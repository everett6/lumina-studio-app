import Anthropic from '@anthropic-ai/sdk';
import { ProviderError, requestJson, requireKey } from '../providers/http.js';
import { mockCompletion } from './mock.js';

export const directorInstructions = 'You are an expert visual creative director. Translate the user idea into a single concise image-generation prompt. Preserve the intended subject and meaning. Add useful details for composition, lighting, materials, color, and camera only when appropriate. If the idea asks to edit an existing image, keep it phrased as an edit instruction. Return only the prompt, with no preamble or markdown.';

function checkedPrompt(text) {
  const prompt = String(text ?? '').trim();
  if (!prompt || prompt.length > 6000) throw new ProviderError('provider', 'Director returned an invalid prompt');
  return prompt;
}

// Every text provider implements complete(); refine() (image prompt rewriting) is built on it.
const openai = {
  id: 'openai',
  label: 'OpenAI',
  keyProvider: 'openai',
  models: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'],
  async complete({ key, model, system, prompt, maxTokens = 16000 }) {
    const body = await requestJson('https://api.openai.com/v1/responses', {
      method: 'POST', timeoutMs: 300_000,
      headers: { authorization: `Bearer ${requireKey(key)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, instructions: system, input: prompt, max_output_tokens: maxTokens }),
    });
    const text = body.output?.flatMap((item) => item.content ?? []).filter((part) => part.type === 'output_text').map((part) => part.text).join('');
    if (!text) throw new ProviderError('provider', 'OpenAI returned no text');
    return text;
  },
};

const anthropic = {
  id: 'anthropic',
  label: 'Anthropic Claude',
  keyProvider: 'anthropic',
  models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'],
  async complete({ key, model, system, prompt, maxTokens = 16000, effort = 'low' }) {
    const client = new Anthropic({ apiKey: requireKey(key), timeout: 300_000, maxRetries: 1 });
    const params = { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] };
    try {
      let message;
      if (model === 'claude-haiku-4-5') {
        message = await client.messages.create(params);
      } else {
        // Server-side fallback reruns a declined request on another model.
        message = await client.beta.messages.create({
          ...params, output_config: { effort }, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        });
      }
      if (message.stop_reason === 'refusal') throw new ProviderError('policy', 'Claude declined this request');
      if (message.stop_reason === 'max_tokens') throw new ProviderError('provider', 'Claude ran out of output space; try fewer pages');
      return message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
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
  async complete({ key, model, system, prompt, maxTokens = 8000 }) {
    const base = (process.env.NEMOTRON_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '');
    const body = await requestJson(`${base}/chat/completions`, {
      method: 'POST', timeoutMs: 300_000,
      headers: { authorization: `Bearer ${requireKey(key)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0.6, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
    });
    const text = body?.choices?.[0]?.message?.content;
    if (!text) throw new ProviderError('provider', 'Nemotron returned no text');
    return text;
  },
};

const mock = {
  id: 'mock',
  label: 'Mock writer (offline test)',
  keyless: true,
  models: ['mock-director'],
  async complete(args) {
    return mockCompletion(args);
  },
};

for (const writer of [openai, anthropic, nemotron, mock]) {
  writer.refine = async ({ key, model, idea }) => checkedPrompt(await writer.complete({ key, model, system: directorInstructions, prompt: idea, maxTokens: 2000, task: 'refine' }));
}

export function createDirectors({ enableMock = process.env.LUMINA_MOCK === '1' } = {}) {
  const list = [openai, anthropic, nemotron, ...(enableMock ? [mock] : [])];
  const byId = new Map(list.map((director) => [director.id, director]));
  return { list, get: (id) => byId.get(id) };
}
