import { api, emit, h, modelsFor, state, toast } from './lib.js';

// Image tools (upscale, background removal, inpaint, extend). Each one queues a normal generation, so results
// show up in Create's history and in the library.
const guard = (fn) => async (...args) => {
  try { await fn(...args); } catch (error) { toast(error.message, 'error'); }
};

const toolNames = { upscale: 'upscaling', 'remove-background': 'background removal', inpaint: 'inpainting' };

function toolModel(operation) {
  const option = modelsFor(operation).find((o) => o.provider.ready);
  if (!option) toast(`Add a fal.ai key in Settings to use ${toolNames[operation]}.`, 'error');
  return option;
}

async function start(operation, asset, extra = {}) {
  const option = toolModel(operation);
  if (!option) return;
  const { generation } = await api('/api/generate', { method: 'POST', body: {
    projectId: state.project.id, operation, provider: option.provider.id, model: option.model.id, inputAssetIds: [asset.id], ...extra,
  } });
  emit('generation-started', generation);
}

const uploadWorkingImage = async (dataUrl) => (await api('/api/assets', { method: 'POST', body: { projectId: state.project.id, dataUrl, kind: 'mask' } })).asset;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load this image.'));
    image.src = src;
  });
}

function modal(title, ...children) {
  const close = () => overlay.remove();
  const overlay = h('div.modal-backdrop', { onclick: (event) => event.target === overlay && close() },
    h('div.modal.tool-modal', { role: 'dialog', 'aria-label': title },
      h('div.modal-head', {}, h('b', {}, title), h('button.ghost', { onclick: close, 'aria-label': 'Close' }, '✕')), ...children));
  document.body.append(overlay);
  return close;
}

// Paint over the part to change; the mask is white where painted and black elsewhere, at the image's own size.
async function openInpaint(asset) {
  if (!toolModel('inpaint')) return;
  const image = await loadImage(asset.path);
  const canvas = h('canvas.mask-canvas', { width: image.naturalWidth, height: image.naturalHeight });
  const ctx = canvas.getContext('2d');
  let painted = false;
  let last = null;
  const brush = h('input', { type: 'range', min: 2, max: 30, value: 8, 'aria-label': 'Brush size' });
  const point = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height };
  };
  const stroke = (from, to) => {
    ctx.strokeStyle = '#d4f579';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(canvas.width, canvas.height) * Number(brush.value) / 100;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    painted = true;
  };
  canvas.addEventListener('pointerdown', (event) => { canvas.setPointerCapture(event.pointerId); last = point(event); stroke(last, last); });
  canvas.addEventListener('pointermove', (event) => { if (!last) return; const next = point(event); stroke(last, next); last = next; });
  for (const type of ['pointerup', 'pointercancel']) canvas.addEventListener(type, () => { last = null; });
  const prompt = h('textarea', { rows: 2, maxLength: 2000, placeholder: 'What should appear in the painted area? e.g. “a red wooden door”', 'aria-label': 'Inpaint prompt' });
  const go = h('button.button.primary', { onclick: guard(async () => {
    if (!painted) return toast('Paint over the area you want to change.');
    if (!prompt.value.trim()) { prompt.focus(); return toast('Describe what should appear there.'); }
    go.disabled = true;
    try {
      const out = h('canvas', { width: canvas.width, height: canvas.height });
      const octx = out.getContext('2d');
      octx.drawImage(canvas, 0, 0);
      octx.globalCompositeOperation = 'source-in';
      octx.fillStyle = '#fff';
      octx.fillRect(0, 0, out.width, out.height);
      octx.globalCompositeOperation = 'destination-over';
      octx.fillStyle = '#000';
      octx.fillRect(0, 0, out.width, out.height);
      const mask = await uploadWorkingImage(out.toDataURL('image/png'));
      await start('inpaint', asset, { maskAssetId: mask.id, prompt: prompt.value.trim() });
      close();
    } finally {
      go.disabled = false;
    }
    return undefined;
  }) }, 'Inpaint');
  const close = modal('Inpaint: paint the area to change',
    h('div.mask-stage', {}, h('img', { src: asset.path, alt: 'Image to edit' }), canvas),
    h('div.key-row', {}, h('span.field-label', {}, 'BRUSH'), brush,
      h('button.text-button', { onclick: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); painted = false; } }, 'Clear')),
    prompt, h('div.modal-actions', {}, go));
}

