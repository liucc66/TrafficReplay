// Run against a preview build. Static files use localhost; APIs are fully mocked.
// The separate HTTP origin exercises the browser's actual insecure-context behavior.
const { chromium, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const base = process.env.CHECK_BASE_URL || 'http://127.0.0.1:4173';
const insecureOrigin = 'http://replay-http.test';
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const errors = [];
  const fixture = async (origin, { missingRandom = false, failFirst = false } = {}) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
    const page = await context.newPage();
    const state = { creates: [], task: null };
    page.on('pageerror', error => errors.push(error.message));
    if (missingRandom) await page.addInitScript(() => Object.defineProperty(crypto, 'getRandomValues', { configurable: true, value: undefined }));
    await page.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) return route.abort();
      const now = Math.floor(Date.now() / 1000);
      let body, status = 200;
      if (url.pathname === '/api/prometheus/query') {
        body = { status: 'success', data: { resultType: 'vector', result: [{ metric: { model_name: 'http-model' }, value: [now, '1'] }] } };
      } else if (url.pathname === '/api/prometheus/query_range') {
        const start = Number(url.searchParams.get('start')), end = Number(url.searchParams.get('end'));
        body = { status: 'success', data: { resultType: 'matrix', result: [{ metric: { model_name: 'http-model' }, values: [[start, '1'], [end, '2']] }] } };
      } else if (url.pathname === '/api/models') body = { target_models: ['http-target'] };
      else if (url.pathname === '/api/replays/active') body = { active: false, task: null };
      else if (url.pathname === '/api/replays' && req.method() === 'POST') {
        const input = req.postDataJSON(), key = req.headers()['idempotency-key'];
        state.creates.push({ body: input, key });
        if (failFirst && state.creates.length === 1) {
          status = 503; body = { error: 'Creation outcome unknown' };
        } else {
          status = 202;
          state.task = { ...input, replay_id: 'http-task', status: 'queued', request_count: 1 };
          body = state.task;
        }
      } else if (url.pathname === '/api/replays/http-task') body = state.task;
      else if (url.pathname.startsWith('/api/')) {
        throw new Error('Unexpected API route: ' + url.pathname);
      } else {
        return route.fulfill({ response: await route.fetch({ url: new URL(url.pathname + url.search, base).href }) });
      }
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(origin);
    {
      await expect(page.locator('#model')).toHaveValue('http-model');
      await page.getByRole('button', { name: '连接设置', exact: true }).click();
      const keyInput = page.locator('.settings-field input');
      if (await keyInput.count()) await keyInput.fill('Bearer http-test-only');
      await page.getByRole('button', { name: '应用设置', exact: true }).click();
    }
    const inputs = page.locator('.selection-form input');
    // Chromium normalizes zero seconds away when validating datetime-local fills.
    await inputs.first().fill((await inputs.first().getAttribute('min')).replace(/:00$/, ''));
    await inputs.last().fill((await inputs.last().getAttribute('max')).replace(/:00$/, ''));
    await page.getByRole('button', { name: '选择打流目标', exact: true }).click();
    await page.locator('.target-option').first().click();
    const confirm = page.getByRole('button', { name: '确认回放', exact: true });
    await expect(confirm).toBeEnabled(); await confirm.click();
    const start = page.getByRole('button', { name: '开始回放', exact: true });
    await expect(start).toBeEnabled();
    return { page, context, state, start };
  };
  try {
    const native = await fixture(new URL(base).origin);
    assert.equal(await native.page.evaluate(() => typeof crypto.randomUUID), 'function');
    await native.start.click();
    await expect(native.page.locator('.replay-actions code')).toHaveText('http-task');
    assert.equal(native.state.creates.length, 1);
    assert.match(native.state.creates[0].key, uuidV4);
    await native.context.close();

    const http = await fixture(insecureOrigin, { failFirst: true });
    assert.deepEqual(await http.page.evaluate(() => [isSecureContext, typeof crypto.randomUUID, typeof crypto.getRandomValues]), [false, 'undefined', 'function']);
    await http.start.click();
    await expect(http.page.getByRole('dialog')).toContainText('创建回放失败');
    assert.equal(http.state.creates.length, 1);
    const original = http.state.creates[0];
    assert.match(original.key, uuidV4);
    assert.deepEqual(Object.keys(original.body).sort(), ['end_time', 'source_model', 'speed', 'start_time', 'target_model']);
    assert.equal(original.body.source_model, 'http-model');assert.equal(original.body.target_model, 'http-target');
    assert(original.body.end_time > original.body.start_time);
    // Retrying must reuse the saved key, even when generating a new key is impossible.
    await http.page.evaluate(() => Object.defineProperty(crypto, 'getRandomValues', { configurable: true, value: undefined }));
    await http.start.click();
    await expect(http.page.locator('.replay-actions code')).toHaveText('http-task');
    assert.deepEqual(http.state.creates, [original, original]);
    await http.context.close();

    const missing = await fixture(insecureOrigin, { missingRandom: true });
    await missing.start.click();
    await expect(missing.page.getByRole('dialog')).toContainText('当前浏览器无法生成回放标识');
    assert.equal(missing.state.creates.length, 0);
    assert.equal(await missing.page.evaluate(() => Object.keys(sessionStorage).some(key => key.endsWith('.pending'))), false);
    await expect(missing.start).toBeEnabled();
    await missing.page.getByRole('button', { name: '取消', exact: true }).click();
    await missing.page.getByRole('button', { name: 'Switch to English', exact: true }).click();
    await expect(missing.page.getByRole('alert')).toContainText('This browser cannot generate a replay ID.');
    // A client-side initialization failure must not leave the next submission locked.
    await missing.page.evaluate(() => Reflect.deleteProperty(crypto, 'getRandomValues'));
    await missing.page.getByRole('button', { name: 'Confirm replay', exact: true }).click();
    await missing.page.getByRole('button', { name: 'Start replay', exact: true }).click();
    await expect(missing.page.locator('.replay-actions code')).toHaveText('http-task');
    assert.equal(missing.state.creates.length, 1);
    await missing.context.close();

    assert.deepEqual(errors, []);
    console.log('PASS: native UUID submission, HTTP fallback, original body/key on retry without crypto, visible localized initialization errors and recovery.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
