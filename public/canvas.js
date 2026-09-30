import { $, api, downloadAsset, emit, h, modelsFor, on, pickAsset, state, toast } from './lib.js';

const titles = { prompt: 'Prompt', reference: 'Reference image', director: 'Creative director', generate: 'Generate image', edit: 'Edit image', output: 'Output' };
const ns = 'http://www.w3.org/2000/svg';
const ui = { canvas: null, canvases: [], nodeEls: new Map(), run: null, runTimer: null, saveTimer: null, saving: false, dirty: false, drag: null, link: null };
const assetPaths = new Map();

const graph = () => ui.canvas.graph;
const nodeTypes = () => state.catalog?.nodeTypes ?? {};

function setSaveState(text) {
  $('#canvas-save-state').textContent = text;
}

// ---------- persistence ----------

function scheduleSave() {
  ui.dirty = true;
  setSaveState('Unsaved');
  clearTimeout(ui.saveTimer);
  ui.saveTimer = setTimeout(save, 600);
}

async function save() {
  if (!ui.canvas || ui.saving || !ui.dirty) return;
  ui.saving = true;
  ui.dirty = false;
  setSaveState('Saving…');
  try {
    const { canvas } = await api(`/api/canvases/${ui.canvas.id}`, { method: 'PUT', body: { graph: graph(), version: ui.canvas.version, name: ui.canvas.name } });
    ui.canvas.version = canvas.version;
    const option = [...$('#canvas-select').options].find((o) => o.value === canvas.id);
    if (option) option.textContent = `${canvas.name} (${canvas.graph.nodes.length} nodes)`;
    setSaveState('Saved');
  } catch (error) {
    if (error.status === 409 && error.data?.canvas) {
      ui.canvas = error.data.canvas;
      render();
    }
    setSaveState('Not saved');
    toast(error.message, 'error');
  } finally {
    ui.saving = false;
    if (ui.dirty) scheduleSave();
  }
}

async function flushSave() {
  clearTimeout(ui.saveTimer);
  while (ui.saving) await new Promise((resolve) => setTimeout(resolve, 50));
  await save();
}

async function loadCanvasList(selectId) {
  ui.canvases = (await api(`/api/projects/${state.project.id}`)).canvases;
  const select = $('#canvas-select');
  select.replaceChildren(...ui.canvases.map((c) => h('option', { value: c.id }, `${c.name} (${c.nodeCount} nodes)`)));
  const hasAny = ui.canvases.length > 0;
  $('#canvas-empty').classList.toggle('hidden', hasAny);
  $('#canvas-world').classList.toggle('hidden', !hasAny);
  if (!hasAny) {
    ui.canvas = null;
    return;
  }
  const id = selectId && ui.canvases.some((c) => c.id === selectId) ? selectId : ui.canvas && ui.canvases.some((c) => c.id === ui.canvas.id) ? ui.canvas.id : ui.canvases[0].id;
  select.value = id;
  if (ui.canvas?.id !== id) await openCanvas(id);
}

async function openCanvas(id) {
  await flushSave();
  const { canvas, lastRun } = await api(`/api/canvases/${id}`);
  ui.canvas = canvas;
  ui.canvas.graph.viewport ??= { x: 0, y: 0, zoom: 1 };
  ui.run = lastRun;
  $('#canvas-select').value = id;
  setSaveState('Saved');
  render();
  if (lastRun?.status === 'running') watchRun(lastRun.id);
}

async function createCanvas({ template, name, ask = true } = {}) {
  if (!template && ask) {
    name = prompt('Name this canvas', 'Untitled canvas');
    if (name === null) return null;
  }
  const { canvas } = await api(`/api/projects/${state.project.id}/canvases`, { method: 'POST', body: { name, template } });
  await loadCanvasList(canvas.id);
  return canvas;
}

// ---------- graph editing ----------

function newId(prefix) {
  return `${prefix}${Math.random().toString(36).slice(2, 8)}`;
}

function defaultData(type) {
  if (type !== 'generate' && type !== 'edit') return {};
  const first = modelsFor(type).find((m) => m.provider.ready);
  return first ? { provider: first.provider.id, model: first.model.id, size: '1024x1024' } : { size: '1024x1024' };
}

