'use strict';

// Семантика счётчиков OpenCode (plugin API V2):
// - каждый шаг хода = отдельное assistant-сообщение с tokens {input, output, reasoning, cache:{read,write}};
// - вход не включает кэш; cache.read/cache.write отдельно; рассуждения отдельно (не внутри выхода);
// - итог хода = сумма по assistant-сообщениям с дедупликацией по messageID;
// - total считается по семантике TokenUsage.total(): input + output + reasoning + cache.read + cache.write;
// - cost суммируется, если есть; нет счётчиков — measured null, а не 0;
// - compaction / title / generate не смешиваются с ходом: hook "prompt" не срабатывает
//   для compaction/shell/synthetic, а title/generate не оставляют assistant-сообщений в истории хода.

const lib = require('./lib.cjs');

const { estimate, add, rank, promptPreview } = lib;

function messagesOf(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.messages)) return result.messages;
  return [];
}

function num(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function tokenTotal(tokens) {
  return (
    (tokens.input || 0) +
    (tokens.output || 0) +
    (tokens.reasoning || 0) +
    (tokens.cache?.read || 0) +
    (tokens.cache?.write || 0)
  );
}

// tokens OpenCode -> measured. Возвращает null, если нет ни входа, ни выхода.
function measuredFromTokenUsage(tokens) {
  if (!tokens || typeof tokens !== 'object') return null;
  const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
  const input = num(Math.round(Number(tokens.input)));
  const output = num(Math.round(Number(tokens.output)));
  if (input == null && output == null) return null;
  const reasoning = num(Math.round(Number(tokens.reasoning))) ?? 0;
  const cacheRead = num(Math.round(Number(cache.read))) ?? 0;
  const cacheWrite = num(Math.round(Number(cache.write))) ?? 0;
  return {
    input_tokens: input ?? 0,
    output_tokens: output ?? 0,
    reasoning_tokens: reasoning,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    total_tokens: (input ?? 0) + (output ?? 0) + reasoning + cacheRead + cacheWrite,
    incomplete: input == null || output == null,
  };
}

function messageTokens(message) {
  if (!message || typeof message !== 'object') return null;
  return measuredFromTokenUsage(message.tokens);
}

function messageCost(message) {
  const value = Number(message?.cost);
  return Number.isFinite(value) ? value : null;
}

function modelLabel(message) {
  const model = message?.model;
  if (!model) return null;
  const id = model.id || model.modelID;
  const provider = model.providerID;
  if (!id) return null;
  return provider ? `${provider}/${id}` : id;
}

function messageTime(message, key) {
  const raw = message?.time?.[key];
  const value = Date.parse(raw ?? '');
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function hasError(message) {
  return Boolean(message?.error);
}

// Накопление потребителей за ход: UTF-8 байт / 3 по аргументам и результатам инструментов.
// Чистая функция поверх pending (мутирует переданный объект, как Cursor hook.cjs).
function addToolUsage(pending, { tool, input, result, at } = {}) {
  if (!pending) return;
  const name = String(tool || 'tool');
  const callTokens = estimate(input ?? '');
  const resultTokens = estimate(result ?? '');
  add(pending.categories, 'tool_calls', callTokens);
  add(pending.categories, 'tool_results', resultTokens);
  add(pending.consumers, name, resultTokens);
  pending.tools.push({
    name,
    call_tokens: callTokens,
    result_tokens: resultTokens,
    at: at || new Date().toISOString(),
  });
}

function hasActivity(pending) {
  if (!pending) return false;
  if (Array.isArray(pending.tools) && pending.tools.length > 0) return true;
  return Boolean(pending.prompt_message_id);
}

// Сбор отчёта по ходу из сообщений сессии.
// pending — накопленное за ход (preview, потребители); outcome — 'succeeded' | 'failed' | 'interrupted' | null.
function turnFromMessages(messages, pending, { outcome = null, at = null } = {}) {
  const list = messagesOf(messages);
  if (!list.length) return null;

  // Начало хода: prompt-сообщение из hook "prompt", иначе последнее user-сообщение.
  let startIdx = -1;
  const promptId = pending?.prompt_message_id;
  if (promptId) startIdx = list.findIndex((m) => m && m.id === promptId);
  if (startIdx < 0) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]?.type === 'user') {
        startIdx = i;
        break;
      }
    }
  }
  if (startIdx < 0) return null;

  const anchor = list[startIdx];
  const promptMessageId = anchor?.id || promptId || null;

  // Шаги хода: assistant-сообщения после начала хода, дедупликация по messageID.
  const steps = [];
  const seen = new Set();
  for (let i = startIdx + 1; i < list.length; i++) {
    const message = list[i];
    if (!message) continue;
    if (message.type === 'user') break; // следующие ходы не трогаем
    if (message.type !== 'assistant') continue; // compaction/system/synthetic не смешиваем
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    steps.push(message);
  }

  const row = pending && typeof pending === 'object' ? pending : {};
  const now = at || new Date().toISOString();

  const requests = [];
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let costSum = 0;
  let anyTokens = false;
  let anyCost = false;
  let incomplete = false;

  for (const message of steps) {
    const m = messageTokens(message);
    const stepCost = messageCost(message);
    if (m) {
      anyTokens = true;
      input += m.input_tokens;
      output += m.output_tokens;
      reasoning += m.reasoning_tokens;
      cacheRead += m.cache_read_tokens;
      cacheWrite += m.cache_write_tokens;
      if (m.incomplete) incomplete = true;
    }
    if (stepCost != null) {
      anyCost = true;
      costSum += stepCost;
    }
    requests.push({
      message_id: message.id || null,
      model: modelLabel(message),
      at: messageTime(message, 'completed') || messageTime(message, 'created') || now,
      finish: message.finish || null,
      input_tokens: m ? m.input_tokens : null,
      output_tokens: m ? m.output_tokens : null,
      reasoning_tokens: m ? m.reasoning_tokens : null,
      cache_read_tokens: m ? m.cache_read_tokens : null,
      cache_write_tokens: m ? m.cache_write_tokens : null,
      total_tokens: m ? m.total_tokens : null,
      cost: stepCost,
    });
  }

  const measured = anyTokens
    ? {
        input_tokens: input,
        output_tokens: output,
        reasoning_tokens: reasoning,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
        total_tokens: input + output + reasoning + cacheRead + cacheWrite,
        incomplete,
      }
    : null;

  const last = steps[steps.length - 1] || null;
  let status;
  if (outcome === 'failed' || hasError(last)) status = 'error';
  else if (outcome === 'interrupted') status = 'interrupted';
  else if (outcome === 'succeeded') status = 'complete';
  else if (steps.length === 0) status = 'live';
  else if (last && messageTime(last, 'completed') && !hasError(last)) status = 'complete';
  else status = 'live';

  // Preview запроса: сохранённый в hook "prompt", иначе текст user-сообщения.
  const anchorText = typeof anchor?.text === 'string' ? anchor.text : '';
  const preview = promptPreview(row.prompt_preview || anchorText);
  const models = [...new Set(requests.map((r) => r.model).filter(Boolean))];

  return {
    key: null,
    at: now,
    started_at: row.started_at || messageTime(anchor, 'created') || now,
    session_id: row.session_id || anchor?.sessionID || null,
    prompt_message_id: promptMessageId,
    message_id: last?.id || null,
    status,
    outcome: outcome || null,
    model: models.length ? models[models.length - 1] : row.model || null,
    prompt_preview: preview.preview,
    prompt_length: preview.length,
    measured,
    cost: anyCost ? costSum : null,
    steps: steps.length,
    requests,
    missing_usage: steps.length > 0 && !anyTokens,
    consumers: rank(row.consumers || {}),
    categories: row.categories || { tool_results: 0, tool_calls: 0 },
    tools: Array.isArray(row.tools) ? row.tools : [],
    tool_count: Array.isArray(row.tools) ? row.tools.length : 0,
    estimate_method: 'UTF-8 bytes / 3 for tool args/results; measured totals from OpenCode assistant message tokens (dedup by messageID)',
  };
}

