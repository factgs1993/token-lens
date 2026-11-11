const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configPath, readConfig, ensureConfig, writeConfig } = require('../src/config.cjs');

test('first use creates MCP settings and existing browser preference is preserved', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-config-'));
  assert.deepEqual(readConfig(home), { reportView: 'mcp', appendPlanLimits: false, appendContextHeat: false, contextWindow: 200000, autoDeleteDays: 0 });
  assert.deepEqual(ensureConfig(home), { reportView: 'mcp', appendPlanLimits: false, appendContextHeat: false, contextWindow: 200000, autoDeleteDays: 0 });
  const file = configPath(home);
  fs.writeFileSync(file, '\uFEFF{ "reportView": "browser" }');
  const before = fs.readFileSync(file, 'utf8');
  assert.deepEqual(ensureConfig(home), { reportView: 'browser', appendPlanLimits: false, appendContextHeat: false, contextWindow: 200000, autoDeleteDays: 0 });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('invalid configuration stops with a useful error and is not overwritten', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-config-invalid-'));
  ensureConfig(home);
  const file = configPath(home);
  for (const text of ['{', 'null', '[]', '{"reportView":null}', '{"reportView":"both"}', '{"report_view":"browser"}', '{"autoDeleteDays":-1}', '{"autoDeleteDays":null}', '{"appendPlanLimits":"true"}', '{"appendContextHeat":"true"}', '{"contextWindow":0}', '{"contextWindow":-1}', '{"contextWindow":1.5}', '{"contextWindow":"200000"}', '{"contextWindow":null}', '{"contextWindow":9007199254740992}', '{"toString":1}']) {
    fs.writeFileSync(file, text);
    assert.throws(() => ensureConfig(home), error => error.message.includes(file) && error.message.includes('Файл не изменён'));
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
});

test('settings patches preserve the view and reject invalid writes without changing the file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-settings-'));
  writeConfig({ reportView: 'browser' }, home);
  assert.deepEqual(writeConfig({ autoDeleteDays: 30, appendPlanLimits: true, appendContextHeat: true, contextWindow: 100000 }, home), { reportView: 'browser', autoDeleteDays: 30, appendPlanLimits: true, appendContextHeat: true, contextWindow: 100000 });
  assert.equal(writeConfig({ autoDeleteDays: 7 }, home).contextWindow, 100000);
  assert.equal(readConfig(home).appendContextHeat, true);
  const before = fs.readFileSync(configPath(home), 'utf8');
  for (const patch of [{ autoDeleteDays: 1.5 }, { autoDeleteDays: 3651 }, { appendPlanLimits: 1 }, { appendContextHeat: 1 }, { contextWindow: 0 }, { contextWindow: null }, { contextWindow: Infinity }, { contextWindow: 1.5 }, { contextWindow: Number.MAX_SAFE_INTEGER + 1 }, { unknown: 1 }]) assert.throws(() => writeConfig(patch, home));
  assert.equal(fs.readFileSync(configPath(home), 'utf8'), before);
});
