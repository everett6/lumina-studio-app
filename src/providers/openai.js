import { joinAudio, splitForSpeech } from '../audio.js';
import { ProviderError, request, requestJson, requireKey } from './http.js';

const sizes = ['1024x1024', '1536x1024', '1024x1536'];
const voices = ['coral', 'alloy', 'ash', 'ballad', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
const base = 'https://api.openai.com/v1';

export default {
  id: 'openai',
  label: 'OpenAI',
  keyUrl: 'https://platform.openai.com/api-keys',
  models: [
    { id: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare', operations: ['generate', 'edit'], sizes, qualities: ['low', 'medium', 'high'], maxReferences: 4, note: 'Fast everyday generation and edits' },
    { id: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst', operations: ['generate', 'edit'], sizes, qualities: ['low', 'medium', 'high'], maxReferences: 4, note: 'Most capable; slower and higher cost' },
    { id: 'gpt-4o-mini-tts', label: 'GPT-4o mini TTS', operations: ['speech'], sizes: [], qualities: [], maxReferences: 0, voices, note: 'Narration with style instructions (MP3)' },
  ],
  async speak({ key, model, text, voice, style }) {
    const clips = [];
    for (const chunk of splitForSpeech(text, 3800)) {
      const response = await request(`${base}/audio/speech`, {
        method: 'POST', timeoutMs: 180_000,
        headers: { authorization: `Bearer ${requireKey(key)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: chunk, voice: voices.includes(voice) ? voice : 'coral', response_format: 'mp3', ...(style ? { instructions: style } : {}) }),
      });
      clips.push(Buffer.from(await response.arrayBuffer()));
    }
    return { bytes: joinAudio(clips, 'audio/mpeg'), usage: { characters: text.length } };
  },
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
