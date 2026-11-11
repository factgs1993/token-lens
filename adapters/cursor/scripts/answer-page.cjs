'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  DATA_DIR,
  ensureDir,
  formatNum,
  writeJson,
  readSettings,
  loadChat,
  buildChatSummary,
  buildExportSnapshot,
  emptyCategories,
  visibleModelRequests,
} = require('./lib.cjs');
const { ensureServerSync, answerUrl } = require('./serve.cjs');
const { fetchPlanUsageSync, renderPlanBars, formatPlanUsageLine } = require('./plan-usage.cjs');

function resolveContextInputTokens(report) {
  const current = report && report.measured && report.measured.input_tokens;
  if (current != null && Number.isFinite(Number(current))) return Number(current);
  // Chat tail is written before stop; fall back to last completed turn in this chat.
  const chatId = report && report.conversation_id;
  if (!chatId) return null;
  const chat = loadChat(chatId);
  const turns = chat && Array.isArray(chat.turns) ? chat.turns : [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (!turn || turn.status === 'in_progress') continue;
    if (report && report.generation_id && turn.generation_id === report.generation_id) continue;
    const input = turn.measured && turn.measured.input_tokens;
    if (input != null && Number.isFinite(Number(input))) return Number(input);
  }
  return null;
}

function formatContextHeatLine(report, settings) {
  const input = resolveContextInputTokens(report);
  if (input == null) return 'Контекст: нет данных, появятся со следующим ответом';
  const window =
    settings && settings.contextWindowTokens
      ? Number(settings.contextWindowTokens)
      : 200000;
  const pct = Math.min(100, Math.max(0, Math.round((Number(input) / window) * 100)));
  if (pct >= 85) return `🌋 Контекст: ${pct}% · лучше начать новый чат`;
  if (pct >= 70) return `🔥 Контекст: ${pct}% · скоро новый чат`;
  if (pct >= 40) return `🌤️ Контекст: ${pct}% · ещё нормально`;
  return `🧊 Контекст: ${pct}% · ок`;
}

function buildAnswerMarkdown(url, report) {
  const settings = readSettings();
  const blocks = [`[📊 Аналитика запроса/ответа](${url})`];
  if (settings.appendPlanLimits) {
    blocks.push(formatPlanUsageLine(report && report.plan_usage));
  }
  if (settings.appendContextHeat) {
    blocks.push(formatContextHeatLine(report, settings));
  }
  return blocks.join('\n\n');
}

const ANSWERS_DIR = path.join(DATA_DIR, 'answers');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function answerKey(report) {
  const raw = report.generation_id || `${report.conversation_id || 'chat'}-${Date.parse(report.at) || Date.now()}`;
  return String(raw).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || `turn-${Date.now()}`;
}

const CATEGORY_ROWS = [
  ['schemas', 'Схемы инструментов', '#ab9af5'],
  ['tool_results', 'Результаты инструментов', '#68bdea'],
  ['instructions', 'Инструкции и правила', '#e2bd68'],
  ['conversation', 'История, запрос и контекст', '#79c9aa'],
  ['tool_calls', 'Аргументы вызовов инструментов', '#e4a17d'],
];

function renderCategoryBars(cats) {
  const values = CATEGORY_ROWS.map(([key, label, color]) => ({
    key,
    label,
    color,
    value: Number(cats[key]) || 0,
  }));
  const total = values.reduce((sum, row) => sum + row.value, 0) || 1;
  const bars = values
    .filter((row) => row.value > 0)
    .map(
      (row) =>
        `<div class="row"><i style="background:${row.color}"></i><span>${escapeHtml(row.label)}</span><strong>≈ ${escapeHtml(formatNum(row.value))}</strong><div class="track"><span style="width:${Math.min(100, (row.value / total) * 100)}%;background:${row.color}"></span></div></div>`
    )
    .join('');
  const stack = values
    .filter((row) => row.value > 0)
    .map((row) => `<span style="flex-grow:${row.value};background:${row.color}"></span>`)
    .join('');
  return {
    bars: bars || '<p class="muted">Нет категорий.</p>',
    stack: stack ? `<div class="stack" aria-hidden="true">${stack}</div>` : '',
  };
}

