const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TOKEN_LENS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-usage-'));

const usage = require('../src/usage.cjs');
const lib = require('../src/lib.cjs');

// Хелпер: assistant-сообщение OpenCode.
function assistant(id, tokens, extra = {}) {
  return {
    type: 'assistant',
    id,
    tokens: tokens || {},
    cost: extra.cost ?? null,
    model: extra.model || null,
    time: extra.time || { created: '2026-01-01T00:00:00.000Z', completed: '2026-01-01T00:00:05.000Z' },
    finish: extra.finish || 'stop',
    error: extra.error || null,
  };
}

function user(id, text, extra = {}) {
  return { type: 'user', id, text, time: extra.time || { created: '2026-01-01T00:00:00.000Z' } };
}

test('measuredFromTokenUsage: total = input + output + reasoning + cache.read + cache.write', () => {
  const m = usage.measuredFromTokenUsage({ input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 } });
  assert.equal(m.total_tokens, 165);
  assert.equal(m.incomplete, false);
  assert.equal(m.input_tokens, 100);
  assert.equal(m.reasoning_tokens, 5);
});

test('measuredFromTokenUsage: no counters -> null, not 0', () => {
  assert.equal(usage.measuredFromTokenUsage(null), null);
  assert.equal(usage.measuredFromTokenUsage({}), null);
  // Частичный случай: есть выход, входа нет — неполный, но не «недоступно».
  const partial = usage.measuredFromTokenUsage({ output: 5 });
  assert.equal(partial.incomplete, true);
  assert.equal(partial.output_tokens, 5);
  assert.equal(partial.total_tokens, 5);
  assert.equal(partial.input_tokens, 0);
});

test('turnFromMessages: sums per-step tokens with dedupe by messageID', () => {
  const messages = [
    user('u1', 'привет'),
    assistant('a1', { input: 10, output: 2 }, { cost: 0.01 }),
    assistant('a1', { input: 10, output: 2 }, { cost: 0.01 }), // дубликат
    assistant('a2', { input: 30, output: 4, reasoning: 3, cache: { read: 5 } }, { cost: 0.02 }),
  ];
  const report = usage.turnFromMessages(messages, { prompt_message_id: 'u1', consumers: {}, categories: { tool_results: 0, tool_calls: 0 }, tools: [] }, { outcome: 'succeeded' });
  assert.equal(report.prompt_message_id, 'u1');
  assert.equal(report.steps, 2);
  assert.equal(report.measured.input_tokens, 40);
  assert.equal(report.measured.output_tokens, 6);
  assert.equal(report.measured.reasoning_tokens, 3);
  assert.equal(report.measured.cache_read_tokens, 5);
  assert.equal(report.measured.total_tokens, 54);
  assert.equal(report.cost, 0.03);
  assert.equal(report.status, 'complete');
  assert.equal(report.requests.length, 2);
});

test('turnFromMessages: no tokens in steps -> measured null and missing_usage, not zeros', () => {
  const messages = [user('u1', 'q'), assistant('a1', {}, {})];
  const report = usage.turnFromMessages(messages, { prompt_message_id: 'u1', consumers: {}, categories: {}, tools: [] }, { outcome: 'succeeded' });
  assert.equal(report.measured, null);
  assert.equal(report.missing_usage, true);
  assert.equal(report.status, 'complete');
});

test('turnFromMessages: stops at next user message and skips non-assistant', () => {
  const messages = [
    user('u1', 'первый'),
    assistant('a1', { input: 10, output: 2 }),
    user('u2', 'второй'),
    assistant('a2', { input: 999, output: 999 }),
    { type: 'synthetic', id: 's1', text: 'не ход' },
  ];
  const report = usage.turnFromMessages(messages, { prompt_message_id: 'u1', consumers: {}, categories: {}, tools: [] }, { outcome: 'succeeded' });
  assert.equal(report.steps, 1);
  assert.equal(report.measured.input_tokens, 10);
});

test('turnFromMessages: interrupted/failed outcome maps to status', () => {
  const base = { consumers: {}, categories: {}, tools: [] };
  const messages = [user('u1', 'q'), assistant('a1', { input: 1, output: 1 })];
  assert.equal(usage.turnFromMessages(messages, { ...base, prompt_message_id: 'u1' }, { outcome: 'interrupted' }).status, 'interrupted');
  assert.equal(usage.turnFromMessages(messages, { ...base, prompt_message_id: 'u1' }, { outcome: 'failed' }).status, 'error');
});

test('addToolUsage estimates UTF-8 bytes / 3 per tool args and result', () => {
  const pending = { consumers: {}, categories: { tool_results: 0, tool_calls: 0 }, tools: [] };
  usage.addToolUsage(pending, { tool: 'read', input: { path: 'a.txt' }, result: 'abcde' });
  usage.addToolUsage(pending, { tool: 'read', input: '', result: 'ёжик' });
  // JSON {"path":"a.txt"} = 17 байт -> 6; 'abcde' = 5 байт -> 2; 'ёжик' = 8 байт -> 3
  assert.equal(pending.categories.tool_calls, 6);
  assert.equal(pending.categories.tool_results, 5);
  assert.deepEqual(lib.rank(pending.consumers, 10), [{ name: 'read', tokens: 5 }]);
  assert.equal(pending.tools.length, 2);
});

test('turnFromMessages falls back to last user message when no pending prompt id', () => {
  const messages = [
    user('u0', 'старый'),
    assistant('a0', { input: 1, output: 1 }),
    user('u1', 'новый'),
    assistant('a1', { input: 2, output: 2 }),
  ];
  const report = usage.turnFromMessages(messages, { consumers: {}, categories: {}, tools: [] }, { outcome: 'succeeded' });
  assert.equal(report.prompt_message_id, 'u1');
  assert.equal(report.measured.input_tokens, 2);
});

test('liveReportFromPending: page exists before measured', () => {
  const live = usage.liveReportFromPending({ session_id: 's1', prompt_message_id: 'm1', prompt_preview: 'запрос' });
  assert.equal(live.status, 'live');
  assert.equal(live.measured, null);
  assert.equal(live.prompt_message_id, 'm1');
});