function addNode(type, data = {}) {
  const stage = $('#canvas-stage').getBoundingClientRect();
  const { x, y, zoom } = graph().viewport;
  // Find a free slot inside the visible area; if it is full, stagger near its centre so the node stays in view.
  const left = (20 - x) / zoom;
  const top = (20 - y) / zoom;
  const right = (stage.width - 280 * zoom - x) / zoom;
  const bottom = (stage.height - 160 * zoom - y) / zoom;
  const taken = (ax, ay) => graph().nodes.some((n) => Math.abs(n.x - ax) < 280 && Math.abs(n.y - ay) < 200);
  let spot = null;
  for (let py = top; py <= bottom && !spot; py += 120) {
    for (let px = left; px <= right && !spot; px += 150) {
      if (!taken(px, py)) spot = { x: px, y: py };
    }
  }
  const stagger = (graph().nodes.length % 5) * 28;
  spot ??= { x: (stage.width / 2 - x) / zoom - 130 + stagger, y: (stage.height / 2 - y) / zoom - 80 + stagger };
  const node = { id: newId(type[0]), type, x: Math.round(spot.x), y: Math.round(spot.y), data: { ...defaultData(type), ...data } };
  graph().nodes.push(node);
  render();
  scheduleSave();
  return node;
}

function removeNode(id) {
  graph().nodes = graph().nodes.filter((n) => n.id !== id);
  graph().edges = graph().edges.filter((e) => e.from.node !== id && e.to.node !== id);
  render();
  scheduleSave();
}

function duplicateNode(node) {
  const copy = { ...structuredClone(node), id: newId(node.type[0]), x: node.x + 40, y: node.y + 60 };
  graph().nodes.push(copy);
  // Keep the copy's inputs so it branches from the same sources.
  for (const edge of graph().edges.filter((e) => e.to.node === node.id)) {
    graph().edges.push({ id: newId('e'), from: { ...edge.from }, to: { node: copy.id, port: edge.to.port } });
  }
  render();
  scheduleSave();
}

function connect(from, to) {
  const fromType = nodeTypes()[graph().nodes.find((n) => n.id === from.node).type].outputs[from.port];
  const toNode = graph().nodes.find((n) => n.id === to.node);
  const input = nodeTypes()[toNode.type].inputs[to.port];
  if (from.node === to.node) return;
  if (fromType !== input.type) return toast(`Cannot connect ${fromType} to ${input.type}.`, 'error');
  if (!input.multiple) graph().edges = graph().edges.filter((e) => !(e.to.node === to.node && e.to.port === to.port));
  if (graph().edges.some((e) => e.from.node === from.node && e.from.port === from.port && e.to.node === to.node && e.to.port === to.port)) return;
  graph().edges.push({ id: newId('e'), from, to });
  renderEdges();
  scheduleSave();
}

// ---------- rendering ----------

function modelSelect(node) {
  const options = modelsFor(node.type);
  const select = h('select', { 'aria-label': 'Model', onchange: () => {
    const [provider, model] = select.value.split('|');
    Object.assign(node.data, { provider, model });
    scheduleSave();
  } }, ...options.map(({ provider, model, value }) => h('option', { value, disabled: !provider.ready }, `${provider.label} · ${model.label}`)));
  select.value = `${node.data.provider}|${node.data.model}`;
  if (!options.length) select.append(h('option', { value: '' }, 'No models'));
  return select;
}