function requestsForDisplay(report) {
  const rows = visibleModelRequests(report && report.requests).map((step) => ({ ...step }));
  const m = report && report.measured;
  if (!m) return rows;
  const hasMeasuredAssistant = rows.some(
    (row) => row.kind === 'assistant' && !row.estimated && row.input_tokens != null
  );
  if (!hasMeasuredAssistant) {
    const delta = {
      input_tokens: m.input_tokens,
      output_tokens: m.output_tokens,
      cache_read_tokens: m.cache_read_tokens,
      cache_write_tokens: m.cache_write_tokens,
      reasoning_tokens: m.reasoning_tokens,
    };
    const lastAssistant = [...rows].reverse().find((row) => row.kind === 'assistant');
    if (lastAssistant) {
      Object.assign(lastAssistant, delta);
      delete lastAssistant.estimated;
    } else if (!rows.some((row) => row.kind === 'stop_total')) {
      rows.push({ kind: 'assistant', model: report.model, ...delta });
    }
  }
  const assistants = rows.filter((row) => row.kind === 'assistant' && row.input_tokens != null && !row.estimated);
  const stops = rows.filter((row) => row.kind === 'stop_total');
  if (assistants.length === 1 && stops.length === 1) {
    const a = assistants[0];
    const s = stops[0];
    if (a.input_tokens === s.input_tokens && a.output_tokens === s.output_tokens) {
      return rows.filter((row) => row.kind !== 'stop_total');
    }
  }
  return rows;
}

function renderRequestsTable(report) {
  const rows = requestsForDisplay(report);
  if (!rows.length) {
    return '<p class="muted">Запросов модели пока нет. Счётчики появляются из <code>afterAgentResponse</code> / <code>stop</code>, когда Cursor их передал.</p>';
  }
  const body = rows
    .map((step, index) => {
      const tools = step.tools ? ` · ${escapeHtml(step.tools)}` : '';
      const est = step.estimated ? ' · оценка' : '';
      const label = `${index + 1} · ${escapeHtml(step.model || '—')}<br><small class="muted">${escapeHtml(step.kind || 'step')}${tools}${est}${step.at ? ` · ${escapeHtml(new Date(step.at).toLocaleTimeString('ru-RU'))}` : ''}</small>`;
      const cell = (value) => {
        if (value == null) return '<td class="num">—</td>';
        const text = step.estimated ? `≈ ${formatNum(value)}` : formatNum(value);
        return `<td class="num">${escapeHtml(text)}</td>`;
      };
      return `<tr><td>${label}</td>${cell(step.input_tokens)}${cell(step.cache_read_tokens)}${cell(step.output_tokens)}${cell(step.reasoning_tokens)}</tr>`;
    })
    .join('');
  return `<div class="table-wrap"><table><thead><tr><th>Шаг / модель</th><th class="num">Вход</th><th class="num">Кэш¹</th><th class="num">Выход</th><th class="num">Рассуждения</th></tr></thead><tbody>${body}</tbody></table></div><p class="muted">¹ Кэш уже входит во вход, если Cursor его передал. Строки <code>assistant</code> — дельты measured с <code>afterAgentResponse</code> (когда Cursor отдал поля); <code>stop_total</code> — итог хода. Tool I/O в этой таблице не показываем как отдельные запросы.</p>`;
}

