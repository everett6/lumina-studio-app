import { ProviderError, downloadBytes, request, requestJson, requireKey, sleep, toDataUrl, aspectFor } from './http.js';

const queue = 'https://queue.fal.run';
const sizes = ['1024x1024', '1536x1024', '1024x1536'];

// Each model maps Lumina's request onto that endpoint's own input schema.
const inputs = {
  'fal-ai/flux/schnell': ({ prompt, size }) => {
    const [width, height] = size.split('x').map(Number);
    return { prompt, image_size: { width, height }, num_images: 1, output_format: 'png' };
  },
  'fal-ai/flux-pro/kontext': ({ prompt, size, images }) => ({
    prompt, image_url: toDataUrl(images[0]), aspect_ratio: aspectFor(size), num_images: 1, output_format: 'png',
  }),
};

export default {
  id: 'fal',
  label: 'fal.ai',
  keyUrl: 'https://fal.ai/dashboard/keys',
  models: [
    { id: 'fal-ai/flux/schnell', label: 'FLUX.1 schnell', operations: ['generate'], sizes, qualities: [], maxReferences: 0, note: 'Very fast, low cost drafts' },
    { id: 'fal-ai/flux-pro/kontext', label: 'FLUX.1 Kontext pro', operations: ['edit'], sizes, qualities: [], maxReferences: 1, note: 'Instruction-based image editing' },
  ],
  // fal has no key-introspection endpoint; probing a non-existent request separates bad keys (401/403) from good ones (404).
  async validateKey(key) {
    try {
      await request(`${queue}/fal-ai/flux/schnell/requests/00000000-0000-0000-0000-000000000000/status`, { headers: { authorization: `Key ${key}` }, timeoutMs: 20_000 });
    } catch (error) {
      if (error.category === 'auth') throw error;
      return { ok: true, verified: false, message: 'Key accepted by fal; full access is confirmed on first generation.' };
    }
    return { ok: true, verified: false };
  },
  async run({ key, model, prompt, size, images }) {
    const headers = { authorization: `Key ${requireKey(key)}`, 'content-type': 'application/json' };
    const build = inputs[model];
    if (!build) throw new ProviderError('invalid_request', 'Unknown fal model', { detail: model });
    const submitted = await requestJson(`${queue}/${model}`, { method: 'POST', headers, body: JSON.stringify(build({ prompt, size, images })) });
    const deadline = Date.now() + 300_000;
    for (;;) {
      const status = await requestJson(submitted.status_url, { headers });
      if (status.status === 'COMPLETED') break;
      if (Date.now() > deadline) throw new ProviderError('timeout', 'fal queue timed out');
      await sleep(1500);
    }
    const result = await requestJson(submitted.response_url, { headers });
    const url = result?.images?.[0]?.url;
    if (!url) throw new ProviderError(result?.has_nsfw_concepts?.[0] ? 'policy' : 'provider', 'fal returned no image');
    return { bytes: await downloadBytes(url), usage: null };
  },
};
