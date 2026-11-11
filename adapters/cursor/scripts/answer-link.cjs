'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  PENDING_PATH,
  LATEST_JSON,
  ACTIVE_PATH,
  STATUS_PATH,
  DATA_DIR,
  readJson,
  ensureDir,
  writeJson,
  loadChat,
  formatNum,
} = require('./lib.cjs');
const { writeAnswerPage } = require('./answer-page.cjs');

function rankConsumers(map, limit = 12) {
  return Object.entries(map || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, tokens]) => ({ name, tokens }));
}

function main() {
  ensureDir();
  const active = readJson(ACTIVE_PATH, {});
  const pending = readJson(PENDING_PATH, {});
  const latest = readJson(LATEST_JSON, null);
  const status = readJson(STATUS_PATH, {});
  const conversationId =
    process.argv[2] ||
    pending.conversation_id ||
    active.conversation_id ||
    status.conversation_id ||
    (latest && latest.conversation_id) ||
    null;

  const chat = conversationId ? loadChat(conversationId) : null;
  const lastTurn =
    chat && Array.isArray(chat.turns) && chat.turns.length ? chat.turns[chat.turns.length - 1] : latest;

  const pendingConsumers = rankConsumers(pending.consumers);
  const hasLivePending = pendingConsumers.length > 0 || (pending.tools && pending.tools.length);

  // Prefer a real per-answer page when the last turn is already saved.
  if (!hasLivePending && lastTurn && lastTurn.measured) {
    const page = writeAnswerPage(lastTurn);
    const payload = {
      conversation_id: conversationId,
      markdown: page.markdown,
      label: '📊 Аналитика запроса/ответа',
      url: page.url,
      measured: lastTurn.measured,
      consumers: lastTurn.consumers || [],
      live: false,
    };
    writeJson(path.join(DATA_DIR, 'last-answer-link.json'), payload);
    process.stdout.write(JSON.stringify(payload));
    return;
  }

  // In-flight: point at last completed answer page if any, else server index.
  const { ensureServer, baseUrl, answerUrl } = require('./serve.cjs');
  ensureServer();
  let url = `${baseUrl()}/`;
  if (lastTurn && lastTurn.generation_id) {
    const page = writeAnswerPage(lastTurn);
    url = page.url;
  }
  const markdown = `[📊 Аналитика запроса/ответа](${url})`;
  const payload = {
    conversation_id: conversationId,
    markdown,
    label: '📊 Аналитика запроса/ответа',
    url,
    measured: lastTurn?.measured || null,
    consumers: pendingConsumers,
    live: true,
    note: 'Полная страница текущего хода появится после stop',
  };
  writeJson(path.join(DATA_DIR, 'last-answer-link.json'), payload);
  process.stdout.write(JSON.stringify(payload));
}

try {
  main();
} catch (error) {
  process.stderr.write(String(error && error.message ? error.message : error));
  process.exitCode = 1;
}
