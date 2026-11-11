---
name: token-lens
description: >-
  Показывает расход токенов Cursor Agent после ответа: фактический вход/выход
  и оценку потребителей. В конце ответа добавляет «📊 Аналитика запроса/ответа».
  Use when the user asks about token usage, spend, consumers, input/output tokens,
  «расход токенов», «на что ушли токены».
---

# Token Lens (как Codex)

## В конце каждого финального ответа

Команды ниже рассчитаны на Windows PowerShell.

1. Узнай `conversation_id` текущего чата; без него не вызывай помощник, чтобы не взять другой чат из `active.json`.
2. Run `node "$env:USERPROFILE\.cursor\plugins\local\cursor-token-lens\scripts\answer-link.cjs" "<conversation_id>"`. Если известен `generation_id` текущего хода, передай его вторым аргументом. Не выдумывай ID.
3. Append the complete stdout JSON field `markdown` unchanged as the last lines of the answer, including subscription limits when enabled.
4. Do not start follow-ups only to reprint usage.
5. If MCP tool `token_usage_panel` is available and the user asked for the panel, call it once in the same turn.

## Source of truth

- Отчёт конкретного хода: `~/.cursor/token-lens/answers/<generation_id>.json`; история чата — `chats/<conversation_id>.json`. Помощник выбирает отчёт по переданным ID.
- Measured totals — поля Cursor `stop`; дельты запросов — из `afterAgentResponse`, когда Cursor передал счётчики. `latest.json` — общий последний отчёт всех чатов, его нельзя считать отчётом текущего чата без проверки ID.
- Consumers: pending tool I/O estimates (UTF-8/3), not billable.

## Do not

- Do not invent numbers.
- Do not reuse a previous answer's markdown.
- Do not start follow-up loops only to reprint usage.
