import { $, api, describeTotal, downloadAsset, emit, estimateCost, h, modelsFor, on, state, sumCosts, toast, askText } from './lib.js';

// Storyboard: an idea becomes a shot list; each shot gets a still frame, then a clip; clips join into one video.
const ui = { list: [], detail: null, options: null, presets: [], timer: null, busy: '' };
const jobActive = (job) => job && ['queued', 'running'].includes(job.status);
const statusText = { queued: 'Queued', running: 'Generating…', failed: 'Failed', interrupted: 'Interrupted' };
const defaultLengths = [4, 5, 6, 8, 10];
const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;

// The chosen video model, and the clip length it will actually make for a shot (the nearest one it supports).
function videoChoice() {
  const settings = ui.detail?.sequence.settings ?? {};
  return modelsFor('video').find((o) => o.provider.id === settings.videoProvider && o.model.id === settings.videoModel) ?? null;
}
function clipLength(duration) {
  const lengths = videoChoice()?.model.durations;
  if (!lengths?.length) return duration;
  return lengths.reduce((best, d) => (Math.abs(d - duration) < Math.abs(best - duration) || (Math.abs(d - duration) === Math.abs(best - duration) && d > best) ? d : best));
}

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
  const seq = ui.detail?.sequence;
  const joiningNow = seq?.join?.state === 'running' || seq?.production?.state === 'running' || seq?.enhance?.state === 'running';
  if (!joiningNow && !ui.detail?.shots.some((s) => jobActive(s.frameJob) || jobActive(s.clipJob))) return;
  ui.timer = setTimeout(guard(async () => {
    if (!ui.detail || $('#storyboard-view').classList.contains('hidden')) return;
    const snapshot = (d) => JSON.stringify([d.sequence.join, d.sequence.production, d.sequence.enhance, d.sequence.outputPath, d.shots.map((s) => [s.frameJob?.status, s.clipJob?.status, s.imagePath, s.videoPath])]);
    const before = snapshot(ui.detail);
    const next = await call(`/api/storyboards/${ui.detail.sequence.id}`, 'GET');
    const after = snapshot(next);
    const join = next.sequence.join;
    if (ui.detail.sequence.join?.state === 'running' && join?.state === 'completed') toast(`Joined ${join.clips} clip(s) into a ${clock(join.duration ?? 0)} video${join.skipped ? `; ${join.skipped} shot(s) without a clip were skipped` : ''}.`);
    if (ui.detail.sequence.join?.state === 'running' && join?.state === 'failed') toast(join.error, 'error');
    const [was, now] = [ui.detail.sequence.production, next.sequence.production];
    if (was?.state === 'running' && now?.state === 'completed') toast('Your film is ready.');
    if (was?.state === 'running' && now?.state === 'paused' && now.error) toast(now.error, 'error');
    const [enhBefore, enhAfter] = [ui.detail.sequence.enhance, next.sequence.enhance];
    if (enhBefore?.state === 'running' && enhAfter?.state === 'completed') toast(`Enhanced to ${enhAfter.width}×${enhAfter.height}. It is in the library.`);
    if (enhBefore?.state === 'running' && enhAfter?.state === 'failed') toast(enhAfter.error, 'error');
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
  const maxShots = ui.options?.maxShots ?? 60;
  const count = h('input', { type: 'number', min: 1, max: maxShots, value: settings.shotCount, 'aria-label': 'Number of shots', onchange: () => saveSettings({ shotCount: Number(count.value) }) });
  // Target length in minutes; picking one also suggests a shot count that fits the video model's longest clip.
  const target = h('input', { type: 'number', min: 0, max: (ui.options?.maxTargetSeconds ?? 900) / 60, step: 0.5, value: settings.targetSeconds ? settings.targetSeconds / 60 : '', placeholder: 'Any',
    'aria-label': 'Target length in minutes', onchange: () => {
      const seconds = Math.round(Number(target.value || 0) * 60);
      const longest = Math.max(...(videoChoice()?.model.durations ?? [8]));
      const typical = Math.min(longest, 8);
      const change = { targetSeconds: seconds };
      if (seconds) change.shotCount = Math.min(maxShots, Math.max(settings.shotCount, Math.ceil(seconds / typical)));
      saveSettings(change);
    } });
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
  // List-price estimates for the two bulk actions.
  const sizes = { '16:9': '1536x1024', '9:16': '1024x1536', '1:1': '1024x1024' };
  const pick = (kind, operation) => modelsFor(operation).find((o) => o.provider.id === settings[`${kind}Provider`] && o.model.id === settings[`${kind}Model`]);
  const imageChoice = pick('image', 'generate');
  const clipModel = pick('video', 'video');
  const total = (choice, jobs) => (choice && !choice.provider.keyless ? describeTotal(sumCosts(jobs.map((job) => estimateCost(choice.model, job)))) : '');
  const frameCost = total(imageChoice, withFrames.map(() => ({ size: sizes[settings.aspect] })));
  const clipCost = total(clipModel, withFrames.map((s) => ({ duration: clipLength(s.duration) })));
  const runtime = withFrames.reduce((sum, s) => sum + clipLength(s.duration), 0);
  const costLine = [frameCost && `all frames ${frameCost}`, clipCost && `all clips ${clipCost}`].filter(Boolean).join(' · ');
  const clips = shots.filter((s) => s.videoPath).length;
  const join = sequence.join;
  const joiningNow = join?.state === 'running';
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
      if (!confirm(`Generate ${withFrames.length} video clip(s)? Video takes several minutes each and costs more than images.${clipCost ? `\n\nAt list prices: ${clipCost}.` : ''}`)) return;
      for (const shot of withFrames) await call(`/api/shots/${shot.id}/animate`);
      show(await call(`/api/storyboards/${sequence.id}`, 'GET'));
    }) }, 'Animate all'),
    h('span.toolbar-sep'),
    sequence.production?.state === 'running'
      ? h('button.button.secondary.small', { onclick: guard(async () => show(await call(`/api/storyboards/${sequence.id}/stop`))) }, 'Stop production')
      : h('button.button.primary.small', {
        disabled: !withFrames.length || !ui.options?.ffmpeg || joiningNow, title: 'Make every missing frame and clip, then join them into the finished film',
        onclick: guard(async () => {
          const missing = withFrames.filter((s) => !s.videoPath).length;
          if (missing && !confirm(`Produce the film? Lumina will make ${missing} clip(s) (${clock(runtime)} in total)${settings.continuity === 'chain' ? ', one after another so each continues from the last' : ''}, then join them. Video takes minutes per clip.${clipCost ? `\n\nAt list prices: ${clipCost} for all clips.` : ''}`)) return;
          show(await call(`/api/storyboards/${sequence.id}/produce`));
        }),
      }, '🎬 Produce film'),
    h('button.button.secondary.small', {
      disabled: !clips || !ui.options?.ffmpeg || Boolean(ui.busy) || joiningNow, title: ui.options?.ffmpeg ? '' : 'Needs ffmpeg installed on this computer (sudo apt install ffmpeg)',
      onclick: guard(async () => show(await call(`/api/storyboards/${sequence.id}/stitch`))),
    }, joiningNow ? `Joining… step ${join.done}/${join.total}` : `Join ${clips} clip(s) into one video`),
    ui.options?.ffmpeg ? null : h('span.muted', {}, 'Joining needs ffmpeg, which isn\'t installed.'));

  return h('section.panel.sb-settings', {},
    h('div.sb-grid', {},
      h('label.sb-wide', {}, h('span.field-label', {}, 'TITLE'), title),
      h('label.sb-wide', {}, h('span.field-label', {}, 'IDEA'), idea),
      h('label', {}, h('span.field-label', {}, 'WRITER (PLANS THE SHOTS)'), writer),
      h('label', {}, h('span.field-label', {}, 'TARGET LENGTH (MINUTES)'), target),
      h('label', {}, h('span.field-label', {}, 'SHOTS'), count),
      h('label', {}, h('span.field-label', {}, 'FRAME'), aspect),
      h('label', {}, h('span.field-label', {}, 'STYLE'), style),
      modelPicker('image', 'generate', 'IMAGE MODEL (FRAMES)'),
      modelPicker('video', 'video', 'VIDEO MODEL (CLIPS)'),
      ...filmFields(settings)),
    characters, actions, productionLine(sequence),
    h('p.muted', {}, [
      withFrames.length ? `Running time: ${clock(runtime)} across ${withFrames.length} shot(s)${settings.targetSeconds ? ` (target ${clock(settings.targetSeconds)})` : ''}.` : '',
      costLine ? `At list prices (${state.catalog?.pricesAsOf ?? 'recent'}): ${costLine}.` : '',
    ].filter(Boolean).join(' ')),
    join?.state === 'failed' ? h('p.error-text', {}, join.error) : null);
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
  const offered = videoChoice()?.model.durations?.length ? videoChoice().model.durations : defaultLengths;
  const lengths = offered.includes(clipLength(shot.duration)) ? offered : [...offered, shot.duration].sort((x, y) => x - y);
  const duration = h('select', { 'aria-label': 'Length' }, ...lengths.map((d) => h('option', { value: d }, `${d} s`)));
  duration.value = String(clipLength(shot.duration));
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

