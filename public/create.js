import { $, api, downloadAsset, emit, h, modelsFor, on, pickAsset, state, toast, uploadReference } from './lib.js';

const local = { inputs: [], shown: null, polling: new Set(), operation: 'generate' };
const statusLabels = { queued: 'Queued', running: 'Generating…', failed: 'Failed', interrupted: 'Interrupted', completed: 'Done' };

function selectedModel() {
  const [providerId, modelId] = $('#model-select').value.split('|');
  const provider = state.catalog?.providers.find((p) => p.id === providerId);
  return { provider, model: provider?.models.find((m) => m.id === modelId) };
}

// The model list follows what the current inputs need: generation models without inputs, edit models with them.
function renderModelOptions() {
  if (!state.catalog) return;
  const operation = local.inputs.length ? 'edit' : 'generate';
  const select = $('#model-select');
  const previous = select.value;
  const options = modelsFor(operation);
  select.replaceChildren(...options.map(({ provider, model, value }) => h('option', { value, disabled: !provider.ready },
    `${provider.label} · ${model.label}${provider.ready ? '' : ' (add key)'}`)));
  const ready = options.filter((o) => o.provider.ready);
  const saved = (() => { try { return localStorage.getItem(`lumina-model-${operation}`); } catch { return null; } })();
  select.value = [previous, saved].find((v) => ready.some((o) => o.value === v)) ?? ready[0]?.value ?? '';
  renderModelDetails();
}

function renderModelDetails() {
  const { model } = selectedModel();
  const qualityField = $('#quality-field');
  qualityField.classList.toggle('hidden', !model?.qualities.length);
  if (model?.qualities.length) {
    const current = $('#quality-select').value;
    $('#quality-select').replaceChildren(...model.qualities.map((q) => h('option', { value: q }, q[0].toUpperCase() + q.slice(1))));
    $('#quality-select').value = model.qualities.includes(current) ? current : model.qualities[Math.min(1, model.qualities.length - 1)];
  }
  $('#model-note').textContent = model ? model.note : 'Add an API key in Settings to start generating.';
  $('#reference-hint').textContent = model?.maxReferences
    ? `${local.inputs.length}/${model.maxReferences} input image(s) — the prompt describes the edit`
    : 'Add images to edit or guide the result';
  $('#generate-btn').disabled = !model;
  $('#generate-btn').textContent = local.inputs.length ? 'Edit image' : 'Generate image';
}

function renderDirectors() {
  const options = [h('option', { value: '' }, 'Off — use my prompt as written')];
  for (const director of state.catalog?.directors ?? []) {
    for (const model of director.models) {
      options.push(h('option', { value: `${director.id}:${model}`, disabled: !director.ready }, `${director.label} · ${model}${director.ready ? '' : ' (add key)'}`));
    }
  }
  const select = $('#director-select');
  const previous = select.value;
  select.replaceChildren(...options);
  select.value = [...select.options].some((o) => o.value === previous && !o.disabled) ? previous : '';
}

function renderInputs() {
  $('#reference-tray').replaceChildren(...local.inputs.map((asset) => h('div.tray-item', {},
    h('img', { src: asset.path, alt: asset.label || 'Input image' }),
    h('button', { title: 'Remove', 'aria-label': 'Remove input image', onclick: () => { local.inputs = local.inputs.filter((a) => a.id !== asset.id); renderInputs(); renderModelOptions(); } }, '✕'))));
}

function addInput(asset) {
  if (local.inputs.some((a) => a.id === asset.id)) return;
  local.inputs.push(asset);
  renderInputs();
  renderModelOptions();
}

function showGeneration(generation) {
  local.shown = generation;
  const image = $('#result-image');
  const status = $('#preview-status');
  $('#empty-state').classList.toggle('hidden', Boolean(generation));
  if (!generation) {
    image.classList.add('hidden');
    status.classList.add('hidden');
    $('#preview-actions').classList.add('hidden');
    $('#preview-caption').textContent = '';
    return;
  }
  const done = generation.status === 'completed';
  image.classList.toggle('hidden', !done);
  if (done) image.src = generation.assetPath;
  status.classList.toggle('hidden', done);
  status.dataset.status = generation.status;
  status.replaceChildren(
    h('b', {}, statusLabels[generation.status] ?? generation.status),
    generation.userError ? h('span', {}, generation.userError) : h('span.muted', {}, `${generation.provider} · ${generation.model}`),
    ['failed', 'interrupted'].includes(generation.status) ? h('button.button.secondary.small', { onclick: () => retry(generation) }, 'Retry') : null);
  $('#preview-actions').classList.toggle('hidden', !done);
  const caption = generation.finalPrompt && generation.finalPrompt !== generation.prompt ? `${generation.prompt}  →  ${generation.finalPrompt}` : generation.prompt;
  $('#preview-caption').textContent = caption;
}

