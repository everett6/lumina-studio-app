import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
      'outline_book', 'draft_chapter', 'read_chapter', 'revise_chapter', 'edit_chapter', 'generate_cover', 'narrate', 'generate_speech', 'generate_video', 'export_book', 'list_presets',
      'list_characters', 'create_character', 'enhance_image', 'import_manuscript', 'create_storyboard', 'get_storyboard', 'update_shot', 'generate_shot', 'join_storyboard',
      'update_character', 'make_character_sheet', 'review_shot', 'render_still_shot', 'voice_dialogue', 'estimate_film_cost', 'openrouter_credit_status', 'budget_status', 'decide_approval', 'refresh_models', 'import_video', 'inspect_video', 'interpolate_video',
      'list_shot_takes', 'select_shot_take', 'attach_clip_to_shot', 'repair_frame', 'rerecord_line', 'set_line_timing', 'export_production', 'list_voices', 'preview_voice', 'cast_voices', 'set_background_music', 'find_music']) {
      assert.ok(names.includes(name), `missing tool ${name}`);
    }

    const allowance = parse(await client.callTool({ name: 'openrouter_credit_status', arguments: { refresh: true } }));
    assert.equal(allowance.status, 'missing_key');
    assert.equal(allowance.keyRemainingUsd, null);
    assert.equal(allowance.accountRemainingUsd, null);

    const project = parse(await client.callTool({ name: 'create_project', arguments: { name: 'From Claude' } }));
    const models = parse(await client.callTool({ name: 'list_models', arguments: {} }));
    assert.ok(models.providers.find((p) => p.id === 'mock').ready);

    const generated = await client.callTool({ name: 'generate_image', arguments: { projectId: project.id, prompt: 'a paper boat', provider: 'mock', model: 'mock-image' } });
    const summary = parse(generated);
    assert.equal(summary.status, 'completed');
    const image = generated.content.find((c) => c.type === 'image');
    assert.equal(image.mimeType, 'image/png');
    assert.ok(Buffer.from(image.data, 'base64').subarray(1, 4).toString() === 'PNG');

    const background = parse(await client.callTool({ name: 'generate_video', arguments: { projectId: project.id, prompt: 'waves', provider: 'mock', model: 'mock-video', duration: 4, seed: 1234, wait: false } }));
    assert.equal(background.seed, 1234);
    assert.match(background.note, /Poll get_generation/);
    await t.call('POST', `/api/generations/${background.id}/wait`, { timeoutMs: 10000 });
    assert.equal(parse(await client.callTool({ name: 'get_generation', arguments: { generationId: background.id, includeImage: false } })).status, 'completed');

    const presets = parse(await client.callTool({ name: 'list_presets', arguments: { mode: 'image' } }));
    assert.ok(presets.some((p) => p.id === 'noir') && !presets.some((p) => p.group === 'camera'));
    const styled = parse(await client.callTool({ name: 'generate_image', arguments: { projectId: project.id, prompt: 'a lighthouse', provider: 'mock', model: 'mock-image', presets: ['noir'] } }));
    assert.deepEqual(styled.presets, ['noir']);
    assert.match(styled.finalPrompt, /film noir/);

    const edited = parse(await client.callTool({ name: 'generate_image', arguments: { projectId: project.id, prompt: 'make it red', provider: 'mock', model: 'mock-image', inputAssetIds: [summary.assetId] } }));
    assert.equal(edited.operation, 'edit');

    const placed = parse(await client.callTool({ name: 'add_to_canvas', arguments: { projectId: project.id, assetId: summary.assetId } }));
    const listed = parse(await client.callTool({ name: 'list_assets', arguments: { projectId: project.id } }));
    assert.equal(listed.assets.length, 4);
    assert.equal(listed.canvases[0].id, placed.canvasId);

    const run = parse(await client.callTool({ name: 'run_canvas', arguments: { canvasId: placed.canvasId } }));
    assert.equal(run.status, 'completed');
    assert.equal(run.nodes[placed.nodeId].assetId, summary.assetId);

    // A local video comes in through import_video; interpolating it needs RIFE, which tests never download.
    const clipFile = path.join(tempRoot(), 'clip.mp4');
    spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=12:duration=1', '-pix_fmt', 'yuv420p', '-y', clipFile]);
    const imported = parse(await client.callTool({ name: 'import_video', arguments: { projectId: project.id, filePath: clipFile } }));
    assert.ok(imported.assetId && existsSync(imported.file));
    const notText = await client.callTool({ name: 'import_video', arguments: { projectId: project.id, filePath: path.join(testsDir, 'mcp.test.js') } });
    assert.ok(notText.isError);
    const inspection = await client.callTool({ name: 'inspect_video', arguments: { assetId: imported.assetId, times: [0, 0.25] } });
    assert.equal(inspection.isError, undefined);
    assert.equal(inspection.content.filter((c) => c.type === 'image').length, 2);
    assert.deepEqual(parse(inspection).sampleTimes, [0, 0.25]);
    const invalidInspection = await client.callTool({ name: 'inspect_video', arguments: { assetId: imported.assetId, times: [999] } });
    assert.equal(invalidInspection.isError, true);
    const smooth = await client.callTool({ name: 'interpolate_video', arguments: { assetId: imported.assetId, fps: 24 } });
    assert.ok(smooth.isError);
    assert.match(smooth.content[0].text, /RIFE|not installed/);

    // Characters, image tools, storyboard and manuscript import.
    const hero = parse(await client.callTool({ name: 'create_character', arguments: { name: 'Pip', description: 'small red fox, green scarf', referenceAssetIds: [summary.assetId] } }));
    assert.equal(parse(await client.callTool({ name: 'list_characters', arguments: {} }))[0].id, hero.id);
    const cast = parse(await client.callTool({ name: 'generate_image', arguments: { projectId: project.id, prompt: 'by the lake', provider: 'mock', model: 'mock-image', characterIds: [hero.id] } }));
    assert.match(cast.finalPrompt, /Pip — small red fox/);
    const bigger = await client.callTool({ name: 'enhance_image', arguments: { projectId: project.id, assetId: summary.assetId, operation: 'upscale', scale: 2 } });
    assert.equal(parse(bigger).operation, 'upscale');
    assert.ok(bigger.content.some((c) => c.type === 'image'));
    const board = parse(await client.callTool({ name: 'create_storyboard', arguments: { projectId: project.id, title: 'Dawn', idea: 'A fox reaches a lake.', shotCount: 2, characterIds: [hero.id] } }));
    assert.equal(board.shots.length, 2);
    assert.equal(board.settings.videoModel, 'mock-video');
    const reshot = parse(await client.callTool({ name: 'update_shot', arguments: { shotId: board.shots[0].id, camera: 'crane-up', duration: 8 } }));
    assert.equal(reshot.shots[0].camera, 'crane-up');
    const frameResult = await client.callTool({ name: 'generate_shot', arguments: { shotId: board.shots[0].id, kind: 'frame' } });
    assert.ok(frameResult.content.some((c) => c.type === 'image'));
    assert.equal(parse(await client.callTool({ name: 'generate_shot', arguments: { shotId: board.shots[0].id, kind: 'clip' } })).operation, 'video');
    const fetched = parse(await client.callTool({ name: 'get_storyboard', arguments: { storyboardId: board.id } }));
    assert.ok(fetched.shots[0].frameAssetId && fetched.shots[0].clipAssetId && !fetched.shots[1].clipAssetId);
    const lake = parse(await client.callTool({ name: 'create_character', arguments: { name: 'Lake', kind: 'location', description: 'misty lake, jetty on the left' } }));
    assert.equal(lake.kind, 'location');
    const lockedPip = parse(await client.callTool({ name: 'update_character', arguments: { characterId: hero.id, locked: true } }));
    assert.equal(lockedPip.locked, true);
    const refused = await client.callTool({ name: 'update_character', arguments: { characterId: hero.id, description: 'a blue fox' } });
    assert.ok(refused.isError && /locked/.test(refused.content[0].text));
    const detailed = parse(await client.callTool({ name: 'update_shot', arguments: { shotId: board.shots[1].id, details: { locationId: lake.id, method: 'still', forbidden: 'the scarf', dialogue: [{ speaker: 'narrator', text: 'Dawn.' }] } } }));
    assert.equal(detailed.shots[1].method, 'still');
    assert.equal(detailed.shots[1].dialogue[0].recorded, false);
    const cost = parse(await client.callTool({ name: 'estimate_film_cost', arguments: { storyboardId: board.id } }));
    assert.equal(typeof cost.totalUsd, 'number');
    assert.ok(cost.freeStillSeconds > 0);
    assert.equal(parse(await client.callTool({ name: 'budget_status', arguments: {} })).settings.enabled, false);
    const review = await client.callTool({ name: 'review_shot', arguments: { shotId: board.shots[0].id, status: 'accepted', notes: 'on model' } });
    assert.equal(parse(review).shots[0].review, 'accepted');
    if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0) {
      await client.callTool({ name: 'generate_shot', arguments: { shotId: board.shots[1].id, kind: 'frame' } });
      const still = parse(await client.callTool({ name: 'render_still_shot', arguments: { shotId: board.shots[1].id } }));
      assert.ok(still.shots[1].clipAssetId, 'still shot rendered');
      const joined = parse(await client.callTool({ name: 'join_storyboard', arguments: { storyboardId: board.id } }));
      assert.equal(joined.joined, 2);
      assert.ok(existsSync(joined.file));
    }
    const manuscript = parse(await client.callTool({ name: 'import_manuscript', arguments: { projectId: project.id, title: 'Lake Road', text: '## One\n\nIt began.\n\n## Two\n\nIt ended.' } }));
    assert.deepEqual(manuscript.chapters.map((c) => c.title), ['One', 'Two']);

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
    const fixedEpub = parse(await client.callTool({ name: 'export_book', arguments: { bookId: created.id, format: 'epub', fixedLayout: true } }));
    assert.match(fixedEpub.savedOnUsersComputer, /-fixed\.epub$/);
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
    const voices = parse(await client.callTool({ name: 'list_voices', arguments: {} }));
    const mockVoice = voices.models.find((m) => m.provider === 'mock');
    assert.deepEqual(mockVoice.voices, ['tone-low', 'tone-high']);
    assert.equal(voices.models[0].local, true, 'local voices are listed first');
    const sample = await client.callTool({ name: 'preview_voice', arguments: { projectId: project.id, voice: 'tone-high', provider: 'mock', model: 'mock-voice' } });
    assert.equal(parse(sample).voice, 'tone-high');
    const clip = sample.content.find((c) => c.type === 'audio');
    assert.ok(clip?.data.length > 100, 'the sample is returned as inline audio');
    const aiko = parse(await client.callTool({ name: 'create_character', arguments: { name: 'Aiko', description: '1girl, short black hair, school uniform' } }));
    const ren = parse(await client.callTool({ name: 'create_character', arguments: { name: 'Ren', description: '1boy, spiky hair, he carries a sword' } }));
    const castBoard = parse(await client.callTool({ name: 'create_storyboard', arguments: { projectId: project.id, title: 'Cast', idea: 'Two friends.', plan: false, characterIds: [aiko.id] } }));
    await client.callTool({ name: 'import_shot_plan', arguments: { storyboardId: castBoard.id, shots: [{ description: 'rooftop', duration: 3, details: { method: 'still', dialogue: [{ speaker: aiko.id, text: 'Ready?' }, { speaker: ren.id, text: 'Always.' }, { speaker: 'narrator', text: 'They jumped.' }] } }] } });
    const cast = parse(await client.callTool({ name: 'cast_voices', arguments: { storyboardId: castBoard.id, provider: 'mock', model: 'mock-voice', record: true } }));
    assert.deepEqual(cast.characters.map((c) => c.name).sort(), ['Aiko', 'Ren'], 'the cast and every dialogue speaker get a voice');
    assert.notEqual(cast.characters[0].voice, cast.characters[1].voice, 'characters get distinct voices');
    assert.equal(cast.characters.find((c) => c.name === 'Aiko').guessed, 'female');
    assert.equal(cast.characters.find((c) => c.name === 'Ren').guessed, 'male');
    assert.ok(cast.narrator.voice);
    assert.equal(cast.queued, 3, 'record=true records every line');
    const again = parse(await client.callTool({ name: 'cast_voices', arguments: { storyboardId: castBoard.id, provider: 'mock', model: 'mock-voice', voices: { [ren.id]: 'tone-low' } } }));
    assert.equal(again.characters.find((c) => c.name === 'Aiko').kept, true, 'chosen voices are kept');
    assert.equal(again.characters.find((c) => c.name === 'Ren').voice, 'tone-low');
    const sampleId = parse(sample).assetId;
    const music = parse(await client.callTool({ name: 'set_background_music', arguments: { storyboardId: castBoard.id, assetId: sampleId, volume: 0.4 } }));
    assert.deepEqual(music.music, { assetId: sampleId, volume: 0.4 });
    const quieter = parse(await client.callTool({ name: 'set_background_music', arguments: { storyboardId: castBoard.id, volume: 0.2, clipVolume: 0.5 } }));
    assert.equal(quieter.music.volume, 0.2);
    assert.equal(quieter.clipVolume, 0.5);
    const picture = parse(await client.callTool({ name: 'generate_image', arguments: { projectId: project.id, prompt: 'a lake', provider: 'mock', model: 'mock-image' } }));
    const notAudio = await client.callTool({ name: 'set_background_music', arguments: { storyboardId: castBoard.id, role: 'ambience', assetId: picture.assetId } });
    assert.equal(notAudio.isError, true, 'an image cannot be the ambience');
    const removed = parse(await client.callTool({ name: 'set_background_music', arguments: { storyboardId: castBoard.id, remove: true } }));
    assert.equal(removed.music, null);
    const before = parse(await client.callTool({ name: 'list_characters', arguments: {} })).find((c) => c.id === aiko.id).voice;
    const bad = await client.callTool({ name: 'cast_voices', arguments: { storyboardId: castBoard.id, provider: 'mock', model: 'mock-voice', replace: true, narrator: 'nobody' } });
    assert.equal(bad.isError, true);
    const after = parse(await client.callTool({ name: 'list_characters', arguments: {} })).find((c) => c.id === aiko.id).voice;
    assert.deepEqual(after, before, 'an invalid request changes no voice');
    assert.match(cast.warning ?? '', /too few voices/, 'three speakers on a two-voice model are flagged');
    const wrong = await client.callTool({ name: 'preview_voice', arguments: { projectId: project.id, voice: 'nobody', model: 'mock-voice' } });
    assert.equal(wrong.isError, true);
    assert.match(wrong.content[0].text, /tone-low, tone-high/, 'a model-only call picks that model and lists its voices');
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

