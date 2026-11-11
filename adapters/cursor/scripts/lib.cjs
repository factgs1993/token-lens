'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DATA_DIR = path.join(os.homedir(), '.cursor', 'token-lens');
const PENDING_PATH = path.join(DATA_DIR, 'pending.json');
const PROMPT_PATH = path.join(DATA_DIR, 'current-prompt.json');
const LATEST_JSON = path.join(DATA_DIR, 'latest.json');
const LATEST_MD = path.join(DATA_DIR, 'latest.md');
const LOG_PATH = path.join(DATA_DIR, 'usage.jsonl');
const ACTIVE_PATH = path.join(DATA_DIR, 'active.json');
const INDEX_PATH = path.join(DATA_DIR, 'index.json');
const STATUS_PATH = path.join(DATA_DIR, 'status.json');
const CHATS_DIR = path.join(DATA_DIR, 'chats');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(CHATS_DIR, { recursive: true });
}

function estimate(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function appendJsonl(file, value) {
  ensureDir();
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function num(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function formatNum(value) {
  if (!Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('ru-RU');
}

function compactNum(value) {
  if (!Number.isFinite(value)) return '—';
  const n = Math.round(value);
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

function safeChatId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return null;
  return id;
}

function chatPath(conversationId) {
  const id = safeChatId(conversationId);
  if (!id) return null;
  return path.join(CHATS_DIR, `${id}.json`);
}

function measuredFromPayload(payload) {
  const input = num(payload.input_tokens);
  const output = num(payload.output_tokens);
  if (input == null && output == null) return null;
  const cacheRead = num(payload.cache_read_tokens) ?? 0;
  const cacheWrite = num(payload.cache_write_tokens) ?? 0;
  const totalIn = input ?? 0;
  const uncached = Math.max(0, totalIn - cacheRead - cacheWrite);
  return {
    input_tokens: totalIn,
    output_tokens: output ?? 0,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    uncached_input_tokens: uncached,
    total_tokens: totalIn + (output ?? 0),
  };
}

function emptyPending(conversationId) {
  return {
    conversation_id: conversationId || null,
    started_at: new Date().toISOString(),
    prompt_preview: null,
    prompt_length: 0,
    consumers: {},
    categories: {
      tool_results: 0,
      tool_calls: 0,
    },
    tools: [],
  };
}

function promptPreview(value, limit = 200) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!text) return { preview: null, length: 0 };
  return {
    preview: text.length > limit ? `${text.slice(0, limit)}…` : text,
    length: text.length,
  };
}

function extractPromptText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const candidates = [
    payload.prompt,
    payload.content,
    payload.text,
    payload.message,
    payload.user_prompt,
    payload.input,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value;
    if (value && typeof value === 'object') {
      if (typeof value.text === 'string' && value.text.trim()) return value.text;
      if (typeof value.content === 'string' && value.content.trim()) return value.content;
      if (Array.isArray(value.content)) {
        const joined = value.content
          .map((part) => (typeof part === 'string' ? part : part && typeof part.text === 'string' ? part.text : ''))
          .filter(Boolean)
          .join('\n');
        if (joined.trim()) return joined;
      }
    }
  }
  if (Array.isArray(payload.messages)) {
    const lastUser = [...payload.messages].reverse().find((row) => row && (row.role === 'user' || row.type === 'user'));
    if (lastUser) {
      if (typeof lastUser.content === 'string') return lastUser.content;
      if (typeof lastUser.text === 'string') return lastUser.text;
    }
  }
  return '';
}

function add(map, key, value) {
  map[key] = (map[key] || 0) + value;
}

function rank(map, limit = 12) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, tokens]) => ({ name, tokens }));
}

function sumMeasured(turns) {
  const out = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    uncached_input_tokens: 0,
    total_tokens: 0,
  };
  for (const turn of turns) {
    const m = turn.measured;
    if (!m) continue;
    for (const key of Object.keys(out)) out[key] += m[key] || 0;
  }
  return out;
}