function renderHistory() {
  const generations = state.detail?.generations ?? [];
  $('#history-count').textContent = generations.length;
  const grid = $('#history-grid');
  if (!generations.length) return grid.replaceChildren(h('div.history-empty.muted', {}, 'Your generated images will appear here.'));
  grid.replaceChildren(...generations.slice(0, 12).map((g) => h(`button.history-card${local.shown?.id === g.id ? '.active' : ''}`, { onclick: () => { showGeneration(g); renderHistory(); } },
    h('div.history-thumb', { dataset: { status: g.status } }, g.status === 'completed' ? h('img', { src: g.assetPath, alt: '', loading: 'lazy' }) : h('span', {}, statusLabels[g.status])),
    h('b', {}, g.prompt), h('small', {}, `${g.model} · ${new Date(g.createdAt).toLocaleString()}`))));
}

function upsertGeneration(generation) {
  const list = state.detail.generations;
  const index = list.findIndex((g) => g.id === generation.id);
  if (index >= 0) list[index] = generation; else list.unshift(generation);
  if (local.shown?.id === generation.id) showGeneration(generation);
  renderHistory();
}

async function poll(id) {
  if (local.polling.has(id)) return;
  local.polling.add(id);
  try {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const { generation } = await api(`/api/generations/${id}`);
      if (generation.projectId !== state.project?.id) return;
      upsertGeneration(generation);
      if (!['queued', 'running'].includes(generation.status)) {
        if (generation.status === 'completed') {
          emit('assets-changed');
          if (generation.finalPrompt && generation.finalPrompt !== generation.prompt) toast('Creative director refined your prompt.');
        } else toast(generation.userError || 'Generation failed.', 'error');
        return;
      }
    }
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    local.polling.delete(id);
  }
}

async function generate() {
  const prompt = $('#prompt').value.trim();
  if (!prompt) { $('#prompt').focus(); return toast('Add an idea to get started.'); }
  const { provider, model } = selectedModel();
  if (!model) return toast('Add an API key in Settings first.', 'error');
  try {
    localStorage.setItem(`lumina-model-${local.inputs.length ? 'edit' : 'generate'}`, $('#model-select').value);
  } catch { /* ignore */ }
  const { generation } = await api('/api/generate', { method: 'POST', body: {
    projectId: state.project.id, prompt, provider: provider.id, model: model.id, size: $('#size-select').value,
    quality: model.qualities.length ? $('#quality-select').value : null, director: $('#director-select').value || null,
    inputAssetIds: local.inputs.map((a) => a.id), operation: local.operation,
  } });
  local.operation = 'generate';
  upsertGeneration(generation);
  showGeneration(generation);
  poll(generation.id);
}

async function retry(generation) {
  const { generation: next } = await api(`/api/generations/${generation.id}/retry`, { method: 'POST', body: {} });
  upsertGeneration(next);
  showGeneration(next);
  poll(next.id);
}

function outputAsset() {
  const g = local.shown;
  return g && { id: g.assetId, path: g.assetPath, kind: 'generation', label: g.prompt };
}

const guard = (fn) => async (...args) => {
  try { await fn(...args); } catch (error) { toast(error.message, 'error'); }
};

export function initCreate() {
  $('#prompt').addEventListener('input', () => { $('#char-count').textContent = `${$('#prompt').value.length} / 4000`; });
  $('#prompt').addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') guard(generate)(); });
  $('#model-select').addEventListener('change', renderModelDetails);
  $('#generate-btn').addEventListener('click', guard(generate));
  $('#pick-reference').addEventListener('click', guard(async () => { const asset = await pickAsset({ title: 'Choose an input image' }); if (asset) addInput(asset); }));
  $('#reference-file').addEventListener('change', guard(async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) addInput(await uploadReference(state.project.id, file));
    emit('assets-changed');
  }));
  $('#download-btn').addEventListener('click', () => local.shown && downloadAsset(local.shown.assetPath, `lumina-${local.shown.id}.${local.shown.assetPath.split('.').pop()}`));
  $('#use-input-btn').addEventListener('click', () => { addInput(outputAsset()); $('#prompt').value = ''; $('#prompt').focus(); toast('Describe the change you want, then Edit image.'); });
  $('#variation-btn').addEventListener('click', guard(async () => {
    local.inputs = [];
    addInput(outputAsset());
    $('#prompt').value = local.shown.prompt;
    local.operation = 'variation';
    await generate();
    local.inputs = [];
    renderInputs();
    renderModelOptions();
  }));
  $('#add-canvas-btn').addEventListener('click', () => emit('add-to-canvas', outputAsset()));

  on('catalog', () => { renderModelOptions(); renderDirectors(); });
  on('project', (detail) => {
    const switched = local.projectId !== detail.project.id;
    local.projectId = detail.project.id;
    if (switched) {
      local.inputs = [];
      renderInputs();
      renderModelOptions();
    }
    const shown = local.shown && detail.generations.find((g) => g.id === local.shown.id);
    showGeneration(switched || !shown ? detail.generations[0] ?? null : shown);
    renderHistory();
    detail.generations.filter((g) => ['queued', 'running'].includes(g.status)).forEach((g) => poll(g.id));
  });
  on('use-as-input', (asset) => { addInput(asset); emit('open-tab', 'create'); });
}
