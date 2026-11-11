const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { createStore } = require('../src/usage.cjs');
const { createReportServer } = require('../src/report.cjs');
const sessionId = '11111111-2222-3333-4444-555555555555';
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-export-'));
  const dir = path.join(home, 'sessions'); fs.mkdirSync(dir);
  const rows = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'event_msg', payload: { type: 'user_message', message: '</script><img src=x onerror=alert(1)> private prompt' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c', output: 'NEVER_EXPORT_TOOL_CONTENT' } },
    { type: 'token_usage_record', payload: { turn_id: 'first', response_id: 'r1', usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 50, reasoning_output_tokens: 10 } } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'first' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'second' } }
  ];
  fs.writeFileSync(path.join(dir, `rollout-test-${sessionId}.jsonl`), rows.map(JSON.stringify).join('\n') + '\n');
  return home;
}
test('browser report and exports stay bound, escape prompt markup and expose no source files', async t => {
  const home = fixture(), store = createStore(home);
  const server = createReportServer(store, path.join(__dirname, '../dist'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const query = `?sessionId=${sessionId}&turnId=first`;
  const html = await (await fetch(base + '/answer' + query)).text();
  assert.ok(html.includes('\\u003c/script>\\u003cimg'));
  assert.ok(!html.includes('NEVER_EXPORT_TOOL_CONTENT'));
  assert.ok(html.includes(`"baseUrl":"${base}"`));
  const response = await fetch(base + '/export.json' + query);
  assert.ok(response.headers.get('content-disposition').includes('attachment;'));
  const data = await response.json();
  assert.equal(data.turnId, 'first'); assert.equal(data.summary.totals.total_tokens, 120);
  assert.equal(data.summary.missingUsageTurns, 1); assert.equal(data.turns.length, 2);
  assert.ok(!JSON.stringify(data).includes('NEVER_EXPORT_TOOL_CONTENT'));
  const offline = await (await fetch(base + '/export.html' + query)).text();
  assert.ok(offline.includes('"baseUrl":null'));
  assert.equal((await fetch(base + '/api/report' + query, { headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
  const badHost = await new Promise((resolve, reject) => http.get(base + '/api/report' + query, { headers: { Host: 'untrusted.invalid' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject));
  assert.equal(badHost, 403);
  assert.equal((await fetch(base + '/auth.json')).status, 404);
  assert.equal((await fetch(base + '/api/report?sessionId=../auth&turnId=first')).status, 400);
  assert.equal((await fetch(base + '/api/report' + query.replace('first', 'unknown'))).status, 400);
  const missing = await (await fetch(base + '/api/report' + query.replace('first', 'second'))).json();
  assert.equal(missing.turns.find(turn => turn.id === 'second').hasUsage, false);
});
test('installed answer helper starts its independent browser runtime and keeps the latest turn ID', async t => {
  const home = fixture();
  const env = { ...process.env, CODEX_HOME: home, CODEX_THREAD_ID: sessionId };
  t.after(async () => {
    const file = path.join(home, 'token-lens/browser-server.json');
    if (!fs.existsSync(file)) return;
    const meta = JSON.parse(fs.readFileSync(file));
    try {
      const health = await (await fetch(`http://127.0.0.1:${meta.port}/health`)).json();
      if (health.secret === meta.secret) process.kill(meta.pid);
    } catch {}
  });
  const install = spawnSync(process.execPath, [path.join(__dirname, '../scripts/enable-default.cjs')], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(install.status, 0, install.stderr);
  const run = spawnSync(process.execPath, [path.join(home, 'tools/token-usage-link.cjs')], { env, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  const link = JSON.parse(run.stdout);
  assert.equal(link.turnId, 'second'); assert.ok(link.markdown.includes('[📊 Токены этого ответа](codex://'));
  assert.ok(link.markdown.includes(`[HTML](${link.htmlUrl})`));
  const data = await (await fetch(link.jsonUrl)).json();
  assert.equal(data.turnId, 'second');
});
