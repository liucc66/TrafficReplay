import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { cacheQueries, createReplayCacheConfig, deriveKvCurrent, emptyCacheData, fetchReplayCache, parseCacheResult, replayCachePlan, retainReplayCache, type CacheResult } from '../src/replayCacheData';
import { createApiConfig } from '../src/apiConfig';
import type { Replay, Series } from '../src/types';

const config = createReplayCacheConfig({}, 15);
const task: Replay = { id:'task',modelId:'alias',modelName:'target',metricsName:'real-model',metricsLabels:{model_name:'real-model',deployment:'target-deploy'},source:{start:10,end:20},status:'running',startedAt:1000.75 };
const matrix = (result: unknown[]) => ({ status:'success',data:{resultType:'matrix',result} });
const vector = (result: unknown[]) => ({ status:'success',data:{resultType:'vector',result} });

test('cache config defaults to confirmed token counters and preserves explicit unit overrides', () => {
  assert.equal(config.counterUnit,'tokens');
  assert.equal(createReplayCacheConfig({VITE_REPLAY_CACHE_CONFIG:'{"counterUnit":"unknown"}'},15).counterUnit,'unknown');
  assert.equal(config.kvUnit,'ratio');
  assert.equal(createReplayCacheConfig({VITE_REPLAY_CACHE_CONFIG:'{"counterUnit":"tokens","kvUnit":"percent","windowSeconds":20}'},30).windowSeconds,120);
  for(const raw of ['[]','null','{"counterUnit":"bytes"}','{"kvMetric":"x or up"}','{"windowSeconds":0}','{"labels":{"__name__":"up"}}','{"unknown":true}']) assert.throws(()=>createReplayCacheConfig({VITE_REPLAY_CACHE_CONFIG:raw},15));
});

test('KV starts immediately, full rate windows never include pre-task traffic and terminal time is stable', () => {
  assert.equal(replayCachePlan({...task,startedAt:undefined},2000,config),undefined);
  assert.equal(replayCachePlan(task,1000.9,config),undefined);
  const early = replayCachePlan(task,1001,config)!;
  assert.deepEqual(early.range,{start:1001,end:1001}); assert.equal(early.rateRange,undefined);
  assert.equal(replayCachePlan(task,1060,config)?.rateRange,undefined);
  assert.deepEqual(replayCachePlan(task,1061,config)?.rateRange,{start:1061,end:1061});
  const ended = {...task,status:'cancelled' as const,finishedAt:1100.5};
  const final = replayCachePlan(ended,2000,config)!;
  assert.equal(final.terminal,true); assert.equal(replayCachePlan(task,1200,config)!.terminal,false);
  assert.equal(final.evaluatedAt,1131); assert.equal(final.settleAfter,1161);
  assert.deepEqual(replayCachePlan(ended,9999,config),final);
  assert.equal(replayCachePlan({...task,status:'succeeded',finishedAt:1001},2000,config)?.rateRange,undefined);
  for(const status of ['draining','cancelling'] as const) assert.equal(replayCachePlan({...task,status},1200,config)?.evaluatedAt,1200);
});

test('derived KV card tracks the curve: last defined point while running, earliest peak when terminal', () => {
  const series = (name: string, values: (number | undefined)[]): Series => ({ id: name, name, points: values.map((value, index) => ({ timestamp: 1000 + index * 15, value })) });
  const trend: CacheResult = { series: [series('a', [10, 30, undefined, undefined]), series('b', [20, 35, 28, undefined])] };
  const running = deriveKvCurrent(trend, false);
  assert.equal(running.value, 30); assert.equal(running.name, 'a'); assert.equal(running.observedAt, 1015);
  assert.deepEqual(running.series.map(s => s.points.map(p => p.timestamp)), [[1015], [1030]]);
  const peak = deriveKvCurrent(trend, true);
  assert.equal(peak.value, 35); assert.equal(peak.name, 'b'); assert.equal(peak.observedAt, 1015);
  // 并列峰值取首次达到时刻；跨序列并列取更早的点。
  assert.equal(deriveKvCurrent({ series: [series('a', [42, 42, 42])] }, true).observedAt, 1000);
  const tie = deriveKvCurrent({ series: [series('a', [30, undefined, 30]), series('b', [30, 30, undefined])] }, false);
  assert.equal(tie.value, 30); assert.equal(tie.name, 'b'); assert.equal(tie.observedAt, 1015);
  assert.deepEqual(deriveKvCurrent({ series: [series('a', [undefined, undefined])] }, false), { series: [] });
  const failed = deriveKvCurrent({ series: [], error: 'HTTP 503' }, false);
  assert.equal(failed.error, 'HTTP 503'); assert.equal(failed.value, undefined);
});

