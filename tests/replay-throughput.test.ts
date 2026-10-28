import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DEFAULT_API_CONFIG } from '../src/apiConfig';
import { requestPrometheus, setMetricsAuth } from '../src/data';
import { replayTrendCanSettle, replayTrendHasInsufficientWindow, replayTrendPlan } from '../src/replayTrendData';
import { applyThroughputResult, createReplayThroughputConfig, emptyThroughputData, fetchThroughput, parseThroughput, throughputQuery, throughputStep, throughputTarget } from '../src/replayThroughputData';
import type { Replay } from '../src/types';

const cfg = createReplayThroughputConfig({ VITE_REPLAY_THROUGHPUT_CONFIG: JSON.stringify({ targets: { alias: { requestedModel: 'litellm-alias', labels: { job: 'litellm' } } } }) });
const replay: Replay = { id: 'token-task', modelId: 'alias', modelName: 'Model', metricsName: 'unrelated-vllm', metricsLabels: { deployment: 'vllm-only' }, source: { start: 1, end: 2 }, startedAt: 1000.25, status: 'running' };
const plan = replayTrendPlan(replay, 1121, cfg, cfg.tailSeconds)!;
const target = throughputTarget(replay, cfg)!;
const matrix = (values: unknown[], metric: unknown = { requested_model: 'litellm-alias' }) => ({ status: 'success', data: { resultType: 'matrix', result: [{ metric, values }] } });

test('throughput requires explicit logical target mapping and independent LiteLLM labels', () => {
  assert.equal(throughputTarget(replay, createReplayThroughputConfig({})), undefined);
  assert.equal(throughputTarget({ ...replay, modelId: 'unrelated-vllm' }, cfg), undefined);
  assert.equal(throughputTarget({ ...replay, modelId: 'toString' }, cfg), undefined);
  assert.equal(throughputQuery(target, 'input', cfg), 'sum by (requested_model) (rate(litellm_input_tokens_metric_total{job="litellm",requested_model="litellm-alias"}[1m]))');
  const escaped = throughputQuery({ requestedModel: 'a"\\\n', labels: {} }, 'output', cfg);
  assert(escaped.includes('requested_model="a\\"\\\\\\n"'));
  assert(escaped.includes('litellm_output_tokens_metric_total'));
  assert(!escaped.includes('vllm-only'));
});

test('throughput validates deployment config, duration bounds and metric names', () => {
  const config = createReplayThroughputConfig({ VITE_REPLAY_THROUGHPUT_CONFIG: '{"scrapeSeconds":30,"windowSeconds":10,"tailSeconds":180}' });
  assert.equal(config.windowSeconds, 120); assert.equal(config.tailSeconds, 180); assert.equal(config.timeoutSeconds, 300);
  for (const raw of ['[]', '{', '{"typo":1}', '{"timeoutSeconds":301}', '{"windowSeconds":0}', '{"inputMetric":"bad{metric"}', '{"targets":{"a":{"requestedModel":""}}}', '{"targets":{"a":{"requestedModel":"a","labels":{"requested_model":"b"}}}}', '{"targets":{"a":{"requestedModel":"a","labels":{"__name__":"bad"}}}}']) {
    assert.throws(() => createReplayThroughputConfig({ VITE_REPLAY_THROUGHPUT_CONFIG: raw }));
  }
});

test('throughput uses actual replay start, full window, configured tail and bounded historical grid', () => {
  assert.equal(replayTrendPlan(replay, 1060, cfg, cfg.tailSeconds), undefined);
  const ended = { ...replay, status: 'succeeded' as const, finishedAt: 1100.5 };
  const final = replayTrendPlan(ended, 9999, cfg, cfg.tailSeconds)!;
  assert.equal(final.range.start, 1061); assert.equal(final.range.end, 1161); assert.equal(final.settleAfter, 1191);
  assert.deepEqual(replayTrendPlan(JSON.parse(JSON.stringify(ended)), 99999, cfg, cfg.tailSeconds), final);
  assert(replayTrendHasInsufficientWindow({ ...ended, finishedAt: 1001 }, cfg, 0));
  const long = replayTrendPlan(replay, 1000 + 7 * 86400, cfg)!;
  assert(Math.floor((long.range.end - long.range.start) / throughputStep(long, cfg)) + 1 <= 301);
});

