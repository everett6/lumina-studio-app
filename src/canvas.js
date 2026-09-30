import { RequestError } from './generation.js';

// Port types: 'text' carries a prompt string, 'image' carries one or more asset ids.
export const nodeTypes = {
  prompt: { inputs: {}, outputs: { text: 'text' } },
  reference: { inputs: {}, outputs: { image: 'image' } },
  director: { inputs: { text: { type: 'text', required: true } }, outputs: { text: 'text' } },
  generate: { inputs: { prompt: { type: 'text', required: true }, images: { type: 'image', multiple: true } }, outputs: { image: 'image' } },
  edit: { inputs: { prompt: { type: 'text', required: true }, images: { type: 'image', required: true, multiple: true } }, outputs: { image: 'image' } },
  output: { inputs: { image: { type: 'image', required: true } }, outputs: {} },
};

const maxNodes = 200;

export function emptyGraph() {
  return { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
}

export function validateGraph(graph) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new RequestError(400, 'Canvas graph is malformed.');
  if (graph.nodes.length > maxNodes) throw new RequestError(400, `Canvases are limited to ${maxNodes} nodes.`);
  const nodes = new Map();
  for (const node of graph.nodes) {
    if (typeof node?.id !== 'string' || !nodeTypes[node.type]) throw new RequestError(400, 'Canvas contains an unknown node type.');
    if (nodes.has(node.id)) throw new RequestError(400, 'Canvas contains duplicate node ids.');
    nodes.set(node.id, node);
  }
  const incoming = new Map();
  for (const edge of graph.edges) {
    const from = nodes.get(edge?.from?.node);
    const to = nodes.get(edge?.to?.node);
    const outType = from && nodeTypes[from.type].outputs[edge.from.port];
    const input = to && nodeTypes[to.type].inputs[edge.to.port];
    if (!outType || !input) throw new RequestError(400, 'Canvas contains a connection to a missing port.');
    if (outType !== input.type) throw new RequestError(400, `Cannot connect ${outType} to ${input.type}.`);
    const key = `${to.id}:${edge.to.port}`;
    const list = incoming.get(key) ?? [];
    if (list.length && !input.multiple) throw new RequestError(400, 'That input accepts a single connection.');
    list.push(edge);
    incoming.set(key, list);
  }
  topoOrder(graph);
  return { nodes, incoming };
}

function topoOrder(graph) {
  const indegree = new Map(graph.nodes.map((n) => [n.id, 0]));
  const next = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const edge of graph.edges) {
    indegree.set(edge.to.node, indegree.get(edge.to.node) + 1);
    next.get(edge.from.node).push(edge.to.node);
  }
  const ready = [...indegree].filter(([, d]) => d === 0).map(([id]) => id);
  const order = [];
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    for (const target of next.get(id)) {
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) ready.push(target);
    }
  }
  if (order.length !== graph.nodes.length) throw new RequestError(400, 'Canvas connections form a loop.');
  return order;
}

function ancestorsOf(graph, targetId) {
  const parents = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const edge of graph.edges) parents.get(edge.to.node).push(edge.from.node);
  const seen = new Set();
  const stack = [targetId];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(parents.get(id) ?? []));
  }
  return seen;
}

export const templates = {
  'prompt-to-image': {
    name: 'Prompt to image',
    graph: {
      nodes: [
        { id: 'p1', type: 'prompt', x: 60, y: 120, data: { text: 'A lighthouse on a basalt cliff at blue hour, long exposure sea' } },
        { id: 'g1', type: 'generate', x: 380, y: 100, data: {} },
        { id: 'o1', type: 'output', x: 700, y: 100, data: {} },
      ],
      edges: [
        { id: 'e1', from: { node: 'p1', port: 'text' }, to: { node: 'g1', port: 'prompt' } },
        { id: 'e2', from: { node: 'g1', port: 'image' }, to: { node: 'o1', port: 'image' } },
      ],
    },
  },
  'generate-then-edit': {
    name: 'Generate, then edit variations',
    graph: {
      nodes: [
        { id: 'p1', type: 'prompt', x: 40, y: 60, data: { text: 'Studio product photo of a ceramic coffee cup on travertine' } },
        { id: 'g1', type: 'generate', x: 340, y: 40, data: {} },
        { id: 'p2', type: 'prompt', x: 40, y: 300, data: { text: 'Same cup, but glazed deep cobalt blue' } },
        { id: 'p3', type: 'prompt', x: 40, y: 480, data: { text: 'Same cup, now on a sunlit linen tablecloth' } },
        { id: 'x1', type: 'edit', x: 660, y: 220, data: {} },
        { id: 'x2', type: 'edit', x: 660, y: 440, data: {} },
      ],
      edges: [
        { id: 'e1', from: { node: 'p1', port: 'text' }, to: { node: 'g1', port: 'prompt' } },
        { id: 'e2', from: { node: 'g1', port: 'image' }, to: { node: 'x1', port: 'images' } },
        { id: 'e3', from: { node: 'p2', port: 'text' }, to: { node: 'x1', port: 'prompt' } },
        { id: 'e4', from: { node: 'g1', port: 'image' }, to: { node: 'x2', port: 'images' } },
        { id: 'e5', from: { node: 'p3', port: 'text' }, to: { node: 'x2', port: 'prompt' } },
      ],
    },
  },
};

