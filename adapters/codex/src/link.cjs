const { createStore } = require('./usage.cjs');
const { ensureConfig } = require('./config.cjs');

function responseLink(sessionId, turnId) {
  if (![sessionId, turnId].every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id))) throw new Error('Invalid session or turn ID');
  const route = '/answer?' + new URLSearchParams({ sessionId, turnId });
  const url = 'codex://plugins/codex-token-lens@token-lens-local/app/token_usage_panel?path=' + encodeURIComponent(route);
  return { sessionId, turnId, url, markdown: `[📊 Токены этого ответа](${url})` };
}

async function main() {
  try {
    const config = ensureConfig();
    const sessionId = process.argv[2] || process.env.CODEX_THREAD_ID;
    const store = createStore();
    const turn = store.report(sessionId).turns.at(-1);
    if (!turn) throw new Error('Current turn not found');
    const link = responseLink(sessionId, turn.id);
    link.view = config.reportView;
    if (config.reportView === 'browser') {
      const baseUrl = await require('./report.cjs').ensureReportServer();
      const query = new URLSearchParams({ sessionId, turnId: turn.id });
      link.htmlUrl = `${baseUrl}/answer?${query}`;
      link.jsonUrl = `${baseUrl}/export.json?${query}`;
      link.url = link.htmlUrl;
      link.markdown = `[📊 Токены этого ответа](${link.url})`;
    }
    console.log(JSON.stringify(link));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
if (require.main === module) main();
module.exports = { responseLink, main };
