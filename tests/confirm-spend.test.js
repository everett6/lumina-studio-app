import assert from 'node:assert/strict';
import test from 'node:test';
import { startTestApp } from './helpers.js';

// A total budget of $0 makes every paid request stop at the budget check, so nothing here can reach a provider.
const noMoney = { enabled: true, strictPrices: false, totalUsd: 0, retryReserveUsd: 0, perRequestUsd: 2, confirmPaid: true };
const paid = (projectId) => ({ projectId, operation: 'generate', prompt: 'a lighthouse', provider: 'fal', model: 'fal-ai/flux/schnell', size: '1024x1024' });

test('confirm spend: app clicks on paid models need confirmation; free models, MCP and confirmed requests do not', async () => {
  const t = await startTestApp({ budgetSettings: noMoney });
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Confirm' })).body.project;
    await t.call('PUT', '/api/settings/keys/fal', { key: 'test-not-a-real-key' }); // saved locally only; the $0 budget stops every request
    await t.call('PUT', '/api/settings/keys/openai', { key: 'test-not-a-real-key' });
    // A paid model whose cost cannot be bounded in advance (billed per token) is refused outright, before any question.
    const unbounded = await t.call('POST', '/api/generate', { projectId: project.id, operation: 'generate', prompt: 'a lighthouse', provider: 'openai', model: 'gpt-image-2.5-flare', size: '1024x1024', quality: 'low' });
    assert.equal(unbounded.status, 402);
    assert.match(unbounded.body.error, /no bounded price/);
    const asked = await t.call('POST', '/api/generate', paid(project.id));
    assert.equal(asked.status, 428);
    assert.equal(asked.body.needsSpendConfirm, true);
    assert.match(asked.body.error, /paid credits/);
    assert.equal((await t.call('GET', `/api/projects/${project.id}`)).body.generations?.length ?? 0, 0, 'nothing queued');

    // Confirmed: past the question, then stopped by the $0 budget (proves the confirm gate is the only thing it skipped).
    const confirmed = await t.call('POST', '/api/generate', paid(project.id), { headers: { 'x-lumina-confirm-spend': '1' } });
    assert.equal(confirmed.status, 402);
    const fromMcp = await t.call('POST', '/api/generate', paid(project.id), { headers: { 'x-lumina-client': 'mcp' } });
    assert.equal(fromMcp.status, 402, 'MCP spending stays under the budget approvals');

    const free = await t.call('POST', '/api/generate', { ...paid(project.id), provider: 'mock', model: 'mock-image' });
    assert.notEqual(free.status, 428, 'free (keyless) providers are never asked');

    assert.equal((await t.call('GET', '/api/budget')).body.settings.confirmPaid, true);
    await t.call('PUT', '/api/budget', { ...noMoney, confirmPaid: false });
    assert.equal((await t.call('POST', '/api/generate', paid(project.id))).status, 402, 'turned off: no question, budget still applies');
  } finally {
    await t.close();
  }
});

test('confirm spend: a canvas with paid nodes asks before the run starts', async () => {
  const t = await startTestApp({ budgetSettings: noMoney });
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Canvas' })).body.project;
    await t.call('PUT', '/api/settings/keys/fal', { key: 'test-not-a-real-key' });
    const graph = { nodes: [
      { id: 'p1', type: 'prompt', x: 0, y: 0, data: { text: 'a lighthouse' } },
      { id: 'g1', type: 'generate', x: 200, y: 0, data: { provider: 'fal', model: 'fal-ai/flux/schnell' } },
    ], edges: [{ id: 'e1', from: { node: 'p1', port: 'text' }, to: { node: 'g1', port: 'prompt' } }] };
    const canvas = (await t.call('POST', `/api/projects/${project.id}/canvases`, { name: 'Paid' })).body.canvas;
    const saved = await t.call('PUT', `/api/canvases/${canvas.id}`, { graph, version: canvas.version });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const run = await t.call('POST', `/api/canvases/${canvas.id}/run`, {});
    assert.equal(run.status, 428, JSON.stringify(run.body));
    assert.equal(run.body.jobs, 1);
  } finally {
    await t.close();
  }
});
