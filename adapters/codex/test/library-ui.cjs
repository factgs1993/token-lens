const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createStore } = require('../src/usage.cjs');
const { createReportServer } = require('../src/report.cjs');
const s1 = '11111111-2222-3333-4444-555555555555', s2 = '22222222-2222-3333-4444-555555555555';
(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-library-ui-'));
  fs.mkdirSync(path.join(home, 'sessions'));
  for (const [sessionId, turnId] of [[s1, 'first'], [s2, 'second']]) {
    const timestamp = new Date().toISOString();
    const rows = [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
      { type: 'event_msg', payload: { type: 'user_message', message: turnId + ' <img src=x onerror=alert(1)>' } },
      { type: 'token_usage_record', payload: { turn_id: turnId, response_id: turnId, usage: { input_tokens: 100, output_tokens: 20 } } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } }
    ];
    fs.writeFileSync(path.join(home, 'sessions', `rollout-test-${sessionId}.jsonl`), rows.map(row => JSON.stringify({ ...row, timestamp })).join('\n') + '\n');
  }
  const store = createStore(home), server = createReportServer(store, path.join(__dirname, '../dist'), () => ({ state: 'unavailable', pools: [] }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 950 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/reports');
    await page.locator('.report-entry').nth(1).waitFor();
    assert.equal(await page.locator('#report-list img').count(), 0);
    await page.locator('.report-open').filter({ hasText: 'second' }).click();
    await page.locator('#total').filter({ hasText: '120' }).waitFor();
    assert.match(await page.locator('#answer-title').textContent(), /second/);
    await page.locator('#page-settings').click();
    await page.locator('#settings-save:enabled').waitFor();
    await page.locator('#setting-view').selectOption('browser');
    await page.locator('#setting-limits').check();
    assert.equal(await page.locator('#setting-context-heat').isChecked(), false);
    assert.equal(await page.locator('#setting-context-window').inputValue(), '200000');
    await page.locator('#setting-context-heat').check();
    await page.locator('#setting-context-window').fill('100000');
    await page.locator('#setting-days').fill('30');
    await page.locator('#settings-save').click();
    await page.locator('#settings-status').filter({ hasText: 'сохранены' }).waitFor();
    assert.deepEqual(store.settings(), { reportView: 'browser', appendPlanLimits: true, appendContextHeat: true, contextWindow: 100000, autoDeleteDays: 30 });
    await page.locator('#page-reports').click(); await page.locator('#page-settings').click();
    await page.locator('#settings-save:enabled').waitFor();
    assert.equal(await page.locator('#setting-context-heat').isChecked(), true);
    assert.equal(await page.locator('#setting-context-window').inputValue(), '100000');
    assert.equal(await page.locator('html').evaluate(el => el.scrollWidth > el.clientWidth), false);
    await page.screenshot({ path: 'test/panel-context-settings-mobile.png', fullPage: true });
    await page.locator('#page-reports').click();
    await page.locator('.report-entry').nth(1).waitFor();
    await page.locator('.report-entry input').first().check();
    await page.locator('#delete-selected').click();
    await page.locator('#cancel-delete').click();
    assert.equal(store.catalog().total, 2);
    await page.locator('#delete-selected').click(); await page.locator('#confirm-delete').click();
    await page.waitForFunction(() => document.querySelectorAll('.report-entry').length === 1);
    assert.equal(store.catalog().total, 1);
    assert.equal(fs.readdirSync(path.join(home, 'sessions')).length, 2);
    assert.equal(await page.locator('html').evaluate(el => el.scrollWidth > el.clientWidth), false);
    await page.screenshot({ path: 'test/panel-library-mobile.png', fullPage: true });
    await page.close();
    const mcp = await browser.newPage({ viewport: { width: 768, height: 950 } });
    mcp.on('pageerror', error => errors.push(error.message));
    await mcp.setContent('<iframe style="width:100%;height:900px;border:0"></iframe>');
    await mcp.evaluate(({ html, catalog, settings }) => {
      window.calls = [];
      window.addEventListener('message', event => {
        const message = event.data; if (!message?.method || message.id === undefined) return;
        let result = {};
        if (message.method === 'ui/initialize') result = { protocolVersion: '2026-01-26', hostInfo: { name: 'Codex', version: 'test' }, hostCapabilities: { serverTools: {} }, hostContext: {} };
        if (message.method === 'tools/call') {
          window.calls.push(message.params);
          result = { content: [], structuredContent: message.params.name === 'list_token_reports' ? catalog : settings };
        }
        event.source.postMessage({ jsonrpc: '2.0', id: message.id, result }, '*');
      });
      document.querySelector('iframe').srcdoc = html;
    }, { html: fs.readFileSync('dist/panel.html', 'utf8'), catalog: store.catalog(), settings: store.settings() });
    const frame = mcp.frameLocator('iframe');
    await frame.locator('.report-entry').waitFor();
    await frame.locator('#page-settings').click(); await frame.locator('#settings-save:enabled').waitFor();
    assert.equal(await frame.locator('#setting-context-heat').isChecked(), true);
    assert.equal(await frame.locator('#setting-context-window').inputValue(), '100000');
    await frame.locator('#setting-context-heat').uncheck();
    await frame.locator('#setting-context-window').fill('200000');
    await frame.locator('#setting-days').fill('0'); await frame.locator('#settings-save').click();
    await frame.locator('#settings-status').filter({ hasText: 'сохранены' }).waitFor();
    assert.ok((await mcp.evaluate(() => window.calls)).some(call => call.name === 'save_token_settings' && call.arguments.autoDeleteDays === 0 && call.arguments.appendContextHeat === false && call.arguments.contextWindow === 200000));
    assert.deepEqual(errors, []);
    console.log('PASS library UI: cross-chat navigation, persistent settings, confirmed deletion, mobile layout and MCP app-only tools.');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
