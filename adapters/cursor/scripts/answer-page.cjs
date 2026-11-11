'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  DATA_DIR,
  ensureDir,
  formatNum,
  writeJson,
} = require('./lib.cjs');
const { ensureServer, answerUrl } = require('./serve.cjs');

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
    details { margin-top:18px; color:var(--muted); }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">Cursor · локальная статистика · per answer</div>
    <h1>📊 Аналитика запроса/ответа</h1>
    <p class="muted">Чат <code>${escapeHtml(report.conversation_id || '—')}</code>
      · ход <code>${escapeHtml(report.generation_id || '—')}</code>
      · модель <code>${escapeHtml(report.model || '—')}</code>
      · ${escapeHtml(report.status || 'completed')}
      · ${escapeHtml(report.at || '')}</p>

    <div class="eyebrow">Фактические счётчики (stop)</div>
    <section class="metrics" aria-label="Фактический расход">
      <article class="metric primary"><span>Всего</span><strong>${escapeHtml(formatNum(m.total_tokens))}</strong><small>вход + выход</small></article>
      <article class="metric"><span>Вход</span><strong>${escapeHtml(formatNum(m.input_tokens))}</strong><small>без кэша ${escapeHtml(formatNum(m.uncached_input_tokens))}</small></article>
      <article class="metric"><span>Cache read</span><strong>${escapeHtml(formatNum(m.cache_read_tokens))}</strong><small>входит во вход</small></article>
      <article class="metric"><span>Выход</span><strong>${escapeHtml(formatNum(m.output_tokens))}</strong><small>completion</small></article>
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
  fs.writeFileSync(htmlPath, renderAnswerHtml(report));
  writeJson(jsonPath, report);
  // Cursor opens file:// as source in the editor — serve over localhost for real UI.
  const server = ensureServer();
  const url = answerUrl(key);
  const markdown = `[📊 Аналитика запроса/ответа](${url})`;
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
};
