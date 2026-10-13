import assert from 'node:assert/strict';
import test from 'node:test';
import { createBudget } from '../src/budget.js';
import { startTestApp } from './helpers.js';

test('production refuses missing dialogue voices before queuing any frames', async () => {
  const t = await startTestApp();
  try {
    const { project } = (await t.call('POST', '/api/projects', { name: 'Release' })).body;
    const created = (await t.call('POST', `/api/projects/${project.id}/storyboards`, { title: 'Anime', idea: 'A hero speaks', settings: { imageProvider: 'mock', imageModel: 'mock-image', videoProvider: 'mock', videoModel: 'mock-video' } })).body;
    const id = created.sequence.id;
    const shot = (await t.call('POST', `/api/storyboards/${id}/shots`, { description: 'A hero at dawn' })).body.shots[0];
    await t.call('PATCH', `/api/shots/${shot.id}`, { details: { dialogue: [{ speaker: 'narrator', text: 'We will return.' }] } });
    const result = await t.call('POST', `/api/storyboards/${id}/produce`, {});
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.match(result.body.error, /voice/i);
    assert.equal((await t.call('GET', `/api/projects/${project.id}`)).body.generations.length, 0);
  } finally { await t.close(); }
});

test('strict budget rejects unknown prices even after an approval', async () => {
  const t = await startTestApp();
  try {
    await t.call('PUT', '/api/budget', { enabled: true, strictPrices: true, totalUsd: 12 });
    assert.equal((await t.call('GET', '/api/budget')).body.settings.strictPrices, true);
    const budget = createBudget({ repo: t.app.repo });
    assert.throws(() => budget.authorize({ projectId: 'p', estimateUsd: null, signature: 'unknown', approvalId: 'approved' }), /Strict budget/);
  } finally { await t.close(); }
});

 test('MCP-authored plan is imported without paid planning; readiness reports tool blockers', async () => {
  const t = await startTestApp();
  try {
    const { project } = (await t.call('POST', '/api/projects', { name: 'Imported plan' })).body;
    const { sequence } = (await t.call('POST', `/api/projects/${project.id}/storyboards`, { title: 'Anime', idea: 'A hero speaks', settings: { imageProvider: 'mock', imageModel: 'mock-image', videoProvider: 'mock', videoModel: 'mock-video', upscale: 'anime', interpolateFps: 30, narratorVoice: { provider: 'mock', model: 'mock-voice' } } })).body;
    const imported = await t.call('POST', `/api/storyboards/${sequence.id}/import-plan`, { shots: [{ description: 'Hero at dawn', duration: 4, details: { dialogue: [{ speaker: 'narrator', text: 'We return.', style: 'calm' }] } }] });
    assert.equal(imported.status, 200);
    assert.equal(imported.body.shots[0].details.dialogue[0].style, 'calm');
    const ready = (await t.call('GET', `/api/storyboards/${sequence.id}/readiness`)).body;
    assert.equal(ready.ready, false);
    assert.ok(ready.blockers.some((b) => /RIFE/.test(b)));
    assert.ok(ready.blockers.some((b) => /Real-ESRGAN/.test(b)));
    assert.equal(ready.lipSync, false);
    assert.equal((await t.call('GET', `/api/projects/${project.id}`)).body.generations.length, 0);
    const bad = await t.call('POST', `/api/storyboards/${sequence.id}/import-plan`, { replace: true, shots: [{ description: 'Invalid', duration: 0 }] });
    assert.equal(bad.status, 400);
    assert.equal((await t.call('GET', `/api/storyboards/${sequence.id}`)).body.shots[0].description, 'Hero at dawn');
  } finally { await t.close(); }
});

test('strict budget reviews one paid shot before submitting the next', async () => {
  const t = await startTestApp();
  try {
    await t.call('PUT', '/api/budget', { enabled: true, strictPrices: true, totalUsd: 12 });
    const { project } = (await t.call('POST', '/api/projects', { name: 'Staged paid clips' })).body;
    const { sequence } = (await t.call('POST', `/api/projects/${project.id}/storyboards`, { title: 'Anime', settings: { imageProvider: 'mock', imageModel: 'mock-image', videoProvider: 'mock', videoModel: 'mock-video' } })).body;
    const { shots } = (await t.call('POST', `/api/storyboards/${sequence.id}/import-plan`, { shots: [1,2].map(i=>({description:`Shot ${i}`,duration:4})) })).body;
    for (const shot of shots) {
      const { generation } = (await t.call('POST', `/api/shots/${shot.id}/frame`, {})).body;
      await t.call('POST', `/api/generations/${generation.id}/wait`, { timeoutMs: 10000 });
      await t.call('POST', `/api/shots/${shot.id}/approve-frame`, { approved: true });
    }
    const { generation } = (await t.call('POST', `/api/shots/${shots[0].id}/animate`, {})).body;
    await t.call('POST', `/api/generations/${generation.id}/wait`, { timeoutMs: 10000 });
    const blocked = await t.call('POST', `/api/shots/${shots[1].id}/animate`, {});
    assert.equal(blocked.status,409);
    assert.match(blocked.body.error,/review shot 1/i);
    await t.call('POST', `/api/shots/${shots[0].id}/review`, { status: 'accepted' });
    const next = await t.call('POST', `/api/shots/${shots[1].id}/animate`, {});
    assert.equal(next.status,202);
    await t.call('POST', `/api/generations/${next.body.generation.id}/wait`, { timeoutMs: 10000 });
  } finally { await t.close(); }
});