// Film settings: how shots connect, clip length, look, and how the clips are joined.
function filmFields(settings) {
  const select = (label, key, options, value, cast = String) => {
    const node = h('select', { 'aria-label': label, onchange: () => saveSettings({ [key]: cast(node.value) }) },
      ...options.map(([v, text]) => h('option', { value: v }, text)));
    node.value = String(value);
    return h('label', {}, h('span.field-label', {}, label.toUpperCase()), node);
  };
  const lengths = videoChoice()?.model.durations?.length ? videoChoice().model.durations : defaultLengths;
  return [
    select('Continuity', 'continuity', [['frames', 'Separate shots (own frame each)'], ['chain', 'Continuous (each clip starts where the last ended)']], settings.continuity),
    select('Clip length', 'clipLength', [['0', 'Writer decides'], ...lengths.map((d) => [String(d), `${d} s every shot`])], settings.clipLength ?? 0, Number),
    select('Look', 'realistic', [['true', 'Realistic live action'], ['false', 'As written (any style)']], settings.realistic !== false, (v) => v === 'true'),
    select('Transitions', 'transition', [['cut', 'Hard cuts'], ['crossfade', 'Crossfades (0.5 s)']], settings.transition ?? 'cut'),
    select('Finish', 'finish', [['none', 'None'], ['cinematic', 'Cinematic (2.39:1 bars, grain, fades)']], settings.finish ?? 'none'),
  ];
}