function saveTurn(report) {
  ensureDir();
  const id = safeChatId(report.conversation_id);
  writeJson(ACTIVE_PATH, {
    conversation_id: id,
    at: report.at,
  });

  const status = {
    at: report.at,
    conversation_id: id,
    model: report.model || null,
    measured: report.measured,
    text: report.measured
      ? `↓${compactNum(report.measured.input_tokens)} ↑${compactNum(report.measured.output_tokens)}`
      : 'Token Lens',
    detail: report.measured
      ? `in ${formatNum(report.measured.input_tokens)} · out ${formatNum(report.measured.output_tokens)} · total ${formatNum(report.measured.total_tokens)}`
      : 'Нет measured totals в последнем stop',
  };
  writeJson(STATUS_PATH, status);

  if (!id) return;
  const file = chatPath(id);
  const chat = readJson(file, {
    conversation_id: id,
    created_at: report.at,
    updated_at: report.at,
    turns: [],
  });
  chat.updated_at = report.at;
  chat.turns.push(report);
  if (chat.turns.length > 200) chat.turns = chat.turns.slice(-200);
  chat.totals = sumMeasured(chat.turns);
  writeJson(file, chat);

  const index = readJson(INDEX_PATH, []);
  const entry = {
    conversation_id: id,
    updated_at: report.at,
    turn_count: chat.turns.length,
    last_total: report.measured?.total_tokens ?? null,
    last_input: report.measured?.input_tokens ?? null,
    last_output: report.measured?.output_tokens ?? null,
    chat_total: chat.totals.total_tokens,
  };
  const next = [entry, ...index.filter((row) => row.conversation_id !== id)].slice(0, 50);
  writeJson(INDEX_PATH, next);
}

function listChats() {
  return readJson(INDEX_PATH, []);
}

function loadChat(conversationId) {
  const file = chatPath(conversationId);
  if (!file) return null;
  return readJson(file, null);
}

function renderMarkdown(report) {
  const m = report.measured;
  const lines = [
    '# Расход токенов',
    '',
    `Чат: \`${report.conversation_id || '—'}\` · модель: \`${report.model || '—'}\` · статус: ${report.status || '—'}`,
    '',
    '## Фактически (API / stop)',
    '',
  ];
  if (!m) {
    lines.push('_В payload `stop` не было полей токенов._', '');
  } else {
    lines.push(
      `| | Токены |`,
      `|---|---:|`,
      `| **Вход** | ${formatNum(m.input_tokens)} |`,
      `| · без кэша | ${formatNum(m.uncached_input_tokens)} |`,
      `| · cache read | ${formatNum(m.cache_read_tokens)} |`,
      `| · cache write | ${formatNum(m.cache_write_tokens)} |`,
      `| **Выход** | ${formatNum(m.output_tokens)} |`,
      `| **Всего** | ${formatNum(m.total_tokens)} |`,
      ''
    );
  }
  lines.push('## Потребители (оценка входа)', '');
  lines.push('_UTF-8 байт / 3 по аргументам и результатам инструментов за ход. Не биллинг._', '');
  const consumers = report.consumers || [];
  if (!consumers.length) {
    lines.push('_За ход не было tool results для оценки._', '');
  } else {
    lines.push('| Инструмент | ≈ токены результатов |', '|---|---:|');
    for (const row of consumers) lines.push(`| \`${row.name}\` | ${formatNum(row.tokens)} |`);
    lines.push('');
  }
  const cats = report.categories || {};
  lines.push('## Категории (оценка)', '');
  lines.push(
    `| Категория | ≈ токены |`,
    `|---|---:|`,
    `| Результаты инструментов | ${formatNum(cats.tool_results || 0)} |`,
    `| Вызовы инструментов | ${formatNum(cats.tool_calls || 0)} |`,
    ''
  );
  lines.push(`Сохранено: \`${LATEST_MD}\``);
  return lines.join('\n');
}

module.exports = {
  DATA_DIR,
  PENDING_PATH,
  PROMPT_PATH,
  LATEST_JSON,
  LATEST_MD,
  LOG_PATH,
  ACTIVE_PATH,
  INDEX_PATH,
  STATUS_PATH,
  CHATS_DIR,
  ensureDir,
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
  listChats,
  loadChat,
  renderMarkdown,
  formatNum,
  compactNum,
  safeChatId,
};
