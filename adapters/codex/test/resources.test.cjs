const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('cached panel URIs and the current entrypoint return the same built UI', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'token-lens-resource-check', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '../dist/server.cjs')] }));
    const { tools } = await client.listTools();
    const panel = tools.find(tool => tool.name === 'token_usage_panel');
    assert.equal(panel._meta.ui.resourceUri, 'ui://codex-token-lens/panel.html');
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
  } finally { await client.close(); }
});
