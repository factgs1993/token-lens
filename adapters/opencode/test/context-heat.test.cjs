const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TOKEN_LENS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-context-'));
const lib = require('../src/lib.cjs');
const { buildAnswerMarkdown, formatContextHeatLine } = require('../src/answer-page.cjs');

test('context indicator uses the same threshold boundaries as Codex', () => {
  for (const [input, expected] of [
    [0, '🧊 Контекст: 0% · ок'],
    [79999, '🧊 Контекст: 39% · ок'],
    [80000, '🌤️ Контекст: 40% · ещё нормально'],
    [139999, '🌤️ Контекст: 69% · ещё нормально'],
    [140000, '🔥 Контекст: 70% · скоро новый чат'],
    [142000, '🔥 Контекст: 71% · скоро новый чат'],
    [169999, '🔥 Контекст: 84% · скоро новый чат'],
    [170000, '🌋 Контекст: 85% · лучше начать новый чат'],
    [250000, '🌋 Контекст: 125% · лучше начать новый чат'],
  ]) assert.equal(formatContextHeatLine(input), expected);
  assert.equal(formatContextHeatLine(71000, 100000), '🔥 Контекст: 71% · скоро новый чат');
  for (const value of [undefined, null, -1, NaN, Infinity, '71000', 1.5]) assert.equal(formatContextHeatLine(value), '');
  for (const value of [null, 0, -1, NaN, Infinity, '200000', 1.5]) assert.equal(formatContextHeatLine(71000, value), '');
});

test('footer uses the last measured request including both caches, independently of token summary', () => {
  const url = 'http://127.0.0.1:3848/answers/context_turn.html';
  const link = buildAnswerMarkdown(url);
  const report = {
    measured: { input_tokens: 210000, output_tokens: 80 },
    requests: [
      { input_tokens: 180000, cache_read_tokens: 10000, cache_write_tokens: 0 },
      { input_tokens: 30000, cache_read_tokens: 100000, cache_write_tokens: 12000 },
      { input_tokens: null, cache_read_tokens: null, cache_write_tokens: null },
    ],
  };
  assert.equal(buildAnswerMarkdown(url, null, report), link);
  lib.writeSettings({ appendContextHeat: true });
  assert.equal(buildAnswerMarkdown(url, null, report), `${link}\n\n🔥 Контекст: 71% · скоро новый чат`);
  lib.writeSettings({ appendTokenSummary: true });
  assert.match(buildAnswerMarkdown(url, null, report), /\n\nТокены:[\s\S]*\n\n🔥 Контекст: 71%/);
  lib.writeSettings({ appendTokenSummary: false, contextWindow: 400000 });
  assert.match(buildAnswerMarkdown(url, null, report), /🧊 Контекст: 35% · ок$/);
  report.requests.push({ input_tokens: 10000, cache_read_tokens: 10000, cache_write_tokens: 0 });
  assert.match(buildAnswerMarkdown(url, null, report), /🧊 Контекст: 5% · ок$/);
  for (const missing of [null, {}, { requests: [] }, { measured: report.measured }, { ...report, measured: { incomplete: true } }]) {
    assert.equal(buildAnswerMarkdown(url, null, missing), link);
  }
  assert.equal(buildAnswerMarkdown(url, null, { requests: [{ input_tokens: -1, cache_read_tokens: 0, cache_write_tokens: 0 }] }), link);
  lib.writeSettings({ appendContextHeat: false });
  assert.equal(buildAnswerMarkdown(url, null, report), link);
});

test('context settings default off, persist across other writes and reject invalid values without changes', () => {
  lib.writeJson(lib.SETTINGS_PATH, { clickBehavior: 'dialog' });
  assert.equal(lib.readSettings().appendContextHeat, false);
  assert.equal(lib.readSettings().contextWindow, 200000);
  lib.writeSettings({ appendContextHeat: true, contextWindow: 100000 });
  lib.writeSettings({ appendTokenSummary: true, autoDeleteDays: 0, lastAutoPurgeAt: null });
  const before = lib.readSettings();
  assert.equal(before.appendContextHeat, true);
  assert.equal(before.contextWindow, 100000);
  assert.equal(before.clickBehavior, 'dialog');
  for (const patch of [
    { appendContextHeat: 'false' }, { appendContextHeat: null },
    ...[0, -1, 1.5, NaN, Infinity, null, '200000', Number.MAX_SAFE_INTEGER + 1].map(contextWindow => ({ contextWindow })),
  ]) {
    assert.throws(() => lib.writeSettings(patch));
    assert.deepEqual(lib.readSettings(), before);
  }
  lib.writeSettings({ appendContextHeat: false });
  assert.equal(lib.readSettings().appendContextHeat, false);
  assert.equal(lib.readSettings().contextWindow, 100000);
});
