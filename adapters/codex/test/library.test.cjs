const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../src/usage.cjs');
const { createReportServer } = require('../src/report.cjs');
const { formatFooter } = require('../src/link.cjs');
const s1 = '11111111-2222-3333-4444-555555555555', s2 = '22222222-2222-3333-4444-555555555555';
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-library-'));
  fs.mkdirSync(path.join(home, 'sessions'));
  const files = [];
  for (const [sessionId, ids] of [[s1, ['old', 'recent', 'running']], [s2, ['other']]]) {
    const rows = [];
    for (const id of ids) {
      const timestamp = new Date(Date.now() - (['old', 'running'].includes(id) ? 40 : id === 'recent' ? 1 : 2) * 86400000).toISOString();
      const add = (type, payload) => rows.push({ type, timestamp, payload });
      add('event_msg', { type: 'task_started', turn_id: id });
      add('event_msg', { type: 'user_message', message: id + ' <img src=x onerror=alert(1)> ' + 'x'.repeat(300) });
      if (id !== 'running') {
        add('token_usage_record', { turn_id: id, response_id: sessionId + id, usage: { input_tokens: 100, output_tokens: 20 } });
        add('event_msg', { type: 'task_complete', turn_id: id });
      }
    }
    const file = path.join(home, 'sessions', `rollout-test-${sessionId}.jsonl`);
    fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n'); files.push(file);
  }
  return { home, store: createStore(home), files };
}
test('all reports cover different chats, are paginated and exclude source contents', () => {
  const { store } = fixture();
  const first = store.catalog({ limit: 2 });
  assert.equal(first.total, 4); assert.equal(first.hasMore, true);
  assert.deepEqual(first.reports.map(row => row.turnId), ['recent', 'other']);
  assert.equal(store.catalog({ offset: 2, limit: 2 }).hasMore, false);
  assert.ok(first.reports.every(row => row.label.length <= 90));
  assert.throws(() => store.catalog({ offset: -1 }));
});
test('deletion persists across readers, filters history and exports, and preserves original journals', () => {
  const { home, store, files } = fixture(), original = files.map(file => fs.readFileSync(file, 'utf8'));
  assert.throws(() => store.removeReports([{ sessionId: s1, turnId: 'recent' }, { sessionId: s2, turnId: '../bad' }]));
  assert.equal(store.catalog().total, 4);
  assert.equal(store.removeReports([{ sessionId: s1, turnId: 'recent' }]).deleted, 1);
  const next = createStore(home);
  assert.equal(next.catalog().total, 3);
  assert.throws(() => next.snapshot(s1, 'recent'), error => error.code === 'REPORT_DELETED');
  assert.throws(() => next.answer(s1, 'recent'), error => error.code === 'REPORT_DELETED');
  const snapshot = next.snapshot(s1, 'old');
  assert.deepEqual(snapshot.turns.map(turn => turn.id), ['old', 'running']);
  assert.equal(snapshot.summary.totals.total_tokens, 120);
  assert.deepEqual(files.map(file => fs.readFileSync(file, 'utf8')), original);
});
test('retention is off by default and removes only old finished reports without resurrecting them', () => {
  const { store, files } = fixture(), before = fs.readFileSync(files[0], 'utf8');
  assert.equal(store.catalog().total, 4);
  store.saveSettings({ autoDeleteDays: 30 });
  assert.deepEqual(store.catalog().reports.map(row => row.turnId).sort(), ['other', 'recent', 'running']);
  store.saveSettings({ autoDeleteDays: 0 });
  assert.equal(store.catalog().total, 3);
  assert.equal(fs.readFileSync(files[0], 'utf8'), before);
});
test('HTTP catalog, settings and deletion require the same origin and deleted deep links return 410', async t => {
  const { store } = fixture();
  const server = createReportServer(store, path.join(__dirname, '../dist'), () => ({ pools: [] }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (endpoint, body, origin = base) => fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  assert.equal((await fetch(base + '/reports')).status, 200);
  assert.equal((await (await fetch(base + '/api/reports')).json()).total, 4);
  assert.equal((await post('/api/settings', { autoDeleteDays: 1 }, 'https://evil.invalid')).status, 403);
  assert.equal((await post('/api/settings', { appendPlanLimits: true })).status, 200);
  assert.equal((await (await fetch(base + '/api/settings')).json()).appendPlanLimits, true);
  assert.equal((await post('/api/settings', { reportView: 'bad' })).status, 400);
  assert.equal((await post('/api/reports/delete', { reports: [{ sessionId: s1, turnId: 'recent' }] })).status, 200);
  assert.equal((await fetch(base + `/answer?sessionId=${s1}&turnId=recent`)).status, 410);
  assert.equal((await fetch(base + `/export.json?sessionId=${s1}&turnId=recent`)).status, 410);
});
test('footer labels account-wide percentages without invented remaining requests', () => {
  assert.equal(formatFooter(null), 'Лимиты Codex: временно недоступны.');
  const limits = { fetchedAt: new Date(2026, 10, 17, 13, 56).toISOString(), pools: [{ name: 'Codex', primary: { windowMinutes: 300, remainingPercent: 0 }, secondary: { windowMinutes: 10080, remainingPercent: 40 } }] };
  assert.equal(formatFooter(limits), 'Лимиты аккаунта Codex 17.11.2026 13:56:\n\n* Осталось 0% (5 ч)\n* Осталось 40% (7 д)\n* Общие для всех чатов.');
  assert.ok(formatFooter({ ...limits, fetchedAt: null }).startsWith('Лимиты аккаунта Codex:\n\n'));
});
