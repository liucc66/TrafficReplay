// All API responses are mocked. No real replay or inference requests are sent.
const {chromium,expect}=require('@playwright/test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const base=process.env.CHECK_BASE_URL||'http://127.0.0.1:4173';

(async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHECK_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  let release;
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1100}});
    const errors=[],queries=[],posts=[];
    page.on('pageerror',error=>errors.push(error.message));
    const now=Math.floor(Date.now()/1000);
    await page.clock.install({time:new Date(now*1000)});
    let task={replay_id:'latency-task',model_id:'model-a',source_model:'model-a',target_model:'model-a',status:'preparing',speed:2,cancellable:true,pausable:false,resumable:false,revision:1,start_time:now-1200,end_time:now-600,request_count:20,sent_count:0,completed_count:0,target:{metrics_labels:{model_name:'model-v2',deployment:'replay-deploy'}}};
    let active=true,failTTFT=false,emptyITL=false,holdE2E=false,held=false;
    await page.route('**/api/**',async route=>{
      const req=route.request(),url=new URL(req.url());let body,status=200;
      if(url.pathname.startsWith('/api/prometheus/')){
        assert(!req.headers().authorization,'metrics must not receive replay credentials');
        const query=url.searchParams.get('query');
        if(/kv_cache|prefix_cache/.test(query))body={status:'success',data:{resultType:url.pathname.endsWith('/query_range')?'matrix':'vector',result:[]}};
        else if(url.pathname.endsWith('/query_range'))body={status:'success',data:{resultType:'matrix',result:[]}};
        else if(query.startsWith('count by'))body={status:'success',data:{resultType:'vector',result:['model-a','model-b','model-v2'].map(model_name=>({metric:{model_name},value:[now,'0']}))}};
        else{
          const isReplay=query.includes(' @ '),at=Number(query.match(/ @ (\d+)/)?.[1]);
          queries.push({query,isReplay,at});
          if(isReplay){
            assert.deepEqual([...url.searchParams.keys()],['query']);
            assert(query.includes('model_name="model-v2"'));
            assert(query.includes('deployment="replay-deploy"'));
            const duration=query.match(/\[(\d+)([sm])\]/);
            const window=Number(duration[1])*(duration[2]==='m'?60:1);
            assert(at-window>=task.started_at,'rate window cannot reach before actual replay start');
          }
          if(isReplay&&holdE2E&&query.includes('e2e_request_latency')&&!held){held=true;await new Promise(resolve=>release=resolve);}
          if(isReplay&&failTTFT&&query.includes('time_to_first')){status=503;body={error:'temporary replay latency failure'};}
          else body={status:'success',data:{resultType:'vector',result:isReplay&&emptyITL&&query.includes('inter_token')?[]:[{metric:{model_name:isReplay?'model-v2':query.match(/model_name="([^"]+)"/)[1]},value:[at||now,isReplay?'0.222':'0.111']}]}};
        }
      }else{
        assert.equal(req.headers().authorization,'Bearer latency-test');
        if(req.method()==='POST'){
          posts.push(url.pathname);
          const action=url.pathname.split('/').at(-1);
          assert.equal(action,'cancel','restoring must never create or control a replay');
          task={...task,status:'cancelling',cancellable:false,pausable:false,resumable:false,revision:task.revision+1};status=202;
          body=task;
        }else if(url.pathname==='/api/replays/active')body={active,task:active?task:null};
        else body=task;
      }
      await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)}).catch(()=>{});
    });
    const authenticate=async()=>{
      await page.getByRole('button',{name:'连接设置',exact:true}).click();
      await page.locator('.settings-field input').fill('Bearer latency-test');
      await page.getByRole('button',{name:'应用设置',exact:true}).click();
    };
    const section=page.locator('.replay-latency-section');
    const ttft=section.locator('[data-replay-metric="ttft"]');
    const replayQueries=()=>queries.filter(q=>q.isReplay);
    await page.goto(base);
    await expect(section.locator('.metric-card')).toHaveCount(5);
    await expect(section).toContainText('等待创建回放任务');
    await page.getByRole('button',{name:'后端',exact:true}).click();
    await authenticate();
    await expect(page.locator('.replay-actions code')).toHaveText(task.replay_id);
    await expect(section).toContainText('等待实际打流开始时间');
    assert.equal(replayQueries().length,0);
    task={...task,status:'running',started_at:now,pausable:true,revision:2};
    await page.clock.runFor(2500);
    await expect(section).toContainText('采集中');
    assert.equal(replayQueries().length,0);
    await page.clock.runFor(31000);
    await expect(ttft.locator('.metric-value')).toContainText('0.222');
    assert.equal(replayQueries().length,5);
    await expect(section).toContainText('model-v2');
    await expect(section).toContainText('来源历史');
    await expect(page.locator('[data-metric="ttft"] .metric-value')).toContainText('0.111');
    const replayCount=replayQueries().length;
    await page.locator('#model').selectOption('model-b');
    await page.locator('#range').selectOption('43200');
    await expect(page.locator('.metrics-context')).toContainText('model-b');
    await expect(page.locator('.metrics-context')).toContainText('12h');
    assert.equal(replayQueries().length,replayCount,'left filters must not restart replay latency');
    await expect(ttft.locator('.metric-value')).toContainText('0.222');

    task={...task,status:'running',pausable:true,resumable:false,revision:task.revision+1};
    await page.clock.runFor(2500);
    await expect(page.locator('.replay-panel .badge')).toHaveText('回放中');
    holdE2E=true;
    await page.clock.runFor(31000);
    await expect.poll(()=>held).toBe(true);
    // Slow metric responses must not prevent cancellation or progress polling.
    await page.getByRole('button',{name:'取消回放',exact:true}).click();
    task={...task,status:'cancelled',finished_at:Math.floor(await page.evaluate(()=>Date.now()/1000)),revision:task.revision+1};active=false;
    await page.clock.runFor(2500);
    await expect(page.locator('.replay-panel .badge')).toHaveText('已取消');
    release();holdE2E=false;
    await expect(section).toContainText('补采尾部指标');
    await page.clock.runFor(95000);
    await expect(section).toContainText('最终观测已固定');
    const finalAt=task.finished_at+30;
    assert.equal(replayQueries().at(-1).at,finalAt);
    const endCount=replayQueries().length;
    await page.clock.runFor(65000);
    assert.equal(replayQueries().length,endCount,'settled terminal metrics must stop polling');
    await page.getByRole('button',{name:'刷新指标',exact:true}).click();
    await expect(section).toContainText('最终观测已固定');
    await expect.poll(()=>replayQueries().length).toBeGreaterThan(endCount);
    assert.equal(replayQueries().at(-1).at,finalAt);
    await page.reload();await authenticate();
    await expect(section).toContainText('最终观测已固定');
    assert.equal(replayQueries().at(-1).at,finalAt,'reload of ended task must query its fixed historical instant');
    assert.equal(posts.length,1);
    await page.getByRole('button',{name:'Switch to English',exact:true}).click();
    await expect(section).toContainText('Replay live latency');
    await page.setViewportSize({width:320,height:900});
    assert(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),'320px page must not overflow');
    fs.mkdirSync('test-results',{recursive:true});
    await section.screenshot({path:'test-results/replay-latency-mobile.png'});
    await page.setViewportSize({width:1440,height:1100});
    await page.getByRole('button',{name:'切换到中文',exact:true}).click();
    await section.screenshot({path:'test-results/replay-latency-desktop.png'});
    task={...task,replay_id:'latency-task-2',status:'preparing',started_at:undefined,finished_at:undefined,revision:1};active=true;
    const beforeNewTask=replayQueries().length;
    await authenticate();
    await expect(section).toContainText('latency-task-2');
    await expect(ttft.locator('.metric-value')).toContainText('—');
    await expect(ttft.locator('.metric-observed')).toHaveCount(0);
    assert.equal(replayQueries().length,beforeNewTask,'new unstarted task must clear old values without querying');
    assert.deepEqual(errors,[]);
    console.log('PASS: existing cards unchanged; replay-only target/window, warm-up, partial failure timestamps, reload, slow-query cancellation, terminal fixed-time recovery, manual refresh, English and 320px layout.');
  }finally{if(release)release();await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
