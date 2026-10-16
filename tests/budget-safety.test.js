import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
process.env.LUMINA_OPENROUTER_POLL_MS = '1';
import { Worker } from 'node:worker_threads';
import { requestContext } from '../src/context.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase, transaction } from '../src/db.js';
import { createRepo } from '../src/repo.js';
import { billingState, createBudget } from '../src/budget.js';
import { createGenerationService } from '../src/generation.js';
import { createJobRunner } from '../src/jobs.js';
import { createCreditMonitor } from '../src/credits.js';
import openai from '../src/providers/openai.js';
import openrouter from '../src/providers/openrouter.js';
import gemini from '../src/providers/gemini.js';
import replicate from '../src/providers/replicate.js';
import fal from '../src/providers/fal.js';

function fixture(t, implementation = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'budget-safety-'));
  let db = openDatabase(dir), repo = createRepo(db);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const project = repo.projects.create('Safety');
  const model = { id: 'bounded', label: 'Synthetic', operations: ['generate', 'edit', 'video', 'speech', 'upscale'], sizes: ['1024x1024', '1536x1024'], qualities: [], maxReferences: 2, durations: [4], aspects: ['16:9'], voices: ['one', 'two'], scales: [2], livePrice: { usd: 1, per: 'image' } };
  const provider = { id: 'synthetic', label: 'Synthetic', models: [model], ...implementation };
  const providers = { get: () => provider, model: () => model };
  const keys = { get: () => 'fake' }, directors = new Map();
  const assetStore = { save: async () => ({ id: 'output' }), read: async () => ({ mime: 'image/png', bytes: Buffer.from('input') }) };
  let budget, service;
  const setup = () => {
    budget = createBudget({ repo });
    service = createGenerationService({ repo, providers, directors, keys, budget, db, transaction, jobs: { enqueue() {} } });
  };
  setup();
  const input = (extra = {}) => ({ projectId: project.id, provider: provider.id, model: model.id, prompt: 'synthetic', ...extra });
  return { get db() { return db; }, get repo() { return repo; }, get budget() { return budget; }, get service() { return service; }, dir, project, provider, model, input,
    restart() { db.close(); db = openDatabase(dir); repo = createRepo(db); setup(); },
    runner(options = {}) { return createJobRunner({ repo, providers, directors, keys, budget, assetStore, credits: createCreditMonitor({ keys, get: async () => ({ data: { limit_remaining: 100 } }) }), log: { error() {} }, ...options }); },
  };
}

test('idempotency binds normalized inputs and never returns an unrelated paid job', (t) => {
  const f = fixture(t);
  const a = f.service.submit(f.input({ idempotencyKey: 'same-key-123' }));
  assert.equal(f.service.submit(f.input({ idempotencyKey: 'same-key-123' })).id, a.id);
  for (const extra of [{ prompt: 'different' }, { size: '1536x1024' }, { operation: 'speech' }]) {
    assert.throws(() => f.service.submit(f.input({ idempotencyKey: 'same-key-123', ...extra })), { status: 409 });
  }
  assert.equal(f.repo.spend.total().usd, 1);
});

test('bare retries and ineligible retryOf jobs cannot spend the protected reserve', (t) => {
  const f = fixture(t);
  assert.throws(() => f.service.submit(f.input({ isRetry: true })), { status: 400 });
  const first = f.service.submit(f.input());
  f.repo.generations.update(first.id, { status: 'failed', billing: 'unknown', billingState: 'billing_unknown' });
  for (const extra of [{ retryOf: first.id }, { isRetry: true, retryOf: first.id }]) {
    assert.throws(() => f.service.submit(f.input(extra)), { status: 400 });
  }
  assert.throws(() => f.service.retry(first.id, { confirmUncertain: true }), { status: 409 });
  assert.equal(f.repo.spend.total().usd, 1);
  f.budget.resolve(first.id, 0);
  const retry = f.service.retry(first.id);
  assert.equal(retry.params.accounting.retryOf, first.id);
  assert.equal(billingState(f.repo.generations.get(first.id)), 'confirmed_unbilled');
  assert.equal(f.repo.spend.total().usd, 1);
});

