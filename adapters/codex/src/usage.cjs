const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const fields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const empty = () => Object.fromEntries(fields.map(key => [key, 0]));
const estimate = value => Math.ceil(Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value ?? ''), 'utf8') / 3);
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);

function normalizeUsage(value) {
  if (!value || !['input_tokens', 'output_tokens'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) return null;
  const result = empty();
  for (const key of fields) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 0)) return null;
    result[key] = value[key] ?? 0;
  }
  result.total_tokens = value.total_tokens ?? result.input_tokens + result.output_tokens;
  return result;
}

function parseTranscript(text) {
  const lines = text.split('\n');
  const rows = [];
  let malformedLines = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try { rows.push(JSON.parse(lines[i])); }
    catch { if (i < lines.length - 1) malformedLines++; } // A writer may still be appending the final line.
  }
  const modern = rows.some(row => row.type === 'token_usage_record');
  const turns = new Map();
  let currentTurn = null;
  let model = '—';
  let base = '';
  let visible = [];
  let pendingAssistant = [];
  let schemas = [];
  let previousLegacy = empty();
  let lastStepSignature = '';
  const seenResponses = new Set();
  const calls = new Map();
  const getTurn = id => {
    if (!turns.has(id)) turns.set(id, { id, label: '', prompt: null, startedAt: null, status: 'unknown', usage: empty(), requests: [], consumers: {}, categories: {}, models: {}, hasUsage: false });
    return turns.get(id);
  };
  const add = (object, key, value) => { object[key] = (object[key] ?? 0) + value; };
  const contentText = p => (p.content || []).filter(c => typeof c.text === 'string').map(c => c.text).join('\n');
  function capturePrompt(id, text) {
    if (!id || typeof text !== 'string' || !text.trim() || getTurn(id).prompt) return;
    const preview = text.replace(/\s+/g, ' ').trim();
    const turn = getTurn(id);
    turn.prompt = { preview: preview.slice(0, 200), length: text.length, truncated: preview.length > 200 };
    turn.label = preview.slice(0, 90);
  }

  for (const row of rows) {
    const p = row.payload || {};
    if (row.type === 'session_meta') base = typeof p.base_instructions === 'string' ? p.base_instructions : p.base_instructions?.text || '';
    if (row.type === 'turn_context') { currentTurn = p.turn_id || currentTurn; model = p.model || model; }
    if (row.type === 'event_msg' && p.type === 'user_message') capturePrompt(p.turn_id || currentTurn, p.message);
    if (row.type === 'event_msg' && ['task_started', 'turn_started'].includes(p.type)) {
      currentTurn = p.turn_id || p.turn_attribution?.turn_id || 'legacy';
      const turn = getTurn(currentTurn);
      turn.status = 'running'; turn.startedAt = row.timestamp;
    }
    if (row.type === 'event_msg' && ['task_complete', 'task_completed', 'turn_completed', 'turn_aborted'].includes(p.type)) {
      const id = p.turn_id || currentTurn;
      if (id) getTurn(id).status = p.type === 'turn_aborted' ? 'interrupted' : 'completed';
    }
    if (row.type === 'compacted') {
      // shortcut: rollout context is incomplete; upgrade when Codex exposes request-level attribution.
      visible = visible.filter(item => item.category === 'instructions');
      if (Array.isArray(p.replacement_history)) {
        for (const item of p.replacement_history) visible.push({ category: 'conversation', tokens: estimate(contentText(item)), consumer: null });
      } else if (p.message) visible.push({ category: 'conversation', tokens: estimate(p.message), consumer: null });
    }
    if (row.type === 'response_item') {
      if (p.type === 'additional_tools') schemas = [{ category: 'schemas', tokens: estimate(p.tools), consumer: null }];
      if (p.type === 'message') {
        const text = contentText(p);
        if (text) (p.role === 'assistant' ? pendingAssistant : visible).push({ category: ['developer', 'system'].includes(p.role) ? 'instructions' : 'conversation', tokens: estimate(text), consumer: null });
        if (p.role === 'user' && !text.trim().startsWith('<')) capturePrompt(currentTurn, text);
      }
      if (['function_call', 'custom_tool_call'].includes(p.type)) {
        const name = p.name || 'tool';
        calls.set(p.call_id, name);
        pendingAssistant.push({ category: 'tool_calls', tokens: estimate(p.arguments ?? p.input ?? ''), consumer: name });
      }
      if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
        visible.push({ category: 'tool_results', tokens: estimate(p.output), consumer: calls.get(p.call_id) || 'tool' });
      }
    }

    let usage = null;
    let id = currentTurn || 'legacy';
    if (row.type === 'token_usage_record') {
      const responseKey = p.response_id || `${p.turn_id}:${row.ordinal ?? row.timestamp}`;
      if (seenResponses.has(responseKey)) continue;
      seenResponses.add(responseKey);
      usage = normalizeUsage(p.usage); id = p.turn_id || id;
    } else if (!modern && row.type === 'event_msg' && p.type === 'token_count' && p.info) {
      const total = normalizeUsage(p.info.total_token_usage);
      const last = normalizeUsage(p.info.last_token_usage);
      if (!total || !last) continue;
      const signature = JSON.stringify(total);
      if (signature === lastStepSignature) continue;
      lastStepSignature = signature;
      // Legacy cumulative counters can repeat and can reset after a resumed session.
      usage = total.total_tokens >= previousLegacy.total_tokens ? Object.fromEntries(fields.map(key => [key, Math.max(0, total[key] - previousLegacy[key])])) : last;
      previousLegacy = total;
    }
    if (!usage) continue;
    const turn = getTurn(id);
    turn.hasUsage = true;
    for (const key of fields) turn.usage[key] += usage[key];
    const models = turn.models[model] ||= empty();
    for (const key of fields) models[key] += usage[key];
    // This is a visible-context proxy, not a reconstruction of the actual model request.
    const snapshot = [{ category: 'instructions', tokens: estimate(base), consumer: null }, ...schemas, ...visible];
    for (const item of snapshot) {
      add(turn.categories, item.category, item.tokens);
      if (item.consumer && item.category === 'tool_results') add(turn.consumers, item.consumer, item.tokens);
    }
    turn.requests.push({ at: row.timestamp, model, ...usage });
    visible.push(...pendingAssistant);
    pendingAssistant = [];
  }
  return { turns: [...turns.values()], source: modern ? 'token_usage_record' : 'event_msg.token_count', malformedLines, estimateMethod: 'UTF-8 bytes / 3; visible context accumulated at usage events; not billable attribution' };
}

