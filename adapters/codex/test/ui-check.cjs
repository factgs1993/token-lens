const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const usage = { input_tokens: 12000, cached_input_tokens: 8000, output_tokens: 900, reasoning_output_tokens: 200, total_tokens: 12900 };
const fixture = { sessionId: 'session-1', source: 'token_usage_record', malformedLines: 0, turn: { id: 'turn-1', label: '<img src=x onerror="alert(1)">', hasUsage: true, status: 'completed', usage, requests: [{ at: '2026-11-10T10:00:00Z', model: 'test-model', ...usage }], categories: { schemas: 1000, instructions: 2000, conversation: 3000, tool_results: 5000, tool_calls: 300 }, consumers: { exec: 4500, web: 500 } } };

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [width, theme] of [[375, 'dark'], [768, 'light'], [1440, 'dark']]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setContent('<style>body{margin:0}iframe{width:100%;height:980px;border:0}</style><iframe></iframe>');
      await page.evaluate(({ html, fixture, theme }) => {
        window.calls = [];
        window.addEventListener('message', event => {
          const message = event.data;
          if (!message?.method || message.id === undefined) return;
          let result = {};
          if (message.method === 'ui/initialize') result = { protocolVersion: '2026-01-26', hostInfo: { name: 'Codex', version: '26.1029.61003' }, hostCapabilities: { serverTools: {} }, hostContext: { theme, 'openai/deepLink': { url: '/answer?sessionId=session-1&turnId=turn-1' } } };
          if (message.method === 'tools/call') { window.calls.push(message.params); result = { content: [], structuredContent: fixture }; }
          event.source.postMessage({ jsonrpc: '2.0', id: message.id, result }, '*');
        });
        document.querySelector('iframe').srcdoc = html;
      }, { html: fs.readFileSync('dist/panel.html', 'utf8'), fixture, theme });
      const frame = page.frameLocator('iframe');
      await frame.locator('#total').filter({ hasText: '12 900' }).waitFor({ timeout: 10000 });
      assert.equal(await frame.locator('select').count(), 0);
      assert.equal(await frame.locator('#answer-title img').count(), 0);
      assert.equal(await frame.locator('html').evaluate(el => el.scrollWidth > el.clientWidth), false);
      assert.deepEqual((await page.evaluate(() => window.calls))[0].arguments, { sessionId: 'session-1', turnId: 'turn-1' });
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `test/panel-${width}-${theme}.png`, fullPage: true });
      await page.close();
    }
    console.log('PASS UI: MCP handshake, answer binding, no selectors, safe labels, no JS errors or horizontal overflow at 375/768/1440.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
