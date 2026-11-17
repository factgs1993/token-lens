const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

process.env.TOKEN_LENS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-settings-'));

test('HTTP settings save and reload the toggle; invalid values preserve existing settings', async t => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, [path.join(__dirname, '../src/serve.cjs'), '--serve'], {
    env: { ...process.env, TOKEN_LENS_PORT: String(port) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) });
  const url = `http://127.0.0.1:${port}`;
  const read = async () => (await (await fetch(`${url}/api/settings`)).json()).settings;
  const save = patch => fetch(`${url}/api/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  });
  assert.equal((await read()).appendTokenSummary, false);
  assert.equal((await read()).appendContextHeat, false);
  assert.equal((await read()).contextWindow, 200000);
  const html = await (await fetch(`${url}/settings`)).text();
  assert.match(html, /id="appendTokenSummary"/);
  assert.match(html, /id="appendContextHeat"/);
  assert.match(html, /id="contextWindow"/);
  assert.equal((await save({ appendContextHeat: true, contextWindow: 100000 })).status, 200);
  assert.match(html, /appendTokenSummary: appendTokenSummary.checked/);
  assert.equal((await save({ appendTokenSummary: true, clickBehavior: 'dialog' })).status, 200);
  assert.equal((await read()).appendTokenSummary, true);
  assert.equal((await save({ autoDeleteDays: 0 })).status, 200);
  assert.equal((await read()).appendTokenSummary, true);
  assert.equal((await save({ appendTokenSummary: 'false' })).status, 400);
  assert.equal((await read()).appendTokenSummary, true);
  assert.equal((await save({ appendTokenSummary: false })).status, 200);
  const saved = await read();
  assert.equal(saved.appendTokenSummary, false);
  assert.equal(saved.clickBehavior, 'dialog');
  assert.equal(saved.appendContextHeat, true);
  assert.equal(saved.contextWindow, 100000);
  for (const patch of [{ appendContextHeat: 'false' }, { contextWindow: 0 }, { contextWindow: '200000' }]) {
    assert.equal((await save(patch)).status, 400);
    assert.deepEqual(await read(), saved);
  }
});

test('RPC settings exposes, saves and preserves the summary toggle', async () => {
  const { default: plugin } = await import('../src/index.js');
  const { TokenLens } = await import('../src/rpc.js');
  assert.equal(TokenLens.methods.settings.input.properties.appendTokenSummary.type, 'boolean');
  assert.equal(TokenLens.methods.settings.input.properties.appendContextHeat.type, 'boolean');
  assert.equal(TokenLens.methods.settings.input.properties.contextWindow.type, 'integer');
  let handlers;
  const cleanup = await plugin.setup({
    tool: { transform: async () => {}, hook: async () => {} },
    skill: { transform: async () => {} },
    session: { hook: async () => {} },
    rpc: { register: async (_contract, registered) => { handlers = registered; } },
    event: { subscribe: async function* () {} },
  });
  try {
    assert.equal((await handlers.settings({ appendContextHeat: true, contextWindow: 128000 })).settings.contextWindow, 128000);
    assert.equal((await handlers.settings({ appendTokenSummary: true })).settings.appendTokenSummary, true);
    assert.equal((await handlers.settings({ clickBehavior: 'external' })).settings.appendTokenSummary, true);
    assert.equal((await handlers.settings({})).settings.appendTokenSummary, true);
    await assert.rejects(handlers.settings({ appendTokenSummary: 'false' }), /boolean/);
    assert.equal((await handlers.settings({ appendTokenSummary: false })).settings.appendTokenSummary, false);
    assert.equal((await handlers.settings({})).settings.appendContextHeat, true);
    await assert.rejects(handlers.settings({ contextWindow: 0 }), /contextWindow/);
    assert.equal((await handlers.settings({ appendContextHeat: false })).settings.appendContextHeat, false);
  } finally {
    cleanup();
  }
});

test('default instruction preserves the full multiline footer and is idempotent', () => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-instructions-'));
  const file = path.join(config, 'AGENTS.md');
  fs.writeFileSync(file, 'Existing rule\n');
  const run = () => spawnSync(process.execPath, [path.join(__dirname, '../scripts/enable-default.cjs')], {
    env: { ...process.env, OPENCODE_CONFIG_DIR: config }, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(run().status, 0);
  const once = fs.readFileSync(file, 'utf8');
  assert.match(once, /^Existing rule/);
  assert.match(once, /Сохрани все строки/);
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), once);
});
