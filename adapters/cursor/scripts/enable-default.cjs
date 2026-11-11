'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pluginRoot = path.join(__dirname, '..');
const helper = path.join(pluginRoot, 'scripts', 'answer-link.cjs');
const server = path.join(pluginRoot, 'mcp', 'server.cjs');
const mcpPath = path.join(os.homedir(), '.cursor', 'mcp.json');
const rulesDir = path.join(os.homedir(), '.cursor', 'rules');
const rulePath = path.join(rulesDir, 'token-lens-analytics.mdc');

const rule = `---
description: В конце каждого финального ответа добавлять аналитику токенов как в Codex
alwaysApply: true
---

# Аналитика запроса/ответа (Token Lens)

В конце каждого финального ответа добавь блок аналитики токенов (аналог Codex «Токены этого ответа»).

1. Один раз выполни:

\`\`\`text
node "${helper.replace(/\\/g, '\\\\')}"
\`\`\`

2. Поле \`markdown\` из JSON допиши **последними строками** ответа без правок.
3. Если доступен MCP \`token_usage_panel\` (\`cursor-token-lens\`) — вызови его один раз в этом ходу.
4. Не выдумывай числа. Не копируй блок от прошлого ответа.
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

// Ensure local UI server (http://127.0.0.1:3847) so links open rendered HTML, not source.
try {
  require('./serve.cjs').ensureServer();
} catch {
  // non-fatal
}

// Keep MCP only in ~/.cursor/mcp.json (User). Do not also ship plugin mcp.json —
// Cursor would show two identical "cursor-token-lens" servers (User + Plugin).
console.log(
  JSON.stringify(
    {
      enabled: true,
      mcpPath,
      rulePath,
      helper,
      server,
      note: 'Single User MCP entry only. Reload MCP. Do not re-add plugin mcp.json.',
    },
    null,
    2
  )
);
