import { $, api, downloadAsset, emit, h, modelsFor, on, state, toast } from './lib.js';

// Storyboard: an idea becomes a shot list; each shot gets a still frame, then a clip; clips join into one video.
const ui = { list: [], detail: null, options: null, presets: [], timer: null, busy: '' };
const jobActive = (job) => job && ['queued', 'running'].includes(job.status);
const statusText = { queued: 'Queued', running: 'Generating…', failed: 'Failed', interrupted: 'Interrupted' };

const guard = (fn) => async (...args) => {
  try { await fn(...args); } catch (error) { toast(error.message, 'error'); }
};

const call = (path, method = 'POST', body = {}) => api(path, { method, body: method === 'GET' ? undefined : body });

function show(detail) {
  ui.detail = detail;
  const option = [...$('#sb-select').options].find((o) => o.value === detail.sequence.id);
  if (option) option.textContent = `${detail.sequence.title} (${detail.shots.length} shots)`;
  render();
  watch();
}

// Poll while any frame or clip is still being made.
function watch() {
  clearTimeout(ui.timer);
  if (!ui.detail?.shots.some((s) => jobActive(s.frameJob) || jobActive(s.clipJob))) return;
  ui.timer = setTimeout(guard(async () => {
    if (!ui.detail || $('#storyboard-view').classList.contains('hidden')) return;
    const before = JSON.stringify(ui.detail.shots.map((s) => [s.frameJob?.status, s.clipJob?.status, s.imagePath, s.videoPath]));
    const next = await call(`/api/storyboards/${ui.detail.sequence.id}`, 'GET');
    const after = JSON.stringify(next.shots.map((s) => [s.frameJob?.status, s.clipJob?.status, s.imagePath, s.videoPath]));
    if (before === after) return watch();
    // Leaving a field saves it; do that before redrawing so typing is not lost.
    if ($('#sb-editor').contains(document.activeElement)) document.activeElement.blur();
    emit('assets-changed');
    return show({ ...next, shots: next.shots.map((s) => ({ ...s, description: ui.detail.shots.find((x) => x.id === s.id)?.description ?? s.description })) });
  }), 1500);
}

async function loadList(selectId) {
  if (!state.project) return;
  ui.list = (await call(`/api/projects/${state.project.id}/storyboards`, 'GET')).storyboards;
  const select = $('#sb-select');
  select.replaceChildren(...ui.list.map((s) => h('option', { value: s.id }, `${s.title} (${s.shotCount} shots)`)));
  select.classList.toggle('hidden', !ui.list.length);
  $('#sb-delete').classList.toggle('hidden', !ui.list.length);
  const id = [selectId, ui.detail?.sequence.id].find((x) => ui.list.some((s) => s.id === x)) ?? ui.list[0]?.id;
  if (!id) {
    ui.detail = null;
    return render();
  }
  select.value = id;
  return show(await call(`/api/storyboards/${id}`, 'GET'));
}

const saveSettings = guard(async (settings) => show(await call(`/api/storyboards/${ui.detail.sequence.id}`, 'PATCH', { settings })));
const saveFields = guard(async (fields) => {
  const detail = await call(`/api/storyboards/${ui.detail.sequence.id}`, 'PATCH', fields);
  ui.detail.sequence = detail.sequence;
  if (fields.title) {
    const option = [...$('#sb-select').options].find((o) => o.value === detail.sequence.id);
    if (option) option.textContent = `${detail.sequence.title} (${detail.shots.length} shots)`;
  }
});

function modelPicker(kind, operation, label) {
  const { settings } = ui.detail.sequence;
  const options = modelsFor(operation);
  const select = h('select', { 'aria-label': label, onchange: () => {
    const [provider, model] = select.value.split('|');
    saveSettings({ [`${kind}Provider`]: provider ?? '', [`${kind}Model`]: model ?? '' });
  } }, h('option', { value: '' }, 'Choose…'),
  ...options.map(({ provider, model, value }) => h('option', { value, disabled: !provider.ready }, `${provider.label} · ${model.label}${provider.ready ? '' : ' (add key)'}`)));
  select.value = options.some((o) => o.value === `${settings[`${kind}Provider`]}|${settings[`${kind}Model`]}`) ? `${settings[`${kind}Provider`]}|${settings[`${kind}Model`]}` : '';
  return h('label', {}, h('span.field-label', {}, label), select);
}

