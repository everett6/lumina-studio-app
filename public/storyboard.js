import { $, api, describeTotal, downloadAsset, emit, estimateCost, h, modelsFor, on, state, sumCosts, toast, askText } from './lib.js';

// Storyboard: an idea becomes a shot list; each shot gets a still frame, then a clip; clips join into one video.
const ui = { list: [], detail: null, options: null, presets: [], timer: null, busy: '', estimate: null, pollUntil: 0, faces: null, tools: null, mouthFor: null };
const jobActive = (job) => job && ['queued', 'running'].includes(job.status);
const statusText = { queued: 'Queued', running: 'Generating…', failed: 'Failed', interrupted: 'Interrupted' };
const defaultLengths = [4, 5, 6, 8, 10];
const reviewLabels = {
  pending: 'Not checked yet', needs_review: 'Needs your review', accepted: 'Accepted', needs_repair: 'Needs repair', needs_regeneration: 'Redo', rejected: 'Rejected',
};
const reviewTone = { accepted: 'ok', needs_review: 'busy', pending: 'busy', needs_repair: 'error', needs_regeneration: 'error', rejected: 'error' };
const people = () => (state.characters ?? []).filter((c) => c.kind !== 'location');
const places = () => (state.characters ?? []).filter((c) => c.kind === 'location');
const voiceOptions = () => modelsFor('speech').flatMap(({ provider, model }) => (model.voices?.length ? model.voices : [null])
  .map((voice) => ({ value: JSON.stringify({ provider: provider.id, model: model.id, voice }), label: `${provider.label} · ${model.label}${voice ? ` · ${voice}` : ''}`, ready: provider.ready })));
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
  // What finishing the film would still cost (still shots are free), worked out by the app.
  api(`/api/storyboards/${detail.sequence.id}/estimate`).then((estimate) => {
    if (ui.detail?.sequence.id !== detail.sequence.id) return;
    const changed = JSON.stringify(estimate) !== JSON.stringify(ui.estimate);
    ui.estimate = estimate;
    if (changed && !$('#sb-editor').contains(document.activeElement)) render();
  }).catch(() => {});
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
  if (!joiningNow && Date.now() > ui.pollUntil && !ui.detail?.shots.some((s) => jobActive(s.frameJob) || jobActive(s.clipJob))) return;
  ui.timer = setTimeout(guard(async () => {
    if (!ui.detail || $('#storyboard-view').classList.contains('hidden')) return;
    const snapshot = (d) => JSON.stringify([d.sequence.join, d.sequence.production, d.sequence.enhance, d.sequence.outputPath, d.shots.map((s) => [s.frameJob?.status, s.clipJob?.status, s.frameJob?.progress?.done, s.clipJob?.progress?.done, s.imagePath, s.videoPath, s.review?.status, s.review?.checkedAt, s.details?.dialogue?.map((l) => l.assetId)])]);
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
  ...options.map(({ provider, model, value }) => h('option', { value, disabled: !provider.ready }, `${provider.label} · ${model.label}${provider.ready ? '' : provider.keyless ? ' (not installed)' : ' (add key)'}`)));
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
          const left = ui.estimate?.totalUsd ? `\n\nStill to spend at list prices: about $${ui.estimate.totalUsd.toFixed(2)}${ui.estimate.unpriced ? ` plus ${ui.estimate.unpriced} job(s) without a listed price` : ''}${ui.estimate.fits === false ? ' — MORE THAN YOUR REMAINING BUDGET' : ''}.` : (clipCost ? `\n\nAt list prices: ${clipCost} for all clips.` : '');
          if (missing && !confirm(`Produce the film? Lumina will make ${missing} clip(s) (${clock(runtime)} in total)${settings.continuity === 'chain' ? ', one after another so each continues from the last' : ''}, then join them.${settings.requireApproval ? ' It will stop for you to approve the frames, then the clips.' : ''} Video takes minutes per clip.${left}`)) return;
          show(await call(`/api/storyboards/${sequence.id}/produce`));
        }),
      }, '🎬 Produce film'),
    h('button.button.secondary.small', {
      disabled: !clips || !ui.options?.ffmpeg || Boolean(ui.busy) || joiningNow, title: ui.options?.ffmpeg ? '' : 'Needs ffmpeg installed on this computer (sudo apt install ffmpeg)',
      onclick: guard(async () => show(await call(`/api/storyboards/${sequence.id}/stitch`))),
    }, joiningNow ? `Joining… step ${join.done}/${join.total}` : `Join ${clips} clip(s) into one video`),
    ui.options?.ffmpeg ? null : h('span.muted', {}, 'Joining needs ffmpeg, which isn\'t installed.'));

  const story = h('section.panel.sb-settings', {},
    h('div.sb-section-head', {}, h('h2', {}, 'Story'), h('span.muted', {}, 'What happens, who writes the shots, and how long it runs.')),
    h('div.sb-grid', {},
      h('label.sb-wide', {}, h('span.field-label', {}, 'TITLE'), title),
      h('label.sb-wide', {}, h('span.field-label', {}, 'IDEA'), idea),
      h('label', {}, h('span.field-label', {}, 'WRITER (PLANS THE SHOTS)'), writer),
      h('label', {}, h('span.field-label', {}, 'TARGET LENGTH (MINUTES)'), target),
      h('label', {}, h('span.field-label', {}, 'SHOTS'), count),
      h('label', {}, h('span.field-label', {}, 'FRAME'), aspect)),
    characters,
    h('div.sb-section-head', {}, h('h2', {}, 'Models and look'), h('span.muted', {}, 'Which models make the frames and clips, and how the shots fit together.')),
    h('div.sb-grid', {},
      modelPicker('image', 'generate', 'IMAGE MODEL (FRAMES)'),
      modelPicker('video', 'video', 'VIDEO MODEL (CLIPS)'),
      h('label', {}, h('span.field-label', {}, 'STYLE'), style),
      ...filmFields(settings)),
    filmPanels(sequence));
  const controls = h('div.sb-actions', {}, actions, productionLine(sequence),
    h('p.muted.sb-runtime', {}, [
      withFrames.length ? `Running time: ${clock(runtime)} across ${withFrames.length} shot(s)${settings.targetSeconds ? ` (target ${clock(settings.targetSeconds)})` : ''}.` : 'Write an idea and press Plan shots.',
      costLine ? `At list prices (${state.catalog?.pricesAsOf ?? 'recent'}): ${costLine}.` : '',
    ].filter(Boolean).join(' ')),
    estimateLine(),
    join?.state === 'failed' ? h('p.error-text', {}, join.error) : null);
  return { story, controls };
}

