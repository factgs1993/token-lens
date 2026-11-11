---
name: token-lens-server
description: Статус / старт / стоп локального UI-сервера Token Lens (порт 3847)
---

Управление локальным HTTP UI для ссылок «📊 Аналитика запроса/ответа».

Выполни нужную команду и покажи JSON как есть:

- статус: `node "%USERPROFILE%\.cursor\plugins\local\cursor-token-lens\scripts\serve.cjs" --status`
- старт: `node "%USERPROFILE%\.cursor\plugins\local\cursor-token-lens\scripts\serve.cjs" --start`
- стоп: `node "%USERPROFILE%\.cursor\plugins\local\cursor-token-lens\scripts\serve.cjs" --stop`
- рестарт: `node "%USERPROFILE%\.cursor\plugins\local\cursor-token-lens\scripts\serve.cjs" --restart`

Если `running: false` — сначала `--start`, затем открой `http://127.0.0.1:3847/`.
Не выдумывай статус.
