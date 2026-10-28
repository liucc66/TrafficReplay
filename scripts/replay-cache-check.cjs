// All API responses are mocked. No inference requests or real replay creation.
const {chromium,expect}=require('@playwright/test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const base=process.env.CHECK_BASE_URL||'http://127.0.0.1:4173';
const tokens=process.env.CHECK_CACHE_TOKENS!=='0';

(async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHECK_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1100}});
    await page.addInitScript(()=>{
      window.cacheAxisLabels=[];
      const fillText=CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText=function(text,...args){
        const chart=this.canvas.closest('[data-cache-chart]');
        if(chart)window.cacheAxisLabels.push({chart:chart.dataset.cacheChart,text:String(text)});
        return fillText.call(this,text,...args);
      };
    });
    const errors=[],queries=[],posts=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(/same key|unique.*key/i.test(message.text()))errors.push(message.text());});
    const now=Math.floor(Date.now()/1000);
    await page.clock.install({time:new Date(now*1000)});
    let task={replay_id:'cache-task',model_id:'model-a',source_model:'model-a',target_model:'model-a',status:'preparing',speed:2,cancellable:true,pausable:false,resumable:false,revision:1,start_time:now-1200,end_time:now-600,request_count:20,sent_count:0,completed_count:0,target:{metrics_labels:{model_name:'model-v2',deployment:'replay-deploy'}}};
    let failKV=false,emptyRate=false,missingKV=false,confirmedTokens=tokens;
    await page.route('**/api/**',async route=>{
      const req=route.request(),url=new URL(req.url());let body,status=200;
      if(url.pathname.startsWith('/api/prometheus/')){
        assert(!req.headers().authorization);
        const query=url.searchParams.get('query'),isRange=url.pathname.endsWith('/query_range');
        const key=query.includes('kv_cache_usage_perc')?'kv':query.includes('prefix_cache_queries_total')?'hitRate':query.includes('prefix_cache_hits_total')?'hitTokens':undefined;
        if(key){
          // Reproduce a proxy that rejects @ in instant queries, while accepting range queries.
          if(!isRange||query.includes('@')){await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Invalid query syntax'})});return;}
          const at=Number(url.searchParams.get('end'));
          const start=Number(url.searchParams.get('start')),end=Number(url.searchParams.get('end')),step=Number(url.searchParams.get('step'));
          queries.push({key,query,isRange,at,start,end,step});
          assert(query.includes('model_name="model-v2"'));assert(query.includes('deployment="replay-deploy"'));
          if(key!=='kv')assert(confirmedTokens,'unknown counter units must not be queried');
          assert(start>=Math.ceil(task.started_at+(key==='kv'?0:60)));assert(step>=15);
          if(failKV&&key==='kv'){status=503;body={error:'temporary cache query failure'};}
          else{
            const values=key==='kv'?[64,50]:key==='hitRate'?[68]:[1280];
            const result=(key==='hitRate'&&emptyRate||key==='kv'&&missingKV)?[]:values.map((value,i)=>{
              const metric=key==='kv'?{model_name:'model-v2',deployment:'replay-deploy',instance:'worker:8000',engine:String(i)}:{};
              const samples=[];if(isRange)for(let time=start;time<=end;time+=step)samples.push([time,String(value-(key==='kv'?0:(end-time)*.01))]);
              return isRange?{metric,values:samples}:{metric,value:[at,String(value)]};
            });
            body={status:'success',data:{resultType:isRange?'matrix':'vector',result}};
          }
        }else if(query.startsWith('count by'))body={status:'success',data:{resultType:'vector',result:['model-a','model-b','model-v2'].map(model_name=>({metric:{model_name},value:[now,'0']}))}};
        else body={status:'success',data:{resultType:isRange?'matrix':'vector',result:[]}};
      }else{
        assert.equal(req.headers().authorization,'Bearer cache-test');
        if(req.method()==='POST'){
          posts.push(url.pathname);
          const action=url.pathname.split('/').at(-1);
          assert.equal(action,'cancel','restoring must never create or control a replay');
          task={...task,status:'cancelling',cancellable:false,pausable:false,resumable:false,revision:task.revision+1};status=202;
          body=task;
        }else if(url.pathname==='/api/replays/active'){
          const active=!['cancelled','succeeded','failed'].includes(task.status);body={active,task:active?task:null};
        }else body=task;
      }
      await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)}).catch(()=>{});
    });
    const auth=async()=>{
      await page.getByRole('button',{name:'连接设置',exact:true}).click();
      await page.locator('.settings-field input').fill('Bearer cache-test');
      await page.getByRole('button',{name:'应用设置',exact:true}).click();
    };
    const section=page.locator('.replay-cache-section'),kv=section.locator('[data-cache-metric="kv"]'),hitRate=section.locator('[data-cache-metric="hitRate"]'),hitTokens=section.locator('[data-cache-metric="hitTokens"]');
    await page.goto(base);
    await expect(section.locator('.metric-card')).toHaveCount(3);
    await expect(section).toContainText('等待创建回放任务');
    await page.getByRole('button',{name:'后端',exact:true}).click();await auth();
    await expect(page.locator('.replay-cache-section')).toHaveCount(1);
    await expect(page.locator('.replay-latency-section')).toHaveCount(1);
    await expect(page.locator('[data-replay-metric]')).toHaveCount(5);
    await expect(section).toContainText('cache-task');await expect(section).toContainText('等待实际打流开始时间');
    assert.equal(queries.length,0);
    await expect.poll(()=>page.evaluate(()=>['kv','hitRate','hitTokens'].every(chart=>window.cacheAxisLabels.some(item=>item.chart===chart&&item.text==='00:00')))).toBe(true);
    await page.evaluate(()=>{window.cacheAxisLabels=[];});
    task={...task,status:'running',started_at:now-180+.75,pausable:true,revision:2};
    await page.clock.runFor(2500);
    await expect(kv.locator('.metric-value')).toContainText('64');
    await expect(kv).toContainText('当前实例最大值');await expect(kv).toContainText('engine=0');
    await expect(section.locator('[data-cache-chart="kv"] .cache-legend>span')).toHaveCount(2);
    await expect(section).toContainText('deployment=replay-deploy');
    await expect(section.getByRole('checkbox',{name:'相对时间',exact:true})).toBeChecked();
    await expect.poll(()=>page.evaluate(()=>window.cacheAxisLabels.some(item=>item.chart==='kv'&&item.text==='00:00'))).toBe(true);
    if(tokens){await expect(hitRate.locator('.metric-value')).toContainText('68');await expect(hitTokens.locator('.metric-value')).toContainText('1,280');}
    else {await expect(hitRate).toContainText('请先确认缓存计数单位');await expect(hitTokens.locator('.metric-value')).toContainText('—');}
    const beforeLeft=queries.length;
    await page.locator('#model').selectOption('model-b');await page.locator('#range').selectOption('43200');
    await expect(page.locator('.metrics-context')).toContainText('model-b');
    assert.equal(queries.length,beforeLeft);await expect(kv.locator('.metric-value')).toContainText('64');
    const observed=await kv.locator('.metric-observed').innerText();
    failKV=true;emptyRate=true;
    await page.clock.runFor(31000);
    await expect(kv).toContainText('查询失败 · 显示上次数据');await expect(kv.locator('.metric-value')).toContainText('64');
    assert.equal(await kv.locator('.metric-observed').innerText(),observed);
    await expect(section.locator('[data-cache-chart="kv"] .cache-legend>span')).toHaveCount(2);
    if(tokens){await expect(hitRate.locator('.metric-value')).toContainText('—');await expect(hitTokens.locator('.metric-value')).toContainText('1,280');}
    failKV=false;emptyRate=false;
    assert.equal(queries.filter(q=>q.key==='kv'&&q.isRange).at(-1).start,Math.ceil(task.started_at));
    task={...task,status:'running',pausable:true,resumable:false,revision:task.revision+1};
    await page.clock.runFor(2500);await expect(section).toContainText('回放中');
    await section.getByRole('checkbox',{name:'相对时间',exact:true}).check();
    await section.locator('[data-cache-chart="kv"] .cache-trend').scrollIntoViewIfNeeded();
    const bounds=await section.locator('[data-cache-chart="kv"] .cache-trend').boundingBox();
    await page.mouse.move(bounds.x+bounds.width*.75,bounds.y+bounds.height*.43);
    await expect(section.locator('[data-cache-chart="kv"]')).toContainText('相对时间 +');
    fs.mkdirSync('test-results',{recursive:true});
    await page.mouse.move(0,0);await section.screenshot({path:`test-results/replay-cache-${tokens?'tokens':'unknown'}-desktop.png`});
    await page.getByRole('button',{name:'取消回放',exact:true}).click();
    await expect(section).toContainText('正在取消');
    const cancellingQueries=queries.length;await page.clock.runFor(31000);
    await expect.poll(()=>queries.length).toBeGreaterThan(cancellingQueries);
    task={...task,status:'cancelled',finished_at:Math.floor(await page.evaluate(()=>Date.now()/1000)),revision:task.revision+1};
    await page.clock.runFor(2500);await expect(section).toContainText('补采尾部指标');
    await page.clock.runFor(95000);await expect(section).toContainText('最终观测已固定');
    const finalAt=task.finished_at+30;
    assert.equal(queries.at(-1).at,finalAt);
    const endCount=queries.length;await page.clock.runFor(65000);assert.equal(queries.length,endCount);
    await page.reload();await auth();await expect(section).toContainText('最终观测已固定');
    assert.equal(queries.at(-1).at,finalAt);assert.equal(posts.length,1);
    missingKV=true;await page.clock.runFor(31000);await page.getByRole('button',{name:'刷新指标',exact:true}).click();
    await expect(kv.locator('.metric-value')).toContainText('—');
    await expect(section.locator('[data-cache-chart="kv"] .cache-legend>span')).toHaveCount(0);
    await page.getByRole('button',{name:'Switch to English',exact:true}).click();
    await expect(section).toContainText('Replay cache monitoring');
    if(!tokens)await expect(hitTokens).toContainText('Confirm the cache counter unit first');
    {
      confirmedTokens=true;
      await section.getByLabel('Cache counter unit',{exact:true}).selectOption('tokens');
      await expect(hitRate.locator('.metric-value')).toContainText('68');
      await expect(hitTokens.locator('.metric-value')).toContainText('1,280');
      await section.getByLabel('Cache counter unit',{exact:true}).selectOption('blocks');
      await expect(hitRate.locator('.metric-value')).toContainText('68');
      await expect(hitTokens).toContainText('Counter unit is not tokens; token/s is unavailable');
      confirmedTokens=false;
      await section.getByLabel('Cache counter unit',{exact:true}).selectOption('unknown');
      await expect(hitRate).toContainText('Confirm the cache counter unit first');
      await expect(hitRate.locator('.metric-value')).toContainText('—');
    }
    for(const width of [736,360,320]){
      await page.setViewportSize({width,height:950});
      assert(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),`no overflow at ${width}px`);
    }
    await section.screenshot({path:`test-results/replay-cache-${tokens?'tokens':'unknown'}-mobile.png`});
    await page.getByRole('button',{name:'切换到中文',exact:true}).click();
    task={...task,replay_id:'cache-task-2',status:'preparing',started_at:undefined,finished_at:undefined,revision:1};
    const beforeNew=queries.length;await auth();
    await expect(section).toContainText('cache-task-2');await expect(kv.locator('.metric-value')).toContainText('—');
    await expect(kv.locator('.metric-observed')).toHaveCount(0);assert.equal(queries.length,beforeNew);
    await expect(page.locator('.replay-cache-section')).toHaveCount(1);
    await expect(page.locator('[data-replay-metric]')).toHaveCount(5);
    // Receiving a fractional started_at in its first second must not skip a whole 30s refresh.
    const freshStart=Math.ceil(await page.evaluate(()=>Date.now()/1000));
    await page.clock.pauseAt(new Date((freshStart+.8)*1000));
    task={...task,status:'running',started_at:freshStart+.75,pausable:true,revision:2};
    missingKV=false;confirmedTokens=tokens;
    await auth();await expect(section).toContainText('回放中');
    await page.clock.runFor(1100);
    await expect(kv.locator('.metric-value')).toContainText('64');
    assert(queries.length>beforeNew,'first cache request should run at the next whole second');
    assert.deepEqual(errors,[]);
    console.log(`PASS: cache ${tokens?'token counters':'unconfirmed units'}, instance maximum/curves, target isolation, failures, empty results, reload, final historical time, relative tooltip, English and 320px layout.`);
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
