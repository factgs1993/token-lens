const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

test('cached panel URIs and the current entrypoint return the same built UI', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-mcp-settings-'));
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'token-lens-resource-check', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '../dist/server.cjs')], env: { ...process.env, CODEX_HOME: home } }));
    const { tools } = await client.listTools();
    const panel = tools.find(tool => tool.name === 'token_usage_panel');
    assert.equal(panel._meta.ui.resourceUri, 'ui://codex-token-lens/panel.html');
    assert.deepEqual(tools.find(tool => tool.name === 'read_token_report')._meta.ui.visibility, ['app']);
    for (const name of ['list_token_reports', 'read_token_settings', 'save_token_settings', 'delete_token_reports']) assert.deepEqual(tools.find(tool => tool.name === name)._meta.ui.visibility, ['app']);
    assert.equal(tools.find(tool => tool.name === 'delete_token_reports').annotations.readOnlyHint, false);
    const content = [];
    for (const uri of ['ui://codex-token-lens/panel.html', 'ui://codex-token-lens/panel-v0.1.2.html']) {
      const result = await client.readResource({ uri });
      assert.equal(result.contents[0].uri, uri);
      assert.equal(result.contents[0].mimeType, 'text/html;profile=mcp-app');
      assert(result.contents[0].text.includes('ФАКТИЧЕСКИЕ СЧЁТЧИКИ'));
      content.push(result.contents[0].text);
    }
    assert.equal(content[0], content[1]);
    const result = await client.callTool({ name: 'token_usage_panel', arguments: {} });
    assert.equal(result.structuredContent.ready, true);
    const saved = await client.callTool({ name: 'save_token_settings', arguments: { reportView: 'mcp', appendPlanLimits: false, appendContextHeat: true, contextWindow: 100000, autoDeleteDays: 0 } });
    assert.equal(saved.structuredContent.appendContextHeat, true);
    assert.equal(saved.structuredContent.contextWindow, 100000);
    const oldClient = await client.callTool({ name: 'save_token_settings', arguments: { reportView: 'browser', appendPlanLimits: true, autoDeleteDays: 2 } });
    assert.equal(oldClient.structuredContent.appendContextHeat, true);
    assert.equal(oldClient.structuredContent.contextWindow, 100000);
    const invalid = await client.callTool({ name: 'save_token_settings', arguments: { reportView: 'mcp', appendPlanLimits: false, appendContextHeat: true, contextWindow: 0, autoDeleteDays: 0 } });
    assert.equal(invalid.isError, true);
    const settings = await client.callTool({ name: 'read_token_settings', arguments: {} });
    assert.equal(settings.structuredContent.contextWindow, 100000);
  } finally { await client.close(); }
});
