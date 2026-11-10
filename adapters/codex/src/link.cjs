const { createStore } = require('./usage.cjs');

function responseLink(sessionId, turnId) {
  if (![sessionId, turnId].every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id))) throw new Error('Invalid session or turn ID');
  const route = '/answer?' + new URLSearchParams({ sessionId, turnId });
  const url = 'codex://plugins/codex-token-lens@token-lens-local/app/token_usage_panel?path=' + encodeURIComponent(route);
  return { sessionId, turnId, url, markdown: `[📊 Токены этого ответа](${url})` };
}

if (require.main === module) {
  try {
    const sessionId = process.argv[2] || process.env.CODEX_THREAD_ID;
    const store = createStore();
    const turn = store.report(sessionId).turns.at(-1);
    if (!turn) throw new Error('Current turn not found');
    console.log(JSON.stringify(responseLink(sessionId, turn.id)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { responseLink };