function nodeBody(node) {
  const data = node.data ??= {};
  const result = ui.run?.nodeState?.[node.id];
  const resultPath = result?.assetPath ?? (result?.assetId ? assetPaths.get(result.assetId) : null);
  switch (node.type) {
    case 'prompt':
      return [h('textarea', { rows: 4, value: data.text ?? '', placeholder: 'Describe the image or the change…', oninput: (e) => { data.text = e.target.value; scheduleSave(); } })];
    case 'reference': {
      const path = data.assetId && assetPaths.get(data.assetId);
      return [
        path ? h('img.node-image', { src: path, alt: 'Reference' }) : h('div.node-placeholder', {}, data.assetId ? 'Image not found' : 'No image'),
        h('button.button.secondary.small', { onclick: async () => {
          const asset = await pickAsset({ title: 'Choose a reference image' });
          if (!asset) return;
          assetPaths.set(asset.id, asset.path);
          data.assetId = asset.id;
          render();
          scheduleSave();
        } }, data.assetId ? 'Change image' : 'Choose image'),
      ];
    }
    case 'director': {
      const select = h('select', { 'aria-label': 'Director', onchange: () => { data.director = select.value; scheduleSave(); } },
        ...(state.catalog?.directors ?? []).flatMap((d) => d.models.map((m) => h('option', { value: `${d.id}:${m}`, disabled: !d.ready }, `${d.label} · ${m}`))));
      if (!data.director) data.director = select.querySelector('option:not([disabled])')?.value ?? '';
      select.value = data.director;
      return [select, result?.text ? h('p.node-text', {}, result.text) : null];
    }
    case 'generate':
    case 'edit': {
      const size = h('select', { 'aria-label': 'Format', onchange: () => { data.size = size.value; scheduleSave(); } },
        h('option', { value: '1024x1024' }, 'Square'), h('option', { value: '1536x1024' }, 'Landscape'), h('option', { value: '1024x1536' }, 'Portrait'));
      size.value = data.size ?? '1024x1024';
      return [modelSelect(node), size, resultPath ? h('img.node-image', { src: resultPath, alt: 'Result' }) : null];
    }
    case 'output':
      return resultPath
        ? [h('img.node-image', { src: resultPath, alt: 'Output' }), h('button.button.secondary.small', { onclick: () => downloadAsset(resultPath, resultPath.split('/').pop()) }, 'Download')]
        : [h('div.node-placeholder', {}, 'Run the canvas to see the result')];
    default:
      return [];
  }
}

function portList(node, direction) {
  const spec = nodeTypes()[node.type]?.[direction] ?? {};
  return Object.entries(spec).map(([port, value]) => {
    const type = direction === 'inputs' ? value.type : value;
    const label = direction === 'inputs' ? `${port}${value.required ? '' : ' (optional)'}` : port;
    return h(`div.port.port-${direction === 'inputs' ? 'in' : 'out'}`, { dataset: { node: node.id, port, type, direction } },
      h('span.port-dot', { dataset: { type } }), h('span.port-label', {}, label));
  });
}

function renderNode(node) {
  const result = ui.run?.nodeState?.[node.id];
  const status = result?.status;
  const runnable = ['generate', 'edit', 'director', 'output'].includes(node.type);
  const el = h('div.canvas-node', { dataset: { id: node.id, type: node.type, status: status ?? '' } },
    h('div.node-head', { dataset: { drag: node.id } },
      h('span.node-title', {}, titles[node.type]),
      status ? h('span.node-status', {}, result.reused ? 'cached' : status) : null,
      runnable ? h('button.node-btn', { title: 'Run up to this node', 'aria-label': 'Run up to this node', onclick: () => runCanvas(node.id) }, '▶') : null,
      h('button.node-btn', { title: 'Duplicate (branch)', 'aria-label': 'Duplicate node', onclick: () => duplicateNode(node) }, '⧉'),
      h('button.node-btn', { title: 'Delete node', 'aria-label': 'Delete node', onclick: () => removeNode(node.id) }, '✕')),
    h('div.node-ports', {}, h('div.ports-in', {}, portList(node, 'inputs')), h('div.ports-out', {}, portList(node, 'outputs'))),
    h('div.node-body', {}, nodeBody(node)),
    result?.error ? h('p.node-error', {}, result.error) : null);
  el.style.transform = `translate(${node.x}px, ${node.y}px)`;
  return el;
}

function applyViewport() {
  const { x, y, zoom } = graph().viewport;
  $('#canvas-world').style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
}

function portCenter(nodeId, port, direction) {
  const el = ui.nodeEls.get(nodeId)?.querySelector(`.port[data-port="${port}"][data-direction="${direction}"] .port-dot`);
  const node = graph().nodes.find((n) => n.id === nodeId);
  if (!el || !node) return null;
  const nodeEl = ui.nodeEls.get(nodeId);
  let x = el.offsetWidth / 2;
  let y = el.offsetHeight / 2;
  for (let cur = el; cur && cur !== nodeEl; cur = cur.offsetParent) {
    x += cur.offsetLeft;
    y += cur.offsetTop;
  }
  return { x: node.x + x, y: node.y + y };
}

