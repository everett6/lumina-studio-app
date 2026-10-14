import assert from 'node:assert/strict';
import test from 'node:test';
import { startTestApp } from './helpers.js';

process.env.LUMINA_FAKE_BAKE = '1'; // a stand-in trainer: no GPU, writes an empty LoRA file

const settle = async (t, id) => {
  for (let i = 0; i < 100; i++) {
    const s = (await t.call('GET', `/api/characters/${id}/bake`)).body;
    if (s.job?.state !== 'running') return s;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('bake did not finish');
};

test('bake character: needs a sheet, records the LoRA and trigger, can be removed', async () => {
  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Bake' })).body.project;
    const character = (await t.call('POST', '/api/characters', { name: 'Rei', kind: 'person', designTags: '1girl, silver hair, red eyes' })).body.character;
    const early = await t.call('POST', `/api/characters/${character.id}/bake`, {});
    assert.equal(early.status, 400);
    assert.match(early.body.error, /character sheet/);

    const sheet = (await t.call('POST', `/api/characters/${character.id}/sheet`, { projectId: project.id, provider: 'mock', model: 'mock-image' })).body.generation;
    await t.call('POST', `/api/generations/${sheet.id}/wait`, { timeoutMs: 10_000 });
    for (let i = 0; i < 50 && !(await t.call('GET', '/api/characters')).body.characters.find((c) => c.id === character.id).referenceAssetIds.length; i++) await new Promise((r) => setTimeout(r, 20));

    const started = await t.call('POST', `/api/characters/${character.id}/bake`, {});
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const done = await settle(t, character.id);
    assert.equal(done.job.state, 'completed');
    assert.match(done.baked.trigger, /^lmn[a-f0-9]{8}$/);
    assert.equal(done.baked.scale, 0.8);

    const removed = (await t.call('DELETE', `/api/characters/${character.id}/bake`)).body;
    assert.equal(removed.baked, null);
    await t.call('POST', `/api/characters/${character.id}/bake`, {});
    await settle(t, character.id);
    assert.ok((await t.call('GET', `/api/characters/${character.id}/bake`)).body.baked, 'baked again');
    assert.equal((await t.call('DELETE', `/api/characters/${character.id}`)).status, 200);
    assert.equal(t.app.repo.settings.get(`bake:${character.id}`, null), null, 'deleting the character removes its LoRA record');
    assert.equal((await t.call('POST', `/api/characters/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}/bake`, {})).status, 404);
  } finally {
    await t.close();
  }
});
