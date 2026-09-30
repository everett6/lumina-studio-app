import { $, api, downloadAsset, emit, h, modelsFor, on, pickAsset, state, toast, uploadReference } from './lib.js';
import { applyPresets, initPresets, presetModeChanged, selectedPresets } from './presets.js';

const local = { inputs: [], shown: null, polling: new Set(), operation: 'generate', mode: 'image' };
const modeCopy = {
  image: { label: 'WHAT DO YOU WANT TO CREATE?', placeholder: 'A sun-drenched coastal villa at golden hour, linen curtains drifting in the breeze…', button: 'Generate image' },
  video: { label: 'DESCRIBE THE SHOT', placeholder: 'Slow dolly shot through a misty pine forest at dawn, birdsong, light rays…', button: 'Generate video' },
  speech: { label: 'TEXT TO READ ALOUD', placeholder: 'Paste the words to narrate. Long text is split and joined automatically.', button: 'Generate voice' },
};
const statusLabels = { queued: 'Queued', running: 'Generating…', failed: 'Failed', interrupted: 'Interrupted', completed: 'Done' };

function selectedModel() {
  const [providerId, modelId] = $('#model-select').value.split('|');
  const provider = state.catalog?.providers.find((p) => p.id === providerId);
  return { provider, model: provider?.models.find((m) => m.id === modelId) };
}