test('unknown cost is refused even with relaxed prices or disabled limits', (t) => {
  const f = fixture(t);
  delete f.model.livePrice;
  for (const enabled of [true, false]) {
    f.repo.settings.set('budget', { enabled, strictPrices: false, confirmPaid: false });
    assert.throws(() => f.service.submit(f.input()), (e) => e.status === 402 && /local model/i.test(e.message));
    assert.throws(() => f.service.submit(f.input({ operation: 'speech' })), { status: 402 });
  }
  assert.equal(f.repo.spend.total().count, 0);
});

test('concurrent submissions near $12 reserve atomically, including separate SQLite connections', async (t) => {
  const f = fixture(t);
  f.model.livePrice.usd = 0.75;
  const authorize = f.budget.authorize;
  f.budget.authorize = (request) => { assert.equal(f.db.isTransaction, true, 'authorization holds the SQLite write lock'); return authorize(request); };
  const otherDb = openDatabase(f.dir), otherRepo = createRepo(otherDb);
  t.after(() => otherDb.close());
  const other = createGenerationService({ repo: otherRepo, providers: { get: () => f.provider, model: () => f.model }, keys: { get: () => 'fake' }, directors: new Map(), budget: createBudget({ repo: otherRepo }), db: otherDb, transaction, jobs: { enqueue() {} } });
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => (i % 2 ? f.service : other).submit(f.input()))));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 14); // $10.50, $1 kept for retries
  assert.equal(f.budget.status().reservedUsd, 10.5);
  assert.equal(f.budget.status().spentUsd, 10.5);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 6);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.status === 402));
});

test('a timeout after submission keeps money and never automatically submits again', async (t) => {
  let submissions = 0;
  const f = fixture(t, { run: async ({ onSubmitted }) => {
    submissions++; onSubmitted({ id: 'accepted', resumable: false });
    throw Object.assign(Error('response lost'), { category: 'timeout' });
  } });
  const job = f.service.submit(f.input()), jobs = f.runner();
  jobs.enqueue(job.id); await jobs.idle();
  assert.equal(billingState(f.repo.generations.get(job.id)), 'billing_unknown');
  assert.equal(f.budget.status().unknownUsd, 1);
  assert.equal(f.budget.status().spentUsd, 1);
  f.restart();
  const recovered = f.runner(); recovered.recover(); await recovered.idle();
  assert.equal(submissions, 1);
  assert.throws(() => f.service.retry(job.id, { confirmUncertain: true }), { status: 409 });
});

test('restart resumes the existing remote job; cancelling submitted work never frees money', async (t) => {
  let submissions = 0, polls = 0;
  const f = fixture(t, { resumable: true, run: async ({ resumeJob }) => {
    if (!resumeJob) { submissions++; throw Error('must not submit'); }
    polls++; assert.equal(resumeJob.id, 'remote-id'); return { bytes: Buffer.from('result') };
  } });
  const resumed = f.service.submit(f.input()), cancelled = f.service.submit(f.input());
  for (const job of [resumed, cancelled]) f.repo.generations.update(job.id, { status: 'running', billingState: 'submitted', providerJob: { id: 'remote-id' } });
  f.restart();
  const jobs = f.runner({ concurrency: 0 });
  assert.equal(jobs.recover().reattached, 2);
  jobs.cancel(cancelled.id);
  assert.equal(f.repo.spend.get(cancelled.id).status, 'unknown');
  assert.equal(billingState(f.repo.generations.get(cancelled.id)), 'billing_unknown');
  const active = f.runner(); active.recover(); await active.idle();
  assert.equal(f.repo.generations.get(resumed.id).status, 'completed');
  assert.equal(submissions, 0); assert.equal(polls, 1);
  assert.equal(f.budget.status().spentUsd, 2);
});

