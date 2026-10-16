import { ProviderError, assertResumable, downloadBytes, request, requestJson, requireKey, sleep, toDataUrl, aspectFor } from './http.js';

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
  resumable: true,
  async run({ key, model, prompt, size, images, resumeJob, onSubmitting, onSubmitted, onRequestId, onCompleted, onDownloadFailed }) {
    if (resumeJob?.downloadUrl) return { bytes: await downloadBytes(resumeJob.downloadUrl, { onCompleted, onDownloadFailed, usage: resumeJob.usage }), usage: resumeJob.usage ?? null };
    const headers = { authorization: `Bearer ${requireKey(key)}`, 'content-type': 'application/json' };
    const build = inputs[model];
    if (!build) throw new ProviderError('invalid_request', 'Unknown Replicate model', { detail: model });
    const onReplicate = (url) => /^https:\/\/api\.replicate\.com\/v1\/predictions\//.test(String(url ?? ''));
    assertResumable(resumeJob, onReplicate(resumeJob?.pollUrl));
    let prediction = resumeJob ? await requestJson(resumeJob.pollUrl, { headers }) : await requestJson(`${base}/models/${model}/predictions`, {
      method: 'POST', onSubmitting, onSubmitted, onRequestId, headers: { ...headers, prefer: 'wait=60' }, body: JSON.stringify({ input: build({ prompt, size, images }) }), timeoutMs: 90_000,
    });
    if (prediction.id || prediction.urls?.get) onSubmitted?.({ id: prediction.id ?? resumeJob?.id ?? null, pollUrl: prediction.urls?.get ?? resumeJob?.pollUrl, resumable: onReplicate(prediction.urls?.get ?? resumeJob?.pollUrl) });
    const deadline = Date.now() + 300_000;
    while (['starting', 'processing'].includes(prediction.status)) {
      if (Date.now() > deadline) throw new ProviderError('timeout', 'Replicate prediction timed out');
      await sleep(1500);
      const pollUrl = prediction.urls?.get ?? resumeJob?.pollUrl;
      if (!onReplicate(pollUrl)) throw new ProviderError('provider', 'Replicate returned an unexpected polling address');
      prediction = await requestJson(pollUrl, { headers });
    }
    if (prediction.status !== 'succeeded' && prediction.status !== 'successful') {
      const detail = String(prediction.error ?? prediction.status);
      throw new ProviderError(/nsfw|safety|flagged/i.test(detail) ? 'policy' : 'provider', 'Replicate prediction failed', { detail });
    }
    const url = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    if (typeof url !== 'string') throw new ProviderError('provider', 'Replicate returned no image');
    return { bytes: await downloadBytes(url, { onCompleted, onDownloadFailed, usage: prediction.metrics }), usage: prediction.metrics ?? null };
  },
};