// The model list follows what the current inputs need: generation models without inputs, edit models with them.
function renderModelOptions() {
  if (!state.catalog) return;
  const operation = local.mode === 'image' ? (local.inputs.length ? 'edit' : 'generate') : local.mode;
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

function fillSelect(select, values, label = (v) => v) {
  const current = select.value;
  select.replaceChildren(...values.map((v) => h('option', { value: v }, label(v))));
  if (values.map(String).includes(current)) select.value = current;
}

function renderModelDetails() {
  const { model } = selectedModel();
  const mode = local.mode;
  $('#quality-field').classList.toggle('hidden', mode !== 'image' || !model?.qualities.length);
  if (mode === 'image' && model?.qualities.length) {
    const current = $('#quality-select').value;
    $('#quality-select').replaceChildren(...model.qualities.map((q) => h('option', { value: q }, q[0].toUpperCase() + q.slice(1))));
    $('#quality-select').value = model.qualities.includes(current) ? current : model.qualities[Math.min(1, model.qualities.length - 1)];
  }
  $('#size-field').classList.toggle('hidden', mode !== 'image');
  $('#duration-field').classList.toggle('hidden', mode !== 'video');
  $('#aspect-field').classList.toggle('hidden', mode !== 'video' || !model?.aspects?.length);
  $('#voice-field').classList.toggle('hidden', mode !== 'speech');
  $('#style-field').classList.toggle('hidden', mode !== 'speech');
  $('#director-field').classList.toggle('hidden', mode === 'speech');
  $('#reference-row').classList.toggle('hidden', mode === 'speech' || (mode === 'video' && !model?.maxReferences));
  if (mode === 'video') {
    fillSelect($('#duration-select'), model?.durations ?? [], (d) => `${d} seconds`);
    fillSelect($('#aspect-select'), model?.aspects ?? []);
  }
  if (mode === 'speech') fillSelect($('#voice-select'), model?.voices ?? []);
  const copy = modeCopy[mode];
  $('#prompt-label').textContent = copy.label;
  $('#prompt').placeholder = copy.placeholder;
  $('#prompt').maxLength = mode === 'speech' ? 200000 : 4000;
  $('#char-count').textContent = `${$('#prompt').value.length} / ${mode === 'speech' ? '200000' : '4000'}`;
  $('#model-note').textContent = model ? `${model.note}${model.requiresImage ? ' — needs a start image' : ''}` : 'Add an API key in Settings for a provider that offers this.';
  $('#reference-hint').textContent = mode === 'video'
    ? `${local.inputs.length}/${model?.maxReferences ?? 0} start image — animate it, or leave empty for text to video`
    : model?.maxReferences ? `${local.inputs.length}/${model.maxReferences} input image(s) — the prompt describes the edit` : 'Add images to edit or guide the result';
  $('#generate-btn').disabled = !model;
  $('#generate-btn').textContent = mode === 'image' && local.inputs.length ? 'Edit image' : copy.button;
}

function setMode(mode) {
  local.mode = mode;
  document.querySelectorAll('#mode-select button').forEach((b) => b.classList.toggle('selected', b.dataset.mode === mode));
  if (mode === 'speech') {
    local.inputs = [];
    renderInputs();
  }
  if (mode === 'video' && local.inputs.length > 1) {
    local.inputs = local.inputs.slice(0, 1);
    renderInputs();
  }
  presetModeChanged(mode);
  renderModelOptions();
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
  if (local.mode === 'video') local.inputs = [];
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
  const mime = generation.mimeType ?? (generation.operation === 'speech' ? 'audio/' : generation.operation === 'video' ? 'video/' : 'image/');
  const isImage = mime.startsWith('image/');
  const media = $('#result-media');
  image.classList.toggle('hidden', !done || !isImage);
  media.classList.toggle('hidden', !done || isImage);
  if (done && isImage) image.src = generation.assetPath;
  if (done && !isImage && media.dataset.src !== generation.assetPath) {
    media.dataset.src = generation.assetPath;
    media.replaceChildren(mime.startsWith('video/')
      ? h('video.result-media', { src: generation.assetPath, controls: true, loop: true })
      : h('audio.result-media', { src: generation.assetPath, controls: true }));
  }
  status.classList.toggle('hidden', done);
  status.dataset.status = generation.status;
  status.replaceChildren(...[
    h('b', {}, statusLabels[generation.status] ?? generation.status),
    generation.userError ? h('span', {}, generation.userError) : h('span.muted', {}, `${generation.provider} · ${generation.model}`),
    ['failed', 'interrupted'].includes(generation.status) ? h('button.button.secondary.small', { onclick: () => retry(generation) }, 'Retry') : null,
  ].filter(Boolean));
  $('#preview-actions').classList.toggle('hidden', !done);
  for (const id of ['#use-input-btn', '#variation-btn', '#add-canvas-btn', '#animate-btn']) $(id).classList.toggle('hidden', !isImage);
  const caption = generation.finalPrompt && generation.finalPrompt !== generation.prompt ? `${generation.prompt}  →  ${generation.finalPrompt}` : generation.prompt;
  $('#preview-caption').textContent = caption;
}

function renderHistory() {
  const generations = state.detail?.generations ?? [];
  $('#history-count').textContent = generations.length;
  const grid = $('#history-grid');
  if (!generations.length) return grid.replaceChildren(h('div.history-empty.muted', {}, 'Your generated images will appear here.'));
  grid.replaceChildren(...generations.slice(0, 12).map((g) => h(`button.history-card${local.shown?.id === g.id ? '.active' : ''}`, { onclick: () => { showGeneration(g); renderHistory(); } },
    h('div.history-thumb', { dataset: { status: g.status } }, g.status !== 'completed' ? h('span', {}, statusLabels[g.status])
      : g.operation === 'speech' ? h('span', {}, '♪ Voice') : g.operation === 'video' ? h('span', {}, '▶ Video') : h('img', { src: g.assetPath, alt: '', loading: 'lazy' })),
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
          if (generation.director && generation.finalPrompt && generation.finalPrompt !== generation.prompt) toast('Creative director refined your prompt.');
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
  const mode = local.mode;
  try {
    localStorage.setItem(`lumina-model-${mode === 'image' ? (local.inputs.length ? 'edit' : 'generate') : mode}`, $('#model-select').value);
  } catch { /* ignore */ }
  if (mode === 'video' && !confirm('Generate a video clip? Video takes several minutes and costs more than an image.')) return;
  const { generation } = await api('/api/generate', { method: 'POST', body: {
    projectId: state.project.id, prompt, provider: provider.id, model: model.id, size: $('#size-select').value,
    quality: model.qualities.length ? $('#quality-select').value : null, director: mode === 'speech' ? null : $('#director-select').value || null,
    inputAssetIds: mode === 'speech' ? [] : local.inputs.map((a) => a.id), operation: mode === 'image' ? local.operation : mode,
    presets: mode === 'speech' ? [] : selectedPresets(),
    duration: $('#duration-select').value, aspect: $('#aspect-select').value, voice: $('#voice-select').value, style: $('#style-input').value,
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
  $('#prompt').addEventListener('input', () => { $('#char-count').textContent = `${$('#prompt').value.length} / ${local.mode === 'speech' ? '200000' : '4000'}`; });
  document.querySelectorAll('#mode-select button').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
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
  $('#animate-btn').addEventListener('click', () => {
    const asset = outputAsset();
    setMode('video');
    addInput(asset);
    $('#prompt').value = '';
    $('#prompt').focus();
    toast('Describe the motion, and pick a camera move below.');
  });
  $('#remix-btn').addEventListener('click', () => {
    const g = local.shown;
    setMode(g.operation === 'speech' || g.operation === 'video' ? g.operation : 'image');
    $('#prompt').value = g.prompt;
    $('#prompt').dispatchEvent(new Event('input'));
    applyPresets(g.params?.presets);
    $('#prompt').focus();
  });
  initPresets();

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
  on('use-as-input', (asset) => {
    if (!asset.mimeType?.startsWith('image/') && asset.mimeType) return toast('Only images can be used as inputs.');
    if (local.mode === 'speech') setMode('image');
    addInput(asset);
    emit('open-tab', 'create');
    return undefined;
  });
}
