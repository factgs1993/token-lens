'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DATA_DIR = path.join(os.homedir(), '.cursor', 'token-lens');
const PENDING_PATH = path.join(DATA_DIR, 'pending.json'); // legacy mirror of active chat
const PROMPT_PATH = path.join(DATA_DIR, 'current-prompt.json'); // legacy mirror
const LATEST_JSON = path.join(DATA_DIR, 'latest.json');
const LATEST_MD = path.join(DATA_DIR, 'latest.md');
const LOG_PATH = path.join(DATA_DIR, 'usage.jsonl');
const ACTIVE_PATH = path.join(DATA_DIR, 'active.json');
const INDEX_PATH = path.join(DATA_DIR, 'index.json');
const STATUS_PATH = path.join(DATA_DIR, 'status.json');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const CHATS_DIR = path.join(DATA_DIR, 'chats');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(CHATS_DIR, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify(value, null, 2);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, body);
  // Windows cannot rename over an existing file (EPERM); replace explicitly.
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.copyFileSync(tmp, file);
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
    if (!fs.existsSync(file)) throw error;
  }
}

function appendJsonl(file, value) {
  ensureDir();
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function num(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function formatNum(value) {
  if (!Number.isFinite(value)) return 'нет данных';
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

function sessionDir(conversationId) {
  const id = safeChatId(conversationId);
  if (!id) return null;
  return path.join(SESSIONS_DIR, id);
}

function pendingPath(conversationId) {
  const dir = sessionDir(conversationId);
  return dir ? path.join(dir, 'pending.json') : PENDING_PATH;
}

function promptPath(conversationId) {
  const dir = sessionDir(conversationId);
  return dir ? path.join(dir, 'prompt.json') : PROMPT_PATH;
}

function setActive(conversationId, generationId) {
  writeJson(ACTIVE_PATH, {
    conversation_id: conversationId || null,
    generation_id: generationId || null,
    at: new Date().toISOString(),
  });
}

function readSessionPending(conversationId) {
  const file = pendingPath(conversationId);
  let pending = readJson(file, null);
  if (!pending && conversationId) {
    // Migrate once from legacy global pending if it matches this chat.
    const legacy = readJson(PENDING_PATH, null);
    if (legacy && legacy.conversation_id === conversationId) pending = legacy;
  }
  return pending || emptyPending(conversationId);
}

function writeSessionPending(conversationId, pending) {
  writeJson(pendingPath(conversationId), pending);
  // Mirror active chat for older readers / /latest fallback.
  const active = readJson(ACTIVE_PATH, {});
  if (!conversationId || active.conversation_id === conversationId || !active.conversation_id) {
    writeJson(PENDING_PATH, pending);
  }
}

function readSessionPrompt(conversationId) {
  const file = promptPath(conversationId);
  let saved = readJson(file, null);
  if (!saved && conversationId) {
    const legacy = readJson(PROMPT_PATH, null);
    if (legacy && (!legacy.conversation_id || legacy.conversation_id === conversationId)) saved = legacy;
  }
  if (!saved) return { prompt_preview: null, prompt_length: 0, generation_id: null, model: null };
  if (conversationId && saved.conversation_id && saved.conversation_id !== conversationId) {
    return { prompt_preview: null, prompt_length: 0, generation_id: null, model: null };
  }
  return {
    prompt_preview: saved.prompt_preview || null,
    prompt_length: saved.prompt_length || 0,
    generation_id: saved.generation_id || null,
    model: saved.model || null,
    conversation_id: saved.conversation_id || conversationId || null,
    at: saved.at || null,
    payload_keys: saved.payload_keys || [],
  };
}

function writeSessionPrompt(conversationId, record) {
  writeJson(promptPath(conversationId), record);
  const active = readJson(ACTIVE_PATH, {});
  if (!conversationId || active.conversation_id === conversationId || !active.conversation_id) {
    writeJson(PROMPT_PATH, record);
  }
}

function clearSessionPending(conversationId) {
  writeSessionPending(conversationId, emptyPending(conversationId));
}

function measuredFromPayload(payload) {
  const input = num(payload.input_tokens);
  const output = num(payload.output_tokens);
  if (input == null && output == null) return null;

  const cacheRead = num(payload.cache_read_tokens);
  const cacheWrite = num(payload.cache_write_tokens);
  const incomplete = input == null || output == null;
  const uncached =
    input == null
      ? null
      : Math.max(0, input - (cacheRead ?? 0) - (cacheWrite ?? 0));

  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    uncached_input_tokens: uncached,
    total_tokens: input != null && output != null ? input + output : null,
    incomplete,
  };
}

function emptyPending(conversationId) {
  return {
    conversation_id: conversationId || null,
    generation_id: null,
    model: null,
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

function liveReportFromPending(pending, extras = {}) {
  const row = pending && typeof pending === 'object' ? pending : {};
  return {
    at: new Date().toISOString(),
    conversation_id: row.conversation_id || null,
    generation_id: row.generation_id || extras.generation_id || null,
    model: row.model || extras.model || null,
    status: extras.status || 'in_progress',
    prompt_preview: row.prompt_preview || null,
    prompt_length: row.prompt_length || 0,
    measured: extras.measured || null,
    categories: row.categories || {},
    consumers: Array.isArray(extras.consumers)
      ? extras.consumers
      : rank(row.consumers || {}),
    tool_count: Array.isArray(row.tools) ? row.tools.length : 0,
    estimate_method: 'UTF-8 bytes / 3 for tool args/results; measured totals from stop payload',
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
  return Object.entries(map || {})
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
    for (const key of Object.keys(out)) {
      if (Number.isFinite(m[key])) out[key] += m[key];
    }
  }
  return out;
}

function hasConsumers(report) {
  if (!report) return false;
  if (Array.isArray(report.consumers) && report.consumers.length) return true;
  if (report.consumers && typeof report.consumers === 'object' && !Array.isArray(report.consumers)) {
    return Object.keys(report.consumers).length > 0;
  }
  return false;
}

function mergeTurnReports(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  const prevCats = prev.categories || {};
  const nextCats = next.categories || {};
  const categories = {
    tool_results: Math.max(Number(nextCats.tool_results) || 0, Number(prevCats.tool_results) || 0),
    tool_calls: Math.max(Number(nextCats.tool_calls) || 0, Number(prevCats.tool_calls) || 0),
  };
  const consumers = hasConsumers(next) ? next.consumers : prev.consumers || [];
  const tools =
    Array.isArray(next.tools) && next.tools.length
      ? next.tools
      : Array.isArray(prev.tools)
        ? prev.tools
        : [];
  return {
    ...prev,
    ...next,
    prompt_preview: next.prompt_preview || prev.prompt_preview || null,
    prompt_length: next.prompt_length || prev.prompt_length || 0,
    measured: next.measured || prev.measured || null,
    plan_usage: next.plan_usage || prev.plan_usage || null,
    consumers,
    categories,
    tools,
    tool_count: Array.isArray(tools) ? tools.length : next.tool_count || prev.tool_count || 0,
  };
}

function findTurn(conversationId, generationId) {
  if (!generationId) return null;
  const chat = loadChat(conversationId);
  if (!chat || !Array.isArray(chat.turns)) return null;
  const gid = String(generationId);
  return chat.turns.find((row) => row && String(row.generation_id || '') === gid) || null;
}

function saveTurn(report) {
  ensureDir();
  const id = safeChatId(report.conversation_id);
  writeJson(ACTIVE_PATH, {
    conversation_id: id,
    generation_id: report.generation_id || null,
    at: report.at,
  });

  const m = report.measured;
  const status = {
    at: report.at,
    conversation_id: id,
    model: report.model || null,
    measured: m,
    text: m
      ? `↓${compactNum(m.input_tokens)} ↑${compactNum(m.output_tokens)}${m.incomplete ? ' ~' : ''}`
      : 'Token Lens',
    detail: m
      ? m.incomplete
        ? `неполный: in ${formatNum(m.input_tokens)} · out ${formatNum(m.output_tokens)}`
        : `in ${formatNum(m.input_tokens)} · out ${formatNum(m.output_tokens)} · total ${formatNum(m.total_tokens)}`
      : 'Нет measured totals в последнем stop',
  };
  writeJson(STATUS_PATH, status);

  if (!id) return { isNew: true, turn_count: 0 };

  const file = chatPath(id);
  const chat = readJson(file, {
    conversation_id: id,
    created_at: report.at,
    updated_at: report.at,
    turns: [],
  });
  chat.updated_at = report.at;

  let isNew = true;
  const gid = report.generation_id ? String(report.generation_id) : null;
  if (gid) {
    const idx = chat.turns.findIndex((row) => row && String(row.generation_id || '') === gid);
    if (idx >= 0) {
      chat.turns[idx] = mergeTurnReports(chat.turns[idx], report);
      isNew = false;
    } else {
      chat.turns.push(report);
    }
  } else {
    chat.turns.push(report);
  }

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
  return { isNew, turn_count: chat.turns.length };
}

function listChats() {
  return readJson(INDEX_PATH, []);
}

function loadChat(conversationId) {
  const file = chatPath(conversationId);
  if (!file) return null;
  return readJson(file, null);
}

function safeAnswerKey(key) {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(key)) return null;
  return key;
}

function listAnswerReports(limit = 200) {
  ensureDir();
  if (!fs.existsSync(path.join(DATA_DIR, 'answers'))) return [];
  const dir = path.join(DATA_DIR, 'answers');
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const key = name.slice(0, -5);
      const file = path.join(dir, name);
      const data = readJson(file, {}) || {};
      let mtime = null;
      try {
        mtime = fs.statSync(file).mtime.toISOString();
      } catch {
        mtime = null;
      }
      return {
        key,
        at: data.at || mtime,
        conversation_id: data.conversation_id || null,
        generation_id: data.generation_id || key,
        model: data.model || null,
        status: data.status || null,
        total_tokens: data.measured && data.measured.total_tokens != null ? data.measured.total_tokens : null,
        input_tokens: data.measured && data.measured.input_tokens != null ? data.measured.input_tokens : null,
        output_tokens: data.measured && data.measured.output_tokens != null ? data.measured.output_tokens : null,
        prompt_preview: data.prompt_preview || '',
      };
    })
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
    .slice(0, limit);
}

function removeTurnFromChat(conversationId, generationId) {
  const id = safeChatId(conversationId);
  if (!id || !generationId) return;
  const file = chatPath(id);
  if (!file || !fs.existsSync(file)) return;
  const chat = readJson(file, null);
  if (!chat || !Array.isArray(chat.turns)) return;
  const gid = String(generationId);
  const nextTurns = chat.turns.filter((row) => !row || String(row.generation_id || '') !== gid);
  if (nextTurns.length === chat.turns.length) return;
  chat.turns = nextTurns;
  chat.updated_at = new Date().toISOString();
  chat.totals = sumMeasured(chat.turns);
  writeJson(file, chat);
  const index = readJson(INDEX_PATH, []);
  const entry = {
    conversation_id: id,
    updated_at: chat.updated_at,
    turn_count: chat.turns.length,
    last_total: chat.turns.length ? chat.turns[chat.turns.length - 1].measured?.total_tokens ?? null : null,
    last_input: chat.turns.length ? chat.turns[chat.turns.length - 1].measured?.input_tokens ?? null : null,
    last_output: chat.turns.length ? chat.turns[chat.turns.length - 1].measured?.output_tokens ?? null : null,
    chat_total: chat.totals.total_tokens,
  };
  writeJson(INDEX_PATH, [entry, ...index.filter((row) => row.conversation_id !== id)].slice(0, 50));
}

function normalizeAutoDeleteDays(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(3650, Math.floor(n));
}

function asBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

function readSettings() {
  const raw = readJson(SETTINGS_PATH, {}) || {};
  return {
    autoDeleteDays: normalizeAutoDeleteDays(raw.autoDeleteDays),
    lastAutoPurgeAt: typeof raw.lastAutoPurgeAt === 'string' ? raw.lastAutoPurgeAt : null,
    appendPlanLimits: asBool(raw.appendPlanLimits, false),
  };
}

function writeSettings(patch = {}) {
  const current = readSettings();
  const next = {
    autoDeleteDays: normalizeAutoDeleteDays(
      patch.autoDeleteDays !== undefined ? patch.autoDeleteDays : current.autoDeleteDays
    ),
    lastAutoPurgeAt:
      patch.lastAutoPurgeAt !== undefined ? patch.lastAutoPurgeAt : current.lastAutoPurgeAt,
    appendPlanLimits:
      patch.appendPlanLimits !== undefined
        ? asBool(patch.appendPlanLimits, current.appendPlanLimits)
        : current.appendPlanLimits,
  };
  writeJson(SETTINGS_PATH, next);
  return next;
}

function purgeOldAnswers({ force = false } = {}) {
  const settings = readSettings();
  const days = settings.autoDeleteDays;
  if (!days) return { skipped: true, reason: 'off', deleted: [], days: 0 };

  if (!force && settings.lastAutoPurgeAt) {
    const last = Date.parse(settings.lastAutoPurgeAt);
    // shortcut: at most once per hour unless forced by settings save, upgrade if need exact daily cron
    if (Number.isFinite(last) && Date.now() - last < 60 * 60 * 1000) {
      return { skipped: true, reason: 'throttled', deleted: [], days };
    }
  }

  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const keys = listAnswerReports(10000)
    .filter((row) => {
      const t = Date.parse(row.at || '');
      return Number.isFinite(t) && t < cutoffMs;
    })
    .map((row) => row.key);

  const result = keys.length ? deleteAnswerReports(keys) : { deleted: [], missing: [], errors: [] };
  writeSettings({ lastAutoPurgeAt: new Date().toISOString() });
  return {
    skipped: false,
    reason: null,
    days,
    cutoff: new Date(cutoffMs).toISOString(),
    deleted: result.deleted || [],
    missing: result.missing || [],
    errors: result.errors || [],
  };
}

function deleteAnswerReports(keys) {
  ensureDir();
  const dir = path.join(DATA_DIR, 'answers');
  const deleted = [];
  const missing = [];
  const errors = [];
  const list = Array.isArray(keys) ? keys : [];
  for (const raw of list) {
    const key = safeAnswerKey(raw);
    if (!key) {
      errors.push({ key: raw, error: 'bad key' });
      continue;
    }
    const jsonPath = path.join(dir, `${key}.json`);
    const htmlPath = path.join(dir, `${key}.html`);
    const hadJson = fs.existsSync(jsonPath);
    const hadHtml = fs.existsSync(htmlPath);
    if (!hadJson && !hadHtml) {
      missing.push(key);
      continue;
    }
    let report = null;
    if (hadJson) {
      report = readJson(jsonPath, null);
      try {
        fs.unlinkSync(jsonPath);
      } catch (error) {
        errors.push({ key, error: String(error && error.message ? error.message : error) });
        continue;
      }
    }
    if (hadHtml) {
      try {
        fs.unlinkSync(htmlPath);
      } catch (error) {
        errors.push({ key, error: String(error && error.message ? error.message : error) });
      }
    }
    if (report) removeTurnFromChat(report.conversation_id, report.generation_id || key);
    deleted.push(key);
  }

  const latest = readJson(LATEST_JSON, null);
  if (latest && latest.generation_id && deleted.includes(String(latest.generation_id))) {
    const next = listAnswerReports(1)[0];
    if (next) {
      const nextReport = readJson(path.join(dir, `${next.key}.json`), null);
      if (nextReport) {
        writeJson(LATEST_JSON, nextReport);
        fs.writeFileSync(LATEST_MD, renderMarkdown(nextReport));
      }
    }
  }

  const active = readJson(ACTIVE_PATH, {});
  if (active && active.generation_id && deleted.includes(String(active.generation_id))) {
    writeJson(ACTIVE_PATH, {
      conversation_id: active.conversation_id || null,
      generation_id: null,
      at: new Date().toISOString(),
    });
  }

  return { deleted, missing, errors };
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
      `| **Всего** | ${m.incomplete ? 'неполный' : formatNum(m.total_tokens)} |`,
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
  SETTINGS_PATH,
  CHATS_DIR,
  SESSIONS_DIR,
  ensureDir,
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
  listChats,
  loadChat,
  safeAnswerKey,
  listAnswerReports,
  deleteAnswerReports,
  readSettings,
  writeSettings,
  purgeOldAnswers,
  normalizeAutoDeleteDays,
  renderMarkdown,
  formatNum,
  compactNum,
  safeChatId,
  sessionDir,
  pendingPath,
  promptPath,
  setActive,
  readSessionPending,
  writeSessionPending,
  readSessionPrompt,
  writeSessionPrompt,
  clearSessionPending,
};
