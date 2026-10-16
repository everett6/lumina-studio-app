import assert from 'node:assert/strict';
import { existsSync, lstatSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startTestApp, tinyPngDataUrl } from './helpers.js';

const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../mcp/server.js');
const parse = (result) => JSON.parse(result.content.find((c) => c.type === 'text').text);

test('library and project management over MCP', async (suite) => {
  const t = await startTestApp();
  const client = new Client({ name: 'library-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, LUMINA_DATA_DIR: t.dataRoot }, stderr: 'ignore' }));
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const good = async (name, args) => { const result = await call(name, args); assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`); return parse(result); };
  const api = async (method, url, body) => { const result = await t.call(method, url, body); assert.ok(result.status < 300, result.text); return result.body; };
  const project = parse(await call('create_project', { name: 'Library' }));
  const upload = async (label, projectId = project.id) => (await api('POST', '/api/assets', { projectId, label, dataUrl: tinyPngDataUrl() })).asset;
  const board = (await api('POST', `/api/projects/${project.id}/storyboards`, { title: 'Original', settings: { imageProvider: 'mock', imageModel: 'mock-image' } })).sequence;
  const shot = (await api('POST', `/api/storyboards/${board.id}/shots`, { description: 'A door opens' })).shots[0];
  try {
    await suite.test('all eleven tools advertise titles, schemas and local free costs', async () => {
      const { tools } = await client.listTools();
      for (const name of ['rename_project', 'tag_assets', 'search_assets', 'asset_lineage', 'storage_usage', 'find_unused_assets', 'delete_assets', 'duplicate_storyboard', 'export_storyboard_json', 'import_storyboard_json', 'get_generation_history']) {
        const tool = tools.find((entry) => entry.name === name);
        assert.ok(tool, name); assert.ok(tool.title && tool.inputSchema); assert.match(tool.description, /Free/);
      }
    });
    await suite.test('renaming persists and tags filter stable newest-first pages', async () => {
      assert.equal((await good('rename_project', { projectId: project.id, name: 'Renamed' })).name, 'Renamed');
      const assets = [await upload('Door alpha'), await upload('Door beta'), await upload('Door gamma')];
      await good('tag_assets', { assetIds: assets.map((a) => a.id), add: ['door', 'draft'], remove: [] });
      await good('tag_assets', { assetIds: [assets[0].id], add: ['final', 'final'], remove: ['draft'] });
      assert.deepEqual(t.app.repo.settings.get(`asset-tags:${assets[0].id}`), ['door', 'final']);
      const query = { projectId: project.id, kind: 'reference', tag: 'door', text: 'DOOR', offset: 0, limit: 2 };
      const first = await good('search_assets', query);
      const second = await good('search_assets', { ...query, offset: 2 });
      assert.equal(first.total, 3); assert.equal(first.assets.length, 2); assert.equal(second.assets.length, 1);
      assert.deepEqual((await good('search_assets', query)).assets, first.assets);
      const combined = [...first.assets, ...second.assets];
      assert.equal(new Set(combined.map((a) => a.id)).size, 3);
      assert.ok(combined.every((a, i) => !i || combined[i - 1].createdAt >= a.createdAt));
      assert.equal((await good('search_assets', { ...query, tag: 'draft' })).total, 2);
      const ordered = [...assets].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      assert.deepEqual(combined.map((a) => a.id), ordered.map((a) => a.id));
      assert.equal((await good('search_assets', { ...query, to: '2000-01-01' })).total, 0);
      assert.equal((await good('search_assets', { ...query, from: '2099-01-01T00:00:00Z' })).total, 0);
      assert.equal((await call('search_assets', { from: 'nonsense' })).isError, true);
    });
    await suite.test('lineage follows an existing reframe route and includes generation billing', async () => {
      const generated = await good('generate_image', { projectId: project.id, prompt: 'A door', provider: 'mock', model: 'mock-image' });
      const derived = (await api('POST', `/api/assets/${generated.assetId}/reframe`, { aspect: '1:1' })).asset;
      const result = await good('asset_lineage', { assetId: derived.id });
      assert.equal(result.parents[0].id, generated.assetId);
      assert.equal(result.parents[0].generation.model, 'mock-image');
      assert.equal(result.parents[0].generation.prompt, 'A door');
      assert.ok('billingState' in result.parents[0].generation && 'cost' in result.parents[0].generation);
      assert.equal((await good('asset_lineage', { assetId: generated.assetId })).children[0].id, derived.id);
      const history = await good('get_generation_history', { projectId: project.id, status: 'completed', model: 'mock-image', operation: 'generate', offset: 0, limit: 1 });
      assert.equal(history.total, 1); assert.equal(history.generations[0].id, generated.id);
    });
    await suite.test('unused scan protects cues, sfx, takes, books, characters, canvas runs and film events across projects', async () => {
      const protectedAssets = [];
      const asset = async (label) => { const a = await upload(label); protectedAssets.push(a); return a; };
      const image = await asset('shot frame');
      t.app.repo.shots.update(shot.id, { imageAssetId: image.id });
      // The fixture bytes are deliberately tiny; these scans inspect references, not decoded audio.
      const cue = await asset('cue'), sfx = await asset('sfx');
      t.app.repo.sequences.update(board.id, { settings: { ...board.settings, musicCues: [{ shotId: shot.id, assetId: cue.id }] } });
      t.app.repo.shots.update(shot.id, { details: { sfx: [{ assetId: sfx.id }], dialogue: [] } });
      const take = await asset('old take');
      const g = t.app.repo.generations.create({ projectId: project.id, provider: 'mock', model: 'mock-image', operation: 'generate', prompt: 'old', bookTarget: `shot-image:${shot.id}` });
      t.app.repo.generations.update(g.id, { status: 'completed', outputAssetId: take.id });
      const book = t.app.repo.books.create({ projectId: project.id, title: 'Book' });
      const page = t.app.repo.pages.insert(book.id, { position: 1 });
      t.app.repo.pages.update(page.id, { assetId: (await asset('page')).id });
      const chapter = t.app.repo.chapters.insert(book.id, { position: 1 });
      t.app.repo.chapters.update(chapter.id, { narrationAssetId: (await asset('chapter')).id });
      t.app.repo.characters.create({ name: 'Hero', description: 'Hero', referenceAssetIds: [(await asset('character')).id] });
      const other = t.app.repo.projects.create('Other project');
      const canvas = t.app.repo.canvases.create(other.id, 'Cross project', { nodes: [{ assetId: (await asset('canvas')).id }], edges: [] });
      t.app.repo.runs.create(canvas.id, { result: { assetId: (await asset('run')).id } });
      const film = t.app.repo.films.open(board.id);
      t.app.repo.films.commit(film.id, { expectedRevision: film.revision }, [{ kind: 'checkpoint', data: { assetId: (await asset('event')).id } }]);
      const derivedTake = await asset('Derived take (lip-synced)');
      t.app.repo.assets.remove(derivedTake.id);
      t.app.repo.assets.create({ ...derivedTake, kind: 'video', parentAssetId: image.id });
      const reviewed = await asset('reviewed without controller');
      t.app.repo.settings.set(`visual-review:${board.id}`, [{ kind: 'finding', data: { takeId: reviewed.id } }]);
      const unused = await upload('Truly unused');
      const found = await good('find_unused_assets', { projectId: project.id });
      assert.ok(found.assets.some((a) => a.id === unused.id && a.size === unused.size));
      for (const a of protectedAssets) {
        assert.ok(!found.assets.some((candidate) => candidate.id === a.id), a.label);
        assert.equal((await call('delete_assets', { assetIds: [a.id], confirm: true })).isError, true, a.label);
        assert.ok(t.app.repo.assets.get(a.id));
      }
    });
    await suite.test('deletion requires confirmation, preflights the whole batch and frees real files', async () => {
      const a = await upload('delete me');
      const protectedId = t.app.repo.shots.get(shot.id).imageAssetId;
      assert.equal((await call('delete_assets', { assetIds: [a.id] })).isError, true);
      assert.equal((await call('delete_assets', { assetIds: [a.id], confirm: false })).isError, true);
      const refused = await t.call('POST', '/api/library/assets/delete', { assetIds: [a.id] });
      assert.equal(refused.status, 400);
      assert.equal((await call('delete_assets', { assetIds: [a.id, protectedId], confirm: true })).isError, true);
      const file = path.join(t.dataRoot, 'storage/assets', a.file);
      assert.ok(existsSync(file));
      await good('tag_assets', { assetIds: [a.id], add: ['trash'] });
      const removed = await good('delete_assets', { assetIds: [a.id, a.id], confirm: true });
      assert.equal(removed.bytesFreed, a.size); assert.equal(removed.deleted.length, 1);
      assert.equal(existsSync(file), false); assert.equal(t.app.repo.assets.get(a.id), undefined);
      assert.deepEqual(t.app.repo.settings.get(`asset-tags:${a.id}`), []);
    });
    await suite.test('storage measures disk files by project and kind without following symlinks', async () => {
      const outside = path.join(t.dataRoot, 'outside.bin'); writeFileSync(outside, Buffer.alloc(8192));
      const link = path.join(t.dataRoot, 'data', 'outside-link'); symlinkSync(outside, link);
      assert.ok(lstatSync(link).isSymbolicLink());
      const usage = await good('storage_usage', { projectId: project.id });
      const expected = t.app.repo.assets.listByProject(project.id).reduce((sum, a) => sum + a.size, 0);
      assert.equal(usage.assetBytes, expected); assert.equal(usage.projects[0].bytes, expected);
      assert.ok(usage.byKind.reference > 0 && usage.largest.length <= 10);
      assert.ok(usage.dataFolderBytes > 0 && usage.freeDiskBytes > 0);
    });
    await suite.test('duplicate shares media, remaps cue shots and drops film output and approvals', async () => {
      const source = t.app.repo.sequences.get(board.id);
      const frame = t.app.repo.shots.get(shot.id).imageAssetId;
      t.app.repo.sequences.update(board.id, { outputAssetId: frame, screenplay: 'INT. DOOR — DAY' });
      t.app.repo.shots.update(shot.id, { review: { status: 'accepted', frameApproved: frame } });
      t.app.repo.settings.set(`scene-state:${shot.id}`, { start: { location: 'door', characters: [{ id: t.app.repo.characters.list()[0].id, injuries: ['left arm'] }] }, end: { location: 'room' } });
      const copy = await good('duplicate_storyboard', { storyboardId: board.id, title: 'Branch' });
      assert.equal(copy.sequence.title, 'Branch'); assert.equal(copy.sequence.outputAssetId, null);
      assert.equal(copy.sequence.screenplay, 'INT. DOOR — DAY');
      assert.equal(copy.shots[0].imageAssetId, frame); assert.notEqual(copy.shots[0].id, shot.id);
      assert.equal(copy.sequence.settings.musicCues[0].assetId, source.settings.musicCues[0].assetId);
      assert.equal(copy.sequence.settings.musicCues[0].shotId, copy.shots[0].id);
      assert.deepEqual(copy.shots[0].review, {}); assert.equal(t.app.repo.films.bySequence(copy.sequence.id), undefined);
      assert.equal(t.app.repo.settings.get(`scene-state:${copy.shots[0].id}`).start.location, 'door');
      assert.deepEqual(t.app.repo.settings.get(`scene-state:${copy.shots[0].id}`).start.characters[0].injuries, ['left arm']);
    });
    await suite.test('portable export/import preserves plan, settings, media IDs and maps missing characters', async () => {
      const hero = t.app.repo.characters.list()[0];
      const current = t.app.repo.sequences.get(board.id);
      t.app.repo.sequences.update(board.id, { settings: { ...current.settings, characterIds: [hero.id] } });
      const existing = t.app.repo.shots.get(shot.id);
      t.app.repo.shots.update(shot.id, { details: { ...existing.details, characterIds: [hero.id], dialogue: [{ speaker: hero.id, text: 'Hello', assetId: null }] } });
      const exported = await good('export_storyboard_json', { storyboardId: board.id });
      assert.equal(typeof exported.json, 'string');
      assert.ok(!/"(?:file|path|imagePath|videoPath|audioPath|review|outputAssetId)"\s*:/.test(exported.json));
      const imported = await good('import_storyboard_json', { projectId: project.id, json: exported.json });
      assert.equal(imported.sequence.title, current.title); assert.equal(imported.shots[0].description, existing.description);
      assert.equal(imported.shots[0].imageAssetId, existing.imageAssetId);
      assert.equal(imported.sequence.settings.musicCues[0].shotId, imported.shots[0].id);
      assert.deepEqual(imported.sequence.settings.characterIds, [hero.id]); assert.deepEqual(imported.warnings, []);
      t.app.repo.characters.remove(hero.id);
      const missing = await good('import_storyboard_json', { projectId: project.id, json: exported.json });
      assert.deepEqual(missing.sequence.settings.characterIds, []); assert.deepEqual(missing.shots[0].details.characterIds, []);
      assert.equal(missing.shots[0].details.dialogue[0].speaker, 'none'); assert.ok(missing.warnings.length > 0);
    });
    await suite.test('invalid JSON, invalid plan shapes and embedded paths are rejected before writes', async () => {
      const exported = await good('export_storyboard_json', { storyboardId: board.id });
      const before = t.app.repo.sequences.listByProject(project.id).length;
      const plan = JSON.parse(exported.json);
      for (const json of ['{bad', 'null', '{}', JSON.stringify({ ...plan, shots: 'oops' }),
        JSON.stringify({ ...plan, shots: [{ ...plan.shots[0], duration: -1 }] }),
        JSON.stringify({ ...plan, shots: [{ ...plan.shots[0], details: { dialogue: [null] } }] }),
        JSON.stringify({ ...plan, shots: [{ ...plan.shots[0], details: { sfx: ['oops'] } }] }),
        JSON.stringify({ ...plan, shots: [{ ...plan.shots[0], details: { attachedClips: ['../../secret.mp4'] } }] }),
        JSON.stringify({ ...plan, settings: { ...plan.settings, themes: [42] } }),
        JSON.stringify({ ...plan, settings: { ...plan.settings, aspect: {} } }),
        JSON.stringify({ ...plan, shots: [{ ...plan.shots[0], details: { overlays: [null] } }] }), JSON.stringify({ ...plan, shots: [{ ...plan.shots[0], imageAssetId: '../../secret.png' }] }), JSON.stringify({ ...plan, settings: { ...plan.settings, music: { path: '/etc/passwd' } } }), JSON.stringify({ ...plan, shots: [{ ...plan.shots[0], details: { audioPath: 'file:///etc/passwd' } }] })]) {
        assert.equal((await call('import_storyboard_json', { projectId: project.id, json })).isError, true, json.slice(0, 100));
      }
      assert.equal(t.app.repo.sequences.listByProject(project.id).length, before);
    });
  } finally { await client.close(); await t.close(); }
});
