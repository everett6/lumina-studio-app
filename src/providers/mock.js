import { createHash } from 'node:crypto';
import { encodePng } from '../png.js';
import { ProviderError, sleep } from './http.js';

const sizes = ['1024x1024', '1536x1024', '1024x1536'];

// Offline stand-in for development and tests: deterministic gradient art derived from the prompt.
// Prompts containing "[fail]" fail with a policy error so error paths can be exercised.
export default {
  id: 'mock',
  label: 'Mock (offline test)',
  keyless: true,
  models: [
    { id: 'mock-image', label: 'Mock image', operations: ['generate', 'edit'], sizes, qualities: ['low', 'medium', 'high'], maxReferences: 4, note: 'Local test renderer, no network' },
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
};