function settingsPanel() {
  const { sequence, shots } = ui.detail;
  const { settings } = sequence;
  const title = h('input', { type: 'text', value: sequence.title, maxLength: 80, 'aria-label': 'Title', onchange: () => title.value.trim() && saveFields({ title: title.value }) });
  const idea = h('textarea', { rows: 4, maxLength: 6000, value: sequence.idea, 'aria-label': 'Idea', placeholder: 'What happens? e.g. “A lighthouse keeper finds a message in a bottle at dawn and rows out to answer it.”', onchange: () => saveFields({ idea: idea.value }) });
  const writer = h('select', { 'aria-label': 'Writer', onchange: () => saveFields({ writer: writer.value }) }, h('option', { value: '' }, 'Choose…'),
    ...(state.catalog?.directors ?? []).flatMap((d) => d.models.map((m) => h('option', { value: `${d.id}:${m}`, disabled: !d.ready }, `${d.label} · ${m}${d.ready ? '' : ' (add key)'}`))));
  writer.value = sequence.writer ?? '';
  const count = h('input', { type: 'number', min: 1, max: 24, value: settings.shotCount, 'aria-label': 'Number of shots', onchange: () => saveSettings({ shotCount: Number(count.value) }) });
  const aspect = h('select', { 'aria-label': 'Frame', onchange: () => saveSettings({ aspect: aspect.value }) }, ...['16:9', '9:16', '1:1'].map((a) => h('option', { value: a }, a)));
  aspect.value = settings.aspect;
  const style = h('select', { 'aria-label': 'Style', onchange: () => saveSettings({ style: style.value }) }, h('option', { value: '' }, 'None'),
    ...ui.presets.filter((p) => p.group === 'style').map((p) => h('option', { value: p.id }, p.label)));
  style.value = settings.style;
  const chosen = new Set(settings.characterIds);
  const characters = h('div.applied-presets', {}, h('span.field-label', {}, 'CHARACTERS'),
    ...(state.characters ?? []).map((c) => h(`button.character-chip${chosen.has(c.id) ? '.selected' : ''}`, { 'aria-pressed': String(chosen.has(c.id)), onclick: () => {
      if (chosen.has(c.id)) chosen.delete(c.id); else chosen.add(c.id);
      saveSettings({ characterIds: [...chosen] });
    } }, c.references[0] ? h('img', { src: c.references[0].path, alt: '' }) : null, c.name)),
    h('button.text-button', { onclick: () => emit('open-tab', 'characters') }, (state.characters ?? []).length ? 'Manage →' : '＋ Add a character →'));

  const withFrames = shots.filter((s) => s.description.trim());
  const clips = shots.filter((s) => s.videoPath).length;
  const busy = (label, key) => (ui.busy === key ? 'Working…' : label);
  const actions = h('div.book-toolbar', {},
    h('button.button.primary.small', { disabled: Boolean(ui.busy), onclick: guard(async () => {
      if (idea.value !== sequence.idea) await saveFields({ idea: idea.value });
      if (shots.length && !confirm('Replace the current shots with a new plan? Frames and clips stay in the library.')) return;
      await work('plan', async () => show(await call(`/api/storyboards/${sequence.id}/plan`, 'POST', { replace: true })));
    }) }, busy(shots.length ? 'Re-plan shots' : 'Plan shots', 'plan')),
    h('button.button.secondary.small', { disabled: !withFrames.length, onclick: guard(async () => {
      for (const shot of withFrames) await call(`/api/shots/${shot.id}/frame`);
      show(await call(`/api/storyboards/${sequence.id}`, 'GET'));
    }) }, 'Make all frames'),
    h('button.button.secondary.small', { disabled: !withFrames.length, onclick: guard(async () => {
      if (!confirm(`Generate ${withFrames.length} video clip(s)? Video takes several minutes each and costs more than images.`)) return;
      for (const shot of withFrames) await call(`/api/shots/${shot.id}/animate`);
      show(await call(`/api/storyboards/${sequence.id}`, 'GET'));
    }) }, 'Animate all'),
    h('span.toolbar-sep'),
    h('button.button.secondary.small', {
      disabled: !clips || !ui.options?.ffmpeg || Boolean(ui.busy), title: ui.options?.ffmpeg ? '' : 'Needs ffmpeg installed on this computer (sudo apt install ffmpeg)',
      onclick: guard(async () => work('stitch', async () => {
        const result = await call(`/api/storyboards/${sequence.id}/stitch`);
        emit('assets-changed');
        toast(`Joined ${result.joined} clip(s)${result.skipped ? `; ${result.skipped} shot(s) without a clip were skipped` : ''}.`);
        show(result);
      })),
    }, busy(`Join ${clips} clip(s) into one video`, 'stitch')),
    ui.options?.ffmpeg ? null : h('span.muted', {}, 'Joining needs ffmpeg, which isn\'t installed.'));

  return h('section.panel.sb-settings', {},
    h('div.sb-grid', {},
      h('label.sb-wide', {}, h('span.field-label', {}, 'TITLE'), title),
      h('label.sb-wide', {}, h('span.field-label', {}, 'IDEA'), idea),
      h('label', {}, h('span.field-label', {}, 'WRITER (PLANS THE SHOTS)'), writer),
      h('label', {}, h('span.field-label', {}, 'SHOTS'), count),
      h('label', {}, h('span.field-label', {}, 'FRAME'), aspect),
      h('label', {}, h('span.field-label', {}, 'STYLE'), style),
      modelPicker('image', 'generate', 'IMAGE MODEL (FRAMES)'),
      modelPicker('video', 'video', 'VIDEO MODEL (CLIPS)')),
    characters, actions);
}

