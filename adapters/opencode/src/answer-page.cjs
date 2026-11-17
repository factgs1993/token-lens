'use strict';

// Per-answer HTML-отчёт. Портирован из adapters/cursor 0.2.1 (answer-page.cjs):
// один отчёт на завершённый ход, стабильный URL, live-страница дополняется счётчиками.
// Лимиты подписки Cursor (renderPlanBars) заменены строкой cost из OpenCode —
// надёжного источника квот в OpenCode нет.

const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR, ensureDir, formatNum, writeJson, answerKey, readSettings } = require('./lib.cjs');
const { ensureServerSync, answerUrl } = require('./serve.cjs');

const ANSWERS_DIR = path.join(DATA_DIR, 'answers');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusLabel(status) {
  const labels = {
    live: 'идёт',
    complete: 'завершён',
    interrupted: 'прерван',
    error: 'ошибка',
  };
  return labels[status] || status || '—';
}

function formatContextHeatLine(inputTokens, contextWindow = 200000) {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) return '';
  // shortcut: last measured input approximates context occupancy; upgrade when OpenCode exposes actual occupancy.
  const percent = inputTokens * 100 / contextWindow;
  const [icon, label] = percent < 40 ? ['🧊', 'ок'] : percent < 70 ? ['🌤️', 'ещё нормально'] : percent < 85 ? ['🔥', 'скоро новый чат'] : ['🌋', 'лучше начать новый чат'];
  return `${icon} Контекст: ${Math.floor(percent)}% · ${label}`;
}