test('cancellable paid provider cannot release billing after acceptance', async (t) => {
  let ready;
  const accepted = new Promise((resolve) => { ready = resolve; });
  const f = fixture(t, { cancellable: true, run: async ({ signal, onSubmitted }) => {
    onSubmitted({ id: 'paid' }); ready();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    throw Error('stopped tracking');
  } });
  const job = f.service.submit(f.input()), jobs = f.runner(); jobs.enqueue(job.id);
  await accepted; jobs.cancel(job.id); await jobs.idle();
  assert.equal(f.repo.spend.get(job.id).status, 'unknown');
  assert.equal(f.budget.status().spentUsd, 1);
});

test('budget splits estimates, reservations, charges and unknown amounts across restart', (t) => {
  const f = fixture(t);
  const queued = f.service.submit(f.input()), unknown = f.service.submit(f.input()), charged = f.service.submit(f.input());
  f.budget.settle(unknown, { outcome: 'unknown' });
  f.budget.settle(charged, { outcome: 'completed', usage: { cost: 0.4 } });
  const settings = f.budget.settings();
  f.restart();
  const status = f.budget.status();
  assert.equal(status.estimatedUsd, 3); assert.equal(status.reservedUsd, 1);
  assert.equal(status.chargedUsd, 0.4); assert.equal(status.unknownUsd, 1);
  assert.equal(status.spentUsd, 2.4);
  assert.deepEqual(f.budget.settings(), settings);
  assert.equal(billingState(f.repo.generations.get(queued.id)), 'not_submitted');
});

test('unreadable key allowance is unavailable and distinct from account credits', async () => {
  const monitor = createCreditMonitor({ keys: { get: () => 'fake' }, get: async () => ({ data: { limit_remaining: null } }) });
  const status = await monitor.status();
  assert.equal(status.status, 'unavailable');
  assert.equal(status.keyRemainingUsd, null);
  assert.equal(status.accountRemainingUsd, null);
  assert.equal(status.accountStatus, 'requires_management_key');
});

// These exercise the real adapters and runner; only the provider's HTTP boundary is fake.
for (const [name, adapter, operation, body] of [
  ['openai image', openai, 'generate', { id: 'image-id', data: [{ b64_json: 'b3V0' }] }],
  ['openrouter image', openrouter, 'generate', { id: 'image-id', data: [{ b64_json: 'b3V0' }] }],
  ['gemini image', gemini, 'generate', { id: 'interaction-id', status: 'completed', steps: [{ content: [{ type: 'image', data: 'b3V0' }] }] }],
  ['openai speech', openai, 'speech', null],
  ['gemini speech', gemini, 'speech', { id: 'speech-id', steps: [{ content: [{ type: 'audio', data: 'b3V0', mime_type: 'audio/wav' }] }] }],
]) {
  test(`${name} persists acceptance before reading the response body`, async (t) => {
    const f = fixture(t, adapter);
    let jobId, posts = 0;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      assert.equal(options.method, 'POST'); posts++;
      assert.equal(billingState(f.repo.generations.get(jobId)), 'billing_unknown', 'intent is durable before POST');
      const response = body ? Response.json(body, { headers: { 'x-request-id': 'http-id' } }) : new Response('audio', { headers: { 'x-request-id': 'http-id' } });
      const method = body ? 'json' : 'arrayBuffer';
      const read = response[method].bind(response);
      response[method] = async () => {
        const job = f.repo.generations.get(jobId);
        assert.equal(billingState(job), name === 'openai speech' ? 'completed_remote' : 'submitted');
        assert.equal(job.providerJob.id, 'http-id');
        return read();
      };
      return response;
    });
    const job = f.service.submit(f.input({ operation })); jobId = job.id;
    const jobs = f.runner(); jobs.enqueue(job.id); await jobs.idle();
    assert.equal(f.repo.generations.get(job.id).status, 'completed');
    assert.equal(billingState(f.repo.generations.get(job.id)), 'charged');
    assert.equal(posts, 1);
  });
}

