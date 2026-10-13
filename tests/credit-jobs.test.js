import assert from 'node:assert/strict';
import test from 'node:test';
import { createCreditMonitor } from '../src/credits.js';
import { createJobRunner } from '../src/jobs.js';
import { createBudget } from '../src/budget.js';
import { startTestApp, tinyPng, quietLog } from './helpers.js';

test('credit guard releases refused jobs, retains unknown billing and resumes accepted jobs without buying again', async () => {
  const t = await startTestApp();
  try {
    const { repo } = t.app;
    const project = repo.projects.create({ name: 'credit regression' });
    const budget = createBudget({ repo });
    budget.update({ enabled: true, retryReserveUsd: 0.5 });
    let remaining = 0.2, calls = 0, checks = 0;
    const credits = createCreditMonitor({ keys: { get: () => 'fake' }, get: async () => {
      checks++; return { data: { limit_remaining: remaining } };
    } });
    const runner = createJobRunner({ repo, budget, credits, keys: { get: () => 'fake' },
      providers: { get: () => ({ id: 'openrouter', resumable: true, video: async ({ resumeJob }) => {
        calls++; return { bytes: tinyPng(), usage: { cost: resumeJob ? 0.8 : 1 } };
      } }) }, directors: {}, assetStore: { save: async () => ({ id: 'asset' }) }, log: quietLog });
    function make(status = 'queued', providerJob = null) {
      const job = repo.generations.create({ projectId: project.id, provider: 'openrouter', model: 'test-video',
        operation: 'video', prompt: 'test', params: { duration: 1 } });
      repo.spend.reserve({ generationId: job.id, projectId: project.id, provider: 'openrouter', model: job.model, operation: 'video', estimatedUsd: 1 });
      repo.generations.update(job.id, { status, providerJob });
      return job.id;
    }
    const refused = make(); runner.enqueue(refused);
    const result = await runner.waitFor(refused);
    assert.equal(result.errorCategory, 'credit_limit'); assert.equal(result.billing, 'none'); assert.equal(calls, 0);
    assert.equal(repo.spend.outstanding('openrouter').usd, 0);
    remaining = 2;
    const good = make(); runner.enqueue(good);
    assert.equal((await runner.waitFor(good)).status, 'completed'); assert.equal(calls, 1); assert.equal(checks, 2);
    // Once accepted, poll the existing request even when available allowance reaches zero.
    remaining = 0;
    const accepted = make('running', { id: 'existing' });
    const unknown = make('running');
    runner.recover();
    assert.equal((await runner.waitFor(accepted)).status, 'completed');
    assert.equal(calls, 2); assert.equal(checks, 2);
    assert.equal(repo.spend.get(unknown).status, 'unknown');
    assert.equal(repo.spend.outstanding('openrouter').usd, 1);
  } finally { await t.close(); }
});

test('missing, null and negative provider charges cannot erase a reservation', async () => {
  const t = await startTestApp();
  try {
    const { repo } = t.app;
    const budget = createBudget({ repo });
    const project = repo.projects.create({ name: 'billing values' });
    for (const cost of [undefined, null, '', -1]) {
      const job = repo.generations.create({ projectId: project.id, operation: 'video', provider: 'test', model: 'video', prompt: 'test', params: {} });
      repo.spend.reserve({ generationId: job.id, projectId: project.id, provider: 'test', model: job.model, operation: 'video', estimatedUsd: 1 });
      budget.settle(job, { outcome: 'completed', usage: { cost } });
      assert.equal(repo.spend.get(job.id).actualUsd, null);
    }
    assert.equal(repo.spend.total().usd, 4);
  } finally { await t.close(); }
});
