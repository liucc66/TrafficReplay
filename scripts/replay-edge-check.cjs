// Regressions for reviewed replay edge cases. All API calls are mocked.
const {chromium,expect}=require('@playwright/test');
const assert=require('node:assert/strict');
const base=process.env.CHECK_BASE_URL||'http://127.0.0.1:4173';
const proxy=process.env.CHECK_PROXY==='1';
const now=Math.floor(Date.now()/1000);
const fullTask=(alias='edge-model')=>({replay_id:'edge-task',status:'running',model_id:alias,source_model:alias,target_model:alias,
  start_time:now-1200,end_time:now-600,started_at:now-120,speed:2,cancellable:true,revision:1,
  progress:{ready:true,total:100,sent:30,completed:20},target:{metrics_labels:{model_name:'edge-model'}}});

(async()=>{
  const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const contexts=[],errors=[];
  const fixture=async(task=null)=>{
    const context=await browser.newContext({viewport:{width:1440,height:1120}});contexts.push(context);
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    const state={task,createPolicy:'rejected',creates:[],curves:[],curvePolicy:'normal',waitingValue:'8'};
    await context.route('**/api/**',async route=>{
      const req=route.request(),url=new URL(req.url());let status=200,body;
      if(url.pathname.endsWith('/query')){
        assert(!req.headers().authorization);
        const discovery=url.searchParams.get('query').startsWith('count by');
        body={status:'success',data:{resultType:'vector',result:[{metric:discovery?{model_name:'edge-model'}:{},value:[now,'1']}]}};
      }else if(url.pathname.endsWith('/query_range')){
        assert(!req.headers().authorization);
        const start=Number(url.searchParams.get('start')),end=Number(url.searchParams.get('end')),query=url.searchParams.get('query');
        state.curves.push({start,end,query});
        const running=query.includes('num_requests_running');
        if(state.curvePolicy==='failed'||state.curvePolicy==='partial'&&running){status=503;body={error:'temporary metrics outage'};}
        else{
          const samples=state.task&&start===state.task.started_at?[now-90,now-60]:[start,end];
          const values=running?['2','8']:[state.waitingValue,state.waitingValue];
          body={status:'success',data:{resultType:'matrix',result:state.curvePolicy==='empty'?[]:[{metric:{model_name:'edge-model'},values:samples.map((time,i)=>[time,values[i]])}]}};
        }
      }else if(url.pathname==='/api/models'){
        body={target_models:['edge-model']};
      }else{
        assert.equal(req.headers().authorization,proxy?undefined:'Bearer edge-test-only');
        if(url.pathname==='/api/replays/active')body={active:!!state.task&&!['succeeded','cancelled'].includes(state.task.status),task:state.task&&!['succeeded','cancelled'].includes(state.task.status)?state.task:null};
        else if(url.pathname==='/api/replays'&&req.method()==='POST'){
          const input=req.postDataJSON(),key=req.headers()['idempotency-key'];state.creates.push({body:input,key});
          if(state.createPolicy==='rejected'){status=400;body={error:'Selected model is invalid'};}
          else if(state.createPolicy==='unknown'){status=503;body={error:'Creation outcome unknown'};}
          else{status=202;state.task={...fullTask(input.target_model),...input};body=state.task;}
        }else body=state.task;
      }
      await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)}).catch(()=>{});
    });
    return {page,state};
  };
  const authenticate=async page=>{
    if(proxy)return;
    await page.getByRole('button',{name:'连接设置',exact:true}).click();
    await page.locator('.settings-field input').fill('Bearer edge-test-only');
    await page.getByRole('button',{name:'应用设置',exact:true}).click();
    await expect(page.locator('.recovery-banner').filter({hasText:'正在恢复回放任务'})).toHaveCount(0);
  };
  const enter=async page=>{
    await page.goto(base);await page.getByRole('button',{name:'后端',exact:true}).click();
    // Proxy recovery may select the task's source before model discovery finishes.
    await expect(page.locator('#model option[value="edge-model"]')).toHaveCount(1);await authenticate(page);
  };
  const select=async page=>{
    const inputs=page.locator('.selection-form input');
    await inputs.first().fill(await inputs.first().getAttribute('min'));
    await inputs.last().fill(await inputs.last().getAttribute('max'));
    if(await page.locator('.target-choice button').isEnabled()){
      await page.locator('.target-choice button').click();
      await page.locator('.target-option').first().click();
    }
  };
  const begin=async page=>{
    await expect(page.getByRole('button',{name:'确认回放',exact:true})).toBeEnabled();
    await page.getByRole('button',{name:'确认回放',exact:true}).click();
    await page.getByRole('button',{name:'开始回放',exact:true}).click();
  };
  const rejected=async page=>{
    await select(page);await begin(page);await expect(page.getByRole('dialog')).toContainText('创建回放失败');
    await page.getByRole('button',{name:'取消',exact:true}).click();
  };
  const pending=page=>page.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.endsWith('.pending')).map(key=>JSON.parse(sessionStorage.getItem(key))));
  try{
    const first=await fixture();await enter(first.page);await rejected(first.page);
    assert.equal((await pending(first.page)).length,0);
    await expect(first.page.locator('#replay-speed')).toBeEnabled();
    await first.page.reload();await authenticate(first.page);await select(first.page);
    await first.page.locator('#replay-speed').selectOption('2');first.state.createPolicy='normal';await begin(first.page);
    await expect(first.page.locator('.replay-actions code')).toHaveText('edge-task');
    assert.notEqual(first.state.creates[0].key,first.state.creates[1].key);
    assert.equal(first.state.creates[1].body.speed,2);

    const uncertain=await fixture();uncertain.state.createPolicy='unknown';await enter(uncertain.page);await rejected(uncertain.page);
    const original=uncertain.state.creates[0];uncertain.state.createPolicy='rejected';
    await uncertain.page.getByRole('button',{name:'重试原创建请求',exact:true}).click();
    await expect.poll(()=>uncertain.state.creates.length).toBe(2);
    assert.equal((await pending(uncertain.page))[0].key,original.key,'a rejected retry must not erase an earlier uncertain attempt');
    await uncertain.page.getByRole('button',{name:'取消回放',exact:true}).click();
    await expect(uncertain.page.locator('.replay-panel .badge')).toHaveText('已取消');
    await uncertain.page.getByRole('button',{name:'后端',exact:true}).click();
    await expect(uncertain.page.getByRole('button',{name:'重试原创建请求',exact:true})).toBeEnabled();
    uncertain.state.createPolicy='normal';await uncertain.page.getByRole('button',{name:'重试原创建请求',exact:true}).click();
    await expect(uncertain.page.locator('.replay-actions code')).toHaveText('edge-task');
    assert.deepEqual(uncertain.state.creates[2],original);assert.equal((await pending(uncertain.page)).length,0);

    const alias=await fixture(fullTask('edge-alias'));await enter(alias.page);
    await expect(alias.page.locator('.replay-actions code')).toHaveText('edge-task');
    await expect(alias.page.locator('#model')).toHaveValue('edge-model');
    await expect.poll(()=>alias.state.curves.some(curve=>curve.start<=alias.state.task.start_time&&curve.end>=alias.state.task.end_time&&curve.query.includes('model_name="edge-model"'))).toBe(true);
    assert(!alias.state.curves.some(curve=>curve.query.includes('model_name="edge-alias"')));
    await alias.page.getByRole('button',{name:'刷新模型列表',exact:true}).click();
    await expect(alias.page.getByRole('button',{name:'刷新模型列表',exact:true})).toBeEnabled();
    await alias.page.getByRole('button',{name:'连接设置',exact:true}).click();
    await expect(alias.page.locator('.endpoint-list')).toContainText('source_model = edge-alias');
    await alias.page.getByRole('button',{name:'关闭',exact:true}).click();
    // A different source must not use the target deployment's metric name.
    const separate=await fixture({...fullTask('target-alias'),source_model:'source-model'});await enter(separate.page);
    await expect(separate.page.locator('#model')).toHaveValue('source-model');
    await expect.poll(()=>separate.state.curves.some(curve=>curve.query.includes('model_name="source-model"'))).toBe(true);

    const outage=await fixture(fullTask());await enter(outage.page);
    const chart=outage.page.locator('.replay-panel .load-chart');await expect(chart).toHaveCount(1);
    const tooltip=async()=>{
      const box=await chart.boundingBox();await outage.page.mouse.move(0,0);await outage.page.mouse.move(box.x+box.width*.6,box.y+100);
      await expect(chart.locator('b')).toHaveCount(2);return chart.locator('b').allTextContents();
    };
    assert.deepEqual(await tooltip(),['8','8']);
    const refresh=async(seconds)=>{
      const count=outage.state.curves.length;
      await outage.page.clock.setFixedTime(new Date((now+seconds)*1000));
      await outage.page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
      await expect.poll(()=>outage.state.curves.length).toBeGreaterThan(count);
    };
    outage.state.curvePolicy='partial';outage.state.waitingValue='12';await refresh(31);
    await expect(outage.page.locator('.replay-panel .chart-error')).toContainText('temporary metrics outage');
    assert.deepEqual(await tooltip(),['8','12'],'retain failed running, update successful waiting');
    outage.state.curvePolicy='failed';await refresh(62);
    await expect(outage.page.locator('.replay-panel .chart-error')).toContainText('waiting');
    assert.deepEqual(await tooltip(),['8','12'],'retain both curves through a complete metrics outage');
    outage.state.curvePolicy='empty';await refresh(93);
    await expect(outage.page.locator('.replay-panel .chart-error')).toHaveCount(0);
    const box=await chart.boundingBox();await outage.page.mouse.move(0,0);await outage.page.mouse.move(box.x+box.width*.6,box.y+100);
    await expect(chart.locator('b').first()).not.toBeVisible();

    const clear=await browser.newContext({viewport:{width:1440,height:1120}});contexts.push(clear);
    const page=await clear.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(base);await select(page);
    await expect(page.getByRole('button',{name:'确认回放',exact:true})).toBeEnabled();
    const history=page.locator('.load-chart').first(),bounds=await history.boundingBox();
    await page.mouse.click(bounds.x+bounds.width-12,bounds.y+12);
    await expect(page.locator('.selection-form input').first()).toHaveValue('');
    await expect(page.locator('.selection-form input').last()).toHaveValue('');
    await expect(page.getByRole('button',{name:'确认回放',exact:true})).toBeDisabled();
    await page.getByRole('button',{name:'Switch to English',exact:true}).click();
    await expect(page.locator('.selection-form input').first()).toHaveValue('');
    await page.getByRole('button',{name:'切换到中文',exact:true}).click();
    await page.mouse.move(bounds.x+bounds.width*.3,bounds.y+100);await page.mouse.down();
    await page.mouse.move(bounds.x+bounds.width*.6,bounds.y+100,{steps:8});await page.mouse.up();
    await expect(page.getByRole('button',{name:'确认回放',exact:true})).toBeEnabled();
    assert.deepEqual(errors,[]);
    console.log('PASS: rejected creation unlocks new input; unknown attempts keep original keys across retries; server labels restore history and aliases; failed series retain data while successful empty results clear it; toolbox clear synchronizes selection. Auth='+ (proxy?'proxy':'manual'));
  }finally{await Promise.all(contexts.map(context=>context.close()));await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
