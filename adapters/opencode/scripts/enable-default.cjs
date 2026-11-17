'use strict';

// Включает «хвост ссылки по умолчанию» для OpenCode: добавляет правило в
// глобальный AGENTS.md (~/.config/opencode/AGENTS.md), чтобы модель вызывала
// инструмент token_usage_panel в конце каждого финального ответа.
// Секция идемпотентна (маркеры opencode-token-lens:start/end), как в Cursor-адаптере.
// Без auto-дописывания synthetic-сообщением и без follow-up-спама.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONFIG_DIR =
  process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), '.config', 'opencode');
const instructions = path.join(CONFIG_DIR, 'AGENTS.md');
const start = '<!-- opencode-token-lens:start -->';
const end = '<!-- opencode-token-lens:end -->';

const section = `${start}
## Аналитика запроса/ответа (Token Lens)

В конце каждого финального ответа показывай локальную аналитику токенов через инструмент плагина.

1. В самом конце финального ответа вызови инструмент \`token_usage_panel\` (без аргументов).
2. Добавь всё поле \`markdown\` из его результата **без изменений в самом конце** ответа — ссылку «📊 Аналитика запроса/ответа», краткую сводку и индикатор контекста под ней, если они включены в Settings. Сохрани все строки.
3. Не пиши follow-up, который только повторяет ссылку или цифры, и не упоминай плагин в тексте ответа.
4. Не выдумывай цифры и URL: только поле \`markdown\` из результата инструмента. Если инструмент недоступен, кратко скажи об этом.
5. Пользовательские вопросы о расходе токенов/cost/потребителях отвечай по данным \`read_token_usage\` — теми же цифрами, что и в отчёте.
${end}`;

let current = fs.existsSync(instructions) ? fs.readFileSync(instructions, 'utf8') : '';
const beginAt = current.indexOf(start);
if (beginAt >= 0) {
  const endAt = current.indexOf(end, beginAt);
  if (endAt < 0) throw new Error('Incomplete token-lens section in AGENTS.md; refusing to overwrite.');
  current = current.slice(0, beginAt) + section + current.slice(endAt + end.length);
} else {
  current = current.trimEnd() + (current.trim() ? '\n\n' : '') + section + '\n';
}

fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.writeFileSync(instructions, current);
console.log(JSON.stringify({ instructions, enabled: true }));
