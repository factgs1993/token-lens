'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DATA_DIR, ANSWERS_DIR, ensureDir, readJson, writeJson } = (() => {
  const lib = require('./lib.cjs');
  const answers = path.join(lib.DATA_DIR, 'answers');
  return { ...lib, ANSWERS_DIR: answers };
})();

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

function isRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function baseUrl() {
  return `http://${HOST}:${PORT}`;
}

function answerUrl(key) {
  return `${baseUrl()}/answers/${encodeURIComponent(key)}.html`;
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
            ? fs.readdirSync(ANSWERS_DIR).filter((name) => name.endsWith('.html')).sort().reverse().slice(0, 30)
            : [];
          const body = `<!doctype html><meta charset="utf-8"><title>Token Lens</title><body style="font:14px system-ui;background:#121317;color:#e8eaed;padding:24px"><h1>Token Lens</h1><ul>${files
            .map((name) => `<li><a style="color:#7dd3fc" href="/answers/${name}">${name}</a></li>`)
            .join('')}</ul></body>`;
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
  server.listen(PORT, HOST, () => {
    writeJson(META_PATH, { host: HOST, port: PORT, baseUrl: baseUrl(), pid: process.pid, at: new Date().toISOString() });
    fs.writeFileSync(PID_PATH, String(process.pid));
    process.stdout.write(JSON.stringify({ ok: true, baseUrl: baseUrl(), pid: process.pid }) + '\n');
  });
}

function ensureServer() {
  ensureDir();
  const meta = readJson(META_PATH, null);
  const pid = meta?.pid || (fs.existsSync(PID_PATH) ? Number(fs.readFileSync(PID_PATH, 'utf8')) : null);
  if (isRunning(pid)) {
    return { ok: true, baseUrl: meta?.baseUrl || baseUrl(), pid, already: true };
  }
  const child = spawn(process.execPath, [__filename, '--serve'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  const started = Date.now();
  while (Date.now() - started < 2500) {
    const next = readJson(META_PATH, null);
    if (next?.pid && isRunning(next.pid)) {
      return { ok: true, baseUrl: next.baseUrl || baseUrl(), pid: next.pid, already: false };
    }
    const waitUntil = Date.now() + 40;
    while (Date.now() < waitUntil) {
      /* spin */
    }
  }
  return { ok: true, baseUrl: baseUrl(), pid: child.pid, already: false, pending: true };
}

if (require.main === module) {
  if (process.argv.includes('--serve')) startForeground();
  else if (process.argv.includes('--ensure')) {
    process.stdout.write(JSON.stringify(ensureServer()));
  } else {
    process.stdout.write(JSON.stringify(ensureServer()));
  }
}

module.exports = { PORT, HOST, baseUrl, answerUrl, ensureServer, META_PATH };
