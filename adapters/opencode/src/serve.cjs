'use strict';

// Локальный сервер отчётов. Портирован из adapters/cursor 0.2.1 (serve.cjs).
// Слушает только 127.0.0.1:3848 (не конфликтует с Cursor :3847); порт — TOKEN_LENS_PORT.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const lib = require('./lib.cjs');

const {
  DATA_DIR,
  ensureDir,
  readJson,
  writeJson,
  listAnswerReports,
  deleteAnswerReports,
  formatNum,
  readSettings,
  writeSettings,
  purgeOldAnswers,
  normalizeAutoDeleteDays,
  normalizeClickBehavior,
  safeAnswerKey,
  safeSessionId,
} = lib;
const ANSWERS_DIR = path.join(DATA_DIR, 'answers');

const PORT = Number(process.env.TOKEN_LENS_PORT) || 3848;
const HOST = '127.0.0.1';
const META_PATH = path.join(DATA_DIR, 'server.json');
const PID_PATH = path.join(DATA_DIR, 'server.pid');

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.md')) return 'text/markdown; charset=utf-8';
  return 'application/octet-stream';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderDeletedAnswerHtml(key) {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Отчёт удалён · Token Lens</title>
  <style>
    :root { color-scheme: light dark; --fg:#e8eaed; --muted:#9aa0a6; --card:#1e1f24; --line:#2d3038; --bg:#121317; --accent:#7dd3fc; }
    body { margin:0; font:14px/1.45 system-ui,sans-serif; color:var(--fg); background:var(--bg); }
    main { max-width:560px; margin:0 auto; padding:48px 16px; }
    h1 { font-size:22px; margin:6px 0 10px; }
    .muted { color:var(--muted); }
    .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; }
    a { color:var(--accent); }
    code { font:12px ui-monospace,Consolas,monospace; }
  </style>
</head>
<body>
  <main>
    <div class="card">
      <h1>Отчёт удалён</h1>
      <p class="muted">Этой страницы больше нет — отчёт удалили из списка или файла уже нет на диске.</p>
      <p class="muted">Ход: <code>${escapeHtml(key || '—')}</code></p>
      ${navHtml()}
    </div>
  </main>
</body>
</html>`;
}

function navHtml({ reportKey = null, backToReport = null } = {}) {
  const settingsHref = reportKey
    ? `/settings?from=${encodeURIComponent(reportKey)}`
    : '/settings';
  const parts = [`<a href="/">All Reports</a>`, `<a href="${settingsHref}">Settings</a>`];
  if (backToReport) {
    parts.push(`<a href="${escapeHtml(backToReport)}">Back to report</a>`);
  }
  return `<p class="nav">${parts.join(' · ')}</p>`;
}

const ANSWER_WATCH_SCRIPT = `<script id="token-lens-deleted-watch">
(function () {
  try {
    var key = decodeURIComponent(location.pathname.split('/').pop() || '').replace(/\\.html$/i, '');
    if (!key) return;
    var ch = new BroadcastChannel('token-lens-answers');
    ch.onmessage = function (ev) {
      var deleted = ev && ev.data && ev.data.deleted;
      if (Array.isArray(deleted) && deleted.indexOf(key) >= 0) location.reload();
    };
  } catch (e) {}
})();
</script>`;

function decorateAnswerHtml(html, reportKey = null) {
  let out = String(html || '');
  const nav = navHtml({ reportKey: safeAnswerKey(reportKey) });
  if (/<p class="nav">[\s\S]*?<\/p>/i.test(out)) {
    out = out.replace(/<p class="nav">[\s\S]*?<\/p>/i, nav);
  } else if (/<main[^>]*>/i.test(out)) {
    out = out.replace(/<main[^>]*>/i, (m) => `${m}\n${nav}`);
  }
  if (!out.includes('token-lens-deleted-watch')) {
    out = /<\/body>/i.test(out)
      ? out.replace(/<\/body>/i, `${ANSWER_WATCH_SCRIPT}</body>`)
      : `${out}${ANSWER_WATCH_SCRIPT}`;
  }
  return out;
}

function renderSettingsHtml(fromKey = null) {
  const key = safeAnswerKey(fromKey);
  const backToReport = key ? `/answers/${encodeURIComponent(key)}.html` : null;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Settings · Token Lens</title>
  <style>
    :root { color-scheme: light dark; --fg:#e8eaed; --muted:#9aa0a6; --card:#1e1f24; --line:#2d3038; --bg:#121317; --accent:#7dd3fc; }
    body { margin:0; font:14px/1.45 system-ui,sans-serif; color:var(--fg); background:var(--bg); }
    main { max-width:720px; margin:0 auto; padding:20px 16px 40px; }
    h1 { font-size:22px; margin:6px 0 8px; }
    .muted { color:var(--muted); }
    .nav { margin:0 0 14px; }
    .nav a { color:var(--accent); text-decoration:none; }
    .nav a:hover { text-decoration:underline; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; }
    .row { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin:10px 0; }
    label { display:inline-flex; gap:8px; align-items:center; }
    select, input[type="number"] { font:13px system-ui,sans-serif; color:var(--fg); background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:6px 8px; }
    input[type="number"] { width:5.5rem; }
    button.save { font:13px system-ui,sans-serif; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--fg); padding:8px 12px; cursor:pointer; }
    .hint { margin:0 0 8px; padding:10px 12px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--muted); font-size:13px; max-width:42rem; }
    #settingsStatus { color:var(--muted); font-size:12px; min-height:1.2em; }
  </style>
</head>
<body>
  <main>
    ${navHtml({ backToReport })}
    <h1>Settings</h1>
    <p class="muted">Auto-delete for stored reports. В отчёте показывается cost хода; лимитов подписки в OpenCode нет.</p>
    <section class="card" aria-label="Settings">
      <div class="row">
        <strong>Auto-delete</strong>
        <label>Mode
          <select id="autoMode">
            <option value="0">Off</option>
            <option value="1">older than 1 day</option>
            <option value="3">older than 3 days</option>
            <option value="7">older than 7 days</option>
            <option value="14">older than 14 days</option>
            <option value="30">older than 30 days</option>
            <option value="90">older than 90 days</option>
            <option value="custom">custom…</option>
          </select>
        </label>
        <label id="customWrap" hidden>N days
          <input type="number" id="autoDays" min="1" max="3650" value="7" />
        </label>
      </div>
      <div class="row">
        <strong>Открытие ссылки</strong>
        <label>Variant
          <select id="clickBehavior">
            <option value="panel">Встроенный браузер (панель)</option>
            <option value="dialog">Диалог в окне приложения</option>
            <option value="external">Системный браузер</option>
          </select>
        </label>
        <span class="hint" id="clickHint" hidden>Рекомендация: если клик по ссылке не открывает отчёт
        в окне приложения — полностью перезапусти OpenCode desktop (GUI-часть плагина загружается
        при старте приложения).</span>
      </div>
      <div class="row">
        <label><input type="checkbox" id="appendTokenSummary" /> Краткая сводка токенов после ссылки</label>
      </div>
      <p class="hint">Вход и выход текущего хода на момент формирования ссылки. Финальный текст ответа ещё не учтён;
        полный итог доступен в отчёте после завершения. Кэш и рассуждения показаны отдельно в отчёте.
        Без полных счётчиков строка пропускается. По умолчанию выключено; применяется со следующей ссылки.</p>
      <div class="row">
        <label><input type="checkbox" id="appendContextHeat" /> Индикатор контекста после ссылки</label>
      </div>
      <div class="row">
        <label>Размер окна, токенов <input type="number" id="contextWindow" min="1" max="9007199254740991" step="1" value="200000" /></label>
      </div>
      <p class="hint">Приблизительное заполнение окна: вход последнего измеренного запроса модели, включая кэш,
        делится на указанный размер окна. Это не сумма за весь ход. Без измерения строка пропускается.
        По умолчанию индикатор выключен, окно — 200 000 токенов. Укажи размер окна своей модели.</p>
      <div class="row">
        <button type="button" class="save" id="saveSettings">Save</button>
        <span id="settingsStatus"></span>
      </div>
    </section>
  </main>
  <script>
    (function () {
      var presets = [1, 3, 7, 14, 30, 90];
      var autoMode = document.getElementById('autoMode');
      var autoDays = document.getElementById('autoDays');
      var customWrap = document.getElementById('customWrap');
      var clickBehavior = document.getElementById('clickBehavior');
      var appendTokenSummary = document.getElementById('appendTokenSummary');
      var appendContextHeat = document.getElementById('appendContextHeat');
      var contextWindow = document.getElementById('contextWindow');
      var clickHint = document.getElementById('clickHint');
      var status = document.getElementById('settingsStatus');
      function syncCustom() { customWrap.hidden = autoMode.value !== 'custom'; }
      // Рекомендация о перезапуске актуальна только для внутренних вариантов открытия.
      function syncClickHint() { clickHint.hidden = clickBehavior.value === 'external'; }
      function applySettings(s) {
        var days = Number(s.autoDeleteDays || 0);
        if (days === 0 || presets.indexOf(days) >= 0) autoMode.value = String(days);
        else { autoMode.value = 'custom'; autoDays.value = String(days); }
        syncCustom();
        if (s.clickBehavior) clickBehavior.value = s.clickBehavior;
        appendTokenSummary.checked = s.appendTokenSummary === true;
        appendContextHeat.checked = s.appendContextHeat === true;
        contextWindow.value = String(s.contextWindow || 200000);
        syncClickHint();
      }
      autoMode.addEventListener('change', syncCustom);
      clickBehavior.addEventListener('change', syncClickHint);
      fetch('/api/settings').then(function (r) { return r.json(); }).then(function (d) { applySettings(d.settings || {}); }).catch(function () {});
      document.getElementById('saveSettings').addEventListener('click', function () {
        var days = autoMode.value === 'custom' ? Number(autoDays.value) : Number(autoMode.value);
        status.textContent = 'Saving…';
        fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ autoDeleteDays: days, clickBehavior: clickBehavior.value, appendTokenSummary: appendTokenSummary.checked,
            appendContextHeat: appendContextHeat.checked, contextWindow: Number(contextWindow.value) })
        }).then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
          .then(function (res) {
            if (!res.ok) throw new Error(res.data.error || 'save failed');
            applySettings(res.data.settings || {});
            var purged = (res.data.purge && res.data.purge.deleted) || [];
            if (purged.length) {
              try { new BroadcastChannel('token-lens-answers').postMessage({ deleted: purged }); } catch (e) {}
            }
            status.textContent = 'Saved' + (purged.length ? ' · auto-purged: ' + purged.length : '');
          })
          .catch(function (error) {
            status.textContent = String(error && error.message ? error.message : error);
          });
      });
    })();
  </script>
</body>
</html>`;
}

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function renderIndexHtml() {
  purgeOldAnswers();
  const rows = listAnswerReports(200);
  const body = rows.length
    ? rows
        .map((row) => {
          const preview = String(row.prompt_preview || '')
            .replace(/\s+/g, ' ')
            .slice(0, 80);
          return `<tr data-key="${escapeHtml(row.key)}">
  <td><input type="checkbox" class="pick" value="${escapeHtml(row.key)}" /></td>
  <td class="mono"><a href="/answers/${encodeURIComponent(row.key)}.html">${escapeHtml(row.at || '—')}</a></td>
  <td class="num">${escapeHtml(row.total_tokens == null ? '—' : formatNum(row.total_tokens))}</td>
  <td class="mono muted">${escapeHtml(String(row.session_id || '—').slice(0, 12))}</td>
  <td class="preview" title="${escapeHtml(row.prompt_preview || '')}">${escapeHtml(preview || '—')}</td>
</tr>`;
        })
        .join('\n')
    : `<tr><td colspan="5" class="muted">Пока нет отчётов.</td></tr>`;

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>All Reports · Token Lens</title>
  <style>
    :root { color-scheme: light dark; --fg:#e8eaed; --muted:#9aa0a6; --card:#1e1f24; --line:#2d3038; --bg:#121317; --accent:#7dd3fc; --danger:#f87171; }
    body { margin:0; font:14px/1.45 system-ui,sans-serif; color:var(--fg); background:var(--bg); }
    main { max-width:960px; margin:0 auto; padding:20px 16px 40px; }
    h1 { font-size:22px; margin:6px 0 8px; }
    .muted { color:var(--muted); }
    .mono { font:12px/1.4 ui-monospace,Consolas,monospace; }
    .nav { margin:0 0 14px; }
    .nav a { color:var(--accent); text-decoration:none; }
    .nav a:hover { text-decoration:underline; }
    .toolbar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin:16px 0; }
    button { font:13px system-ui,sans-serif; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--fg); padding:8px 12px; cursor:pointer; }
    button:hover { border-color:var(--muted); }
    button.danger { border-color:color-mix(in srgb,var(--danger) 50%, var(--line)); color:var(--danger); }
    button:disabled { opacity:.45; cursor:default; }
    table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
    th, td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
    th { font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); font-weight:600; }
    tr:last-child td { border-bottom:0; }
    tr:hover td { background:color-mix(in srgb,var(--accent) 6%, transparent); }
    a { color:var(--accent); text-decoration:none; }
    a:hover { text-decoration:underline; }
    .num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
    .preview { color:var(--muted); max-width:360px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #status { min-height:1.2em; }
  </style>
</head>
<body>
  <main>
    ${navHtml()}
    <h1>All Reports</h1>
    <p class="muted">Select one or more reports to delete. Open a report via the date link.</p>
    <div class="toolbar">
      <label><input type="checkbox" id="all" /> Все</label>
      <button type="button" id="del" class="danger" disabled>Удалить выбранные</button>
      <a href="/latest">/latest</a>
      <span id="status" class="muted"></span>
    </div>
    <table>
      <thead>
        <tr>
          <th></th>
          <th>Когда</th>
          <th class="num">Всего</th>
          <th>Сессия</th>
          <th>Запрос</th>
        </tr>
      </thead>
      <tbody id="rows">
${body}
      </tbody>
    </table>
  </main>
  <script>
    const all = document.getElementById('all');
    const del = document.getElementById('del');
    const status = document.getElementById('status');
    const picks = () => [...document.querySelectorAll('.pick')];
    function sync() {
      const list = picks();
      const checked = list.filter((el) => el.checked);
      del.disabled = !checked.length;
      all.checked = list.length > 0 && checked.length === list.length;
      all.indeterminate = checked.length > 0 && checked.length < list.length;
      status.textContent = checked.length ? 'Выбрано: ' + checked.length : '';
    }
    all.addEventListener('change', () => {
      picks().forEach((el) => { el.checked = all.checked; });
      sync();
    });
    document.getElementById('rows').addEventListener('change', (e) => {
      if (e.target.classList.contains('pick')) sync();
    });
    del.addEventListener('click', async () => {
      const keys = picks().filter((el) => el.checked).map((el) => el.value);
      if (!keys.length) return;
      if (!confirm('Удалить отчётов: ' + keys.length + '?')) return;
      del.disabled = true;
      status.textContent = 'Удаляю…';
      try {
        const res = await fetch('/api/answers/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keys }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'delete failed');
        for (const key of data.deleted || []) {
          const row = document.querySelector('tr[data-key="' + CSS.escape(key) + '"]');
          if (row) row.remove();
        }
        try {
          new BroadcastChannel('token-lens-answers').postMessage({ deleted: data.deleted || [] });
        } catch (_) {}
        status.textContent = 'Удалено: ' + (data.deleted || []).length;
        sync();
        if (!document.querySelector('.pick')) {
          document.getElementById('rows').innerHTML = '<tr><td colspan="5" class="muted">Пока нет отчётов.</td></tr>';
        }
      } catch (error) {
        status.textContent = String(error && error.message ? error.message : error);
        sync();
      }
    });
    sync();
  </script>
</body>
</html>`;
}

function baseUrl() {
  return `http://${HOST}:${PORT}`;
}

// Внутри рантайма OpenCode process.execPath может быть не node (например, bun/opencode).
// Сервер всегда запускаем отдельным Node-процессом; бинарник можно переопределить через TOKEN_LENS_NODE.
function nodeBinary() {
  const exec = process.execPath || '';
  const base = String(path.basename(exec)).toLowerCase();
  if (base.startsWith('node')) return exec;
  const override = process.env.TOKEN_LENS_NODE;
  if (override && fs.existsSync(override)) return override;
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const candidate = path.join(programFiles, 'nodejs', 'node.exe');
  if (fs.existsSync(candidate)) return candidate;
  // spawn сам разрезолвит 'node' по PATH.
  return 'node';
}

function answerUrl(key) {
  return `${baseUrl()}/answers/${encodeURIComponent(key)}.html`;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
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
      ? 'Сервер отвечает. Открывай ссылки http://127.0.0.1:3848/answers/…'
      : 'Сервер не отвечает. Запусти: node src/serve.cjs --start',
  };
}

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', baseUrl());
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (!rel || rel === '/') rel = 'index.html';
  if (rel.includes('..')) {
    res.writeHead(400).end('bad path');
    return;
  }

  if (rel === 'api/answers/delete' && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      const body = raw.trim() ? JSON.parse(raw) : {};
      const result = deleteAnswerReports(body.keys || []);
      res
        .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(JSON.stringify(result));
    } catch (error) {
      res
        .writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(JSON.stringify({ error: String(error && error.message ? error.message : error) }));
    }
    return;
  }

  if (rel === 'api/answers' && req.method === 'GET') {
    res
      .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(JSON.stringify({ answers: listAnswerReports(200), settings: readSettings() }));
    return;
  }

  if (rel === 'api/settings' && req.method === 'GET') {
    res
      .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(JSON.stringify({ settings: readSettings() }));
    return;
  }

  if (rel === 'api/settings' && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      const body = raw.trim() ? JSON.parse(raw) : {};
      const patch = {};
      if (body.autoDeleteDays !== undefined) patch.autoDeleteDays = normalizeAutoDeleteDays(body.autoDeleteDays);
      if (body.clickBehavior !== undefined) patch.clickBehavior = normalizeClickBehavior(body.clickBehavior);
      if (body.appendTokenSummary !== undefined) patch.appendTokenSummary = body.appendTokenSummary;
      if (body.appendContextHeat !== undefined) patch.appendContextHeat = body.appendContextHeat;
      if (body.contextWindow !== undefined) patch.contextWindow = body.contextWindow;
      writeSettings(patch);
      const purge = purgeOldAnswers({ force: true });
      res
        .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(JSON.stringify({ settings: readSettings(), purge }));
    } catch (error) {
      res
        .writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(JSON.stringify({ error: String(error && error.message ? error.message : error) }));
    }
    return;
  }

  // Alias: текущая live-страница хода, иначе последний завершённый отчёт.
  if (rel === 'latest' || rel === 'latest.html') {
    const active = readJson(path.join(DATA_DIR, 'active.json'), {});
    const latest = readJson(path.join(DATA_DIR, 'latest.json'), null);
    let liveId = active && active.prompt_message_id ? active.prompt_message_id : null;
    if (!liveId && active && active.session_id) {
      const sessionPending = readJson(
        path.join(DATA_DIR, 'sessions', String(active.session_id), 'pending.json'),
        null
      );
      liveId = sessionPending && sessionPending.prompt_message_id ? sessionPending.prompt_message_id : null;
    }
    const doneId = latest && latest.prompt_message_id ? latest.prompt_message_id : null;
    const sessionId = active.session_id || latest.session_id;
    if (!sessionId) {
      res.writeHead(404, { 'Cache-Control': 'no-store' }).end('no answers yet');
      return;
    }
    const key = lib.answerKey({ session_id: safeSessionId(sessionId) || sessionId, prompt_message_id: liveId || doneId });
    res
      .writeHead(302, {
        Location: `/answers/${encodeURIComponent(key)}.html`,
        'Cache-Control': 'no-store',
      })
      .end();
    return;
  }

  if (rel === 'index.html') {
    res
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(renderIndexHtml());
    return;
  }

  if (rel === 'settings' || rel === 'settings.html') {
    res
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(renderSettingsHtml(url.searchParams.get('from')));
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
    const missingAnswer = /^answers\/([a-zA-Z0-9_-]{1,200})\.html$/i.exec(rel);
    if (missingAnswer) {
      res
        .writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(renderDeletedAnswerHtml(missingAnswer[1]));
      return;
    }
    res.writeHead(404).end('not found');
    return;
  }
  const headers = { 'Content-Type': contentType(real) };
  if (real.endsWith('.html') || real.endsWith('.json')) headers['Cache-Control'] = 'no-store';
  let body = fs.readFileSync(real);
  if (rel.startsWith('answers/') && rel.endsWith('.html')) {
    const key = safeAnswerKey(path.basename(rel, '.html'));
    body = Buffer.from(decorateAnswerHtml(body.toString('utf8'), key), 'utf8');
  }
  res.writeHead(200, headers).end(body);
}

