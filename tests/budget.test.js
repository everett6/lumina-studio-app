import assert from 'node:assert/strict';
import test from 'node:test';
import { createBudget } from '../src/budget.js';
import { createModelCatalog, videoRate } from '../src/catalog.js';
import { startTestApp } from './helpers.js';

// Every test here uses the offline mock provider (pretend prices: $0.01 per image, $0.01 per video second).
const mcp = { headers: { 'x-lumina-client': 'mcp' } };
const video = (projectId, extra = {}) => ({ projectId, operation: 'video', prompt: 'waves on rocks', provider: 'mock', model: 'mock-video', duration: 4, ...extra });
const settle = async (t, id) => (await t.call('POST', `/api/generations/${id}/wait`, { timeoutMs: 20_000 })).body.generation;

test('budget: simultaneous requests cannot jointly overspend; limits are app-only; the ledger survives project deletion', async () => {
  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Budget' })).body.project;
    assert.equal((await t.call('PUT', '/api/budget', { enabled: true, totalUsd: 1 }, mcp)).status, 403, 'MCP clients cannot change limits');
    const set = await t.call('PUT', '/api/budget', { enabled: true, totalUsd: 0.1, retryReserveUsd: 0, approvalAboveUsd: 1, perRequestUsd: 1 });
    assert.equal(set.status, 200);
    // Five 4-second clips at $0.04 arrive at once; only two fit in $0.10.
    const results = await Promise.all(Array.from({ length: 5 }, () => t.call('POST', '/api/generate', video(project.id), mcp)));
    const accepted = results.filter((r) => r.status === 202);
    assert.equal(accepted.length, 2, results.map((r) => r.status).join(','));
    assert.ok(results.filter((r) => r.status === 402).every((r) => /Budget: \$0\.08 of \$0\.10/.test(r.body.error)));
    for (const r of accepted) assert.equal((await settle(t, r.body.generation.id)).status, 'completed');
    const status = (await t.call('GET', '/api/budget')).body;
    assert.equal(status.spentUsd, 0.08);
    assert.equal(status.remainingUsd, 0.02);
    assert.ok(status.recent.every((row) => row.status === 'charged'));
    // Deleting the project does not give the money back.
    await t.call('DELETE', `/api/projects/${project.id}`);
    assert.equal((await t.call('GET', '/api/budget')).body.spentUsd, 0.08);
    // A retry reserve holds back the last part of the budget for retries only.
    await t.call('PUT', '/api/budget', { totalUsd: 0.2, retryReserveUsd: 0.1 });
    const other = (await t.call('POST', '/api/projects', { name: 'Two' })).body.project;
    assert.equal((await t.call('POST', '/api/generate', video(other.id))).status, 402, '0.08 + 0.04 > 0.20 - 0.10');
  } finally {
    await t.close();
  }
});

test('budget: requests above the approval threshold wait for the person; MCP approval only when allowed; approvals are single-use', async () => {
  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Approve' })).body.project;
    await t.call('PUT', '/api/budget', { enabled: true, totalUsd: 5, retryReserveUsd: 0, approvalAboveUsd: 0.03, perRequestUsd: 1 });
    const first = await t.call('POST', '/api/generate', video(project.id), mcp);
    assert.equal(first.status, 402);
    assert.equal(first.body.needsApproval, true);
    const { approvalId } = first.body;
    assert.match(approvalId, /^[a-f0-9-]{36}$/);
    // Asking again does not pile up approvals.
    assert.equal((await t.call('POST', '/api/generate', video(project.id), mcp)).body.approvalId, approvalId);
    assert.equal((await t.call('POST', `/api/budget/approvals/${approvalId}`, { approve: true }, mcp)).status, 403, 'MCP cannot approve by default');
    assert.equal((await t.call('GET', '/api/budget')).body.approvals.length, 1);
    assert.equal((await t.call('POST', `/api/budget/approvals/${approvalId}`, { approve: true })).status, 200);
    // An approval only covers the request it was asked for.
    const different = await t.call('POST', '/api/generate', video(project.id, { prompt: 'something else' }), { headers: { 'x-lumina-client': 'mcp', 'x-lumina-approval-id': approvalId } });
    assert.equal(different.status, 402);
    const ok = await t.call('POST', '/api/generate', video(project.id), { headers: { 'x-lumina-client': 'mcp', 'x-lumina-approval-id': approvalId } });
    assert.equal(ok.status, 202, JSON.stringify(ok.body));
    await settle(t, ok.body.generation.id);
    const again = await t.call('POST', '/api/generate', video(project.id), { headers: { 'x-lumina-approval-id': approvalId } });
    assert.equal(again.status, 402, 'used approvals cannot be reused');
    // With MCP approval switched on, the MCP client may approve.
    await t.call('PUT', '/api/budget', { mcpCanApprove: true });
    assert.equal((await t.call('POST', `/api/budget/approvals/${again.body.approvalId}`, { approve: true }, mcp)).status, 200);
    // An approval given for this exact request is picked up without its id (how film production resumes), once.
    const resumed = await t.call('POST', '/api/generate', video(project.id));
    assert.equal(resumed.status, 202, JSON.stringify(resumed.body));
    await settle(t, resumed.body.generation.id);
    assert.equal((await t.call('POST', '/api/generate', video(project.id))).status, 402);
  } finally {
    await t.close();
  }
});