test('terminal finalization uses request start and full tail coverage even after a wall clock jump', () => {
  const ended = { ...replay, status: 'succeeded' as const, finishedAt: 1100 };
  const early = replayTrendPlan(ended, 1110, cfg)!;
  assert.equal(replayTrendCanSettle(early, 1110), false);
  assert.equal(replayTrendCanSettle(early, 9999), false);
  const final = replayTrendPlan(ended, 1190, cfg)!;
  assert.equal(replayTrendCanSettle(final, final.settleAfter! - .01), false);
  assert.equal(replayTrendCanSettle(final, final.settleAfter!), true);
});

test('throughput keeps zero, nonfinite gaps and omitted grid points without interpolation', () => {
  const result = parseThroughput(matrix([[1061, '0'], [1076, 'NaN'], [1106, '+Inf'], [1121, '12']]), target.requestedModel, plan, 15);
  assert.deepEqual(result.points.map(point => point.value), [0, undefined, undefined, undefined, 12]);
  assert.deepEqual(parseThroughput({ status: 'success', data: { resultType: 'matrix', result: [] } }, target.requestedModel, plan, 15).points, []);
});

test('throughput rejects wrong models, unaggregated series, duplicates, negatives and invalid points', () => {
  const parse = (raw: unknown) => parseThroughput(raw, target.requestedModel, plan, 15);
  assert.throws(() => parse(matrix([], { requested_model: 'other' })));
  assert.throws(() => parse(matrix([], { requested_model: 'litellm-alias', instance: 'a' })));
  assert.throws(() => parse({ status: 'success', data: { resultType: 'matrix', result: [{}, {}] } }));
  for (const values of [[[1061, '-1']], [[1061, 'oops']], [[1062, '1']], [[1060, '1']], [[1122, '1']], [[1061, '1'], [1061, '2']], [[NaN, '1']], [[1061, 1]]]) assert.throws(() => parse(matrix(values)));
});

test('throughput never sums across refresh batches; partial failures keep their own data and time', () => {
  const input = { points: [{ timestamp: 1061, value: 10 }, { timestamp: 1076, value: 0 }], observedAt: 1121 };
  const output = { points: [{ timestamp: 1061, value: 5 }, { timestamp: 1076, value: undefined }], observedAt: 1121 };
  let state = applyThroughputResult(emptyThroughputData(), 'input', input, 1);
  assert.equal(state.total.observedAt, undefined);
  state = applyThroughputResult(state, 'output', output, 1);
  assert.deepEqual(state.total.points.map(point => point.value), [15, undefined]);
  state = applyThroughputResult(state, 'input', { ...input, observedAt: 1151 }, 2);
  assert.equal(state.total.observedAt, 1121); assert(state.total.error);
  state = applyThroughputResult(state, 'output', { points: [], error: '503' }, 2);
  assert.equal(state.output.observedAt, 1121); assert.equal(state.output.error, '503');
  assert.equal(state.input.observedAt, 1151); assert.equal(state.total.observedAt, 1121);
  state = applyThroughputResult(state, 'output', { points: [], observedAt: 1151 }, 3);
  state = applyThroughputResult(state, 'input', { points: [], observedAt: 1151 }, 3);
  assert.deepEqual(state.total.points, []); assert.equal(state.total.error, undefined);
});

test('metrics cache deduplicates long pending requests, starts TTL after success, isolates auth and final queries', async context => {
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
  let now = Date.now() + 120000, calls = 0, release: ((value: Response) => void) | undefined;
  context.mock.method(Date, 'now', () => now);
  globalThis.window = globalThis as any;
  globalThis.fetch = (async (_path, options) => {
    calls++;
    const headers = new Headers(options?.headers);
    if (calls === 1) { assert.equal(headers.get('x-api-key'), 'metrics-a'); return new Promise(resolve => release = resolve); }
    assert.equal(headers.get('authorization'), 'Bearer metrics-b');
    return new Response('{}');
  }) as typeof fetch;
  try {
    setMetricsAuth({ apiKey: 'metrics-a', authHeader: 'x-api-key' });
    const first = requestPrometheus('/api/token-cache', { timeoutMs: 300000 });
    now += 90000;
    assert.equal(requestPrometheus('/api/token-cache', { timeoutMs: 300000 }), first); assert.equal(calls, 1);
    setMetricsAuth({ apiKey: 'Bearer metrics-b', authHeader: 'Authorization' });
    const second = requestPrometheus('/api/token-cache', { timeoutMs: 300000 });
    await second; assert.equal(calls, 2);
    release!(new Response('{}')); await first;
    assert.equal(requestPrometheus('/api/token-cache', { timeoutMs: 300000 }), second);
    now += 29000; assert.equal(requestPrometheus('/api/token-cache', { timeoutMs: 300000 }), second);
    const final = requestPrometheus('/api/token-cache', { timeoutMs: 300000, freshAfter: now });
    await final; assert.equal(calls, 3);
    now += 31000; await requestPrometheus('/api/token-cache', { timeoutMs: 300000 }); assert.equal(calls, 4);
  } finally { setMetricsAuth({}); globalThis.fetch = originalFetch; globalThis.window = originalWindow; context.mock.restoreAll(); }
});

