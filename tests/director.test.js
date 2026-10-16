import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startTestApp } from './helpers.js';

async function fixture(t) {
  const app = await startTestApp();
  t.after(() => app.close());
  const { call } = app;
  const project = (await call('POST', '/api/projects', { name: 'Director' })).body.project;
  const hero = (await call('POST', '/api/characters', { name: 'Pip', designTags: 'amber eyes, green scarf', description: 'A curious fox' })).body.character;
  const place = (await call('POST', '/api/characters', { name: 'Lake', kind: 'location', description: 'Reeds under blue mist' })).body.character;
  const board = (await call('POST', `/api/projects/${project.id}/storyboards`, {
    title: 'Dawn', idea: 'Pip finds the lake', screenplay: 'Pip arrives. Pip waits.',
    settings: { characterIds: [hero.id, place.id], look: 'anime', lookBible: 'Indigo shadows, copper sunrise', style: 'watercolor',
      imageProvider: 'mock', imageModel: 'mock-image', videoProvider: 'mock', videoModel: 'mock-video' },
  })).body.sequence;
  const imported = await call('POST', `/api/storyboards/${board.id}/import-plan`, { shots: [
    { description: 'Pip walks through the reeds', duration: 4, camera: 'dolly-in', details: { characterIds: [hero.id], locationId: place.id, startState: 'At the reeds', endState: 'At the shore', timing: 'twos', dialogue: [{ speaker: hero.id, text: 'Hello lake' }] } },
    { description: 'Pip watches the dawn', duration: 4 },
  ] });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  return { ...app, board, hero, place, shots: imported.body.shots };
}

async function generate(f, shotId, kind = 'frame') {
  const queued = await f.call('POST', `/api/shots/${shotId}/${kind === 'frame' ? 'frame' : 'animate'}`, {});
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  const result = await f.call('POST', `/api/generations/${queued.body.generation.id}/wait`, { timeoutMs: 20000 });
  assert.equal(result.body.generation.status, 'completed', JSON.stringify(result.body));
  return result.body.generation;
}