// ---------- Server metadata (no app needed: a stub client and an in-memory transport) ----------
async function connectStub(serverOptions, clientStub = {}) {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { registerLuminaTools } = await import('../mcp/tools.js');
  const server = serverOptions === null ? new McpServer({ name: 'x', version: '1' }) : new McpServer({ name: 'x', version: '1' }, serverOptions);
  registerLuminaTools(server, { call: async () => ({}), fetchRaw: async () => ({ ok: false }), exportDir: () => '.', upload: async () => ({}), ...clientStub });
  const client = new Client({ name: 'meta-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, server };
}

test('every MCP tool has a title, annotations and a cost note', async () => {
  const { client } = await connectStub(null);
  const { tools } = await client.listTools();
  const { toolNames } = await import('../mcp/tools.js');
  assert.deepEqual(tools.map((x) => x.name).sort(), toolNames().sort(), 'TOOL_META must list exactly the registered tools');
  for (const tool of tools) {
    assert.ok(tool.title && tool.title !== tool.name, `${tool.name} needs a title`);
    const a = tool.annotations ?? {};
    for (const key of ['readOnlyHint', 'openWorldHint']) assert.equal(typeof a[key], 'boolean', `${tool.name}.${key}`);
    if (!a.readOnlyHint) for (const key of ['destructiveHint', 'idempotentHint']) assert.equal(typeof a[key], 'boolean', `${tool.name}.${key}`);
    assert.match(tool.description, /Free|credits|money|cost/i, `${tool.name} should say what it costs`);
  }
  const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
  assert.equal(by.list_projects.readOnlyHint, true);
  assert.equal(by.import_shot_plan.destructiveHint, true);
  assert.equal(by.bake_character.destructiveHint, true);
  assert.equal(by.generate_shot.openWorldHint, true);
  assert.equal(by.join_storyboard.openWorldHint, false);
  assert.equal(by.update_shot.idempotentHint, true);
  assert.equal(by.create_project.destructiveHint, false);
});

test('take, repair, dialogue-revision and export tools call the right routes', async () => {
  const calls = [];
  const shot = { id: 's1', position: 1, details: { dialogue: [{ speaker: 'narrator', text: 'One', start: 1, assetId: 'a1', style: '' }, { speaker: 'narrator', text: 'Two', start: null, style: 'calm' }] } };
  const { client } = await connectStub(null, { call: async (method, route, body) => {
    calls.push([method, route, body]);
    if (route === '/api/shots/s1') return method === 'GET' ? { shot } : { shots: [shot], sequence: {} };
    if (route.endsWith('/takes')) return { position: 1, frames: [{ assetId: 'f1', current: true, source: 'frame', createdAt: 'x', path: '/p' }], clips: [] };
    if (route.endsWith('/repair-frame')) return { generation: { id: 'g1', status: 'queued', provider: 'fal', model: 'm' } };
    if (route.endsWith('/rerecord')) return { queued: [{ id: 'g2' }] };
    if (route.endsWith('/export-project')) return { folder: '/x', files: ['timeline.json'] };
    return { sequence: { settings: {} }, shots: [shot] };
  } });
  const run = (name, args) => client.callTool({ name, arguments: args });
  assert.equal(parse(await run('list_shot_takes', { shotId: 's1' })).frames[0].assetId, 'f1');
  await run('select_shot_take', { shotId: 's1', kind: 'clip', assetId: 'c1' });
  await run('attach_clip_to_shot', { shotId: 's1', assetId: 'v1' });
  assert.equal(parse(await run('repair_frame', { shotId: 's1', box: [0.1, 0.1, 0.5, 0.5], instruction: 'fix hand' })).generationId, 'g1');
  assert.deepEqual(parse(await run('rerecord_line', { shotId: 's1', lineIndex: 1, style: 'whisper' })).queued, ['g2']);
  await run('set_line_timing', { shotId: 's1', lineIndex: 1, start: 2.5 });
  assert.equal((await run('set_line_timing', { shotId: 's1', lineIndex: 7, start: 1 })).isError, true);
  assert.deepEqual(parse(await run('export_production', { storyboardId: 'b1' })).files, ['timeline.json']);
  const by = (route) => calls.find((c) => c[1].endsWith(route));
  assert.deepEqual(by('/takes/select')[2], { kind: 'clip', assetId: 'c1' });
  assert.deepEqual(by('/attach-clip')[2], { assetId: 'v1' });
  assert.deepEqual(by('/dialogue/1/rerecord')[2], { style: 'whisper' });
  const patch = calls.find((c) => c[0] === 'PATCH');
  assert.deepEqual(patch[2].details.dialogue.map((l) => l.start), [1, 2.5]);
});

test('server instructions are present, also for a server built without options (remote endpoint)', async () => {
  const { LUMINA_INSTRUCTIONS } = await import('../mcp/tools.js');
  for (const options of [{ instructions: LUMINA_INSTRUCTIONS }, null]) {
    const { client } = await connectStub(options);
    const text = client.getInstructions();
    assert.match(text, /film_next_step/);
    assert.match(text, /lipSync/);
    assert.match(text, /English only/);
    assert.match(text, /watch_jobs/);
    assert.match(text, /budget approvals/);
  }
});

test('prompts list and use real tool names', async () => {
  const { client } = await connectStub(null);
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name).sort(), ['finish_film', 'fix_a_shot', 'make_anime_short']);
  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  const anime = await client.getPrompt({ name: 'make_anime_short', arguments: { idea: 'A fox crosses a lake', minutes: '2', characters: 'Pip, a fox' } });
  const body = anime.messages[0].content.text;
  assert.match(body, /A fox crosses a lake/);
  const fix = await client.getPrompt({ name: 'fix_a_shot', arguments: { storyboardId: 'sb1', shotId: 'sh1', problem: 'face drifts' } });
  const finish = await client.getPrompt({ name: 'finish_film', arguments: { storyboardId: 'sb1' } });
  const mentioned = new Set([body, fix.messages[0].content.text, finish.messages[0].content.text].flatMap((x) => x.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []));
  const known = ['create_project', 'create_character', 'make_character_sheet', 'bake_character', 'create_storyboard', 'film_next_step', 'join_storyboard', 'preview_shot', 'review_shot', 'watch_jobs'];
  for (const name of known) assert.ok(names.has(name) && (body + fix.messages[0].content.text + finish.messages[0].content.text).includes(name), name);
  // Any snake_case word that is a tool-like verb in the prompts must be a real tool (ignore argument and status words).
  const ignored = new Set(['needs_regeneration', 'plan_false', 'strict_budget']);
  for (const word of mentioned) if (/^(list|get|create|update|make|generate|preview|review|trim|move|adjust|render|voice|estimate|decide|lip|film|join|watch|import|production|budget|set|bake)_/.test(word) && !ignored.has(word)) assert.ok(names.has(word), `prompt mentions unknown tool ${word}`);
});

