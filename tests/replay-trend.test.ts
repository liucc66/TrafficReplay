import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DEFAULT_API_CONFIG } from '../src/apiConfig';
import { metricQueries } from '../src/data';
import { emptyReplayTrendData, fetchReplayTrend, parseReplayTrend, replayTrendHasInsufficientWindow, replayTrendPlan, replayTrendQuery, retainReplayTrend } from '../src/replayTrendData';
import type { Replay } from '../src/types';

const config = { windowSeconds: 60, scrapeSeconds: 15 };
const replay: Replay = { id: 'trend-task', modelId: 'alias', modelName: 'Model', metricsName: 'model-v2', source: { start: 1, end: 2 }, status: 'running', startedAt: 1000.25, metricsLabels: { model_name: 'model-v2', deployment: 'replay' } };
const matrix = (result: unknown[]) => ({ status: 'success', data: { resultType: 'matrix', result } });

test('TTFT trend waits for a complete window and fixes the terminal interval across reload', () => {
  assert.equal(replayTrendPlan({ ...replay, startedAt: undefined }, 1200, config), undefined);
  assert.equal(replayTrendPlan(replay, 1060.99, config), undefined);
  assert.deepEqual(replayTrendPlan(replay, 1061, config), { range: { start: 1061, end: 1061 }, evaluatedAt: 1061, settleAfter: undefined });
  const ended = { ...replay, status: 'succeeded' as const, finishedAt: 1100.5 };
  assert.equal(replayTrendPlan(ended, 1110, config)?.range.end, 1110);
  const final = replayTrendPlan(ended, 1200, config)!;
  assert.equal(final.evaluatedAt, 1131);
  assert.equal(final.settleAfter, 1161);
  assert.deepEqual(replayTrendPlan(JSON.parse(JSON.stringify(ended)), 9999, config), final);
  for (const status of ['draining', 'cancelling'] as const) {
    assert.equal(replayTrendPlan({ ...replay, status }, 1200, config)?.range.end, 1200);
  }
});

test('TTFT query uses target labels and the configured live card expression in milliseconds', () => {
  assert.equal(replayTrendQuery(replay, config, DEFAULT_API_CONFIG), '1000 * (rate(vllm:time_to_first_token_seconds_sum{model_name="model-v2",deployment="replay"}[1m]) / rate(vllm:time_to_first_token_seconds_count{model_name="model-v2",deployment="replay"}[1m]))');
  const api = { ...DEFAULT_API_CONFIG, metricNames: { ttft: { sum: 'custom:ttft_sum', count: 'custom:ttft_count' } } };
  assert.equal(replayTrendQuery(replay, config, api), `1000 * (${metricQueries(replay.metricsName, config.windowSeconds, api, { labels: replay.metricsLabels }).ttft})`);
});

test('TTFT averages engines per role, ignores idle NaN engines and preserves real zero', () => {
  const data = parseReplayTrend(matrix([
    { metric: { model_name: 'model-v2', role: 'decode', engine: '0' }, values: [[1061, '100'], [1076, 'NaN'], [1091, '0']] },
    { metric: { model_name: 'model-v2', role: 'decode', engine: '1' }, values: [[1061, '200'], [1076, '300'], [1091, '0']] },
    { metric: { model_name: 'model-v2', role: 'prefill', engine: '0' }, values: [[1061, '80']] },
  ]), 'model-v2', [], 1091);
  assert.equal(data.observedAt, 1091);
  assert.deepEqual(data.series.map(series => [series.name, series.points]), [
    ['model-v2 · decode', [{ timestamp: 1061, value: 150 }, { timestamp: 1076, value: 300 }, { timestamp: 1091, value: 0 }]],
    ['model-v2 · prefill', [{ timestamp: 1061, value: 80 }]],
  ]);
});

test('ended short tasks stop waiting when no full window can ever fit', () => {
  const short = { ...replay, status: 'succeeded' as const, finishedAt: 1001 };
  assert(replayTrendHasInsufficientWindow(short, config));
  assert.equal(replayTrendPlan(short, 9999, config), undefined);
  assert.equal(replayTrendHasInsufficientWindow({ ...short, startedAt: undefined }, config), false);
  assert.equal(replayTrendHasInsufficientWindow({ ...short, finishedAt: undefined }, config), false);
  assert.equal(replayTrendHasInsufficientWindow({ ...short, status: 'running' }, config), false);
  const justFits = { ...short, finishedAt: 1030.1 };
  assert.equal(replayTrendHasInsufficientWindow(justFits, config), false);
  assert.equal(replayTrendPlan(justFits, 2000, config)?.range.start, 1061);
});

test('mixed roles follow configured model matching and nonfinite values become gaps', () => {
  const raw = matrix([
    { metric: { model_name: 'DeepSeek-V3', role: 'prefill' }, values: [[1091, '+Inf'], [1076, '100'], [1061, 'NaN']] },
    { metric: { model_name: 'DeepSeek-V3', role: 'decode' }, values: [[1091, '200'], [1076, '200'], [1061, 'NaN']] },
  ]);
  const data = parseReplayTrend(raw, 'DeepSeek-V3');
  assert.equal(data.series.length, 1);
  assert.equal(data.series[0].name, 'DeepSeek-V3');
  assert.deepEqual(data.series[0].points, [
    { timestamp: 1061, value: undefined }, { timestamp: 1076, value: 150 }, { timestamp: 1091, value: undefined },
  ]);
  assert.equal(parseReplayTrend(raw, 'DeepSeek-V3', []).series.length, 2);
});