const direct = (f, body, id = f.shots[0].id) => f.call('POST', `/api/shots/${id}/direct`, body);
const preview = async (f, id = f.shots[0].id) => {
  const response = await f.call('GET', `/api/shots/${id}/prompts`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
};

test('director overrides reach the image and clip provider with automatic identity and look blocks', async (t) => {
  const f = await fixture(t);
  assert.equal((await direct(f, { framePrompt: 'A tiny fox beneath an immense sky', clipPrompt: 'A single ripple spreads', negativePrompt: 'extra tails' })).status, 200);
  const prompts = await preview(f);
  assert.match(prompts.framePrompt, /^A tiny fox beneath an immense sky/);
  assert.match(prompts.framePrompt, /amber eyes, green scarf/);
  assert.match(prompts.framePrompt, /Indigo shadows, copper sunrise/);
  assert.match(prompts.framePrompt, /Consistency:/);
  assert.match(prompts.framePrompt, /extra tails/);
  assert.doesNotMatch(prompts.framePrompt, /Pip walks through the reeds/);
  const frame = await generate(f, f.shots[0].id);
  assert.equal(frame.finalPrompt, prompts.framePrompt);
  assert.equal(frame.director, null);
  const clip = await generate(f, f.shots[0].id, 'clip');
  assert.equal(clip.finalPrompt, (await preview(f)).clipPrompt);
  assert.match(clip.finalPrompt, /^A single ripple spreads/);
});

test('verbatim direction bypasses automatic look, identity and camera/style presets', async (t) => {
  const f = await fixture(t);
  const automatic = await preview(f);
  assert.equal((await direct(f, { framePrompt: 'Just a silhouette.', clipPrompt: 'Hold.', keepAutomatic: false })).status, 200);
  const prompts = await preview(f);
  assert.equal(prompts.framePrompt, 'Just a silhouette.');
  assert.equal(prompts.clipPrompt, 'Hold.');
  assert.equal((await generate(f, f.shots[0].id)).finalPrompt, 'Just a silhouette.');
  assert.equal((await generate(f, f.shots[0].id, 'clip')).finalPrompt, 'Hold.');
  await direct(f, { framePrompt: null, clipPrompt: null });
  assert.deepEqual(await preview(f), automatic, 'clearing restores automatic text even when keepAutomatic remains false');
});

test('clearing direction restores automatic prompts and ordinary shot edits preserve overrides', async (t) => {
  const f = await fixture(t);
  const before = await preview(f);
  await direct(f, { framePrompt: 'Overhead fox', clipPrompt: 'Orbit slowly' });
  await f.call('PATCH', `/api/shots/${f.shots[0].id}`, { details: { timing: 'threes' } });
  assert.match((await preview(f)).framePrompt, /^Overhead fox/);
  assert.equal((await direct(f, { framePrompt: null, clipPrompt: null })).status, 200);
  assert.deepEqual(await preview(f), before);
  assert.equal((await generate(f, f.shots[0].id)).finalPrompt, before.framePrompt);
});

test('negative direction can be cleared without clearing a positive override', async (t) => {
  const f = await fixture(t);
  await direct(f, { framePrompt: 'Pip at dawn', negativePrompt: 'purple clouds' });
  assert.match((await preview(f)).framePrompt, /Avoid: purple clouds/);
  await direct(f, { negativePrompt: null });
  const prompts = await preview(f);
  assert.match(prompts.framePrompt, /^Pip at dawn/);
  assert.doesNotMatch(prompts.framePrompt, /purple clouds/);
  assert.equal((await generate(f, f.shots[0].id)).finalPrompt, prompts.framePrompt);
});

test('direction invalidates approved frames and accepted clips, and respects story locks', async (t) => {
  const f = await fixture(t);
  const shotId = f.shots[0].id;
  const frame = await generate(f, shotId);
  await f.call('POST', `/api/shots/${shotId}/approve-frame`, {});
  await generate(f, shotId, 'clip');
  await f.call('POST', `/api/shots/${shotId}/review`, { status: 'accepted' });
  await f.call('POST', `/api/shots/${shotId}/approve-frame`, {});
  assert.equal((await f.call('GET', `/api/shots/${shotId}`)).body.shot.review.frameApproved, frame.assetId);
  await direct(f, { clipPrompt: 'A new ripple' });
  let shot = (await f.call('GET', `/api/shots/${shotId}`)).body.shot;
  assert.equal(shot.imageAssetId, frame.assetId);
  assert.equal(shot.review.frameApproved, null);
  assert.equal(shot.review.status, 'pending');
  await f.call('PATCH', `/api/shots/${shotId}`, { details: { locked: true } });
  assert.equal((await direct(f, { framePrompt: 'Forbidden revision' })).status, 409);
  shot = (await f.call('GET', `/api/shots/${shotId}`)).body.shot;
  assert.equal(shot.details.directorFramePrompt, null);
});

test('batch direction validates all shot ids, ownership, locks and fields before saving', async (t) => {
  const f = await fixture(t);
  const batch = (shots) => f.call('POST', `/api/storyboards/${f.board.id}/direct`, { shots });
  const before = f.app.repo.shots.get(f.shots[0].id);
  for (const bad of [
    { shotId: '00000000-0000-4000-8000-000000000000', framePrompt: 'Missing' },
    { shotId: f.shots[1].id, keepAutomatic: 'false' },
    { shotId: f.shots[1].id, camera: 'not-a-camera' },
    { shotId: f.shots[1].id, motion: 'not-a-motion' },
    { shotId: f.shots[1].id, framePrompt: 'x'.repeat(4000) },
    { shotId: f.shots[1].id, framePrompt: '' },
  ]) {
    const result = await batch([{ shotId: f.shots[0].id, framePrompt: 'Must not save' }, bad]);
    assert.ok(result.status >= 400, JSON.stringify(result.body));
    assert.deepEqual(f.app.repo.shots.get(f.shots[0].id), before);
  }
  const foreign = f.app.repo.sequences.create({ projectId: f.board.projectId, title: 'Elsewhere', settings: {} });
  const foreignShot = f.app.repo.shots.insert(foreign.id, { position: 1, description: 'Other' });
  assert.equal((await batch([{ shotId: f.shots[0].id, framePrompt: 'Must not save' }, { shotId: foreignShot.id, framePrompt: 'Other' }])).status, 400);
  await f.call('PATCH', `/api/shots/${f.shots[1].id}`, { details: { locked: true } });
  assert.equal((await batch(f.shots.map((s) => ({ shotId: s.id, framePrompt: 'Must not save' })))).status, 409);
  assert.deepEqual(f.app.repo.shots.get(f.shots[0].id), before);
  await f.call('PATCH', `/api/shots/${f.shots[1].id}`, { details: { locked: false } });
  assert.equal((await batch(f.shots.map((s, i) => ({ shotId: s.id, framePrompt: `Direction ${i}`, camera: 'locked-off', motion: 'push-in' })))).status, 200);
  assert.match((await preview(f, f.shots[1].id)).framePrompt, /^Direction 1/);
});

test('direction rejects a composed prompt over the generation limit before changing a shot', async (t) => {
  const f = await fixture(t);
  const before = f.app.repo.shots.get(f.shots[0].id);
  assert.equal((await direct(f, { framePrompt: 'x'.repeat(4000) })).status, 400);
  assert.deepEqual(f.app.repo.shots.get(f.shots[0].id), before);
  assert.equal((await direct(f, { framePrompt: 'x'.repeat(4000), keepAutomatic: false })).status, 200);
  assert.equal((await generate(f, f.shots[0].id)).finalPrompt, 'x'.repeat(4000));
});

test('director brief paginates shots, includes the cast and film brief, and matches actual generation prompts', async (t) => {
  const f = await fixture(t);
  const frame = await generate(f, f.shots[0].id);
  await f.call('PATCH', `/api/characters/${f.hero.id}`, { referenceAssetIds: [frame.assetId] });
  f.app.repo.settings.set(`bake:${f.hero.id}`, { path: '/synthetic/lora', trigger: 'pip' });
  const first = await f.call('GET', `/api/storyboards/${f.board.id}/director-brief?offset=0&limit=1`);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.total, 2);
  assert.equal(first.body.nextOffset, 1);
  assert.equal(first.body.shots.length, 1);
  assert.equal(first.body.idea, 'Pip finds the lake');
  assert.equal(first.body.screenplay, 'Pip arrives. Pip waits.');
  assert.equal(first.body.look, 'anime');
  assert.equal(first.body.characters[0].baked, true);
  assert.deepEqual(first.body.characters[0].referenceAssetIds, [frame.assetId]);
  assert.equal(first.body.characters[0].voice, null);
  assert.equal(first.body.locations[0].name, 'Lake');
  const shot = first.body.shots[0];
  assert.equal(shot.timing, 'twos');
  assert.equal(shot.startState, 'At the reeds');
  assert.equal(shot.dialogue[0].text, 'Hello lake');
  assert.equal(shot.framePrompt, (await generate(f, shot.shotId)).finalPrompt);
  assert.equal(shot.clipPrompt, (await generate(f, shot.shotId, 'clip')).finalPrompt);
  const second = (await f.call('GET', `/api/storyboards/${f.board.id}/director-brief?offset=1&limit=1`)).body;
  assert.equal(second.shots[0].shotId, f.shots[1].id);
  assert.equal(second.nextOffset, null);
  const all = await f.call('GET', `/api/storyboards/${f.board.id}/prompts`);
  assert.equal(all.body.shots.length, 2);
  assert.equal(all.body.shots[0].framePrompt, shot.framePrompt);
  assert.equal((await f.call('GET', `/api/storyboards/${f.board.id}/director-brief?limit=-1`)).status, 400);
  const end = (await f.call('GET', `/api/storyboards/${f.board.id}/director-brief?offset=2&limit=1`)).body;
  assert.deepEqual(end.shots, []);
  assert.equal(end.nextOffset, null);
});

