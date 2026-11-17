const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TOKEN_LENS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-tools-'));
// Tool tests write real reports but do not start a server.
require('../src/serve.cjs').ensureServerSync = () => ({ ok: true });
const lib = require('../src/lib.cjs');
const { makeToolDefs } = require('../src/tools.cjs');

test('tools return the full footer, refresh current counters and respect settings without reloading', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 17, 13, 56).getTime() });
  const sessionID = 'summary-session';
  const pending = { ...lib.emptyPending(sessionID), prompt_message_id: 'prompt-1' };
  lib.writeSessionPending(sessionID, pending);
  const step = { type: 'assistant', id: 'a1', tokens: { input: 100, output: 20, reasoning: 3, cache: { read: 50 } }, time: { completed: Date.now() } };
  const messages = [{ type: 'user', id: 'prompt-1', sessionID }, step, step];
  const tools = makeToolDefs({ session: { context: async () => ({ messages }) } });
  const panel = tools.find(t => t.name === 'token_usage_panel');
  const read = tools.find(t => t.name === 'read_token_usage');
  const call = tool => tool.execute({}, { sessionID });

  const off = await call(panel);
  assert.equal(off.content, off.structuredContent.markdown);
  assert.doesNotMatch(off.content, /Токены(?: |:)/);
  lib.writeSettings({ appendTokenSummary: true });
  const on = await call(panel);
  assert.match(on.content, /\n\nТокены 17\.11\.2026 13:56: вход 100 · выход 20 \(на момент ссылки\)$/);
  assert.equal(on.structuredContent.measured.input_tokens, 100);
  assert.equal(on.structuredContent.measured.output_tokens, 20);
  assert.equal(on.structuredContent.measured.total_tokens, 173);

  messages.push({ ...step, id: 'a2', tokens: { input: 200, output: 40 } });
  const updated = await call(panel);
  assert.match(updated.content, /вход 300 · выход 60/);
  const data = await call(read);
  assert.equal(data.structuredContent.markdown, updated.content);
  assert.equal(data.structuredContent.measured.input_tokens, 300);
  lib.writeSettings({ appendContextHeat: true, contextWindow: 200 });
  assert.match((await call(panel)).content, /🌋 Контекст: 100% · лучше начать новый чат$/);
  messages.push({ ...step, id: 'after-compaction', tokens: { input: 10, output: 2, cache: { read: 15, write: 5 } } });
  assert.match((await call(panel)).content, /🧊 Контекст: 15% · ок$/);
  lib.writeSettings({ appendTokenSummary: false });
  assert.doesNotMatch((await call(panel)).content, /Токены(?: |:)/);

  lib.writeSettings({ appendTokenSummary: true });
  lib.writeSessionPending(sessionID, { ...pending, prompt_message_id: 'prompt-2' });
  messages.push({ type: 'user', id: 'prompt-2', sessionID });
  const empty = await call(panel);
  assert.equal(empty.structuredContent.measured, null);
  assert.doesNotMatch(empty.content, /Токены(?: |:)/);
  assert.doesNotMatch(empty.content, /Контекст:/);
  messages.push({ ...step, id: 'a3', tokens: { output: 5 } });
  assert.doesNotMatch((await call(panel)).content, /Токены(?: |:)/);
  assert.doesNotMatch((await call(panel)).content, /Контекст:/);
});