test('budget: unpriced requests need approval and reserve the per-request ceiling; never counted as free', () => {
  const store = new Map();
  const ledger = [];
  const approvals = new Map();
  const repo = {
    settings: { get: (k, d) => store.get(k) ?? d, set: (k, v) => store.set(k, v) },
    spend: { total: () => ({ usd: ledger.reduce((s, x) => s + x, 0), count: ledger.length }), byModel: () => [], list: () => [] },
    approvals: {
      get: (id) => approvals.get(id), list: () => [],
      pendingFor: (sig) => [...approvals.values()].find((a) => a.signature === sig && a.status === 'pending'),
      approvedFor: (sig) => [...approvals.values()].find((a) => a.signature === sig && a.status === 'approved'),
      create: ({ signature }) => { const a = { id: `a${approvals.size}`, signature, status: 'pending' }; approvals.set(a.id, a); return a; },
    },
  };
  const budget = createBudget({ repo });
  budget.update({ enabled: true, totalUsd: 12, perRequestUsd: null });
  assert.throws(() => budget.authorize({ projectId: 'p', estimateUsd: null, signature: 's' }), /no published price/);
  budget.update({ perRequestUsd: 2 });
  assert.throws(() => budget.authorize({ projectId: 'p', estimateUsd: null, signature: 's' }), (e) => e.extra.needsApproval && /needs approval/.test(e.message));
  approvals.get('a0').status = 'approved';
  assert.equal(budget.authorize({ projectId: 'p', estimateUsd: null, signature: 's', approvalId: 'a0' }).reserveUsd, 2);
  assert.throws(() => budget.authorize({ projectId: 'p', estimateUsd: 2.5, signature: 'x' }), /per-request limit/);
});

test('no double billing: idempotency keys, uncertain outcomes need confirmation, accepted provider jobs resume after a restart', async () => {
  const t = await startTestApp();
  const { dataRoot } = t;
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Jobs' })).body.project;
    await t.call('PUT', '/api/budget', { enabled: true, totalUsd: 5, retryReserveUsd: 0, approvalAboveUsd: 1 });
    const keyed = video(project.id, { idempotencyKey: 'shot-1-take-1' });
    const a = await t.call('POST', '/api/generate', keyed, mcp);
    const b = await t.call('POST', '/api/generate', keyed, mcp);
    assert.equal(a.body.generation.id, b.body.generation.id, 'the same key returns the same job');
    await settle(t, a.body.generation.id);
    assert.equal((await t.call('GET', '/api/budget')).body.requests, 1, 'and is charged once');

    // A refusal before the provider accepted the job releases the reservation.
    const refused = await settle(t, (await t.call('POST', '/api/generate', { projectId: project.id, prompt: 'a cat [fail]', provider: 'mock', model: 'mock-image' })).body.generation.id);
    assert.equal(refused.billing, 'none');
    // A failure after the provider accepted the job is "unknown": still counted, and a retry needs confirmation.
    const lost = await settle(t, (await t.call('POST', '/api/generate', video(project.id, { prompt: 'storm [fail]' }))).body.generation.id);
    assert.equal(lost.billing, 'unknown');
    const blocked = await t.call('POST', `/api/generations/${lost.id}/retry`, {});
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.uncertainBilling, true);
    assert.equal((await t.call('POST', `/api/generations/${lost.id}/retry`, { confirmUncertain: true })).status, 202);
    // The person checks the provider's records and marks it not billed.
    assert.equal((await t.call('POST', `/api/budget/spend/${lost.id}`, { actualUsd: 0 })).body.spend.status, 'released');

    // Simulate Lumina closing mid-job: one job the provider had accepted, one that never got that far.
    const { repo } = t.app;
    const accepted = repo.generations.create({ projectId: project.id, operation: 'video', provider: 'mock', model: 'mock-video', prompt: 'resumed clip', params: { duration: 4 }, billing: 'reserved' });
    repo.spend.reserve({ generationId: accepted.id, projectId: project.id, provider: 'mock', model: 'mock-video', operation: 'video', estimatedUsd: 0.04 });
    repo.generations.update(accepted.id, { status: 'running', providerJob: { id: 'mock-job-1' } });
    const orphan = repo.generations.create({ projectId: project.id, operation: 'video', provider: 'mock', model: 'mock-video', prompt: 'lost clip', params: { duration: 4 }, billing: 'reserved' });
    repo.spend.reserve({ generationId: orphan.id, projectId: project.id, provider: 'mock', model: 'mock-video', operation: 'video', estimatedUsd: 0.04 });
    repo.generations.update(orphan.id, { status: 'running' });
    await t.close({ keep: true });

    const again = await startTestApp({ dataRoot });
    try {
      const resumed = await settle(again, accepted.id);
      assert.equal(resumed.status, 'completed', 'the accepted job was polled again, not resubmitted');
      assert.equal(resumed.billing, 'charged');
      const interrupted = (await again.call('GET', `/api/generations/${orphan.id}`)).body.generation;
      assert.equal(interrupted.status, 'interrupted');
      assert.equal(interrupted.billing, 'unknown');
    } finally {
      await again.close();
    }
  } finally {
    // dataRoot was handed to the second app, which removes it.
  }
});

