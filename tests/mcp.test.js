import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startTestApp } from './helpers.js';

const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../mcp/server.js');
const parse = (result) => JSON.parse(result.content.find((c) => c.type === 'text').text);

test('MCP tools drive a running Lumina app end to end', async () => {
  const t = await startTestApp();
  const client = new Client({ name: 'lumina-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, LUMINA_DATA_DIR: t.dataRoot }, stderr: 'ignore' }));
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['add_to_canvas', 'create_project', 'generate_image', 'get_generation', 'list_assets', 'list_models', 'list_projects', 'run_canvas']);

    const project = parse(await client.callTool({ name: 'create_project', arguments: { name: 'From Claude' } }));
    const models = parse(await client.callTool({ name: 'list_models', arguments: {} }));
    assert.ok(models.providers.find((p) => p.id === 'mock').ready);

    const generated = await client.callTool({ name: 'generate_image', arguments: { projectId: project.id, prompt: 'a paper boat', provider: 'mock', model: 'mock-image' } });
    const summary = parse(generated);
    assert.equal(summary.status, 'completed');
    const image = generated.content.find((c) => c.type === 'image');
    assert.equal(image.mimeType, 'image/png');
    assert.ok(Buffer.from(image.data, 'base64').subarray(1, 4).toString() === 'PNG');

    const edited = parse(await client.callTool({ name: 'generate_image', arguments: { projectId: project.id, prompt: 'make it red', provider: 'mock', model: 'mock-image', inputAssetIds: [summary.assetId] } }));
    assert.equal(edited.operation, 'edit');

    const placed = parse(await client.callTool({ name: 'add_to_canvas', arguments: { projectId: project.id, assetId: summary.assetId } }));
    const listed = parse(await client.callTool({ name: 'list_assets', arguments: { projectId: project.id } }));
    assert.equal(listed.assets.length, 2);
    assert.equal(listed.canvases[0].id, placed.canvasId);

    const run = parse(await client.callTool({ name: 'run_canvas', arguments: { canvasId: placed.canvasId } }));
    assert.equal(run.status, 'completed');
    assert.equal(run.nodes[placed.nodeId].assetId, summary.assetId);

    const failed = await client.callTool({ name: 'generate_image', arguments: { projectId: project.id, prompt: 'x [fail]', provider: 'mock', model: 'mock-image' } });
    assert.equal(failed.isError, true);
    const missing = await client.callTool({ name: 'generate_image', arguments: { projectId: project.id, prompt: 'x', provider: 'openai', model: 'gpt-image-2.5-flare' } });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /API key/);
  } finally {
    await client.close();
    await t.close();
  }
});

test('MCP server reports clearly when Lumina is not running', async () => {
  const t = await startTestApp();
  const root = t.dataRoot;
  await t.close({ keep: true });
  const client = new Client({ name: 'lumina-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, LUMINA_DATA_DIR: root }, stderr: 'ignore' }));
  try {
    const result = await client.callTool({ name: 'list_projects', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not running/);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});
