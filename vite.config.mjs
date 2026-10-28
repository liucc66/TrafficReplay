import { defineConfig, loadEnv } from 'vite';
import ts from 'typescript';
import { minify } from 'terser';

function replayMetricsPrefix(env) {
  const prefix=(env.VITE_REPLAY_PROMETHEUS_API_PREFIX?.trim() || '/api/replay-prometheus').replace(/\/+$/,'');
  if(!/^\/api\/[a-zA-Z0-9_./-]+$/.test(prefix))throw new Error('回放指标路径应以 /api/ 开头，仅含字母、数字、点、斜线、下划线和连字符');
  return prefix;
}
function replayMetricsMatch(env) {
  return '^'+replayMetricsPrefix(env).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/(?:query|query_range)(?:\\?|$)';
}

// 更具体的回放路径先匹配；未配置独立地址时仍走已有看板后端。
export function createBackendProxy(env) {
  if(env.VITE_REPLAY_AUTH_MODE==='proxy' && !env.BENCHMARK_API_KEY?.trim())throw new Error('代理认证模式需要配置服务端 BENCHMARK_API_KEY');
  const proxyOptions = (address,replay=false) => {
    const options = { target:address, changeOrigin:true, ...(!replay ? { timeout:310000, proxyTimeout:310000 } : {}) };
    // 只给回放代理注入密钥；非 VITE_ 配置不会进入浏览器产物。
    if(replay && env.VITE_REPLAY_AUTH_MODE==='proxy')options.headers={Authorization:`Bearer ${env.BENCHMARK_API_KEY.trim()}`};
    if(env.BACKEND_PROXY_DEBUG==='true') {
      const target = new URL(address);
      const destination = target.origin + target.pathname.replace(/\/$/,'');
      console.info(`[backend-proxy] target=${destination}`);
      options.configure = proxy => {
        proxy.on('proxyRes',(response,request)=>{
          console.info(`[backend-proxy] ${request.method} ${request.url?.split('?')[0]} -> ${destination} HTTP ${response.statusCode}`);
        });
      };
    }
    return options;
  };
  const proxy = {};
  if(env.REPLAY_PROMETHEUS_URL?.trim()) {
    if(!env.VITE_REPLAY_PROMETHEUS_API_PREFIX?.trim())throw new Error('配置灰度地址时必须同时设置 VITE_REPLAY_PROMETHEUS_API_PREFIX，否则浏览器仍查询历史入口');
    const prefix=replayMetricsPrefix(env);
    const historyPrefix=(env.VITE_PROMETHEUS_API_PREFIX?.trim() || '/api/prometheus').replace(/\/+$/,'');
    if(prefix===historyPrefix)throw new Error('灰度指标入口必须与历史指标入口不同');
    const target=new URL(env.REPLAY_PROMETHEUS_URL.trim());
    if(!['http:','https:'].includes(target.protocol)||target.username||target.password||target.search||target.hash)throw new Error('REPLAY_PROMETHEUS_URL 应为不含凭据和查询参数的 HTTP(S) 地址');
    const options=proxyOptions(target.href.replace(/\/+$/,''));
    options.rewrite=path=>'/api/v1/'+path.slice(prefix.length+1);
    const debugConfigure=options.configure;
    options.configure=proxy=>{
      debugConfigure?.(proxy);
      proxy.on('proxyReq',upstream=>{
        // 灰度 Prometheus 凭据在代理服务端独立配置，不转发页面里的回放/正式指标凭据。
        for(const name of ['Authorization','x-api-key','x-litellm-key'])upstream.removeHeader(name);
        if(env.REPLAY_PROMETHEUS_BEARER_TOKEN?.trim())upstream.setHeader('Authorization',`Bearer ${env.REPLAY_PROMETHEUS_BEARER_TOKEN.trim()}`);
      });
    };
    proxy[replayMetricsMatch(env)]=options;
  }
  const replayAddress=env.REPLAY_BACKEND_URL || env.BACKEND_URL;
  if(replayAddress) {
    // Benchmark exposes its LiteLLM target list beside replay endpoints.
    proxy['^/api/models(?:$|[/?])'] = proxyOptions(replayAddress);
    const create = env.VITE_REPLAY_CREATE_PATH || '/api/replays';
    const status = env.VITE_REPLAY_STATUS_PATH || '/api/replays/{id}';
    const active = env.VITE_REPLAY_ACTIVE_PATH || '/api/replays/active';
    const cancel = env.VITE_REPLAY_CANCEL_PATH || '/api/replays/{id}/cancel';
    const prefixes = new Set([create,status.split('{id}')[0].replace(/\/+$/,''),active,cancel.split('{id}')[0].replace(/\/+$/,'')]);
    for(const prefix of prefixes) {
      if(!prefix.startsWith('/api/')||/[?#\s\\]/.test(prefix))throw new Error('回放代理路径应以 /api/ 开头，不含查询参数或空格');
      const match = '^' + prefix.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '(?:$|[/?])';
      proxy[match] = proxyOptions(replayAddress,true);
    }
  }
  if(env.BACKEND_URL) {
    proxy['/api'] = proxyOptions(env.BACKEND_URL);
    proxy['/health'] = proxyOptions(env.BACKEND_URL);
  }
  return Object.keys(proxy).length ? proxy : undefined;
}

export function createReplayMetricsGuard(env) {
  const unavailableMetrics = server => {
    if(env.REPLAY_PROMETHEUS_URL?.trim())return;
    const prefix=replayMetricsPrefix(env);
    if(prefix===(env.VITE_PROMETHEUS_API_PREFIX?.trim() || '/api/prometheus').replace(/\/+$/,''))return;
    const match=new RegExp(replayMetricsMatch(env));
    server.middlewares.use((request,response,next)=>{
      if(!match.test(request.url || ''))return next();
      response.statusCode=503;response.setHeader('Content-Type','application/json; charset=utf-8');
      response.end(JSON.stringify({error:'未配置灰度 Prometheus，请设置服务端 REPLAY_PROMETHEUS_URL'}));
    });
  };
  return {name:'replay-metrics-config',configureServer:unavailableMetrics,configurePreviewServer:unavailableMetrics};
}

export default defineConfig(({ mode }) => {
  // 服务地址与密钥只由代理读取，VITE_ 变量仅配置浏览器同源路径。
  const env = loadEnv(mode, process.cwd(), '');
  // 历史/回放任务路径原样透传；灰度指标改写为原生 /api/v1。
  const backendProxy = createBackendProxy(env);
  return {
    resolve: { preserveSymlinks: true },
    // 使用 TypeScript 转译和 Terser 压缩，兼容受限 Windows 下 esbuild 原生路径扫描限制。
    // 类型检查由 npm run build 中的 tsc -b 单独完成。
    plugins: [createReplayMetricsGuard(env), {
      name: 'typescript-transpile',
      transform(source, id) {
        if (!/\.tsx?$/.test(id)) return;
        return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, sourceMap: true } }).outputText;
      }
    }, {
      name: 'compress-production-js',
      apply: 'build',
      async renderChunk(code) { const output = await minify(code, { module:true }); return { code:output.code, map:null }; }
    }],
    esbuild: false,
    build: { minify: false },
    server: {
      // 浏览器 /api → Vite 代理 → 已有看板后端 → Prometheus/LiteLLM/回放任务。
      proxy: backendProxy
    },
    // npm run dev 先 build 再启动 preview；生产静态服务器仍须另外配置代理。
    preview: { proxy: backendProxy }
  };
});
