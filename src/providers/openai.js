import { ProviderError, request, requestJson, requireKey } from './http.js';

const sizes = ['1024x1024', '1536x1024', '1024x1536'];
const base = 'https://api.openai.com/v1';

export default {
  id: 'openai',
  label: 'OpenAI',
  keyUrl: 'https://platform.openai.com/api-keys',
  models: [
    { id: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare', operations: ['generate', 'edit'], sizes, qualities: ['low', 'medium', 'high'], maxReferences: 4, note: 'Fast everyday generation and edits' },
    { id: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst', operations: ['generate', 'edit'], sizes, qualities: ['low', 'medium', 'high'], maxReferences: 4, note: 'Most capable; slower and higher cost' },
  ],
  async validateKey(key) {
    await request(`${base}/models`, { headers: { authorization: `Bearer ${key}` }, timeoutMs: 20_000 });
    return { ok: true, verified: true };
  },
  async run({ key, model, prompt, size, quality, images }) {
    const auth = { authorization: `Bearer ${requireKey(key)}` };
    let body;
    if (images.length) {
      const form = new FormData();
      form.set('model', model);
      form.set('prompt', prompt);
      form.set('size', size);
      form.set('quality', quality);
      images.forEach((image, index) => form.append('image[]', new Blob([image.bytes], { type: image.mime }), `input-${index}.${image.mime.split('/')[1]}`));
      body = await requestJson(`${base}/images/edits`, { method: 'POST', headers: auth, body: form, timeoutMs: 300_000 });
    } else {
      body = await requestJson(`${base}/images/generations`, {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt, size, quality, n: 1 }), timeoutMs: 300_000,
      });
    }
    const b64 = body?.data?.[0]?.b64_json;
    if (!b64) throw new ProviderError('provider', 'OpenAI returned no image data');
    return { bytes: Buffer.from(b64, 'base64'), usage: body.usage ?? null };
  },
};