test('tool errors carry the API message plus a hint for common statuses', async () => {
  const { errorHint } = await import('../mcp/tools.js');
  const err = (status, message, data = {}) => Object.assign(new Error(message), { status, data });
  assert.match(errorHint(err(402, 'Strict budget: needs approval', { approvalId: 'a1' })), /budget_status.*decide_approval/);
  assert.match(errorHint(err(402, 'Daily limit reached')), /budget_status/);
  assert.match(errorHint(err(409, 'Lip sync is turned off for this storyboard (Settings).')), /off by default/);
  assert.match(errorHint(err(409, 'Pip is locked (approved).')), /locked: false/);
  assert.match(errorHint(err(409, 'A job is already running')), /watch_jobs/);
  assert.match(errorHint(err(501, 'Enhancing video needs ffmpeg')), /apt install ffmpeg/);
  assert.match(errorHint(err(501, 'RIFE missing')), /install/);
  assert.match(errorHint(err(422, 'Mouth not found', { needBox: true })), /mouthBox/);
  assert.match(errorHint(err(404, 'Not found')), /list_projects/);
  assert.equal(errorHint(new Error('plain')), '');

  const { client } = await connectStub(null, { call: async () => { throw err(409, 'Lip sync is turned off for this storyboard (Settings).'); } });
  const result = await client.callTool({ name: 'lip_sync_shot', arguments: { shotId: 's1' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Lip sync is turned off/);
  assert.match(result.content[0].text, /Hint:/);
});
