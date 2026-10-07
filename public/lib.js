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

// In-app replacement for window.prompt(), which the desktop app (Electron) does not support.
// Resolves with the entered text (trimmed), or null when cancelled. `multiline` gives a textarea; `optional` allows ''.
export function askText(title, { label = '', value = '', placeholder = '', multiline = false, optional = false, okLabel = 'OK' } = {}) {
  return new Promise((resolve) => {
    const field = h(multiline ? 'textarea' : 'input', { value, placeholder, rows: multiline ? 4 : undefined, type: multiline ? undefined : 'text', maxLength: 2000, 'aria-label': label || title });
    const error = h('small.error-text');
    const finish = (result) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    };
    const submit = () => {
      const text = field.value.trim();
      if (!text && !optional) {
        error.textContent = 'Type something first, or cancel.';
        return field.focus();
      }
      return finish(text);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); finish(null); }
      if (event.key === 'Enter' && (!multiline || event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); }
    };
    const overlay = h('div.modal-backdrop', { onclick: (event) => event.target === overlay && finish(null) },
      h('div.modal.ask-modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div.modal-head', {}, h('b', {}, title), h('button.ghost', { onclick: () => finish(null), 'aria-label': 'Cancel' }, '✕')),
        label ? h('label.field-label', {}, label) : null, field, error,
        h('div.ask-actions', {}, h('button.button.secondary.small', { onclick: () => finish(null) }, 'Cancel'), h('button.button.primary.small', { onclick: submit }, okLabel))));
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    field.focus();
    if (!multiline) field.select();
  });
}

// Pick one item from a list; resolves with the chosen item or null.
export function askChoice(title, items, { describe = String, okLabel = 'Choose' } = {}) {
  return new Promise((resolve) => {
    const select = h('select', { 'aria-label': title }, ...items.map((item, index) => h('option', { value: index }, describe(item))));
    const finish = (result) => { overlay.remove(); resolve(result); };
    const overlay = h('div.modal-backdrop', { onclick: (event) => event.target === overlay && finish(null) },
      h('div.modal.ask-modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div.modal-head', {}, h('b', {}, title), h('button.ghost', { onclick: () => finish(null), 'aria-label': 'Cancel' }, '✕')),
        select,
        h('div.ask-actions', {}, h('button.button.secondary.small', { onclick: () => finish(null) }, 'Cancel'),
          h('button.button.primary.small', { onclick: () => finish(items[Number(select.value)] ?? null) }, okLabel))));
    document.body.append(overlay);
    select.focus();
  });
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

export const state = { project: null, projects: [], catalog: null, detail: null, characters: [] };

export function modelsFor(operation) {
  return (state.catalog?.providers ?? []).flatMap((provider) => provider.models
    .filter((model) => model.operations.includes(operation))
    .map((model) => ({ provider, model, value: `${provider.id}|${model.id}` })));
}

// Cost of one job at the provider's list price: { usd } when it can be worked out, otherwise { text }.
export function estimateCost(model, { size, duration } = {}) {
  const price = model?.price;
  if (!price) return { usd: null, text: 'Price not listed' };
  if (price.usd == null) return { usd: null, text: price.text };
  if (price.per === 'second') return { usd: price.usd * (Number(duration) || 0), from: price.from };
  if (price.per === 'megapixel') {
    const [w, h] = String(size ?? '').split('x').map(Number);
    return w && h ? { usd: price.usd * w * h / 1e6 } : { usd: null, text: `$${price.usd} per megapixel` };
  }
  return { usd: price.usd };
}

export function formatUsd(usd, from = false) {
  if (usd === 0) return 'free';
  if (usd < 0.01) return 'under $0.01';
  return `${from ? 'from ' : ''}about $${usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

// Adds up several jobs; `unknown` counts the ones without a list price.
export function sumCosts(costs) {
  const known = costs.filter((c) => c.usd != null);
  return { usd: known.reduce((sum, c) => sum + c.usd, 0), unknown: costs.length - known.length, from: known.some((c) => c.from), count: costs.length };
}

export function describeTotal(total) {
  if (!total.count) return '';
  if (total.unknown === total.count) return 'price not listed for these models';
  return `${formatUsd(total.usd, total.from)}${total.unknown ? ` plus ${total.unknown} without a listed price` : ''}`;
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
    const items = [...detail.assets, ...references].filter((a) => a.mimeType.startsWith('image/') && !seen.has(a.id) && seen.add(a.id));
    if (!items.length) grid.append(h('p.muted', {}, 'No images yet. Upload one or generate an image first.'));
    for (const asset of items) {
      grid.append(h('button.picker-item', { onclick: () => close(asset), title: asset.label || asset.kind },
        h('img', { src: asset.path, alt: asset.label || '', loading: 'lazy' }), h('small', {}, asset.kind === 'reference' ? 'Reference' : 'Generated')));
    }
  });
}