test('MCP exposes and executes all four director tools without a writer model', async (t) => {
  const f = await fixture(t);
  f.app.repo.settings.set('budget', { enabled: true, strictPrices: true, confirmPaid: false });
  const client = new Client({ name: 'director-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL('../mcp/server.js', import.meta.url).pathname], env: { ...process.env, LUMINA_DATA_DIR: f.dataRoot }, stderr: 'ignore' }));
  t.after(() => client.close());
  const tools = (await client.listTools()).tools;
  const run = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return JSON.parse(response.content.find((c) => c.type === 'text').text);
  };
  for (const name of ['get_director_brief', 'direct_shot', 'direct_storyboard', 'preview_prompts']) assert.ok(tools.some((x) => x.name === name));
  await run('direct_shot', { shotId: f.shots[0].id, framePrompt: 'From the connected AI' });
  await run('direct_storyboard', { storyboardId: f.board.id, shots: [{ shotId: f.shots[1].id, clipPrompt: 'Dawn breaks' }] });
  assert.match((await run('preview_prompts', { shotId: f.shots[0].id })).framePrompt, /^From the connected AI/);
  assert.equal((await run('preview_prompts', { storyboardId: f.board.id })).shots.length, 2);
  assert.equal((await run('get_director_brief', { storyboardId: f.board.id, offset: 1, limit: 1 })).shots[0].shotId, f.shots[1].id);
  for (const args of [{}, { storyboardId: f.board.id, shotId: f.shots[0].id }]) {
    assert.equal((await client.callTool({ name: 'preview_prompts', arguments: args })).isError, true);
  }
});
