const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeLimits, readRateLimits, createLimitsReader } = require('../src/limits.cjs');
const response = () => ({ accountId: 'never-export-account-id', ordinaryUsageAllowed: false,
  rateLimits: { limitId: 'codex', planType: 'plus', primary: { usedPercent: 88, windowDurationMins: 300, resetsAt: 1794397755 }, secondary: { usedPercent: 55, windowDurationMins: 10080 } } });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('limit windows retain percentages, resets and explicit service permission without exporting account identity', () => {
  const data = normalizeLimits(response());
  assert.equal(data.pools[0].primary.remainingPercent, 12);
  assert.equal(data.pools[0].secondary.remainingPercent, 45);
  assert.equal(data.pools[0].primary.resetsAt, 1794397755);
  assert.equal(data.ordinaryUsageAllowed, false);
  assert.ok(!JSON.stringify(data).includes('never-export-account-id'));
  const missing = normalizeLimits({ rateLimits: { primary: { usedPercent: null }, secondary: null } });
  assert.equal(missing.pools[0].primary, null);
  assert.equal(missing.ordinaryUsageAllowed, null);
  assert.throws(() => normalizeLimits({}));
});
test('multiple pools replace the legacy mirror and over-limit values never imply automatic recovery', () => {
  const data = normalizeLimits({ ...response(), rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 0 } }, other: { limitName: '<img src=x>', primary: { usedPercent: 110, resetsAt: 1 } }
  } });
  assert.equal(data.pools.length, 2);
  assert.equal(data.pools[0].primary.remainingPercent, 100);
  assert.equal(data.pools[1].primary.remainingPercent, 0);
  assert.equal(data.ordinaryUsageAllowed, false);
});
test('account reads are nonblocking, cached, deduplicated and retain visibly stale data on failure', async () => {
  let time = 0, calls = 0;
  const read = createLimitsReader({ now: () => time, ttlMs: 60, read: async () => { calls++; if (calls === 2) throw new Error('offline'); return response(); } });
  assert.equal(read().state, 'loading'); read();
  await tick(); assert.equal(read().pools[0].primary.usedPercent, 88); assert.equal(calls, 1);
  time = 61; read(); read(); await tick();
  assert.equal(calls, 2); assert.equal(read().stale, true); assert.equal(read().pools[0].primary.usedPercent, 88);
  assert.equal(read().error, 'offline');
  time = 122; read(); await tick(); assert.equal(read().stale, false); assert.equal(calls, 3);
  const fail = createLimitsReader({ read: async () => { throw new Error('unavailable'); } });
  fail(); await tick(); assert.equal(fail().state, 'unavailable'); assert.deepEqual(fail().pools, []);
});
test('RPC only initializes and reads account limits; auth errors and missing CLI expose no credential text', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-rpc-'));
  const script = path.join(dir, 'fake-cli.cjs'), trace = path.join(dir, 'trace.json');
  fs.writeFileSync(script, `const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});const methods=[];rl.on('line',line=>{const m=JSON.parse(line);methods.push(m.method);if(m.method==='initialize'){process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');}if(m.method==='account/rateLimits/read'){fs.writeFileSync(${JSON.stringify(trace)},JSON.stringify(methods));process.stdout.write(JSON.stringify({id:m.id,...(process.argv[2]==='error'?{error:{code:-32000,message:'auth failed secret-token'}}:{result:${JSON.stringify(response())}})})+'\\n');}});`);
  const raw = await readRateLimits({ command: process.execPath, args: [script] });
  assert.equal(raw.rateLimits.primary.usedPercent, 88);
  assert.deepEqual(JSON.parse(fs.readFileSync(trace)), ['initialize', 'initialized', 'account/rateLimits/read']);
  await assert.rejects(readRateLimits({ command: process.execPath, args: [script, 'error'] }), error => !error.message.includes('secret-token') && error.message.includes('ChatGPT'));
  await assert.rejects(readRateLimits({ command: path.join(dir, 'missing-cli') }), /Codex CLI не найден/);
});
