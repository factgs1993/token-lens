'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pluginRoot = path.join(__dirname, '..');
const helper = path.join(pluginRoot, 'scripts', 'answer-link.cjs');
const serveScript = path.join(pluginRoot, 'scripts', 'serve.cjs');
const server = path.join(pluginRoot, 'mcp', 'server.cjs');
const mcpPath = path.join(os.homedir(), '.cursor', 'mcp.json');
const rulesDir = path.join(os.homedir(), '.cursor', 'rules');
const rulePath = path.join(rulesDir, 'token-lens-analytics.mdc');
const startupDir = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'Startup'
);
const startupCmd = path.join(startupDir, 'token-lens-server.cmd');

const rule = `---
description: В конце каждого финального ответа добавлять ссылку на аналитику токенов как в Codex
alwaysApply: true
---

# Аналитика запроса/ответа (Token Lens)

Как в Codex: в конце ответа — весь блок из поля markdown (ссылка и лимиты, если включены), без второго агентного хода.

1. Узнай id текущего чата (conversation / composer id, UUID).
2. \`node "${helper.replace(/\\/g, '\\\\')}" "<conversation_id>"\`
   Для привязки к ходу: вторым аргументом \`generation_id\`.
3. Поле \`markdown\` из JSON допиши **последними строками** ответа целиком, без изменений.
4. Не вызывай отдельный follow-up и не повторяй ссылку вторым сообщением.
5. MCP \`token_usage_panel\` — только если пользователь явно просит панель; не вызывать в начале хода и не в каждом ответе.
6. Без \`conversation_id\` не вызывать — иначе возможен чужой чат из active.json.

Не вставляй большую таблицу токенов вместо ссылки. Не выдумывай URL.
`;

let mcp = { mcpServers: {} };
if (fs.existsSync(mcpPath)) {
  const raw = fs.readFileSync(mcpPath, 'utf8');
  try {
    mcp = JSON.parse(raw);
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          enabled: false,
          error: 'mcp.json повреждён — установщик остановлен, файл не изменён',
          mcpPath,
          parseError: String(error && error.message ? error.message : error),
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    process.exit(1);
  }
}
if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) {
  console.error(
    JSON.stringify(
      {
        enabled: false,
        error: 'mcp.json должен быть объектом — установщик остановлен, файл не изменён',
        mcpPath,
      },
      null,
      2
    )
  );
  process.exit(1);
}
if (mcp.mcpServers == null) {
  mcp.mcpServers = {};
} else if (typeof mcp.mcpServers !== 'object' || Array.isArray(mcp.mcpServers)) {
  console.error(
    JSON.stringify(
      {
        enabled: false,
        error: 'mcp.json: поле mcpServers битое — установщик остановлен, файл не изменён',
        mcpPath,
      },
      null,
      2
    )
  );
  process.exit(1);
}
mcp.mcpServers['cursor-token-lens'] = {
  command: 'node',
  args: [server],
};
fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');

fs.mkdirSync(rulesDir, { recursive: true });
fs.writeFileSync(rulePath, rule);

// Autostart on Windows logon.
let startup = null;
try {
  fs.mkdirSync(startupDir, { recursive: true });
  const cmd = `@echo off\r\nnode "${serveScript}" --start >nul 2>nul\r\n`;
  fs.writeFileSync(startupCmd, cmd, 'utf8');
  startup = startupCmd;
} catch (error) {
  startup = { error: error.message };
}

// Start now + keep only User MCP.
let serverStatus = null;
try {
  serverStatus = require('./serve.cjs').ensureServerSync();
} catch (error) {
  serverStatus = { ok: false, error: error.message };
}

console.log(
  JSON.stringify(
    {
      enabled: true,
      mcpPath,
      rulePath,
      helper,
      server,
      startup,
      serverStatus,
      note: 'Server autostarts on Windows logon + Cursor workspaceOpen/sessionStart/beforeSubmitPrompt.',
    },
    null,
    2
  )
);