test('Replicate retries a failed poll and failed download with backoff, never POSTs twice', async (t) => {
  const f = fixture(t, replicate);
  let posts = 0, polls = 0, downloads = 0, jobId;
  const times = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options.method === 'POST') {
      posts++;
      return Response.json({ id: 'prediction-id', status: 'processing', urls: { get: 'https://api.replicate.com/v1/predictions/prediction-id' } });
    }
    const job = f.repo.generations.get(jobId);
    assert.equal(job.providerJob.id, 'prediction-id');
    if (String(url).includes('/predictions/')) {
      polls++; times.push(Date.now());
      if (polls === 1) throw Error('poll connection lost');
      return Response.json({ id: 'prediction-id', status: 'succeeded', output: ['https://synthetic.invalid/result'] });
    }
    downloads++;
    assert.equal(job.providerJob.downloadUrl, 'https://synthetic.invalid/result');
    assert.equal(billingState(job), 'completed_remote');
    if (downloads === 1) throw Error('download connection lost');
    return new Response('result');
  });
  f.model.id = 'black-forest-labs/flux-schnell';
  const paid = f.service.submit(f.input()); jobId = paid.id;
  const jobs = f.runner(); jobs.enqueue(paid.id); await jobs.idle();
  assert.equal(f.repo.generations.get(paid.id).status, 'completed', f.repo.generations.get(paid.id).userError);
  assert.equal(posts, 1); assert.equal(polls, 2); assert.equal(downloads, 2);
  assert.ok(times[1] - times[0] >= 75, 'poll retry backs off');
  assert.equal(f.repo.spend.total().usd, 1);
});

for (const operation of ['generate', 'video', 'upscale']) {
  test(`fal ${operation}: exhausted download remains reserved and restart downloads the saved URL`, async (t) => {
    const f = fixture(t, fal);
    f.model.id = operation === 'video' ? 'fal-ai/kling-video/v3/pro/text-to-video' : operation === 'upscale' ? 'fal-ai/esrgan' : 'fal-ai/flux/schnell';
    const image = f.repo.assets.create({ projectId: f.project.id, kind: 'image', file: 'input.png', mimeType: 'image/png', size: 1 });
    let posts = 0, gets = 0, fail = true, jobId;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (options.method === 'POST') {
        posts++; return Response.json({ request_id: 'fal-id', status_url: 'https://queue.fal.run/status', response_url: 'https://queue.fal.run/result' });
      }
      assert.equal(f.repo.generations.get(jobId).providerJob.id, 'fal-id');
      if (url === 'https://queue.fal.run/status') return Response.json({ status: 'COMPLETED' });
      if (url === 'https://queue.fal.run/result') return Response.json({ images: [{ url: 'https://synthetic.invalid/result' }], image: { url: 'https://synthetic.invalid/result' }, video: { url: 'https://synthetic.invalid/result' } });
      gets++;
      assert.equal(f.repo.generations.get(jobId).providerJob.downloadUrl, 'https://synthetic.invalid/result');
      if (fail) return new Response('expired', { status: 403 });
      return new Response('result');
    });
    const job = f.service.submit(f.input({ operation, ...(operation === 'upscale' ? { inputAssetIds: [image.id] } : {}) })); jobId = job.id;
    let jobs = f.runner(); jobs.enqueue(job.id); await jobs.idle();
    assert.equal(billingState(f.repo.generations.get(job.id)), 'download_failed');
    assert.equal(f.repo.spend.total().usd, 1); assert.equal(gets, 3);
    f.repo.generations.update(job.id, { status: 'running' });
    f.restart(); fail = false;
    jobs = f.runner(); jobs.recover(); await jobs.idle();
    assert.equal(f.repo.generations.get(job.id).status, 'completed');
    assert.equal(posts, 1); assert.equal(gets, 4);
    assert.equal(f.repo.spend.total().usd, 1);
  });
}

