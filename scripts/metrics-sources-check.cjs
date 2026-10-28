// Isolated compiled UI with all API calls mocked; never contacts Prometheus or inference services.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');

(async () => {
  const root = path.resolve('test-results/metrics-sources');
  const secret = 'gray-test-secret-server-only';
  const upstream = 'http://gray-test-server-only.invalid:9090';
  const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--configLoader', 'native', '--outDir', root], {
    env: { ...process.env,
      BACKEND_URL: '', REPLAY_BACKEND_URL: '', VITE_REPLAY_AUTH_MODE: 'manual',
      VITE_PROMETHEUS_API_PREFIX: '/api/prometheus', VITE_REPLAY_PROMETHEUS_API_PREFIX: '/api/replay-prometheus',
      VITE_REPLAY_THROUGHPUT_PROMETHEUS_API_PREFIX: '', VITE_MODEL_METRICS_MAP: '{"source-archive":"shared-model"}',
      VITE_REPLAY_MODEL_METRICS_MAP: '{"gray-target":"shared-model","gray-target-2":"shared-model"}',
      VITE_REPLAY_CREATE_PATH: '/api/replays', VITE_REPLAY_STATUS_PATH: '/api/replays/{id}',
      VITE_REPLAY_ACTIVE_PATH: '/api/replays/active', VITE_REPLAY_CANCEL_PATH: '/api/replays/{id}/cancel',
      VITE_REPLAY_STORAGE_SCOPE: 'metrics-sources-check',
      VITE_PROMETHEUS_SCRAPE_INTERVAL_SECONDS: '60', VITE_REPLAY_LATENCY_WINDOW_SECONDS: '240',
      VITE_REPLAY_CACHE_CONFIG: '{"counterUnit":"tokens"}',
      VITE_REPLAY_THROUGHPUT_CONFIG: '{"targets":{"gray-target":{"requestedModel":"gray-target"}}}',
      REPLAY_PROMETHEUS_URL: upstream, REPLAY_PROMETHEUS_BEARER_TOKEN: secret,
    }, stdio: 'inherit',
  });
  assert.equal(build.status, 0);
  for (const name of fs.readdirSync(path.join(root, 'assets'))) {
    const contents = fs.readFileSync(path.join(root, 'assets', name), 'utf8');
    assert(!contents.includes(secret) && !contents.includes(upstream), 'server credentials or address leaked into browser assets');
  }
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = pathname.startsWith('/assets/') ? path.join(root, 'assets', path.basename(pathname)) : path.join(root, 'index.html');
    response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHECK_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1120 } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const now = Math.floor(Date.now() / 1000);
    const state = { requests: [], creates: [], task: null, grayFailed: false, holdMetrics: false };
    let releaseMetrics;
    const metricsGate=new Promise(resolve=>releaseMetrics=resolve);
    await context.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url());
      const query = url.searchParams.get('query') || '';
      let body, status = 200;
      if (url.pathname === '/api/models') {
        body = { target_models: ['gray-target','gray-target-2'] };
      } else if (url.pathname.startsWith('/api/prometheus/') || url.pathname.startsWith('/api/replay-prometheus/')) {
        assert(!request.headers().authorization, 'Benchmark credentials must not be sent to metric queries');
        const gray = url.pathname.startsWith('/api/replay-prometheus/');
        state.requests.push({ pathname: url.pathname, query, start: Number(url.searchParams.get('start')), end: Number(url.searchParams.get('end')), gray });
        if(gray && state.holdMetrics)await metricsGate;
        assert(!/namespace=|deployment=|environment=/.test(query), 'unique targets require no additional label');
        if (gray && state.grayFailed) { status = 503; body = { error: 'gray metrics unavailable' }; }
        else if (query.startsWith('count by')) {
          assert(!gray, 'source models must be discovered from production');
          body = { status: 'success', data: { resultType: 'vector', result: ['shared-model', 'source-other'].map(model_name => ({ metric: { model_name }, value: [now, '0'] })) } };
        } else {
          const model = query.includes('source-other') ? 'source-other' : 'shared-model';
          const metric = query.includes('litellm_') ? { requested_model: 'gray-target' } : { model_name: model };
          const value = query.includes('num_requests') ? gray ? '33' : '11' : '0.2';
          const range = url.pathname.endsWith('/query_range');
          const timestamp = range ? Number(url.searchParams.get('start')) : now;
          body = { status: 'success', data: { resultType: range ? 'matrix' : 'vector', result: [
            { metric, ...(range ? { values: [[timestamp, value]] } : { value: [timestamp, value] }) },
          ] } };
        }
      } else {
        assert.equal(request.headers().authorization, 'Bearer fixture-benchmark');
        if (url.pathname === '/api/replays/active') body = { active: state.task?.status==='running', task: state.task?.status==='running'?state.task:null };
        else if (url.pathname === '/api/replays' && request.method() === 'POST') {
          const input = request.postDataJSON(); state.creates.push(input);
          state.task = { ...input, replay_id: 'split-metrics-task', status: 'running', cancellable: true,
            started_at: now - 600, request_count: 100, sent_count: 30, completed_count: 20,
            target: { metrics_labels: { model_name: input.target_model } },
          };
          status = 202; body = state.task;
        } else {
          assert.equal(url.pathname, '/api/replays/split-metrics-task'); body = state.task;
        }
      }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    });
    const authenticate = async () => {
      await page.getByRole('button', { name: '连接设置', exact: true }).click();
      await expect(page.locator('.endpoint-list')).toContainText('历史指标入口：/api/prometheus');
      await expect(page.locator('.endpoint-list')).toContainText('回放指标入口：/api/replay-prometheus');
      await page.locator('.settings-field input').fill('Bearer fixture-benchmark');
      await page.getByRole('button', { name: '应用设置', exact: true }).click();
    };
    const has = (gray, pattern, endpoint) => state.requests.some(item => item.gray === gray && pattern.test(item.query) && (!endpoint || item.pathname.endsWith(endpoint)));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button', { name: '后端', exact: true }).click();
    await expect(page.locator('#model')).toHaveValue('shared-model');
    await authenticate();
    const inputs = page.locator('.selection-form input');
    await inputs.first().fill((await inputs.first().getAttribute('min')).replace(/:00$/,''));
    await inputs.last().fill((await inputs.last().getAttribute('max')).replace(/:00$/,''));
    await page.getByRole('button', { name: '选择打流目标', exact: true }).click();
    await page.getByRole('button', { name: 'gray-target', exact: true }).click();
    await page.getByRole('button', { name: '确认回放', exact: true }).click();
    await page.getByRole('button', { name: '开始回放', exact: true }).click();
    await expect(page.locator('.replay-actions code')).toHaveText('split-metrics-task');
    await expect.poll(() => has(true, /num_requests_running/, '/query_range') && has(true, /num_requests_waiting/, '/query_range')).toBe(true);
    for (const metric of ['time_to_first_token_seconds', 'e2e_request_latency_seconds', 'inter_token_latency_seconds', 'request_decode_time_seconds', 'request_queue_time_seconds']) {
      await expect.poll(() => has(true, new RegExp(metric), '/query')).toBe(true);
    }
    await expect.poll(() => has(true, /1000 \*.*time_to_first_token/, '/query_range')).toBe(true);
    for (const metric of ['kv_cache_usage', 'prefix_cache_hits', 'prefix_cache_queries', 'litellm_input_tokens', 'litellm_output_tokens']) {
      await expect.poll(() => has(true, new RegExp(metric), '/query_range')).toBe(true);
    }
    assert(has(false, /num_requests_running/, '/query_range'));
    assert(has(false, /time_to_first_token_seconds/, '/query'));
    assert(!has(false, /kv_cache|prefix_cache|litellm_|1000 \*/));
    await expect(page.locator('.replay-latency-section .metric-value').first()).toContainText('0.2');
    assert.deepEqual(Object.keys(state.creates[0]).sort(), ['end_time', 'source_model', 'speed', 'start_time', 'target_model']);
    assert.equal(state.creates[0].source_model, 'source-archive'); assert.equal(state.creates[0].target_model, 'gray-target');

    const beforeReload = state.requests.length;
    await page.evaluate(()=>localStorage.removeItem('trafficReplay.v2.metrics-sources-check'));
    await page.reload(); await authenticate();
    await expect(page.locator('.replay-actions code')).toHaveText('split-metrics-task');
    await expect.poll(() => state.requests.slice(beforeReload).some(item => item.gray && /num_requests_running/.test(item.query))).toBe(true);
    await expect(page.locator('#model')).toHaveValue('shared-model');
    await page.locator('#model').selectOption('source-other');
    await expect(page.locator('.replay-panel .panel-model strong')).toHaveText('source-archive → gray-target');
    await expect.poll(() => has(false, /model_name="source-other"/)).toBe(true);
    assert.equal(state.creates.length, 1, 'refresh must not submit the task again');

    state.grayFailed = true;
    const beforeFailure = state.requests.length;
    await page.reload(); await authenticate();
    await expect(page.locator('.replay-panel .chart-error')).toContainText('gray metrics unavailable');
    assert(state.requests.slice(beforeFailure).some(item => !item.gray));
    assert(!state.requests.some(item => !item.gray && item.start === state.task.started_at), 'failed replay metrics must not fall back to production');
    await page.setViewportSize({ width: 320, height: 844 });
    await page.getByRole('button', { name: '连接设置', exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    await page.evaluate(finishedAt=>{
      const key='trafficReplay.v2.metrics-sources-check';
      const cached=JSON.parse(localStorage.getItem(key));
      cached.replay.status='succeeded';cached.replay.finishedAt=finishedAt;cached.replay.cancellable=false;
      localStorage.setItem(key,JSON.stringify(cached));
    },now-5);
    await page.close();

    // A query started before the final deadline must not stop polling merely because the machine slept.
    state.grayFailed=false;state.holdMetrics=true;
    state.task={...state.task,status:'succeeded',cancellable:false,finished_at:now-5};
    const slowPage=await context.newPage();
    slowPage.on('pageerror',error=>errors.push(error.message));
    await slowPage.clock.install({time:new Date(now*1000)});
    await slowPage.clock.pauseAt(new Date(now*1000+100));
    const beforeSlow=state.requests.length;
    await slowPage.goto(`http://127.0.0.1:${server.address().port}`);
    await slowPage.getByRole('button',{name:'连接设置',exact:true}).click();
    await slowPage.locator('.settings-field input').fill('Bearer fixture-benchmark');
    await slowPage.getByRole('button',{name:'应用设置',exact:true}).click();
    const slowLoad=()=>state.requests.slice(beforeSlow).filter(item=>item.gray&&/num_requests_/.test(item.query));
    await expect.poll(()=>slowLoad().length).toBe(2);
    await expect.poll(()=>state.requests.slice(beforeSlow).filter(item=>item.gray).length).toBeGreaterThanOrEqual(15);
    await slowPage.clock.setSystemTime(new Date((now+180)*1000));
    state.holdMetrics=false;releaseMetrics();
    await expect(slowPage.locator('.replay-latency-section .metric-value').first()).toContainText('0.2');
    await expect(slowPage.locator('.replay-latency-section')).not.toContainText('最终观测已固定');
    await expect(slowPage.locator('.replay-cache-section')).not.toContainText('最终观测已固定');
    await slowPage.clock.runFor(31000);
    await expect.poll(()=>slowLoad().length).toBe(4);
    await expect(slowPage.locator('.replay-latency-section')).toContainText('最终观测已固定');
    await expect(slowPage.locator('.replay-cache-section')).toContainText('最终观测已固定');
    // End of the fixed load window is two gray scrapes after task completion.
    assert(slowLoad().every(item=>item.start===state.task.started_at && item.end===state.task.finished_at+120));
    await slowPage.clock.runFor(65000);
    assert.equal(slowLoad().length,4,'after a fresh final fetch the load stops polling');
    assert.deepEqual(errors,[]);
    console.log('PASS: split aliases and same-name metrics, all observers, original Benchmark payload, recovery without a snapshot, failures, slow gray sampling and sleep during final queries');
    await context.close();
  } finally {
    await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
