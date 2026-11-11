const { spawn } = require('node:child_process');
const os = require('node:os');

const source = 'Codex App Server: account/rateLimits/read';
const unavailable = 'Лимиты аккаунта временно недоступны.';
function normalizeLimits(raw, at = new Date().toISOString()) {
  if (!raw || typeof raw !== 'object') throw new Error(unavailable);
  const multiple = raw.rateLimitsByLimitId;
  const rows = multiple && typeof multiple === 'object' && Object.keys(multiple).length
    ? Object.entries(multiple) : raw.rateLimits ? [[raw.rateLimits.limitId || 'codex', raw.rateLimits]] : [];
  const window = value => {
    if (!value || !Number.isFinite(value.usedPercent) || value.usedPercent < 0) return null;
    return { usedPercent: value.usedPercent, remainingPercent: Math.max(0, 100 - value.usedPercent),
      windowMinutes: Number.isSafeInteger(value.windowDurationMins) && value.windowDurationMins > 0 ? value.windowDurationMins : null,
      resetsAt: Number.isSafeInteger(value.resetsAt) && value.resetsAt > 0 && value.resetsAt < 8640000000000 ? value.resetsAt : null };
  };
  const pools = rows.filter(([, row]) => row && typeof row === 'object').map(([id, row]) => ({
    id: String(id).slice(0, 120), name: typeof row.limitName === 'string' && row.limitName !== id ? row.limitName.slice(0, 160) :
      typeof row.normalModelSlug === 'string' ? row.normalModelSlug.slice(0, 160) : id === 'codex' ? 'Codex' : 'Дополнительный лимит',
    planType: typeof row.planType === 'string' ? row.planType.slice(0, 60) : null,
    reached: typeof row.rateLimitReachedType === 'string' ? row.rateLimitReachedType.slice(0, 120) : null,
    primary: window(row.primary), secondary: window(row.secondary)
  }));
  if (!pools.length) throw new Error('Сервис не передал данные лимитов аккаунта.');
  return { state: 'ready', source, fetchedAt: at, stale: false, error: null,
    ordinaryUsageAllowed: typeof raw.ordinaryUsageAllowed === 'boolean' ? raw.ordinaryUsageAllowed : null, pools };
}

function readRateLimits({ command = process.env.TOKEN_LENS_CODEX_BIN || 'codex', args = ['app-server', '--stdio'], timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: os.homedir(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.setEncoding('utf8');
    let buffer = '', done = false;
    const timer = setTimeout(() => finish(new Error('Не удалось получить лимиты Codex за 10 секунд.')), timeoutMs);
    function finish(error, result) {
      if (done) return; done = true; clearTimeout(timer); child.stdin.end(); child.kill();
      if (error) reject(error); else resolve(result);
    }
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    child.on('error', error => finish(new Error(error.code === 'ENOENT' ? 'Codex CLI не найден. Для просмотра лимитов нужен Codex в PATH.' : unavailable)));
    child.stdin.on('error', () => finish(new Error(unavailable)));
    child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => {
      if (done) return;
      buffer += chunk;
      if (buffer.length > 1024 * 1024) { finish(new Error(unavailable)); return; }
      let index;
      while (!done && (index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.method && message.id !== undefined) { send({ id: message.id, error: { code: -32601, message: 'Unsupported request' } }); continue; }
        if (![1, 2].includes(message.id)) continue;
        if (message.error) {
          const auth = /auth|login|sign.in|chatgpt|logged/i.test(String(message.error.message));
          finish(new Error(auth ? 'Лимиты подписки доступны при входе в Codex через ChatGPT.' : unavailable)); return;
        }
        if (message.id === 1) { send({ method: 'initialized' }); send({ id: 2, method: 'account/rateLimits/read' }); }
        else finish(null, message.result);
      }
    });
    child.on('exit', () => finish(new Error(unavailable)));
    child.once('spawn', () => send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'token_lens_limits', version: '0.4.0' },
      capabilities: { experimentalApi: true, explicitGatewayOauth: true }
    } }));
  });
}

function createLimitsReader({ read = readRateLimits, now = Date.now, ttlMs = 60000 } = {}) {
  let snapshot = { state: 'loading', source, fetchedAt: null, stale: false, error: null, ordinaryUsageAllowed: null, pools: [] };
  let attemptedAt = null, pending = null;
  return function getLimits() {
    if (!pending && (attemptedAt === null || now() - attemptedAt >= ttlMs)) {
      attemptedAt = now();
      pending = Promise.resolve().then(read).then(raw => { snapshot = normalizeLimits(raw, new Date(now()).toISOString()); })
        .catch(error => { snapshot = { ...snapshot, state: snapshot.pools.length ? 'ready' : 'unavailable', stale: !!snapshot.pools.length, error: error.message || unavailable }; })
        .finally(() => { pending = null; });
    }
    return { ...snapshot, refreshing: !!pending };
  };
}
module.exports = { normalizeLimits, readRateLimits, createLimitsReader, getAccountLimits: createLimitsReader() };