function renderChatHistory(report, { offline = false, snapshot = null } = {}) {
  const chat = !offline ? loadChat(report.conversation_id) : null;
  const turns =
    offline && snapshot && Array.isArray(snapshot.turns)
      ? snapshot.turns
      : chat && Array.isArray(chat.turns)
        ? chat.turns
        : report
          ? [report]
          : [];
  const summary = (offline && snapshot && snapshot.summary) || buildChatSummary({ turns });
  const selected = String(report.generation_id || '');
  const buttons = turns
    .map((turn, index) => {
      const id = String(turn.generation_id || '');
      const current = id && id === selected;
      const total = turn.measured ? formatNum(turn.measured.total_tokens) : 'Нет счётчиков';
      const label = turn.prompt_preview || turn.generation_id || `ход ${index + 1}`;
      const href =
        !offline && turn.generation_id
          ? `/answers/${encodeURIComponent(String(turn.generation_id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80))}.html`
          : '#';
      const tag = offline ? 'div' : 'a';
      const hrefAttr = offline ? '' : ` href="${escapeHtml(href)}"`;
      return `<${tag} class="turn${current ? ' current' : ''}"${hrefAttr}><span>${index + 1}. ${escapeHtml(String(label).slice(0, 90))}</span><strong>${escapeHtml(total)}</strong><small>${escapeHtml(turn.status || '—')}${turn.at ? ` · ${escapeHtml(new Date(turn.at).toLocaleString('ru-RU'))}` : ''}</small></${tag}>`;
    })
    .join('');
  return `<details class="history"><summary>История ходов и итоги чата</summary>
    <section class="metrics" aria-label="Итоги чата">
      <article class="metric primary"><span>Всего по чату</span><strong>${escapeHtml(formatNum(summary.totals.total_tokens))}</strong><small>по записанным счётчикам</small></article>
      <article class="metric"><span>Вход</span><strong>${escapeHtml(formatNum(summary.totals.input_tokens))}</strong><small>кэш входит во вход</small></article>
      <article class="metric"><span>Выход</span><strong>${escapeHtml(formatNum(summary.totals.output_tokens))}</strong><small>рассуждения входят в выход, если измеряются</small></article>
    </section>
    <p class="muted">Счётчики есть для ${escapeHtml(String(summary.measuredTurnCount))} из ${escapeHtml(String(summary.turnCount))} ходов. Без счётчиков: ${escapeHtml(String(summary.missingUsageTurns))}. Выполняются: ${escapeHtml(String(summary.runningTurns))}.</p>
    <div class="turns">${buttons || '<p class="muted">Нет сохранённых ходов.</p>'}</div>
  </details>`;
}

function reasoningLabel(report, m) {
  if (m && m.reasoning_tokens != null) {
    return `${escapeHtml(formatNum(m.reasoning_tokens))} рассуждений · measured · входит в выход`;
  }
  if (report.reasoning_estimate) {
    return `≈ ${escapeHtml(formatNum(report.reasoning_estimate))} оценка thinking (UTF-8/3) · не billable`;
  }
  return 'нет данных · Cursor hooks обычно не отдают reasoning';
}

