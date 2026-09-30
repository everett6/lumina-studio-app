import openai from './openai.js';
import fal from './fal.js';
import gemini from './gemini.js';
import replicate from './replicate.js';
import mock from './mock.js';

export function createProviders({ enableMock = process.env.LUMINA_MOCK === '1' } = {}) {
  const list = [openai, fal, gemini, replicate, ...(enableMock ? [mock] : [])];
  const byId = new Map(list.map((provider) => [provider.id, provider]));
  return {
    list,
    get: (id) => byId.get(id),
    model(providerId, modelId) {
      return byId.get(providerId)?.models.find((model) => model.id === modelId) ?? null;
    },
  };
}
