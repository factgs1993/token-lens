import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import usage from './usage.cjs';
import browser from './report.cjs';
import limits from './limits.cjs';

const store = usage.createStore();
const resourceUri = 'ui://codex-token-lens/panel.html';
const server = new McpServer({ name: 'codex-token-lens', version: '0.4.2' }, {
  instructions: 'When this plugin is active, append exactly the one Markdown link returned by the bundled answer-link helper, labelled “📊 Аналитика запроса/ответа”. Its destination follows reportView in the local token-lens/config.json (mcp or browser). Do not add a second HTML link. Use the token-report skill to bind the current Codex session and turn; do not guess IDs. Opening the report does not start a model turn. Treat consumer estimates separately from measured counters.'
});
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });

// Codex caches entrypoint metadata across plugin updates; keep previously published URIs readable.
for (const [index, uri] of [resourceUri, 'ui://codex-token-lens/panel-v0.1.2.html'].entries()) {
  server.registerResource(`token-panel-${index}`, uri, { mimeType: 'text/html;profile=mcp-app' }, async () => ({
    contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: fs.readFileSync(path.join(__dirname, 'panel.html'), 'utf8'),
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } }, 'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'fullscreen' } } }]
  }));
}

server.registerTool('token_usage_panel', {
  title: 'Расход токенов',
  description: 'Open the Codex answer report: measured token totals, estimated consumers and account limit windows read through the authenticated Codex CLI. No extra model request or API key.',
  inputSchema: {}, annotations,
  _meta: { ui: { resourceUri }, 'openai/ui': { entrypoints: [{ type: 'global' }] } }
}, async () => result({ ready: true }));

server.registerTool('read_token_usage', {
  title: 'Прочитать расход токенов',
  description: 'Read local Codex token counters for an answer, including a bounded prompt preview. No full prompts or tool results. Estimates are not billing attribution.',
  inputSchema: { sessionId: z.string().min(1).max(100), turnId: z.string().min(1).max(100) }, annotations,
  _meta: { ui: { visibility: ['app', 'model'] } }
}, async ({ sessionId, turnId }) => result(store.answer(sessionId, turnId)));

server.registerTool('read_token_report', {
  title: 'Отчёт и история чата',
  description: 'Read the answer report, bounded prompt previews, turn history, measured chat totals and cached account limit windows for the UI.',
  inputSchema: { sessionId: z.string().min(1).max(100), turnId: z.string().min(1).max(100) },
  outputSchema: { report: z.object({ schemaVersion: z.number(), sessionId: z.string(), turnId: z.string() }).passthrough(), baseUrl: z.string().nullable() },
  annotations, _meta: { ui: { visibility: ['app'] } }
}, async ({ sessionId, turnId }) => {
  const report = { ...store.snapshot(sessionId, turnId), accountLimits: limits.getAccountLimits() };
  let baseUrl = null;
  try { baseUrl = await browser.ensureReportServer(); } catch (error) { console.error(error.message); }
  return result({ report, baseUrl });
});

server.registerTool('list_token_reports', {
  title: 'Все отчёты Token Lens', description: 'List local answer summaries across chats. Deleted reports are excluded.',
  inputSchema: { offset: z.number().int().min(0).optional() }, annotations, _meta: { ui: { visibility: ['app'] } }
}, async input => result(store.catalog(input)));
server.registerTool('read_token_settings', {
  title: 'Настройки Token Lens', description: 'Read report view, footer and report retention settings.',
  inputSchema: {}, annotations, _meta: { ui: { visibility: ['app'] } }
}, async () => result(store.settings()));
server.registerTool('save_token_settings', {
  title: 'Сохранить настройки Token Lens', description: 'Save settings chosen in the app. Retention hides old reports without deleting Codex journals.',
  inputSchema: { reportView: z.enum(['mcp', 'browser']), appendPlanLimits: z.boolean(), autoDeleteDays: z.number().int().min(0).max(3650) },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, _meta: { ui: { visibility: ['app'] } }
}, async input => result(store.saveSettings(input)));
server.registerTool('delete_token_reports', {
  title: 'Удалить выбранные отчёты', description: 'Hide selected Token Lens reports after confirmation in the UI. Codex session journals are preserved.',
  inputSchema: { reports: z.array(z.object({ sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), turnId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) })).min(1).max(200) },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, _meta: { ui: { visibility: ['app'] } }
}, async input => result(store.removeReports(input.reports)));

server.connect(new StdioServerTransport()).catch(error => { console.error(error.message); process.exitCode = 1; });
