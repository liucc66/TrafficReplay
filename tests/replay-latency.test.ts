import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { emptyMetrics, metricQueries } from '../src/data';
import { createReplayLatencyConfig, replayLatencyWindow, replayLoadWindow, retainReplayLatency } from '../src/replayLatencyData';
import type { Replay } from '../src/types';

const config = createReplayLatencyConfig({});
const running: Replay = { id:'task', modelId:'alias', modelName:'old-model', metricsName:'optimized-model', source:{start:100,end:200}, status:'running', startedAt:1000.75 };

test('replay load tail follows gray scrape interval and never settles an active task', () => {
  const slow={scrapeSeconds:60,windowSeconds:240};
  const ended={...running,status:'succeeded' as const,finishedAt:1100};
  const plan=replayLoadWindow(ended,1160,slow)!;
  assert.equal(plan.range.end,1220);
  assert.equal(plan.settleAfter,1250);
  assert.equal(replayLoadWindow({...running,finishedAt:1100},1200,slow)?.settleAfter,undefined);
  assert.deepEqual(replayLoadWindow(ended,9999,slow),plan,'reload keeps the original task and tail time');
  assert.equal(replayLoadWindow({...ended,startedAt:undefined},1300,slow),undefined);
  assert.equal(replayLoadWindow(ended,1300,config)?.range.end,1130,'15s keeps the existing 30s tail');
});

test('replay latency waits for post-start samples and never includes pre-start data', () => {
  assert.equal(replayLatencyWindow({...running,startedAt:undefined}, 2000, config), undefined);
  assert.equal(replayLatencyWindow(running, 1030, config), undefined);
  const warm = replayLatencyWindow(running, 1031, config)!;
  assert.equal(warm.windowSeconds, 30);
  assert(warm.evaluatedAt - warm.windowSeconds >= running.startedAt!);
  assert.deepEqual(replayLatencyWindow(running, 1200, config), { evaluatedAt:1200,windowSeconds:60,settleAfter:undefined });
});

test('terminal observation stays fixed across reload while active cancellation keeps advancing', () => {
  const ended = {...running,status:'cancelled' as const,finishedAt:1100.5};
  const beforeTail = replayLatencyWindow(ended, 1110, config)!;
  assert.equal(beforeTail.evaluatedAt,1110);
  const final = replayLatencyWindow(ended, 1400, config)!;
  assert.equal(final.evaluatedAt,1131);
  assert.equal(final.settleAfter,1161);
  assert.deepEqual(replayLatencyWindow(JSON.parse(JSON.stringify(ended)), 9999, config),final);
  for (const status of ['cancelling','draining'] as const) {
    assert.equal(replayLatencyWindow({...running,status},1400,config)?.evaluatedAt,1400);
  }
});

test('short replays get a bounded tail window and never fabricate latency before dispatch', () => {
  const short = {...running,startedAt:1000,status:'succeeded' as const,finishedAt:1001};
  assert.equal(replayLatencyWindow(short,1005,config),undefined);
  assert.deepEqual(replayLatencyWindow(short,2000,config),{evaluatedAt:1031,windowSeconds:31,settleAfter:1061});
  assert.equal(replayLatencyWindow({...short,startedAt:undefined},2000,config),undefined);
  // 不足一秒的任务不能因为向下取整而永远达不到采样等待门槛。
  const subsecond={...short,startedAt:1000.75,finishedAt:1000.8};
  assert.deepEqual(replayLatencyWindow(subsecond,2000,config),{evaluatedAt:1031,windowSeconds:30,settleAfter:1061});
});

test('sampling config grows the short window without changing history query windows', () => {
  assert.deepEqual(createReplayLatencyConfig({VITE_PROMETHEUS_SCRAPE_INTERVAL_SECONDS:'30',VITE_REPLAY_LATENCY_WINDOW_SECONDS:'60'}),{scrapeSeconds:30,windowSeconds:120});
  assert.throws(()=>createReplayLatencyConfig({VITE_REPLAY_LATENCY_WINDOW_SECONDS:'NaN'}),/正整数秒/);
  assert.throws(()=>createReplayLatencyConfig({VITE_PROMETHEUS_SCRAPE_INTERVAL_SECONDS:'0'}),/正整数秒/);
  assert(metricQueries('history-model',1800).ttft.includes('[30m]'));
  assert(!metricQueries('history-model',1800).ttft.includes('@'));
});

test('all replay ratios target the same real labels and fixed instant, including all TPOT operands', () => {
  const queries = metricQueries('alias',60,undefined,{labels:{model_name:'optimized-model',deployment:'replay-only'},evaluatedAt:1130.8});
  for (const [key,query] of Object.entries(queries)) {
    const operands = key === 'tpot' ? 3 : 2;
    assert.equal(query.match(/model_name="optimized-model"/g)?.length,operands);
    assert.equal(query.match(/deployment="replay-only"/g)?.length,operands);
    assert.equal(query.match(/\[1m\] @ 1130/g)?.length,operands);
    assert(!query.includes('alias'));
  }
  assert.throws(()=>metricQueries('model',60,undefined,{evaluatedAt:NaN}),/观测时间/);
});

test('partial failures retain the last observation while genuine empty and nonfinite results replace it', () => {
  const first=retainReplayLatency(emptyMetrics,{...emptyMetrics,ttft:{value:.2},qt:{value:.3}},1100);
  const next=retainReplayLatency(first,{...emptyMetrics,ttft:{error:'HTTP 503'},e2e:{value:NaN},itl:{value:Infinity}},1130);
  assert.deepEqual(next.ttft,{value:.2,error:'HTTP 503',observedAt:1100});
  assert.deepEqual(next.qt,{observedAt:1130});
  assert(Number.isNaN(next.e2e.value));
  assert.equal(next.itl.value,Infinity);
  const recovered=retainReplayLatency(next,{...emptyMetrics,ttft:{value:.4}},1160);
  assert.deepEqual(recovered.ttft,{value:.4,observedAt:1160});
});
