const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configPath, readConfig, ensureConfig } = require('../src/config.cjs');

test('first use creates MCP settings and existing browser preference is preserved', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-config-'));
  assert.deepEqual(readConfig(home), { reportView: 'mcp' });
  assert.deepEqual(ensureConfig(home), { reportView: 'mcp' });
  const file = configPath(home);
  fs.writeFileSync(file, '\uFEFF{ "reportView": "browser" }');
  const before = fs.readFileSync(file, 'utf8');
  assert.deepEqual(ensureConfig(home), { reportView: 'browser' });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('invalid configuration stops with a useful error and is not overwritten', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-config-invalid-'));
  ensureConfig(home);
  const file = configPath(home);
  for (const text of ['{', 'null', '[]', '{"reportView":null}', '{"reportView":"both"}', '{"report_view":"browser"}']) {
    fs.writeFileSync(file, text);
    assert.throws(() => ensureConfig(home), error => error.message.includes(file) && error.message.includes('Файл не изменён'));
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
});