// Picture quality, always in view: the finished film's size, how smaller clips are enlarged, motion and colour.
function qualityPanel(sequence) {
  const { settings } = sequence;
  const tools = ui.tools ?? {};
  const choose = guard(async (key, value) => {
    const tool = key === 'upscale' && ['ai', 'anime'].includes(value) ? 'ai' : key === 'interpolateFps' && value ? 'rife' : null;
    if (tool && !tools.unavailable && !tools[tool]) {
      const what = tool === 'ai'
        ? `The AI upscaler is Real-ESRGAN, which runs on your GPU. It is not installed yet.\n\nDownload it now from its official GitHub release (about ${tools.downloadMb?.ai ?? 47} MB) into Lumina's data folder?`
        : `Smooth motion uses RIFE, which runs on your GPU. It is not installed yet.\n\nDownload it now from its official GitHub release (about ${tools.downloadMb?.rife ?? 20} MB) into Lumina's data folder?`;
      if (!confirm(what)) return;
      await work(`install-${tool}`, async () => { ui.tools = await call('/api/enhancer/install', 'POST', { tool }); });
      toast(tool === 'ai' ? 'AI upscaler installed.' : 'Smooth motion installed.');
    }
    await saveSettings({ [key]: value });
  });
  const segment = (label, key, options, fallback) => {
    const current = String(settings[key] ?? fallback);
    return h('div.q-field', {}, h('span.field-label', {}, label),
      h('div.segmented.q-segment', { role: 'radiogroup', 'aria-label': label }, ...options.map(([value, text, hint]) => h(`button${current === String(value) ? '.selected' : ''}`, {
        type: 'button', role: 'radio', 'aria-checked': String(current === String(value)), title: hint ?? '', disabled: Boolean(ui.busy),
        onclick: () => current !== String(value) && choose(key, value),
      }, text))));
  };
  const [w, hgt] = { '16:9': [16, 9], '9:16': [9, 16], '1:1': [1, 1] }[settings.aspect] ?? [16, 9];
  const height = settings.outputHeight ?? 1080;
  const size = w >= hgt ? `${Math.round(height * w / hgt / 2) * 2}×${height}` : `${height}×${Math.round(height * hgt / w / 2) * 2}`;
  const upscaler = { none: 'a plain resize', fast: 'the fast GPU sharpener', ai: 'Real-ESRGAN (AI, live action)', anime: 'Real-ESRGAN (AI, anime)' }[settings.upscale ?? 'none'];
  const installing = ui.busy === 'install-ai' ? 'Downloading the AI upscaler…' : ui.busy === 'install-rife' ? 'Downloading RIFE…' : '';
  return h('section.panel.sb-quality', {},
    h('div.sb-section-head', {}, h('h2', {}, 'Picture quality'), h('span.muted', {}, `Finished film: ${size}. Clips smaller than that are enlarged once, from the original, with ${upscaler}.`)),
    h('div.q-row', {},
      segment('RESOLUTION', 'outputHeight', [[720, '720p', 'HD'], [1080, '1080p', 'Full HD'], [1440, '1440p', 'QHD'], [2160, '4K', 'Ultra HD (2160p)']], 1080),
      segment('UPSCALER', 'upscale', [
        ['ai', `AI · live action${tools.ai ? '' : ' ↓'}`, 'Real-ESRGAN x4plus: adds real detail. About a second per frame on the GPU.'],
        ['anime', `AI · anime${tools.ai ? '' : ' ↓'}`, 'Real-ESRGAN anime video: crisp lines, no smearing. Several times faster.'],
        ['fast', 'Fast GPU', 'Sharp Lanczos on the GPU (libplacebo): seconds, no new detail.'],
        ['none', 'Off', 'Plain Lanczos resize only.']], 'none'),
      segment('MOTION', 'interpolateFps', [[0, 'As made', 'Keep the model\'s frame rate (24 fps for cinema models).'], [30, `Smooth 30 fps${tools.rife ? '' : ' ↓'}`, 'RIFE makes in-between frames: steadier on 60 Hz screens.']], 0),
      segment('COLOUR', 'colorMatch', [['scene', 'Match per scene'], ['film', 'Match whole film'], ['off', 'Off']], 'scene')),
    installing ? h('p.badge', { dataset: { tone: 'busy' } }, installing) : null,
    h('p.muted.small-note.q-note', {}, `${tools.ai ? 'AI upscaler installed.' : 'Options marked ↓ download a free tool the first time you pick them.'} Working files stay near-lossless; the film is encoded once at the end. Change these, then join again.`));
}

