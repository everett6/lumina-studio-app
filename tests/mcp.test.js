import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startTestApp, tempRoot } from './helpers.js';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(testsDir, '../mcp/server.js');
const parse = (result) => JSON.parse(result.content.find((c) => c.type === 'text').text);

test('MCP tools drive a running Lumina app end to end', async () => {
  const t = await startTestApp();
  const client = new Client({ name: 'lumina-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, LUMINA_DATA_DIR: t.dataRoot }, stderr: 'ignore' }));
  try {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const name of ['list_projects', 'create_project', 'list_models', 'generate_image', 'get_generation', 'list_assets', 'add_to_canvas', 'run_canvas',
      'create_book', 'list_books', 'get_book', 'update_book', 'draft_bible', 'plan_pages', 'edit_page', 'revise_page', 'generate_illustration',
      'outline_book', 'draft_chapter', 'read_chapter', 'revise_chapter', 'edit_chapter', 'generate_cover', 'narrate', 'generate_speech', 'generate_video', 'export_book']) {
      assert.ok(names.includes(name), `missing tool ${name}`);
    }

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

test('MCP book tools: create → bible → plan → revise → illustrate → export PDF', async () => {
  const t = await startTestApp();
  const client = new Client({ name: 'lumina-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, LUMINA_DATA_DIR: t.dataRoot }, stderr: 'ignore' }));
  try {
    const project = parse(await client.callTool({ name: 'create_project', arguments: { name: 'Book via Claude' } }));
    const created = parse(await client.callTool({ name: 'create_book', arguments: { projectId: project.id, title: 'Moon Fox', writer: 'mock:mock-director', pageCount: 3 } }));
    assert.equal(created.brief.pageCount, 3);
    const withBible = parse(await client.callTool({ name: 'draft_bible', arguments: { bookId: created.id } }));
    assert.equal(withBible.bible.characters[0].name, 'Pip');
    const planned = parse(await client.callTool({ name: 'plan_pages', arguments: { bookId: created.id } }));
    assert.equal(planned.pages.length, 3);
    const revised = parse(await client.callTool({ name: 'revise_page', arguments: { pageId: planned.pages[0].id, instruction: 'rhyme it' } }));
    assert.match(revised.text, /rhyme it/);
    const illustrated = await client.callTool({ name: 'generate_illustration', arguments: { pageId: planned.pages[0].id, provider: 'mock', model: 'mock-image' } });
    assert.equal(parse(illustrated).status, 'completed');
    assert.ok(illustrated.content.some((c) => c.type === 'image'));
    const exported = parse(await client.callTool({ name: 'export_book', arguments: { bookId: created.id } }));
    assert.match(exported.savedOnUsersComputer, /Moon-Fox\.pdf$/);
    assert.equal(readFileSync(exported.savedOnUsersComputer).subarray(0, 5).toString(), '%PDF-');
    const epub = parse(await client.callTool({ name: 'export_book', arguments: { bookId: created.id, format: 'epub' } }));
    assert.equal(readFileSync(epub.savedOnUsersComputer).subarray(30, 38).toString(), 'mimetype');
    const book = parse(await client.callTool({ name: 'get_book', arguments: { bookId: created.id } }));
    assert.equal(book.pages[0].hasIllustration, true);
  } finally {
    await client.close();
    await t.close();
  }
});

test('MCP novel tools: outline → draft → read → narrate → speech/video → DOCX', async () => {
  const t = await startTestApp();
  const client = new Client({ name: 'lumina-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, LUMINA_DATA_DIR: t.dataRoot }, stderr: 'ignore' }));
  try {
    const project = parse(await client.callTool({ name: 'create_project', arguments: { name: 'Novel via Claude' } }));
    const book = parse(await client.callTool({ name: 'create_book', arguments: {
      projectId: project.id, kind: 'novel', title: 'Deep Water', writer: 'mock:mock-director', chapterCount: 2, wordsPerChapter: 300,
      narration: { provider: 'mock', model: 'mock-voice', voice: 'tone-low' },
    } }));
    assert.equal(book.kind, 'novel');
    const outlined = parse(await client.callTool({ name: 'outline_book', arguments: { bookId: book.id } }));
    assert.equal(outlined.chapters.length, 2);
    const drafted = parse(await client.callTool({ name: 'draft_chapter', arguments: { chapterId: outlined.chapters[0].id } }));
    assert.ok(drafted.words > 100);
    const full = parse(await client.callTool({ name: 'read_chapter', arguments: { bookId: book.id, chapterId: outlined.chapters[0].id } }));
    assert.ok(full.text.length > drafted.excerpt.length);
    const narrated = await client.callTool({ name: 'narrate', arguments: { chapterId: outlined.chapters[0].id } });
    assert.equal(parse(narrated).operation, 'speech');
    const speech = parse(await client.callTool({ name: 'generate_speech', arguments: { projectId: project.id, text: 'Hello.', provider: 'mock', model: 'mock-voice' } }));
    assert.equal(speech.status, 'completed');
    const video = parse(await client.callTool({ name: 'generate_video', arguments: { projectId: project.id, prompt: 'rain', provider: 'mock', model: 'mock-video' } }));
    assert.equal(video.operation, 'video');
    const docx = parse(await client.callTool({ name: 'export_book', arguments: { bookId: book.id, format: 'docx' } }));
    assert.match(docx.savedOnUsersComputer, /Deep-Water\.docx$/);
    const audio = parse(await client.callTool({ name: 'export_book', arguments: { bookId: book.id, format: 'audio' } }));
    assert.ok(audio.notes.some((n) => /without narration/.test(n)));
  } finally {
    await client.close();
    await t.close();
  }
});

test('MCP server launches Lumina when it is closed', async () => {
  const root = tempRoot();
  const launcher = path.join(root, 'launch.sh');
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${path.join(testsDir, 'fixtures', 'launch-app.js')}"\n`, { mode: 0o755 });
  const client = new Client({ name: 'lumina-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, LUMINA_DATA_DIR: root, LUMINA_APP_COMMAND: launcher }, stderr: 'ignore' }));
  try {
    const result = await client.callTool({ name: 'list_projects', arguments: {} });
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.ok(Array.isArray(parse(result)));
  } finally {
    await client.close();
    const endpoint = path.join(root, 'data', 'endpoint.json');
    if (existsSync(endpoint)) {
      try { process.kill(JSON.parse(readFileSync(endpoint, 'utf8')).pid); } catch { /* already gone */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP server reports clearly when Lumina is not running', async () => {
  const t = await startTestApp();
  const root = t.dataRoot;
  await t.close({ keep: true });
  const client = new Client({ name: 'lumina-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, LUMINA_DATA_DIR: root, LUMINA_NO_AUTOLAUNCH: '1' }, stderr: 'ignore' }));
  try {
    const result = await client.callTool({ name: 'list_projects', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not running/);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});
