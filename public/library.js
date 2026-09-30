import { $, $$, api, downloadAsset, emit, h, on, state, toast } from './lib.js';

let filter = 'project';

async function render() {
  const grid = $('#library-grid');
  const assets = filter === 'project'
    ? state.detail?.assets ?? []
    : (await api('/api/assets?kind=reference')).assets;
  const prompts = new Map((state.detail?.generations ?? []).filter((g) => g.assetId).map((g) => [g.assetId, g.prompt]));
  if (!assets.length) {
    grid.replaceChildren(h('div.history-empty.muted', {}, filter === 'project' ? 'Generate or upload an image to fill this project.' : 'No reference images yet.'));
    return;
  }
  grid.replaceChildren(...assets.map((asset) => {
    const kindLabel = { reference: 'Reference', generation: 'Generated', audio: 'Audio', video: 'Video' }[asset.kind] ?? asset.kind;
    const caption = prompts.get(asset.id) ?? asset.label ?? `${kindLabel} file`;
    const isImage = asset.mimeType.startsWith('image/');
    const preview = isImage ? h('img', { src: asset.path, alt: caption, loading: 'lazy' })
      : asset.mimeType.startsWith('video/') ? h('video', { src: asset.path, controls: true, preload: 'metadata' })
        : h('div.audio-card', {}, h('span', {}, '♪'), h('audio', { src: asset.path, controls: true, preload: 'none' }));
    return h('article.library-card', {},
      preview,
      h('div.library-meta', {}, h('span.badge', {}, kindLabel), h('b', {}, caption.length > 160 ? `${caption.slice(0, 160)}…` : caption),
        h('small', {}, new Date(asset.createdAt).toLocaleString())),
      h('div.library-actions', {},
        isImage ? h('button.text-button', { onclick: () => emit('use-as-input', asset) }, 'Use as input') : null,
        isImage ? h('button.text-button', { onclick: () => emit('add-to-canvas', asset) }, 'Add to canvas') : null,
        h('button.text-button', { onclick: () => downloadAsset(asset.path, asset.file) }, 'Download'),
        h('button.text-button.danger', { onclick: () => remove(asset) }, 'Delete')));
  }));
}

async function remove(asset) {
  if (!confirm('Delete this image? Canvas nodes and generations that use it will lose it.')) return;
  try {
    await api(`/api/assets/${asset.id}`, { method: 'DELETE' });
    emit('assets-changed');
  } catch (error) {
    toast(error.message, 'error');
  }
}

export function initLibrary() {
  $$('#library-filter button').forEach((button) => button.addEventListener('click', () => {
    filter = button.dataset.filter;
    $$('#library-filter button').forEach((b) => b.classList.toggle('selected', b === button));
    render().catch((error) => toast(error.message, 'error'));
  }));
  on('tab', (tab) => { if (tab === 'library') render().catch((error) => toast(error.message, 'error')); });
  on('project', () => { if (!$('#library-view').classList.contains('hidden')) render().catch((error) => toast(error.message, 'error')); });
}
