import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.js';
import { createRepo } from '../src/repo.js';
import { createBudget } from '../src/budget.js';
import { createJobRunner } from '../src/jobs.js';
import fal from '../src/providers/fal.js';

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'job-regression-'));
  const db = openDatabase(dir), repo = createRepo(db);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const project = repo.projects.create({ name: 'Synthetic' });
  const budget = createBudget({ repo });
  function make(operation = 'generate', inputAssetIds = []) {
    const job = repo.generations.create({ projectId: project.id, provider: 'fal', model: 'fal-ai/flux/schnell', operation, inputAssetIds, prompt: 'Synthetic', params: { size: '1024x1024' } });
    repo.spend.reserve({ generationId: job.id, projectId: project.id, provider: 'fal', model: job.model, operation, estimatedUsd: 1 });
    return job.id;
  }
  const runner = (provider, options = {}) => createJobRunner({ repo, budget, providers: { get: () => provider }, directors: new Map(), keys: { get: () => 'fake' },
    assetStore: { read: async () => ({ bytes: Buffer.from('synthetic image'), mime: 'image/png' }), save: async () => { throw Error('No output expected'); } }, log: { error() {} }, ...options });
  return { repo, make, runner };
}

test('recovered queued cancellation retains submitted reservations and releases unsubmitted ones', (t) => {
  const { repo, make, runner } = fixture(t);
  const submitted = make('video'), fresh = make();
  repo.generations.update(submitted, { status: 'running', providerJob: { id: 'already-paid' } });
  const jobs = runner({ resumable: true }, { concurrency: 0 });
  assert.equal(jobs.recover().reattached, 1);
  assert.equal(repo.generations.get(submitted).status, 'queued');
  assert.equal(jobs.cancel(submitted).generation.billing, 'unknown');
  assert.equal(repo.spend.get(submitted).status, 'unknown');
  assert.equal(repo.spend.outstanding('fal').usd, 2);
  assert.equal(jobs.cancel(fresh).generation.billing, 'none');
  assert.equal(repo.spend.outstanding('fal').usd, 1);
});

test('fal image and tool download refusals retain reservations after durable submission and resume without resubmitting', async (t) => {
  const { repo, make, runner } = fixture(t);
  let current, posts = 0;
  const marker = { id: 'request', statusUrl: 'https://queue.fal.run/status', responseUrl: 'https://queue.fal.run/result' };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options.method === 'POST') {
      posts++;
      return Response.json({ request_id: marker.id, status_url: marker.statusUrl, response_url: marker.responseUrl });
    }
    assert.equal(repo.generations.get(current).providerJob.id, marker.id, 'marker persisted before polling or download');
    if (url === marker.statusUrl) return Response.json({ status: 'COMPLETED' });
    if (url === marker.responseUrl) return Response.json({ images: [{ url: 'https://synthetic.invalid/image.png' }] });
    assert.equal(url, 'https://synthetic.invalid/image.png');
    return new Response('expired', { status: 403 });
  });
  const jobs = runner(fal);
  current = make(); jobs.enqueue(current);
  let result = await jobs.waitFor(current);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCategory, 'auth');
  assert.equal(result.billing, 'unknown');
  assert.equal(repo.spend.outstanding('fal').usd, 1);
  await jobs.idle();
  current = make();
  repo.generations.update(current, { status: 'running', providerJob: marker });
  jobs.recover();
  result = await jobs.waitFor(current);
  assert.equal(result.billing, 'unknown');
  assert.equal(posts, 1);
  assert.equal(repo.spend.outstanding('fal').usd, 2);
  await jobs.idle();
  const input = repo.assets.create({ projectId: result.projectId, kind: 'image', file: 'input.png', size: 1, mimeType: 'image/png' });
  current = make('upscale', [input.id]);
  repo.generations.update(current, { model: 'fal-ai/esrgan', params: { scale: 2 } });
  jobs.enqueue(current);
  result = await jobs.waitFor(current);
  assert.equal(result.errorCategory, 'auth');
  assert.equal(result.billing, 'unknown');
  assert.equal(posts, 2);
  assert.equal(repo.spend.outstanding('fal').usd, 3);
  await jobs.idle();
});
