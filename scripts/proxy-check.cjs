const assert = require('node:assert/strict');
const http = require('node:http');

(async()=>{
  const {createBackendProxy,createReplayMetricsGuard}=await import('../vite.config.mjs');
  const {createServer}=await import('vite');
  const upstreams=[];
  let vite;
  try {
    for(const name of ['metrics','replay','gray']) {
      const server=http.createServer((request,response)=>{
        response.setHeader('Content-Type','application/json');
        response.end(JSON.stringify({backend:name,path:request.url,authorization:request.headers.authorization||null,apiKey:request.headers['x-api-key']||null}));
      });
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      upstreams.push(server);
    }
    const address=server=>`http://127.0.0.1:${server.address().port}`;
    const env={BACKEND_URL:address(upstreams[0]),REPLAY_BACKEND_URL:address(upstreams[1]),REPLAY_PROMETHEUS_URL:address(upstreams[2])+'/gray-base/',VITE_REPLAY_PROMETHEUS_API_PREFIX:'/api/replay-prometheus'};
    assert.equal(createBackendProxy({}),undefined);
    assert.equal(createBackendProxy({BACKEND_URL:env.BACKEND_URL})['/api'].target,env.BACKEND_URL);
    assert.equal(createBackendProxy(env)['/api'].proxyTimeout,310000);
    assert.equal(createBackendProxy(env)['/api'].timeout,310000);
    const proxy=createBackendProxy({...env,VITE_REPLAY_CREATE_PATH:'/api/custom.create',VITE_REPLAY_STATUS_PATH:'/api/custom.status/{id}',VITE_REPLAY_ACTIVE_PATH:'/api/custom.active',VITE_REPLAY_CANCEL_PATH:'/api/custom.cancel/{id}'});
    // 使用实际 Vite 代理验证不同后端、路径优先级与认证头透传。
    vite=await createServer({configFile:false,server:{host:'127.0.0.1',port:0,proxy},optimizeDeps:{noDiscovery:true,include:[]}});
    await vite.listen();
    const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
    const metricsAuth=await (await fetch(origin+'/api/prometheus/query?query=up',{headers:{Authorization:'Bearer independent-metrics'}})).json();
    assert.equal(metricsAuth.authorization,'Bearer independent-metrics');
    const query='sum(vllm:num_requests_running{model_name="shared-model"})';
    const params=new URLSearchParams({query,start:'100',end:'200',step:'15'});
    for(const endpoint of ['query','query_range']) {
      const gray=await (await fetch(origin+`/api/replay-prometheus/${endpoint}?${params}`,{headers:{Authorization:'Bearer must-not-reach-gray','x-api-key':'must-not-reach-gray'}})).json();
      assert.equal(gray.backend,'gray');assert.equal(gray.authorization,null);assert.equal(gray.apiKey,null);
      const url=new URL(gray.path,origin);
      assert.equal(url.pathname,`/gray-base/api/v1/${endpoint}`);assert.equal(url.searchParams.get('query'),query);
      assert.equal(url.searchParams.get('step'),'15');
    }
    for(const [path,backend] of [
      ['/api/prometheus/query?query=up','metrics'],
      ['/api/prometheus/query_range?start=100&end=200','metrics'],
      ['/api/models','replay'],
      ['/api/custom.create','replay'],
      ['/api/custom.status/task-1','replay'],
      ['/api/custom.active','replay'],
      ['/api/custom.cancel/task-1','replay'],
      ['/api/customXcreate','metrics'],
    ]) {
      const response=await fetch(origin+path,backend==='replay'?{headers:{Authorization:'Bearer test-benchmark-key'}}:{});
      const result=await response.json();
      assert.equal(result.backend,backend);
      assert.equal(result.path,path);
      assert.equal(result.authorization,backend==='replay'?'Bearer test-benchmark-key':null);
    }
    const defaults=Object.entries(createBackendProxy(env));
    assert(defaults.some(([key,value])=>new RegExp(key).test('/api/models')&&value.target===env.REPLAY_BACKEND_URL));
    assert(defaults.some(([key,value])=>key.startsWith('^')&&new RegExp(key).test('/api/replays/task-1')&&value.target===env.REPLAY_BACKEND_URL));
    assert(!defaults.some(([key])=>key.startsWith('^')&&new RegExp(key).test('/api/replays-other')));
    assert.throws(()=>createBackendProxy({...env,VITE_REPLAY_AUTH_MODE:'proxy'}),/BENCHMARK_API_KEY/);
    const injected=createBackendProxy({...env,VITE_REPLAY_AUTH_MODE:'proxy',BENCHMARK_API_KEY:'test-server-only',REPLAY_PROMETHEUS_BEARER_TOKEN:'gray-server-only'});
    for(const [path,expected] of [['/api/models',undefined],['/api/replays/active','Bearer test-server-only'],['/api/replays/task-1/cancel','Bearer test-server-only'],['/api/prometheus/query',undefined]]) {
      const [,options]=Object.entries(injected).find(([key])=>key.startsWith('^')?new RegExp(key).test(path):path.startsWith(key));
      assert.equal(options.headers?.Authorization,expected);
    }
    await vite.close();
    vite=await createServer({configFile:false,server:{host:'127.0.0.1',port:0,proxy:injected},optimizeDeps:{noDiscovery:true,include:[]}});
    await vite.listen();
    const injectedOrigin=`http://127.0.0.1:${vite.httpServer.address().port}`;
    for(const [path,expected] of [['/api/models',null],['/api/replays/active','Bearer test-server-only'],['/api/replays/task-1/cancel','Bearer test-server-only'],['/api/prometheus/query',null]]) {
      const body=await (await fetch(injectedOrigin+path)).json();
      assert.equal(body.authorization,expected);
    }
    const grayAuth=await (await fetch(injectedOrigin+'/api/replay-prometheus/query?query=up')).json();
    assert.equal(grayAuth.backend,'gray');assert.equal(grayAuth.authorization,'Bearer gray-server-only');
    assert.throws(()=>createBackendProxy({...env,VITE_REPLAY_PROMETHEUS_API_PREFIX:'/api/prometheus'}),/入口必须/);
    assert.throws(()=>createBackendProxy({...env,VITE_REPLAY_PROMETHEUS_API_PREFIX:''}),/VITE_REPLAY_PROMETHEUS_API_PREFIX/);
    await vite.close();
    const missing={BACKEND_URL:env.BACKEND_URL,VITE_REPLAY_PROMETHEUS_API_PREFIX:'/api/replay-prometheus'};
    vite=await createServer({configFile:false,plugins:[createReplayMetricsGuard(missing)],server:{host:'127.0.0.1',port:0,proxy:createBackendProxy(missing)},optimizeDeps:{noDiscovery:true,include:[]}});
    await vite.listen();
    const missingOrigin=`http://127.0.0.1:${vite.httpServer.address().port}`;
    const unavailable=await fetch(missingOrigin+'/api/replay-prometheus/query?query=up');
    assert.equal(unavailable.status,503);assert((await unavailable.json()).error.includes('REPLAY_PROMETHEUS_URL'));
    assert.equal((await (await fetch(missingOrigin+'/api/prometheus/query?query=up')).json()).backend,'metrics');
    console.log('PASS: production metrics, Benchmark and direct gray Prometheus routing, native API rewrite, isolated credentials, missing-gray 503 and legacy configuration');
  } finally {
    await vite?.close();
    await Promise.all(upstreams.map(server=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
