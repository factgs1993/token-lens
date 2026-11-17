const { test } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../scripts/lib.cjs');

test('plan footer dates the saved snapshot and preserves it for cached or stale data', () => {
  const { formatPlanUsageLine } = require('../scripts/plan-usage.cjs');
  const usage = { at: new Date(2026, 10, 17, 13, 56).toISOString(), membership: 'pro', plan: { auto_percent_used: 12.4, api_percent_used: 3.1 } };
  const expected = 'Лимиты 17.11.2026 13:56: pro · Auto 12% · API 3%';
  assert.equal(formatPlanUsageLine(usage), expected);
  assert.equal(formatPlanUsageLine({ ...usage, cached: true }), expected);
  assert.equal(formatPlanUsageLine({ ...usage, cached: true, stale: true }), expected);
  for (const at of [undefined, null, '', 'invalid']) {
    assert.equal(formatPlanUsageLine({ ...usage, at }), 'Лимиты: pro · Auto 12% · API 3%');
  }
  assert.equal(formatPlanUsageLine(null), 'Лимиты: нет данных');
});

test('missing measured usage stays unavailable and cache is not added twice', () => {
  assert.equal(lib.measuredFromPayload({}), null);
  const measured = lib.measuredFromPayload({ input_tokens: 100, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 10 });
  assert.equal(measured.total_tokens, 120);
  assert.equal(measured.uncached_input_tokens, 60);
  assert.equal(lib.measuredFromPayload({ input_tokens: -1 }), null);
});

test('chat IDs reject filesystem traversal', () => {
  assert.equal(lib.safeChatId('session-123_abc'), 'session-123_abc');
  assert.equal(lib.safeChatId('../usage'), null);
  assert.equal(lib.safeChatId('a/b'), null);
  assert.equal(lib.safeChatId(''), null);
});

test('consumer ranking and UTF-8 estimates preserve order and bytes', () => {
  assert.equal(lib.estimate('abc'), 1);
  assert.equal(lib.estimate('ёж'), 2);
  assert.deepEqual(lib.rank({ shell: 20, read: 50 }, 1), [{ name: 'read', tokens: 50 }]);
});

test('prompt preview normalizes whitespace and limits stored text', () => {
  assert.deepEqual(lib.promptPreview(null), { preview: null, length: 0 });
  assert.deepEqual(lib.promptPreview('  привет\n мир  '), { preview: 'привет мир', length: 10 });
  assert.deepEqual(lib.promptPreview('abcdef', 3), { preview: 'abc…', length: 6 });
  assert.equal(lib.promptPreview('a'.repeat(201)).preview.length, 201);
});

test('reasoning stays null unless stop payload provides it', () => {
  const plain = lib.measuredFromPayload({ input_tokens: 10, output_tokens: 2 });
  assert.equal(plain.reasoning_tokens, null);
  const withReasoning = lib.measuredFromPayload({
    input_tokens: 10,
    output_tokens: 2,
    reasoning_tokens: 7,
  });
  assert.equal(withReasoning.reasoning_tokens, 7);
  const alias = lib.measuredFromPayload({
    input_tokens: 10,
    output_tokens: 2,
    reasoning_output_tokens: 4,
  });
  assert.equal(alias.reasoning_tokens, 4);
});

test('mergeTurnReports keeps five category keys and request history', () => {
  const merged = lib.mergeTurnReports(
    {
      categories: { instructions: 100, conversation: 20, schemas: 5, tool_calls: 9, tool_results: 2 },
      requests: [{ kind: 'assistant' }],
      reasoning_estimate: 11,
      consumers: [{ name: 'Shell', tokens: 2 }],
    },
    {
      categories: { instructions: 0, conversation: 40, schemas: 0, tool_calls: 0, tool_results: 0 },
      requests: [],
      reasoning_estimate: 3,
      consumers: [],
      measured: { input_tokens: 1, output_tokens: 1, total_tokens: 2, reasoning_tokens: null },
    }
  );
  assert.equal(merged.categories.instructions, 100);
  assert.equal(merged.categories.conversation, 40);
  assert.equal(merged.categories.tool_calls, 9);
  assert.equal(merged.requests.length, 1);
  assert.equal(merged.reasoning_estimate, 11);
  assert.equal(merged.consumers[0].name, 'Shell');
});

test('usage deltas and visible model requests hide empty tool_batch rows', () => {
  const first = lib.usageDelta(
    { input_tokens: 100, output_tokens: 10, cache_read_tokens: 40, cache_write_tokens: 0, reasoning_tokens: null },
    null
  );
  assert.equal(first.input_tokens, 100);
  assert.equal(first.output_tokens, 10);
  assert.equal(first.cache_read_tokens, 40);
  const second = lib.usageDelta(
    { input_tokens: 250, output_tokens: 30, cache_read_tokens: 180, cache_write_tokens: 0, reasoning_tokens: 4 },
    first
  );
  assert.equal(second.input_tokens, 150);
  assert.equal(second.output_tokens, 20);
  assert.equal(second.cache_read_tokens, 140);
  assert.equal(second.reasoning_tokens, 4);
  assert.equal(lib.summarizeTools(['Read', 'Read', 'Write']), 'Read×2, Write');
  const visible = lib.visibleModelRequests([
    { kind: 'tool_batch' },
    { kind: 'assistant', input_tokens: 10, output_tokens: 2 },
    { kind: 'tool_batch', input_tokens: 1 },
    { kind: 'stop_total', input_tokens: 10, output_tokens: 2 },
  ]);
  assert.equal(visible.length, 3);
  assert.equal(visible[0].kind, 'assistant');
  assert.equal(visible[1].kind, 'tool_batch');
});
