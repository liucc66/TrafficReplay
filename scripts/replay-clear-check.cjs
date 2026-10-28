// Mock HTTP only: clearing must never delete backend records or send inference traffic.
const { chromium, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = process.env.CHECK_BASE_URL || 'http://127.0.0.1:4173';
const scope = '/api/replays|/api/replays/{id}|/api/replays/active|/api/replays/{id}/cancel';
const snapshotKey = `trafficReplay.v2.${scope}`;
const terminal = status => ['succeeded', 'failed', 'cancelled'].includes(status);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHECK_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const contexts = [], errors = [], gates = [];
  const now = Math.floor(Date.now() / 1000);
  const makeTask = (status = 'running', id = 'clear-task') => ({ replay_id: id, model_id: 'clear-model', source_model: 'clear-model', status, speed: 2, revision: 1,
    start_time: now - 1200, end_time: now - 600, started_at: now - 120, finished_at: terminal(status) ? now - 5 : undefined,
    cancellable: !terminal(status) && status !== 'cancelling', request_count: 100, sent_count: 80, completed_count: 60,
    target: { metrics_labels: { model_name: 'clear-model', deployment: 'clear-deployment' } } });
  const fixture = async (status = 'running') => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }); contexts.push(context);
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.clock.install({ time: new Date(now * 1000) });
    const state = { task: makeTask(status), activeCode: 200, activeBody: undefined, activeCalls: 0, statusCalls: 0, posts: [], observations: 0, holdMetrics: false, held: 0, released: 0, release: undefined, holdActive: false, activeHeld: false, releaseActive: undefined, createLost: false };
    let metricsGate, activeGate;
    state.holdObservation = () => { state.holdMetrics = true; metricsGate = new Promise(resolve => { state.release = resolve; gates.push(resolve); }); };
    state.holdCheck = () => { state.holdActive = true; activeGate = new Promise(resolve => { state.releaseActive = resolve; gates.push(resolve); }); };
    await context.route('**/api/**', async route => {
      const req = route.request(), url = new URL(req.url()); let body, code = 200;
      if (url.pathname.startsWith('/api/prometheus/')) {
        assert(!req.headers().authorization, 'replay credentials must not enter metric queries');
        const query = url.searchParams.get('query'), range = url.pathname.endsWith('/query_range');
        if (query.startsWith('count by')) body = { status: 'success', data: { resultType: 'vector', result: [{ metric: { model_name: 'clear-model' }, value: [now, '1'] }] } };
        else {
          const observation = query.includes('clear-deployment');
          if (observation) {
            state.observations++;
            if (state.holdMetrics) { state.held++; await metricsGate; state.released++; }
          }
          const start = range ? Number(url.searchParams.get('start')) : Number(query.match(/ @ (\d+)/)?.[1]) || now;
          const metric = { model_name: 'clear-model', ...(query.includes('kv_cache') ? { instance: 'worker-0' } : {}) };
          const result = range ? [{ metric, values: [[start, query.includes('kv_cache') ? '42' : '2']] }] : [{ metric, value: [start, '0.222'] }];
          body = { status: 'success', data: { resultType: range ? 'matrix' : 'vector', result } };
        }
      } else if(url.pathname==='/api/models') {
        body={target_models:['clear-model']};
      } else {
        assert.equal(req.headers().authorization, 'Bearer clear-test');
        if (req.method() !== 'GET') {
          assert.equal(url.pathname, '/api/replays', 'clear must not call a delete/cancel/control endpoint');
          assert.equal(req.method(), 'POST'); state.posts.push({ body: req.postDataJSON(), key: req.headers()['idempotency-key'] });
          if (state.createLost) { code = 503; body = { error: 'creation outcome unknown' }; }
          else { code = 202; state.task = { ...makeTask('running', 'new-task'), ...req.postDataJSON() }; body = state.task; }
        } else if (url.pathname.endsWith('/active')) {
          state.activeCalls++; code = state.activeCode;
          if (state.holdActive) { state.activeHeld = true; await activeGate; }
          body = code === 200 ? state.activeBody ?? { active: !!state.task && !terminal(state.task.status), task: state.task && !terminal(state.task.status) ? state.task : null } : { error: 'active query unavailable' };
        } else { state.statusCalls++; body = state.task; }
      }
      await route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
    });
    return { page, state };
  };
  const auth = async page => {
    await page.getByRole('button', { name: '连接设置', exact: true }).click();
    await page.locator('.settings-field input').fill('Bearer clear-test');
    await page.getByRole('button', { name: '应用设置', exact: true }).click();
  };
  const enter = async page => {
    await page.goto(base); await page.getByRole('button', { name: '后端', exact: true }).click(); await auth(page);
    await expect(page.locator('.replay-actions code')).toHaveText('clear-task');
  };
  const finish = async (fixture, status = 'succeeded') => {
    fixture.state.task = { ...fixture.state.task, status, finished_at: now - 5, cancellable: false, revision: fixture.state.task.revision + 1 };
    await fixture.page.clock.runFor(2500);
    await expect(fixture.page.getByRole('button', { name: '清空数据', exact: true })).toBeEnabled();
  };
  const select = async page => {
    const inputs = page.locator('.selection-form input');
    await inputs.first().fill((await inputs.first().getAttribute('min')).replace(/:00$/, ''));
    await inputs.last().fill((await inputs.last().getAttribute('max')).replace(/:00$/, ''));
  };
  const begin = async page => {
    if(await page.locator('.target-choice button').isEnabled()){
      await page.locator('.target-choice button').click();
      await page.locator('.target-option').first().click();
    }
    await page.getByRole('button', { name: '确认回放', exact: true }).click();
    await page.getByRole('button', { name: '开始回放', exact: true }).click();
  };
  const expectEmpty = async page => {
    await expect(page.locator('.replay-panel .badge')).toHaveText('等待回放');
    await expect(page.locator('.replay-empty')).toBeVisible();
    await expect(page.locator('.replay-panel .load-chart, .replay-progress, .replay-actions code')).toHaveCount(0);
    await expect(page.locator('[data-replay-metric="ttft"] .metric-value')).toContainText('—');
    await expect(page.locator('[data-cache-metric="kv"] .metric-value')).toContainText('—');
    await expect(page.locator('[data-cache-chart="kv"] .cache-legend>span')).toHaveCount(0);
    await expect(page.locator('.replay-trend-context').first()).toContainText('等待创建回放任务');
    assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).replay, snapshotKey), undefined);
  };
  try {
    const main = await fixture(); await enter(main.page);
    for (const phase of ['queued', 'preparing', 'running', 'draining', 'cancelling']) {
      main.state.task = { ...main.state.task, status: phase, revision: main.state.task.revision + 1 };
      await main.page.clock.runFor(2500);
      await expect(main.page.getByRole('button', { name: '清空数据', exact: true })).toBeDisabled();
      await expect(main.page.locator('#clear-replay-hint')).toHaveText('任务尚未结束，无法清空数据');
    }
    await finish(main); await select(main.page);
    await expect(main.page.locator('[data-cache-metric="kv"] .metric-value')).toContainText('42');
    const before = await main.page.evaluate(key => JSON.parse(localStorage.getItem(key)).history, snapshotKey);
    // Expire the 30s metric cache before testing a deliberately delayed refresh.
    await main.page.clock.setFixedTime(new Date((now + 61) * 1000));
    main.state.holdObservation(); await main.page.getByRole('button', { name: '刷新指标', exact: true }).click();
    await expect.poll(() => main.state.held).toBeGreaterThan(0);
    const activeBefore = main.state.activeCalls;
    main.state.holdCheck(); await main.page.getByRole('button', { name: '清空数据', exact: true }).click();
    await expect.poll(() => main.state.activeHeld).toBe(true);
    await expect(main.page.getByRole('button', { name: '清空中…', exact: true })).toBeDisabled();
    await expect(main.page.getByRole('button', { name: '确认回放', exact: true })).toBeDisabled();
    main.state.releaseActive(); main.state.holdActive = false;
    await expectEmpty(main.page);
    await expect(main.page.locator('.replay-clear-notice')).toHaveText('已清空回放数据');
    assert.equal(main.state.activeCalls, activeBefore + 1);
    assert.deepEqual(await main.page.evaluate(key => JSON.parse(localStorage.getItem(key)).history, snapshotKey), before);
    main.state.release(); main.state.holdMetrics = false;
    await expect.poll(() => main.state.released).toBe(main.state.held);
    await expectEmpty(main.page);
    const observations = main.state.observations, statusCalls = main.state.statusCalls;
    await main.page.clock.runFor(65000); await expectEmpty(main.page);
    assert.equal(main.state.observations, observations, 'clear must stop task metric polling');
    assert.equal(main.state.statusCalls, statusCalls, 'clear must stop task status polling');
    await main.page.reload(); await auth(main.page); await expectEmpty(main.page);
    assert.equal(main.state.posts.length, 0);
    await expect(main.page.locator('.selection-form input').first()).not.toHaveValue('');
    await begin(main.page); await expect(main.page.locator('.replay-actions code')).toHaveText('new-task');
    assert.equal(main.state.posts.length, 1);

    for (const status of ['failed', 'cancelled']) {
      const ended = await fixture(); await enter(ended.page); await finish(ended, status);
      await ended.page.getByRole('button', { name: '清空数据', exact: true }).click(); await expectEmpty(ended.page);
    }

    const conflict = await fixture(); await enter(conflict.page); await finish(conflict);
    conflict.state.task = makeTask('running', 'other-tab-task');
    await conflict.page.getByRole('button', { name: '清空数据', exact: true }).click();
    await expect(conflict.page.locator('.replay-actions code')).toHaveText('other-tab-task');
    await expect(conflict.page.locator('.error-banner')).toContainText('检测到活动任务');
    await expect(conflict.page.getByRole('button', { name: '清空数据', exact: true })).toBeDisabled();

    const failures = await fixture(); await enter(failures.page); await finish(failures);
    for (const response of [{ activeCode: 503 }, { activeCode: 401 }, { activeCode: 200, activeBody: { active: false, task: makeTask() } }, { activeBody: { active: true, task: { replay_id: 'incomplete', status: 'running' } } }]) {
      Object.assign(failures.state, response);
      await failures.page.getByRole('button', { name: '清空数据', exact: true }).click();
      await expect(failures.page.locator('.error-banner')).toContainText('清空数据失败');
      await expect(failures.page.locator('.replay-actions code')).toHaveText('clear-task');
      assert.equal(await failures.page.evaluate(key => JSON.parse(localStorage.getItem(key)).replay.id, snapshotKey), 'clear-task');
    }
    failures.state.activeBody = undefined;
    await failures.page.evaluate(key => {
      const original = Storage.prototype.setItem;
      window.restoreTaskStorage = () => { Storage.prototype.setItem = original; };
      Storage.prototype.setItem = function (name, value) { if (name === key) throw new DOMException('Blocked', 'QuotaExceededError'); return original.call(this, name, value); };
    }, snapshotKey);
    await failures.page.getByRole('button', { name: '清空数据', exact: true }).click();
    await expect(failures.page.locator('.error-banner')).toContainText('无法清除本地任务记录');
    await expect(failures.page.locator('.replay-actions code')).toHaveText('clear-task');
    await failures.page.evaluate(() => window.restoreTaskStorage());
    await failures.page.reload();
    await expect(failures.page.getByRole('button', { name: '清空数据', exact: true })).toBeDisabled();
    failures.state.activeCode = 503; await auth(failures.page);
    await expect(failures.page.locator('.recovery-banner')).toContainText('恢复回放失败');
    await expect(failures.page.getByRole('button', { name: '清空数据', exact: true })).toBeDisabled();

    const pending = await fixture(); await enter(pending.page); await finish(pending); await select(pending.page);
    pending.state.createLost = true; await begin(pending.page);
    await expect(pending.page.getByRole('dialog')).toContainText('创建回放失败');
    await pending.page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
    await expect(pending.page.getByRole('button', { name: '清空数据', exact: true })).toBeDisabled();
    const pendingKey = await pending.page.evaluate(key => JSON.parse(sessionStorage.getItem(key + '.pending')).key, snapshotKey);
    await pending.page.reload(); await auth(pending.page);
    await expect(pending.page.getByRole('button', { name: '清空数据', exact: true })).toBeDisabled();
    assert.equal(await pending.page.evaluate(key => JSON.parse(sessionStorage.getItem(key + '.pending')).key, snapshotKey), pendingKey);

    console.log('PASS: terminal clear, active states blocked, active-task recheck and errors, storage failure, pending idempotency, late responses/polling, reload empty, history preserved, new task, English and 320px layout.');
  } finally { gates.forEach(release => release()); await Promise.all(contexts.map(context => context.close())); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
