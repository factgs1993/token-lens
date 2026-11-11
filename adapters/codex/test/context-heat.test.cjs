const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatContextHeatLine } = require('../src/link.cjs');
const { parseTranscript } = require('../src/usage.cjs');

test('context heat uses the configured window and exact threshold boundaries', () => {
  for (const [input, expected] of [
    [0, '🧊 Контекст: 0% · ок'],
    [56000, '🧊 Контекст: 28% · ок'],
    [58000, '🧊 Контекст: 29% · ок'],
    [79999, '🧊 Контекст: 39% · ок'],
    [80000, '🌤️ Контекст: 40% · ещё нормально'],
    [110000, '🌤️ Контекст: 55% · ещё нормально'],
    [139999, '🌤️ Контекст: 69% · ещё нормально'],
    [140000, '🔥 Контекст: 70% · скоро новый чат'],
    [156000, '🔥 Контекст: 78% · скоро новый чат'],
    [169999, '🔥 Контекст: 84% · скоро новый чат'],
    [170000, '🌋 Контекст: 85% · лучше начать новый чат'],
    [184000, '🌋 Контекст: 92% · лучше начать новый чат'],
    [250000, '🌋 Контекст: 125% · лучше начать новый чат']
  ]) assert.equal(formatContextHeatLine(input), expected);
  assert.equal(formatContextHeatLine(78000, 100000), '🔥 Контекст: 78% · скоро новый чат');
});

test('missing and invalid measurements never produce a context line', () => {
  for (const input of [undefined, null, -1, NaN, Infinity, '56000', 1.5]) assert.equal(formatContextHeatLine(input), '');
  for (const window of [null, 0, -1, NaN, Infinity, '200000', 1.5]) assert.equal(formatContextHeatLine(56000, window), '');
});

test('last measured request survives compaction and differs from cumulative turn usage', () => {
  const rows = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'first' } },
    { type: 'token_usage_record', payload: { turn_id: 'first', response_id: 'r1', usage: { input_tokens: 190000, output_tokens: 20 } } },
    { type: 'compacted', payload: { message: 'summary' } },
    { type: 'token_usage_record', payload: { turn_id: 'first', response_id: 'r2', usage: { input_tokens: 56000, output_tokens: 20 } } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'second' } }
  ];
  const { turns } = parseTranscript(rows.map(JSON.stringify).join('\n'));
  assert.equal(turns[0].usage.input_tokens, 246000);
  assert.equal(turns[0].lastInputTokens, 56000);
  assert.equal(turns[1].lastInputTokens, null);
  assert.equal(formatContextHeatLine(turns[1].lastInputTokens), '');
});

test('legacy context uses last_token_usage even when the cumulative delta spans several requests', () => {
  const counts = (total, last) => ({ type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: total, output_tokens: 20 },
    last_token_usage: { input_tokens: last, output_tokens: 10 }
  } } });
  const report = parseTranscript([counts(100000, 100000), counts(400000, 56000)].map(JSON.stringify).join('\n'));
  assert.equal(report.turns[0].requests.at(-1).input_tokens, 300000);
  assert.equal(report.turns[0].lastInputTokens, 56000);
});
