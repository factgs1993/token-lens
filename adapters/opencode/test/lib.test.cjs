const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Изолированный каталог данных на файл: DATA_DIR фиксируется при загрузке lib.cjs.
process.env.TOKEN_LENS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-lib-'));

const lib = require('../src/lib.cjs');

test('writeJson overwrites existing file on Windows (rename falls back to copy)', () => {
  const file = path.join(lib.DATA_DIR, 'probe.json');
  lib.writeJson(file, { n: 1 });
  lib.writeJson(file, { n: 2 });
  assert.equal(lib.readJson(file, null).n, 2);
});

test('writeJson creates nested directories', () => {
  const file = path.join(lib.DATA_DIR, 'a', 'b', 'probe.json');
  lib.writeJson(file, { ok: true });
  assert.equal(lib.readJson(file, null).ok, true);
});

test('safeSessionId and safeAnswerKey reject filesystem traversal', () => {
  assert.equal(lib.safeSessionId('ses_abc-123'), 'ses_abc-123');
  assert.equal(lib.safeSessionId('../usage'), null);
  assert.equal(lib.safeSessionId('a/b'), null);
  assert.equal(lib.safeSessionId(''), null);
  assert.equal(lib.safeSessionId(null), null);
  assert.equal(lib.safeAnswerKey('ses_1_msg-2'), 'ses_1_msg-2');
  assert.equal(lib.safeAnswerKey('..\\x'), null);
});

test('prompt preview normalizes whitespace and limits stored text', () => {
  assert.deepEqual(lib.promptPreview(null), { preview: null, length: 0 });
  assert.deepEqual(lib.promptPreview('  привет\n мир  '), { preview: 'привет мир', length: 10 });
  assert.deepEqual(lib.promptPreview('abcdef', 3), { preview: 'abc…', length: 6 });
  assert.equal(lib.promptPreview('a'.repeat(201)).preview.length, 201);
});

test('answer key is stable sessionID + promptMessageID', () => {
  const key = lib.answerKey({ session_id: 'ses1', prompt_message_id: 'msg9', at: '2026-01-01T00:00:00.000Z' });
  assert.equal(key, 'ses1_msg9');
  assert.equal(lib.answerKey({ session_id: 'ses1' }).startsWith('ses1-'), true);
  assert.equal(lib.answerKey(null).startsWith('turn-'), true);
});

test('saveTurn merges by prompt_message_id and index keeps one entry per session', () => {
  const sessionId = 'save-turn-ses';
  const first = lib.saveTurn({
    at: '2026-01-01T00:00:00.000Z',
    session_id: sessionId,
    prompt_message_id: 'm1',
    status: 'complete',
    measured: { input_tokens: 10, output_tokens: 5, reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 15 },
  });
  const second = lib.saveTurn({
    at: '2026-01-01T00:01:00.000Z',
    session_id: sessionId,
    prompt_message_id: 'm1',
    status: 'complete',
    measured: { input_tokens: 30, output_tokens: 7, reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 37 },
  });
  assert.equal(first.isNew, true);
  assert.equal(second.isNew, false);
  const chat = lib.loadChat(sessionId);
  assert.equal(chat.turns.length, 1);
  assert.equal(chat.turns[0].measured.total_tokens, 37);
  assert.equal(chat.totals.total_tokens, 37);
  const index = lib.listChats();
  assert.equal(index.filter((row) => row.session_id === sessionId).length, 1);
});

test('settings default to auto-delete off; no plan-limits option exists', () => {
  const settings = lib.readSettings();
  assert.equal(settings.autoDeleteDays, 0);
  assert.equal('appendPlanLimits' in settings, false, 'опции лимитов в OpenCode нет');
  assert.equal('limitsAvailable' in settings, false);
  lib.writeSettings({ autoDeleteDays: 3, appendPlanLimits: true, limitsAvailable: true });
  const next = lib.readSettings();
  assert.equal(next.autoDeleteDays, 3);
  assert.equal('appendPlanLimits' in next, false);
  assert.equal('limitsAvailable' in next, false);
  lib.writeSettings({ autoDeleteDays: 0 });
});

test('clickBehavior defaults to panel and accepts only known variants', () => {
  const defaults = lib.readSettings();
  assert.equal(defaults.clickBehavior, 'panel');

  lib.writeSettings({ clickBehavior: 'dialog' });
  assert.equal(lib.readSettings().clickBehavior, 'dialog');

  lib.writeSettings({ clickBehavior: 'external' });
  assert.equal(lib.readSettings().clickBehavior, 'external');

  // Неизвестное значение отбрасывается в пользу дефолта.
  lib.writeSettings({ clickBehavior: 'window' });
  assert.equal(lib.readSettings().clickBehavior, 'panel');
  lib.writeSettings({ clickBehavior: undefined });
  assert.equal(lib.readSettings().clickBehavior, 'panel');

  // writeSettings с незатронутым полем сохраняет текущее значение.
  lib.writeSettings({ clickBehavior: 'dialog' });
  lib.writeSettings({ autoDeleteDays: 0 });
  assert.equal(lib.readSettings().clickBehavior, 'dialog');
  lib.writeSettings({ clickBehavior: 'panel' });
});

