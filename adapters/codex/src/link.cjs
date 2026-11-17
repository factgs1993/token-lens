const { createStore } = require('./usage.cjs');
const { ensureConfig } = require('./config.cjs');
const { normalizeLimits, readRateLimits } = require('./limits.cjs');

function formatContextHeatLine(inputTokens, contextWindow = 200000) {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) return '';
  // shortcut: last measured input approximates context occupancy; upgrade when Codex exposes actual occupancy.
  const percent = inputTokens * 100 / contextWindow;
  const [icon, label] = percent < 40 ? ['🧊', 'ок'] : percent < 70 ? ['🌤️', 'ещё нормально'] : percent < 85 ? ['🔥', 'скоро новый чат'] : ['🌋', 'лучше начать новый чат'];
  return `${icon} Контекст: ${Math.floor(percent)}% · ${label}`;
}

function formatFooter(limits) {
  if (!limits?.pools?.length) return 'Лимиты Codex: временно недоступны.';
  const windows = limits.pools.flatMap(pool => [pool.primary, pool.secondary].filter(Boolean).map(window => {
    const minutes = window.windowMinutes;
    const duration = !minutes ? 'окно' : minutes % 1440 === 0 ? `${minutes / 1440} д` : minutes % 60 === 0 ? `${minutes / 60} ч` : `${minutes} мин`;
    return `${pool.name === 'Codex' ? 'Осталось' : `${pool.name}: осталось`} ${window.remainingPercent}% (${duration})`;
  }));
  const timestamp = limits.fetchedAt ? new Date(limits.fetchedAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(', ', ' ') : '';
  return `Лимиты аккаунта Codex${timestamp ? ' ' + timestamp : ''}:\n\n` + [...windows, 'Общие для всех чатов.'].map(line => `* ${line}`).join('\n');
}

function responseLink(sessionId, turnId) {
  if (![sessionId, turnId].every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id))) throw new Error('Invalid session or turn ID');
  const route = '/answer?' + new URLSearchParams({ sessionId, turnId });
  const url = 'codex://plugins/codex-token-lens@token-lens-local/app/token_usage_panel?path=' + encodeURIComponent(route);
  return { sessionId, turnId, url, markdown: `[📊 Аналитика запроса/ответа](${url})` };
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
      link.markdown = `[📊 Аналитика запроса/ответа](${link.url})`;
    }
    if (config.appendPlanLimits) {
      let accountLimits = null;
      try { accountLimits = normalizeLimits(await readRateLimits({ timeoutMs: 3000 })); } catch {}
      link.markdown = formatFooter(accountLimits) + '\n\n' + link.markdown;
    }
    if (config.appendContextHeat) {
      const heat = formatContextHeatLine(turn.lastInputTokens, config.contextWindow);
      if (heat) link.markdown += '\n\n' + heat;
    }
    console.log(JSON.stringify(link));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
if (require.main === module) main();
module.exports = { responseLink, main, formatFooter, formatContextHeatLine };
