const { test } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../scripts/lib.cjs');

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