const shapes = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '21:9': 21 / 9 };

// Extend = inpaint on a larger canvas: the original sits in the middle and the new border is the masked area.
async function openExtend(asset) {
  if (!toolModel('inpaint')) return;
  const image = await loadImage(asset.path);
  const [w, h0] = [image.naturalWidth, image.naturalHeight];
  const shape = h('select', { 'aria-label': 'New shape' }, ...Object.keys(shapes).map((key) => h('option', { value: key }, key)));
  shape.value = w >= h0 ? '9:16' : '16:9';
  const prompt = h('textarea', { rows: 2, maxLength: 2000, placeholder: 'Optional: what should fill the new space?', 'aria-label': 'Extend prompt' });
  const go = h('button.button.primary', { onclick: guard(async () => {
    const ratio = shapes[shape.value];
    const [width, height] = ratio > w / h0 ? [Math.round(h0 * ratio), h0] : [w, Math.round(w / ratio)];
    if (width - w < 16 && height - h0 < 16) return toast('The image already has that shape.');
    if (Math.max(width, height) > 4096) return toast('That would be too large. Try a closer shape.');
    go.disabled = true;
    try {
      const [x, y] = [Math.round((width - w) / 2), Math.round((height - h0) / 2)];
      const padded = h('canvas', { width, height });
      const pctx = padded.getContext('2d');
      pctx.fillStyle = '#808080';
      pctx.fillRect(0, 0, width, height);
      pctx.drawImage(image, x, y);
      const mask = h('canvas', { width, height });
      const mctx = mask.getContext('2d');
      mctx.fillStyle = '#fff';
      mctx.fillRect(0, 0, width, height);
      mctx.fillStyle = '#000';
      // Overlap the original by a few pixels so the seam is repainted.
      mctx.fillRect(x + (x ? 8 : 0), y + (y ? 8 : 0), w - (x ? 16 : 0), h0 - (y ? 16 : 0));
      let dataUrl = padded.toDataURL('image/png');
      if (dataUrl.length > 10_000_000) dataUrl = padded.toDataURL('image/jpeg', 0.93);
      const [source, maskAsset] = await Promise.all([uploadWorkingImage(dataUrl), uploadWorkingImage(mask.toDataURL('image/png'))]);
      await start('inpaint', source, {
        maskAssetId: maskAsset.id,
        prompt: prompt.value.trim() || 'Extend the scene naturally beyond the original frame, matching its style, lighting and perspective.',
      });
      close();
    } finally {
      go.disabled = false;
    }
    return undefined;
  }) }, 'Extend');
  const close = modal('Extend: change the shape and fill the new space',
    h('p.muted', {}, `This image is ${w} × ${h0}. Choose the shape it should become; the original stays in the middle.`),
    h('div.key-row', {}, h('span.field-label', {}, 'NEW SHAPE'), shape), prompt, h('div.modal-actions', {}, go));
}

// A small "Tools" menu for one image asset.
export function toolMenu(asset) {
  const menu = h('details.tool-menu');
  const item = (label, fn) => h('button', { onclick: guard(async () => { menu.open = false; await fn(); }) }, label);
  const scales = modelsFor('upscale').find((o) => o.provider.ready)?.model.scales ?? [2, 4];
  menu.append(h('summary.button.secondary.small', {}, 'Tools ▾'), h('div.tool-menu-list', {},
    ...scales.map((scale) => item(`Upscale ${scale}×`, () => start('upscale', asset, { scale }))),
    item('Remove background', () => start('remove-background', asset)),
    item('Inpaint…', () => openInpaint(asset)),
    item('Extend…', () => openExtend(asset))));
  return menu;
}