function productionLine(sequence) {
  const production = sequence.production;
  if (!production) return null;
  if (production.state === 'running') return h('p.badge', { dataset: { tone: 'busy' } }, `In production: ${production.step}…`);
  if (production.state === 'paused') return h('p.error-text', {}, `Production paused: ${production.error ?? production.step}`);
  return h('p.muted', {}, `Production finished. ${production.step ?? ''}`);
}

function enhanceRow(sequence) {
  const status = sequence.enhance;
  const outputId = sequence.outputAssetId;
  const start = (mode, download = false) => guard(async () => {
    try {
      await call(`/api/assets/${outputId}/enhance`, 'POST', { mode, download });
    } catch (error) {
      if (error.data?.needsDownload && !download) {
        if (confirm('AI upscaling uses Real-ESRGAN, which runs on your NVIDIA GPU. It is not installed yet.\n\nDownload it now from the official GitHub release (about 47 MB) into Lumina\'s data folder?')) return start(mode, true)();
        return undefined;
      }
      throw error;
    }
    return show(await call(`/api/storyboards/${sequence.id}`, 'GET'));
  });
  const running = status?.state === 'running';
  return h('div.key-row.sb-enhance', {},
    h('span.field-label', {}, 'ENHANCE'),
    h('button.button.secondary.small', { disabled: running, title: 'GPU upscaling (libplacebo, EWA Lanczos) to twice the size, up to 4K. Takes seconds to minutes.', onclick: start('fast') }, 'Sharpen + 2× (fast, GPU)'),
    h('button.button.secondary.small', { disabled: running, title: 'Real-ESRGAN AI super-resolution on your NVIDIA GPU: adds real detail, but takes about a second or more per frame.', onclick: start('ai') }, 'AI upscale 2× (Real-ESRGAN, slow)'),
    running ? h('span.badge', { dataset: { tone: 'busy' } }, `Enhancing (${status.mode === 'ai' ? 'AI' : 'fast'})… ${status.done}/${status.total}`) : null,
    status?.state === 'failed' ? h('span.error-text', {}, status.error) : null,
    status?.state === 'completed' ? h('span.muted', {}, `Enhanced copy (${status.width}×${status.height}) saved to the library.`) : null);
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
      enhanceRow(sequence),
      h('p.muted.small-note', {}, 'Re-join after changing clips to update this video.')) : null,
    h('div.sb-shots', {}, ...shots.map((shot, index) => shotCard(shot, index, shots.length))),
    h('button.button.secondary.small', { disabled: shots.length >= (ui.options?.maxShots ?? 60), onclick: guard(async () => show(await call(`/api/storyboards/${sequence.id}/shots`, 'POST', { description: '' }))) }, '+ Add a shot'),
  ].filter(Boolean));
}

export function initStoryboard() {
  $('#sb-select').addEventListener('change', guard(async () => show(await call(`/api/storyboards/${$('#sb-select').value}`, 'GET'))));
  $('#sb-new').addEventListener('click', guard(async () => {
    const title = await askText('New storyboard', { label: 'Title', value: 'Untitled storyboard', okLabel: 'Create' });
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
