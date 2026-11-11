'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  DATA_DIR,
  ensureDir,
  formatNum,
  writeJson,
  readSettings,
} = require('./lib.cjs');
const { ensureServerSync, answerUrl } = require('./serve.cjs');
const { fetchPlanUsageSync, renderPlanBars, formatPlanUsageLine } = require('./plan-usage.cjs');

function buildAnswerMarkdown(url, report) {
  const settings = readSettings();
  // Separate markdown paragraphs: Cursor/chat collapses single \n into one line.
  const blocks = [`[📊 Аналитика запроса/ответа](${url})`];
  if (settings.appendPlanLimits) {
    blocks.push(formatPlanUsageLine(report && report.plan_usage));
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

function renderAnswerHtml(report) {
  const key = answerKey(report);
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

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Аналитика ответа · Token Lens</title>
  <style>
    :root { color-scheme: light dark; --fg:#e8eaed; --muted:#9aa0a6; --card:#1e1f24; --line:#2d3038; --bg:#121317; --accent:#7dd3fc; }
    body { margin:0; font:14px/1.45 system-ui,sans-serif; color:var(--fg); background:var(--bg); }
    main { max-width:720px; margin:0 auto; padding:20px 16px 40px; }
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
    details { margin-top:12px; color:var(--muted); }
    details.prompt { margin:10px 0 16px; background:var(--card); border:1px solid var(--line); border-radius:10px; padding:8px 12px; }
    details.prompt summary { cursor:pointer; color:var(--fg); font-weight:600; }
    details.prompt pre { white-space:pre-wrap; margin:8px 0 4px; color:var(--muted); font:12px/1.45 ui-monospace,Consolas,monospace; }
    details.plan { margin:14px 0 18px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:10px 14px; color:var(--fg); }
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
    .nav { margin:0 0 14px; }
    .nav a { color:var(--accent); text-decoration:none; }
    .nav a:hover { text-decoration:underline; }
  </style>
</head>
<body>
  <main>
    <p class="nav"><a href="/">All Reports</a> · <a href="/settings?from=${encodeURIComponent(key)}">Settings</a></p>
    <div class="eyebrow">Cursor · локальная статистика · per answer</div>
    <h1>📊 Аналитика запроса/ответа</h1>
    <p class="muted">Чат <code>${escapeHtml(report.conversation_id || '—')}</code>
      · ход <code>${escapeHtml(report.generation_id || '—')}</code>
      · модель <code>${escapeHtml(report.model || '—')}</code>
      · ${escapeHtml(report.status || 'completed')}
      · ${escapeHtml(report.at || '')}</p>

    <details class="prompt">
      <summary>Запрос${report.prompt_length ? ` · ${escapeHtml(String(report.prompt_length))} символов` : ''} <span class="badge">первые 200</span></summary>
      <pre>${escapeHtml(report.prompt_preview || 'Текст запроса для этого хода не попал в stop (хук beforeSubmitPrompt не сработал или preview сбросили до записи страницы).')}</pre>
    </details>

    ${renderPlanBars(report.plan_usage)}

    <div class="eyebrow">Фактические счётчики (stop)${m.incomplete ? ' · неполный отчёт' : ''}</div>
    <section class="metrics" aria-label="Фактический расход">
      <article class="metric primary"><span>Всего</span><strong>${escapeHtml(m.incomplete ? 'неполный' : formatNum(m.total_tokens))}</strong><small>${m.incomplete ? 'нет полного входа+выхода' : 'вход + выход'}</small></article>
      <article class="metric"><span>Вход</span><strong>${escapeHtml(formatNum(m.input_tokens))}</strong><small>без кэша ${escapeHtml(formatNum(m.uncached_input_tokens))}</small></article>
      <article class="metric"><span>Cache read</span><strong>${escapeHtml(formatNum(m.cache_read_tokens))}</strong><small>входит во вход</small></article>
      <article class="metric"><span>Выход</span><strong>${escapeHtml(formatNum(m.output_tokens))}</strong><small>${m.output_tokens == null ? 'нет данных' : 'completion'}</small></article>
    </section>

    <h2>Что занимало вход <span class="badge">оценка</span></h2>
    <p class="muted">UTF-8 байт / 3 по видимым tool args/results. Не биллинг и не полное разложение входа.</p>
    ${catBars || '<p class="muted">Нет категорий.</p>'}

    <h2>Потребители: результаты инструментов <span class="badge">оценка</span></h2>
    ${consumerRows}

    <details>
      <summary>Источник</summary>
      <p>Measured totals из Cursor <code>stop</code> hook. Потребители — локальная оценка tool I/O.
      Инструкции, история и схемы инструментов в эту версию ещё не входят. Subagent spend не включён.</p>
    </details>
  </main>
</body>
</html>`;
}

function writeAnswerPage(report) {
  ensureDir();
  fs.mkdirSync(ANSWERS_DIR, { recursive: true });
  const key = answerKey(report);
  const htmlPath = path.join(ANSWERS_DIR, `${key}.html`);
  const jsonPath = path.join(ANSWERS_DIR, `${key}.json`);
  // Never downgrade a completed answer to an empty in-progress rewrite.
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
          // Never copy measured onto a live in_progress rewrite (can be a previous turn's totals).
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
  // Cursor opens file:// as source in the editor — serve over localhost for real UI.
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
  ANSWERS_DIR,
  writeAnswerPage,
  responseLinkFromLatest,
  answerKey,
  buildAnswerMarkdown,
};
