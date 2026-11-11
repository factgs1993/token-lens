const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createStore } = require('./usage.cjs');
const { getAccountLimits } = require('./limits.cjs');
const VERSION = require('../package.json').version;
const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const metaPath = path.join(home, 'token-lens', `browser-server-${VERSION}.json`);

function renderHtml(report, baseUrl = null, assetDir = __dirname, page = 'report') {
  const data = JSON.stringify({ report, baseUrl, page }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return fs.readFileSync(path.join(assetDir, 'standalone.html'), 'utf8').replace('/* REPORT_DATA */', () => data);
}
function readMeta() { try { return JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { return null; } }
async function healthy(meta) {
  if (!meta || !Number.isInteger(meta.port) || meta.port < 1 || meta.port > 65535 || typeof meta.secret !== 'string') return false;
  try {
    const response = await fetch(`http://127.0.0.1:${meta.port}/health`, { signal: AbortSignal.timeout(500) });
    const body = await response.json();
    return body.name === 'codex-token-lens' && body.version === VERSION && body.secret === meta.secret;
  } catch { return false; }
}
function createReportServer(store = createStore(), assetDir = __dirname, readLimits = getAccountLimits) {
  const secret = crypto.randomBytes(24).toString('hex');
  const server = http.createServer(async (req, res) => {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (!['GET', 'POST'].includes(req.method) || req.headers.host !== new URL(baseUrl).host || (req.headers.origin && req.headers.origin !== baseUrl) || (req.method === 'POST' && (req.headers.origin !== baseUrl || !req.headers['content-type']?.startsWith('application/json')))) {
      res.writeHead(403).end('Forbidden'); return;
    }
    try {
      const url = new URL(req.url, baseUrl);
      if (url.pathname === '/health') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ name: 'codex-token-lens', version: VERSION, secret })); return;
      }
      const jsonResponse = value => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value)); };
      if (req.method === 'POST') {
        if (!['/api/settings', '/api/reports/delete'].includes(url.pathname)) { res.writeHead(404).end('Not found'); return; }
        let body = '';
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 65536) { res.writeHead(413).end('Request too large'); return; } }
        const input = JSON.parse(body);
        jsonResponse(url.pathname === '/api/settings' ? store.saveSettings(input) : store.removeReports(input.reports)); return;
      }
      if (['/', '/reports', '/settings'].includes(url.pathname)) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(renderHtml(null, baseUrl, assetDir, url.pathname === '/settings' ? 'settings' : 'reports')); return;
      }
      if (url.pathname === '/api/reports') { jsonResponse(store.catalog({ offset: Number(url.searchParams.get('offset') || 0), limit: 50 })); return; }
      if (url.pathname === '/api/settings') { jsonResponse(store.settings()); return; }
      if (!['/answer', '/api/report', '/export.json', '/export.html'].includes(url.pathname)) { res.writeHead(404).end('Not found'); return; }
      const report = { ...store.snapshot(url.searchParams.get('sessionId'), url.searchParams.get('turnId')), accountLimits: readLimits() };
      const json = ['/api/report', '/export.json'].includes(url.pathname);
      res.setHeader('Content-Type', json ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8');
      if (url.pathname.startsWith('/export.')) res.setHeader('Content-Disposition', `attachment; filename="token-lens-${report.sessionId}-${report.turnId}.${json ? 'json' : 'html'}"`);
      res.end(json ? JSON.stringify(report, null, 2) : renderHtml(report, url.pathname === '/answer' ? baseUrl : null, assetDir));
    } catch (error) {
      if (error.code === 'REPORT_DELETED' && req.url.startsWith('/answer?')) {
        res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Отчёт удалён</title><body><h1>Отчёт удалён</h1><p>Отчёт скрыт в Token Lens. Журнал чата Codex сохранён.</p><a href="/reports">Все отчёты</a></body></html>');
      } else res.writeHead(error.code === 'REPORT_DELETED' ? 410 : 400, { 'Content-Type': 'text/plain; charset=utf-8' }).end(error.message);
    }
  });
  server.reportSecret = secret;
  return server;
}
async function serve() {
  const previous = readMeta();
  if (await healthy(previous)) return;
  const server = createReportServer();
  const listen = port => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  const port = Number.isInteger(previous?.port) && previous.port > 0 && previous.port <= 65535 ? previous.port : 0;
  try { await listen(port); } catch (error) { if (error.code !== 'EADDRINUSE') throw error; await listen(0); }
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  const temp = `${metaPath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ port: server.address().port, secret: server.reportSecret, version: VERSION, pid: process.pid }));
  fs.renameSync(temp, metaPath);
}
let starting;
async function ensureReportServer() {
  if (starting) return starting;
  starting = (async () => {
    const meta = readMeta();
    if (await healthy(meta)) return `http://127.0.0.1:${meta.port}`;
    const child = spawn(process.execPath, [path.join(__dirname, 'report.cjs'), '--serve'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {}); child.unref();
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const next = readMeta();
      if (await healthy(next)) return `http://127.0.0.1:${next.port}`;
    }
    throw new Error('Не удалось запустить локальный HTML-отчёт. Повторите запуск помощника ссылок.');
  })();
  try { return await starting; } finally { starting = null; }
}
if (require.main === module) serve().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { createReportServer, ensureReportServer, renderHtml };
