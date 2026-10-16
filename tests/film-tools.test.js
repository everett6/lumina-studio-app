import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startTestApp } from './helpers.js';

const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../mcp/server.js');
const parse = (result) => { const raw = result.content.find((c) => c.type === 'text').text; try { return JSON.parse(raw); } catch { throw new Error(`not JSON: ${raw.slice(0, 300)}`); } };

test('film controller, autonomy policy and plan validation over MCP', async () => {
  const t = await startTestApp();
  const client = new Client({ name: 'film-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, LUMINA_DATA_DIR: t.dataRoot }, stderr: 'ignore' }));
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); if (r.isError && process.env.DEBUG_FILM) console.log('ERR', name, r.content[0].text); return r; };
  try {
    const caps = parse(await call('get_capabilities', {}));
    assert.ok(Array.isArray(caps.localModels) && Array.isArray(caps.paidProviders));
    const project = parse(await call('create_project', { name: 'Film' }));
    const board = parse(await call('create_storyboard', { projectId: project.id, title: 'Duel', idea: 'A duel.', plan: false, imageProvider: 'mock', imageModel: 'mock-image', videoProvider: 'mock', videoModel: 'mock-video' }));
    await call('import_shot_plan', { storyboardId: board.id, shots: [
      { description: 'Aiko draws her sword', duration: 3, details: { method: 'still' } },
      { description: 'Aiko faces the rival', duration: 3, details: { method: 'still', dialogue: [{ speaker: 'narrator', text: 'Steel rang.' }] } },
    ] });
    const shots = parse(await call('get_storyboard', { storyboardId: board.id })).shots;

    const film = parse(await call('start_film', { storyboardId: board.id, brief: { logline: 'A duel at dusk.' }, policy: { autoApproveFrames: true } }));
    assert.equal(film.storyboardId, board.id);
    assert.equal(parse(await call('start_film', { storyboardId: board.id })).filmId, film.filmId, 'idempotent per storyboard');
    const status = parse(await call('get_film_status', { storyboardId: board.id }));
    assert.equal(typeof status.filmRevision, 'number');

    const unknown = await call('set_autonomy_policy', { filmId: film.filmId, expectedRevision: status.filmRevision, policy: { spendMoreUsd: 100 } });
    assert.equal(unknown.isError, true, 'unknown policy keys are refused');
    assert.match(unknown.content[0].text, /Unknown policy key/);
    const stale = await call('set_autonomy_policy', { filmId: film.filmId, expectedRevision: status.filmRevision - 1, policy: { autoAcceptClips: true } });
    assert.equal(stale.isError, true, 'a stale revision is a conflict');
    const edited = parse(await call('set_autonomy_policy', { filmId: film.filmId, expectedRevision: status.filmRevision, policy: { autoAcceptClips: true, runtimeToleranceSeconds: 2 } }));
    assert.equal(edited.policy.autoAcceptClips, true);
    assert.equal(edited.policy.autoApproveFrames, true, 'existing policy keys are kept');
    assert.ok(edited.filmRevision > status.filmRevision);

    const stepped = parse(await call('film_step', { filmId: film.filmId, expectedRevision: edited.filmRevision }));
    assert.ok(stepped.filmRevision >= edited.filmRevision);
    const journal = parse(await call('get_film_journal', { filmId: film.filmId }));
    assert.ok(journal.total >= 2 && journal.events.some((e) => e.kind === 'edit'));

    // A sword that vanishes across the cut without a declared transfer is a deterministic, blocking finding.
    const hero = { id: 'aiko', position: 'left', facing: 'right', wardrobe: 'kimono', props: { held: ['sword'], worn: [] }, injuries: [], knows: [] };
    await call('set_scene_state', { shotId: shots[0].id, start: { characters: [hero], location: 'bridge', timeOfDay: 'dusk' }, end: { characters: [hero], location: 'bridge', timeOfDay: 'dusk' } });
    const empty = { ...hero, props: { held: [], worn: [] } };
    await call('set_scene_state', { shotId: shots[1].id, start: { characters: [empty], location: 'bridge', timeOfDay: 'dusk' }, end: { characters: [empty], location: 'bridge', timeOfDay: 'dusk' } });
    const report = parse(await call('validate_film_plan', { storyboardId: board.id, targetSeconds: 6, toleranceSeconds: 1 }));
    assert.match(report.scenesDeclared, /^2 of 2/);
    assert.ok(report.blocking.some((f) => f.kind === 'deterministic' && /sword|prop/i.test(`${f.rule} ${f.message}`)), JSON.stringify(report.blocking));
    assert.ok(report.blocking.some((f) => /recording/.test(f.rule)), 'the unrecorded narrator line is reported');
    assert.equal(report.runtime.seconds, 6);
  } finally {
    await client.close();
    await t.close();
  }
});