test('new accounting metadata lives in existing JSON columns and survives restart', (t) => {
  const f = fixture(t);
  const job = f.service.submit(f.input({ idempotencyKey: 'json-accounting-key' }));
  assert.equal(job.params.accounting.billingState, 'not_submitted');
  assert.match(job.params.accounting.requestFingerprint, /^[a-f0-9]{32}$/);
  f.restart();
  assert.equal(f.service.submit(f.input({ idempotencyKey: 'json-accounting-key' })).id, job.id);
});

test('only explicit app confirmation can buy another ambiguous request and retains the old reservation', (t) => {
  const f = fixture(t);
  const job = f.service.submit(f.input());
  f.repo.generations.update(job.id, { status: 'failed', billing: 'unknown', providerJob: { billingState: 'billing_unknown', phase: 'submitting', resumable: false } });
  f.budget.settle(job, { outcome: 'unknown' });
  for (const source of ['background', 'mcp']) {
    requestContext.run({ source }, () => assert.throws(() => f.service.retry(job.id, { confirmUncertain: true }), { status: 409 }));
  }
  requestContext.run({ source: 'app', confirmSpend: true }, () => {
    const next = f.service.retry(job.id, { confirmUncertain: true });
    assert.notEqual(next.id, job.id);
    assert.equal(f.repo.spend.get(job.id).status, 'unknown');
    assert.equal(f.budget.status().spentUsd, 2);
  });
});

test('unknown outcomes and later read refusals cannot shrink an uncertain reservation', (t) => {
  const f = fixture(t);
  const job = f.service.submit(f.input());
  f.repo.generations.update(job.id, { providerJob: { id: 'paid', billingState: 'submitted' } });
  f.budget.settle(job, { outcome: 'unknown', usage: { cost: 0 } });
  assert.equal(f.repo.spend.get(job.id).status, 'unknown');
  assert.equal(f.budget.status().spentUsd, 1);
  f.budget.settle(f.repo.generations.get(job.id), { outcome: 'refused' });
  assert.equal(f.budget.status().spentUsd, 1);
});

for (const adapter of [openai, openrouter, gemini, replicate, fal]) {
  test(`${adapter.id}: unusable recovery markers never become a new paid POST`, async (t) => {
    let posts = 0;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      if (options.method === 'POST') posts++;
      throw Error('no request expected');
    });
    await assert.rejects(adapter.run({ key: 'fake', model: adapter.models[0].id, prompt: 'p', size: '1024x1024', images: [], resumeJob: { phase: 'submitting', resumable: false } }));
    assert.equal(posts, 0);
  });
}

test('ambiguous POST timeout without any response id is not retried after restart', async (t) => {
  const f = fixture(t, openai);
  let posts = 0;
  t.mock.method(globalThis, 'fetch', async () => { posts++; throw new DOMException('timed out', 'TimeoutError'); });
  const job = f.service.submit(f.input()), jobs = f.runner(); jobs.enqueue(job.id); await jobs.idle();
  assert.equal(posts, 1);
  assert.equal(billingState(f.repo.generations.get(job.id)), 'billing_unknown');
  f.repo.generations.update(job.id, { status: 'running' }); f.restart();
  const again = f.runner(); assert.equal(again.recover().reattached, 0); await again.idle();
  assert.equal(posts, 1); assert.equal(f.repo.spend.total().usd, 1);
});

test('a partial/zero usage cost on an uncertain outcome cannot free a reservation', (t) => {
  const f = fixture(t);
  for (const cost of [0, 0.2]) {
    const job = f.service.submit(f.input());
    f.budget.settle(job, { outcome: 'unknown', usage: { cost } });
    assert.equal(f.repo.spend.get(job.id).status, 'unknown');
  }
  assert.equal(f.budget.status().unknownUsd, 2);
  assert.equal(f.budget.status().spentUsd, 2);
});

