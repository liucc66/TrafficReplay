import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { updateLoadAxis } from '../src/loadAxis';
import type { LoadData } from '../src/types';
const data=(running:number,waiting:number):LoadData=>({running:[{id:'r',name:'m',points:[{timestamp:1,value:running}]}],waiting:[{id:'w',name:'m',points:[{timestamp:1,value:waiting}]}],errors:[]});
test('same metric shares both windows, different metrics scale independently and only grow',()=>{
  const history=data(200,3),replay=data(100,12);
  const first=updateLoadAxis(undefined,'h','r',history,replay);
  assert.deepEqual(first.max,{running:230,waiting:20});
  const lower=updateLoadAxis(first,'h','r',data(5,1),data(4,0));
  assert.deepEqual(lower.max,first.max);
  const peak=updateLoadAxis(lower,'h','r',lower.history,data(300,25));
  assert.deepEqual(peak.max,{running:350,waiting:30});
  const reset=updateLoadAxis(peak,'new-history','new-task',peak.history,peak.replay);
  assert.deepEqual(reset.max,{running:10,waiting:10});
  const loaded=updateLoadAxis(reset,'new-history','new-task',data(12,0),data(4,1));
  assert.deepEqual(loaded.max,{running:20,waiting:10});
});
test('failure and empty results keep the current scale; invalid values cannot poison it',()=>{
  const first=updateLoadAxis(undefined,'h','r',data(50,12),data(0,0));
  const next=updateLoadAxis(first,'h','r',{running:[],waiting:[],errors:['failed']},data(NaN,Infinity));
  assert.deepEqual(next.max,first.max);
});
