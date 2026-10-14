import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startTestApp } from './helpers.js';

process.env.LUMINA_FAKE_BAKE = '1'; // stand-in trainer: tiny pictures, empty LoRA, records what it was asked to train

const settle = async (t, id) => {
  for (let i = 0; i < 200; i++) {
    const s = (await t.call('GET', `/api/characters/${id}/bake`)).body;
    if (!s.job?.busy) return s;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('bake did not settle');
};

async function withCharacter(fn) {
  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Bake review' })).body.project;
    const character = (await t.call('POST', '/api/characters', { name: 'Rei', kind: 'person', designTags: '1girl, silver hair, red eyes' })).body.character;
    const sheet = (await t.call('POST', `/api/characters/${character.id}/sheet`, { projectId: project.id, provider: 'mock', model: 'mock-image' })).body.generation;
    await t.call('POST', `/api/generations/${sheet.id}/wait`, { timeoutMs: 10_000 });
    for (let i = 0; i < 50 && !(await t.call('GET', '/api/characters')).body.characters.find((c) => c.id === character.id).referenceAssetIds.length; i++) await new Promise((r) => setTimeout(r, 20));
    await fn(t, character, `/api/characters/${character.id}/bake`);
  } finally {
    await t.close();
  }
}
const trainRequest = (t, id) => JSON.parse(readFileSync(path.join(t.dataRoot, 'loras', id, 'train-request.json'), 'utf8'));

test('bake review: draw, reject + redraw, train only the approved pictures with their mirror flags', async () => {
  await withCharacter(async (t, character, url) => {
    const started = await t.call('POST', url, {});
    assert.equal(started.status, 202);
    assert.equal(started.body.job.state, 'drawing');
    const drawn = await settle(t, character.id);
    assert.equal(drawn.job.state, 'review');
    assert.equal(drawn.baked, null, 'drawing alone trains nothing');
    assert.equal(drawn.pictures.length, 16);
    assert.deepEqual(drawn.review, { approved: 0, rejected: 0, undecided: 16, mirrorOk: true, minApproved: 8 });

    // The picture route serves by number, from the bake folder only.
    const picture = await t.call('GET', drawn.pictures[3].url);
    assert.equal(picture.status, 200);
    assert.match(picture.headers.get('content-type'), /image\/png/);
    assert.equal((await t.call('GET', `${url}/pictures/99`)).status, 404);
    assert.equal((await t.call('GET', `${url}/pictures/1234`)).status, 404);

    // Too few approved: refused.
    await t.call('POST', `${url}/review`, { approved: [0, 1, 2, 3, 4, 5, 6] });
    const few = await t.call('POST', `${url}/train`, {});
    assert.equal(few.status, 400);
    assert.match(few.body.error, /at least 8/);
    assert.equal((await t.call('POST', `${url}/redraw`, {})).status, 400, 'nothing rejected yet');
    assert.equal((await t.call('POST', `${url}/review`, { approved: [99] })).status, 400);
    assert.equal((await t.call('POST', `${url}/review`, { approved: [1], rejected: [1] })).status, 400);

    // Reject two, redraw them: they come back undecided with a new picture.
    const before = (await t.call('GET', drawn.pictures[7].url)).text;
    await t.call('POST', `${url}/review`, { rejected: [7, 9] });
    const redrawn = await t.call('POST', `${url}/redraw`, {});
    assert.equal(redrawn.status, 202);
    const afterRedraw = await settle(t, character.id);
    assert.equal(afterRedraw.job.state, 'review');
    assert.equal(afterRedraw.pictures[7].approved, null);
    assert.equal(afterRedraw.pictures[2].approved, true);
    assert.equal(afterRedraw.pictures[0].approved, true, 'untouched pictures keep their decision');
    assert.notEqual(afterRedraw.pictures[7].url, drawn.pictures[7].url, 'new version so the browser does not show the old one');
    assert.notEqual((await t.call('GET', afterRedraw.pictures[7].url)).text, before);

    // Approve 9 (0-6, 7, 8), turn the mirror off for one picture, leave the rest undecided / rejected.
    await t.call('POST', `${url}/review`, { approved: [7, 8], rejected: [9, 10], mirror: { 2: false } });
    const ready = (await t.call('GET', url)).body;
    assert.equal(ready.review.approved, 9);
    assert.equal(ready.pictures[2].mirror, false);
    assert.equal(ready.pictures[3].mirror, true);

    const training = await t.call('POST', `${url}/train`, {});
    assert.equal(training.status, 202);
    const done = await settle(t, character.id);
    assert.equal(done.job.state, 'completed', JSON.stringify(done.job));
    assert.match(done.baked.trigger, /^lmn[a-f0-9]{8}$/);
    assert.deepEqual(done.pictures, [], 'the review is over');
    const request = trainRequest(t, character.id);
    assert.deepEqual(request.pictures.map((p) => p.framing), [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => `framing ${i}`), 'only approved pictures');
    assert.deepEqual(request.pictures.map((p) => p.mirror), [true, true, false, true, true, true, true, true, true]);
    assert.equal((await t.call('POST', `${url}/train`, {})).status, 409, 'pictures are gone after training');
  });
});

test('bake review: the character-wide mirror switch turns every flipped copy off', async () => {
  await withCharacter(async (t, character, url) => {
    await t.call('POST', url, { mirrorOk: false });
    const drawn = await settle(t, character.id);
    assert.equal(drawn.review.mirrorOk, false);
    assert.ok(drawn.pictures.every((p) => p.mirror === false));
    await t.call('POST', `${url}/review`, { approved: drawn.pictures.slice(0, 8).map((p) => p.index), mirror: { 0: true } });
    assert.equal((await t.call('POST', `${url}/train`, {})).status, 202);
    await settle(t, character.id);
    const flags = trainRequest(t, character.id).pictures.map((p) => p.mirror);
    assert.deepEqual(flags, [true, false, false, false, false, false, false, false]);
    // Switching the character-wide default back resets the per-picture choices.
    await t.call('POST', url, { mirrorOk: false });
    await settle(t, character.id);
    await t.call('POST', `${url}/review`, { mirror: { 0: true } });
    const reset = (await t.call('POST', `${url}/review`, { mirrorOk: true })).body;
    assert.ok(reset.pictures.every((p) => p.mirror === true));
  });
});

test('bake review: auto mode draws and trains everything in one go; busy and missing cases are refused', async () => {
  await withCharacter(async (t, character, url) => {
    assert.equal((await t.call('POST', `${url}/train`, {})).status, 409, 'nothing drawn yet');
    assert.equal((await t.call('POST', `${url}/review`, { approved: [0] })).status, 409);
    const started = await t.call('POST', url, { auto: true });
    assert.equal(started.status, 202);
    const done = await settle(t, character.id);
    assert.equal(done.job.state, 'completed');
    assert.deepEqual(done.pictures, []);
    assert.deepEqual(trainRequest(t, character.id), { auto: true, mirror: true });
  });
});
