const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TOKEN_LENS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-report-'));

const answerPage = require('../src/answer-page.cjs');
const { writeAnswerPage, renderAnswerHtml, buildAnswerMarkdown, answerKey } = answerPage;
const lib = require('../src/lib.cjs');

const baseReport = {
  at: new Date(2026, 10, 17, 13, 56).toISOString(),
  started_at: '2026-01-01T00:00:00.000Z',
  session_id: 'rep-ses',
  prompt_message_id: 'rep-msg',
  message_id: 'asst-1',
  model: 'anthropic/claude-x',
  prompt_preview: 'тестовый запрос',
  prompt_length: 15,
  measured: {
    input_tokens: 1200,
    output_tokens: 340,
    reasoning_tokens: 60,
    cache_read_tokens: 900,
    cache_write_tokens: 100,
    total_tokens: 2600,
  },
  cost: 0.0123,
  steps: 2,
  requests: [],
  missing_usage: false,
  consumers: [{ name: 'read', tokens: 42 }],
  categories: { tool_results: 42, tool_calls: 5 },
  tools: [],
  tool_count: 1,
  status: 'complete',
  outcome: 'succeeded',
};

test('answer key identity: sessionID + messageID', () => {
  assert.equal(answerKey(baseReport), 'rep-ses_rep-msg');
});

test('HTML with measured counters renders totals, cost and steps', () => {
  const html = renderAnswerHtml({ ...baseReport });
  assert.match(html, new RegExp(`2${String.fromCharCode(160)}600`));
  assert.match(html, new RegExp(`1${String.fromCharCode(160)}200`));
  assert.match(html, /900/);
  assert.match(html, /\$0\.0123/);
  assert.match(html, /завершён/);
  assert.match(html, /Аналитика запроса\/ответа/);
});

test('HTML without measured shows «недоступно», never 0', () => {
  const html = renderAnswerHtml({ ...baseReport, measured: null, cost: null });
  assert.match(html, /недоступно/);
  const totalSection = html.split('<article class="metric primary">')[1].split('</article>')[0];
  assert.match(totalSection, /недоступно/);
  assert.doesNotMatch(totalSection, /<strong>0</);
});

test('live page keeps stable key and never downgrades a completed report', () => {
  const completed = { ...baseReport };
  const page1 = writeAnswerPage(completed, { ensure: false });
  assert.equal(page1.key, 'rep-ses_rep-msg');

  const live = { ...baseReport, measured: null, cost: null, status: 'live', outcome: null, steps: 0, requests: [], message_id: null, at: '2026-01-01T00:01:00.000Z' };
  const page2 = writeAnswerPage(live, { ensure: false });
  assert.equal(page2.key, 'rep-ses_rep-msg');

  const saved = lib.readJson(path.join(lib.ANSWERS_DIR, 'rep-ses_rep-msg.json'), null);
  assert.equal(saved.status, 'complete', 'live-перезапись не понижает завершённый отчёт');
  assert.equal(saved.measured.total_tokens, 2600);

  const html = fs.readFileSync(path.join(lib.ANSWERS_DIR, 'rep-ses_rep-msg.html'), 'utf8');
  assert.match(html, new RegExp(`2${String.fromCharCode(160)}600`));
});

test('buildAnswerMarkdown: only the link tail when the summary is off', () => {
  const markdown = buildAnswerMarkdown('http://127.0.0.1:3848/answers/rep-ses_rep-msg.html', null, { ...baseReport });
  assert.equal(markdown, '[📊 Аналитика запроса/ответа](http://127.0.0.1:3848/answers/rep-ses_rep-msg.html)');
});

test('mergeTurnReports keeps the strongest data on repeated finalize', () => {
  const merged = lib.mergeTurnReports(baseReport, { ...baseReport, measured: null, consumers: [], status: 'live' });
  assert.equal(merged.measured.total_tokens, 2600);
  assert.equal(merged.consumers.length, 1);
});

test('summary follows the setting on every link and uses the report input/output without double counting', () => {
  const url = 'http://127.0.0.1:3848/answers/rep-ses_rep-msg.html';
  const link = buildAnswerMarkdown(url);
  assert.equal(buildAnswerMarkdown(url, null, baseReport), link);
  try {
    lib.writeSettings({ appendTokenSummary: true });
    const expected = `${link}\n\nТокены 17.11.2026 13:56: вход ${lib.formatNum(1200)} · выход 340 (на момент ссылки)`;
    assert.equal(buildAnswerMarkdown(url, null, baseReport), expected);
    for (const at of [undefined, null, '', 'invalid']) {
      assert.match(buildAnswerMarkdown(url, null, { ...baseReport, at }), /\n\nТокены: вход/);
    }
    assert.equal(buildAnswerMarkdown(url, null, { ...baseReport, measured: null }), link);
    assert.equal(buildAnswerMarkdown(url, null, { ...baseReport, measured: { ...baseReport.measured, incomplete: true } }), link);
    for (const input of [undefined, -1, NaN, Infinity, '1200']) {
      assert.equal(buildAnswerMarkdown(url, null, { measured: { input_tokens: input, output_tokens: 340 } }), link);
    }
    assert.match(buildAnswerMarkdown(url, null, { measured: { input_tokens: 0, output_tokens: 0 } }), /вход 0 · выход 0/);
    const page = writeAnswerPage({ ...baseReport }, { ensure: false });
    assert.equal(page.markdown, buildAnswerMarkdown(page.url, null, baseReport));
    assert.match(page.markdown, /\n\nТокены 17\.11\.2026 13:56:/);
    assert.equal(lib.readJson(path.join(lib.DATA_DIR, 'last-answer-link.json')).markdown, page.markdown);
    lib.writeSettings({ appendTokenSummary: false });
    assert.equal(buildAnswerMarkdown(url, null, baseReport), link);
  } finally {
    lib.writeSettings({ appendTokenSummary: false });
  }
});
