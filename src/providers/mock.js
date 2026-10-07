import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { imageSize } from '../assets.js';
import { toneWav } from '../audio.js';
import { encodePng } from '../png.js';
import { ProviderError, sleep } from './http.js';

const sizes = ['1024x1024', '1536x1024', '1024x1536'];

// A tiny MP4 container header: enough for type sniffing and storage tests. It is not a playable video.
function fakeMp4(seed) {
  const box = Buffer.alloc(32);
  box.writeUInt32BE(32, 0);
  box.write('ftypisom', 4, 'latin1');
  seed.copy(box, 16, 0, 16);
  return box;
}

// With ffmpeg installed the mock makes a real one-second clip (a flat colour from the prompt), so players and
// stitching can be exercised offline. Without ffmpeg it falls back to the placeholder header.
async function colourClip(seed, aspect, seconds = 1) {
  const dir = await mkdtemp(path.join(tmpdir(), 'lumina-mock-'));
  const file = path.join(dir, 'clip.mp4');
  const colour = `0x${seed.subarray(0, 3).toString('hex')}`;
  try {
    await new Promise((resolve, reject) => execFile('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${colour}:s=${aspect === '9:16' ? '180x320' : '320x180'}:d=${seconds}:r=12`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', file], { timeout: 20_000 }, (error) => (error ? reject(error) : resolve())));
    return await readFile(file);
  } catch {
    return fakeMp4(seed);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function gradient(seed, w, h) {
  const a = [seed[0], seed[1], seed[2]];
  const b = [seed[3], seed[4], seed[5]];
  return encodePng(w, h, (x, y) => {
    const t = (x / w + y / h) / 2;
    const ring = Math.sin(Math.hypot(x - w / 2, y - h / 2) / (6 + (seed[6] % 10))) * 18;
    return a.map((v, i) => Math.max(0, Math.min(255, Math.round(v * (1 - t) + b[i] * t + ring))));
  });
}

// Offline stand-in for development and tests: deterministic gradient art derived from the prompt, a sine-tone
// "voice", and a placeholder video file. Prompts containing "[fail]" fail with a policy error.
export default {
  id: 'mock',
  label: 'Mock (offline test)',
  keyless: true,
  models: [
    { id: 'mock-image', label: 'Mock image', operations: ['generate', 'edit'], sizes, qualities: ['low', 'medium', 'high'], maxReferences: 4, note: 'Local test renderer, no network' },
    { id: 'mock-voice', label: 'Mock voice', operations: ['speech'], sizes: [], qualities: [], maxReferences: 0, voices: ['tone-low', 'tone-high'], note: 'Sine tone, length follows the text' },
    { id: 'mock-video', label: 'Mock video', operations: ['video'], sizes: [], qualities: [], maxReferences: 1, durations: [4, 8, 10], aspects: ['16:9', '9:16'], note: 'One-second colour clip (needs ffmpeg; otherwise a placeholder file)' },
    { id: 'mock-tools', label: 'Mock image tools', operations: ['upscale', 'remove-background', 'inpaint'], sizes: [], qualities: [], maxReferences: 1, scales: [2, 4], note: 'Local test renderer, no network' },
  ],
  async validateKey() {
    return { ok: true, verified: true };
  },
  async run({ prompt, size, images }) {
    if (prompt.includes('[fail]')) throw new ProviderError('policy', 'Mock failure requested');
    await sleep(Number(process.env.LUMINA_MOCK_DELAY_MS ?? 300));
    const seed = createHash('sha256').update(`${prompt}|${images.length}`).digest();
    const [w, h] = size.split('x').map((n) => Math.round(Number(n) / 4));
    return { bytes: gradient(seed, w, h), usage: { mock: true } };
  },
  // Tools return a new gradient at the size the real tool would: scaled for upscale, unchanged otherwise.
  async tool({ operation, image, mask, prompt, scale }) {
    if (prompt.includes('[fail]')) throw new ProviderError('policy', 'Mock failure requested');
    await sleep(Number(process.env.LUMINA_MOCK_DELAY_MS ?? 300));
    const { width, height } = imageSize(image.bytes) ?? { width: 256, height: 256 };
    const factor = operation === 'upscale' ? scale : 1;
    const seed = createHash('sha256').update(`${operation}|${prompt}|${image.bytes.length}|${mask?.bytes.length ?? 0}`).digest();
    return { bytes: gradient(seed, Math.min(4096, width * factor), Math.min(4096, height * factor)), usage: { mock: true } };
  },
  async speak({ text, voice }) {
    if (text.includes('[fail]')) throw new ProviderError('policy', 'Mock failure requested');
    await sleep(Number(process.env.LUMINA_MOCK_DELAY_MS ?? 300));
    return { bytes: toneWav(Math.min(30, 0.05 * text.length + 0.2), voice === 'tone-high' ? 660 : 330), usage: { mock: true } };
  },
  async video({ prompt, image, aspect, duration }) {
    if (prompt.includes('[fail]')) throw new ProviderError('policy', 'Mock failure requested');
    await sleep(Number(process.env.LUMINA_MOCK_DELAY_MS ?? 300));
    return { bytes: await colourClip(createHash('sha256').update(`${prompt}|${image ? 1 : 0}`).digest(), aspect, process.env.LUMINA_MOCK_FULL_CLIPS === '1' ? duration : 1), usage: { mock: true } };
  },
};
