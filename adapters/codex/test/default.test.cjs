const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('default installation preserves existing guidance and is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-default-'));
  const source = path.join(dir, 'plugin');
  const home = path.join(dir, 'codex');
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(source, 'dist'));
  fs.mkdirSync(home);
  fs.copyFileSync(path.join(__dirname, '../scripts/enable-default.cjs'), path.join(source, 'scripts/enable-default.cjs'));
  fs.writeFileSync(path.join(source, 'dist/link.cjs'), 'module.exports = {};');
  fs.writeFileSync(path.join(source, 'dist/report.cjs'), 'report runtime');
  fs.writeFileSync(path.join(source, 'dist/standalone.html'), 'standalone template');
  fs.copyFileSync(path.join(__dirname, '../src/config.cjs'), path.join(source, 'dist/config.cjs'));
  fs.writeFileSync(path.join(home, 'AGENTS.md'), '# Existing guidance\nKeep this.\n');
  for (let i = 0; i < 2; i++) {
    const result = spawnSync(process.execPath, [path.join(source, 'scripts/enable-default.cjs')], { env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    if (i === 0) {
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'token-lens/config.json'))), { reportView: 'mcp', appendPlanLimits: false, appendContextHeat: false, contextWindow: 200000, autoDeleteDays: 0 });
      fs.writeFileSync(path.join(home, 'token-lens/config.json'), JSON.stringify({ reportView: 'browser' }));
    }
  }
  const instructions = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8');
  assert(instructions.startsWith('# Existing guidance\nKeep this.\n'));
  assert.equal(instructions.split('codex-token-lens-default:start').length, 2);
  assert.equal(fs.readFileSync(path.join(home, 'tools/token-usage-link.cjs'), 'utf8'), "require('./token-lens/link.cjs').main();\n");
  assert.equal(fs.readFileSync(path.join(home, 'tools/token-lens/report.cjs'), 'utf8'), 'report runtime');
  assert.equal(fs.readFileSync(path.join(home, 'tools/token-lens/standalone.html'), 'utf8'), 'standalone template');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'token-lens/config.json'))), { reportView: 'browser' });
});
