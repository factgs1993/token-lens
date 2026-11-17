// Server-часть плагина OpenCode (plugin API V2, @opencode/plugin 2.2.6).
// Портировано из adapters/cursor 0.2.1 (hook.cjs flow) на нативные хуки:
// - ctx.session.hook("prompt") — начало хода: prompt.json + pending + live-страница;
// - ctx.tool.hook("execute.after") — потребители (UTF-8 байт / 3);
// - ctx.event.subscribe(session.execution.*) — финализация хода: measured, saveTurn, отчёт;
// - ctx.tool.transform — инструменты token_usage_panel / read_token_usage;
// - ctx.rpc.register — RPC-контракт "./rpc" для TUI/GUI;
// - ctx.skill.transform — скилл token-lens (SKILL.md).

import { Plugin } from "@opencode/plugin";
import { TokenLens } from "./rpc.js";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const lib = require('./lib.cjs');
const usage = require('./usage.cjs');
const { writeAnswerPage } = require('./answer-page.cjs');
const serve = require('./serve.cjs');
const { makeToolDefs } = require('./tools.cjs');

function extractPromptText(prompt) {
  if (typeof prompt === 'string') return prompt;
  if (prompt && typeof prompt.text === 'string') return prompt.text;
  return '';
}

// Начало хода: сохранить prompt.json, создать pending и live-страницу отчёта.
// Hook "prompt" не срабатывает для compaction/shell/synthetic — они не попадают в ход.
async function onPrompt(event) {
  const sessionID = event?.sessionID;
  const messageID = event?.messageID;
  if (!sessionID || !messageID) return;
  const preview = lib.promptPreview(extractPromptText(event?.prompt));
  lib.writeSessionPrompt(sessionID, {
    session_id: sessionID,
    prompt_message_id: messageID,
    prompt_preview: preview.preview,
    prompt_length: preview.length,
    at: new Date().toISOString(),
  });
  const pending = lib.emptyPending(sessionID);
  pending.prompt_message_id = messageID;
  pending.prompt_preview = preview.preview;
  pending.prompt_length = preview.length;
  lib.writeSessionPending(sessionID, pending);
  lib.setActive(sessionID, messageID);
  try {
    // writeAnswerPage сам поднимает сервер (ensureServerSync) — двойной вызов не нужен.
    if (usage.hasActivity(pending)) {
      writeAnswerPage(usage.liveReportFromPending(pending));
    }
  } catch {
    /* non-fatal */
  }
}

// Потребители хода: оценка UTF-8 байт / 3 по аргументам и результатам инструментов.
async function onToolAfter(event) {
  const sessionID = event?.sessionID;
  if (!sessionID) return;
  const pending = lib.readSessionPending(sessionID);
  if (!pending.prompt_message_id) return;
  usage.addToolUsage(pending, {
    tool: event?.tool,
    input: event?.input,
    result: event?.status === 'completed' ? event?.result : event?.error,
    at: new Date().toISOString(),
  });
  lib.writeSessionPending(sessionID, pending);
}

// Финализация хода после session.execution.{succeeded,failed,interrupted}.
// Дедуп: повторное событие / повторный вызов не задваивает токены (ключ сессия+ход+статус).
async function finalizeTurn(ctx, sessionID, outcome, state) {
  if (!sessionID) return;
  if (state.busy.has(sessionID)) return;
  state.busy.add(sessionID);
  try {
    const pending = lib.readSessionPending(sessionID);
    let messages = [];
    try {
      messages = usage.messagesOf(await ctx.session.context({ sessionID }));
    } catch {
      messages = [];
    }
    const report = usage.turnFromMessages(messages, pending, { outcome, at: new Date().toISOString() });
    if (!report || !report.prompt_message_id) return;
    if (report.steps === 0 && !usage.hasActivity(pending)) return;

    const dedupe = `${sessionID}:${report.prompt_message_id}:${report.status}`;
    if (state.done.has(dedupe)) return;
    state.done.add(dedupe);
    if (state.done.size > 400) {
      for (const key of state.done) {
        state.done.delete(key);
        break;
      }
    }

    const saved = lib.saveTurn(report);
    const merged = lib.findTurn(sessionID, report.prompt_message_id) || report;
    lib.writeJson(lib.LATEST_JSON, merged);
    fs.writeFileSync(lib.LATEST_MD, lib.renderMarkdown(merged));
    if (saved.isNew) lib.appendJsonl(lib.LOG_PATH, merged);
    writeAnswerPage(merged);
    lib.clearSessionPending(sessionID);
    try {
      lib.purgeOldAnswers();
    } catch {
      /* non-fatal */
    }
  } finally {
    state.busy.delete(sessionID);
  }
}