function buildAnswerMarkdown(url, fileUrl, report = null) {
  let markdown = `[📊 Аналитика запроса/ответа](${fileUrl || url})`;
  const measured = report?.measured;
  const settings = readSettings();
  if (settings.appendTokenSummary && measured && !measured.incomplete &&
      [measured.input_tokens, measured.output_tokens].every(n => Number.isSafeInteger(n) && n >= 0)) {
    // Финальный текст ещё не сгенерирован при вызове инструмента со ссылкой.
    const at = Date.parse(report.at);
    const timestamp = Number.isFinite(at) ? new Date(at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(', ', ' ') : '';
    markdown += `\n\nТокены${timestamp ? ' ' + timestamp : ''}: вход ${formatNum(measured.input_tokens)} · выход ${formatNum(measured.output_tokens)} (на момент ссылки)`;
  }
  if (settings.appendContextHeat && !measured?.incomplete) {
    const last = Array.isArray(report?.requests) && report.requests.findLast(request =>
      [request?.input_tokens, request?.cache_read_tokens, request?.cache_write_tokens].every(n => Number.isSafeInteger(n) && n >= 0));
    const heat = formatContextHeatLine(last ? last.input_tokens + last.cache_read_tokens + last.cache_write_tokens : null, settings.contextWindow);
    if (heat) markdown += `\n\n${heat}`;
  }
  return markdown;
}

function renderAnswerHtml(report) {
  const key = report.key || answerKey(report);
  const m = report.measured || {};
  const consumers = report.consumers || [];
  const cats = report.categories || {};
  const consumerRows = consumers.length
    ? consumers
        .map(
          (row) =>
            `<div class="row"><i></i><span>${escapeHtml(row.name)}</span><strong>≈ ${escapeHtml(formatNum(row.tokens))}</strong></div>`
        )
        .join('')
    : '<p class="muted">Нет оценки по инструментам.</p>';

  const catTotal = (cats.tool_results || 0) + (cats.tool_calls || 0) || 1;
  const catBars = [
    ['Результаты инструментов', cats.tool_results || 0, '#68bdea'],
    ['Вызовы инструментов', cats.tool_calls || 0, '#e4a17d'],
  ]
    .filter(([, value]) => value > 0)
    .map(
      ([label, value, color]) =>
        `<div class="row"><i style="background:${color}"></i><span>${escapeHtml(label)}</span><strong>≈ ${escapeHtml(formatNum(value))}</strong><div class="track"><span style="width:${Math.min(100, (value / catTotal) * 100)}%;background:${color}"></span></div></div>`
    )
    .join('');

  const requests = Array.isArray(report.requests) ? report.requests : [];
  const stepRows = requests
    .map(
      (step, index) =>
        `<tr>
  <td class="mono">${index + 1}<br><small>${escapeHtml(step.model || '—')}</small><br><small class="muted">${escapeHtml(step.finish || '')}</small></td>
  <td class="num">${escapeHtml(step.input_tokens == null ? '—' : formatNum(step.input_tokens))}</td>
  <td class="num">${escapeHtml(step.cache_read_tokens == null ? '—' : formatNum(step.cache_read_tokens))}</td>
  <td class="num">${escapeHtml(step.cache_write_tokens == null ? '—' : formatNum(step.cache_write_tokens))}</td>
  <td class="num">${escapeHtml(step.output_tokens == null ? '—' : formatNum(step.output_tokens))}</td>
  <td class="num">${escapeHtml(step.reasoning_tokens == null ? '—' : formatNum(step.reasoning_tokens))}</td>
</tr>`
    )
    .join('');

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
    h2 { font-size:14px; margin:22px 0 8px; }
    .muted { color:var(--muted); }
    .mono { font:12px/1.4 ui-monospace,Consolas,monospace; }
    .metrics { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin:16px 0; }
    .metric { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px; }
    .metric.primary { border-color:color-mix(in srgb,var(--accent) 45%, var(--line)); }
    .metric span,.metric small { display:block; color:var(--muted); font-size:11px; }
    .metric strong { display:block; font-size:22px; margin:6px 0; }
    .badge { display:inline-block; font-size:11px; padding:2px 8px; border-radius:999px; border:1px solid var(--line); color:var(--muted); margin-left:8px; }
    .row { display:grid; grid-template-columns:10px 1fr auto; gap:8px; align-items:center; margin:8px 0; }
    .row i { width:8px; height:8px; border-radius:99px; background:var(--accent); }
    .track { grid-column:2 / -1; height:4px; background:var(--line); border-radius:99px; overflow:hidden; }
    .track span { display:block; height:100%; }
    table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
    th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
    th { font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
    tr:last-child td { border-bottom:0; }
    .num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
    details { margin-top:12px; color:var(--muted); }
    details.prompt { margin:10px 0 16px; background:var(--card); border:1px solid var(--line); border-radius:10px; padding:8px 12px; }
    details.prompt summary { cursor:pointer; color:var(--fg); font-weight:600; }
    details.prompt pre { white-space:pre-wrap; margin:8px 0 4px; color:var(--muted); font:12px/1.45 ui-monospace,Consolas,monospace; }
    .nav { margin:0 0 14px; }
    .nav a { color:var(--accent); text-decoration:none; }
    .nav a:hover { text-decoration:underline; }
  </style>
</head>
<body>
  <main>
    <p class="nav"><a href="/">All Reports</a> · <a href="/settings?from=${encodeURIComponent(key)}">Settings</a></p>
    <div class="eyebrow">OpenCode · локальная статистика · per answer</div>
    <h1>📊 Аналитика запроса/ответа</h1>
    <p class="muted">Сессия <code>${escapeHtml(report.session_id || '—')}</code>
      · ход <code>${escapeHtml(report.prompt_message_id || '—')}</code>
      · модель <code>${escapeHtml(report.model || '—')}</code>
      · ${escapeHtml(statusLabel(report.status))}
      · ${escapeHtml(report.at || '')}</p>

    <details class="prompt">
      <summary>Запрос${report.prompt_length ? ` · ${escapeHtml(String(report.prompt_length))} символов` : ''} <span class="badge">первые 200</span></summary>
      <pre>${escapeHtml(report.prompt_preview || 'Текст запроса для этого хода не сохранён (hook "prompt" не сработал или страница создана до записи).')}</pre>
    </details>

    <div class="eyebrow">Фактические счётчики${report.measured && report.measured.incomplete ? ' · неполный отчёт' : ''}${report.status === 'live' ? ' · ход ещё завершается' : ''}</div>
    <section class="metrics" aria-label="Фактический расход">
      <article class="metric primary"><span>Всего</span><strong>${escapeHtml(report.measured == null ? 'недоступно' : report.measured.incomplete ? 'неполный' : formatNum(report.measured.total_tokens))}</strong><small>${report.measured == null ? 'в OpenCode нет счётчиков tokens для этого хода' : 'вход + выход + рассуждения + кэш'}</small></article>
      <article class="metric"><span>Вход</span><strong>${escapeHtml(report.measured == null ? '—' : formatNum(report.measured.input_tokens))}</strong><small>без кэша</small></article>
      <article class="metric"><span>Cache read</span><strong>${escapeHtml(report.measured == null ? '—' : formatNum(report.measured.cache_read_tokens))}</strong><small>отдельно от входа</small></article>
      <article class="metric"><span>Cache write</span><strong>${escapeHtml(report.measured == null ? '—' : formatNum(report.measured.cache_write_tokens))}</strong><small>отдельно от входа</small></article>
      <article class="metric"><span>Выход</span><strong>${escapeHtml(report.measured == null ? '—' : formatNum(report.measured.output_tokens))}</strong><small>без рассуждений</small></article>
      <article class="metric"><span>Рассуждения</span><strong>${escapeHtml(report.measured == null ? '—' : formatNum(report.measured.reasoning_tokens))}</strong><small>отдельно от выхода</small></article>
    </section>
    <p class="muted">Cost хода: ${report.cost == null ? 'недоступно' : '$' + escapeHtml(Number(report.cost).toFixed(4))} · шагов модели: ${escapeHtml(String(report.steps ?? 0))}${report.missing_usage ? ' · счётчики tokens отсутствуют' : ''}</p>

    <h2>Шаги модели <span class="badge">measured</span></h2>
    ${stepRows ? `<div class="table-wrap"><table><thead><tr><th>Шаг</th><th class="num">Вход</th><th class="num">Cache read</th><th class="num">Cache write</th><th class="num">Выход</th><th class="num">Рассуждения</th></tr></thead><tbody>${stepRows}</tbody></table></div>` : '<p class="muted">Шагов пока нет.</p>'}
    <p class="muted">Каждый шаг хода — отдельное assistant-сообщение; итог — сумма шагов с дедупликацией по messageID.</p>

    <h2>Что занимало вход <span class="badge">оценка</span></h2>
    <p class="muted">UTF-8 байт / 3 по видимым tool args/results. Не биллинг и не полное разложение входа.</p>
    ${catBars || '<p class="muted">Нет категорий.</p>'}

    <h2>Потребители: результаты инструментов <span class="badge">оценка</span></h2>
    ${consumerRows}

    <details>
      <summary>Источник</summary>
      <p>Measured totals из assistant-сообщений OpenCode (plugin API V2, дедуп по sessionID + messageID). Потребители — локальная оценка tool I/O через hook execute.after. Компакция, генерация заголовка и transient generate в отчёт хода не входят. Subagent-сессии дают собственные отчёты.</p>
    </details>
  </main>
</body>
</html>`;
}

// Никогда не понижать завершённый отчёт до пустой live-перезаписи.
function mergeWithExisting(report) {
  const key = report.key || answerKey(report);
  const jsonPath = path.join(ANSWERS_DIR, `${key}.json`);
  if (!fs.existsSync(jsonPath)) return report;
  try {
    const prev = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (!prev) return report;
    if (report.status === 'live' && prev.measured && prev.status !== 'live') {
      return prev;
    }
    let merged = report;
    if (!report.prompt_preview && prev.prompt_preview) {
      merged = { ...report, prompt_preview: prev.prompt_preview, prompt_length: prev.prompt_length || report.prompt_length || 0 };
    }
    if (
      (!merged.consumers || (Array.isArray(merged.consumers) && !merged.consumers.length)) &&
      Array.isArray(prev.consumers) &&
      prev.consumers.length
    ) {
      merged = { ...merged, consumers: prev.consumers };
    }
    if (!merged.measured && prev.measured && report.status !== 'live') {
      merged = { ...merged, measured: prev.measured };
    }
    return merged;
  } catch {
    return report;
  }
}

function writeAnswerPage(report, { ensure = true } = {}) {
  ensureDir();
  fs.mkdirSync(ANSWERS_DIR, { recursive: true });
  let final = report;
  final.key = answerKey(final);
  final = mergeWithExisting(final);
  final.key = answerKey(final);

  const htmlPath = path.join(ANSWERS_DIR, `${final.key}.html`);
  const jsonPath = path.join(ANSWERS_DIR, `${final.key}.json`);
  fs.writeFileSync(htmlPath, renderAnswerHtml(final));
  writeJson(jsonPath, final);

  let server = null;
  if (ensure) {
    try {
      server = ensureServerSync();
    } catch {
      /* non-fatal */
    }
  }
  const url = answerUrl(final.key);
  const markdown = buildAnswerMarkdown(url, null, final);
  writeJson(path.join(DATA_DIR, 'last-answer-link.json'), {
    at: final.at,
    session_id: final.session_id,
    prompt_message_id: final.prompt_message_id,
    message_id: final.message_id,
    key: final.key,
    url,
    markdown,
    htmlPath,
    server,
  });
  return { key: final.key, url, markdown, htmlPath, jsonPath, server };
}

if (require.main === module) {
  // answer-page.cjs <sessionID> [promptMessageID] — перестроить страницу последнего/указанного хода.
  const lib = require('./lib.cjs');
  try {
    const sessionId = process.argv[2];
    let report = null;
    if (process.argv[3]) report = lib.findTurn(sessionId, process.argv[3]);
    if (!report) {
      const chat = lib.loadChat(sessionId);
      report = chat && Array.isArray(chat.turns) && chat.turns.length ? chat.turns[chat.turns.length - 1] : null;
    }
    if (!report) throw new Error('Ход не найден.');
    const out = writeAnswerPage(report);
    process.stdout.write(JSON.stringify(out));
  } catch (error) {
    process.stderr.write(String(error && error.message ? error.message : error));
    process.exitCode = 1;
  }
}

module.exports = {
  ANSWERS_DIR,
  writeAnswerPage,
  answerKey,
  buildAnswerMarkdown,
  formatContextHeatLine,
  renderAnswerHtml,
};