test('cache queries preserve instance labels, use weighted counter rates and guard stale/pre-start KV samples', () => {
  const q=cacheQueries(task,config);
  assert(q.kv.includes('* 100')); assert(!q.kv.includes('sum('));
  assert(q.kv.includes('timestamp(')); assert(q.kv.includes('>= 1000.75')); assert(q.kv.includes('(time() - 30)'));
  assert(q.hitRate.includes('100 * sum(rate(vllm:prefix_cache_hits_total'));
  assert(q.hitRate.includes('/ sum(rate(vllm:prefix_cache_queries_total'));
  assert(q.hitRate.includes('> 0')); assert(!q.hitRate.includes('avg('));
  for(const query of Object.values(q)) { assert(query.includes('model_name="real-model"')); assert(query.includes('deployment="target-deploy"')); assert(!query.includes('@')); assert(!query.includes('replay_id')); }
  assert(cacheQueries(task,{...config,kvUnit:'percent',labels:{role:'decode'}}).kv.includes('* 1'));
  assert(cacheQueries(task,{...config,labels:{role:'decode'}}).hitTokens.includes('role="decode"'));
  assert.throws(()=>cacheQueries(task,{...config,labels:{deployment:'another-deploy'}}),/冲突/);
});

test('KV retains independent engines on one instance and card maximum, including a real zero', () => {
  const rows=[{metric:{model_name:'m',instance:'host',engine:'0'},value:[1100,'64']},{metric:{model_name:'m',instance:'host',engine:'1'},value:[1100,'50']}];
  const result=parseCacheResult(vector(rows),'kv','vector',1100);
  assert.equal(result.series.length,2); assert.notEqual(result.series[0].id,result.series[1].id);
  assert.equal(result.value,64); assert(result.name?.includes('engine=0'));
  assert.equal(parseCacheResult(vector([{metric:{},value:[1100,'0']}]),'kv','vector',1100).value,0);
  assert.throws(()=>parseCacheResult(vector([rows[0],rows[0]]),'kv','vector',1100),/重复/);
});

test('missing/nonfinite counters remain unavailable; invalid percentages and unaggregated rates are rejected', () => {
  for(const raw of ['NaN','+Inf','-Inf','']) assert.equal(parseCacheResult(vector([{metric:{},value:[1100,raw]}]),'hitRate','vector',1100).value,undefined);
  assert.equal(parseCacheResult(vector([]),'hitTokens','vector',1100).value,undefined);
  assert.throws(()=>parseCacheResult(vector([{metric:{},value:[1100,'6400']}]),'kv','vector',1100),/单位/);
  assert.throws(()=>parseCacheResult(vector([{metric:{},value:[1100,'-1']}]),'hitTokens','vector',1100),/单位/);
  assert.throws(()=>parseCacheResult(vector([{metric:{engine:'0'}},{metric:{engine:'1'}}]),'hitRate','vector',1100),/聚合/);
  const curve=parseCacheResult(matrix([{metric:{instance:'host'},values:[[1100,'0'],[1115,'NaN'],[1130,'64']]}]),'kv','matrix',1130);
  assert.deepEqual(curve.series[0].points.map(p=>p.value),[0,undefined,64]);
  assert.throws(()=>parseCacheResult(matrix([]),'kv','vector',1100),/响应类型/);
  const missing=parseCacheResult(matrix([{metric:{instance:'host'},values:[[1100,'50'],[1130,'64']]}]),'kv','matrix',1130,{start:1100,end:1130,step:15});
  assert.deepEqual(missing.series[0].points.map(p=>p.value),[50,undefined,64]);
});

test('current and trend failures retain their own successful timestamp; success empty clears stale data', () => {
  const prev=emptyCacheData();
  prev.kv.current={series:[],value:64,observedAt:1100};
  prev.kv.trend={series:[{id:'host',name:'host',points:[{timestamp:1100,value:64}]}],observedAt:1100};
  const next=emptyCacheData(); next.kv.current={series:[],error:'HTTP 503'};
  const retained=retainReplayCache(prev,next);
  assert.equal(retained.kv.current.value,64); assert.equal(retained.kv.current.observedAt,1100);
  assert.equal(retained.kv.current.error,'HTTP 503'); assert.deepEqual(retained.kv.trend.series,[]);
  assert.equal(retainReplayCache(retained,emptyCacheData()).kv.current.value,undefined);
});

