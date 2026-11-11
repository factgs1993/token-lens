'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  LATEST_JSON,
  ACTIVE_PATH,
  STATUS_PATH,
  DATA_DIR,
  readJson,
  ensureDir,
  writeJson,
  loadChat,
  liveReportFromPending,
  rank,
  readSessionPending,
  findTurn,
} = require('./lib.cjs');
const { writeAnswerPage, ANSWERS_DIR, buildAnswerMarkdown } = require('./answer-page.cjs');
const { ensureServerSync, baseUrl } = require('./serve.cjs');

function rankConsumers(map, limit = 12) {
  return Object.entries(map || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, tokens]) => ({ name, tokens }));
}

function readAnswerJson(generationId) {
  if (!generationId) return null;
  const key = String(generationId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  const file = path.join(ANSWERS_DIR, `${key}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isLivePending(pending, conversationId) {
  if (!pending || !pending.generation_id) return false;
  const hasActivity =
    (Array.isArray(pending.tools) && pending.tools.length > 0) ||
    rankConsumers(pending.consumers).length > 0;
  const existing =
    findTurn(conversationId, pending.generation_id) || readAnswerJson(pending.generation_id);
  if (existing && existing.measured && existing.status !== 'in_progress') {
    // Completed turn for this generation — never treat leftover pending/prompt as live.
    return false;
  }
  // In progress: either tool activity, or page not completed yet.
  return hasActivity || !existing || existing.status === 'in_progress';
}

function lookupMeasured(conversationId, generationId) {
  if (!generationId) return null;
  const gid = String(generationId);
  const saved = readAnswerJson(generationId);
  // Ignore stale measured left on an in_progress page from a bad merge.
  if (saved && saved.measured && saved.status !== 'in_progress') return saved;
  const turn = findTurn(conversationId, generationId);
  if (turn && turn.measured && turn.status !== 'in_progress') return turn;
  const latest = readJson(LATEST_JSON, null);
  if (latest && String(latest.generation_id || '') === gid && latest.measured) {
    return latest;
  }
  return null;
}

function withMeasured(report, conversationId) {
  if (report && report.measured) return report;
  const generationId = report && report.generation_id;
  const found = lookupMeasured(conversationId, generationId);
  if (found && found.measured) {
    return {
      ...report,
      measured: found.measured,
      status: found.status || report.status,
      plan_usage: report.plan_usage || found.plan_usage || null,
    };
  }
  return report;
}

function emitPage(report, { live = false, conversationId = null } = {}) {
  const enriched = withMeasured(report, conversationId);
  const page = writeAnswerPage(enriched);
  const payload = {
    conversation_id: conversationId || enriched.conversation_id || null,
    markdown: page.markdown,
    label: '📊 Аналитика запроса/ответа',
    url: page.url,
    generation_id: enriched.generation_id || null,
    measured: enriched.measured || null,
    consumers: enriched.consumers || [],
    live: live && !(enriched && enriched.measured),
    prompt_preview: enriched.prompt_preview || null,
  };
  if (payload.live) {
    payload.note = 'Постоянный URL хода; после stop тот же отчёт дополнится счётчиками';
  }
  writeJson(path.join(DATA_DIR, 'last-answer-link.json'), payload);
  process.stdout.write(JSON.stringify(payload));
}

function main() {
  ensureDir();
  ensureServerSync();
  const active = readJson(ACTIVE_PATH, {});
  const latest = readJson(LATEST_JSON, null);
  const status = readJson(STATUS_PATH, {});

  // argv: answer-link.cjs <conversation_id> [generation_id]
  const conversationId =
    process.argv[2] ||
    process.env.TOKEN_LENS_CHAT_ID ||
    active.conversation_id ||
    status.conversation_id ||
    (latest && latest.conversation_id) ||
    null;
  const generationId = process.argv[3] || process.env.TOKEN_LENS_GENERATION_ID || null;

  const pending = readSessionPending(conversationId);
  const chat = conversationId ? loadChat(conversationId) : null;

  // Strict: requested generation first.
  if (generationId) {
    const turn = findTurn(conversationId, generationId) || readAnswerJson(generationId);
    if (turn && turn.measured && turn.status !== 'in_progress') {
      emitPage(turn, { live: false, conversationId });
      return;
    }
    if (isLivePending({ ...pending, generation_id: generationId }, conversationId)) {
      emitPage(
        liveReportFromPending(
          { ...pending, generation_id: generationId, conversation_id: conversationId },
          { status: 'in_progress', consumers: rank(pending.consumers || {}) }
        ),
        { live: true, conversationId }
      );
      return;
    }
    if (turn) {
      emitPage(turn, { live: false, conversationId });
      return;
    }
  }

  if (isLivePending(pending, conversationId)) {
    emitPage(
      liveReportFromPending(pending, {
        status: 'in_progress',
        consumers: rank(pending.consumers || {}),
      }),
      { live: true, conversationId }
    );
    return;
  }

  const lastTurn =
    chat && Array.isArray(chat.turns) && chat.turns.length ? chat.turns[chat.turns.length - 1] : null;
  const target =
    (lastTurn && lastTurn.conversation_id === conversationId ? lastTurn : null) ||
    (latest && (!conversationId || latest.conversation_id === conversationId) ? latest : null) ||
    lastTurn ||
    latest;

  if (target && target.generation_id) {
    // Prefer already-written answer JSON so we never downgrade measured totals.
    const saved = readAnswerJson(target.generation_id);
    emitPage(saved && saved.measured ? saved : target, { live: false, conversationId });
    return;
  }

  const url = `${baseUrl()}/latest`;
  const payload = {
    conversation_id: conversationId,
    markdown: buildAnswerMarkdown(url, latest || {}),
    label: '📊 Аналитика запроса/ответа',
    url,
    generation_id: null,
    measured: null,
    consumers: [],
    live: false,
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