test('a later refused speech chunk retains accepted chunks and their request ids', async (t) => {
  const f = fixture(t, openai);
  let posts = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    posts++;
    return posts === 1 ? new Response('audio', { headers: { 'x-request-id': 'first-chunk' } }) : new Response('refused', { status: 401 });
  });
  const job = f.service.submit(f.input({ operation: 'speech', prompt: 'long narration '.repeat(400) }));
  const jobs = f.runner(); jobs.enqueue(job.id); await jobs.idle();
  const result = f.repo.generations.get(job.id);
  assert.equal(posts, 2); assert.equal(billingState(result), 'billing_unknown');
  assert.ok(result.providerJob.requestIds.includes('first-chunk'));
  assert.equal(f.repo.spend.total().usd, 1);
  assert.throws(() => f.service.retry(job.id), { status: 409 });
});

for (const [name, adapter] of [['openrouter', openrouter], ['gemini', gemini]]) {
  test(`${name} video keeps its remote id and resumes an exhausted download without POST`, async (t) => {
    const f = fixture(t, adapter);
    let posts = 0, downloads = 0, fail = true;
    const downloadUrl = name === 'openrouter' ? 'https://openrouter.ai/api/v1/videos/remote/content?index=0' : 'https://synthetic.invalid/video';
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (options.method === 'POST') {
        posts++;
        return Response.json(name === 'openrouter' ? { id: 'remote', polling_url: 'https://openrouter.ai/api/v1/videos/remote' }
          : { name: 'operations/remote', done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: downloadUrl } }] } } });
      }
      if (url === 'https://openrouter.ai/api/v1/videos/remote') return Response.json({ status: 'completed', unsigned_urls: [downloadUrl] });
      assert.equal(url, downloadUrl); downloads++;
      if (fail) throw Error('lost download');
      return new Response('video');
    });
    const job = f.service.submit(f.input({ operation: 'video' }));
    const jobs = f.runner(); jobs.enqueue(job.id); await jobs.idle();
    assert.equal(billingState(f.repo.generations.get(job.id)), 'download_failed');
    assert.equal(downloads, 3); assert.equal(f.repo.spend.total().usd, 1);
    f.repo.generations.update(job.id, { status: 'running' }); f.restart(); fail = false;
    const again = f.runner(); again.recover(); await again.idle();
    assert.equal(f.repo.generations.get(job.id).status, 'completed');
    assert.equal(posts, 1); assert.equal(downloads, 4);
  });
}

test('separate worker threads cannot authorize more than the shared ceiling', async (t) => {
  const f = fixture(t);
  const code = `
    import { parentPort, workerData } from 'node:worker_threads';
    import { openDatabase } from ${JSON.stringify(new URL('../src/db.js', import.meta.url).href)};
    import { createRepo } from ${JSON.stringify(new URL('../src/repo.js', import.meta.url).href)};
    import { billingState, createBudget } from ${JSON.stringify(new URL('../src/budget.js', import.meta.url).href)};
    import { createGenerationService } from ${JSON.stringify(new URL('../src/generation.js', import.meta.url).href)};
    const db = openDatabase(workerData.dir), repo = createRepo(db);
    const model = { id: 'bounded', sizes: ['1024x1024'], qualities: [], maxReferences: 0, operations: ['generate'], livePrice: { usd: 0.75, per: 'image' } };
    const service = createGenerationService({ repo, budget: createBudget({ repo }), providers: { get: () => ({ id: 'synthetic', keyless: true }), model: () => model }, directors: new Map(), keys: { get: () => null }, jobs: { enqueue() {} } });
    parentPort.once('message', () => {
      let accepted = 0, refused = 0;
      for (let i = 0; i < 10; i++) {
        try { service.submit({ projectId: workerData.projectId, provider: 'synthetic', model: 'bounded', prompt: 'parallel' }); accepted++; }
        catch (e) { if (e.status !== 402) throw e; refused++; }
      }
      db.close(); parentPort.postMessage({ accepted, refused }); parentPort.close();
    });
    parentPort.postMessage('ready');
  `;
  const workers = [0, 1].map(() => new Worker(new URL(`data:text/javascript,${encodeURIComponent(code)}`), { workerData: { dir: f.dir, projectId: f.project.id } }));
  t.after(async () => { await Promise.all(workers.map((worker) => worker.terminate())); });
  await Promise.all(workers.map((worker) => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); })));
  const finished = workers.map((worker) => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }));
  workers.forEach((worker) => worker.postMessage('go'));
  const results = await Promise.all(finished);
  assert.equal(results.reduce((sum, r) => sum + r.accepted, 0), 14);
  assert.equal(results.reduce((sum, r) => sum + r.refused, 0), 6);
  assert.equal(f.repo.spend.total().usd, 10.5);
});

