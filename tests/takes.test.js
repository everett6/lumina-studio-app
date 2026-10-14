import assert from 'node:assert/strict';
import test from 'node:test';
import { imageSize } from '../src/assets.js';
import { colourDrift, flickerScore } from '../src/qc.js';
import { startTestApp } from './helpers.js';

const wait = async (t, response) => {
  assert.equal(response.status, 202, JSON.stringify(response.body));
  return (await t.call('POST', `/api/generations/${response.body.generation.id}/wait`, { timeoutMs: 20_000 })).body.generation;
};
async function setup(t) {
  const project = (await t.call('POST', '/api/projects', { name: 'Takes' })).body.project;
  const created = await t.call('POST', `/api/projects/${project.id}/storyboards`, {
    title: 'Takes', idea: 'A fox at a lake.', writer: 'mock:mock-director',
    settings: { shotCount: 2, imageProvider: 'mock', imageModel: 'mock-image', videoProvider: 'mock', videoModel: 'mock-video' },
  });
  const id = created.body.sequence.id;
  const [shot] = (await t.call('POST', `/api/storyboards/${id}/plan`, {})).body.shots;
  return { project, id, shot };
}
const shotOf = async (t, id, shotId) => (await t.call('GET', `/api/shots/${shotId}`)).body.shot;

test('takes: every frame and clip is kept; selecting one switches the shot and resets its review', async () => {
  const t = await startTestApp();
  try {
    const { shot } = await setup(t);
    const frameA = await wait(t, await t.call('POST', `/api/shots/${shot.id}/frame`, {}));
    const frameB = await wait(t, await t.call('POST', `/api/shots/${shot.id}/frame`, { force: true }));
    const clipA = await wait(t, await t.call('POST', `/api/shots/${shot.id}/animate`, {}));
    const clipB = await wait(t, await t.call('POST', `/api/shots/${shot.id}/animate`, {}));

    const listed = (await t.call('GET', `/api/shots/${shot.id}/takes`)).body;
    assert.deepEqual(listed.frames.map((f) => f.assetId).sort(), [frameA.assetId, frameB.assetId].sort());
    assert.deepEqual(listed.clips.map((c) => c.assetId).sort(), [clipA.assetId, clipB.assetId].sort());
    assert.equal(listed.frames.filter((f) => f.current).length, 1);
    assert.equal(listed.frames.find((f) => f.current).assetId, frameB.assetId);
    assert.equal(listed.clips.find((c) => c.current).assetId, clipB.assetId);
    assert.ok(listed.frames.every((f) => f.path && f.createdAt && f.generationId));

    const back = await t.call('POST', `/api/shots/${shot.id}/takes/select`, { kind: 'frame', assetId: frameA.assetId });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal((await shotOf(t, null, shot.id)).imageAssetId, frameA.assetId);

    await t.call('POST', `/api/shots/${shot.id}/review`, { status: 'accepted' });
    const older = await t.call('POST', `/api/shots/${shot.id}/takes/select`, { kind: 'clip', assetId: clipA.assetId });
    assert.equal(older.status, 200, JSON.stringify(older.body));
    const after = await shotOf(t, null, shot.id);
    assert.equal(after.videoAssetId, clipA.assetId);
    assert.notEqual(after.review.status, 'accepted');
    assert.equal(after.review.assetId, clipA.assetId, 'checks were run for the chosen clip');

    // Not a take of this shot / bad kind / missing.
    assert.equal((await t.call('POST', `/api/shots/${shot.id}/takes/select`, { kind: 'clip', assetId: frameA.assetId })).status, 404);
    assert.equal((await t.call('POST', `/api/shots/${shot.id}/takes/select`, { kind: 'frame', assetId: clipA.assetId })).status, 404);
    assert.equal((await t.call('POST', `/api/shots/${shot.id}/takes/select`, { kind: 'audio', assetId: frameA.assetId })).status, 400);
  } finally { await t.close(); }
});

test('takes: attach an imported video as the shot clip (same project, video only)', async () => {
  const t = await startTestApp();
  try {
    const { project, shot } = await setup(t);
    const video = await wait(t, await t.call('POST', '/api/generate', { projectId: project.id, operation: 'video', prompt: 'waves', provider: 'mock', model: 'mock-video', duration: 4 }));
    const attached = await t.call('POST', `/api/shots/${shot.id}/attach-clip`, { assetId: video.assetId });
    assert.equal(attached.status, 200, JSON.stringify(attached.body));
    assert.equal((await shotOf(t, null, shot.id)).videoAssetId, video.assetId);
    const takes = (await t.call('GET', `/api/shots/${shot.id}/takes`)).body;
    assert.deepEqual(takes.clips.map((c) => [c.assetId, c.source, c.current]), [[video.assetId, 'attached', true]]);

    const image = await wait(t, await t.call('POST', '/api/generate', { projectId: project.id, prompt: 'a pear', provider: 'mock', model: 'mock-image' }));
    assert.equal((await t.call('POST', `/api/shots/${shot.id}/attach-clip`, { assetId: image.assetId })).status, 400);
    assert.equal((await t.call('POST', `/api/shots/${shot.id}/attach-clip`, { assetId: '00000000-0000-4000-8000-000000000000' })).status, 404);
    const other = (await t.call('POST', '/api/projects', { name: 'Other' })).body.project;
    const foreign = await wait(t, await t.call('POST', '/api/generate', { projectId: other.id, operation: 'video', prompt: 'x', provider: 'mock', model: 'mock-video', duration: 4 }));
    assert.equal((await t.call('POST', `/api/shots/${shot.id}/attach-clip`, { assetId: foreign.assetId })).status, 400);
  } finally { await t.close(); }
});

