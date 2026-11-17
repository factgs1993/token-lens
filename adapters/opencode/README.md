# OpenCode Token Lens (opencode-token-lens)

Адаптер [Token Lens](../../README.md) для [OpenCode](https://opencode.ai): локальная
аналитика расхода токенов по каждому ходу — HTML-отчёт по ссылке «📊 Аналитика
запроса/ответа» в конце ответа, All Reports, Settings и инструменты-аналоги MCP.
Реализован на нативном plugin API V2 OpenCode (`@opencode/plugin`), без внешних
hook-скриптов и MCP-сервера. Необязательная сводка токенов содержит дату и время
получения счётчиков; индикатор контекста включается отдельно.

- **Версия:** 0.1.1 · **Node:** ≥ 22 · **Лицензия:** MIT
- **Сервер:** только `127.0.0.1:3848` (env `TOKEN_LENS_PORT`)
- **Данные:** `~/.opencode/token-lens/` (env `TOKEN_LENS_DATA_DIR`)

## Что делает

| Возможность | Как |
|---|---|
| Ссылка в конце ответа | правило в глобальном `AGENTS.md` (идемпотентная секция) + инструмент `token_usage_panel`; без synthetic-дописывания и follow-up-спама |
| HTML-отчёт хода | стабильный URL `http://127.0.0.1:3848/answers/<sessionID>_<promptMessageID>.html`; live-страница создаётся в начале хода и дополняется счётчиками после завершения |
| Measured | сумма по assistant-сообщениям хода (дедуп по messageID): вход, выход, рассуждения, cache read/write отдельно; `total = input + output + reasoning + cache.read + cache.write` (семантика `TokenUsage.total()`) |
| Cost | сумма cost шагов, если провайдер её вернул; иначе «недоступно» |
| Потребители | оценка UTF-8 байт / 3 по аргументам и результатам инструментов (hook `execute.after`) — отдельно от measured, не биллинг |
| All Reports | `http://127.0.0.1:3848/` — список, мульти-удаление, live-обновление |
| Settings | `http://127.0.0.1:3848/settings` — автоудаление отчётов старше N дней; открытие ссылки в desktop: панель (по умолчанию) / диалог / системный браузер |
| Инструменты | `token_usage_panel` (markdown-ссылка), `read_token_usage` (JSON) — те же данные, что в отчёте |
| Краткая сводка после ссылки | переключатель `appendTokenSummary` в Settings (по умолчанию off); дата и время снимка, вход/выход текущего хода на момент ссылки, без кэша и рассуждений; без полных счётчиков строка пропускается |
| Индикатор контекста | `appendContextHeat` в Settings (по умолчанию off); вход последнего измеренного запроса, включая кэш, / `contextWindow` (по умолчанию 200000); отдельная строка с эмодзи под ссылкой |
| TUI | команда `/token-lens` — открыть All Reports в браузере (toast с URL) |
| GUI (desktop) | `LinkHandler` перехватывает клик по ссылке отчёта в конце ответа и открывает её в приложении: панель (встроенный браузер, по умолчанию), диалог с iframe или системный браузер — как выбрано в Settings (`clickBehavior`); команды палитры «Token Lens: All Reports / Settings» и fallback «в браузере». GUI-часть загружается при старте desktop-приложения: после установки или обновления плагина нужен полный перезапуск OpenCode desktop |
| RPC | `opencode-token-lens/rpc` — методы `reports`, `deleteReports`, `settings`, `server` для TUI/GUI |

## Краткая сводка в ответе

Открой Settings из любого отчёта или командой **Token Lens: Settings** в палитре
OpenCode, включи **«Краткая сводка токенов после ссылки»** и нажми **Save**.
Настройка `appendTokenSummary` сохраняется в `~/.opencode/token-lens/settings.json`
и применяется со следующего вызова `token_usage_panel`, без перезапуска сервера.
По умолчанию сводка выключена.

Пример строк под ссылкой:

```text
📊 Аналитика запроса/ответа

Токены 17.11.2026 13:56: вход 1 200 · выход 340 (на момент ссылки)
```

Дата и время берутся из снимка отчёта (`report.at`) и выводятся в часовом поясе
компьютера, в формате `ДД.ММ.ГГГГ ЧЧ:ММ`. Повторное открытие сохранённого отчёта
не меняет эту отметку; новый снимок текущего хода получает новую дату. Если
дата отсутствует или повреждена, сводка остаётся без неё — время запуска
инструмента вместо неизвестной даты не подставляется.

Это сумма измеренных шагов текущего хода к моменту вызова инструмента. Вход не
включает кэш, выход не включает рассуждения — как в отчёте OpenCode. Финальный
текст ещё не сгенерирован, поэтому полный итог доступен по той же ссылке после
завершения ответа. Если нет полных счётчиков входа и выхода, остаётся только
ссылка. Модель должна переносить всё поле `markdown`, сохраняя все строки.
Лимиты подписки в OpenCode не показываются: надёжного источника квот у адаптера
нет. Дата относится к сводке токенов конкретного хода.

При обновлении ранее установленного плагина повтори
`node scripts/enable-default.cjs`, чтобы обновить это правило в глобальном
`AGENTS.md`, затем нажми **Reload** у плагина или перезапусти OpenCode.

## Индикатор контекста

В **Token Lens: Settings** включи **«Индикатор контекста после ссылки»**, укажи
**«Размер окна, токенов»** своей модели и нажми **Save**. По умолчанию индикатор
выключен (`appendContextHeat: false`), размер окна — 200000 (`contextWindow`).
Обе настройки применяются со следующей ссылки без перезапуска сервера.

| Заполнение окна | Строка под ссылкой |
|---|---|
| <40% | 🧊 Контекст: 28% · ок |
| 40–<70% | 🌤️ Контекст: 55% · ещё нормально |
| 70–<85% | 🔥 Контекст: 71% · скоро новый чат |
| ≥85% | 🌋 Контекст: 92% · лучше начать новый чат |

Это приблизительный сигнал: вход **последнего измеренного запроса модели**,
включая cache read/write, делится на заданное окно. Сумма за весь ход, выход и
рассуждения в расчёт не входят. При уменьшении входа после сжатия контекста
процент тоже уменьшается. Без подходящего измерения строка пропускается.
Переключатель работает независимо от сводки входа/выхода; если включены оба,
индикатор идёт после сводки. Весь `markdown` переносится в ответ одним блоком.

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `TOKEN_LENS_DATA_DIR` | `~/.opencode/token-lens` | Каталог данных отчётов |
| `TOKEN_LENS_PORT` | `3848` | Порт локального сервера (только `127.0.0.1`) |
| `TOKEN_LENS_NODE` | авто | Явный путь к Node для запуска сервера отчётов (нужен, если внутри рантайма OpenCode `process.execPath` — не node, а `node` не в PATH) |
| `OPENCODE_CONFIG_DIR` | `~/.config/opencode` | Куда `enable-default.cjs` пишет правило в `AGENTS.md` |

Компакция, генерация заголовка и transient `generate` не смешиваются с ходом:
hook `prompt` для них не срабатывает, а шаги хода — только assistant-сообщения
после prompt-сообщения. Subagent-сессии дают собственные отчёты.

## Установка

Требуется Node ≥ 22.

### 1. Скопировать плагин

Скопируй каталог `adapters/opencode` в папку плагинов OpenCode:

- глобально: `~/.config/opencode/plugins/opencode-token-lens/` (на Windows тоже `~/.config/opencode`);
- или в проект: `<project>/.opencode/plugins/opencode-token-lens/`.

Затем в скопированном каталоге:

```sh
npm ci --ignore-scripts
```

Папка плагина содержит `package.json` c `"type": "module"` — OpenCode
подхватывает `src/index.js` (server-часть), `src/tui.js` (TUI-команда)
и `src/gui.js` (desktop-команды, экспорт `./gui-experimental`).

### 2. Включить правило «ссылка в конце ответа» (по желанию)

```sh
node scripts/enable-default.cjs
```

Добавляет секцию между маркерами `opencode-token-lens:start/end` в
`~/.config/opencode/AGENTS.md` (env `OPENCODE_CONFIG_DIR`): модель вызывает
`token_usage_panel` в конце финального ответа и добавляет `markdown` из
результата целиком в самом конце ответа, включая сводку, если она включена в
Settings. Повторный запуск идемпотентен.

### 3. Перезапустить OpenCode

При следующем ходе: страница отчёта появится в начале хода, после завершения —
финальные счётчики и ссылка в конце ответа.

## Обновление

Обнови Git-копию (`git pull --ff-only` из корня репозитория) или скачай свежий
ZIP. Скопируй содержимое `adapters/opencode` поверх установленного плагина,
затем из его папки выполни:

```sh
npm ci --ignore-scripts
node src/serve.cjs --stop
node scripts/enable-default.cjs
```

Полностью перезапусти OpenCode, включая desktop-приложение, чтобы обновились
server-, TUI- и GUI-части. Сохраняются настройки и отчёты в
`~/.opencode/token-lens/`. Чтобы увидеть дату сводки в следующем ответе, включи
`appendTokenSummary` в Settings; по умолчанию он выключен.

В PowerShell при блокировке `npm.ps1` используй `npm.cmd` вместо `npm`.

## Проверка сценария

```sh
# статус/запуск/остановка сервера отчётов
node src/serve.cjs --status
node src/serve.cjs --start
node src/serve.cjs --stop

# перестроить страницу последнего хода сессии
node src/answer-page.cjs <sessionID> [promptMessageID]

# тесты
npm test
```

Сценарий в OpenCode: задай вопрос с инструментами → в конце финального ответа
должна появиться строка `[📊 Аналитика запроса/ответа](http://127.0.0.1:3848/answers/…html)`.
Отчёт содержит measured (вход/выход/кэш/рассуждения), cost, шаги модели и
оценку потребителей. Открой `http://127.0.0.1:3848/` (All Reports) и
`/settings`.

## Структура

```
src/
  index.js        server-часть: Plugin.define, хуки prompt / execute.after,
                  события session.execution.*, rpc.register, skill.transform
  rpc.js          Rpc.define — контракт "./rpc" (reports/deleteReports/settings/server)
  tui.js          TUI-часть: slash-команда /token-lens (открыть All Reports)
  gui.js          GUI-часть (desktop): палитра команд — All Reports/Settings в
                  диалоге с iframe к серверу отчётов, fallback в системный браузер
  lib.cjs         общая библиотека: каталоги данных, writeJson (Windows-safe),
                  sessions/chats/index/answers, settings, purge
  usage.cjs       семантика OpenCode: measuredFromTokenUsage, turnFromMessages
                  (дедуп по messageID), addToolUsage, liveReportFromPending
  tools.cjs       инструменты token_usage_panel / read_token_usage
  answer-page.cjs HTML-отчёт хода + writeAnswerPage
  serve.cjs       HTTP-сервер 127.0.0.1:3848: All Reports, Settings, /api/*
scripts/enable-default.cjs   правило в глобальном AGENTS.md
skills/token-lens/SKILL.md   скилл (регистрируется через ctx.skill.transform)
test/                        node --test
```

## Отличия от Cursor-адаптера

| | Cursor 0.3.1 | OpenCode 0.1.1 |
|---|---|---|
| Интеграция | расширение + hook-скрипты (stdin/JSON) | plugin API V2 (`@opencode/plugin` 2.2.6) |
| MCP | внешний MCP-сервер (`mcp/server.cjs`) | нативные инструменты плагина (`ctx.tool.transform`) |
| Идентичность | `conversation_id + generation_id` | `sessionID + promptMessageID` |
| Данные | `~/.cursor/token-lens/`, порт 3847 | `~/.opencode/token-lens/`, порт 3848 |
| Лимиты подписки | план из Cursor (fetch + bars) | нет надёжного источника квот — показывается cost, опция отключена |
| Дата в конце ответа | время получения лимитов подписки | время снимка сводки токенов текущего хода |
| GUI-настройки | Config page расширения | Settings page сервера + RPC |

Каталоги данных и порты не пересекаются — адаптеры можно ставить параллельно.

## Отключение

- Убери секцию `opencode-token-lens:start/end` из `~/.config/opencode/AGENTS.md`
  (или удали файл правила).
- Удали каталог плагина из `plugins/`.
- Останови сервер: `node src/serve.cjs --stop` (данные в `~/.opencode/token-lens/`
  можно удалить целиком).
