'use strict';

// Общая библиотека адаптера OpenCode. Портирована из adapters/cursor 0.2.1
// с заменой идентификаторов: sessionID + messageID вместо conversation_id + generation_id,
// и путей: ~/.opencode/token-lens/ вместо ~/.cursor/token-lens/.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DATA_DIR = process.env.TOKEN_LENS_DATA_DIR || path.join(os.homedir(), '.opencode', 'token-lens');
const LATEST_JSON = path.join(DATA_DIR, 'latest.json');
const LATEST_MD = path.join(DATA_DIR, 'latest.md');
const LOG_PATH = path.join(DATA_DIR, 'usage.jsonl');
const ACTIVE_PATH = path.join(DATA_DIR, 'active.json');
const INDEX_PATH = path.join(DATA_DIR, 'index.json');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// Оценка «потребителей»: UTF-8 байт / 3 по аргументам и результатам инструментов.
// Это приближение, не биллинг.
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

// Windows не умеет rename поверх существующего файла (EPERM) — заменяем явно.
function writeJson(file, value) {
  ensureDir();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify(value, null, 2);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, body);
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

function safeSessionId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(id)) return null;
  return id;
}

function sessionDir(sessionId) {
  const id = safeSessionId(sessionId);
  if (!id) return null;
  return path.join(SESSIONS_DIR, id);
}

function pendingPath(sessionId) {
  const dir = sessionDir(sessionId);
  return dir ? path.join(dir, 'pending.json') : null;
}

function promptPath(sessionId) {
  const dir = sessionDir(sessionId);
  return dir ? path.join(dir, 'prompt.json') : null;
}

function setActive(sessionId, messageId) {
  writeJson(ACTIVE_PATH, {
    session_id: sessionId || null,
    prompt_message_id: messageId || null,
    at: new Date().toISOString(),
  });
}

function emptyPending(sessionId) {
  return {
    session_id: sessionId || null,
    prompt_message_id: null,
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

function readSessionPending(sessionId) {
  const file = pendingPath(sessionId);
  if (!file) return emptyPending(sessionId);
  return readJson(file, null) || emptyPending(sessionId);
}

function writeSessionPending(sessionId, pending) {
  const file = pendingPath(sessionId);
  if (!file) return;
  writeJson(file, pending);
}

function readSessionPrompt(sessionId) {
  const file = promptPath(sessionId);
  if (!file) return { prompt_preview: null, prompt_length: 0, prompt_message_id: null, model: null };
  const saved = readJson(file, null);
  if (!saved) return { prompt_preview: null, prompt_length: 0, prompt_message_id: null, model: null };
  if (sessionId && saved.session_id && saved.session_id !== sessionId) {
    return { prompt_preview: null, prompt_length: 0, prompt_message_id: null, model: null };
  }
  return {
    prompt_preview: saved.prompt_preview || null,
    prompt_length: saved.prompt_length || 0,
    prompt_message_id: saved.prompt_message_id || null,
    model: saved.model || null,
    session_id: saved.session_id || sessionId || null,
    at: saved.at || null,
  };
}

function writeSessionPrompt(sessionId, record) {
  const file = promptPath(sessionId);
  if (!file) return;
  writeJson(file, record);
}

function clearSessionPending(sessionId) {
  writeSessionPending(sessionId, emptyPending(sessionId));
}

function promptPreview(value, limit = 200) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!text) return { preview: null, length: 0 };
  return {
    preview: text.length > limit ? `${text.slice(0, limit)}…` : text,
    length: text.length,
  };
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

function hasConsumers(report) {
  if (!report) return false;
  if (Array.isArray(report.consumers) && report.consumers.length) return true;
  if (report.consumers && typeof report.consumers === 'object' && !Array.isArray(report.consumers)) {
    return Object.keys(report.consumers).length > 0;
  }
  return false;
}

function sumMeasured(turns) {
  const out = {
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
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
  const tools = Array.isArray(next.tools) && next.tools.length ? next.tools : Array.isArray(prev.tools) ? prev.tools : [];
  return {
    ...prev,
    ...next,
    prompt_preview: next.prompt_preview || prev.prompt_preview || null,
    prompt_length: next.prompt_length || prev.prompt_length || 0,
    measured: next.measured || prev.measured || null,
    consumers,
    categories,
    tools,
    tool_count: Array.isArray(tools) ? tools.length : next.tool_count || prev.tool_count || 0,
  };
}

function chatPath(sessionId) {
  const id = safeSessionId(sessionId);
  if (!id) return null;
  return path.join(DATA_DIR, 'chats', `${id}.json`);
}

function loadChat(sessionId) {
  const file = chatPath(sessionId);
  if (!file) return null;
  return readJson(file, null);
}

function findTurn(sessionId, promptMessageId) {
  if (!promptMessageId) return null;
  const chat = loadChat(sessionId);
  if (!chat || !Array.isArray(chat.turns)) return null;
  const pid = String(promptMessageId);
  return chat.turns.find((row) => row && String(row.prompt_message_id || '') === pid) || null;
}

function saveTurn(report) {
  ensureDir();
  const id = safeSessionId(report.session_id);
  writeJson(ACTIVE_PATH, {
    session_id: id,
    prompt_message_id: report.prompt_message_id || null,
    at: report.at,
  });

  if (!id) return { isNew: true, turn_count: 0 };

  const file = chatPath(id);
  const chat = readJson(file, {
    session_id: id,
    created_at: report.at,
    updated_at: report.at,
    turns: [],
  });
  chat.updated_at = report.at;

  let isNew = true;
  const pid = report.prompt_message_id ? String(report.prompt_message_id) : null;
  if (pid) {
    const idx = chat.turns.findIndex((row) => row && String(row.prompt_message_id || '') === pid);
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
    session_id: id,
    updated_at: report.at,
    turn_count: chat.turns.length,
    last_total: report.measured?.total_tokens ?? null,
    chat_total: chat.totals.total_tokens,
  };
  writeJson(INDEX_PATH, [entry, ...index.filter((row) => row.session_id !== id)].slice(0, 50));
  return { isNew, turn_count: chat.turns.length };
}

function listChats() {
  return readJson(INDEX_PATH, []);
}

function safeAnswerKey(key) {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(key)) return null;
  return key;
}

const ANSWERS_DIR = path.join(DATA_DIR, 'answers');

function listAnswerReports(limit = 200) {
  ensureDir();
  if (!fs.existsSync(ANSWERS_DIR)) return [];
  const dir = ANSWERS_DIR;
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
        session_id: data.session_id || null,
        message_id: data.message_id || null,
        status: data.status || null,
        cost: data.cost ?? null,
        total_tokens: data.measured && data.measured.total_tokens != null ? data.measured.total_tokens : null,
        input_tokens: data.measured && data.measured.input_tokens != null ? data.measured.input_tokens : null,
        output_tokens: data.measured && data.measured.output_tokens != null ? data.measured.output_tokens : null,
        prompt_preview: data.prompt_preview || '',
      };
    })
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
    .slice(0, limit);
}