test('repair_frame: masks the box, inpaints, and the result is a new, unselected frame take', async () => {
  const t = await startTestApp();
  try {
    const { shot } = await setup(t);
    assert.equal((await t.call('POST', `/api/shots/${shot.id}/repair-frame`, { box: [0.1, 0.1, 0.4, 0.4], instruction: 'fix the hand' })).status, 400, 'no frame yet');
    const frame = await wait(t, await t.call('POST', `/api/shots/${shot.id}/frame`, {}));
    assert.equal((await t.call('POST', `/api/shots/${shot.id}/repair-frame`, { box: [0.5, 0.1, 0.4, 0.4], instruction: 'x' })).status, 400);
    assert.equal((await t.call('POST', `/api/shots/${shot.id}/repair-frame`, { box: [0.1, 0.1, 0.4], instruction: 'x' })).status, 400);
    assert.equal((await t.call('POST', `/api/shots/${shot.id}/repair-frame`, { box: [0.1, 0.1, 0.4, 0.4], instruction: '  ' })).status, 400);
    const none = await t.call('POST', `/api/shots/${shot.id}/repair-frame`, { box: [0.1, 0.1, 0.4, 0.4], instruction: 'x', provider: 'openai' });
    assert.equal(none.status, 409);
    assert.match(none.body.error, /No inpaint-capable image model is ready/);

    const repair = await wait(t, await t.call('POST', `/api/shots/${shot.id}/repair-frame`, { box: [0.25, 0.5, 0.75, 1], instruction: 'a clean left hand' }));
    assert.equal(repair.status, 'completed');
    assert.equal(repair.operation, 'inpaint');
    assert.deepEqual(repair.inputAssetIds, [frame.assetId]);
    const { repo, } = t.app;
    const mask = repo.assets.get(repair.params.maskAssetId);
    assert.equal(mask.kind, 'mask');
    const [frameBytes, maskBytes] = await Promise.all([frame.assetPath, mask.path].map(async (p) => Buffer.from(await (await fetch(`${t.app.origin}${p}`, { headers: { authorization: `Bearer ${t.app.token}` } })).arrayBuffer())));
    assert.deepEqual(imageSize(maskBytes), imageSize(frameBytes));

    const current = await shotOf(t, null, shot.id);
    assert.equal(current.imageAssetId, frame.assetId, 'the repair is not auto-selected');
    const takes = (await t.call('GET', `/api/shots/${shot.id}/takes`)).body;
    const fixed = takes.frames.find((f) => f.assetId === repair.assetId);
    assert.equal(fixed.source, 'repair');
    assert.equal(fixed.current, false);
    assert.equal((await t.call('POST', `/api/shots/${shot.id}/takes/select`, { kind: 'frame', assetId: repair.assetId })).status, 200);
    assert.equal((await shotOf(t, null, shot.id)).imageAssetId, repair.assetId);
  } finally { await t.close(); }
});

test('qc: flicker spikes and character-area colour drift are detected from numbers, not from pictures of anyone', () => {
  const steady = Array.from({ length: 48 }, (_, i) => 100 + Math.sin(i / 6) * 3);
  assert.equal(flickerScore(steady).spikes, 0);
  const cut = [...Array(24).fill(60), ...Array(24).fill(160)]; // one hard cut is not flicker
  assert.equal(flickerScore(cut).spikes, 0);
  const flicker = steady.map((v, i) => (i % 8 === 4 ? v + 40 : v));
  assert.ok(flickerScore(flicker).spikes >= 4, JSON.stringify(flickerScore(flicker)));
  assert.equal(flickerScore([1, 2]).spikes, 0);

  const colour = (r, g, b, n = 64) => Buffer.from(Array.from({ length: n }, () => [r, g, b]).flat());
  assert.equal(colourDrift([colour(200, 30, 30), colour(200, 30, 30), colour(205, 35, 28)]).drift, 0, 'same colour bins');
  const drifting = colourDrift([colour(200, 30, 30), colour(210, 20, 20), colour(30, 40, 200)]);
  assert.ok(drifting.drift > 0.9 && drifting.atIndex === 2);
  assert.equal(colourDrift([colour(1, 2, 3)]).drift, 0);
});