test('cache requests respect counter units, custom routes, deduplication and independent query failures', async () => {
  const originalFetch=globalThis.fetch, originalWindow=globalThis.window;
  (globalThis as any).window={setTimeout:globalThis.setTimeout};
  const paths:URL[]=[];
  globalThis.fetch=async (input, options)=>{
    const url=new URL(String(input),'http://localhost'); paths.push(url);
    const headers=new Headers(options?.headers); assert(!headers.has('Authorization')); assert(!headers.has('x-api-key'));
    const query=url.searchParams.get('query')!, range=url.pathname.endsWith('/query_range');
    if(!range||query.includes('@')) return new Response(JSON.stringify({error:'Invalid query syntax'}),{status:400});
    const current=url.searchParams.get('start')===url.searchParams.get('end');
    if(url.pathname.includes('tokens')&&query.includes('kv_cache')) return new Response(JSON.stringify({error:'temporary'}),{status:503});
    assert(Number(url.searchParams.get('step'))>=15);
    assert(Number(url.searchParams.get('start')) >= task.startedAt! + (query.includes('prefix_cache')?60:0));
    if(current)assert.equal(Number(url.searchParams.get('end')),1200,'rate cards evaluate at the exact observation time');
    const stamp=Number(url.searchParams.get('start'));
    const metric=query.includes('kv_cache')?{instance:'worker',engine:'0'}:{};
    const row=range?{metric,values:[[stamp,'50']]}:{metric,value:[stamp,'50']};
    return new Response(JSON.stringify({status:'success',data:{resultType:range?'matrix':'vector',result:[row]}}));
  };
  try{
    for(const [counterUnit,count] of [['unknown',1],['tokens',5],['blocks',3],['requests',3]] as const){
      const cfg={...config,counterUnit}; const api=createApiConfig({VITE_PROMETHEUS_API_PREFIX:`/api/cache-${counterUnit}`});
      const plan=replayCachePlan(task,1200,cfg)!;const before=paths.length;
      const result=await fetchReplayCache(task,plan,cfg,api);
      assert.equal(paths.length-before,count);
      assert.equal(result.hitTokens.current.value,counterUnit==='tokens'?50:undefined);
      assert.equal(result.hitRate.current.value,counterUnit==='unknown'?undefined:50);
      if(counterUnit==='tokens'){
        assert(result.kv.current.error?.includes('503'));assert(result.kv.trend.error?.includes('503'));
        assert.equal(result.kv.current.value,undefined);assert.equal(result.kv.trend.series.length,0);
        assert.equal(result.hitTokens.trend.series.length,1);
      }else{
        assert.equal(result.kv.current.value,50);assert.equal(result.kv.current.observedAt,1001);
        await fetchReplayCache(task,plan,cfg,api); assert.equal(paths.length-before,count,'successful cache queries share URL deduplication');
      }
    }
    assert(paths.every(url=>!(url.searchParams.get('query')!.includes('kv_cache')&&url.searchParams.get('start')===url.searchParams.get('end'))),'KV card must derive from the trend range query');
  }finally{globalThis.fetch=originalFetch;if(originalWindow===undefined)delete(globalThis as any).window;else globalThis.window=originalWindow;}
});

test('ended cache cards keep the historical window; KV card shows the replay peak without a single-point query', async () => {
  const originalFetch=globalThis.fetch, originalWindow=globalThis.window;
  (globalThis as any).window={setTimeout:globalThis.setTimeout};
  const paths:URL[]=[];
  globalThis.fetch=async input=>{
    const url=new URL(String(input),'http://localhost');paths.push(url);
    if(!url.pathname.endsWith('/query_range')||url.searchParams.get('query')!.includes('@')) return new Response(JSON.stringify({error:'Invalid query syntax'}),{status:400});
    const start=Number(url.searchParams.get('start')),end=Number(url.searchParams.get('end'));
    const step=Number(url.searchParams.get('step')),values:[number,string][]=[];
    for(let at=start;at<=end;at+=step)values.push([at,'42']);
    return new Response(JSON.stringify(matrix([{metric:{instance:'worker'},values}])));
  };
  try{
    const ended={...task,status:'succeeded' as const,finishedAt:1100.5};
    const plan=replayCachePlan(ended,99999,config)!;
    const result=await fetchReplayCache(ended,plan,config,createApiConfig({VITE_PROMETHEUS_API_PREFIX:'/api/cache-legacy'}));
    assert.equal(result.kv.current.error,undefined);
    assert.equal(result.kv.current.value,42);
    assert.equal(result.kv.current.observedAt,1001);
    assert.equal(result.kv.current.series[0].points[0].timestamp,1001);
    assert(paths.every(url=>!(url.searchParams.get('query')!.includes('kv_cache')&&url.searchParams.get('start')===url.searchParams.get('end'))),'KV card must derive from the trend range query');
    // 命中率/token 卡仍在原任务的固定时刻单点求值。
    assert(paths.some(url=>url.searchParams.get('start')==='1131'&&url.searchParams.get('end')==='1131'&&!url.searchParams.get('query')!.includes('kv_cache')));
    assert(paths.every(url=>Number(url.searchParams.get('end'))===1131));
  }finally{globalThis.fetch=originalFetch;if(originalWindow===undefined)delete(globalThis as any).window;else globalThis.window=originalWindow;}
});
