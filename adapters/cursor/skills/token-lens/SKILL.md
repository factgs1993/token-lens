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

1. Run `node "%USERPROFILE%\.cursor\plugins\local\cursor-token-lens\scripts\answer-link.cjs"`.
2. Append stdout JSON field `markdown` unchanged as the last lines of the answer.
3. If MCP tool `token_usage_panel` is available, call it once in the same turn.

## Source of truth

- Measured totals: `~/.cursor/token-lens/latest.json` from `stop` hook.
- Consumers: pending tool I/O estimates (UTF-8/3), not billable.

## Do not

- Do not invent numbers.
- Do not reuse a previous answer's markdown.
- Do not start follow-up loops only to reprint usage.