test('throughput fetch uses configured timeout, route, exact model and query grid; aborts at deadline', async context => {
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
  let deadline = 0, abort: (() => void) | undefined;
  context.mock.method(Date, 'now', () => 2000000000000);
  globalThis.window = { setTimeout: (callback: () => void, delay: number) => { deadline = delay; abort = callback; return 0; } } as any;
  globalThis.fetch = (async (path, options) => {
    const url = new URL(String(path), 'http://local');
    assert.equal(url.pathname, '/api/token-tests/query_range');
    assert.equal(url.searchParams.get('start'), '1061'); assert.equal(url.searchParams.get('step'), '15');
    assert(url.searchParams.get('query')!.includes('requested_model="litellm-alias"'));
    assert(!new Headers(options?.headers).has('authorization'));
    return new Response(JSON.stringify(matrix([[1061, '0']])));
  }) as typeof fetch;
  try {
    const api = { ...DEFAULT_API_CONFIG, prometheusPrefix: '/api/token-tests' };
    const result = await fetchThroughput(target, 'input', plan, cfg, api);
    assert.equal(deadline, 300000); assert.equal(result.points[0].value, 0);
    globalThis.fetch = ((_path, options) => new Promise((_resolve, reject) => { options!.signal!.addEventListener('abort', () => reject(new Error('aborted'))); })) as typeof fetch;
    const pending = requestPrometheus('/api/token-timeout', { timeoutMs: 300000 });
    abort!(); await assert.rejects(pending, /请求超时（300s）/);
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow; context.mock.restoreAll(); }
});

test('terminal throughput retry bypasses an earlier batch cache even within the successful TTL', async context => {
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
  let now = 2000000000000, inputCalls = 0, outputCalls = 0;
  context.mock.method(Date, 'now', () => now);
  globalThis.window = globalThis as any;
  globalThis.fetch = (async path => {
    const input = String(path).includes('input_tokens');
    if (input) inputCalls++; else outputCalls++;
    if (!input && outputCalls === 1) return new Response('{"error":"temporary"}', { status: 503 });
    return new Response(JSON.stringify(matrix([[1061, String(input ? inputCalls * 10 : 5)]])));
  }) as typeof fetch;
  try {
    const api = { ...DEFAULT_API_CONFIG, prometheusPrefix: '/api/token-terminal-cache' };
    const ended = replayTrendPlan({ ...replay, status: 'succeeded', finishedAt: 1100 }, now / 1000, cfg, cfg.tailSeconds)!;
    await fetchThroughput(target, 'input', ended, cfg, api, now);
    await assert.rejects(fetchThroughput(target, 'output', ended, cfg, api, now));
    now += 5000;
    const [input, output] = await Promise.all(['input', 'output'].map(direction => fetchThroughput(target, direction as 'input' | 'output', ended, cfg, api, now)));
    assert.equal(inputCalls, 2); assert.equal(outputCalls, 2);
    const state = applyThroughputResult(applyThroughputResult(emptyThroughputData(), 'input', input, 2), 'output', output, 2);
    assert.equal(state.total.points[0].value, 25);
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow; context.mock.restoreAll(); }
});

test('a late rate limit from an old metrics identity does not throttle the new identity', async () => {
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
  let release: ((response: Response) => void) | undefined, calls = 0;
  globalThis.window = globalThis as any;
  globalThis.fetch = (() => { calls++; return calls === 1 ? new Promise(resolve => release = resolve) : Promise.resolve(new Response('{}')); }) as typeof fetch;
  try {
    setMetricsAuth({ apiKey: 'old', authHeader: 'x-api-key' });
    const old = requestPrometheus('/api/old-identity-limit');
    setMetricsAuth({ apiKey: 'new', authHeader: 'x-api-key' });
    release!(new Response('{"error":"busy"}', { status: 429, headers: { 'Retry-After': '60' } }));
    await assert.rejects(old);
    await requestPrometheus('/api/new-identity-limit'); assert.equal(calls, 2);
  } finally { setMetricsAuth({}); globalThis.fetch = originalFetch; globalThis.window = originalWindow; }
});
