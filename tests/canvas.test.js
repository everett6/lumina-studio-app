import assert from 'node:assert/strict';
import test from 'node:test';
import { validateGraph } from '../src/canvas.js';
import { startTestApp, tinyPngDataUrl } from './helpers.js';

const defaults = { provider: 'mock', model: 'mock-image' };

async function waitForRun(t, runId) {
  for (let i = 0; i < 200; i += 1) {
    const { run } = (await t.call('GET', `/api/canvas-runs/${runId}`)).body;
    if (run.status !== 'running') return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('run did not finish');
}

test('graph validation rejects bad ports, type mismatches, duplicates and cycles', () => {
  const node = (id, type) => ({ id, type, x: 0, y: 0, data: {} });
  const edge = (from, fp, to, tp) => ({ id: `${from}-${to}`, from: { node: from, port: fp }, to: { node: to, port: tp } });
  assert.throws(() => validateGraph({ nodes: [node('a', 'nope')], edges: [] }), /unknown node/);
  assert.throws(() => validateGraph({ nodes: [node('p', 'prompt'), node('o', 'output')], edges: [edge('p', 'text', 'o', 'image')] }), /Cannot connect text to image/);
  assert.throws(() => validateGraph({ nodes: [node('p', 'prompt'), node('g', 'generate')], edges: [edge('p', 'text', 'g', 'missing')] }), /missing port/);
  assert.throws(() => validateGraph({
    nodes: [node('p', 'prompt'), node('q', 'prompt'), node('g', 'generate')],
    edges: [edge('p', 'text', 'g', 'prompt'), edge('q', 'text', 'g', 'prompt')],
  }), /single connection/);
  assert.throws(() => validateGraph({
    nodes: [node('d1', 'director'), node('d2', 'director')],
    edges: [edge('d1', 'text', 'd2', 'text'), edge('d2', 'text', 'd1', 'text')],
  }), /loop/);
});

test('template canvas runs end to end: generate feeds two parallel edits', async () => {
  const t = await startTestApp();
  try {
    const { project } = (await t.call('POST', '/api/projects', { name: 'Canvas' })).body;
    const { canvas } = (await t.call('POST', `/api/projects/${project.id}/canvases`, { template: 'generate-then-edit' })).body;
    assert.equal(canvas.graph.nodes.length, 6);
    const { run } = (await t.call('POST', `/api/canvases/${canvas.id}/run`, { defaults })).body;
    const finished = await waitForRun(t, run.id);
    assert.equal(finished.status, 'completed', JSON.stringify(finished.nodeState));
    const { g1, x1, x2 } = finished.nodeState;
    assert.ok(g1.assetId && x1.assetId && x2.assetId);
    assert.notEqual(x1.assetId, x2.assetId);
    const generations = (await t.call('GET', `/api/projects/${project.id}`)).body.generations;
    const edits = generations.filter((g) => g.canvasRunId === run.id && g.operation === 'edit');
    assert.equal(edits.length, 2);
    assert.ok(edits.every((g) => g.inputAssetIds[0] === g1.assetId));

    // Running one node reuses cached upstream results instead of regenerating them.
    const single = (await t.call('POST', `/api/canvases/${canvas.id}/run`, { nodeId: 'x1', defaults })).body.run;
    const singleDone = await waitForRun(t, single.id);
    assert.equal(singleDone.status, 'completed');
    assert.equal(singleDone.nodeState.g1.reused, true);
    assert.equal(singleDone.nodeState.g1.assetId, g1.assetId);
    assert.equal(singleDone.nodeState.x2, undefined);
  } finally {
    await t.close();
  }
});

test('failures mark the node failed and downstream nodes skipped', async () => {
  const t = await startTestApp();
  try {
    const { project } = (await t.call('POST', '/api/projects', { name: 'Canvas fail' })).body;
    const { canvas } = (await t.call('POST', `/api/projects/${project.id}/canvases`, { template: 'prompt-to-image' })).body;
    canvas.graph.nodes.find((n) => n.id === 'p1').data.text = 'this will [fail]';
    const saved = (await t.call('PUT', `/api/canvases/${canvas.id}`, { graph: canvas.graph, version: canvas.version })).body.canvas;
    assert.equal(saved.version, 2);
    const stale = await t.call('PUT', `/api/canvases/${canvas.id}`, { graph: canvas.graph, version: 1 });
    assert.equal(stale.status, 409);
    const { run } = (await t.call('POST', `/api/canvases/${canvas.id}/run`, { defaults })).body;
    const finished = await waitForRun(t, run.id);
    assert.equal(finished.status, 'failed');
    assert.equal(finished.nodeState.g1.status, 'failed');
    assert.equal(finished.nodeState.o1.status, 'skipped');
  } finally {
    await t.close();
  }
});

test('reference node feeds an edit node; empty prompt is reported on its node', async () => {
  const t = await startTestApp();
  try {
    const { project } = (await t.call('POST', '/api/projects', { name: 'Refs canvas' })).body;
    const { asset } = (await t.call('POST', '/api/assets', { projectId: project.id, dataUrl: tinyPngDataUrl() })).body;
    const { canvas } = (await t.call('POST', `/api/projects/${project.id}/canvases`, { name: 'Blank' })).body;
    const graph = {
      nodes: [
        { id: 'r', type: 'reference', x: 0, y: 0, data: { assetId: asset.id } },
        { id: 'p', type: 'prompt', x: 0, y: 200, data: { text: 'make it blue' } },
        { id: 'e', type: 'edit', x: 300, y: 0, data: defaults },
        { id: 'p2', type: 'prompt', x: 0, y: 400, data: { text: '' } },
        { id: 'g', type: 'generate', x: 300, y: 400, data: defaults },
      ],
      edges: [
        { id: 'e1', from: { node: 'r', port: 'image' }, to: { node: 'e', port: 'images' } },
        { id: 'e2', from: { node: 'p', port: 'text' }, to: { node: 'e', port: 'prompt' } },
        { id: 'e3', from: { node: 'p2', port: 'text' }, to: { node: 'g', port: 'prompt' } },
      ],
    };
    const saved = (await t.call('PUT', `/api/canvases/${canvas.id}`, { graph, version: canvas.version })).body.canvas;
    const { run } = (await t.call('POST', `/api/canvases/${saved.id}/run`, {})).body;
    const finished = await waitForRun(t, run.id);
    assert.equal(finished.nodeState.e.status, 'completed');
    assert.equal(finished.nodeState.p2.status, 'failed');
    assert.match(finished.nodeState.p2.error, /empty/);
    assert.equal(finished.nodeState.g.status, 'skipped');
  } finally {
    await t.close();
  }
});

test('video node turns a prompt (and optional image) into a clip', async () => {
  const t = await startTestApp();
  try {
    const { project } = (await t.call('POST', '/api/projects', { name: 'Video canvas' })).body;
    const { canvas } = (await t.call('POST', `/api/projects/${project.id}/canvases`, { name: 'Clip' })).body;
    const graph = {
      nodes: [
        { id: 'p', type: 'prompt', x: 0, y: 0, data: { text: 'waves at night' } },
        { id: 'v', type: 'video', x: 300, y: 0, data: { provider: 'mock', model: 'mock-video', duration: 4 } },
      ],
      edges: [{ id: 'e', from: { node: 'p', port: 'text' }, to: { node: 'v', port: 'prompt' } }],
    };
    await t.call('PUT', `/api/canvases/${canvas.id}`, { graph, version: canvas.version });
    const { run } = (await t.call('POST', `/api/canvases/${canvas.id}/run`, {})).body;
    const finished = await waitForRun(t, run.id);
    assert.equal(finished.status, 'completed', JSON.stringify(finished.nodeState));
    assert.match(finished.nodeState.v.videoPath, /\.mp4$/);
  } finally {
    await t.close();
  }
});
