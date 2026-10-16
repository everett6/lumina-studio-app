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

test('every advertised tool schema is valid JSON Schema 2020, including bounded repair boxes', async () => {
  const { default: Ajv2020 } = await import('ajv/dist/2020.js');
  const server = new McpServer({ name: 'schema-regression', version: '1' });
  const submitted = [];
  registerLuminaTools(server, { call: async (...args) => { submitted.push(args); return { accepted: true }; } });
  const client = new Client({ name: 'chatgpt-schema-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const { tools } = await client.listTools();
    const validator = new Ajv2020({ strict: false, validateFormats: false });
    for (const tool of tools) {
      assert.doesNotThrow(() => validator.compile(tool.inputSchema), `${tool.name} input schema`);
      if (tool.outputSchema) assert.doesNotThrow(() => validator.compile(tool.outputSchema), `${tool.name} output schema`);
    }
    const schema = tools.find(t => t.name === 'execute_repair').inputSchema;
    const valid = validator.compile(schema);
    const shotId = 'b0a5817a-5fbf-48e1-aad6-dd1ca1ba0ba0';
    const args = { shotId, plan: { type: 'repair_frame', box: [0.1, 0.1, 0.8, 0.9], instruction: 'Restore the hat.' } };
    assert.equal(valid(args), true);
    for (const box of [[0, 0, 1], [0, 0, 1, 1, 1], [-0.1, 0, 1, 1], [0, 0, '1', 1]]) {
      const invalid = { ...args, plan: { ...args.plan, box } };
      assert.equal(valid(invalid), false, JSON.stringify(box));
      const result = await client.callTool({ name: 'execute_repair', arguments: invalid });
      assert.equal(result.isError, true);
    }
    assert.equal(submitted.length, 0, 'invalid boxes must never reach generation or spending routes');
    const result = await client.callTool({ name: 'execute_repair', arguments: args });
    assert.equal(result.isError, undefined);
    assert.equal(submitted.length, 1);
    assert.deepEqual(submitted[0][2].plan.box, args.plan.box);
  } finally { await client.close(); await server.close(); }
});
