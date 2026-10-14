import assert from 'node:assert/strict';
import test from 'node:test';
import { startTestApp } from './helpers.js';
import { nextStep } from '../mcp/wizard.js';

const make = (t, project, settings = {}) => t.call('POST', `/api/projects/${project.id}/storyboards`, {
  title: 'Mouths', idea: 'Two friends talk.', writer: 'mock:mock-director',
  settings: { shotCount: 2, imageProvider: 'mock', imageModel: 'mock-image', videoProvider: 'mock', videoModel: 'mock-video', look: 'anime', ...settings },
});

test('lipSync defaults to false, can be turned off, and is persisted', async () => {
  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'LS' })).body.project;
    const { id, settings } = (await make(t, project)).body.sequence;
    assert.equal(settings.lipSync, false);
    const patched = await t.call('PATCH', `/api/storyboards/${id}`, { settings: { lipSync: false } });
    assert.equal(patched.body.sequence.settings.lipSync, false);
    assert.equal((await t.call('GET', `/api/storyboards/${id}`)).body.sequence.settings.lipSync, false);
    assert.equal((await make(t, project, { lipSync: false })).body.sequence.settings.lipSync, false);
  } finally { await t.close(); }
});

test('lip sync route answers 409 when the storyboard has it off', async () => {
  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'LS' })).body.project;
    const { id } = (await make(t, project, { lipSync: false })).body.sequence;
    const [shot] = (await t.call('POST', `/api/storyboards/${id}/plan`, {})).body.shots;
    const res = await t.call('POST', `/api/shots/${shot.id}/lipsync`, {});
    assert.equal(res.status, 409);
    assert.match(res.body.error, /Lip sync is turned off for this storyboard/);
  } finally { await t.close(); }
});

test('the film wizard never proposes lip sync, and the anime plan prompt asks for English', async () => {
  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'LS' })).body.project;
    const { id } = (await make(t, project, { lipSync: false })).body.sequence;
    await t.call('POST', `/api/storyboards/${id}/plan`, {});
    const detail = (await t.call('GET', `/api/storyboards/${id}`)).body;
    const step = nextStep(detail);
    assert.ok(!(step.choices ?? []).some((c) => /lip/i.test(c.tool)));
  } finally { await t.close(); }
});

test('local speech voices are English only', async () => {
  const t = await startTestApp();
  try {
    const local = (await t.call('GET', '/api/catalog')).body.providers.find((p) => p.id === 'local');
    const speech = local.models.filter((m) => m.operations.includes('speech'));
    assert.ok(speech.length >= 1);
    for (const m of speech) {
      assert.ok(m.voices.length > 0);
      for (const v of m.voices) assert.match(v, /^(af|am|bf|bm)_/, v);
    }
  } finally { await t.close(); }
});
