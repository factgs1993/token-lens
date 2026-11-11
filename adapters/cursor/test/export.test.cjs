const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderAnswerHtml } = require('../scripts/answer-page.cjs');
test('live reports poll for final counters and offline exports stay self-contained and escape prompt markup', () => {
  const report = { generation_id: 'test-1', conversation_id: 'chat-1', prompt_preview: '</script><img src=x onerror=alert(1)>', measured: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }, plan_usage: { error: 'unavailable' } };
  const live = renderAnswerHtml(report), offline = renderAnswerHtml(report, { offline: true });
  assert.match(live, /\/api\/answer\?key=/); assert.match(live, /4000/); assert.match(live, /\/export.html\?key=test-1/);
  assert.match(live, /Запросы модели/); assert.match(live, /История ходов и итоги чата/); assert.match(live, /Поделиться/);
  assert.ok(!offline.includes('href="/'));
  assert.ok(!offline.includes('</script><img'));
  assert.match(offline, /var offline = true/); assert.match(offline, /offline-json/);
  assert.match(offline, /id="export-data"/);
  const data = JSON.parse(offline.match(/id="answer-data">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.prompt_preview, report.prompt_preview);
});
