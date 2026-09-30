import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/db.js';
import { createRepo } from '../src/repo.js';
import { startTestApp, tempRoot, tinyPngDataUrl } from './helpers.js';

const generateBody = (projectId, extra = {}) => ({ projectId, prompt: 'a calm harbor at dawn', provider: 'mock', model: 'mock-image', size: '1536x1024', ...extra });

test('rejects requests without the token and from foreign hosts or origins', async () => {
  const t = await startTestApp();
  try {
    assert.equal((await t.call('GET', '/api/projects', null, { auth: false })).status, 401);
    assert.equal((await t.call('GET', '/api/projects', null, { headers: { authorization: 'Bearer nope' }, auth: false })).status, 401);
    assert.equal((await t.call('POST', '/api/projects', { name: 'x' }, { headers: { origin: 'http://evil.test' } })).status, 403);
    const launch = await fetch(t.app.launchUrl, { redirect: 'manual' });
    assert.equal(launch.status, 302);
    assert.match(launch.headers.get('set-cookie'), /lumina_token=.+HttpOnly; SameSite=Strict/);
    const cookie = launch.headers.get('set-cookie').split(';')[0];
    assert.equal((await t.call('GET', '/api/projects', null, { auth: false, headers: { cookie } })).status, 200);
    const page = await t.call('GET', '/', null, { auth: false });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(statSync(t.app.tokenFile).mode & 0o777, 0o600);
  } finally {
    await t.close();
  }
});

test('reference upload is stored and served from its saved URL; traversal is blocked', async () => {
  const t = await startTestApp();
  try {
    const { project } = (await t.call('POST', '/api/projects', { name: 'Refs' })).body;
    const bad = await t.call('POST', '/api/assets', { projectId: project.id, dataUrl: 'data:image/png;base64,aGVsbG8=' });
    assert.equal(bad.status, 400);
    const { asset } = (await t.call('POST', '/api/assets', { projectId: project.id, dataUrl: tinyPngDataUrl(), label: 'red' })).body;
    assert.equal(asset.kind, 'reference');
    const served = await fetch(`${t.app.origin}${asset.path}`, { headers: { authorization: `Bearer ${t.app.token}` } });
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    const traversal = await fetch(`${t.app.origin}/assets/..%2F..%2Fdata%2Fkeys.json`, { headers: { authorization: `Bearer ${t.app.token}` } });
    assert.equal(traversal.status, 404);
    const library = (await t.call('GET', '/api/assets?kind=reference')).body.assets;
    assert.ok(library.some((a) => a.id === asset.id));
  } finally {
    await t.close();
  }
});

test('generation runs as a background job, persists, and survives a restart', async () => {
  const t = await startTestApp();
  const { project } = (await t.call('POST', '/api/projects', { name: 'Jobs' })).body;
  const queued = await t.call('POST', '/api/generate', generateBody(project.id, { director: 'mock:mock-director' }));
  assert.equal(queued.status, 202);
  assert.equal(queued.body.generation.status, 'queued');
  const done = (await t.call('POST', `/api/generations/${queued.body.generation.id}/wait`, {})).body.generation;
  assert.equal(done.status, 'completed');
  assert.equal(done.params.size, '1536x1024');
  assert.match(done.finalPrompt, /cinematic lighting/);
  const image = await fetch(`${t.app.origin}${done.assetPath}`, { headers: { authorization: `Bearer ${t.app.token}` } });
  assert.equal(image.status, 200);
  await t.close({ keep: true });

  const again = await startTestApp({ dataRoot: t.dataRoot });
  try {
    const reloaded = (await again.call('GET', `/api/projects/${project.id}`)).body;
    assert.equal(reloaded.generations[0].id, done.id);
    assert.equal(reloaded.generations[0].assetPath, done.assetPath);
    // Variation of the stored output: lineage points back at the source image.
    const variation = (await again.call('POST', '/api/generate', generateBody(project.id, { inputAssetIds: [done.assetId], operation: 'variation' }))).body.generation;
    const finished = (await again.call('POST', `/api/generations/${variation.id}/wait`, {})).body.generation;
    assert.equal(finished.status, 'completed');
    assert.equal(finished.operation, 'variation');
    const asset = reloaded.assets.find((a) => a.id === done.assetId);
    assert.equal(asset.generationId, done.id);
    const assets = (await again.call('GET', `/api/projects/${project.id}`)).body.assets;
    assert.equal(assets.find((a) => a.id === finished.assetId).parentAssetId, done.assetId);
  } finally {
    await again.close();
  }
});

test('failed generation records a friendly error and can be retried', async () => {
  const t = await startTestApp();
  try {
    const { project } = (await t.call('POST', '/api/projects', { name: 'Fail' })).body;
    const job = (await t.call('POST', '/api/generate', generateBody(project.id, { prompt: 'boom [fail]' }))).body.generation;
    const failed = (await t.call('POST', `/api/generations/${job.id}/wait`, {})).body.generation;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorCategory, 'policy');
    assert.match(failed.userError, /declined/);
    const retry = await t.call('POST', `/api/generations/${job.id}/retry`, {});
    assert.equal(retry.status, 202);
    assert.notEqual(retry.body.generation.id, job.id);
  } finally {
    await t.close();
  }
});

