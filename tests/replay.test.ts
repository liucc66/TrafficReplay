import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { applyReplayResponse, isTerminalReplay, replayPercent } from '../src/replay';
import type { Replay } from '../src/types';

const initial: Replay = {id:'task-1',modelId:'model-a',modelName:'model-a',metricsName:'model-a',source:{start:100,end:200},status:'preparing'};

test('unknown totals stay unknown until preparation finishes, including zero totals', () => {
  const preparing=applyReplayResponse({status:'preparing',progress:{ready:false,total:null,sent:0,completed:0,percent:null}},initial,300);
  assert.equal(preparing.requestCount,undefined);
  assert.equal(preparing.completedCount,0);
  assert.equal(replayPercent(preparing),undefined);
  const queued=applyReplayResponse({status:'queued',progress:{ready:true,total:1200,sent:0,completed:0}},preparing,301);
  assert.equal(queued.requestCount,1200);
  assert.equal(replayPercent(queued),0);
  const empty=applyReplayResponse({status:'failed',request_count:0,completed_count:0,error:'No replayable requests'},initial,302);
  assert.equal(empty.requestCount,0);
  assert.equal(replayPercent(empty),undefined);
  assert.equal(empty.taskError,'No replayable requests');
  assert(isTerminalReplay(empty.status));
});

test('creation and polling consume progress counts with legacy top-level fallback', () => {
  const response=applyReplayResponse({status:'running',started_at:300.5,progress:{ready:true,total:1200,sent:600,completed:560,skipped:3},failed_count:2,target:{metrics_labels:{model_name:'optimized-model'}}},initial,305);
  assert.equal(response.requestCount,1200);
  assert.equal(response.completedCount,560);
  assert.equal(response.sentCount,600);
  assert.equal(response.failedCount,2);
  assert.equal(response.skippedCount,3);
  assert.equal(response.startedAt,300.5);
  assert.equal(response.statusUpdatedAt,305);
  assert.deepEqual(response.metricsLabels,{model_name:'optimized-model'});
  assert.equal(replayPercent(response),560/1200*100);
  const legacy=applyReplayResponse({status:'running',request_count:42,sent_count:12,completed_count:9},initial,310);
  assert.equal(replayPercent(legacy),9/42*100);
});

test('missing, null and malformed fields retain the last valid snapshot', () => {
  const running=applyReplayResponse({status:'running',request_count:10,sent_count:8,completed_count:6,started_at:300},initial,305);
  const recovered=applyReplayResponse({status:'draining',progress:{total:null,completed:'8',sent:-1},started_at:null,completed_count:NaN}, {...running,statusError:'Network error'},310);
  assert.equal(recovered.requestCount,10);
  assert.equal(recovered.completedCount,6);
  assert.equal(recovered.sentCount,8);
  assert.equal(recovered.startedAt,300);
  assert.equal(recovered.statusError,undefined);
  assert.equal(recovered.statusUpdatedAt,310);
  assert.throws(()=>applyReplayResponse({status:'not-a-status'},running),/未知回放状态/);
});

test('failed processing may be 100 percent and cancelling remains an active task', () => {
  const failed=applyReplayResponse({status:'failed',request_count:10,sent_count:10,completed_count:10,failed_count:1,error:'One request failed'},initial);
  assert.equal(replayPercent(failed),100);
  assert.equal(failed.status,'failed');
  assert.equal(isTerminalReplay('cancelling'),false);
  for(const status of ['succeeded','failed','cancelled'] as const)assert(isTerminalReplay(status));
  assert.equal(replayPercent({requestCount:10,completedCount:12}),100);
});
