import assert from 'node:assert/strict';
import test from 'node:test';
import { startTestApp } from './helpers.js';

const tags = '1girl, silver hair, long hair, red eyes, black coat, red lining';
const mock = { provider: 'mock', model: 'mock-image' };

async function setup() {
  const t = await startTestApp();
  const project = (await t.call('POST', '/api/projects', { name: 'Sheets' })).body.project;
  return { t, project };
}
const waitFor = async (t, id) => { await t.app.jobs.waitFor(id); return t.app.repo.generations.get(id); };

test('designTags round-trip, trimmed and capped', async () => {
  const { t } = await setup();
  try {
    const created = (await t.call('POST', '/api/characters', { name: 'Mira', designTags: tags })).body.character;
    assert.equal(created.designTags, tags);
    const patched = (await t.call('PATCH', `/api/characters/${created.id}`, { designTags: 'x'.repeat(500) })).body.character;
    assert.equal(patched.designTags.length, 400);
    const listed = (await t.call('GET', '/api/characters')).body.characters[0];
    assert.equal(listed.designTags.length, 400);
  } finally { await t.close(); }
});

test('sheet route queues a turnaround and puts the result first in the references', async () => {
  const { t, project } = await setup();
  try {
    const { id } = (await t.call('POST', '/api/characters', { name: 'Mira', designTags: tags })).body.character;
    const res = await t.call('POST', `/api/characters/${id}/sheet`, { projectId: project.id, ...mock });
    assert.equal(res.status, 202);
    const g = res.body.generation;
    for (const word of ['turnaround', 'front view', 'side view', 'from behind', 'white background', tags]) assert.ok(g.prompt.includes(word), word);
    const again = (await t.call('POST', `/api/characters/${id}/sheet`, { projectId: project.id, ...mock })).body.generation;
    assert.equal(again.params.seed, g.params.seed);
    const done = await waitFor(t, g.id);
    assert.equal(done.status, 'completed');
    await waitFor(t, again.id);
    await new Promise((r) => setTimeout(r, 50));
    const refs = t.app.repo.characters.get(id).referenceAssetIds;
    const second = t.app.repo.generations.get(again.id).assetId;
    assert.ok([done.assetId, second].includes(refs[0]));
    assert.ok(refs.includes(done.assetId) && refs.includes(second));
    assert.ok(refs.length <= 4);
  } finally { await t.close(); }
});

test('expression sheet uses expression words; unknown character 404s', async () => {
  const { t, project } = await setup();
  try {
    const { id } = (await t.call('POST', '/api/characters', { name: 'Mira', description: 'a tall girl with silver hair' })).body.character;
    const g = (await t.call('POST', `/api/characters/${id}/sheet`, { projectId: project.id, expressions: true, ...mock })).body.generation;
    for (const word of ['expression sheet', 'angry', 'surprised', 'closed eyes', 'silver hair']) assert.ok(g.prompt.includes(word), word);
    await waitFor(t, g.id);
    const missing = await t.call('POST', '/api/characters/00000000-0000-4000-8000-000000000000/sheet', { projectId: project.id, ...mock });
    assert.equal(missing.status, 404);
  } finally { await t.close(); }
});

test('a character deleted while its sheet renders is handled quietly', async () => {
  const { t, project } = await setup();
  try {
    const { id } = (await t.call('POST', '/api/characters', { name: 'Gone', designTags: tags })).body.character;
    const g = (await t.call('POST', `/api/characters/${id}/sheet`, { projectId: project.id, ...mock })).body.generation;
    await t.call('DELETE', `/api/characters/${id}`);
    const done = await waitFor(t, g.id);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(done.status, 'completed');
    assert.equal(t.app.repo.characters.get(id), undefined);
  } finally { await t.close(); }
});