function renderAnswerHtml(report, { offline = false, snapshot = null } = {}) {
  const key = answerKey(report);
  const m = report.measured || {};
  const consumers = report.consumers || [];
  const cats = { ...emptyCategories(), ...(report.categories || {}) };
  const consumerRows = consumers.length
    ? consumers
        .map(
          (row) =>
            `<div class="row"><i></i><span>${escapeHtml(row.name)}</span><strong>≈ ${escapeHtml(formatNum(row.tokens))}</strong></div>`
        )
        .join('')
    : '<p class="muted">Нет оценки по инструментам.</p>';
  const { bars: catBars, stack: catStack } = renderCategoryBars(cats);
  const exportPayload = snapshot || buildExportSnapshot(report, { offline: true });
  const liveBadge = offline ? 'Сохранённый отчёт' : 'Обновляется';

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Аналитика ответа · Token Lens</title>
  <style>
    :root { color-scheme: light dark; --fg:#e8eaed; --muted:#9aa0a6; --card:#1e1f24; --line:#2d3038; --bg:#121317; --accent:#7dd3fc; }
    body { margin:0; font:14px/1.45 system-ui,sans-serif; color:var(--fg); background:var(--bg); }
    main { max-width:760px; margin:0 auto; padding:20px 16px 40px; }
    .eyebrow { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
    h1 { font-size:22px; margin:6px 0 8px; }
    .muted { color:var(--muted); }
    .metrics { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin:16px 0; }
    .metric { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px; }
    .metric.primary { border-color:color-mix(in srgb,var(--accent) 45%, var(--line)); }
    .metric span,.metric small { display:block; color:var(--muted); font-size:11px; }
    .metric strong { display:block; font-size:22px; margin:6px 0; }
    h2 { font-size:14px; margin:22px 0 8px; }
    .badge { display:inline-block; font-size:11px; padding:2px 8px; border-radius:999px; border:1px solid var(--line); color:var(--muted); margin-left:8px; }
    .row { display:grid; grid-template-columns:10px 1fr auto; gap:8px; align-items:center; margin:8px 0; }
    .row i { width:8px; height:8px; border-radius:99px; background:var(--accent); }
    .track { grid-column:2 / -1; height:4px; background:var(--line); border-radius:99px; overflow:hidden; }
    .track span { display:block; height:100%; }
    .stack { display:flex; height:10px; border-radius:99px; overflow:hidden; background:var(--line); margin:10px 0; }
    .stack span { min-width:2px; }
    details { margin-top:12px; color:var(--muted); }
    details.prompt, details.history, details.plan { margin:10px 0 16px; background:var(--card); border:1px solid var(--line); border-radius:10px; padding:8px 12px; }
    details.prompt summary, details.history summary { cursor:pointer; color:var(--fg); font-weight:600; }
    details.prompt pre { white-space:pre-wrap; margin:8px 0 4px; color:var(--muted); font:12px/1.45 ui-monospace,Consolas,monospace; }
    details.share { position:relative; margin:0; padding:0; background:transparent; border:0; flex:0 0 auto; color:var(--fg); }
    details.share > summary { list-style:none; cursor:pointer; width:36px; height:36px; display:grid; place-items:center; border:1px solid var(--line); border-radius:10px; background:var(--card); color:var(--fg); }
    details.share > summary::-webkit-details-marker { display:none; }
    details.share > summary:hover { border-color:color-mix(in srgb,var(--accent) 45%, var(--line)); color:var(--accent); }
    details.share[open] > summary { border-color:color-mix(in srgb,var(--accent) 45%, var(--line)); color:var(--accent); }
    details.share > summary svg { width:18px; height:18px; display:block; }
    .share-menu { position:absolute; right:0; top:calc(100% + 6px); min-width:220px; z-index:5; background:var(--card); border:1px solid var(--line); border-radius:10px; padding:6px 12px; box-shadow:0 10px 28px rgba(0,0,0,.35); }
    details.plan > summary { cursor:pointer; list-style:none; display:flex; flex-wrap:wrap; gap:6px 10px; align-items:baseline; }
    details.plan > summary::-webkit-details-marker { display:none; }
    details.plan .plan-caret { display:inline-block; width:0; height:0; border-top:5px solid transparent; border-bottom:5px solid transparent; border-left:7px solid var(--muted); transform:translateY(1px); flex:0 0 auto; transition:transform .12s ease; }
    details.plan[open] > summary .plan-caret { transform:translateY(1px) rotate(90deg); }
    details.plan .plan-title { font-weight:600; }
    details.plan .plan-summary { color:var(--muted); font-size:13px; }
    details.plan .plan-body { margin-top:12px; }
    details.plan .plan-metric { display:inline-flex; align-items:center; gap:4px; }
    details.plan .plan-help { width:16px; height:16px; padding:0; border-radius:99px; border:1px solid var(--line); background:transparent; color:var(--muted); font:11px/1 system-ui,sans-serif; cursor:help; }
    details.plan .plan-help:hover { color:var(--fg); border-color:var(--muted); }
    .plan-row { margin:10px 0; }
    .plan-label { display:flex; justify-content:space-between; gap:12px; margin-bottom:4px; }
    .plan-track { height:8px; background:var(--line); border-radius:99px; overflow:hidden; }
    .plan-track span { display:block; height:100%; }
    .plan-sub { font-size:11px; margin-top:4px; }
    .plan-lk { margin:12px 0 0; font-size:12px; color:var(--muted); }
    .plan-lk a { color:var(--accent); }
    .nav { margin:0 0 14px; display:flex; flex-wrap:wrap; gap:10px; align-items:center; justify-content:space-between; }
    .nav a { color:var(--accent); text-decoration:none; }
    .nav a:hover { text-decoration:underline; }
    .live { font-size:12px; color:var(--muted); }
    .share-menu a, .share-menu button { display:block; width:100%; text-align:left; padding:8px 0; color:var(--accent); background:transparent; border:0; font:inherit; cursor:pointer; }
    .table-wrap { overflow:auto; border:1px solid var(--line); border-radius:12px; background:var(--card); }
    table { width:100%; border-collapse:collapse; }
    th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
    th { font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
    tr:last-child td { border-bottom:0; }
    .num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
    .turns { display:flex; flex-direction:column; gap:8px; margin-top:10px; }
    a.turn { display:grid; grid-template-columns:1fr auto; gap:2px 10px; text-decoration:none; color:inherit; border:1px solid var(--line); border-radius:10px; padding:10px; background:var(--bg); }
    a.turn.current { border-color:color-mix(in srgb,var(--accent) 45%, var(--line)); }
    a.turn span { grid-column:1; color:var(--fg); }
    a.turn strong { grid-column:2; grid-row:1 / span 2; align-self:center; }
    a.turn small { grid-column:1; color:var(--muted); }
    .header-row { display:flex; gap:12px; align-items:flex-start; justify-content:space-between; }
  </style>
</head>
<body>
  <main>
    <div class="nav">
      ${offline ? '<span class="muted">Автономный снимок · без сервера</span>' : `<span><a href="/">All Reports</a> · <a href="/settings?from=${encodeURIComponent(key)}">Settings</a></span>`}
      <span class="live" id="live">${escapeHtml(liveBadge)}</span>
    </div>
    <div class="header-row">
      <div>
        <div class="eyebrow">Cursor · локальная статистика · per answer</div>
        <h1>📊 Аналитика запроса/ответа</h1>
      </div>
      <details class="share">
        <summary aria-label="Поделиться" title="Поделиться">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98"/></svg>
        </summary>
        <div class="share-menu">
          ${offline ? '' : `<a href="/export.html?key=${encodeURIComponent(key)}" download>Скачать как HTML</a><a href="/export.json?key=${encodeURIComponent(key)}" download>Скачать как JSON</a>`}
          <button id="offline-json" type="button">Скачать как JSON${offline ? '' : ' (локальная копия)'}</button>
        </div>
      </details>
    </div>
    <p class="muted">Чат <code>${escapeHtml(report.conversation_id || '—')}</code>
      · ход <code>${escapeHtml(report.generation_id || '—')}</code>
      · модель <code>${escapeHtml(report.model || '—')}</code>
      · ${escapeHtml(report.status || 'completed')}
      · ${escapeHtml(report.at || '')}
      ${report.context_tokens != null ? ` · context ≈ ${escapeHtml(formatNum(report.context_tokens))}` : ''}</p>

    <details class="prompt">
      <summary>Запрос${report.prompt_length ? ` · ${escapeHtml(String(report.prompt_length))} символов` : ''} <span class="badge">первые 200</span></summary>
      <pre>${escapeHtml(report.prompt_preview || 'Текст запроса для этого хода не попал в stop (хук beforeSubmitPrompt не сработал или preview сбросили до записи страницы).')}</pre>
    </details>

    ${offline ? '' : renderPlanBars(report.plan_usage)}
    ${renderChatHistory(report, { offline, snapshot: exportPayload })}

    <div class="eyebrow">Фактические счётчики (stop)${m.incomplete ? ' · неполный отчёт' : ''}</div>
    <section class="metrics" aria-label="Фактический расход">
      <article class="metric primary"><span>Всего</span><strong id="total">${escapeHtml(report.measured == null ? 'нет данных' : m.incomplete ? 'неполный' : formatNum(m.total_tokens))}</strong><small>${report.measured == null ? 'stop без token fields' : 'вход + выход'}</small></article>
      <article class="metric"><span>Вход</span><strong id="input">${escapeHtml(formatNum(m.input_tokens))}</strong><small id="cached">cache read ${escapeHtml(formatNum(m.cache_read_tokens))} · входит во вход</small></article>
      <article class="metric"><span>Выход</span><strong id="output">${escapeHtml(formatNum(m.output_tokens))}</strong><small id="reasoning">${reasoningLabel(report, m)}</small></article>
      <article class="metric"><span>Cache write</span><strong>${escapeHtml(formatNum(m.cache_write_tokens))}</strong><small>без кэша ${escapeHtml(formatNum(m.uncached_input_tokens))}</small></article>
    </section>

    <h2>Что занимало вход <span class="badge">оценка</span></h2>
    <p class="muted">UTF-8 байт / 3 по инструкциям, истории, схемам и tool I/O. Не биллинг и не полное разложение measured входа.</p>
    ${catStack}
    ${catBars}

    <h2>Потребители: результаты инструментов <span class="badge">оценка</span></h2>
    ${consumerRows}

    <h2>Запросы модели <span class="badge">${escapeHtml(String(requestsForDisplay(report).length))} шагов</span></h2>
    ${renderRequestsTable(report)}

    <details>
      <summary>Источник</summary>
      <p>Measured дельты из <code>afterAgentResponse</code>, когда Cursor передал token fields; <code>stop_total</code> — агрегат хода.
      Пустые tool_batch больше не считаются запросами модели. Категории — локальная оценка.
      Reasoning measured — только если Cursor передал поле; иначе оценка thinking из afterAgentThought.
      Схемы — оценка каталога builtin + mcp.json, не точный wire payload. Subagent spend не включён.</p>
    </details>
  </main>
  <script type="application/json" id="answer-data">${JSON.stringify(report).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}</script>
  <script type="application/json" id="export-data">${JSON.stringify(exportPayload).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}</script>
  <script>
  (function () {
    var report = JSON.parse(document.getElementById('answer-data').textContent);
    var snapshot = JSON.parse(document.getElementById('export-data').textContent);
    var offline = ${offline ? 'true' : 'false'};
    var key = ${JSON.stringify(key)};
    var button = document.getElementById('offline-json');
    if (button) button.onclick = function () {
      var url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
      var a = document.createElement('a'); a.href = url; a.download = 'token-lens-' + key + '.json'; a.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    };
    if (!offline) setInterval(async function () {
      if (document.hidden) return;
      try {
        var response = await fetch('/api/answer?key=' + encodeURIComponent(key), { cache: 'no-store' });
        if (response.status === 410) { location.reload(); return; }
        if (!response.ok) return;
        var next = await response.json();
        if (JSON.stringify(next) !== JSON.stringify(report)) location.reload();
      } catch (e) { /* keep last known report */ }
    }, 4000);
  })();
  </script>
</body>
</html>`;
}

function writeAnswerPage(report) {
  ensureDir();
  fs.mkdirSync(ANSWERS_DIR, { recursive: true });
  const key = answerKey(report);
  const htmlPath = path.join(ANSWERS_DIR, `${key}.html`);
  const jsonPath = path.join(ANSWERS_DIR, `${key}.json`);
  if (fs.existsSync(jsonPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      if (prev) {
        if (
          report.status === 'in_progress' &&
          prev.measured &&
          prev.status !== 'in_progress'
        ) {
          report = prev;
        } else {
          if (!report.prompt_preview && prev.prompt_preview) {
            report = {
              ...report,
              prompt_preview: prev.prompt_preview,
              prompt_length: prev.prompt_length || report.prompt_length || 0,
            };
          }
          if (
            (!report.consumers || (Array.isArray(report.consumers) && !report.consumers.length)) &&
            Array.isArray(prev.consumers) &&
            prev.consumers.length
          ) {
            report = { ...report, consumers: prev.consumers };
          }
          if (
            (!report.requests || (Array.isArray(report.requests) && !report.requests.length)) &&
            Array.isArray(prev.requests) &&
            prev.requests.length
          ) {
            report = { ...report, requests: prev.requests };
          }
          if (!report.measured && prev.measured && report.status !== 'in_progress') {
            report = { ...report, measured: prev.measured };
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
  if (!report.plan_usage) {
    try {
      report = { ...report, plan_usage: fetchPlanUsageSync() };
    } catch {
      report = { ...report, plan_usage: { error: 'plan usage fetch failed', plan: null } };
    }
  }
  fs.writeFileSync(htmlPath, renderAnswerHtml(report));
  writeJson(jsonPath, report);
  const server = ensureServerSync();
  const url = answerUrl(key);
  const markdown = buildAnswerMarkdown(url, report);
  writeJson(path.join(DATA_DIR, 'last-answer-link.json'), {
    at: report.at,
    conversation_id: report.conversation_id,
    generation_id: report.generation_id,
    key,
    url,
    markdown,
    htmlPath,
    server,
  });
  return { key, url, markdown, htmlPath, jsonPath, server };
}

function responseLinkFromLatest() {
  const latestPath = path.join(DATA_DIR, 'latest.json');
  if (!fs.existsSync(latestPath)) throw new Error('Нет latest.json — дождитесь stop.');
  const report = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  return writeAnswerPage(report);
}

if (require.main === module) {
  try {
    const out = responseLinkFromLatest();
    process.stdout.write(JSON.stringify(out));
  } catch (error) {
    process.stderr.write(String(error && error.message ? error.message : error));
    process.exitCode = 1;
  }
}

module.exports = {
  renderAnswerHtml,
  ANSWERS_DIR,
  writeAnswerPage,
  responseLinkFromLatest,
  answerKey,
  buildAnswerMarkdown,
  formatContextHeatLine,
};