function removeTurnFromChat(sessionId, promptMessageId) {
  const id = safeSessionId(sessionId);
  if (!id || !promptMessageId) return;
  const file = chatPath(id);
  if (!file || !fs.existsSync(file)) return;
  const chat = readJson(file, null);
  if (!chat || !Array.isArray(chat.turns)) return;
  const pid = String(promptMessageId);
  const nextTurns = chat.turns.filter((row) => !row || String(row.prompt_message_id || '') !== pid);
  if (nextTurns.length === chat.turns.length) return;
  chat.turns = nextTurns;
  chat.updated_at = new Date().toISOString();
  chat.totals = sumMeasured(chat.turns);
  writeJson(file, chat);
  const index = readJson(INDEX_PATH, []);
  const entry = {
    session_id: id,
    updated_at: chat.updated_at,
    turn_count: chat.turns.length,
    last_total: chat.turns.length ? chat.turns[chat.turns.length - 1].measured?.total_tokens ?? null : null,
    chat_total: chat.totals.total_tokens,
  };
  writeJson(INDEX_PATH, [entry, ...index.filter((row) => row.session_id !== id)].slice(0, 50));
}

function deleteAnswerReports(keys) {
  ensureDir();
  const dir = ANSWERS_DIR;
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
    if (report) removeTurnFromChat(report.session_id, report.prompt_message_id || key);
    deleted.push(key);
  }

  const latest = readJson(LATEST_JSON, null);
  if (latest && latest.prompt_message_id && deleted.includes(answerKey(latest))) {
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
  if (active && active.prompt_message_id && deleted.includes(answerKey(active))) {
    writeJson(ACTIVE_PATH, {
      session_id: active.session_id || null,
      prompt_message_id: null,
      at: new Date().toISOString(),
    });
  }

  return { deleted, missing, errors };
}

// Стабильный ключ отчёта: sessionID + messageID (prompt-сообщение хода).
// Ссылка живёт с момента старта хода (live-страница) и дополняется счётчиками после завершения.
function answerKey(report) {
  const raw =
    (report && report.session_id && report.prompt_message_id
      ? `${report.session_id}_${report.prompt_message_id}`
      : '') ||
    (report && report.session_id ? `${report.session_id}-${Date.parse(report.at) || Date.now()}` : '') ||
    `turn-${Date.now()}`;
  return String(raw).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 200) || `turn-${Date.now()}`;
}

function normalizeAutoDeleteDays(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(3650, Math.floor(n));
}

// Как открывать ссылки отчётов по клику (desktop, GUI-часть):
// - panel: встроенный браузер приложения — вкладка в side-панели сессии (по умолчанию);
// - dialog: диалог с iframe внутри окна приложения;
// - external: системный браузер (как раньше).
const CLICK_BEHAVIORS = ['panel', 'dialog', 'external'];

function normalizeClickBehavior(value) {
  return CLICK_BEHAVIORS.includes(value) ? value : 'panel';
}

function asBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