async function work(key, fn) {
  ui.busy = key;
  render();
  try {
    await fn();
  } finally {
    ui.busy = '';
    render();
  }
}

function jobBadge(job, label) {
  if (!job || job.status === 'completed') return null;
  return h('span.badge', { dataset: { tone: jobActive(job) ? 'busy' : 'error' }, title: job.error ?? '' }, `${label}: ${statusText[job.status] ?? job.status}`);
}

function shotCard(shot, index, total) {
  const id = ui.detail.sequence.id;
  const act = (path, method, body) => guard(async () => show(await call(path, method, body)));
  const description = h('textarea', { rows: 3, maxLength: 2000, value: shot.description, 'aria-label': `Shot ${shot.position} description`, placeholder: 'What we see and what happens in this shot.',
    oninput: () => { shot.description = description.value; },
    onchange: guard(async () => { await call(`/api/shots/${shot.id}`, 'PATCH', { description: description.value }); }) });
  const camera = h('select', { 'aria-label': 'Camera move' }, h('option', { value: '' }, 'No camera move'),
    ...ui.presets.filter((p) => p.group === 'camera').map((p) => h('option', { value: p.id }, p.label)));
  camera.value = shot.camera ?? '';
  camera.onchange = guard(async () => show(await call(`/api/shots/${shot.id}`, 'PATCH', { camera: camera.value || null })));
  const duration = h('select', { 'aria-label': 'Length' }, ...[4, 5, 6, 8, 10].map((d) => h('option', { value: d }, `${d} s`)));
  duration.value = String([4, 5, 6, 8, 10].includes(shot.duration) ? shot.duration : 5);
  duration.onchange = guard(async () => show(await call(`/api/shots/${shot.id}`, 'PATCH', { duration: Number(duration.value) })));
  const start = (kind) => guard(async () => {
    if (description.value !== shot.description || document.activeElement === description) await call(`/api/shots/${shot.id}`, 'PATCH', { description: description.value });
    await call(`/api/shots/${shot.id}/${kind}`);
    show(await call(`/api/storyboards/${id}`, 'GET'));
  });
  const media = shot.videoPath ? h('video', { src: shot.videoPath, controls: true, loop: true, preload: 'metadata', poster: shot.imagePath ?? '' })
    : shot.imagePath ? h('img', { src: shot.imagePath, alt: `Frame for shot ${shot.position}`, loading: 'lazy' })
      : h('div.sb-placeholder.muted', {}, 'No frame yet');
  return h('article.panel.sb-shot', {},
    h('div.sb-media', { dataset: { aspect: ui.detail.sequence.settings.aspect } }, media, h('span.sb-number', {}, String(shot.position))),
    h('div.sb-shot-fields', {},
      description,
      h('div.key-row', {}, camera, duration),
      h('div.key-row.sb-shot-actions', {},
        h('button.button.secondary.small', { disabled: jobActive(shot.frameJob), onclick: start('frame') }, shot.imagePath ? 'Redo frame' : 'Make frame'),
        h('button.button.secondary.small', { disabled: jobActive(shot.clipJob), onclick: start('animate') }, shot.videoPath ? 'Redo clip' : 'Animate'),
        jobBadge(shot.frameJob, 'Frame'), jobBadge(shot.clipJob, 'Clip'),
        h('span.sb-spacer'),
        h('button.ghost', { disabled: index === 0, title: 'Move earlier', 'aria-label': 'Move earlier', onclick: act(`/api/shots/${shot.id}/move`, 'POST', { direction: 'up' }) }, '↑'),
        h('button.ghost', { disabled: index === total - 1, title: 'Move later', 'aria-label': 'Move later', onclick: act(`/api/shots/${shot.id}/move`, 'POST', { direction: 'down' }) }, '↓'),
        h('button.ghost', { title: 'Delete shot', 'aria-label': 'Delete shot', onclick: guard(async () => {
          if (confirm(`Delete shot ${shot.position}?`)) show(await call(`/api/shots/${shot.id}`, 'DELETE'));
        }) }, '✕'))));
}

