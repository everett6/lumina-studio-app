export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Build an element: h('button.primary', { onclick }, 'Label', child, ...)
export function h(tag, props = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const node = document.createElement(name || 'div');
  if (classes.length) node.className = classes.join(' ');
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

let toastTimer;
export function toast(message, tone = 'info') {
  const node = $('#toast');
  node.textContent = message;
  node.dataset.tone = tone;
  node.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), 4200);
}

export async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: response.status, data });
  return data;
}

export function readImageFile(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
    return Promise.reject(new Error('Choose a PNG, JPEG or WebP image under 8 MB.'));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read this image.'));
    reader.readAsDataURL(file);
  });
}

export async function uploadReference(projectId, file) {
  const dataUrl = await readImageFile(file);
  return (await api('/api/assets', { method: 'POST', body: { projectId, dataUrl, label: file.name } })).asset;
}

export function downloadAsset(path, name) {
  const link = h('a', { href: path, download: name });
  document.body.append(link);
  link.click();
  link.remove();
}

// Tiny shared store: modules subscribe to named events instead of reaching into each other.
export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const on = (type, fn) => bus.addEventListener(type, (event) => fn(event.detail));

export const state = { project: null, projects: [], catalog: null, detail: null };

export function modelsFor(operation) {
  return (state.catalog?.providers ?? []).flatMap((provider) => provider.models
    .filter((model) => model.operations.includes(operation))
    .map((model) => ({ provider, model, value: `${provider.id}|${model.id}` })));
}

// A modal that resolves with the chosen asset (or null). Shows project images, library references and upload.
export function pickAsset({ title = 'Choose an image' } = {}) {
  return new Promise(async (resolve) => {
    const close = (value) => { overlay.remove(); resolve(value); };
    const grid = h('div.picker-grid');
    const upload = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true, onchange: async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try { close(await uploadReference(state.project.id, file)); } catch (error) { toast(error.message, 'error'); }
    } });
    const overlay = h('div.modal-backdrop', { onclick: (event) => event.target === overlay && close(null) },
      h('div.modal', { role: 'dialog', 'aria-label': title },
        h('div.modal-head', {}, h('b', {}, title), h('button.ghost', { onclick: () => close(null), 'aria-label': 'Close' }, '✕')),
        h('div.modal-actions', {}, h('label.button.secondary', {}, 'Upload image', upload)),
        grid));
    document.body.append(overlay);
    const [{ assets: references }, detail] = await Promise.all([api('/api/assets?kind=reference'), api(`/api/projects/${state.project.id}`)]);
    const seen = new Set();
    const items = [...detail.assets, ...references].filter((a) => !seen.has(a.id) && seen.add(a.id));
    if (!items.length) grid.append(h('p.muted', {}, 'No images yet. Upload one or generate an image first.'));
    for (const asset of items) {
      grid.append(h('button.picker-item', { onclick: () => close(asset), title: asset.label || asset.kind },
        h('img', { src: asset.path, alt: asset.label || '', loading: 'lazy' }), h('small', {}, asset.kind === 'reference' ? 'Reference' : 'Generated')));
    }
  });
}