// Опции «лимиты в хвосте ответа» в OpenCode нет: надёжного источника квот подписки нет,
// биллинг — по провайдерам. В отчёте показывается только cost хода.
function readSettings() {
  const raw = readJson(SETTINGS_PATH, {}) || {};
  return {
    autoDeleteDays: normalizeAutoDeleteDays(raw.autoDeleteDays),
    clickBehavior: normalizeClickBehavior(raw.clickBehavior),
    appendTokenSummary: asBool(raw.appendTokenSummary),
    appendContextHeat: asBool(raw.appendContextHeat),
    contextWindow: Number.isSafeInteger(raw.contextWindow) && raw.contextWindow > 0 ? raw.contextWindow : 200000,
    lastAutoPurgeAt: typeof raw.lastAutoPurgeAt === 'string' ? raw.lastAutoPurgeAt : null,
  };
}

function writeSettings(patch = {}) {
  if (patch.appendContextHeat !== undefined && typeof patch.appendContextHeat !== 'boolean') {
    throw new Error('appendContextHeat должен быть boolean.');
  }
  if (patch.contextWindow !== undefined && (!Number.isSafeInteger(patch.contextWindow) || patch.contextWindow <= 0)) {
    throw new Error('contextWindow должен быть положительным безопасным целым числом.');
  }
  if (patch.appendTokenSummary !== undefined && typeof patch.appendTokenSummary !== 'boolean') {
    throw new Error('appendTokenSummary должен быть boolean.');
  }
  const current = readSettings();
  const next = {
    autoDeleteDays: normalizeAutoDeleteDays(
      patch.autoDeleteDays !== undefined ? patch.autoDeleteDays : current.autoDeleteDays
    ),
    clickBehavior: normalizeClickBehavior(
      patch.clickBehavior !== undefined ? patch.clickBehavior : current.clickBehavior
    ),
    appendTokenSummary: patch.appendTokenSummary !== undefined ? patch.appendTokenSummary : current.appendTokenSummary,
    appendContextHeat: patch.appendContextHeat !== undefined ? patch.appendContextHeat : current.appendContextHeat,
    contextWindow: patch.contextWindow !== undefined ? patch.contextWindow : current.contextWindow,
    lastAutoPurgeAt:
      patch.lastAutoPurgeAt !== undefined ? patch.lastAutoPurgeAt : current.lastAutoPurgeAt,
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
    // Не чаще раза в час; принудительно — при сохранении настроек.
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

function renderMarkdown(report) {
  const m = report.measured;
  const lines = [
    '# Расход токенов',
    '',
    `Сессия: \`${report.session_id || '—'}\` · модель: \`${report.model || '—'}\` · статус: ${report.status || '—'}`,
    '',
    '## Фактически (assistant-сообщения OpenCode)',
    '',
  ];
  if (!m) {
    lines.push('_В assistant-сообщениях этого хода нет счётчиков tokens — расход недоступен._', '');
  } else {
    lines.push(
      `| | Токены |`,
      `|---|---:|`,
      `| **Вход** | ${formatNum(m.input_tokens)} |`,
      `| · cache read | ${formatNum(m.cache_read_tokens)} |`,
      `| · cache write | ${formatNum(m.cache_write_tokens)} |`,
      `| **Выход** | ${formatNum(m.output_tokens)} |`,
      `| · рассуждения | ${formatNum(m.reasoning_tokens)} |`,
      `| **Всего** | ${m.incomplete ? 'неполный' : formatNum(m.total_tokens)} |`,
      ''
    );
  }
  lines.push('## Потребители (оценка)', '');
  lines.push('_UTF-8 байт / 3 по аргументам и результатам инструментов за ход. Не биллинг._', '');
  const consumers = report.consumers || [];
  if (!consumers.length) {
    lines.push('_За ход не было tool results для оценки._', '');
  } else {
    lines.push('| Инструмент | ≈ токены результатов |', '|---|---:|');
    for (const row of consumers) lines.push(`| \`${row.name}\` | ${formatNum(row.tokens)} |`);
    lines.push('');
  }
  lines.push(`Сохранено: \`${LATEST_MD}\``);
  return lines.join('\n');
}

module.exports = {
  DATA_DIR,
  ANSWERS_DIR,
  LATEST_JSON,
  LATEST_MD,
  LOG_PATH,
  ACTIVE_PATH,
  INDEX_PATH,
  SETTINGS_PATH,
  SESSIONS_DIR,
  ensureDir,
  estimate,
  readJson,
  writeJson,
  appendJsonl,
  emptyPending,
  promptPreview,
  add,
  rank,
  hasConsumers,
  sumMeasured,
  mergeTurnReports,
  findTurn,
  saveTurn,
  listChats,
  loadChat,
  chatPath,
  safeSessionId,
  safeAnswerKey,
  sessionDir,
  pendingPath,
  promptPath,
  setActive,
  readSessionPending,
  writeSessionPending,
  readSessionPrompt,
  writeSessionPrompt,
  clearSessionPending,
  listAnswerReports,
  deleteAnswerReports,
  answerKey,
  readSettings,
  writeSettings,
  purgeOldAnswers,
  normalizeAutoDeleteDays,
  normalizeClickBehavior,
  renderMarkdown,
  formatNum,
  compactNum,
};