test('validates requests against model capabilities and key presence', async () => {
  const t = await startTestApp();
  try {
    const { project } = (await t.call('POST', '/api/projects', { name: 'Validate' })).body;
    const noKey = await t.call('POST', '/api/generate', generateBody(project.id, { provider: 'openai', model: 'gpt-image-2.5-flare' }));
    assert.equal(noKey.status, 400);
    assert.match(noKey.body.error, /API key/);
    const badModel = await t.call('POST', '/api/generate', generateBody(project.id, { model: 'nope' }));
    assert.equal(badModel.status, 400);
    const empty = await t.call('POST', '/api/generate', generateBody(project.id, { prompt: '  ' }));
    assert.equal(empty.status, 400);
    const missingProject = await t.call('POST', '/api/generate', generateBody('00000000-0000-0000-0000-000000000000'));
    assert.equal(missingProject.status, 404);
  } finally {
    await t.close();
  }
});

test('keys are stored 0600, never returned, and status reports their source', async () => {
  const t = await startTestApp();
  try {
    const saved = await t.call('PUT', '/api/settings/keys/fal', { key: 'fal-test-key-123' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.keys.fal.source, 'saved');
    assert.equal(saved.body.keys.fal.encrypted, false);
    assert.doesNotMatch(saved.text, /fal-test-key-123/);
    const file = path.join(t.dataRoot, 'data', 'keys.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const catalog = (await t.call('GET', '/api/catalog')).body;
    assert.equal(catalog.providers.find((p) => p.id === 'fal').ready, true);
    assert.doesNotMatch(JSON.stringify(catalog), /fal-test-key-123/);
    assert.equal((await t.call('PUT', '/api/settings/keys/fal', { key: 'has space' })).status, 400);
    const removed = await t.call('DELETE', '/api/settings/keys/fal');
    assert.equal(removed.body.keys.fal.configured, false);
  } finally {
    await t.close();
  }
});

test('project rename, export and delete remove files', async () => {
  const t = await startTestApp();
  try {
    const { project } = (await t.call('POST', '/api/projects', { name: 'Old' })).body;
    assert.equal((await t.call('PATCH', `/api/projects/${project.id}`, { name: 'New name' })).body.project.name, 'New name');
    const { asset } = (await t.call('POST', '/api/assets', { projectId: project.id, dataUrl: tinyPngDataUrl() })).body;
    const exported = (await t.call('POST', `/api/projects/${project.id}/export`, {})).body;
    assert.equal(exported.assets, 1);
    assert.ok(existsSync(path.join(exported.folder, 'assets', asset.file)));
    assert.equal(JSON.parse(readFileSync(path.join(exported.folder, 'project.json'), 'utf8')).project.name, 'New name');
    assert.equal((await t.call('DELETE', `/api/projects/${project.id}`)).status, 200);
    assert.equal(existsSync(path.join(t.dataRoot, 'storage', 'assets', asset.file)), false);
    assert.equal((await t.call('GET', `/api/projects/${project.id}`)).status, 404);
  } finally {
    await t.close();
  }
});

test('imports v0.1 JSON stores once and marks unfinished work interrupted', () => {
  const root = tempRoot();
  const dataDir = path.join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const projectId = '574a4544-b297-4f3c-a074-9ea524f93ba6';
  writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([{ id: projectId, name: 'Smoke Project', createdAt: '2026-09-30T02:34:51.114Z', updatedAt: '2026-09-30T02:34:51.114Z' }]));
  writeFileSync(path.join(dataDir, 'assets.json'), JSON.stringify([{ id: 'a1', projectId, kind: 'generation', mimeType: 'image/png', path: '/assets/a1.png', createdAt: '2026-09-30T02:35:00Z', size: 10 }]));
  writeFileSync(path.join(dataDir, 'generations.json'), JSON.stringify([
    { id: 'g1', projectId, prompt: 'done', status: 'completed', assetId: 'a1', createdAt: '2026-09-30T02:35:00Z' },
    { id: 'g2', projectId, prompt: 'stuck', status: 'processing', createdAt: '2026-09-30T02:36:00Z' },
  ]));
  const db = openDatabase(dataDir);
  const repo = createRepo(db);
  assert.equal(repo.projects.get(projectId).name, 'Smoke Project');
  assert.equal(repo.generations.get('g1').assetPath, '/assets/a1.png');
  assert.equal(repo.generations.get('g2').status, 'interrupted');
  assert.ok(existsSync(path.join(dataDir, 'projects.json.imported')));
  db.close();
  const reopened = openDatabase(dataDir);
  assert.equal(createRepo(reopened).projects.list().length, 1);
  reopened.close();
});
