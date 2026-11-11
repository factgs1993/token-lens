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

Как в Codex: в конце ответа — **одна markdown-ссылка**, без второго агентного хода.

1. \`node "${helper.replace(/\\/g, '\\\\')}"\`
2. Поле \`markdown\` из JSON допиши **последней строкой** ответа без изменений.
3. Не вызывай отдельный follow-up и не повторяй ссылку вторым сообщением.
4. MCP \`token_usage_panel\` — только если пользователь явно просит панель.

Не вставляй большую таблицу токенов вместо ссылки. Не выдумывай URL.
`;

let mcp = { mcpServers: {} };
if (fs.existsSync(mcpPath)) {
  try {
    mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
  } catch {
    mcp = { mcpServers: {} };
  }
}
if (!mcp.mcpServers || typeof mcp.mcpServers !== 'object') mcp.mcpServers = {};
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