const curve = (a, b) => {
  const dx = Math.max(60, Math.abs(b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
};

function renderEdges() {
  const svg = $('#canvas-edges');
  svg.replaceChildren();
  for (const edge of graph().edges) {
    const a = portCenter(edge.from.node, edge.from.port, 'outputs');
    const b = portCenter(edge.to.node, edge.to.port, 'inputs');
    if (!a || !b) continue;
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', curve(a, b));
    path.setAttribute('class', 'edge');
    path.dataset.edge = edge.id;
    const title = document.createElementNS(ns, 'title');
    title.textContent = 'Click to remove connection';
    path.append(title);
    path.addEventListener('click', () => {
      graph().edges = graph().edges.filter((e) => e.id !== edge.id);
      renderEdges();
      scheduleSave();
    });
    svg.append(path);
  }
  if (ui.link?.to) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', curve(ui.link.fromPoint, ui.link.to));
    path.setAttribute('class', 'edge pending');
    svg.append(path);
  }
}

function render() {
  if (!ui.canvas) return;
  for (const asset of state.detail?.assets ?? []) assetPaths.set(asset.id, asset.path);
  const world = $('#canvas-world');
  world.querySelectorAll('.canvas-node').forEach((el) => el.remove());
  ui.nodeEls.clear();
  for (const node of graph().nodes) {
    const el = renderNode(node);
    ui.nodeEls.set(node.id, el);
    world.append(el);
  }
  applyViewport();
  renderEdges();
  $('#canvas-run').disabled = ui.run?.status === 'running';
  $('#canvas-run').textContent = ui.run?.status === 'running' ? 'Running…' : 'Run all';
}

// ---------- pointer interaction ----------

function toWorld(event) {
  const rect = $('#canvas-stage').getBoundingClientRect();
  const { x, y, zoom } = graph().viewport;
  return { x: (event.clientX - rect.left - x) / zoom, y: (event.clientY - rect.top - y) / zoom };
}

function bindPointer() {
  const stage = $('#canvas-stage');
  stage.addEventListener('pointerdown', (event) => {
    if (!ui.canvas || event.button !== 0) return;
    const port = event.target.closest('.port-out .port-dot');
    const head = event.target.closest('.node-head');
    if (port) {
      const { node, port: name } = port.parentElement.dataset;
      ui.link = { from: { node, port: name }, fromPoint: portCenter(node, name, 'outputs'), to: null };
    } else if (head && !event.target.closest('button')) {
      const node = graph().nodes.find((n) => n.id === head.dataset.drag);
      const start = toWorld(event);
      ui.drag = { kind: 'node', node, dx: start.x - node.x, dy: start.y - node.y };
    } else if (!event.target.closest('.canvas-node') && !event.target.closest('.edge')) {
      ui.drag = { kind: 'pan', startX: event.clientX, startY: event.clientY, origin: { ...graph().viewport } };
    } else {
      return;
    }
    stage.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  stage.addEventListener('pointermove', (event) => {
    if (ui.link) {
      ui.link.to = toWorld(event);
      renderEdges();
    } else if (ui.drag?.kind === 'node') {
      const point = toWorld(event);
      ui.drag.node.x = Math.round(point.x - ui.drag.dx);
      ui.drag.node.y = Math.round(point.y - ui.drag.dy);
      ui.nodeEls.get(ui.drag.node.id).style.transform = `translate(${ui.drag.node.x}px, ${ui.drag.node.y}px)`;
      renderEdges();
    } else if (ui.drag?.kind === 'pan') {
      graph().viewport.x = ui.drag.origin.x + event.clientX - ui.drag.startX;
      graph().viewport.y = ui.drag.origin.y + event.clientY - ui.drag.startY;
      applyViewport();
    }
  });
  stage.addEventListener('pointerup', (event) => {
    if (ui.link) {
      // Pointer capture retargets events to the stage; find the input port under the pointer instead.
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.port-in');
      const link = ui.link;
      ui.link = null;
      if (target) connect(link.from, { node: target.dataset.node, port: target.dataset.port });
      else renderEdges();
    } else if (ui.drag) {
      if (ui.drag.kind === 'node' || ui.drag.kind === 'pan') scheduleSave();
      ui.drag = null;
    }
  });
  stage.addEventListener('wheel', (event) => {
    if (!ui.canvas) return;
    event.preventDefault();
    const rect = stage.getBoundingClientRect();
    const vp = graph().viewport;
    const zoom = Math.min(2, Math.max(0.3, vp.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1)));
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    vp.x = px - ((px - vp.x) / vp.zoom) * zoom;
    vp.y = py - ((py - vp.y) / vp.zoom) * zoom;
    vp.zoom = zoom;
    applyViewport();
    scheduleSave();
  }, { passive: false });
}

// ---------- running ----------

async function runCanvas(nodeId = null) {
  if (!ui.canvas) return;
  await flushSave();
  const { run } = await api(`/api/canvases/${ui.canvas.id}/run`, { method: 'POST', body: { nodeId } });
  ui.run = run;
  render();
  watchRun(run.id);
}

function watchRun(runId) {
  clearTimeout(ui.runTimer);
  const tick = async () => {
    try {
      const { run } = await api(`/api/canvas-runs/${runId}`);
      if (!ui.canvas || run.canvasId !== ui.canvas.id) return;
      ui.run = run;
      render();
      if (run.status === 'running') {
        ui.runTimer = setTimeout(tick, 900);
      } else {
        emit('refresh-project');
        toast(run.status === 'completed' ? 'Canvas run finished.' : 'Canvas run finished with errors. Check the red nodes.', run.status === 'completed' ? 'info' : 'error');
      }
    } catch (error) {
      toast(error.message, 'error');
    }
  };
  ui.runTimer = setTimeout(tick, 600);
}

// "Add to canvas" from Create or Library: drop a reference node on the most recent canvas.
async function addAssetToCanvas(asset) {
  if (!asset?.id) return;
  emit('open-tab', 'canvas');
  await loadCanvasList();
  if (!ui.canvas) await createCanvas({ name: 'Canvas 1', ask: false });
  assetPaths.set(asset.id, asset.path);
  addNode('reference', { assetId: asset.id });
  await flushSave();
  toast(`Added to "${ui.canvas.name}".`);
}

const guard = (fn) => async (...args) => {
  try { await fn(...args); } catch (error) { toast(error.message, 'error'); }
};

export function initCanvas() {
  bindPointer();
  $('#add-node-group').replaceChildren(...Object.entries(titles).map(([type, title]) => h('button.button.secondary.small', { onclick: () => ui.canvas ? addNode(type) : toast('Create a canvas first.') }, `+ ${title}`)));
  $('#canvas-select').addEventListener('change', guard(() => openCanvas($('#canvas-select').value)));
  $('#canvas-new').addEventListener('click', guard(() => createCanvas()));
  $('#canvas-empty-new').addEventListener('click', guard(() => createCanvas()));
  $('#canvas-template').addEventListener('change', guard(async (event) => {
    const template = event.target.value;
    event.target.value = '';
    if (template) await createCanvas({ template });
  }));
  $('#canvas-run').addEventListener('click', guard(() => runCanvas()));
  $('#canvas-rename').addEventListener('click', guard(async () => {
    if (!ui.canvas) return;
    const name = prompt('Rename canvas', ui.canvas.name);
    if (!name?.trim()) return;
    ui.canvas.name = name.trim();
    ui.dirty = true;
    await flushSave();
    await loadCanvasList(ui.canvas.id);
  }));
  $('#canvas-delete').addEventListener('click', guard(async () => {
    if (!ui.canvas || !confirm(`Delete canvas "${ui.canvas.name}"? Generated images stay in the library.`)) return;
    clearTimeout(ui.saveTimer);
    await api(`/api/canvases/${ui.canvas.id}`, { method: 'DELETE' });
    ui.canvas = null;
    await loadCanvasList();
  }));

  on('tab', guard(async (tab) => {
    if (tab !== 'canvas' || !state.project) return;
    if (!$('#canvas-template').options[1]) {
      const { templates } = await api('/api/templates');
      $('#canvas-template').append(...templates.map((t) => h('option', { value: t.id }, t.name)));
    }
    await loadCanvasList();
  }));
  on('project', guard(async (detail) => {
    if (ui.canvas && ui.canvas.projectId !== detail.project.id) {
      clearTimeout(ui.runTimer);
      await flushSave();
      ui.canvas = null;
    }
    if (!$('#canvas-view').classList.contains('hidden')) await loadCanvasList();
    render();
  }));
  on('add-to-canvas', guard(addAssetToCanvas));
  on('catalog', () => render());
  window.addEventListener('beforeunload', () => { if (ui.dirty) save(); });
}
