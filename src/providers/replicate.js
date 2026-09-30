import { ProviderError, downloadBytes, request, requestJson, requireKey, sleep, toDataUrl, aspectFor } from './http.js';

const base = 'https://api.replicate.com/v1';
const sizes = ['1024x1024', '1536x1024', '1024x1536'];

const inputs = {
  'black-forest-labs/flux-schnell': ({ prompt, size }) => ({ prompt, aspect_ratio: aspectFor(size), output_format: 'png', num_outputs: 1 }),
  'black-forest-labs/flux-1.1-pro': ({ prompt, size }) => ({ prompt, aspect_ratio: aspectFor(size), output_format: 'png' }),
  'black-forest-labs/flux-kontext-pro': ({ prompt, size, images }) => ({ prompt, input_image: toDataUrl(images[0]), aspect_ratio: aspectFor(size), output_format: 'png' }),
};

export default {
  id: 'replicate',
  label: 'Replicate',
  keyUrl: 'https://replicate.com/account/api-tokens',
  models: [
    { id: 'black-forest-labs/flux-schnell', label: 'FLUX schnell', operations: ['generate'], sizes, qualities: [], maxReferences: 0, note: 'Fast, low cost' },
    { id: 'black-forest-labs/flux-1.1-pro', label: 'FLUX 1.1 pro', operations: ['generate'], sizes, qualities: [], maxReferences: 0, note: 'High quality text-to-image' },
    { id: 'black-forest-labs/flux-kontext-pro', label: 'FLUX Kontext pro', operations: ['edit'], sizes, qualities: [], maxReferences: 1, note: 'Instruction-based editing' },
  ],
  async validateKey(key) {
    await request(`${base}/account`, { headers: { authorization: `Bearer ${key}` }, timeoutMs: 20_000 });
    return { ok: true, verified: true };
  },
  async run({ key, model, prompt, size, images }) {
    const headers = { authorization: `Bearer ${requireKey(key)}`, 'content-type': 'application/json' };
    const build = inputs[model];
    if (!build) throw new ProviderError('invalid_request', 'Unknown Replicate model', { detail: model });
    let prediction = await requestJson(`${base}/models/${model}/predictions`, {
      method: 'POST', headers: { ...headers, prefer: 'wait=60' }, body: JSON.stringify({ input: build({ prompt, size, images }) }), timeoutMs: 90_000,
    });
    const deadline = Date.now() + 300_000;
    while (['starting', 'processing'].includes(prediction.status)) {
      if (Date.now() > deadline) throw new ProviderError('timeout', 'Replicate prediction timed out');
      await sleep(1500);
      prediction = await requestJson(prediction.urls.get, { headers });
    }
    if (prediction.status !== 'succeeded' && prediction.status !== 'successful') {
      const detail = String(prediction.error ?? prediction.status);
      throw new ProviderError(/nsfw|safety|flagged/i.test(detail) ? 'policy' : 'provider', 'Replicate prediction failed', { detail });
    }
    const url = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    if (typeof url !== 'string') throw new ProviderError('provider', 'Replicate returned no image');
    return { bytes: await downloadBytes(url), usage: prediction.metrics ?? null };
  },
};
