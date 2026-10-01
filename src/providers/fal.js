import { ProviderError, downloadBytes, request, requestJson, requireKey, sleep, toDataUrl, aspectFor } from './http.js';

const queue = 'https://queue.fal.run';
const noImage = { sizes: [], qualities: [], maxReferences: 1 };
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

// Submit to fal's queue, poll until done, then fetch the result document.
async function queued({ key, model, input, timeoutMs }) {
  const headers = { authorization: `Key ${requireKey(key)}`, 'content-type': 'application/json' };
  const submitted = await requestJson(`${queue}/${model}`, { method: 'POST', headers, body: JSON.stringify(input) });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await requestJson(submitted.status_url, { headers });
    if (status.status === 'COMPLETED') break;
    if (Date.now() > deadline) throw new ProviderError('timeout', 'fal queue timed out');
    await sleep(timeoutMs > 300_000 ? 4000 : 1500);
  }
  return requestJson(submitted.response_url, { headers });
}

export default {
  id: 'fal',
  label: 'fal.ai',
  keyUrl: 'https://fal.ai/dashboard/keys',
  models: [
    { id: 'fal-ai/flux/schnell', label: 'FLUX.1 schnell', operations: ['generate'], sizes, qualities: [], maxReferences: 0, note: 'Very fast, low cost drafts' },
    { id: 'fal-ai/flux-pro/kontext', label: 'FLUX.1 Kontext pro', operations: ['edit'], sizes, qualities: [], maxReferences: 1, note: 'Instruction-based image editing' },
    { id: 'fal-ai/esrgan', label: 'Real-ESRGAN upscaler', operations: ['upscale'], ...noImage, scales: [2, 4], note: 'Sharpens and enlarges an image 2× or 4×' },
    { id: 'fal-ai/birefnet/v2', label: 'BiRefNet background removal', operations: ['remove-background'], ...noImage, note: 'Cuts out the subject on a transparent background' },
    { id: 'fal-ai/flux-pro/v1/fill', label: 'FLUX.1 Fill pro', operations: ['inpaint'], ...noImage, note: 'Repaints a masked area, or extends an image' },
    { id: 'fal-ai/kling-video/v3/pro/text-to-video', label: 'Kling 3 Pro (text to video)', operations: ['video'], sizes: [], qualities: [], maxReferences: 0, durations: [5, 10], aspects: ['16:9', '9:16', '1:1'], note: 'Text to video with audio' },
    { id: 'fal-ai/kling-video/v3/pro/image-to-video', label: 'Kling 3 Pro (image to video)', operations: ['video'], sizes: [], qualities: [], maxReferences: 1, requiresImage: true, durations: [5, 10], aspects: [], note: 'Animate a still image' },
  ],
  // Image tools. Each endpoint has its own input shape and returns either `image` or `images[0]`.
  async tool({ key, model, operation, image, mask, prompt, scale }) {
    const image_url = toDataUrl(image);
    const input = operation === 'upscale' ? { image_url, scale, output_format: 'png' }
      : operation === 'remove-background' ? { image_url, output_format: 'png' }
        : { image_url, mask_url: toDataUrl(mask), prompt, output_format: 'png' };
    const result = await queued({ key, model, input, timeoutMs: 300_000 });
    const url = result?.image?.url ?? result?.images?.[0]?.url;
    if (!url) throw new ProviderError(result?.has_nsfw_concepts?.[0] ? 'policy' : 'provider', 'fal returned no image');
    return { bytes: await downloadBytes(url), usage: null };
  },
  async video({ key, model, prompt, image, duration, aspect }) {
    const input = { prompt, duration, generate_audio: true };
    if (model.endsWith('image-to-video')) {
      if (!image) throw new ProviderError('invalid_request', 'This model needs a start image', { detail: 'Add an input image' });
      input.start_image_url = toDataUrl(image);
    } else if (aspect) {
      input.aspect_ratio = aspect;
    }
    const result = await queued({ key, model, input, timeoutMs: 900_000 });
    const url = result?.video?.url;
    if (!url) throw new ProviderError('provider', 'fal returned no video');
    return { bytes: await downloadBytes(url, { timeoutMs: 300_000 }), usage: null };
  },
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
    const build = inputs[model];
    if (!build) throw new ProviderError('invalid_request', 'Unknown fal model', { detail: model });
    const result = await queued({ key, model, input: build({ prompt, size, images }), timeoutMs: 300_000 });
    const url = result?.images?.[0]?.url;
    if (!url) throw new ProviderError(result?.has_nsfw_concepts?.[0] ? 'policy' : 'provider', 'fal returned no image');
    return { bytes: await downloadBytes(url), usage: null };
  },
};
