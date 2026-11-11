'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const lib = require('./lib.cjs');

const { DATA_DIR, ensureDir, readJson, writeJson } = lib;
const ANSWERS_DIR = path.join(DATA_DIR, 'answers');

const PORT = Number(process.env.TOKEN_LENS_PORT) || 3847;
const HOST = '127.0.0.1';
const META_PATH = path.join(DATA_DIR, 'server.json');
const PID_PATH = path.join(DATA_DIR, 'server.pid');

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.md')) return 'text/markdown; charset=utf-8';
  return 'application/octet-stream';
}

function baseUrl() {
  return `http://${HOST}:${PORT}`;
}

function answerUrl(key) {
  return `${baseUrl()}/answers/${encodeURIComponent(key)}.html`;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function probeHttp(timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(`${baseUrl()}/`, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, statusCode: res.statusCode });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
    req.on('error', (error) => resolve({ ok: false, error: error.code || error.message }));
  });
}

function readMeta() {
  const meta = readJson(META_PATH, null) || {};
  const pidFromFile = fs.existsSync(PID_PATH) ? Number(fs.readFileSync(PID_PATH, 'utf8')) : null;
  return {
    host: meta.host || HOST,
    port: meta.port || PORT,
    baseUrl: meta.baseUrl || baseUrl(),
    pid: Number.isInteger(meta.pid) ? meta.pid : pidFromFile,
    at: meta.at || null,
  };
}

function clearMeta() {
  try {
    if (fs.existsSync(META_PATH)) fs.unlinkSync(META_PATH);
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync(PID_PATH)) fs.unlinkSync(PID_PATH);
  } catch {
    /* ignore */
  }
}

async function status() {
  const meta = readMeta();
  const httpStatus = await probeHttp();
  const pidAlive = isPidAlive(meta.pid);
  return {
    running: !!httpStatus.ok,
    http: httpStatus,
    pid: meta.pid || null,
    pidAlive,
    baseUrl: meta.baseUrl || baseUrl(),
    at: meta.at,
    hint: httpStatus.ok
      ? 'Сервер отвечает. Открывай ссылки http://127.0.0.1:3847/answers/…'
      : 'Сервер не отвечает. Запусти: node …/serve.cjs --start',
  };
}

function startForeground() {
  ensureDir();
  fs.mkdirSync(ANSWERS_DIR, { recursive: true });
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', baseUrl());
      let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (!rel || rel === '/') rel = 'index.html';
      if (rel.includes('..')) {
        res.writeHead(400).end('bad path');
        return;
      }
      const file = path.join(DATA_DIR, rel);
      const root = path.resolve(DATA_DIR);
      const real = path.resolve(file);
      if (!real.startsWith(root)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      if (!fs.existsSync(real) || fs.statSync(real).isDirectory()) {
        if (rel === 'index.html') {
          const files = fs.existsSync(ANSWERS_DIR)
            ? fs
                .readdirSync(ANSWERS_DIR)
                .filter((name) => name.endsWith('.html'))
                .sort()
                .reverse()
                .slice(0, 30)
            : [];
          const body = `<!doctype html><meta charset="utf-8"><title>Token Lens</title>
<body style="font:14px system-ui;background:#121317;color:#e8eaed;padding:24px">
<h1>Token Lens</h1>
<p class="muted">UI сервер · ${baseUrl()}</p>
<ul>${files
            .map((name) => `<li><a style="color:#7dd3fc" href="/answers/${name}">${name}</a></li>`)
            .join('')}</ul>
</body>`;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
          return;
        }
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType(real) }).end(fs.readFileSync(real));
    } catch (error) {
      res.writeHead(500).end(String(error && error.message ? error.message : error));
    }
  });
  server.on('error', (error) => {
    process.stderr.write(JSON.stringify({ ok: false, error: error.message }) + '\n');
    process.exitCode = 1;
  });
  server.listen(PORT, HOST, () => {
    writeJson(META_PATH, {
      host: HOST,
      port: PORT,
      baseUrl: baseUrl(),
      pid: process.pid,
      at: new Date().toISOString(),
    });
    fs.writeFileSync(PID_PATH, String(process.pid));
    process.stdout.write(JSON.stringify({ ok: true, baseUrl: baseUrl(), pid: process.pid }) + '\n');
  });
}

async function ensureServer() {
  const current = await status();
  if (current.running) {
    return { ok: true, baseUrl: current.baseUrl, pid: current.pid, already: true };
  }
  // Stale pid/meta from previous reboot — clear before spawn.
  if (current.pid && !current.pidAlive) clearMeta();

  ensureDir();
  const child = spawn(process.execPath, [__filename, '--serve'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  const started = Date.now();
  while (Date.now() - started < 3000) {
    const next = await status();
    if (next.running) {
      return { ok: true, baseUrl: next.baseUrl, pid: next.pid, already: false };
    }
    const waitUntil = Date.now() + 50;
    while (Date.now() < waitUntil) {
      /* spin */
    }
  }
  return {
    ok: false,
    baseUrl: baseUrl(),
    pid: child.pid,
    already: false,
    error: 'Сервер не поднялся за 3с. Проверь порт 3847 или запусти вручную: node serve.cjs --serve',
  };
}

function ensureServerSync() {
  const self = __filename;
  const statusRun = spawnSync(process.execPath, [self, '--status'], {
    encoding: 'utf8',
    timeout: 4000,
    windowsHide: true,
  });
  try {
    const current = JSON.parse((statusRun.stdout || '').trim() || '{}');
    if (current.running) return { ok: true, baseUrl: current.baseUrl || baseUrl(), pid: current.pid, already: true };
  } catch {
    /* continue to start */
  }
  const startRun = spawnSync(process.execPath, [self, '--start'], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  try {
    const started = JSON.parse((startRun.stdout || '').trim() || '{}');
    return started;
  } catch {
    return {
      ok: false,
      baseUrl: baseUrl(),
      error: (startRun.stderr || startRun.stdout || 'start failed').trim(),
    };
  }
}

function stopServer() {
  const meta = readMeta();
  const pid = meta.pid;
  let stopped = false;
  if (isPidAlive(pid)) {
    try {
      process.kill(pid);
      stopped = true;
    } catch (error) {
      return { ok: false, error: error.message, pid };
    }
  }
  clearMeta();
  return {
    ok: true,
    stopped,
    pid: pid || null,
    hint: stopped ? 'Сервер остановлен.' : 'Процесс уже не был запущен; meta очищена.',
  };
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.find((arg) => arg.startsWith('--')) || '--status';

  if (cmd === '--serve') {
    startForeground();
    return;
  }
  if (cmd === '--stop') {
    process.stdout.write(JSON.stringify(stopServer(), null, 2) + '\n');
    return;
  }
  if (cmd === '--start' || cmd === '--ensure' || cmd === '--restart') {
    if (cmd === '--restart') stopServer();
    const result = await ensureServer();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  // default: status
  process.stdout.write(JSON.stringify(await status(), null, 2) + '\n');
  process.exitCode = (await status()).running ? 0 : 1;
}

module.exports = {
  PORT,
  HOST,
  baseUrl,
  answerUrl,
  ensureServer,
  ensureServerSync,
  status,
  stopServer,
  META_PATH,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(String(error && error.message ? error.message : error) + '\n');
    process.exitCode = 1;
  });
}
