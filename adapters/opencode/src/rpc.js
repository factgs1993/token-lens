// RPC-контракт Token Lens для OpenCode (Rpc.define из @opencode/plugin).
// Список отчётов / удаление / настройки / сервер — для TUI и GUI-клиентов.
// Экспортируется как "./rpc" из package.json; обработчики регистрируются в
// server-части плагина (src/index.js) через ctx.rpc.register.

import { Rpc } from "@opencode/plugin/rpc";

const reportSchema = {
  type: "object",
  properties: {
    key: { type: "string" },
    at: { type: "string" },
    session_id: { type: ["string", "null"] },
    message_id: { type: ["string", "null"] },
    status: { type: ["string", "null"] },
    cost: { type: ["number", "null"] },
    total_tokens: { type: ["integer", "null"] },
    input_tokens: { type: ["integer", "null"] },
    output_tokens: { type: ["integer", "null"] },
    prompt_preview: { type: ["string", "null"] },
  },
};

export const TokenLens = Rpc.define({
  id: "opencode-token-lens",
  methods: {
    // Список отчётов для All Reports + сессионный индекс + настройки.
    reports: {
      input: {
        type: "object",
        properties: {
          limit: { type: "number", minimum: 1, maximum: 500, default: 200 },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          answers: { type: "array", items: reportSchema },
          index: { type: "array", items: { type: "object" } },
          settings: { type: "object" },
        },
      },
    },
    // Мульти-удаление отчётов (как All Reports в UI).
    deleteReports: {
      input: {
        type: "object",
        properties: {
          keys: { type: "array", items: { type: "string" }, minItems: 1 },
        },
        required: ["keys"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          deleted: { type: "array", items: { type: "string" } },
          missing: { type: "array", items: { type: "string" } },
          errors: { type: "array", items: { type: "object" } },
        },
      },
    },
    // Чтение/запись настроек; запись запускает purge force.
    settings: {
      input: {
        type: "object",
        properties: {
          autoDeleteDays: { type: "number", minimum: 0, maximum: 3650 },
          clickBehavior: { type: "string", enum: ["panel", "dialog", "external"] },
          appendTokenSummary: { type: "boolean" },
          appendContextHeat: { type: "boolean" },
          contextWindow: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          settings: { type: "object" },
          purge: { type: ["object", "null"] },
        },
      },
    },
    // Статус/запуск локального сервера отчётов (127.0.0.1:3848).
    server: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          running: { type: "boolean" },
          baseUrl: { type: "string" },
          port: { type: "number" },
          pid: { type: ["integer", "null"] },
          hint: { type: ["string", "null"] },
        },
      },
    },
  },
  events: {},
});

export default TokenLens;