// Live-отчёт из накопленного pending — страница существует до финальных measured.
function liveReportFromPending(pending, extras = {}) {
  const row = pending && typeof pending === 'object' ? pending : {};
  const preview = promptPreview(row.prompt_preview || '');
  const now = new Date().toISOString();
  return {
    key: null,
    at: extras.at || now,
    started_at: row.started_at || now,
    session_id: row.session_id || null,
    prompt_message_id: row.prompt_message_id || null,
    message_id: null,
    status: 'live',
    outcome: null,
    model: row.model || null,
    prompt_preview: preview.preview,
    prompt_length: preview.length,
    measured: null,
    cost: null,
    steps: 0,
    requests: [],
    missing_usage: false,
    consumers: rank(row.consumers || {}),
    categories: row.categories || { tool_results: 0, tool_calls: 0 },
    tools: Array.isArray(row.tools) ? row.tools : [],
    tool_count: Array.isArray(row.tools) ? row.tools.length : 0,
    estimate_method: 'UTF-8 bytes / 3 for tool args/results; measured totals pending until the turn completes',
  };
}

module.exports = {
  messagesOf,
  measuredFromTokenUsage,
  messageTokens,
  messageCost,
  modelLabel,
  tokenTotal,
  addToolUsage,
  hasActivity,
  turnFromMessages,
  liveReportFromPending,
};
