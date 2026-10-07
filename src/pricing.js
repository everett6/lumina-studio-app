// List prices read from each provider's own pricing page on the date below. Providers change prices and bill by
// their own rules, so these are estimates for planning, not invoices. Models without an entry show "not listed".
export const pricesAsOf = '2026-10-01';

const perToken = (what) => ({ text: `Billed per token (${what}); the cost depends on the output` });
const table = {
  'fal|fal-ai/flux/schnell': { usd: 0.003, per: 'megapixel' },
  'fal|fal-ai/flux-pro/kontext': { usd: 0.04, per: 'image' },
  'fal|fal-ai/flux-pro/v1/fill': { usd: 0.05, per: 'megapixel' },
  'fal|fal-ai/esrgan': { text: 'Billed by compute time ($0.00111 per second)' },
  // Lumina asks Kling for audio, which is the higher of its two per-second rates.
  'fal|fal-ai/kling-video/v3/pro/text-to-video': { usd: 0.168, per: 'second' },
  'fal|fal-ai/kling-video/v3/pro/image-to-video': { usd: 0.168, per: 'second' },
  'gemini|gemini-3.1-flash-image': { usd: 0.067, per: 'image' },
  'gemini|gemini-3-pro-image': { usd: 0.134, per: 'image' },
  'gemini|gemini-3.1-flash-lite-image': { usd: 0.0336, per: 'image' },
  'gemini|veo-3.1-generate-preview': { usd: 0.4, per: 'second' },
  // Fast and Lite cost more above 720p.
  'gemini|veo-3.1-fast-generate-preview': { usd: 0.1, per: 'second', from: true },
  'gemini|veo-3.1-lite-generate-preview': { usd: 0.05, per: 'second', from: true },
  'gemini|gemini-3.8-flash-tts': perToken('$9 per 1M audio output tokens'),
  'gemini|gemini-3.8-flash-lite-tts': perToken('$6 per 1M audio output tokens'),
  'openai|gpt-image-2.5-flare': perToken('$30 per 1M image output tokens'),
  'openai|gpt-image-2.5-sunburst': perToken('$30 per 1M image output tokens'),
  'openai|gpt-4o-mini-tts': perToken('$12 per 1M audio output tokens'),
  // OpenRouter list prices from its /images and /videos model catalogs (read 2026-10-06).
  'openrouter|bytedance-seed/seedream-4.5': { usd: 0.04, per: 'image' },
  'openrouter|black-forest-labs/flux.2-pro': { usd: 0.03, per: 'megapixel' },
  'openrouter|google/gemini-3.1-flash-image': perToken('$60 per 1M image output tokens'),
  'openrouter|google/gemini-3-pro-image': perToken('$120 per 1M image output tokens'),
  'openrouter|openai/gpt-image-2': perToken('$30 per 1M image output tokens'),
  'openrouter|google/veo-3.1-fast': { usd: 0.12, per: 'second' },
  'openrouter|google/veo-3.1': { usd: 0.4, per: 'second' },
  'openrouter|kwaivgi/kling-v3.0-pro': { usd: 0.168, per: 'second' },
  'openrouter|alibaba/wan-2.7': { usd: 0.1, per: 'second' },
  'openrouter|minimax/hailuo-3': { usd: 0.13, per: 'second' },
  'openrouter|bytedance/seedance-2.0': { text: 'Billed per video token; the cost depends on length and resolution' },
  'mock|mock-image': { usd: 0, per: 'image' },
  'mock|mock-video': { usd: 0, per: 'second' },
  'mock|mock-voice': { usd: 0, per: 'image' },
  'mock|mock-tools': { usd: 0, per: 'image' },
};

export const priceFor = (providerId, modelId) => table[`${providerId}|${modelId}`] ?? null;

// Dollar estimate for one job, or null when the model has no per-unit list price.
export function estimateUsd(price, { size, duration } = {}) {
  if (!price || price.usd == null) return null;
  if (price.per === 'second') return Number.isFinite(Number(duration)) ? price.usd * Number(duration) : null;
  if (price.per === 'megapixel') {
    const [w, h] = String(size ?? '').split('x').map(Number);
    return w && h ? price.usd * w * h / 1e6 : null;
  }
  return price.usd;
}