// The film: the player (opens on the first shot's frame, not a black fade-in), the main actions and progress.
function filmHero(sequence, shots, controls) {
  const poster = shots.find((s) => s.imagePath)?.imagePath ?? '';
  const meta = h('span.sb-film-meta.muted', {});
  const player = sequence.outputPath
    ? h('video.sb-film', { src: sequence.outputPath, controls: true, preload: 'metadata', poster, playsInline: true,
      onloadedmetadata: (event) => { meta.textContent = `${event.target.videoWidth}×${event.target.videoHeight} · ${clock(event.target.duration)}`; } })
    : h('div.sb-film-empty', {}, poster ? h('img', { src: poster, alt: '' }) : null,
      h('div.sb-film-empty-text', {}, h('b', {}, shots.length ? 'Your film appears here' : 'Start with an idea'),
        h('span.muted', {}, shots.length ? 'Press Produce film: Lumina makes every frame and clip, then joins them.' : 'Write the idea below, then press Plan shots.')));
  return h('section.panel.sb-hero', {},
    h('div.panel-topline', {}, h('div', {}, h('span.section-title', {}, sequence.title), meta),
      sequence.outputPath ? h('button.button.secondary.small', { onclick: () => downloadAsset(sequence.outputPath, `${sequence.title}.mp4`) }, 'Download film') : null),
    h('div.sb-film-frame', { dataset: { aspect: sequence.settings.aspect } }, player),
    controls,
    sequence.outputPath ? enhanceRow(sequence) : null);
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

// Queued jobs, and running jobs on this computer, can be stopped; paid jobs keep running once sent.
const canCancel = (job) => job.status === 'queued' || (job.status === 'running' && ['local', 'mock'].includes(job.provider));
async function cancelJob(job) {
  try {
    await call(`/api/generations/${job.id}/cancel`);
    toast('Cancelled.');
  } catch (error) {
    toast(error.message, 'error');
  }
  ui.pollUntil = Date.now() + 5000;
  watch();
}

function jobBadge(job, label) {
  if (!job || job.status === 'completed') return null;
  const percent = job.progress?.total ? ` ${Math.round(job.progress.fraction * 100)}%${job.progress.etaSeconds != null ? ` · ${clock(job.progress.etaSeconds)} left` : ''}` : '';
  const badge = h('span.badge', { dataset: { tone: jobActive(job) ? 'busy' : job.error === 'Cancelled.' || job.error === 'Cancelled before it started.' ? '' : 'error' }, title: job.error ?? '' },
    `${label}: ${statusText[job.status] ?? job.status}${job.status === 'running' ? percent : ''}`);
  if (!jobActive(job) || !canCancel(job)) return badge;
  return h('span', {}, badge, ' ', h('button.button.ghost.small', { title: 'Stop this job', onclick: () => cancelJob(job) }, 'Cancel'));
}

// A shot's continuity details: who and where, the action, the words, how it starts and ends, what must not change.
function shotDetails(shot) {
  const d = shot.details;
  const locked = d.locked;
  const save = (patch) => guard(async () => show(await call(`/api/shots/${shot.id}`, 'PATCH', { details: patch })))();
  const text = (label, key, max, placeholder, story = true) => {
    const node = h('input', { type: 'text', value: d[key] ?? '', maxLength: max, placeholder, disabled: locked && story, 'aria-label': label, onchange: () => save({ [key]: node.value }) });
    return h('label', {}, h('span.field-label', {}, label.toUpperCase()), node);
  };
  const location = h('select', { 'aria-label': 'Location', disabled: locked, onchange: () => save({ locationId: location.value || null }) },
    h('option', { value: '' }, places().length ? 'No saved location' : 'Add a location on the Characters tab'), ...places().map((c) => h('option', { value: c.id }, c.name)));
  location.value = d.locationId ?? '';
  const filmThemes = (ui.detail.sequence.settings.themes ?? []).map((t) => (t.indexOf(':') > 0 ? t.slice(0, t.indexOf(':')).trim() : t.trim()));
  const shown = new Set(d.themes ?? []);
  const themeChips = filmThemes.length ? h('div.applied-presets', {}, h('span.field-label', {}, 'THEMES IN THIS SHOT'),
    ...filmThemes.map((name) => h(`button.character-chip${shown.has(name) ? '.selected' : ''}`, { 'aria-pressed': String(shown.has(name)), disabled: locked, onclick: () => {
      if (shown.has(name)) shown.delete(name); else shown.add(name);
      save({ themes: [...shown] });
    } }, name))) : null;
  const cast = new Set(d.characterIds);
  const castChips = h('div.applied-presets', {}, h('span.field-label', {}, 'IN THIS SHOT'),
    ...people().map((c) => h(`button.character-chip${cast.has(c.id) ? '.selected' : ''}`, { 'aria-pressed': String(cast.has(c.id)), disabled: locked, onclick: () => {
      if (cast.has(c.id)) cast.delete(c.id); else cast.add(c.id);
      save({ characterIds: [...cast] });
    } }, c.references[0] ? h('img', { src: c.references[0].path, alt: '' }) : null, c.name)),
    h('small.muted', {}, cast.size ? '' : 'None picked: the film\'s whole cast is used.'));

  // Dialogue: one row per line; any change saves the whole list.
  const rows = d.dialogue.map((line) => ({ ...line }));
  const speakers = [['narrator', 'Narrator'], ...people().map((c) => [c.id, c.name])];
  const saveLines = () => save({ dialogue: rows.filter((r) => r.text.trim()).map(({ speaker, text: words, start }) => ({ speaker, text: words, start })) });
  const lineRow = (row, i) => {
    const speaker = h('select', { disabled: locked, 'aria-label': 'Speaker', onchange: () => { row.speaker = speaker.value; saveLines(); } }, ...speakers.map(([v, label]) => h('option', { value: v }, label)));
    speaker.value = row.speaker;
    const words = h('input', { type: 'text', value: row.text, maxLength: 1000, disabled: locked, 'aria-label': 'Line', onchange: () => { row.text = words.value; saveLines(); } });
    const start = h('input', { type: 'number', min: 0, step: 0.1, value: row.start ?? '', placeholder: 'auto', disabled: locked, 'aria-label': 'Starts at (seconds into the shot)', title: 'Seconds into the shot (empty = one after another)',
      onchange: () => { row.start = start.value === '' ? null : Number(start.value); saveLines(); } });
    return h('div.key-row.sb-line', {}, speaker, words, start,
      row.audioPath ? h('audio', { src: row.audioPath, controls: true, preload: 'none' }) : h('span.muted', {}, 'not recorded'),
      locked ? null : h('button.ghost', { 'aria-label': 'Remove line', onclick: () => { rows.splice(i, 1); saveLines(); } }, '✕'));
  };
  const videoModels = modelsFor('video');
  const model = h('select', { 'aria-label': 'Video model for this shot', onchange: () => save({ model: model.value }) },
    h('option', { value: '' }, 'Storyboard\'s video model'), ...videoModels.map(({ provider, model: m, value }) => h('option', { value, disabled: !provider.ready }, `${provider.label} · ${m.label}`)));
  model.value = d.model ?? '';
  const method = h('select', { 'aria-label': 'Shot type', disabled: locked, onchange: () => save({ method: method.value }) },
    h('option', { value: 'video' }, 'Video clip (paid)'), h('option', { value: 'still' }, 'Still shot with camera move (free)'));
  method.value = d.method;
  const motion = h('select', { 'aria-label': 'Still-shot move', onchange: () => save({ motion: motion.value }) },
    ...(ui.options?.stillMotions ?? ['push-in', 'pull-out', 'pan-left', 'pan-right', 'rise', 'hold']).map((m) => h('option', { value: m }, m)));
  motion.value = d.motion;
  const toggle = (label, key) => {
    const box = h('input', { type: 'checkbox', checked: Boolean(d[key]), onchange: () => save({ [key]: box.checked }) });
    return h('label.check-row', {}, box, h('span', {}, label));
  };
  return h('details.panel-details.sb-details', {},
    h('summary', {}, [d.scene || 'Continuity details', locked ? '🔒 locked' : '', d.dialogue.length ? `${d.dialogue.length} line(s)` : ''].filter(Boolean).join(' · ')),
    h('div.sb-grid', {},
      text('Scene', 'scene', 80, 'e.g. 3 – Rooftop at night'),
      h('label', {}, h('span.field-label', {}, 'LOCATION'), location),
      h('label', {}, h('span.field-label', {}, 'SHOT TYPE'), method),
      d.method === 'still' ? h('label', {}, h('span.field-label', {}, 'STILL-SHOT MOVE'), motion) : h('label', {}, h('span.field-label', {}, 'VIDEO MODEL'), model),
      text('Action', 'action', 1000, 'The one thing that must happen'),
      text('Starts with', 'startState', 500, 'Situation at the first frame'),
      text('Ends with', 'endState', 500, 'Situation at the last frame'),
      text('Must not change', 'forbidden', 500, 'e.g. the red scarf, the scar on her left cheek')),
    castChips, themeChips,
    h('div.sb-dialogue', {}, h('span.field-label', {}, 'DIALOGUE'), ...rows.map(lineRow),
      locked ? null : h('button.text-button', { onclick: () => { rows.push({ speaker: speakers[1]?.[0] ?? 'narrator', text: '', start: null }); render(); } }, '+ Add a line')),
    h('div.key-row', {},
      toggle('Smooth to 30 fps', 'interpolate'), toggle('Mute the clip\'s own sound', 'muteClipSound'),
      h('label.check-row', { title: 'Locked shots keep their story (description, action, dialogue, start and end) until you unlock them.' },
        h('input', { type: 'checkbox', checked: locked, onchange: (event) => save({ locked: event.target.checked }) }), h('span', {}, 'Lock story'))));
}

// Review: the free checks' findings and the person's decision.
function reviewRow(shot) {
  const r = shot.review ?? {};
  const settings = ui.detail.sequence.settings;
  const act = (path, body) => guard(async () => show(await call(path, 'POST', body)));
  const problems = (r.checks ?? []).filter((c) => !c.ok);
  const frameApproved = r.frameApproved && r.frameApproved === shot.imageAssetId;
  return h('div.sb-review', {},
    h('div.key-row', {},
      shot.videoPath ? h('span.badge', { dataset: { tone: reviewTone[r.status] ?? 'busy' }, title: r.notes || '' }, reviewLabels[r.status] ?? 'Not checked yet') : null,
      settings.requireApproval && shot.imagePath && !shot.videoPath
        ? h('button.button.secondary.small', { onclick: act(`/api/shots/${shot.id}/approve-frame`, { approved: !frameApproved }) }, frameApproved ? '✓ Frame approved' : 'Approve frame')
        : null,
      shot.videoPath ? h('button.button.secondary.small', { disabled: r.status === 'accepted', onclick: act(`/api/shots/${shot.id}/review`, { status: 'accepted' }) }, r.status === 'accepted' ? '✓ Accepted' : 'Accept') : null,
      shot.videoPath ? h('button.text-button', { onclick: act(`/api/shots/${shot.id}/review`, { status: 'needs_regeneration' }) }, 'Mark for redo') : null,
      shot.videoPath ? h('button.text-button.danger', { onclick: act(`/api/shots/${shot.id}/review`, { status: 'rejected' }) }, 'Leave out') : null,
      shot.videoPath ? h('button.text-button', { title: 'Run the free checks again', onclick: act(`/api/shots/${shot.id}/checks`, {}) }, 'Re-check') : null),
    problems.length ? h('ul.sb-problems', {}, ...problems.map((c) => h('li', { dataset: { severity: c.severity } }, c.detail))) : null);
}

function shotCard(shot, index, total) {
  const id = ui.detail.sequence.id;
  const act = (path, method, body) => guard(async () => show(await call(path, method, body)));
  const locked = shot.details.locked;
  const description = h('textarea', { rows: 3, maxLength: 2000, value: shot.description, disabled: locked, 'aria-label': `Shot ${shot.position} description`, placeholder: 'What we see and what happens in this shot.',
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
    if (!locked && (description.value !== shot.description || document.activeElement === description)) await call(`/api/shots/${shot.id}`, 'PATCH', { description: description.value });
    const result = await call(`/api/shots/${shot.id}/${kind}`);
    if (result.alreadyRunning) toast('That job is already running.');
    show(result.sequence ? result : await call(`/api/storyboards/${id}`, 'GET'));
  });
  const still = shot.details.method === 'still';
  const unrecorded = shot.details.dialogue.filter((l) => !l.assetId).length;
  const recorded = shot.details.dialogue.filter((l) => l.assetId).length;
  const lipSync = (box) => guard(async () => {
    try {
      await work(`lipsync-${shot.id}`, async () => show(await call(`/api/shots/${shot.id}/lipsync`, 'POST', box ? { box } : {})));
      ui.mouthFor = null;
      toast(`Shot ${shot.position} is lip-synced.`);
    } catch (error) {
      if (!error.data?.needBox) throw error;
      ui.mouthFor = shot.id;
      render();
      toast('Drag a box over the speaker\'s mouth on the shot\'s picture.');
    }
  })();
  // Drawing the mouth box: drag over the frame; the box is sent as fractions of the picture.
  const mouthPicker = () => {
    const img = h('img', { src: shot.imagePath, alt: `Frame for shot ${shot.position}`, draggable: false });
    const mark = h('div.sb-mouth-box.hidden');
    let start = null;
    const at = (event) => {
      const r = img.getBoundingClientRect();
      return [Math.min(1, Math.max(0, (event.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (event.clientY - r.top) / r.height))];
    };
    const place = (a, b) => {
      const [x1, x2] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
      const [y1, y2] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
      Object.assign(mark.style, { left: `${x1 * 100}%`, top: `${y1 * 100}%`, width: `${(x2 - x1) * 100}%`, height: `${(y2 - y1) * 100}%` });
      mark.classList.remove('hidden');
      return [x1, y1, x2, y2];
    };
    return h('div.sb-mouth-picker', {
      onpointerdown: (event) => { start = at(event); event.currentTarget.setPointerCapture(event.pointerId); },
      onpointermove: (event) => { if (start) place(start, at(event)); },
      onpointerup: (event) => {
        if (!start) return;
        const box = place(start, at(event));
        start = null;
        if (box[2] - box[0] > 0.01 && box[3] - box[1] > 0.01) lipSync(box);
      },
    }, img, mark, h('span.sb-mouth-hint', {}, 'Drag over the mouth'));
  };
  const media = ui.mouthFor === shot.id && shot.imagePath ? mouthPicker() : shot.videoPath ? h('video', { src: shot.videoPath, controls: true, loop: true, preload: 'metadata', poster: shot.imagePath ?? '' })
    : shot.imagePath ? h('img', { src: shot.imagePath, alt: `Frame for shot ${shot.position}`, loading: 'lazy' })
      : h('div.sb-placeholder.muted', {}, 'No frame yet');
  return h('article.panel.sb-shot', {},
    h('div.sb-media', { dataset: { aspect: ui.detail.sequence.settings.aspect } }, media, h('span.sb-number', {}, String(shot.position))),
    h('div.sb-shot-fields', {},
      description,
      h('div.key-row', {}, camera, duration, still ? h('span.badge', {}, 'Still shot · free') : null),
      h('div.key-row.sb-shot-actions', {},
        h('button.button.secondary.small', { disabled: jobActive(shot.frameJob), onclick: start('frame') }, shot.imagePath ? 'Redo frame' : 'Make frame'),
        still
          ? h('button.button.secondary.small', { disabled: !shot.imagePath, onclick: start('still') }, shot.videoPath ? 'Re-render still' : 'Render still (free)')
          : h('button.button.secondary.small', { disabled: jobActive(shot.clipJob), onclick: start('animate') }, shot.videoPath ? 'Redo clip' : 'Animate'),
        ui.options?.lipSync && ui.detail?.sequence.settings.lipSync === true && ui.detail?.sequence.settings.look === 'anime' && shot.videoPath && recorded ? h('button.button.secondary.small', { disabled: ui.busy === `lipsync-${shot.id}`, title: 'Make the mouth move with the recorded dialogue (free, on this computer)', onclick: () => lipSync(null) },
          ui.busy === `lipsync-${shot.id}` ? 'Lip-syncing…' : shot.details.lipsync?.result === shot.videoAssetId ? 'Redo lip sync' : 'Lip sync') : null,
        unrecorded ? h('button.button.secondary.small', { title: 'Speak the dialogue in each character\'s voice', onclick: guard(async () => {
          const result = await call(`/api/shots/${shot.id}/dialogue`);
          if (result.missingVoices.length) toast(`No voice set for: ${result.missingVoices.join(', ')}. Pick one on the Characters tab (or a narrator voice).`, 'error');
          ui.pollUntil = Date.now() + 90_000;
          watch();
        }) }, `Voice ${unrecorded} line(s)`) : null,
        jobBadge(shot.frameJob, 'Frame'), jobBadge(shot.clipJob, 'Clip'),
        h('span.sb-spacer'),
        h('button.ghost', { disabled: index === 0, title: 'Move earlier', 'aria-label': 'Move earlier', onclick: act(`/api/shots/${shot.id}/move`, 'POST', { direction: 'up' }) }, '↑'),
        h('button.ghost', { disabled: index === total - 1, title: 'Move later', 'aria-label': 'Move later', onclick: act(`/api/shots/${shot.id}/move`, 'POST', { direction: 'down' }) }, '↓'),
        h('button.ghost', { title: 'Delete shot', 'aria-label': 'Delete shot', onclick: guard(async () => {
          if (confirm(`Delete shot ${shot.position}?`)) show(await call(`/api/shots/${shot.id}`, 'DELETE'));
        }) }, '✕')),
      reviewRow(shot),
      shotDetails(shot)));
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
  const lastFrame = Boolean(videoChoice()?.model.lastFrame);
  return [
    select('Continuity', 'continuity', [
      ['frames', 'Each shot from its approved frame'],
      ['keyframes', `Start and end frames${lastFrame ? '' : ' (this video model can\'t take an end frame)'}`],
      ['chain', 'Continuous (each clip starts where the last ended)'],
    ], settings.continuity),
    select('Clip length', 'clipLength', [['0', 'Writer decides'], ...lengths.map((d) => [String(d), `${d} s every shot`])], settings.clipLength ?? 0, Number),
    select('Look', 'look', [['live-action', 'Live-action film'], ['anime', 'Anime feature film'], ['as-written', 'As written (any style)']], settings.look ?? 'live-action'),
    select('Transitions', 'transition', [['cut', 'Hard cuts'], ['crossfade', 'Crossfades (0.5 s)']], settings.transition ?? 'cut'),
    select('Finish', 'finish', [['none', 'None'], ['cinematic', 'Cinematic (2.39:1 bars, grain, fades)'], ['anime', 'Anime (clean colour, crisp lines, fades)']], settings.finish ?? 'none'),
  ];
}

// Upload a music, ambience or voice file; resolves with the saved audio asset.
function chooseAudio() {
  return new Promise((resolve, reject) => {
    const input = h('input', { type: 'file', accept: 'audio/mpeg,audio/wav,audio/ogg,audio/flac,.mp3,.wav,.ogg,.flac' });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try {
        const response = await fetch(`/api/projects/${state.project.id}/audio`, { method: 'POST', credentials: 'same-origin', body: file, headers: { 'x-lumina-label': file.name.slice(0, 120) } });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Upload failed.');
        resolve(data.asset);
      } catch (error) {
        reject(error);
      }
    };
    input.click();
  });
}

// The settings that make a film look like one film and sound finished: look bible and seed, approval, the
// screenplay and the soundtrack. (Size, upscaler, motion and colour are in the picture quality panel.)
function filmPanels(sequence) {
  const { settings } = sequence;
  const check = (label, key, hint) => {
    const box = h('input', { type: 'checkbox', checked: Boolean(settings[key]), onchange: () => saveSettings({ [key]: box.checked }) });
    return h('label.check-row', { title: hint }, box, h('span', {}, label));
  };
  const bible = h('textarea', { rows: 3, maxLength: 1500, value: settings.lookBible ?? '', 'aria-label': 'Look bible',
    placeholder: 'Sent with every frame and clip. e.g. “Muted teal-and-amber palette, 35 mm anamorphic lens, soft rim light, light film grain, late-1970s Tokyo.”',
    onchange: () => saveSettings({ lookBible: bible.value }) });
  const themes = h('textarea', { rows: 3, maxLength: 2500, value: (settings.themes ?? []).join('\n'), 'aria-label': 'Themes',
    placeholder: 'One per line, "Name: how it shows on screen". e.g.\nChaos agent: a grinning trickster who breaks every plan with fire and laughter\nTranscendentalist doctrine: a monk who finds truth alone in wild nature, lit by dawn',
    onchange: () => saveSettings({ themes: themes.value.split('\n').map((t) => t.trim()).filter(Boolean) }) });
  const coverage = sequence.themeCoverage;
  const themeNote = settings.themes?.length && Object.keys(coverage?.where ?? {}).length
    ? h(coverage.missing.length ? 'p.error-text' : 'p.muted.small-note', {}, Object.entries(coverage.where).map(([name, at]) => `${name}: ${at.length ? `shots ${at.join(', ')}` : 'not shown in any shot'}`).join(' · ')
      + (coverage.missing.length ? ' — re-plan, or tag shots in their continuity details.' : ''))
    : null;
  const seed = h('input', { type: 'number', min: 0, value: settings.seed ?? '', placeholder: 'None', 'aria-label': 'Seed', onchange: () => saveSettings({ seed: seed.value === '' ? null : Number(seed.value) }) });
  const screenplay = h('textarea', { rows: 8, maxLength: 60000, value: sequence.screenplay ?? '', 'aria-label': 'Screenplay',
    placeholder: 'Optional. Paste a screenplay: the writer follows its scenes in order and keeps the dialogue word for word.', onchange: () => saveFields({ screenplay: screenplay.value }) });
  const budgetSeconds = h('input', { type: 'number', min: 0, max: 900, value: settings.videoSecondsBudget || '', placeholder: 'No limit', 'aria-label': 'Seconds of paid video',
    onchange: () => saveSettings({ videoSecondsBudget: Number(budgetSeconds.value || 0) }) });
  const level = (label, value, onchange) => {
    const node = h('input', { type: 'range', min: 0, max: 1.5, step: 0.05, value, 'aria-label': label, onchange: () => onchange(Number(node.value)) });
    return h('label', {}, h('span.field-label', {}, `${label.toUpperCase()}`), node);
  };
  const bed = (key, label) => {
    const current = settings[key];
    return h('div.key-row', {},
      h('span.field-label', {}, label.toUpperCase()),
      current ? h('span.muted', {}, 'Uploaded track') : h('span.muted', {}, 'None'),
      h('button.button.secondary.small', { onclick: guard(async () => {
        const asset = await chooseAudio();
        if (asset) saveSettings({ [key]: { assetId: asset.id, volume: current?.volume ?? (key === 'music' ? 0.3 : 0.25) } });
      }) }, current ? 'Replace…' : 'Upload…'),
      current ? level('Level', current.volume, (volume) => saveSettings({ [key]: { ...current, volume } })) : null,
      current ? h('button.text-button.danger', { onclick: () => saveSettings({ [key]: null }) }, 'Remove') : null);
  };
  const narrator = h('select', { 'aria-label': 'Narrator voice', onchange: () => saveSettings({ narratorVoice: narrator.value ? JSON.parse(narrator.value) : null }) },
    h('option', { value: '' }, 'No narrator voice'), ...voiceOptions().map((o) => h('option', { value: o.value, disabled: !o.ready }, o.label + (o.ready ? '' : ' (add key)'))));
  narrator.value = settings.narratorVoice ? JSON.stringify({ provider: settings.narratorVoice.provider, model: settings.narratorVoice.model, voice: settings.narratorVoice.voice ?? null }) : '';
  return h('div.sb-film-panels', {},
    h('details.panel-details', { open: !sequence.outputAssetId }, h('summary', {}, 'Look and continuity — keep every face, set and colour the same'),
      h('div.sb-grid', {},
        h('label.sb-wide', {}, h('span.field-label', {}, 'LOOK BIBLE (EVERY SHOT)'), bible),
        h('label.sb-wide', {}, h('span.field-label', {}, 'THEMES THE AUDIENCE MUST SEE'), themes, themeNote),
        h('label', {}, h('span.field-label', {}, 'SEED (SAME FOR EVERY SHOT)'), seed),
        h('label', {}, h('span.field-label', {}, 'PAID VIDEO LIMIT (SECONDS)'), budgetSeconds),
        check('Lip sync (anime mouth movement)', 'lipSync', 'Show the Lip sync button on shots with recorded dialogue. Turn off to keep mouths still.'),
        check('Approve frames and clips before they are used', 'requireApproval', 'Production stops for you to approve every frame (before video is paid for) and every clip (before the film is joined).')),
      h('p.muted.small-note', {}, 'Characters and locations you add above are attached to every shot they appear in (description and reference photos). Lock a character once it looks right.'),
      faceRow()),
    h('details.panel-details', {}, h('summary', {}, 'Screenplay'), screenplay),
    h('details.panel-details', {}, h('summary', {}, 'Sound — dialogue, music, ambience'),
      h('label', {}, h('span.field-label', {}, 'NARRATOR VOICE'), narrator),
      bed('music', 'Music'), bed('ambience', 'Ambience'),
      level('Clip sound (effects from the video model)', settings.clipVolume ?? 1, (clipVolume) => saveSettings({ clipVolume })),
      h('p.muted.small-note', {}, 'Dialogue is spoken in each character\'s voice (set it on the Characters tab), levelled to match, and the music ducks under it.')));
}

// Timeline: the film to scale — every shot, every dialogue line where it will be heard, and the music and ambience
// beds. Lines without a recording yet are drawn at an estimated length (about 2.6 words a second). Lines that run
// past the end of their shot are shown in red. Click a shot to jump to it.
function timeline() {
  const { sequence, shots } = ui.detail;
  const total = shots.reduce((sum, s) => sum + (s.duration ?? 0), 0);
  if (!total) return null;
  const pct = (seconds) => `${(seconds / total) * 100}%`;
  const names = new Map((state.characters ?? []).map((c) => [c.id, c.name]));
  const pictures = [];
  const lines = [];
  let elapsed = 0;
  for (const shot of shots) {
    const length = shot.duration ?? 0;
    const status = shot.videoPath ? shot.review?.status ?? 'pending' : 'missing';
    pictures.push(h('button.tl-shot', {
      style: `left:${pct(elapsed)};width:${pct(length)}`, dataset: { status, still: String(shot.details.method === 'still') },
      title: `Shot ${shot.position}: ${length} s${shot.details.scene ? ` · ${shot.details.scene}` : ''} · ${shot.videoPath ? reviewLabels[status] ?? status : 'no clip yet'}`,
      onclick: () => document.querySelectorAll('.sb-shot')[shot.position - 1]?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
    }, String(shot.position)));
    let cursor = 0.4;
    for (const line of shot.details.dialogue) {
      const seconds = line.seconds ?? Math.max(0.8, line.text.split(/\s+/).length / 2.6);
      const at = Number.isFinite(line.start) && line.start !== null ? line.start : cursor;
      cursor = at + seconds + 0.25;
      const over = at + seconds > length + 0.05;
      const who = line.speaker === 'narrator' ? 'Narrator' : names.get(line.speaker) ?? 'Unknown';
      lines.push(h('span.tl-line', {
        style: `left:${pct(elapsed + at)};width:${pct(Math.min(seconds, total - elapsed - at))}`, dataset: { over: String(over), recorded: String(Boolean(line.assetId)) },
        title: `${who}: “${line.text}” (${seconds.toFixed(1)} s${line.seconds ? '' : ', estimated'}${over ? `, runs ${(at + seconds - length).toFixed(1)} s past the shot` : ''})`,
      }, who[0]));
    }
    elapsed += length;
  }
  const step = total > 240 ? 60 : total > 60 ? 15 : 5;
  const ticks = [];
  for (let t = 0; t <= total; t += step) ticks.push(h('span.tl-tick', { style: `left:${pct(t)}` }, clock(t)));
  const bed = (key, label) => (sequence.settings[key] ? h('div.tl-track', {}, h('span.tl-label', {}, label), h('div.tl-lane', {}, h('span.tl-bed', { dataset: { kind: key }, title: `${label} at ${Math.round(sequence.settings[key].volume * 100)}%` }))) : null);
  const overruns = lines.filter((l) => l.dataset.over === 'true').length;
  return h('details.panel-details.sb-timeline', { open: true },
    h('summary', {}, `Timeline · ${clock(total)}${overruns ? ` · ${overruns} line(s) too long for their shot` : ''}`),
    h('div.tl-track', {}, h('span.tl-label', {}, ''), h('div.tl-lane.tl-ruler', {}, ...ticks)),
    h('div.tl-track', {}, h('span.tl-label', {}, 'Picture'), h('div.tl-lane', {}, ...pictures)),
    lines.length ? h('div.tl-track', {}, h('span.tl-label', {}, 'Dialogue'), h('div.tl-lane', {}, ...lines)) : null,
    bed('music', 'Music'), bed('ambience', 'Ambience'));
}

// The face identity check: after each clip, are the people in it the same people as in their reference photos?
function faceRow() {
  const f = ui.faces;
  if (!f || f.unavailable) return null;
  if (f.installed) return h('p.muted.small-note', {}, '✓ Face identity check on: every clip is compared with the reference photos of the people in it (live action; skipped for anime).');
  return h('div.key-row', {},
    h('span.muted', {}, `Face identity check: tells you when a person in a clip no longer looks like their reference photos. Free; needs a one-time ${f.downloadMb} MB download of two open models (OpenCV YuNet and SFace).`),
    h('button.button.secondary.small', { disabled: ui.busy === 'faces', onclick: guard(async () => {
      await work('faces', async () => { ui.faces = await call('/api/faces/install'); });
      toast('Face check installed. New clips will be checked; press Re-check on a shot to check an existing one.');
    }) }, ui.busy === 'faces' ? 'Downloading…' : 'Install'));
}

function estimateLine() {
  const e = ui.estimate;
  if (!e || !e.lines.length) return null;
  const parts = [`Still to spend: about $${e.totalUsd.toFixed(2)} for ${e.lines.length} job(s)`];
  if (e.unpriced) parts.push(`${e.unpriced} without a listed price`);
  if (e.stillSeconds) parts.push(`${clock(e.stillSeconds)} of free still shots`);
  if (e.remainingUsd != null) parts.push(`budget left $${e.remainingUsd.toFixed(2)}`);
  return h(e.fits === false ? 'p.error-text' : 'p.muted', {}, `${parts.join(' · ')}${e.fits === false ? ' — over your budget.' : '.'}`);
}

function productionLine(sequence) {
  const production = sequence.production;
  if (!production) return null;
  if (production.state === 'running') return h('p.badge', { dataset: { tone: 'busy' } }, `In production: ${production.step}…`);
  if (production.state === 'paused') return h('p.error-text', {}, `Production paused: ${production.error ?? production.step}`);
  if (production.state === 'review') return h('p.badge', { dataset: { tone: 'busy' } }, `Waiting for you: ${production.step}.`);
  return h('p.muted', {}, `Production finished. ${production.step ?? ''}`);
}

function enhanceRow(sequence) {
  const status = sequence.enhance;
  const outputId = sequence.outputAssetId;
  const start = (mode, download = false, target = undefined) => guard(async () => {
    try {
      await call(`/api/assets/${outputId}/enhance`, 'POST', { mode, download, height: target });
    } catch (error) {
      if (error.data?.needsDownload && !download) {
        if (confirm('AI upscaling uses Real-ESRGAN, which runs on your NVIDIA GPU. It is not installed yet.\n\nDownload it now from the official GitHub release (about 47 MB) into Lumina\'s data folder?')) return start(mode, true, target)();
        return undefined;
      }
      throw error;
    }
    return show(await call(`/api/storyboards/${sequence.id}`, 'GET'));
  });
  const running = status?.state === 'running';
  const height = h('select', { 'aria-label': 'Target height' }, h('option', { value: '' }, '2× size'), ...[1080, 1440, 2160].map((v) => h('option', { value: v }, `${v}p`)));
  const go = (mode) => (event) => start(mode, false, height.value ? Number(height.value) : undefined)(event);
  return h('div.key-row.sb-enhance', {},
    h('span.field-label', {}, 'ENHANCE'), height,
    h('button.button.secondary.small', { disabled: running, title: 'GPU upscaling (libplacebo, EWA Lanczos). Takes seconds to minutes.', onclick: go('fast') }, 'Sharpen (fast, GPU)'),
    h('button.button.secondary.small', { disabled: running, title: 'Real-ESRGAN anime-video model: clean lines and flat colours stay crisp, no smearing.', onclick: go('anime') }, 'AI upscale — anime'),
    h('button.button.secondary.small', { disabled: running, title: 'Real-ESRGAN x4plus on your GPU: adds real detail to live action, but takes about a second or more per frame.', onclick: go('ai') }, 'AI upscale — live action'),
    running ? h('span.badge', { dataset: { tone: 'busy' } }, `Enhancing (${status.mode})… ${status.done}/${status.total}`) : null,
    status?.state === 'failed' ? h('span.error-text', {}, status.error) : null,
    status?.state === 'completed' ? h('span.muted', {}, `Enhanced copy (${status.width}×${status.height}) saved to the library.`) : null);
}

function render() {
  const editor = $('#sb-editor');
  if (!ui.detail) {
    return editor.replaceChildren(h('div.history-empty.muted', {}, 'Turn an idea into a short film: Lumina plans the shots, makes a frame for each, animates them, and joins the clips into one video.'));
  }
  const { sequence, shots } = ui.detail;
  const { story, controls } = settingsPanel();
  return editor.replaceChildren(...[
    filmHero(sequence, shots, controls),
    qualityPanel(sequence),
    story,
    shots.length ? h('section.panel.sb-timeline-panel', {}, timeline()) : null,
    h('div.sb-section-head.sb-shots-head', {}, h('h2', {}, `Shots${shots.length ? ` · ${shots.length}` : ''}`), h('span.muted', {}, 'Each shot gets a frame, then a clip made from it. Accept the ones that look right.')),
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
    ui.faces ??= await call('/api/faces', 'GET').catch(() => null);
    ui.tools ??= await call('/api/enhancer', 'GET').catch(() => null);
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
