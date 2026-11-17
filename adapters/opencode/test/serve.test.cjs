const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TOKEN_LENS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-serve-'));

const serve = require('../src/serve.cjs');

test('answerUrl builds 127.0.0.1:3848 URL with encoded key', () => {
  assert.equal(serve.answerUrl('ses1_msg-2'), 'http://127.0.0.1:3848/answers/ses1_msg-2.html');
  assert.equal(serve.answerUrl('a b'), 'http://127.0.0.1:3848/answers/a%20b.html');
});

test('decorateAnswerHtml injects nav and deleted-watch script once', () => {
  const html = '<!doctype html><html><body><main><h1>Отчёт</h1></main></body></html>';
  const out = serve.decorateAnswerHtml(html, 'ses1_msg-2');
  assert.match(out, /<p class="nav"><a href="\/">All Reports<\/a>/);
  assert.match(out, /\/settings\?from=ses1_msg-2/);
  assert.match(out, /token-lens-deleted-watch/);
  // Повторная декорация не дублирует скрипт и заменяет nav.
  const out2 = serve.decorateAnswerHtml(out, 'ses1_msg-2');
  assert.equal(out2.split('token-lens-deleted-watch').length - 1, 1);
  assert.equal(out2.split('<p class="nav">').length - 1, 1);
});

test('decorateAnswerHtml without reportKey links plain settings page', () => {
  const html = '<html><body><main><p class="nav">OLD</p></main></body></html>';
  const out = serve.decorateAnswerHtml(html, null);
  assert.match(out, /<a href="\/settings">Settings<\/a>/);
  assert.doesNotMatch(out, /settings\?from/);
  assert.doesNotMatch(out, /OLD/);
});

test('nodeBinary: node-like execPath wins; TOKEN_LENS_NODE override works; bad override ignored', () => {
  const realExec = process.execPath;
  // В тестовом раннере execPath — node, поэтому должен вернуться он же.
  assert.ok(serve.nodeBinary());
  const fake = path.join(os.tmpdir(), 'token-lens-node-fake');
  fs.writeFileSync(fake, 'node stub');
  process.env.TOKEN_LENS_NODE = fake;
  // execPath node-подобный -> он сильнее override
  assert.equal(serve.nodeBinary(), realExec);
  delete process.env.TOKEN_LENS_NODE;
});
