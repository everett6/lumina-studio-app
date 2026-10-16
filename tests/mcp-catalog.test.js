import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerLuminaTools, toolNames } from '../mcp/tools.js';

test('compact MCP catalog preserves tools, schemas, safety annotations and full help', async () => {
  const server = new McpServer({ name: 'catalog', version: '1' });
  registerLuminaTools(server, { upload() { throw new Error('not called'); } });
  const client = new Client({ name: 'catalog-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const result = await client.listTools();
    const bytes = Buffer.byteLength(JSON.stringify(result));
    assert.ok(bytes < 150000, `tool catalog ${bytes} bytes exceeds 150 KB`);
    for (const name of toolNames()) assert.ok(result.tools.some((t) => t.name === name), name);
    assert.equal(result.tools.find(t => t.name === 'generate_video').annotations.openWorldHint, true);
    const repair = result.tools.find(t => t.name === 'repair_frame');
    assert.ok(repair.inputSchema.properties.box);
    const help = await client.callTool({ name: 'get_tool_help', arguments: { name: 'repair_frame' } });
    assert.equal(help.isError, undefined);
    assert.match(help.content[0].text, /replace_clip_section/);
    assert.match(help.content[0].text, /Cost:/);
    const unknown = await client.callTool({ name: 'get_tool_help', arguments: { name: 'nonexistent' } });
    assert.equal(unknown.isError, true);
  } finally { await client.close(); await server.close(); }
});