const handlers = {
  async reports(input) {
    const limit = input?.limit;
    return {
      answers: lib.listAnswerReports(Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(500, Math.floor(Number(limit))) : 200),
      index: lib.listChats(),
      settings: lib.readSettings(),
    };
  },
  async deleteReports(input) {
    return lib.deleteAnswerReports(input?.keys || []);
  },
  async settings(input) {
    if (input && ['autoDeleteDays', 'clickBehavior', 'appendTokenSummary', 'appendContextHeat', 'contextWindow'].some(key => input[key] !== undefined)) {
      lib.writeSettings(input);
      const purge = lib.purgeOldAnswers({ force: true });
      return { settings: lib.readSettings(), purge };
    }
    return { settings: lib.readSettings(), purge: null };
  },
  async server() {
    const ensured = await serve.ensureServer();
    const current = await serve.status();
    return {
      ok: Boolean(ensured.ok || current.running),
      running: Boolean(current.running),
      baseUrl: current.baseUrl || ensured.baseUrl || serve.baseUrl(),
      port: serve.PORT,
      pid: current.pid ?? ensured.pid ?? null,
      hint: current.hint || ensured.error || null,
    };
  },
};

export default Plugin.define({
  id: "opencode-token-lens",
  async setup(ctx) {
    const state = { busy: new Set(), done: new Set() };

    // Инструменты: token_usage_panel и read_token_usage.
    try {
      await ctx.tool.transform((editor) => {
        for (const tool of makeToolDefs(ctx)) {
          editor.add(tool);
        }
      });
    } catch {
      /* non-fatal */
    }

    // Скилл token-lens: инструкция по отчётам, путь — bundled SKILL.md.
    try {
      await ctx.skill.transform((editor) => {
        const skillPath = path.resolve(here, '..', 'skills', 'token-lens', 'SKILL.md');
        let content = '';
        try {
          content = fs.readFileSync(skillPath, 'utf8');
        } catch {
          content = '';
        }
        if (content && !editor.get('token-lens')) {
          editor.add({
            id: 'token-lens',
            name: 'token-lens',
            description:
              'Локальная аналитика токенов: HTML-отчёты на http://127.0.0.1:3848, All Reports и Settings. Используй, когда пользователя спрашивают про расход токенов, cost или потребителей контекста.',
            autoinvoke: false,
            path: skillPath,
            content,
          });
        }
      });
    } catch {
      /* non-fatal */
    }

    // Начало хода.
    try {
      await ctx.session.hook('prompt', onPrompt);
    } catch {
      /* non-fatal */
    }

    // Потребители за ход.
    try {
      await ctx.tool.hook('execute.after', onToolAfter);
    } catch {
      /* non-fatal */
    }

    // RPC-контракт для TUI/GUI.
    try {
      await ctx.rpc.register(TokenLens, handlers);
    } catch {
      /* non-fatal */
    }

    // Финализация хода.
    const controller = new AbortController();
    (async () => {
      for await (const event of ctx.event.subscribe({
        types: ['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'],
        signal: controller.signal,
      })) {
        const sessionID = event?.data?.sessionID || event?.data?.session?.id || null;
        const outcome =
          event?.type === 'session.execution.succeeded'
            ? 'succeeded'
            : event?.type === 'session.execution.failed'
              ? 'failed'
              : event?.type === 'session.execution.interrupted'
                ? 'interrupted'
                : null;
        if (!sessionID || !outcome) continue;
        try {
          await finalizeTurn(ctx, sessionID, outcome, state);
        } catch {
          /* non-fatal */
        }
      }
    })().catch(() => {});

    return () => controller.abort();
  },
});
