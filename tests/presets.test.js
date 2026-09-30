import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPresets, composePrompt, presets } from '../src/presets.js';
import { startTestApp } from './helpers.js';

test('preset catalog is well formed and validates per mode and group', () => {
  const ids = new Set();
  for (const p of presets) {
    assert.ok(!ids.has(p.id), `duplicate ${p.id}`);
    ids.add(p.id);
    assert.ok(p.label && p.blurb && p.fragment && p.tile?.motion && p.tile?.look, p.id);
    assert.ok(p.modes.every((m) => ['image', 'video'].includes(m)), p.id);
  }
  assert.deepEqual(checkPresets(['dolly-in', 'rain', 'noir'], 'video'), ['dolly-in', 'rain', 'noir']);
  assert.deepEqual(checkPresets(undefined, 'generate'), []);
  assert.throws(() => checkPresets(['dolly-in'], 'generate'), /not image/);
  assert.throws(() => checkPresets(['dolly-in', 'orbit-left'], 'video'), /one camera preset/);
  assert.throws(() => checkPresets(['nope'], 'video'), /Unknown preset/);
  assert.equal(composePrompt('a fox', []), 'a fox');
  assert.match(composePrompt('a fox', ['dolly-in', 'noir']), /^a fox\n\nCamera: .*dolly.*\nStyle: .*noir/s);
});

test('presets flow through the API into the provider prompt and survive retry', async () => {
  const t = await startTestApp();
  try {
    const listed = await t.call('GET', '/api/presets');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.groups.camera && listed.body.presets.length >= 40);

    const project = (await t.call('POST', '/api/projects', { name: 'Presets' })).body.project;
    const base = { projectId: project.id, prompt: 'a lighthouse on a cliff', provider: 'mock' };
    const video = await t.call('POST', '/api/generate', { ...base, model: 'mock-video', operation: 'video', presets: ['crane-up', 'fog', 'cinematic'] });
    assert.equal(video.status, 202);
    assert.deepEqual(video.body.generation.params.presets, ['crane-up', 'fog', 'cinematic']);
    const done = (await t.call('POST', `/api/generations/${video.body.generation.id}/wait`, { timeoutMs: 10_000 })).body.generation;
    assert.equal(done.status, 'completed');
    assert.equal(done.prompt, 'a lighthouse on a cliff');
    assert.match(done.finalPrompt, /crane.*\n.*fog.*\n.*cinematic/is);

    const wrongMode = await t.call('POST', '/api/generate', { ...base, model: 'mock-image', presets: ['orbit-left'] });
    assert.equal(wrongMode.status, 400);
    assert.match(wrongMode.body.error, /not image/);
    const twoStyles = await t.call('POST', '/api/generate', { ...base, model: 'mock-image', presets: ['noir', 'anime'] });
    assert.equal(twoStyles.status, 400);

    const failing = await t.call('POST', '/api/generate', { ...base, prompt: 'boom [fail]', model: 'mock-image', presets: ['watercolor'] });
    const failed = (await t.call('POST', `/api/generations/${failing.body.generation.id}/wait`, { timeoutMs: 10_000 })).body.generation;
    assert.equal(failed.status, 'failed');
    const retried = await t.call('POST', `/api/generations/${failed.id}/retry`, {});
    assert.deepEqual(retried.body.generation.params.presets, ['watercolor']);
  } finally {
    await t.close();
  }
});
