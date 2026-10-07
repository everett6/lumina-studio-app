import { ProviderError, downloadBytes, requestJson, requireKey, sleep, toDataUrl } from './http.js';

// OpenRouter: one key for many image, video and text models.
// Images: POST /api/v1/images (base64 in data[].b64_json). Video: POST /api/v1/videos, poll the job, download
// unsigned_urls[0] with the same key. Model ids and capabilities were read from /api/v1/images/models and
// /api/v1/videos/models on 2026-10-06.
const api = 'https://openrouter.ai/api/v1';
const sizes = ['1024x1024', '1536x1024', '1024x1536'];
const ratio = { '1024x1024': '1:1', '1536x1024': '3:2', '1024x1536': '2:3' };
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const image = (id, label, note, extra = {}) => ({ id, label, operations: ['generate', 'edit'], sizes, qualities: [], maxReferences: 4, note, ...extra });
const video = (id, label, durations, aspects, note) => ({ id, label, operations: ['video'], sizes: [], qualities: [], maxReferences: 1, durations, aspects, note });

const headers = (key) => ({
  authorization: `Bearer ${requireKey(key)}`, 'content-type': 'application/json',
  // Optional attribution headers OpenRouter documents for app listings.
  'http-referer': 'https://github.com/everett6/lumina-studio-app', 'x-title': 'Lumina Studio',
});

export default {
  id: 'openrouter',
  label: 'OpenRouter',
  keyUrl: 'https://openrouter.ai/settings/keys',
  models: [
    image('google/gemini-3.1-flash-image', 'Nano Banana 2 (Gemini 3.1 Flash Image)', 'Fast generation and editing'),
    image('google/gemini-3-pro-image', 'Nano Banana Pro (Gemini 3 Pro Image)', 'Highest quality Gemini images'),
    image('openai/gpt-image-2', 'GPT Image 2', 'Strong text rendering and edits', { qualities: ['low', 'medium', 'high'] }),
    image('black-forest-labs/flux.2-pro', 'FLUX.2 Pro', 'Photoreal, consistent characters'),
    image('bytedance-seed/seedream-4.5', 'Seedream 4.5', 'Detailed images, good editing consistency'),
    video('google/veo-3.1-fast', 'Veo 3.1 Fast', [4, 6, 8], ['16:9', '9:16'], 'Video with sound; start frame optional'),
    video('google/veo-3.1', 'Veo 3.1', [4, 6, 8], ['16:9', '9:16'], 'Top-quality video with sound'),
    video('kwaivgi/kling-v3.0-pro', 'Kling 3.0 Pro', range(3, 15), ['16:9', '9:16', '1:1'], 'Up to 15 s per clip, with sound'),
    video('bytedance/seedance-2.0', 'Seedance 2.0', range(4, 15), ['16:9', '9:16', '1:1'], 'Up to 15 s per clip, with sound'),
    video('alibaba/wan-2.7', 'Wan 2.7', range(2, 10), ['16:9', '9:16', '1:1'], 'Lower cost, with sound'),
    video('minimax/hailuo-3', 'Hailuo 3', range(5, 15), ['16:9', '9:16', '1:1'], 'Up to 15 s per clip, with sound'),
  ],
  async validateKey(key) {
    // GET /key describes the key itself, so a 401 means a bad key and success means it works.
    const body = await requestJson(`${api}/key`, { headers: headers(key), timeoutMs: 20_000 });
    const left = body?.data?.limit_remaining;
    return { ok: true, verified: true, message: left == null ? 'Key works.' : `Key works. Credit left on this key: $${Number(left).toFixed(2)}.` };
  },
  async run({ key, model, prompt, size, quality, images }) {
    const body = { model, prompt, aspect_ratio: ratio[size] ?? '1:1', n: 1 };
    if (quality) body.quality = quality;
    if (images.length) body.input_references = images.map((img) => ({ type: 'image_url', image_url: { url: toDataUrl(img) } }));
    const result = await requestJson(`${api}/images`, { method: 'POST', headers: headers(key), body: JSON.stringify(body), timeoutMs: 300_000 });
    const first = result?.data?.[0];
    if (!first?.b64_json) throw new ProviderError('provider', 'OpenRouter returned no image');
    return { bytes: Buffer.from(first.b64_json, 'base64'), usage: result.usage ?? null };
  },
  async video({ key, model, prompt, image: start, duration, aspect }) {
    const body = { model, prompt, generate_audio: true };
    if (duration) body.duration = duration;
    if (aspect) body.aspect_ratio = aspect;
    if (start) body.frame_images = [{ type: 'image_url', image_url: { url: toDataUrl(start) }, frame_type: 'first_frame' }];
    const job = await requestJson(`${api}/videos`, { method: 'POST', headers: headers(key), body: JSON.stringify(body), timeoutMs: 120_000 });
    if (!job?.id) throw new ProviderError('provider', 'OpenRouter did not start the video job');
    const poll = job.polling_url && /^https:\/\/openrouter\.ai\//.test(job.polling_url) ? job.polling_url : `${api}/videos/${encodeURIComponent(job.id)}`;
    const deadline = Date.now() + 20 * 60_000;
    for (;;) {
      await sleep(Number(process.env.LUMINA_OPENROUTER_POLL_MS ?? 5000));
      const status = await requestJson(poll, { headers: headers(key), timeoutMs: 60_000 });
      if (status.status === 'completed') {
        const url = status.unsigned_urls?.[0] ?? `${api}/videos/${encodeURIComponent(job.id)}/content?index=0`;
        return { bytes: await downloadBytes(url, { timeoutMs: 300_000, headers: { authorization: `Bearer ${key}` } }), usage: status.usage ?? null };
      }
      if (['failed', 'cancelled', 'expired'].includes(status.status)) {
        const reason = String(status.error ?? status.status);
        throw new ProviderError(/policy|safety|moderat/i.test(reason) ? 'policy' : 'provider', `OpenRouter video ${status.status}`, { detail: reason });
      }
      if (Date.now() > deadline) throw new ProviderError('timeout', 'OpenRouter video timed out');
    }
  },
};
