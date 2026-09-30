import { ProviderError, request, requestJson, requireKey, sleep, aspectFor } from './http.js';

const base = 'https://generativelanguage.googleapis.com/v1beta';
const sizes = ['1024x1024', '1536x1024', '1024x1536'];

// The Interactions API nests outputs under steps[].content[]; search rather than hard-code one path.
function findImage(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'image' && typeof node.data === 'string') return node;
  for (const value of Object.values(node)) {
    const found = findImage(value);
    if (found) return found;
  }
  return null;
}

export default {
  id: 'gemini',
  label: 'Google Gemini',
  keyUrl: 'https://aistudio.google.com/apikey',
  models: [
    { id: 'gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image', operations: ['generate', 'edit'], sizes, qualities: [], maxReferences: 3, note: 'Fast generation and multi-image edits' },
    { id: 'gemini-3-pro-image', label: 'Gemini 3 Pro Image', operations: ['generate', 'edit'], sizes, qualities: [], maxReferences: 3, note: 'Highest fidelity Gemini image model' },
    { id: 'gemini-3.1-flash-lite-image', label: 'Gemini 3.1 Flash Lite Image', operations: ['generate', 'edit'], sizes, qualities: [], maxReferences: 3, note: 'Lowest cost Gemini image model' },
  ],
  async validateKey(key) {
    await request(`${base}/models?pageSize=1`, { headers: { 'x-goog-api-key': key }, timeoutMs: 20_000 });
    return { ok: true, verified: true };
  },
  async run({ key, model, prompt, size, images }) {
    const headers = { 'x-goog-api-key': requireKey(key), 'content-type': 'application/json' };
    const input = [{ type: 'text', text: prompt }, ...images.map((image) => ({ type: 'image', mime_type: image.mime, data: image.bytes.toString('base64') }))];
    let interaction = await requestJson(`${base}/interactions`, {
      method: 'POST', headers, timeoutMs: 300_000,
      body: JSON.stringify({ model, input, response_format: { type: 'image', mime_type: 'image/png', aspect_ratio: aspectFor(size) } }),
    });
    const deadline = Date.now() + 300_000;
    while (['queued', 'in_progress'].includes(interaction?.status) && interaction.id) {
      if (Date.now() > deadline) throw new ProviderError('timeout', 'Gemini interaction timed out');
      await sleep(1500);
      interaction = await requestJson(`${base}/interactions/${interaction.id}`, { headers });
    }
    if (interaction?.status === 'failed' || interaction?.status === 'cancelled') {
      const detail = JSON.stringify(interaction.errors ?? interaction.error ?? '').slice(0, 300);
      throw new ProviderError(/safety|block|policy/i.test(detail) ? 'policy' : 'provider', 'Gemini interaction failed', { detail });
    }
    const image = findImage(interaction);
    if (!image) throw new ProviderError('policy', 'Gemini returned no image (often a safety refusal)');
    return { bytes: Buffer.from(image.data, 'base64'), usage: interaction.usage ?? null };
  },
};
