import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const imageTypes = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp']]);
const mediaTypes = new Map([...imageTypes, ['audio/mpeg', 'mp3'], ['audio/wav', 'wav'], ['video/mp4', 'mp4']]);
export const maxUploadBytes = 8 * 1024 * 1024;
const maxOutputBytes = 400 * 1024 * 1024;

// Trust the bytes, not the label a provider or browser attached to them.
export function sniffImage(bytes) {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length > 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function sniffMedia(bytes) {
  const image = sniffImage(bytes);
  if (image) return image;
  if (bytes.length > 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WAVE') return 'audio/wav';
  if (bytes.length > 3 && (bytes.toString('latin1', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) return 'audio/mpeg';
  if (bytes.length > 12 && bytes.toString('latin1', 4, 8) === 'ftyp') return 'video/mp4';
  return null;
}

// Pixel size of a PNG/JPEG/WebP, for layout math in exports. Returns null when unknown.
export function imageSize(bytes) {
  const mime = sniffImage(bytes);
  if (mime === 'image/png') return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (mime === 'image/jpeg') {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      const length = bytes.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  if (mime === 'image/webp') {
    const format = bytes.toString('latin1', 12, 16);
    if (format === 'VP8X') return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (format === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (format === 'VP8L') {
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

export const kindForMime = (mime) => (mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : null);

export function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > maxUploadBytes || sniffImage(bytes) !== match[1]) return null;
  return { mime: match[1], bytes };
}

export function createAssetStore({ assetDir, repo }) {
  mkdirSync(assetDir, { recursive: true });
  const fileFor = (asset) => path.join(assetDir, path.basename(asset.file));

  return {
    dir: assetDir,
    async save({ bytes, projectId, kind, label, generationId, parentAssetId }) {
      const mimeType = sniffMedia(bytes);
      if (!mimeType) throw new Error('Output is not a supported image, audio or video file.');
      if (bytes.length > maxOutputBytes) throw new Error('Output exceeded the storage limit.');
      const file = `${randomUUID()}.${mediaTypes.get(mimeType)}`;
      await writeFile(path.join(assetDir, file), bytes, { flag: 'wx' });
      return repo.assets.create({ projectId, kind: kindForMime(mimeType) ?? kind, mimeType, file, size: bytes.length, label, generationId, parentAssetId });
    },
    async read(asset) {
      return { mime: asset.mimeType, bytes: await readFile(fileFor(asset)) };
    },
    async remove(asset) {
      repo.assets.remove(asset.id);
      await unlink(fileFor(asset)).catch(() => {});
    },
    path: fileFor,
  };
}
