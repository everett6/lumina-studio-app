import Anthropic from '@anthropic-ai/sdk';
import { ProviderError, requestJson, requireKey } from '../providers/http.js';

export const directorInstructions = 'You are an expert visual creative director. Translate the user idea into a single concise image-generation prompt. Preserve the intended subject and meaning. Add useful details for composition, lighting, materials, color, and camera only when appropriate. If the idea asks to edit an existing image, keep it phrased as an edit instruction. Return only the prompt, with no preamble or markdown.';

function checked(text) {
  const prompt = String(text ?? '').trim();
  if (!prompt || prompt.length > 6000) throw new ProviderError('provider', 'Director returned an invalid prompt');
  return prompt;
}

const openai = {
  id: 'openai',
  label: 'OpenAI',
  keyProvider: 'openai',
  models: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'],
  async refine({ key, model, idea }) {
    const body = await requestJson('https://api.openai.com/v1/responses', {
      method: 'POST', timeoutMs: 60_000,
      headers: { authorization: `Bearer ${requireKey(key)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, instructions: directorInstructions, input: idea }),
    });
    const text = body.output?.flatMap((item) => item.content ?? []).find((part) => part.type === 'output_text')?.text;
    return checked(text);
  },
};

const anthropic = {
  id: 'anthropic',
  label: 'Anthropic Claude',
  keyProvider: 'anthropic',
  models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'],
  async refine({ key, model, idea }) {
    const client = new Anthropic({ apiKey: requireKey(key), timeout: 60_000, maxRetries: 1 });
    const params = { model, max_tokens: 2000, system: directorInstructions, messages: [{ role: 'user', content: idea }] };
    try {
      let message;
      if (model === 'claude-haiku-4-5') {
        message = await client.messages.create(params);
      } else {
        // Short rewrite task: low effort; server-side fallback reruns a declined request on another model.
        message = await client.beta.messages.create({
          ...params, output_config: { effort: 'low' }, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        });
      }
      if (message.stop_reason === 'refusal') throw new ProviderError('policy', 'Claude declined to rewrite this prompt');
      return checked(message.content.filter((block) => block.type === 'text').map((block) => block.text).join(''));
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) throw new ProviderError('auth', error.message);
      if (error instanceof Anthropic.RateLimitError) throw new ProviderError('rate_limit', error.message);
      if (error instanceof Anthropic.BadRequestError) throw new ProviderError('invalid_request', error.message, { detail: error.message });
      if (error instanceof Anthropic.APIConnectionTimeoutError) throw new ProviderError('timeout', error.message);
      throw new ProviderError('provider', error.message);
    }
  },
};

const nemotron = {
  id: 'nemotron',
  label: 'NVIDIA Nemotron',
  keyProvider: 'nemotron',
  models: [process.env.NEMOTRON_MODEL || 'nvidia/nemotron-3.5-lightning-30b-a3b'],
  async refine({ key, model, idea }) {
    const base = (process.env.NEMOTRON_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '');
    const body = await requestJson(`${base}/chat/completions`, {
      method: 'POST', timeoutMs: 45_000,
      headers: { authorization: `Bearer ${requireKey(key)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0.5, max_tokens: 500, messages: [{ role: 'system', content: directorInstructions }, { role: 'user', content: idea }] }),
    });
    return checked(body?.choices?.[0]?.message?.content);
  },
};

const mock = {
  id: 'mock',
  label: 'Mock director (offline test)',
  keyless: true,
  models: ['mock-director'],
  async refine({ idea }) {
    return `${idea.trim()}, cinematic lighting, detailed composition`;
  },
};

export function createDirectors({ enableMock = process.env.LUMINA_MOCK === '1' } = {}) {
  const list = [openai, anthropic, nemotron, ...(enableMock ? [mock] : [])];
  const byId = new Map(list.map((director) => [director.id, director]));
  return { list, get: (id) => byId.get(id) };
}