test('token summary defaults off, persists, survives unrelated writes and validates its type', () => {
  assert.equal(lib.readSettings().appendTokenSummary, false);
  lib.writeSettings({ appendTokenSummary: true });
  lib.writeSettings({ autoDeleteDays: 0, clickBehavior: 'dialog' });
  lib.writeSettings({ lastAutoPurgeAt: null });
  assert.equal(lib.readSettings().appendTokenSummary, true);
  assert.equal(lib.readSettings().clickBehavior, 'dialog');
  for (const value of ['false', 1, null, {}]) {
    assert.throws(() => lib.writeSettings({ appendTokenSummary: value }), /boolean/);
    assert.equal(lib.readSettings().appendTokenSummary, true);
  }
  lib.writeSettings({ appendTokenSummary: false, clickBehavior: 'panel' });
  assert.equal(lib.readSettings().appendTokenSummary, false);
});

test('purgeOldAnswers deletes reports older than TTL', () => {
  lib.ensureDir();
  const now = Date.now();
  const old = { key: 'old-ses_old-msg', at: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(), session_id: 'old-ses', prompt_message_id: 'old-msg', measured: { total_tokens: 5 } };
  const fresh = { key: 'old-ses_new-msg', at: new Date(now - 1000).toISOString(), session_id: 'old-ses', prompt_message_id: 'new-msg', measured: { total_tokens: 7 } };
  lib.writeJson(path.join(lib.ANSWERS_DIR, `${old.key}.json`), old);
  fs.writeFileSync(path.join(lib.ANSWERS_DIR, `${old.key}.html`), '<html></html>');
  lib.writeJson(path.join(lib.ANSWERS_DIR, `${fresh.key}.json`), fresh);
  fs.writeFileSync(path.join(lib.ANSWERS_DIR, `${fresh.key}.html`), '<html></html>');

  lib.writeSettings({ autoDeleteDays: 3, lastAutoPurgeAt: null });
  const result = lib.purgeOldAnswers({ force: true });
  assert.equal(result.skipped, false);
  assert.deepEqual(result.deleted, ['old-ses_old-msg']);
  assert.equal(fs.existsSync(path.join(lib.ANSWERS_DIR, `${old.key}.json`)), false);
  assert.equal(fs.existsSync(path.join(lib.ANSWERS_DIR, `${old.key}.html`)), false);
  assert.equal(fs.existsSync(path.join(lib.ANSWERS_DIR, `${fresh.key}.json`)), true);
  // Не-force purge в течение часа троттлится.
  assert.equal(lib.purgeOldAnswers().skipped, true);
  lib.writeSettings({ autoDeleteDays: 0 });
});

test('deleteAnswerReports removes json+html, reports missing keys, cleans active/latest', () => {
  lib.ensureDir();
  const key = 'del-ses_del-msg';
  const report = { key, at: new Date().toISOString(), session_id: 'del-ses', prompt_message_id: 'del-msg', measured: { total_tokens: 11 } };
  lib.writeJson(path.join(lib.ANSWERS_DIR, `${key}.json`), report);
  fs.writeFileSync(path.join(lib.ANSWERS_DIR, `${key}.html`), '<html></html>');
  lib.writeJson(lib.LATEST_JSON, report);

  const result = lib.deleteAnswerReports([key, 'missing-key', '../bad']);
  assert.deepEqual(result.deleted, [key]);
  assert.deepEqual(result.missing, ['missing-key']);
  assert.equal(result.errors.filter((row) => row.key === '../bad').length, 1);
  assert.equal(fs.existsSync(path.join(lib.ANSWERS_DIR, `${key}.json`)), false);
  assert.equal(fs.existsSync(path.join(lib.ANSWERS_DIR, `${key}.html`)), false);
  // latest.json перекидывается на следующий доступный отчёт.
  const latest = lib.readJson(lib.LATEST_JSON, null);
  assert.equal(latest && latest.prompt_message_id, 'new-msg');
  // Удаление хода чистит чат.
  lib.saveTurn({ at: new Date().toISOString(), session_id: 'del-ses', prompt_message_id: 'del-msg', status: 'complete', measured: { total_tokens: 3 } });
  lib.writeJson(path.join(lib.ANSWERS_DIR, `${key}.json`), report);
  fs.writeFileSync(path.join(lib.ANSWERS_DIR, `${key}.html`), '<html></html>');
  lib.deleteAnswerReports([key]);
  assert.equal((lib.loadChat('del-ses').turns || []).length, 0);
});