test('estimates: live OpenRouter SKUs by resolution, audio and start image; token-priced models give no number', () => {
  const grokLite = { cents_per_image_input: '1', cents_per_video_output_second_480p: '2', cents_per_video_output_second_720p: '3', cents_per_video_output_second_1080p: '14' };
  assert.deepEqual(videoRate(grokLite, { resolution: '480p' }), { perSecond: 0.02, imageInput: 0, minimum: 0 });
  assert.equal(videoRate(grokLite, { resolution: '720p', image: true }).imageInput, 0.01);
  assert.equal(videoRate(grokLite, {}).perSecond, 0.14, 'no resolution: the dearest rate');
  const kling = { duration_seconds: '0.112', duration_seconds_with_audio: '0.168', text_to_video_duration_seconds_720p: '0.112' };
  assert.equal(videoRate(kling, { resolution: '720p', audio: true }).perSecond, 0.168, 'audio on: the with-audio rate');
  const veo = { duration_seconds_with_audio: '0.40', duration_seconds_with_audio_4k: '0.60', duration_seconds_without_audio: '0.20' };
  assert.equal(videoRate(veo, { resolution: '720p' }).perSecond, 0.6, 'unknown resolution: the dearest with-audio rate');
  assert.equal(videoRate(veo, { resolution: '4K' }).perSecond, 0.6);
  assert.equal(videoRate({ video_tokens: '0.000007' }, { resolution: '720p' }), null);
  assert.equal(videoRate({ cents_per_second_output: '28', minimum_cents_per_generation: '56' }).minimum, 0.56);
});

test('live model list: real capabilities replace hand-typed ones, models missing from OpenRouter are dropped, prices by resolution', async () => {
  const store = new Map();
  const repo = { settings: { get: (k, d) => store.get(k) ?? d, set: (k, v) => store.set(k, v) } };
  const provider = {
    models: [
      { id: 'img/one', operations: ['generate', 'edit'], sizes: [], qualities: [] },
      { id: 'x-ai/grok-imagine-video-1.5-lite', label: 'Grok Lite', operations: ['video'], durations: [5], aspects: ['16:9'], maxReferences: 1 },
      { id: 'alibaba/wan-2.7:free', label: 'Made up', operations: ['video'], durations: [5], aspects: ['16:9'], maxReferences: 1 },
    ],
  };
  const fetchImpl = async (url) => {
    if (url.endsWith('/videos/models')) {
      return Response.json({ data: [
        { id: 'x-ai/grok-imagine-video-1.5-lite', name: 'Grok Lite', supported_durations: [1, 2, 15], supported_aspect_ratios: ['16:9', '9:16'], supported_resolutions: ['480p', '720p', '1080p'], supported_frame_images: ['first_frame'], pricing_skus: { cents_per_video_output_second_480p: '2', cents_per_video_output_second_720p: '3' } },
        { id: 'heygen/heygen-video-1', name: 'HeyGen Video', supported_durations: [5, 15], supported_aspect_ratios: ['16:9'], supported_resolutions: ['480p'], supported_frame_images: [], pricing_skus: { duration_seconds_480p: '0.02' } },
      ] });
    }
    if (url.endsWith('/images/models')) return Response.json({ data: [{ id: 'img/one', supported_parameters: { input_references: { type: 'range', min: 0, max: 14 }, seed: { type: 'boolean' } } }] });
    return Response.json({ data: { endpoints: [{ pricing: [{ billable: 'output_image', unit: 'image', cost_usd: 0.03 }, { billable: 'output_image', unit: 'image', cost_usd: 0.04 }] }] } });
  };
  const catalog = createModelCatalog({ repo, provider, fetchImpl, log: {} });
  await catalog.refresh();
  const ids = provider.models.map((m) => m.id);
  assert.deepEqual(ids, ['img/one', 'x-ai/grok-imagine-video-1.5-lite', 'heygen/heygen-video-1']);
  const grok = provider.models[1];
  assert.deepEqual(grok.durations, [1, 2, 15]);
  assert.deepEqual(grok.resolutions, ['480p', '720p', '1080p']);
  assert.equal(grok.maxReferences, 1);
  assert.equal(provider.models[2].maxReferences, 0, 'no first-frame support: no start image');
  assert.deepEqual(provider.models[0].livePrice, { usd: 0.04, per: 'image' }, 'the dearest endpoint');
  assert.equal(provider.models[0].maxReferences, 14, 'all character and location references fit');
  assert.equal(provider.models[0].seed, true);
  assert.equal(catalog.status().videoModels, 2);
});
