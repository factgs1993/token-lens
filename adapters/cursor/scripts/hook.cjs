'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  LATEST_JSON,
  LATEST_MD,
  LOG_PATH,
  DATA_DIR,
  estimate,
  readJson,
  writeJson,
  appendJsonl,
  measuredFromPayload,
  emptyPending,
  liveReportFromPending,
  promptPreview,
  extractPromptText,
  add,
  rank,
  saveTurn,
  mergeTurnReports,
  findTurn,
  renderMarkdown,
  setActive,
  readSessionPending,
  writeSessionPending,
  readSessionPrompt,
  writeSessionPrompt,
  clearSessionPending,
} = require('./lib.cjs');
const { writeAnswerPage } = require('./answer-page.cjs');
const { ensureServerSync } = require('./serve.cjs');
const { fetchPlanUsageSync, CACHE_PATH } = require('./plan-usage.cjs');

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
    generation_id: payload.generation_id || null,
    model: payload.model || payload.model_id || null,
    at: new Date().toISOString(),
    prompt_preview: preview.preview,
    prompt_length: preview.length,
    payload_keys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 40) : [],
  };
  writeSessionPrompt(conversationId, record);
  return record;
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
      pending.generation_id = saved.generation_id;
      pending.model = saved.model;
      writeSessionPending(conversationId, pending);
      setActive(conversationId, pending.generation_id);
      try {
        ensureServerSync();
        if (pending.generation_id) {
          // Codex-style: permanent page for this turn exists before the answer ends.
          writeAnswerPage(liveReportFromPending(pending, { status: 'in_progress' }));
        }
      } catch {
        /* non-fatal */
      }
      reply({});
      return;
    }

    if (event === 'postToolUse') {
      const pending = readSessionPending(conversationId);
      const saved = readSessionPrompt(conversationId);
      pending.conversation_id = conversationId || pending.conversation_id;
      pending.prompt_preview = pending.prompt_preview || saved.prompt_preview;
      pending.prompt_length = pending.prompt_length || saved.prompt_length || 0;
      pending.generation_id = payload.generation_id || pending.generation_id || saved.generation_id;
      pending.model = payload.model || payload.model_id || pending.model || saved.model;
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
      writeSessionPending(conversationId, pending);
      if (pending.generation_id) setActive(conversationId, pending.generation_id);
      reply({});
      return;
    }

    if (event === 'stop') {
      const pending = readSessionPending(conversationId);
      const savedPrompt = readSessionPrompt(conversationId || pending.conversation_id);
      const measured = measuredFromPayload(payload);
      // Persist measured first (cached plan) — do not block on network plan fetch.
      let planUsage = readJson(CACHE_PATH, null);
      const generationId =
        payload.generation_id || pending.generation_id || savedPrompt.generation_id || null;
      const chatId = conversationId || pending.conversation_id;
      const prevTurn = findTurn(chatId, generationId);
      let report = mergeTurnReports(prevTurn, {
        at: new Date().toISOString(),
        conversation_id: chatId,
        generation_id: generationId,
        model: payload.model || payload.model_id || pending.model || savedPrompt.model || null,
        status: payload.status || null,
        prompt_preview: pending.prompt_preview || savedPrompt.prompt_preview || null,
        prompt_length: pending.prompt_length || savedPrompt.prompt_length || 0,
        measured,
        categories: pending.categories || {},
        consumers: rank(pending.consumers || {}),
        tools: Array.isArray(pending.tools) ? pending.tools : [],
        tool_count: Array.isArray(pending.tools) ? pending.tools.length : 0,
        estimate_method: 'UTF-8 bytes / 3 for tool args/results; measured totals from stop payload',
        plan_usage: planUsage,
      });
      writeJson(LATEST_JSON, report);
      fs.writeFileSync(LATEST_MD, renderMarkdown(report));
      const saved = saveTurn(report);
      if (saved.isNew) appendJsonl(LOG_PATH, report);
      clearSessionPending(chatId);
      let page = writeAnswerPage(report);

      try {
        planUsage = fetchPlanUsageSync();
        if (planUsage) {
          report = { ...report, plan_usage: planUsage };
          writeJson(LATEST_JSON, report);
          fs.writeFileSync(LATEST_MD, renderMarkdown(report));
          page = writeAnswerPage(report);
        }
      } catch {
        /* keep cached plan_usage */
      }

      writeJson(path.join(DATA_DIR, 'last-followup.json'), {
        at: new Date().toISOString(),
        conversation_id: chatId,
        generation_id: generationId,
        url: page.url,
        markdown: page.markdown,
      });
      reply({});
      return;
    }

    reply({});
  } catch (error) {
    process.stderr.write(`[cursor-token-lens] ${error && error.message ? error.message : error}\n`);
    try {
      writeJson(path.join(DATA_DIR, 'hook-error.json'), {
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
