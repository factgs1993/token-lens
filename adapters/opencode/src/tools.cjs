'use strict';

// Инструменты плагина (контракт MCP-адаптера Cursor 0.2.1 «по смыслу»):
// - token_usage_panel — markdown-ссылка «📊 Аналитика запроса/ответа» на отчёт текущего/последнего хода;
// - read_token_usage  — те же данные в JSON, без выдуманных чисел.
// В OpenCode вместо внешнего MCP-сервера инструменты регистрируются через ctx.tool.transform.

const path = require('node:path');
const lib = require('./lib.cjs');
const usage = require('./usage.cjs');
const { writeAnswerPage, answerKey } = require('./answer-page.cjs');
const { ensureServerSync } = require('./serve.cjs');

// ctx.session.context() возвращает Promise — без await получим пустую историю
// и отчёт без measured (fallback на live-страницу с нулями).
async function currentReport(ctx, sessionID) {
  const pending = lib.readSessionPending(sessionID);
  let messages = [];
  try {
    messages = usage.messagesOf(await ctx.session.context({ sessionID }));
  } catch {
    messages = [];
  }
  const turn = usage.turnFromMessages(messages, pending, { outcome: null });
  if (turn && turn.session_id) return turn;
  // Fallback: live-страница из pending, даже если историю прочитать не удалось.
  if (usage.hasActivity(pending)) return usage.liveReportFromPending({ ...pending, session_id: sessionID });
  return null;
}

function lastCompletedReport(sessionID) {
  const chat = lib.loadChat(sessionID);
  const turns = chat && Array.isArray(chat.turns) ? chat.turns : [];
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i] && turns[i].status && turns[i].status !== 'live') return turns[i];
  }
  return null;
}

function emitPage(report, { live = false } = {}) {
  const page = writeAnswerPage(report);
  const payload = {
    session_id: report.session_id || null,
    markdown: page.markdown,
    label: '📊 Аналитика запроса/ответа',
    url: page.url,
    key: page.key,
    message_id: report.message_id || null,
    measured: report.measured || null,
    cost: report.cost ?? null,
    consumers: report.consumers || [],
    live: live && !report.measured,
  };
  if (payload.live) {
    payload.note = 'Постоянный URL хода; после завершения тот же отчёт дополнится счётчиками';
  }
  lib.writeJson(path.join(lib.DATA_DIR, 'last-answer-link.json'), payload);
  return payload;
}

async function lookup(ctx, input, context) {
  const sessionID = (input && input.sessionID) || (context && context.sessionID) || null;
  if (!sessionID) throw new Error('Нет sessionID текущей сессии.');
  ensureServerSync();

  // 1. Завершённый отчёт текущего хода, если финализация уже прошла.
  const pending = lib.readSessionPending(sessionID);
  if (pending && pending.prompt_message_id) {
    const key = answerKey({ session_id: sessionID, prompt_message_id: pending.prompt_message_id });
    const saved = lib.readJson(path.join(lib.ANSWERS_DIR, `${key}.json`), null);
    if (saved && saved.measured && saved.outcome && saved.status && saved.status !== 'live') {
      return emitPage(saved, { live: false });
    }
    // 2. Текущий ход — live-страница (URL станет отчётом после завершения).
    const turn = await currentReport(ctx, sessionID);
    if (turn) return emitPage(turn, { live: turn.status === 'live' });
  }

  // 3. Последний завершённый ход этой сессии.
  const last = lastCompletedReport(sessionID);
  if (last) return emitPage(last, { live: false });

  throw new Error('Для этой сессии пока нет хода с инструментами или ответом.');
}

function makeToolDefs(ctx) {
  const inputSchema = {
    type: 'object',
    properties: {
      sessionID: { type: 'string', description: 'ID сессии OpenCode; по умолчанию — текущая сессия' },
    },
    additionalProperties: false,
  };

  return [
    {
      name: 'token_usage_panel',
      description:
        'Показать локальную аналитику токенов текущего/последнего ответа OpenCode: фактический вход/выход/кэш, cost и оценка потребителей. Добавь весь markdown без изменений в конце ответа: ссылку, сводку токенов и индикатор контекста, если они включены в Settings. Без сети.',
      input: inputSchema,
      execute: async (input, context) => {
        const payload = await lookup(ctx, input, context);
        return {
          content: payload.markdown,
          structuredContent: payload,
        };
      },
    },
    {
      name: 'read_token_usage',
      description:
        'Прочитать локальные агрегаты Token Lens текущего/последнего ответа OpenCode (measured tokens, cost, потребители) без сырых промптов.',
      input: inputSchema,
      execute: async (input, context) => {
        const sessionID = (input && input.sessionID) || (context && context.sessionID) || null;
        if (!sessionID) throw new Error('Нет sessionID текущей сессии.');
        ensureServerSync();
        const pending = lib.readSessionPending(sessionID);
        // Сохранённая страница текущего хода может быть live (measured ещё нет) —
        // в этом случае пересобираем отчёт из контекста, а не отдаём пустые счётчики.
        const saved =
          pending && pending.prompt_message_id
            ? lib.readJson(
                path.join(
                  lib.ANSWERS_DIR,
                  `${answerKey({ session_id: sessionID, prompt_message_id: pending.prompt_message_id })}.json`
                ),
                null
              )
            : null;
        const report =
          (saved && saved.measured && saved.outcome ? saved : null) ||
          (await currentReport(ctx, sessionID)) ||
          (saved || null) ||
          lastCompletedReport(sessionID);
        if (!report) throw new Error('Для этой сессии пока нет хода с инструментами или ответом.');
        const page = writeAnswerPage(report);
        const data = { ...report, url: page.url, markdown: page.markdown };
        return {
          content: JSON.stringify(data),
          structuredContent: data,
        };
      },
    },
  ];
}

module.exports = { makeToolDefs, currentReport, lastCompletedReport, lookup, emitPage };