// Executes a canvas: every node's value is a memoized promise, so independent branches run in parallel
// and each generate/edit node becomes one job in the shared queue.
export function createCanvasRunner({ repo, generations, jobs, directors, keys }) {
  function previousResults(canvasId) {
    const rows = repo.runs.listByCanvas(canvasId);
    const results = {};
    for (const run of rows) {
      for (const [nodeId, state] of Object.entries(run.nodeState)) {
        if (!results[nodeId] && state.status === 'completed') results[nodeId] = state;
      }
    }
    return results;
  }

  function start(canvasId, { targetNodeId = null, defaults = {} } = {}) {
    const canvas = repo.canvases.get(canvasId);
    if (!canvas) throw new RequestError(404, 'Canvas not found.');
    const graph = canvas.graph;
    const { nodes, incoming } = validateGraph(graph);
    if (targetNodeId && !nodes.has(targetNodeId)) throw new RequestError(404, 'Node not found.');
    const scope = targetNodeId ? ancestorsOf(graph, targetNodeId) : new Set(nodes.keys());
    const cached = targetNodeId ? previousResults(canvasId) : {};

    const state = Object.fromEntries([...scope].map((id) => [id, { status: 'pending' }]));
    const run = repo.runs.create(canvasId, state);
    const save = () => repo.runs.update(run.id, { nodeState: state });
    const values = new Map();

    const inputsFor = (nodeId, port) => (incoming.get(`${nodeId}:${port}`) ?? []).map((edge) => value(edge.from.node));

    function value(nodeId) {
      if (!values.has(nodeId)) values.set(nodeId, evaluate(nodes.get(nodeId)));
      return values.get(nodeId);
    }

    async function evaluate(node) {
      const reuse = node.id !== targetNodeId && cached[node.id];
      if (reuse && (node.type === 'generate' || node.type === 'edit' || node.type === 'director')) {
        state[node.id] = { ...reuse, reused: true };
        save();
        return reuse.text !== undefined ? { text: reuse.text } : { assetIds: [reuse.assetId] };
      }
      const data = node.data ?? {};
      try {
        state[node.id] = { status: 'running' };
        save();
        let result;
        if (node.type === 'prompt') {
          const text = String(data.text ?? '').trim();
          if (!text) throw new RequestError(400, 'Prompt node is empty.');
          result = { text };
          state[node.id] = { status: 'completed', text };
        } else if (node.type === 'reference') {
          if (!data.assetId || !repo.assets.get(data.assetId)) throw new RequestError(400, 'Reference node has no image.');
          result = { assetIds: [data.assetId] };
          state[node.id] = { status: 'completed', assetId: data.assetId };
        } else if (node.type === 'director') {
          const [idea] = await Promise.all(inputsFor(node.id, 'text'));
          if (!idea) throw new RequestError(400, 'Connect a prompt to the director.');
          const spec = generations.resolveDirector(data.director || defaults.director);
          if (!spec) throw new RequestError(400, 'Choose a creative director.');
          const [directorId, model] = spec.split(':');
          const director = directors.get(directorId);
          const text = await director.refine({ key: director.keyless ? null : keys.get(director.keyProvider), model, idea: idea.text });
          result = { text };
          state[node.id] = { status: 'completed', text };
        } else if (node.type === 'generate' || node.type === 'edit') {
          const [prompts, images] = await Promise.all([Promise.all(inputsFor(node.id, 'prompt')), Promise.all(inputsFor(node.id, 'images'))]);
          if (!prompts[0]) throw new RequestError(400, 'Connect a prompt.');
          const inputAssetIds = images.flatMap((image) => image.assetIds);
          if (node.type === 'edit' && !inputAssetIds.length) throw new RequestError(400, 'Connect an image to edit.');
          const generation = generations.submit({
            projectId: canvas.projectId, prompt: prompts[0].text, inputAssetIds,
            provider: data.provider || defaults.provider, model: data.model || defaults.model,
            size: data.size, quality: data.quality, canvasRunId: run.id, nodeId: node.id,
          });
          state[node.id] = { status: 'running', generationId: generation.id };
          save();
          const done = await jobs.waitFor(generation.id);
          if (done?.status !== 'completed') throw new RequestError(502, done?.userError || 'Generation failed.');
          result = { assetIds: [done.assetId] };
          state[node.id] = { status: 'completed', generationId: done.id, assetId: done.assetId, assetPath: done.assetPath };
        } else if (node.type === 'output') {
          const [image] = await Promise.all(inputsFor(node.id, 'image'));
          if (!image) throw new RequestError(400, 'Connect an image to the output.');
          result = image;
          state[node.id] = { status: 'completed', assetId: image.assetIds[0] };
        }
        save();
        return result;
      } catch (error) {
        const upstream = error.upstream === true;
        state[node.id] = { status: upstream ? 'skipped' : 'failed', error: upstream ? 'An earlier step failed.' : error.message };
        save();
        throw Object.assign(new Error(error.message), { upstream: true });
      }
    }

    const done = Promise.allSettled([...scope].map((id) => value(id))).then((results) => {
      const failed = results.some((r) => r.status === 'rejected');
      return repo.runs.update(run.id, { status: failed ? 'failed' : 'completed', nodeState: state });
    });
    return { run, done };
  }

  return { start };
}
