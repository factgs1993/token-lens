'use strict';

const fs = require('node:fs');
const {
  PENDING_PATH,
  PROMPT_PATH,
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
  promptPreview,
  extractPromptText,
  add,
  rank,
  saveTurn,
  renderMarkdown,
} = require('./lib.cjs');
const { writeAnswerPage } = require('./answer-page.cjs');
const { ensureServerSync } = require('./serve.cjs');

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

function savePrompt(conversationId, payload) {
  const preview = promptPreview(extractPromptText(payload));
  const record = {
    conversation_id: conversationId || null,
    at: new Date().toISOString(),
    prompt_preview: preview.preview,
    prompt_length: preview.length,
    payload_keys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 40) : [],
  };
  writeJson(PROMPT_PATH, record);
  return record;
}

function readSavedPrompt(conversationId) {
  const saved = readJson(PROMPT_PATH, null);
  if (!saved || !saved.prompt_preview) return { prompt_preview: null, prompt_length: 0 };
  if (conversationId && saved.conversation_id && saved.conversation_id !== conversationId) {
    return { prompt_preview: null, prompt_length: 0 };
  }
  return {
    prompt_preview: saved.prompt_preview,
    prompt_length: saved.prompt_length || 0,
  };
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
    if (event === 'sessionStart' || event === 'workspaceOpen') {
      try {
        ensureServerSync();
      } catch (error) {
        process.stderr.write(`[cursor-token-lens] ensureServer: ${error && error.message ? error.message : error}\n`);
      }
      reply({});
      return;
    }

    if (event === 'beforeSubmitPrompt') {
      const pending = emptyPending(conversationId);
      const saved = savePrompt(conversationId, payload);
      pending.prompt_preview = saved.prompt_preview;
      pending.prompt_length = saved.prompt_length;
      writeJson(PENDING_PATH, pending);
      if (conversationId) {
        writeJson(ACTIVE_PATH, {
          conversation_id: conversationId,
          at: new Date().toISOString(),
        });
      }
      try {
        ensureServerSync();
      } catch {
        /* non-fatal */
      }
      reply({});
      return;
    }

    if (event === 'postToolUse') {
      const pending = readJson(PENDING_PATH, emptyPending(conversationId));
      if (conversationId && pending.conversation_id && pending.conversation_id !== conversationId) {
        const kept = {
          prompt_preview: pending.prompt_preview,
          prompt_length: pending.prompt_length,
        };
        Object.assign(pending, emptyPending(conversationId), {
          prompt_preview: kept.prompt_preview || readSavedPrompt(conversationId).prompt_preview,
          prompt_length: kept.prompt_length || readSavedPrompt(conversationId).prompt_length,
        });
      }
      if (!pending.prompt_preview) {
        const saved = readSavedPrompt(conversationId);
        pending.prompt_preview = saved.prompt_preview;
        pending.prompt_length = saved.prompt_length;
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
      const savedPrompt = readSavedPrompt(conversationId || pending.conversation_id);
      const measured = measuredFromPayload(payload);
      const report = {
        at: new Date().toISOString(),
        conversation_id: conversationId || pending.conversation_id,
        generation_id: payload.generation_id || null,
        model: payload.model || payload.model_id || null,
        status: payload.status || null,
        prompt_preview: pending.prompt_preview || savedPrompt.prompt_preview || null,
        prompt_length: pending.prompt_length || savedPrompt.prompt_length || 0,
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
      writeAnswerPage(report);
      reply({});
      return;
    }

    reply({});
  } catch (error) {
    process.stderr.write(`[cursor-token-lens] ${error && error.message ? error.message : error}\n`);
    try {
      writeJson(require('node:path').join(DATA_DIR, 'hook-error.json'), {
        at: new Date().toISOString(),
        event,
        message: String(error && error.message ? error.message : error),
      });
    } catch {
      /* ignore */
    }
    reply({});
  }
}

main();
