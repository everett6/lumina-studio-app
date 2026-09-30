import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const imageTypes = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp']]);
export const maxUploadBytes = 8 * 1024 * 1024;
const maxOutputBytes = 30 * 1024 * 1024;

// Trust the bytes, not the label a provider or browser attached to them.
export function sniffImage(bytes) {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length > 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

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
      const mimeType = sniffImage(bytes);
      if (!mimeType) throw new Error('Output is not a PNG, JPEG or WebP image.');
      if (bytes.length > maxOutputBytes) throw new Error('Image exceeded the storage limit.');
      const file = `${randomUUID()}.${imageTypes.get(mimeType)}`;
      await writeFile(path.join(assetDir, file), bytes, { flag: 'wx' });
      return repo.assets.create({ projectId, kind, mimeType, file, size: bytes.length, label, generationId, parentAssetId });
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
