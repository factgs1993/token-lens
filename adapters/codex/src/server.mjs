import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import usage from './usage.cjs';
import browser from './report.cjs';

const store = usage.createStore();
const resourceUri = 'ui://codex-token-lens/panel.html';
const server = new McpServer({ name: 'codex-token-lens', version: '0.2.1' }, {
  instructions: 'When this plugin is active, append exactly the one Markdown link returned by the bundled answer-link helper, labelled “📊 Токены этого ответа”. Its destination follows reportView in the local token-lens/config.json (mcp or browser). Do not add a second HTML link. Use the token-report skill to bind the current Codex session and turn; do not guess IDs. Opening the report does not start a model turn. Treat consumer estimates separately from measured counters.'
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
  description: 'Open local Codex usage UI through an answer deep link. Actual input/output/cache totals; context consumers are estimates. No network access or API key.',
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
  description: 'Read the answer report, bounded prompt previews, turn history and measured chat totals for the UI.',
  inputSchema: { sessionId: z.string().min(1).max(100), turnId: z.string().min(1).max(100) },
  outputSchema: { report: z.object({ schemaVersion: z.number(), sessionId: z.string(), turnId: z.string() }).passthrough(), baseUrl: z.string().nullable() },
  annotations, _meta: { ui: { visibility: ['app'] } }
}, async ({ sessionId, turnId }) => {
  const report = store.snapshot(sessionId, turnId);
  let baseUrl = null;
  try { baseUrl = await browser.ensureReportServer(); } catch (error) { console.error(error.message); }
  return result({ report, baseUrl });
});

server.connect(new StdioServerTransport()).catch(error => { console.error(error.message); process.exitCode = 1; });