test('a bare retry remains invalid even when an idempotency key already exists', (t) => {
  const f = fixture(t);
  f.service.submit(f.input({ idempotencyKey: 'previous-key' }));
  assert.throws(() => f.service.submit(f.input({ idempotencyKey: 'previous-key', isRetry: true })), { status: 400 });
  assert.equal(f.repo.spend.total().usd, 1);
});

test('retry eligibility rejects another project, operation, successful job, and charged job', (t) => {
  const f = fixture(t);
  const previous = f.service.submit(f.input());
  f.repo.generations.update(previous.id, { status: 'failed' }); f.budget.resolve(previous.id, 0);
  assert.throws(() => f.service.submit(f.input({ isRetry: true, retryOf: previous.id, operation: 'speech' })), { status: 400 });
  const another = f.repo.projects.create('Other');
  assert.throws(() => f.service.submit(f.input({ isRetry: true, retryOf: previous.id, projectId: another.id })), { status: 400 });
  f.repo.generations.update(previous.id, { status: 'completed' });
  assert.throws(() => f.service.submit(f.input({ isRetry: true, retryOf: previous.id })), { status: 400 });
  f.repo.generations.update(previous.id, { status: 'failed' }); f.budget.resolve(previous.id, 0.5);
  assert.throws(() => f.service.submit(f.input({ isRetry: true, retryOf: previous.id })), { status: 400 });
  assert.equal(f.repo.spend.total().usd, 0.5);
});

test('duplicate queue entries and two runners claim a generation only once', async (t) => {
  let submissions = 0;
  const f = fixture(t, { run: async ({ onSubmitted }) => { submissions++; onSubmitted({ id: 'only-once' }); return { bytes: Buffer.from('result') }; } });
  const job = f.service.submit(f.input()), a = f.runner(), b = f.runner();
  a.enqueue(job.id); b.enqueue(job.id); a.enqueue(job.id);
  await Promise.all([a.idle(), b.idle()]);
  assert.equal(submissions, 1); assert.equal(f.repo.generations.get(job.id).status, 'completed');
  assert.equal(f.repo.spend.total().usd, 1);
});

test('sub-cent estimates cannot slip above the ceiling through rounded ledger totals', (t) => {
  const f = fixture(t);
  f.budget.update({ totalUsd: 1, retryReserveUsd: 0 });
  f.model.livePrice.usd = 0.50004;
  f.service.submit(f.input());
  f.model.livePrice.usd = 0.49998;
  assert.throws(() => f.service.submit(f.input()), { status: 402 });
  assert.equal(f.repo.spend.total().count, 1);
});

test('empty reconciliation is rejected instead of silently declaring a paid job unbilled', (t) => {
  const f = fixture(t), job = f.service.submit(f.input());
  f.budget.settle(job, { outcome: 'unknown' });
  for (const amount of [null, '', '   ', undefined]) {
    assert.throws(() => f.budget.resolve(job.id, amount), { status: 400 });
  }
  assert.equal(f.repo.spend.total().usd, 1);
});