function createStore(codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  const root = path.join(codexHome, 'sessions');
  let files = [];
  let scannedAt = 0;
  const cache = new Map();
  function scan() {
    if (Date.now() - scannedAt < 10000) return;
    files = [];
    function walk(dir) {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && /^rollout-.+\.jsonl$/.test(entry.name)) files.push({ path: file, name: entry.name, mtime: fs.statSync(file).mtimeMs });
      }
    }
    walk(root); files.sort((a, b) => b.mtime - a.mtime); scannedAt = Date.now();
  }
  function read(file) {
    const stat = fs.statSync(file.path);
    if (stat.size > 64 * 1024 * 1024) throw new Error('Журнал больше 64 МБ: этот чат пока не поддерживается.');
    const previous = cache.get(file.path);
    if (previous && previous.mtime === stat.mtimeMs && previous.size === stat.size) return previous.report;
    const report = parseTranscript(fs.readFileSync(file.path, 'utf8'));
    cache.set(file.path, { mtime: stat.mtimeMs, size: stat.size, report });
    if (cache.size > 5) cache.delete(cache.keys().next().value);
    return report;
  }
  function list() {
    scan();
    return files.slice(0, 30).map(file => {
      const id = file.name.match(/([a-f0-9]{8}-[a-f0-9-]{27,})\.jsonl$/i)?.[1];
      if (!id) return null;
      return { id, modifiedAt: new Date(file.mtime).toISOString() };
    }).filter(Boolean);
  }
  function report(sessionId) {
    if (!validId(sessionId)) throw new Error('Некорректный ID чата.');
    scan();
    const file = files.find(file => file.name.endsWith(`-${sessionId}.jsonl`));
    if (!file) throw new Error('Локальный журнал чата не найден.');
    const realRoot = fs.realpathSync(root);
    const relative = path.relative(realRoot, fs.realpathSync(file.path));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Журнал находится вне каталога sessions.');
    return { sessionId, ...read(file) };
  }
  function answer(sessionId, turnId) {
    if (!validId(turnId)) throw new Error('Некорректный ID ответа.');
    const data = report(sessionId);
    const turn = data.turns.find(turn => turn.id === turnId);
    if (!turn) throw new Error('Ответ не найден в журнале этого чата.');
    return { sessionId, turn, source: data.source, malformedLines: data.malformedLines, estimateMethod: data.estimateMethod };
  }
  function snapshot(sessionId, turnId) {
    if (!validId(turnId)) throw new Error('Некорректный ID ответа.');
    const data = report(sessionId);
    if (!data.turns.some(turn => turn.id === turnId)) throw new Error('Ответ не найден в журнале этого чата.');
    const measured = data.turns.filter(turn => turn.hasUsage);
    const totals = empty();
    for (const turn of measured) for (const key of fields) totals[key] += turn.usage[key];
    return { schemaVersion: 1, exportedAt: new Date().toISOString(), ...data, turnId,
      summary: { totals: measured.length ? totals : null, turnCount: data.turns.length, measuredTurnCount: measured.length,
        missingUsageTurns: data.turns.length - measured.length, runningTurns: data.turns.filter(turn => turn.status === 'running').length } };
  }
  return { list, report, answer, snapshot };
}

module.exports = { parseTranscript, createStore, normalizeUsage };
