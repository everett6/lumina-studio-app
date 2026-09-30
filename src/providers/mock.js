import { createHash } from 'node:crypto';
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

// Offline stand-in for development and tests: deterministic gradient art derived from the prompt, a sine-tone
// "voice", and a placeholder video file. Prompts containing "[fail]" fail with a policy error.
export default {
  id: 'mock',
  label: 'Mock (offline test)',
  keyless: true,
  models: [
    { id: 'mock-image', label: 'Mock image', operations: ['generate', 'edit'], sizes, qualities: ['low', 'medium', 'high'], maxReferences: 4, note: 'Local test renderer, no network' },
    { id: 'mock-voice', label: 'Mock voice', operations: ['speech'], sizes: [], qualities: [], maxReferences: 0, voices: ['tone-low', 'tone-high'], note: 'Sine tone, length follows the text' },
    { id: 'mock-video', label: 'Mock video', operations: ['video'], sizes: [], qualities: [], maxReferences: 1, durations: [4, 8], aspects: ['16:9', '9:16'], note: 'Placeholder file (not playable)' },
  ],
  async validateKey() {
    return { ok: true, verified: true };
  },
  async run({ prompt, size, images }) {
    if (prompt.includes('[fail]')) throw new ProviderError('policy', 'Mock failure requested');
    await sleep(Number(process.env.LUMINA_MOCK_DELAY_MS ?? 300));
    const seed = createHash('sha256').update(`${prompt}|${images.length}`).digest();
    const [w, h] = size.split('x').map((n) => Math.round(Number(n) / 4));
    const a = [seed[0], seed[1], seed[2]];
    const b = [seed[3], seed[4], seed[5]];
    const bytes = encodePng(w, h, (x, y) => {
      const t = (x / w + y / h) / 2;
      const ring = Math.sin(Math.hypot(x - w / 2, y - h / 2) / (6 + (seed[6] % 10))) * 18;
      return a.map((v, i) => Math.max(0, Math.min(255, Math.round(v * (1 - t) + b[i] * t + ring))));
    });
    return { bytes, usage: { mock: true } };
  },
  async speak({ text, voice }) {
    if (text.includes('[fail]')) throw new ProviderError('policy', 'Mock failure requested');
    await sleep(Number(process.env.LUMINA_MOCK_DELAY_MS ?? 300));
    return { bytes: toneWav(Math.min(30, 0.05 * text.length + 0.2), voice === 'tone-high' ? 660 : 330), usage: { mock: true } };
  },
  async video({ prompt, image }) {
    if (prompt.includes('[fail]')) throw new ProviderError('policy', 'Mock failure requested');
    await sleep(Number(process.env.LUMINA_MOCK_DELAY_MS ?? 300));
    return { bytes: fakeMp4(createHash('sha256').update(`${prompt}|${image ? 1 : 0}`).digest()), usage: { mock: true } };
  },
};
