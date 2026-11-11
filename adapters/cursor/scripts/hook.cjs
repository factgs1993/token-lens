'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  PENDING_PATH,
  LATEST_JSON,
  LATEST_MD,
  LOG_PATH,
  ACTIVE_PATH,
  DATA_DIR,
  estimate,
  readJson,
  writeJson,
  appendJsonl,
  measuredFromPayload,
  emptyPending,
  add,
  rank,
  saveTurn,
  renderMarkdown,
} = require('./lib.cjs');
const { writeAnswerPage } = require('./answer-page.cjs');

function followupEnabled() {
  return process.env.TOKEN_LENS_FOLLOWUP !== '0';
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function reply(obj) {
  process.stdout.write(JSON.stringify(obj || {}));
}

async function main() {
  let raw = '';
  try {
    raw = await readStdin();
  } catch {
    reply({});
    return;
  }
  let payload = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    reply({});
    return;
  }

  const event = payload.hook_event_name || payload.event || '';
  const conversationId = payload.conversation_id || payload.session_id || null;

  try {
    if (event === 'beforeSubmitPrompt') {
      writeJson(PENDING_PATH, emptyPending(conversationId));
      if (conversationId) {
        writeJson(ACTIVE_PATH, {
          conversation_id: conversationId,
          at: new Date().toISOString(),
        });
      }
      reply({});
      return;
    }

    if (event === 'postToolUse') {
      const pending = readJson(PENDING_PATH, emptyPending(conversationId));
      if (conversationId && pending.conversation_id && pending.conversation_id !== conversationId) {
        Object.assign(pending, emptyPending(conversationId));
      }
      pending.conversation_id = conversationId || pending.conversation_id;
      const name = String(payload.tool_name || 'tool');
      const callTokens = estimate(payload.tool_input ?? '');
      const resultTokens = estimate(payload.tool_output ?? '');
      add(pending.categories, 'tool_calls', callTokens);
      add(pending.categories, 'tool_results', resultTokens);
      add(pending.consumers, name, resultTokens);
      pending.tools.push({
        name,
        call_tokens: callTokens,
        result_tokens: resultTokens,
        at: new Date().toISOString(),
      });
      writeJson(PENDING_PATH, pending);
      reply({});
      return;
    }

    if (event === 'stop') {
      const pending = readJson(PENDING_PATH, emptyPending(conversationId));
      const measured = measuredFromPayload(payload);
      const report = {
        at: new Date().toISOString(),
        conversation_id: conversationId || pending.conversation_id,
        generation_id: payload.generation_id || null,
        model: payload.model || payload.model_id || null,
        status: payload.status || null,
        measured,
        categories: pending.categories || {},
        consumers: rank(pending.consumers || {}),
        tool_count: Array.isArray(pending.tools) ? pending.tools.length : 0,
        estimate_method: 'UTF-8 bytes / 3 for tool args/results; measured totals from stop payload',
      };
      writeJson(LATEST_JSON, report);
      fs.writeFileSync(LATEST_MD, renderMarkdown(report));
      appendJsonl(LOG_PATH, report);
      saveTurn(report);
      writeJson(PENDING_PATH, emptyPending(conversationId));

      // Codex-style: one markdown link to a per-answer detail page (not a dumped table).
      const loopCount = Number(payload.loop_count) || 0;
      const page = writeAnswerPage(report);
      if (followupEnabled() && loopCount === 0 && payload.status !== 'aborted') {
        writeJson(path.join(DATA_DIR, 'last-followup.json'), {
          at: report.at,
          conversation_id: report.conversation_id,
          generation_id: report.generation_id,
          url: page.url,
          markdown: page.markdown,
        });
        reply({
          followup_message:
            'Покажи пользователю ТОЛЬКО следующую markdown-ссылку на аналитику этого ответа — без вступления, без инструментов и без другого текста:\n\n' +
            page.markdown,
        });
        return;
      }

      reply({});
      return;
    }

    reply({});
  } catch (error) {
    process.stderr.write(`[cursor-token-lens] ${error && error.message ? error.message : error}\n`);
    reply({});
  }
}

main();