function render() {
  const editor = $('#sb-editor');
  if (!ui.detail) {
    return editor.replaceChildren(h('div.history-empty.muted', {}, 'Turn an idea into a short film: Lumina plans the shots, makes a frame for each, animates them, and joins the clips into one video.'));
  }
  const { sequence, shots } = ui.detail;
  return editor.replaceChildren(...[
    settingsPanel(),
    sequence.outputPath ? h('section.panel.sb-output', {},
      h('div.panel-topline', {}, h('span.section-title', {}, 'Joined video'),
        h('button.button.secondary.small', { onclick: () => downloadAsset(sequence.outputPath, `${sequence.title}.mp4`) }, 'Download')),
      h('video', { src: sequence.outputPath, controls: true, preload: 'metadata' }),
      h('p.muted.small-note', {}, 'Re-join after changing clips to update this video.')) : null,
    h('div.sb-shots', {}, ...shots.map((shot, index) => shotCard(shot, index, shots.length))),
    h('button.button.secondary.small', { disabled: shots.length >= 24, onclick: guard(async () => show(await call(`/api/storyboards/${sequence.id}/shots`, 'POST', { description: '' }))) }, '+ Add a shot'),
  ].filter(Boolean));
}

export function initStoryboard() {
  $('#sb-select').addEventListener('change', guard(async () => show(await call(`/api/storyboards/${$('#sb-select').value}`, 'GET'))));
  $('#sb-new').addEventListener('click', guard(async () => {
    const title = prompt('Name this storyboard', 'Untitled storyboard');
    if (title === null) return;
    const image = modelsFor('generate').find((o) => o.provider.ready);
    const video = modelsFor('video').find((o) => o.provider.ready);
    const writer = (state.catalog?.directors ?? []).find((d) => d.ready);
    const detail = await call(`/api/projects/${state.project.id}/storyboards`, 'POST', {
      title, writer: writer ? `${writer.id}:${writer.models[0]}` : null,
      settings: { imageProvider: image?.provider.id, imageModel: image?.model.id, videoProvider: video?.provider.id, videoModel: video?.model.id },
    });
    await loadList(detail.sequence.id);
  }));
  $('#sb-delete').addEventListener('click', guard(async () => {
    if (!ui.detail || !confirm(`Delete the storyboard "${ui.detail.sequence.title}"? Its frames and clips stay in the library.`)) return;
    await call(`/api/storyboards/${ui.detail.sequence.id}`, 'DELETE');
    ui.detail = null;
    await loadList();
  }));
  on('tab', guard(async (tab) => {
    if (tab !== 'storyboard') return clearTimeout(ui.timer);
    ui.options ??= await call('/api/storyboard-options', 'GET');
    if (!ui.presets.length) ui.presets = (await call('/api/presets', 'GET')).presets;
    return loadList();
  }));
  on('project', guard(async (detail) => {
    if (ui.detail && ui.detail.sequence.projectId !== detail.project.id) ui.detail = null;
    if (!$('#storyboard-view').classList.contains('hidden') && !ui.detail) await loadList();
  }));
  on('characters', () => { if (ui.detail && !$('#storyboard-view').classList.contains('hidden') && !$('#sb-editor').contains(document.activeElement)) render(); });
  on('catalog', () => { if (ui.detail && !$('#storyboard-view').classList.contains('hidden')) render(); });
}
