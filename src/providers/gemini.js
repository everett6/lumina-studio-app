import { joinAudio, splitForSpeech } from '../audio.js';
import { ProviderError, downloadBytes, request, requestJson, requireKey, sleep, aspectFor } from './http.js';

const base = 'https://generativelanguage.googleapis.com/v1beta';
const sizes = ['1024x1024', '1536x1024', '1024x1536'];
const voices = ['Kore', 'Zephyr', 'Puck', 'Charon', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel',
  'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird',
  'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'];

// The Interactions API nests outputs under steps[].content[]; search rather than hard-code one path.
export function findPart(node, match) {
  if (!node || typeof node !== 'object') return null;
  if (typeof node.data === 'string' && match(node)) return node;
  for (const value of Object.values(node)) {
    const found = findPart(value, match);
    if (found) return found;
  }
  return null;
}
const findImage = (node) => findPart(node, (part) => part.type === 'image');

export default {
  id: 'gemini',
  label: 'Google Gemini',
  keyUrl: 'https://aistudio.google.com/apikey',
  models: [
    { id: 'gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image', operations: ['generate', 'edit'], sizes, qualities: [], maxReferences: 3, note: 'Fast generation and multi-image edits' },
    { id: 'gemini-3-pro-image', label: 'Gemini 3 Pro Image', operations: ['generate', 'edit'], sizes, qualities: [], maxReferences: 3, note: 'Highest fidelity Gemini image model' },
    { id: 'gemini-3.1-flash-lite-image', label: 'Gemini 3.1 Flash Lite Image', operations: ['generate', 'edit'], sizes, qualities: [], maxReferences: 3, note: 'Lowest cost Gemini image model' },
    { id: 'gemini-3.8-flash-tts', label: 'Gemini 3.8 Flash TTS', operations: ['speech'], sizes: [], qualities: [], maxReferences: 0, voices, note: 'Expressive narration (WAV)' },
    { id: 'gemini-3.8-flash-lite-tts', label: 'Gemini 3.8 Flash Lite TTS', operations: ['speech'], sizes: [], qualities: [], maxReferences: 0, voices, note: 'Lower cost narration (WAV)' },
    ...['veo-3.1-generate-preview', 'veo-3.1-fast-generate-preview', 'veo-3.1-lite-generate-preview'].map((id) => ({
      id, label: id.replace('veo-3.1', 'Veo 3.1').replace('-generate-preview', '').replace('-fast', ' Fast').replace('-lite', ' Lite'),
      operations: ['video'], sizes: [], qualities: [], maxReferences: 1, durations: [8, 6, 4], aspects: ['16:9', '9:16'],
      note: 'Video with native audio; optional start image',
    })),
  ],
  async speak({ key, model, text, voice, style }) {
    const headers = { 'x-goog-api-key': requireKey(key), 'content-type': 'application/json' };
    const clips = [];
    for (const chunk of splitForSpeech(text, 3800)) {
      const content = { type: 'text', text: chunk, ...(style ? { annotations: [{ type: 'speech_metadata', style }] } : {}) };
      const interaction = await requestJson(`${base}/interactions`, {
        method: 'POST', headers, timeoutMs: 300_000,
        body: JSON.stringify({
          model, input: [{ type: 'user_input', content: [content] }], response_format: { type: 'audio' },
          generation_config: { speech_config: [{ voice: voices.includes(voice) ? voice : 'Kore' }] },
        }),
      });
      const audio = findPart(interaction, (node) => node.type === 'audio' || /^audio\//.test(node.mime_type ?? ''));
      if (!audio) throw new ProviderError('provider', 'Gemini returned no audio');
      clips.push(Buffer.from(audio.data, 'base64'));
    }
    return { bytes: joinAudio(clips, 'audio/wav'), usage: { characters: text.length } };
  },
  async video({ key, model, prompt, image, duration, aspect }) {
    const headers = { 'x-goog-api-key': requireKey(key), 'content-type': 'application/json' };
    const instance = { prompt, ...(image ? { image: { inlineData: { mimeType: image.mime, data: image.bytes.toString('base64') } } } : {}) };
    let operation = await requestJson(`${base}/models/${model}:predictLongRunning`, {
      method: 'POST', headers, timeoutMs: 120_000,
      body: JSON.stringify({ instances: [instance], parameters: { aspectRatio: aspect, durationSeconds: duration, numberOfVideos: 1 } }),
    });
    const deadline = Date.now() + 900_000;
    while (!operation.done) {
      if (Date.now() > deadline) throw new ProviderError('timeout', 'Veo generation timed out');
      await sleep(8000);
      operation = await requestJson(`${base}/${operation.name}`, { headers });
    }
    if (operation.error) throw new ProviderError(/safety|policy|block/i.test(operation.error.message) ? 'policy' : 'provider', 'Veo failed', { detail: operation.error.message });
    const uri = operation.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
    if (!uri) throw new ProviderError('policy', 'Veo returned no video (often a safety filter)');
    return { bytes: await downloadBytes(uri, { headers: { 'x-goog-api-key': key }, timeoutMs: 300_000 }), usage: null };
  },
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
