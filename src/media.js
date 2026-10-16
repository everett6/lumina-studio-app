import { lookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sniffMedia, imageSize } from './assets.js';
import { RequestError } from './generation.js';
import { privateAddress, safeFetch } from './safefetch.js';
import { encodePng } from './png.js';
import { inspectVideo, probe, run, runCapture } from './video.js';

const MB = 1024 * 1024;
export const mediaLimits = { image: 25 * MB, audio: 80 * MB, video: 300 * MB };
const aspects = { '16:9': [16, 9], '9:16': [9, 16], '1:1': [1, 1], '4:5': [4, 5] };
const invalid = (message) => { throw new RequestError(400, message); };
const finiteFraction = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
function checkSize(width, height) {
  if (![width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 16384) || width * height > 32_000_000) invalid('Media dimensions must be positive, at most 16384 per side and 32 million pixels.');
}
export function boxMask(width, height, box) {
  checkSize(width, height);
  if (!box || !['x', 'y', 'w', 'h'].every((k) => finiteFraction(box[k])) || box.w <= 0 || box.h <= 0 || box.x + box.w > 1 || box.y + box.h > 1) invalid('The mask box must fit inside the image: x, y, w, h are fractions from 0 to 1, with positive w/h.');
  const x0 = Math.floor(box.x * width), y0 = Math.floor(box.y * height);
  const x1 = Math.ceil((box.x + box.w) * width), y1 = Math.ceil((box.y + box.h) * height);
  return encodePng(width, height, (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1 ? [255, 255, 255] : [0, 0, 0]);
}

// Also handle IPv4-mapped IPv6 in hexadecimal form (URL normalisation produces this form).
function nonPublic(address) {
  const value = address.toLowerCase();
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
  if (mapped) {
    const a = parseInt(mapped[1], 16), b = parseInt(mapped[2], 16);
    return nonPublic(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`);
  }
  if (!isIP(address) || privateAddress(address)) return true;
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113);
  }
  return value.startsWith('::') || value.startsWith('fec') || value.startsWith('fed') || value.startsWith('fee') || value.startsWith('fef') || value.startsWith('2001:db8:');
}
export function validateMedia(bytes) {
  const mimeType = sniffMedia(bytes);
  if (!mimeType) invalid('Not a supported image, audio or video file. File type is checked from the bytes.');
  const type = mimeType.split('/')[0];
  if (bytes.length > mediaLimits[type]) invalid(`That ${type} is too large (limit ${mediaLimits[type] / MB} MB).`);
  return { mimeType, kind: type === 'image' ? 'reference' : type };
}

export function createMediaService({ repo, assetStore, enhancer, fetchImpl = safeFetch, lookupImpl = (host) => lookup(host, { all: true }) }) {
  const needAsset = (id, type) => {
    const asset = repo.assets.get(id);
    if (!asset) throw new RequestError(404, 'Asset not found.');
    if (type && !asset.mimeType?.startsWith(`${type}/`)) invalid(`Choose an ${type} asset.`);
    return asset;
  };
  // A refused paid call must be repeatable with the SAME input ids after approval. Keep
  // working masks/canvases across requests (and app restarts), rather than creating new ids.
  const preparing = new Map();
  const canonical = (value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => [k, canonical(value[k])])) : value;
  async function prepared(kind, id, options, make) {
    needAsset(id, 'image');
    const key = `media-prepared:${createHash('sha256').update(JSON.stringify([kind, id, canonical(options)])).digest('hex')}`;
    const cached = repo.settings.get(key, null);
    if (cached && repo.assets.get(cached.inputAssetId) && repo.assets.get(cached.maskAssetId)) return cached;
    if (preparing.has(key)) return preparing.get(key);
    const pending = make().then((result) => { repo.settings.set(key, result); return result; });
    preparing.set(key, pending);
    try { return await pending; } finally { preparing.delete(key); }
  }
  async function importBytes(projectId, bytes, label = 'Imported media') {
    const { kind } = validateMedia(bytes);
    return assetStore.save({ bytes, projectId, kind, label: String(label).slice(0, 120) });
  }
  async function importUrl(projectId, link, label) {
    let url;
    try { url = new URL(link); } catch { invalid('Pass a valid public HTTPS media URL.'); }
    const signal = AbortSignal.timeout(120_000);
    let response;
    for (let hop = 0; ; hop++) {
      if (url.protocol !== 'https:' || url.username || url.password) invalid('Media imports require HTTPS without URL credentials.');
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(host) ? [{ address: host }] : await lookupImpl(host).catch(() => []);
      if (!addresses.length || addresses.some(({ address }) => nonPublic(address))) invalid('Media imports require a public host; private addresses are refused.');
      response = await fetchImpl(url.href, { redirect: 'manual', signal, headers: { accept: 'image/*, audio/*, video/*' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (hop >= 5) invalid('The media URL redirects too many times.');
        const location = response.headers.get('location');
        if (!location) invalid('The media redirect has no destination.');
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new RequestError(502, `The media host returned HTTP ${response.status}.`); }
      break;
    }
    if (Number(response.headers.get('content-length')) > mediaLimits.video) { await response.body?.cancel(); invalid('Media exceeds the 300 MB size limit.'); }
    const reader = response.body?.getReader();
    if (!reader) invalid('The media response has no body.');
    const chunks = [];
    let size = 0, cap = mediaLimits.video, prefix = Buffer.alloc(0);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = Buffer.from(value);
        size += bytes.length;
        if (prefix.length < 32) prefix = Buffer.concat([prefix, bytes.subarray(0, 32 - prefix.length)]);
        const type = sniffMedia(prefix)?.split('/')[0];
        if (!type && prefix.length >= 16) invalid('Not a supported image, audio or video file. File type is checked from the bytes.');
        if (type) cap = mediaLimits[type];
        if (size > cap || (type && Number(response.headers.get('content-length')) > cap)) invalid(`Media is too large (limit ${cap / MB} MB for this type).`);
        chunks.push(bytes);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return importBytes(projectId, Buffer.concat(chunks), label);
  }
  async function temporary(fn) {
    const dir = await mkdtemp(path.join(tmpdir(), 'lumina-media-'));
    try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
  }
  const dimensions = async (asset) => {
    if (asset.mimeType.startsWith('image/')) {
      const size = imageSize((await assetStore.read(asset)).bytes);
      if (!size) invalid('Cannot read image dimensions.');
      checkSize(size.width, size.height);
      return size;
    }
    return probe(assetStore.path(asset));
  };
  async function reframe(id, { aspect, mode = 'crop', focusX = 0.5, focusY = 0.5 }) {
    const asset = needAsset(id);
    if (!['image', 'video'].some((type) => asset.mimeType.startsWith(`${type}/`))) invalid('Reframe requires an image or video.');
    if (!aspects[aspect] || !['crop', 'pad'].includes(mode)) invalid('Choose a supported aspect (16:9, 9:16, 1:1, 4:5) and crop or pad mode.');
    if (!finiteFraction(focusX) || !finiteFraction(focusY)) invalid('focusX and focusY must be fractions from 0 to 1.');
    const info = await dimensions(asset);
    const [a, b] = aspects[aspect];
    const video = asset.mimeType.startsWith('video/');
    // Integer multiples keep the requested aspect exact; video output must also be even for H.264.
    const unit = video ? 2 : 1;
    const factor = (mode === 'crop' ? Math.floor(Math.min(info.width / a, info.height / b) / unit) : Math.ceil(Math.max(info.width / a, info.height / b) / unit)) * unit;
    const width = a * factor, height = b * factor;
    checkSize(width, height);
    const x = Math.floor(Math.abs(info.width - width) * focusX), y = Math.floor(Math.abs(info.height - height) * focusY);
    const filter = mode === 'crop' ? `crop=${width}:${height}:${x}:${y}:exact=1` : `pad=${width}:${height}:${x}:${y}:color=black`;
    return temporary(async (dir) => {
      const out = path.join(dir, video ? 'reframed.mp4' : 'reframed.png');
      await run('ffmpeg', ['-v', 'error', '-i', assetStore.path(asset), '-map', '0:v:0', ...(video ? ['-map', '0:a?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart'] : ['-frames:v', '1']), '-vf', filter, '-threads', '1', '-y', out], 600_000);
      const saved = await assetStore.save({ bytes: await readFile(out), projectId: asset.projectId, kind: video ? 'video' : 'generation', label: `${asset.label ?? 'Media'} (${mode} ${aspect})`, parentAssetId: id });
      return { asset: saved, width, height };
    });
  }
  async function prepareMask(id, mask) {
    const asset = needAsset(id, 'image');
    const size = await dimensions(asset);
    if (typeof mask === 'string') {
      const saved = needAsset(mask, 'image');
      if (saved.projectId !== asset.projectId) invalid('The mask must belong to the same project.');
      const maskSize = await dimensions(saved);
      if (maskSize.width !== size.width || maskSize.height !== size.height) invalid('The mask dimensions must match the image.');
      return { projectId: asset.projectId, inputAssetId: id, maskAssetId: mask };
    }
    const saved = await assetStore.save({ bytes: boxMask(size.width, size.height, mask), projectId: asset.projectId, kind: 'mask', label: 'Inpaint mask', parentAssetId: id });
    return { projectId: asset.projectId, inputAssetId: id, maskAssetId: saved.id };
  }
  async function extend(id, { padding, direction = 'all', aspect, focusX = 0.5, focusY = 0.5 } = {}) {
    const asset = needAsset(id, 'image');
    const source = await dimensions(asset);
    if (!finiteFraction(focusX) || !finiteFraction(focusY)) invalid('focusX and focusY must be fractions from 0 to 1.');
    let p;
    if (padding !== undefined) {
      if (!padding || typeof padding !== 'object' || Array.isArray(padding)) invalid('Padding must be an object of pixel counts.');
      p = Object.fromEntries(['left', 'right', 'top', 'bottom'].map((k) => [k, padding[k] ?? 0]));
      if (Object.values(p).some((n) => !Number.isInteger(n) || n < 0 || n > 8192)) invalid('Padding must be whole pixel counts from 0 to 8192.');
    } else if (aspect) {
      if (!aspects[aspect]) invalid('Choose a supported aspect: 16:9, 9:16, 1:1, 4:5.');
      const [a, b] = aspects[aspect], factor = Math.ceil(Math.max(source.width / a, source.height / b));
      const dx = a * factor - source.width, dy = b * factor - source.height;
      const left = Math.floor(dx * focusX), top = Math.floor(dy * focusY);
      p = { left, right: dx - left, top, bottom: dy - top };
    } else {
      if (!['left', 'right', 'up', 'down', 'top', 'bottom', 'all', 'horizontal', 'vertical'].includes(direction)) invalid('Choose an extension direction or pixel padding.');
      const dx = Math.max(1, Math.round(source.width / 4)), dy = Math.max(1, Math.round(source.height / 4));
      p = { left: ['left', 'all', 'horizontal'].includes(direction) ? dx : 0, right: ['right', 'all', 'horizontal'].includes(direction) ? dx : 0,
        top: ['up', 'top', 'all', 'vertical'].includes(direction) ? dy : 0, bottom: ['down', 'bottom', 'all', 'vertical'].includes(direction) ? dy : 0 };
    }
    const width = source.width + p.left + p.right, height = source.height + p.top + p.bottom;
    checkSize(width, height);
    if (width === source.width && height === source.height) invalid('Outpainting requires some new canvas area. Choose padding or a wider/taller aspect.');
    return temporary(async (dir) => {
      const out = path.join(dir, 'canvas.png');
      await run('ffmpeg', ['-v', 'error', '-i', assetStore.path(asset), '-vf', `format=rgb24,pad=${width}:${height}:${p.left}:${p.top}:color=black`, '-frames:v', '1', '-threads', '1', '-y', out], 60_000);
      const canvas = await assetStore.save({ bytes: await readFile(out), projectId: asset.projectId, kind: 'mask', label: 'Outpaint working canvas', parentAssetId: id });
      try {
        const mask = await assetStore.save({ bytes: encodePng(width, height, (x, y) => x >= p.left && x < p.left + source.width && y >= p.top && y < p.top + source.height ? [0, 0, 0] : [255, 255, 255]), projectId: asset.projectId, kind: 'mask', label: 'Outpaint mask', parentAssetId: id });
        return { projectId: asset.projectId, inputAssetId: canvas.id, maskAssetId: mask.id, width, height, padding: p };
      } catch (error) { await assetStore.remove(canvas); throw error; }
    });
  }
  async function upscaleImage(id, options) {
    const asset = needAsset(id, 'image');
    if (!enhancer?.upscaleImage) throw new RequestError(501, 'Local Real-ESRGAN image upscaling is not installed.');
    const result = await enhancer.upscaleImage(assetStore.path(asset), options);
    const saved = await assetStore.save({ bytes: result.bytes, projectId: asset.projectId, kind: 'generation', label: `${asset.label ?? 'Image'} (${options.scale ?? 2}× upscale)`, parentAssetId: id });
    return { asset: saved, width: result.width, height: result.height };
  }
  async function analyze(id) {
    const asset = needAsset(id, 'video');
    const file = assetStore.path(asset), info = await probe(file);
    const { stderr } = await runCapture('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-map', '0:v:0', ...(info.hasAudio ? ['-map', '0:a:0', '-af', 'ebur128=peak=true'] : []),
      '-vf', 'scdet=threshold=10,blackdetect=d=0.3:pix_th=0.10,freezedetect=n=-50dB:d=0.5', '-f', 'null', '-'], 300_000);
    const sceneCuts = [...stderr.matchAll(/lavfi\.scd\.time:\s*([\d.]+)/g)].map((m) => ({ time: Number(m[1]) }));
    const black = [...stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)].map((m) => ({ start: +m[1], end: +m[2], duration: +m[3] }));
    const freezes = [];
    let start = null;
    for (const m of stderr.matchAll(/lavfi\.freezedetect\.freeze_(start|end):\s*([\d.]+)/g)) {
      if (m[1] === 'start') start = +m[2];
      else if (start !== null) { freezes.push({ start, end: +m[2], duration: +m[2] - start }); start = null; }
    }
    if (start !== null) freezes.push({ start, end: info.duration, duration: info.duration - start });
    const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
    const number = (regex) => { const n = Number(regex.exec(summary)?.[1]); return Number.isFinite(n) ? n : null; };
    const loudness = info.hasAudio ? { integratedLufs: number(/\bI:\s*(-?[\d.]+)\s*LUFS/), truePeakDbfs: number(/Peak:\s*(-?[\d.]+)\s*dBFS/) } : null;
    const last = Math.max(0, Math.min(info.duration, info.frames ? info.frames / info.fps : info.duration) - 1 / info.fps);
    const samples = await inspectVideo(file, [0, last / 3, last * 2 / 3, last]);
    return { assetId: id, ...info, sceneCuts, black, freezes, loudness, frames: samples.frames,
      note: 'Local heuristic analysis (scene threshold 10, freeze minimum 0.5s, black minimum 0.3s). Samples and detections require human review; they do not prove quality or sync.' };
  }
  return { needAsset, importBytes, importUrl, reframe,
    prepareMask: (id, mask) => prepared('mask', id, mask, () => prepareMask(id, mask)),
    extend: (id, options) => prepared('extend', id, options, () => extend(id, options)),
    upscaleImage, analyze };
}
