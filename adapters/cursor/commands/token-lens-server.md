---
name: token-lens-server
description: Статус / старт / стоп локального UI-сервера Token Lens (порт 3847)
---

Управление локальным HTTP UI для ссылок «📊 Аналитика запроса/ответа».

В PowerShell выполни нужную команду и покажи JSON как есть:

- статус: `node "$env:USERPROFILE\.cursor\plugins\local\cursor-token-lens\scripts\serve.cjs" --status`
- старт: `node "$env:USERPROFILE\.cursor\plugins\local\cursor-token-lens\scripts\serve.cjs" --start`
- стоп: `node "$env:USERPROFILE\.cursor\plugins\local\cursor-token-lens\scripts\serve.cjs" --stop`
- рестарт: `node "$env:USERPROFILE\.cursor\plugins\local\cursor-token-lens\scripts\serve.cjs" --restart`

Если пользователь просит запуск и `running: false`, выполни `--start`. После запрошенного `--stop` не запускай сервер снова автоматически. Открывай `http://127.0.0.1:3847/` только по просьбе пользователя.
Не выдумывай статус.
