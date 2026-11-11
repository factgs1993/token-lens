'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const pluginRoot = path.join(__dirname, '..');
const answerLink = path.join(pluginRoot, 'scripts', 'answer-link.cjs');
const panelPath = path.join(__dirname, 'panel.html');
const resourceUri = 'ui://cursor-token-lens/panel.html';

function runAnswerLink(conversationId) {
  const args = [answerLink];
  if (conversationId) args.push(conversationId);
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'answer-link failed').trim());
  return JSON.parse(result.stdout);
}

function panelHtml(payload) {
  const base = fs.readFileSync(panelPath, 'utf8');
  const data = JSON.stringify(payload || {}).replace(/</g, '\\u003c');
  return base.replace('__TOKEN_LENS_DATA__', data);
}

const server = new McpServer(
  { name: 'cursor-token-lens', version: '0.2.0' },
  {
    instructions:
      'When this server is available, call token_usage_panel once near the end of each final answer and append the markdown from answer-link / tool result labelled «📊 Аналитика запроса/ответа». Do not invent token counts.',
  }
);

server.registerResource(
  'token-panel',
  resourceUri,
  { mimeType: 'text/html;profile=mcp-app' },
  async () => {
    let payload = {};
    try {
      payload = runAnswerLink();
    } catch {
      payload = { markdown: 'Нет данных Token Lens', consumers: [] };
    }
    return {
      contents: [
        {
          uri: resourceUri,
          mimeType: 'text/html;profile=mcp-app',
          text: panelHtml(payload),
          _meta: {
            ui: {
              csp: { connectDomains: [], resourceDomains: [] },
            },
          },
        },
      ],
    };
  }
);

server.registerTool(
  'token_usage_panel',
  {
    title: 'Аналитика запроса/ответа',
    description:
      'Показать локальную аналитику токенов текущего/последнего ответа Cursor: фактический вход/выход и оценка потребителей. Без сети.',
    inputSchema: {
      conversationId: z.string().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: {
      ui: { resourceUri },
    },
  },
  async ({ conversationId }) => {
    const data = runAnswerLink(conversationId);
    const text = data.markdown
      ? `${data.markdown}\n\nОткрой ссылку для подробного разбора этого ответа (как в Codex).`
      : 'Нет данных';
    return {
      content: [{ type: 'text', text }],
      structuredContent: data,
    };
  }
);

server.registerTool(
  'read_token_usage',
  {
    title: 'Прочитать расход токенов',
    description: 'Прочитать локальные агрегаты Token Lens без сырых промптов.',
    inputSchema: {
      conversationId: z.string().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ conversationId }) => {
    const data = runAnswerLink(conversationId);
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      structuredContent: data,
    };
  }
);

server.connect(new StdioServerTransport()).catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