test('missing query_range grid points create gaps instead of joining an outage', () => {
  const data = parseReplayTrend(matrix([
    { metric: { role: 'prefill' }, values: [[1106, '200'], [1061, '100']] },
  ]), 'model-v2', [], 1121, { range: { start: 1061, end: 1121 }, step: 15 });
  assert.deepEqual(data.series[0].points, [
    { timestamp: 1061, value: 100 }, { timestamp: 1076, value: undefined }, { timestamp: 1091, value: undefined },
    { timestamp: 1106, value: 200 }, { timestamp: 1121, value: undefined },
  ]);
  assert.deepEqual(parseReplayTrend(matrix([]), 'model-v2', [], 1121, { range: { start: 1061, end: 1121 }, step: 15 }).series, []);
});

test('wrong models, malformed matrices, duplicate samples, bad timestamps and negative TTFT are rejected', () => {
  assert.throws(() => parseReplayTrend(matrix([{ metric: { model_name: 'other' }, values: [] }]), 'model-v2'), /其他模型/);
  assert.throws(() => parseReplayTrend({ status: 'success', data: { resultType: 'vector', result: [] } }, 'model-v2'), /响应类型/);
  assert.throws(() => parseReplayTrend(matrix([{ values: [] }]), 'model-v2'), /格式无效/);
  assert.throws(() => parseReplayTrend(matrix([{ metric: {}, values: [[1061, '100'], [1061, '200']] }]), 'model-v2'), /采样点无效/);
  assert.throws(() => parseReplayTrend(matrix([{ metric: {}, values: [[NaN, '100']] }]), 'model-v2'), /采样点无效/);
  assert.throws(() => parseReplayTrend(matrix([{ metric: {}, values: [[1061, -1]] }]), 'model-v2'), /采样点无效/);
  assert.throws(() => parseReplayTrend(matrix([{ metric: {}, values: [[1061, '-1']] }]), 'model-v2'), /不能为负数/);
  for (const timestamp of [1060, 1062, 1100]) {
    assert.throws(() => parseReplayTrend(matrix([{ metric: {}, values: [[timestamp, '100']] }]), 'model-v2', [], 1091, { range: { start: 1061, end: 1091 }, step: 15 }), /查询网格/);
  }
});

test('query errors retain successful history and time; successful empty responses clear history', () => {
  const previous = { series: [{ id: 'a', name: 'a', points: [{ timestamp: 1061, value: 180 }] }], observedAt: 1061 };
  const failed = { series: [], error: 'HTTP 503' };
  assert.deepEqual(retainReplayTrend(previous, failed), { ...previous, error: 'HTTP 503' });
  assert.deepEqual(retainReplayTrend(emptyReplayTrendData(), failed), failed);
  assert.deepEqual(retainReplayTrend(previous, emptyReplayTrendData()), emptyReplayTrendData());
});


test('TTFT fetch makes one range request with bounded sampling, target model override, no throughput and no auth', async context => {
  const oldFetch = globalThis.fetch, oldWindow = globalThis.window;
  // Earlier request tests exercise a shared metrics cooldown; advance this test's clock past it.
  const now = Date.now() + 120000;
  context.mock.method(Date, 'now', () => now);
  const urls: URL[] = [];
  (globalThis as any).window = globalThis;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://dashboard.local'); urls.push(url);
    assert.equal(new Headers(init?.headers).get('Authorization'), null);
    const start = Number(url.searchParams.get('start'));
    return new Response(JSON.stringify(matrix([{ metric: { model_name: 'target-model' }, values: [[start, '180']] }])), { status: 200 });
  };
  try {
    const target = { ...replay, metricsLabels: { model_name: 'target-model', deployment: 'ttft-target' } };
    const api = { ...DEFAULT_API_CONFIG, prometheusPrefix: '/api/ttft-test' };
    const plan = replayTrendPlan(target, 110000, config)!;
    const result = await fetchReplayTrend(target, plan, config, api);
    assert.equal(result.series[0].name, 'target-model');
    assert(result.series[0].points.length <= 301);
    assert.equal(urls.length, 1);
    assert.equal(urls[0].pathname, '/api/ttft-test/query_range');
    assert(!urls[0].searchParams.get('query')!.includes('generation_tokens'));
    assert(urls[0].searchParams.get('query')!.includes('model_name="target-model"'));
    assert.equal(Number(urls[0].searchParams.get('start')), plan.range.start);
    assert.equal(Number(urls[0].searchParams.get('end')), plan.range.end);
    assert(Number(urls[0].searchParams.get('step')) >= config.scrapeSeconds);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldWindow === undefined) delete (globalThis as any).window;
    else globalThis.window = oldWindow;
  }
});