function startForeground() {
  ensureDir();
  fs.mkdirSync(ANSWERS_DIR, { recursive: true });
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      res.writeHead(500).end(String(error && error.message ? error.message : error));
    });
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
    try {
      purgeOldAnswers();
    } catch {
      /* non-fatal */
    }
    process.stdout.write(JSON.stringify({ ok: true, baseUrl: baseUrl(), pid: process.pid }) + '\n');
  });
}

async function ensureServer() {
  const current = await status();
  if (current.running) {
    return { ok: true, baseUrl: current.baseUrl, pid: current.pid, already: true };
  }
  // Протухший pid/meta от прошлой перезагрузки — чистим перед запуском.
  if (current.pid && !current.pidAlive) clearMeta();

  ensureDir();
  const child = spawn(nodeBinary(), [__filename, '--serve'], {
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
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    ok: false,
    baseUrl: baseUrl(),
    pid: child.pid,
    already: false,
    error: 'Сервер не поднялся за 3с. Проверь порт 3848 или запусти вручную: node src/serve.cjs --serve',
  };
}

function ensureServerSync() {
  const self = __filename;
  const node = nodeBinary();
  const statusRun = spawnSync(node, [self, '--status'], {
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
  const startRun = spawnSync(node, [self, '--start'], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  try {
    return JSON.parse((startRun.stdout || '').trim() || '{}');
  } catch {
    const reason =
      startRun.error?.code ||
      statusRun.error?.code ||
      (startRun.stderr || startRun.stdout || 'start failed').trim();
    return {
      ok: false,
      baseUrl: baseUrl(),
      error: reason === 'ENOENT' ? 'Node не найден для запуска сервера отчётов (см. TOKEN_LENS_NODE).' : String(reason),
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
  const result = await status();
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.running ? 0 : 1;
}

module.exports = {
  PORT,
  HOST,
  baseUrl,
  answerUrl,
  ensureServer,
  ensureServerSync,
  nodeBinary,
  status,
  stopServer,
  decorateAnswerHtml,
  META_PATH,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(String(error && error.message ? error.message : error) + '\n');
    process.exitCode = 1;
  });
}
