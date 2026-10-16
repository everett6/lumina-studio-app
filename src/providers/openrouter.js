import { ProviderError, assertResumable, downloadBytes, requestJson, requireKey, sleep, toDataUrl } from './http.js';

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
    video('kwaivgi/kling-v3.0-std', 'Kling 3.0 Standard', range(3, 15), ['16:9', '9:16', '1:1'], 'Cheaper Kling, up to 15 s, with sound'),
    video('bytedance/seedance-2.0', 'Seedance 2.0', range(4, 15), ['16:9', '9:16', '1:1'], 'Up to 15 s per clip, with sound'),
    video('bytedance/seedance-2.0-mini', 'Seedance 2.0 Mini', range(4, 15), ['16:9', '9:16', '1:1'], 'Lower-cost Seedance, up to 15 s, with sound'),
    // xAI Grok Imagine bills per second by resolution (480p is the cheapest); OpenRouter does not say whether it adds sound.
    video('x-ai/grok-imagine-video-1.5-lite', 'Grok Imagine 1.5 Lite', range(1, 15), ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'], 'Budget video; first frame supported'),
    video('x-ai/grok-imagine-video-1.5', 'Grok Imagine 1.5', range(1, 15), ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'], 'Higher quality Grok video; first frame supported'),
    video('x-ai/grok-imagine-video', 'Grok Imagine', range(1, 15), ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'], 'First-generation Grok video; first frame supported'),
    video('heygen/heygen-video-1', 'HeyGen Video', range(5, 15), ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], 'No sound; first frame supported'),
    video('alibaba/wan-2.7', 'Wan 2.7', range(2, 10), ['16:9', '9:16', '1:1'], 'With sound'),
    video('minimax/hailuo-3', 'Hailuo 3', range(5, 15), ['16:9', '9:16', '1:1'], 'Up to 15 s per clip, with sound'),
  ],
  async validateKey(key) {
    // GET /key describes the key itself, so a 401 means a bad key and success means it works.
    const body = await requestJson(`${api}/key`, { headers: headers(key), timeoutMs: 20_000 });
    const left = body?.data?.limit_remaining;
    return { ok: true, verified: true, message: left == null ? 'Key works.' : `Key works. Credit left on this key: $${Number(left).toFixed(2)}.` };
  },
  async run({ key, model, prompt, size, quality, images, seed, resumeJob, onSubmitting, onSubmitted, onRequestId, onCompleted }) {
    assertResumable(resumeJob, false);
    const body = { model, prompt, aspect_ratio: ratio[size] ?? '1:1', n: 1 };
    if (quality) body.quality = quality;
    if (Number.isInteger(seed)) body.seed = seed;
    if (images.length) body.input_references = images.map((img) => ({ type: 'image_url', image_url: { url: toDataUrl(img) } }));
    const result = await requestJson(`${api}/images`, { method: 'POST', onSubmitting, onSubmitted, onRequestId, headers: headers(key), body: JSON.stringify(body), timeoutMs: 300_000 });
    if (result.id) onSubmitted?.({ id: result.id, resumable: false });
    onCompleted?.({ usage: result.usage ?? null, resumable: false });
    const first = result?.data?.[0];
    if (!first?.b64_json) throw new ProviderError('provider', 'OpenRouter returned no image');
    return { bytes: Buffer.from(first.b64_json, 'base64'), usage: result.usage ?? null };
  },
  // Video jobs are asynchronous. `onSubmitted` receives the job id the moment OpenRouter accepts it (Lumina saves
  // it), and `resumeJob` continues polling a saved job after a restart instead of submitting (and paying) again.
  resumable: true,
  async video({ key, model, prompt, image: start, endImage = null, duration, aspect, resolution, seed, resumeJob = null, onSubmitting, onSubmitted, onRequestId, onCompleted, onDownloadFailed }) {
    const download = (url, usage) => downloadBytes(url, { timeoutMs: 300_000, headers: { authorization: `Bearer ${requireKey(key)}` }, onCompleted, onDownloadFailed, usage });
    if (resumeJob?.downloadUrl) return { bytes: await download(resumeJob.downloadUrl, resumeJob.usage), usage: resumeJob.usage ?? null };
    assertResumable(resumeJob, Boolean(resumeJob?.id));
    let job = resumeJob;
    if (!job?.id) {
      const body = { model, prompt, generate_audio: true };
      if (duration) body.duration = duration;
      if (aspect) body.aspect_ratio = aspect;
      // Always explicit: per-second prices differ several-fold between resolutions.
      if (resolution) body.resolution = resolution;
      // First and last frame: the clip starts on an approved still and (when the model supports it) ends exactly on
      // the next shot's approved still, which keeps characters and sets from drifting.
      const frames = [];
      if (start) frames.push({ type: 'image_url', image_url: { url: toDataUrl(start) }, frame_type: 'first_frame' });
      if (endImage) frames.push({ type: 'image_url', image_url: { url: toDataUrl(endImage) }, frame_type: 'last_frame' });
      if (frames.length) body.frame_images = frames;
      if (Number.isInteger(seed)) body.seed = seed;
      const submitted = await requestJson(`${api}/videos`, { method: 'POST', onSubmitting, onSubmitted, onRequestId, headers: headers(key), body: JSON.stringify(body), timeoutMs: 120_000 });
      if (!submitted?.id) throw new ProviderError('provider', 'OpenRouter did not start the video job');
      job = { id: String(submitted.id), pollUrl: submitted.polling_url, resumable: true };
      onSubmitted?.({ ...job, resumable: true });
    }
    const onOpenRouter = (url) => /^https:\/\/openrouter\.ai\//.test(String(url ?? ''));
    const poll = onOpenRouter(job.pollUrl) ? job.pollUrl : `${api}/videos/${encodeURIComponent(job.id)}`;
    const deadline = Date.now() + 20 * 60_000;
    for (;;) {
      await sleep(Number(process.env.LUMINA_OPENROUTER_POLL_MS ?? 5000));
      const status = await requestJson(poll, { headers: headers(key), timeoutMs: 60_000 });
      if (status.status === 'completed') {
        const listed = status.unsigned_urls?.[0];
        // The key only goes to OpenRouter's own content endpoint.
        const url = onOpenRouter(listed) ? listed : `${api}/videos/${encodeURIComponent(job.id)}/content?index=0`;
        return { bytes: await download(url, status.usage), usage: status.usage ?? null };
      }
      if (['failed', 'cancelled', 'expired'].includes(status.status)) {
        const reason = String(status.error ?? status.status);
        throw Object.assign(new ProviderError(/policy|safety|moderat/i.test(reason) ? 'policy' : 'provider', `OpenRouter video ${status.status}`, { detail: reason }), { usage: status.usage ?? null });
      }
      if (Date.now() > deadline) throw new ProviderError('timeout', 'OpenRouter video timed out');
    }
  },
};
