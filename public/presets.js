import { $, api, h, on, state, toast } from './lib.js';

// Preset gallery on Create: animated tiles (drawn in CSS from each preset's `tile` hints), one preset per group.
const local = { groups: {}, presets: [], selected: new Map(), mode: 'image', filter: 'all' };

const available = () => local.presets.filter((p) => p.modes.includes(local.mode));

export const selectedPresets = () => [...local.selected.values()].map((p) => p.id);

// Newest completed generation in this project that used the preset: shown on its tile instead of the drawing.
function lastResult(presetId) {
  return (state.detail?.generations ?? []).find((g) => g.status === 'completed' && g.params?.presets?.includes(presetId));
}

function scene() {
  return h('div.tile-scene', {}, h('div.l-sky'), h('div.l-sun'), h('div.l-far'), h('div.l-mid'), h('div.l-near'), h('div.l-fx'));
}

function toggle(preset) {
  if (local.selected.get(preset.group)?.id === preset.id) local.selected.delete(preset.group);
  else local.selected.set(preset.group, preset);
  render();
}

function tile(preset) {
  const selected = local.selected.get(preset.group)?.id === preset.id;
  const result = lastResult(preset.id);
  const media = result && (result.mimeType?.startsWith('video/')
    ? h('video.tile-result', { src: result.assetPath, muted: true, loop: true, playsInline: true, preload: 'metadata' })
    : result.mimeType?.startsWith('image/') ? h('img.tile-result', { src: result.assetPath, alt: '', loading: 'lazy' }) : null);
  const button = h(`button.preset-tile${selected ? '.selected' : ''}`, {
    dataset: { motion: preset.tile.motion, look: preset.tile.look, group: preset.group },
    'aria-pressed': String(selected), title: preset.fragment, onclick: () => toggle(preset),
  },
  scene(), media,
  media ? h('span.tile-badge', {}, 'Your result') : null,
  h('span.tile-group', {}, local.groups[preset.group]?.label.replace(/s$/, '') ?? preset.group),
  h('div.tile-text', {}, h('b', {}, preset.label), h('small', {}, preset.blurb)),
  selected ? h('span.tile-check', { 'aria-hidden': 'true' }, '✓') : null);
  if (media?.tagName === 'VIDEO') {
    button.addEventListener('mouseenter', () => media.play().catch(() => {}));
    button.addEventListener('mouseleave', () => media.pause());
  }
  return button;
}

function renderApplied() {
  const chips = [...local.selected.values()].map((p) => h('span.preset-chip', {},
    h('span.muted', {}, `${local.groups[p.group]?.label.replace(/s$/, '')}:`), ` ${p.label}`,
    h('button', { title: `Remove ${p.label}`, 'aria-label': `Remove ${p.label}`, onclick: () => toggle(p) }, '✕')));
  $('#applied-presets').replaceChildren(
    ...chips,
    h('button.text-button', { onclick: () => $('#preset-section').scrollIntoView({ behavior: 'smooth', block: 'start' }) },
      chips.length ? 'Change presets ↓' : '✦ Add a camera move, effect or style ↓'),
  );
  $('#applied-presets').classList.toggle('hidden', local.mode === 'speech');
}

function render() {
  $('#preset-section').classList.toggle('hidden', local.mode === 'speech');
  renderApplied();
  if (local.mode === 'speech') return;
  const list = available();
  const groups = Object.keys(local.groups).filter((g) => list.some((p) => p.group === g));
  if (local.filter !== 'all' && !groups.includes(local.filter)) local.filter = 'all';
  $('#preset-groups').replaceChildren(...['all', ...groups].map((g) => h(`button${local.filter === g ? '.selected' : ''}`, { onclick: () => { local.filter = g; render(); } },
    g === 'all' ? 'All' : local.groups[g].label)));
  $('#preset-grid').replaceChildren(...list.filter((p) => local.filter === 'all' || p.group === local.filter).map(tile));
}

export function presetModeChanged(mode) {
  local.mode = mode;
  for (const [group, preset] of local.selected) if (!preset.modes.includes(mode)) local.selected.delete(group);
  render();
}

// Apply the presets a past generation used (Remix).
export function applyPresets(ids = []) {
  local.selected.clear();
  for (const id of ids) {
    const preset = local.presets.find((p) => p.id === id);
    if (preset?.modes.includes(local.mode)) local.selected.set(preset.group, preset);
  }
  render();
}

export async function initPresets() {
  try {
    ({ groups: local.groups, presets: local.presets } = await api('/api/presets'));
  } catch (error) {
    toast(error.message, 'error');
  }
  on('project', () => render());
  render();
}