test('an old queued request without a bounded estimate is refused before provider traffic', async (t) => {
  let posts = 0;
  const f = fixture(t, { run: async () => { posts++; throw Error('must not submit'); } });
  const job = f.repo.generations.create({ projectId: f.project.id, provider: f.provider.id, model: f.model.id, operation: 'generate', prompt: 'old unpriced' });
  f.repo.spend.reserve({ generationId: job.id, projectId: f.project.id, provider: f.provider.id, model: f.model.id, operation: 'generate', estimatedUsd: null });
  const jobs = f.runner(); jobs.enqueue(job.id); await jobs.idle();
  assert.equal(posts, 0);
  assert.equal(f.repo.generations.get(job.id).errorCategory, 'budget_limit');
  assert.match(f.repo.generations.get(job.id).userError, /local model/);
});

test('legacy queued jobs without a bounded reservation never reach a paid provider', async (t) => {
  let submissions = 0;
  const f = fixture(t, { run: async () => { submissions++; return { bytes: Buffer.from('result') }; } });
  const job = f.repo.generations.create({ projectId: f.project.id, provider: 'synthetic', model: 'unpriced-legacy', operation: 'generate', prompt: 'legacy', params: {}, inputAssetIds: [] });
  const jobs = f.runner(); jobs.enqueue(job.id); await jobs.idle();
  const result = f.repo.generations.get(job.id);
  assert.equal(submissions, 0);
  assert.equal(result.status, 'failed');
  assert.match(result.userError, /local model/i);
});

test('previously approved requests keep their approval binding', (t) => {
  const f = fixture(t);
  f.budget.update({ approvalAboveUsd: 0.5 });
  const signature = createHash('sha256').update(JSON.stringify(['synthetic', 'bounded', 'generate', 'synthetic', { size: '1024x1024', quality: null }, [], null])).digest('hex').slice(0, 32);
  const approval = f.repo.approvals.create({ signature, summary: {}, estimatedUsd: 1, requestedBy: 'app' });
  f.repo.approvals.decide(approval.id, 'approved');
  const job = f.service.submit(f.input({ approvalId: approval.id }));
  assert.equal(f.repo.approvals.get(approval.id).usedBy, job.id);
  assert.equal(f.repo.spend.total().usd, 1);
});

test('reconciliation while a remote job is running cannot turn restart recovery into another POST', async (t) => {
  let submissions = 0, polls = 0;
  const f = fixture(t, { resumable: true, run: async ({ resumeJob }) => {
    if (resumeJob) polls++; else submissions++;
    return { bytes: Buffer.from('result') };
  } });
  const job = f.service.submit(f.input());
  f.repo.generations.update(job.id, { status: 'running', providerJob: { id: 'original', phase: 'submitted', resumable: true, billingState: 'submitted' } });
  f.budget.resolve(job.id, 0);
  f.restart();
  const jobs = f.runner(); jobs.recover(); await jobs.idle();
  assert.equal(submissions, 0);
  assert.equal(polls, 1);
  assert.equal(f.repo.spend.get(job.id).status, 'released');
  assert.equal(billingState(f.repo.generations.get(job.id)), 'confirmed_unbilled');
});

test('provider refusal request ids are durable before reading the error body', async (t) => {
  const f = fixture(t, openai);
  let jobId, posts = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    posts++;
    const response = new Response('rejected', { status: 400, headers: { 'x-request-id': 'refusal-id' } });
    const text = response.text.bind(response);
    response.text = async () => {
      assert.equal(f.repo.generations.get(jobId).providerJob.id, 'refusal-id');
      return text();
    };
    return response;
  });
  const job = f.service.submit(f.input()); jobId = job.id;
  const jobs = f.runner(); jobs.enqueue(job.id); await jobs.idle();
  assert.equal(posts, 1);
  assert.equal(billingState(f.repo.generations.get(job.id)), 'confirmed_unbilled');
  assert.equal(f.repo.spend.get(job.id).status, 'released');
});
