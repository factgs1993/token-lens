# Token Lens для Cursor IDE

Локальный анализатор расхода токенов: ссылка «📊 Аналитика запроса/ответа», HTML-отчёты на `http://127.0.0.1:3847/`, оценка потребителей инструментов, лимиты подписки и необязательная панель со строкой состояния.

Версия плагина и MCP-сервера — **0.3.0**; отдельного IDE-расширения — 0.1.2. Лицензия адаптера — [MIT](LICENSE).

## Что умеет 0.3.0

- Per-answer HTML-отчёт: measured input/output/cache, поле reasoning, потребители, preview запроса, лимиты подписки
- Таблица запросов модели: measured-дельты с `afterAgentResponse` (когда Cursor отдал token fields) + строка `stop_total`; пустые `tool_batch` больше не показываются как запросы
- Оценка категорий входа: инструкции, история/запрос, схемы инструментов, tool args/results (UTF-8/3, не биллинг)
- История ходов и итоги чата **в самом HTML-отчёте**
- **Поделиться** → HTML/JSON со снимком всех ходов чата + выбранный ответ; автономный HTML без сервера
- Live-обновление открытого отчёта каждые 4 секунды
- **All Reports** — таблица отчётов, мультивыбор и удаление; страница «отчёт удалён»
- **Settings** — автоудаление старше N дней; опция «писать лимиты подписки в хвост ответа»
- Hooks: `beforeSubmitPrompt` / `postToolUse` / `afterAgentThought` / `afterAgentResponse` / `preCompact` / `stop`
- MCP: `token_usage_panel`, `read_token_usage`
- Rule + skill: агент дописывает markdown-ссылку (и лимиты, если включено) в конце ответа

Вход/выход текущего хода в **чате до `stop` недоступны** — они появляются в HTML после `stop`. В хвост ответа цифры ↓/↑ намеренно не дублируются.

**Reasoning:** measured только если Cursor передал поле в `stop`; иначе показывается оценка размера thinking из `afterAgentThought` (не billable). Схемы — оценка каталога builtin-tools + `mcp.json`, не точный wire payload.

## Установка

Эти команды рассчитаны на **Windows PowerShell**. Нужны Node.js 22+, npm и Cursor с разрешённой загрузкой локальных плагинов. Проверьте `node --version` и `npm --version`. Если PowerShell блокирует `npm.ps1`, используйте `npm.cmd`.

### 1. Скопируйте адаптер

Откройте PowerShell **в корне репозитория `token-lens`**, рядом с корневым README:

```powershell
$tokenLensPlugin = Join-Path $env:USERPROFILE '.cursor\plugins\local\cursor-token-lens'
New-Item -ItemType Directory -Path $tokenLensPlugin -Force | Out-Null
Get-ChildItem -LiteralPath '.\adapters\cursor' -Force |
  Where-Object { $_.Name -notin @('node_modules', 'token-lens.vsix') } |
  Copy-Item -Destination $tokenLensPlugin -Recurse -Force
Set-Location -LiteralPath $tokenLensPlugin
npm ci --ignore-scripts
npm test
```

Копируется содержимое адаптера, включая скрытый `.cursor-plugin`. Итоговый путь манифеста — `~/.cursor/plugins/local/cursor-token-lens/.cursor-plugin/plugin.json`; дополнительной вложенной папки `cursor` быть не должно.

### 2. Включите аналитику

Если существует `~/.cursor/mcp.json`, сохраните его копию и убедитесь, что он содержит корректный JSON: текущий установщик при ошибке разбора заменяет конфигурацию пустой. Затем **из папки установленного плагина** выполните:

```powershell
node scripts/enable-default.cjs
```

Установщик:

- добавляет `cursor-token-lens` в пользовательский `~/.cursor/mcp.json`, сохраняя остальные корректные записи;
- записывает глобальное правило `~/.cursor/rules/token-lens-analytics.mdc`, чтобы агент добавлял ссылку без упоминания плагина;
- создаёт `token-lens-server.cmd` в папке автозагрузки Windows и запускает локальный сервер отчётов на `http://127.0.0.1:3847/`.

В результате команды проверьте `serverStatus.ok: true` и путь `startup`. Само поле `enabled: true` ещё не подтверждает запуск сервера.

Оставьте MCP **только в пользовательской конфигурации**. Файл `mcp.json.example` в адаптере — пример; переименовывать его в `mcp.json` не нужно, иначе Cursor может подключить MCP дважды.

### 3. Перезагрузите Cursor и проверьте

В Command Palette (`Ctrl+Shift+P`) запустите **Developer: Reload Window** либо полностью перезапустите IDE. В **Customize** проверьте наличие локального `cursor-token-lens`, его hooks, правил и пользовательского MCP-сервера.

```powershell
node scripts/serve.cjs --status
```

Ожидается `running: true`. Откройте [http://127.0.0.1:3847/](http://127.0.0.1:3847/) — **All Reports**. Из любого отчёта: **Settings** (автоудаление и лимиты в хвосте ответа), **Поделиться** (HTML/JSON).

В новом чате отправьте короткий запрос и дождитесь завершения. После `stop` в списке появится HTML-страница; ссылка из ответа агента открывает её в браузере. Если Cursor не передал счётчики токенов, отчёт покажет их отсутствие, а не нулевой расход.

Локальные плагины описаны в [документации Cursor](https://cursor.com/docs/plugins). Установленный из marketplace плагин с тем же именем имеет приоритет над локальной копией.

## Необязательное расширение IDE

```powershell
node scripts/install-extension.cjs
```

Копирует расширение в `~/.cursor/extensions/`. После **Reload Window** появятся `TokenLens` в строке состояния и команда **Token Lens: Open Panel**. Для просмотра HTML-отчётов расширение не требуется.

## Управление сервером

```powershell
node scripts/serve.cjs --status
node scripts/serve.cjs --start
node scripts/serve.cjs --restart
node scripts/serve.cjs --stop
```

Также есть `/token-lens-server`. Сервер поднимается при входе в Windows, hooks Cursor, активации расширения и формировании страницы/ссылки ответа — поэтому `--stop` может быть снова отменён следующим событием.

Сервис слушает только `127.0.0.1:3847`.

## Обновление

1. В корне Git-копии: `git pull --ff-only` (или свежий ZIP).
2. Повторите шаги 1–3 установки.
3. `node scripts/serve.cjs --restart` из папки плагина.
4. Если ставили расширение IDE — снова `node scripts/install-extension.cjs` и Reload Window.

Отчёты лежат отдельно в `~/.cursor/token-lens/` и при обновлении исходников не удаляются.

## Данные и ограничения

- `beforeSubmitPrompt` сохраняет превью первых 200 символов запроса и оценку инструкций/схем/истории.
- `postToolUse` / `afterAgentResponse` / `afterAgentThought` дополняют категории и шаги.
- Measured totals — из `stop` и, при наличии полей, дельты с `afterAgentResponse`. Отдельные вызовы внутри tool-loop без token fields по-прежнему неразличимы.
- `stop` сохраняет отчёт и HTML **без** автоматического follow-up в чат.
- Параллельные чаты изолированы по `sessions/<conversation_id>/`; история — до 200 ходов на чат, индекс — 50 чатов.
- Журналы и HTML — в `~/.cursor/token-lens/`; сервер отдаёт этот каталог по localhost.
- Экспорт включает превью запросов и агрегаты; полные tool outputs не экспортируются.

Состав: `.cursor-plugin/`, `hooks/`, `scripts/`, `mcp/`, `rules/`, `commands/`, `skills/`, `extension/`, `test/`. Тесты: `npm test`.
