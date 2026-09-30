import { checkPresets } from './presets.js';

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Validates a generation request against the chosen model's declared capabilities, then queues it.
export function createGenerationService({ repo, providers, directors, keys, jobs }) {
  function resolveDirector(director) {
    if (!director) return null;
    const [directorId, model] = String(director).split(':');
    const entry = directors.get(directorId);
    if (!entry || !entry.models.includes(model)) throw new RequestError(400, 'Unknown creative director.');
    if (!entry.keyless && !keys.get(entry.keyProvider)) throw new RequestError(400, `Add a ${entry.label} key in Settings to use this director.`);
    return `${directorId}:${model}`;
  }

  function submit(input) {
    const project = repo.projects.get(input.projectId);
    if (!project) throw new RequestError(404, 'Project not found.');
    const media = input.operation === 'speech' || input.operation === 'video' ? input.operation : null;
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    const limit = media === 'speech' ? 200_000 : 4000;
    if (!prompt || prompt.length > limit) throw new RequestError(400, media === 'speech' ? 'Nothing to narrate (or the text is over 200,000 characters).' : 'Enter a prompt between 1 and 4000 characters.');

    const provider = providers.get(input.provider);
    if (!provider) throw new RequestError(400, 'Choose an image provider.');
    const model = providers.model(input.provider, input.model);
    if (!model) throw new RequestError(400, `${provider.label} does not offer that model.`);
    if (!provider.keyless && !keys.get(provider.id)) throw new RequestError(400, `Add a ${provider.label} API key in Settings first.`);

    const inputAssetIds = [...new Set(Array.isArray(input.inputAssetIds) ? input.inputAssetIds.filter((id) => typeof id === 'string') : [])];
    for (const id of inputAssetIds) {
      if (!repo.assets.get(id)) throw new RequestError(404, 'An input image no longer exists.');
    }
    for (const id of inputAssetIds) {
      if (!repo.assets.get(id).mimeType.startsWith('image/')) throw new RequestError(400, 'Input files must be images.');
    }
    let operation;
    let params;
    if (media) {
      operation = media;
      if (!model.operations.includes(media)) throw new RequestError(400, `${model.label} cannot ${media === 'speech' ? 'narrate' : 'make video'}.`);
      if (inputAssetIds.length > model.maxReferences) throw new RequestError(400, `${model.label} accepts at most ${model.maxReferences} input image(s).`);
      if (model.requiresImage && !inputAssetIds.length) throw new RequestError(400, `${model.label} needs a start image.`);
      params = media === 'speech'
        ? { voice: model.voices?.includes(input.voice) ? input.voice : model.voices?.[0] ?? null, style: typeof input.style === 'string' ? input.style.slice(0, 500) : null }
        : { duration: model.durations?.includes(Number(input.duration)) ? Number(input.duration) : model.durations?.[0], aspect: model.aspects?.includes(input.aspect) ? input.aspect : model.aspects?.[0] ?? null };
    } else {
      operation = inputAssetIds.length ? (input.operation === 'variation' ? 'variation' : 'edit') : 'generate';
      const needed = operation === 'generate' ? 'generate' : 'edit';
      if (!model.operations.includes(needed)) {
        throw new RequestError(400, needed === 'edit' ? `${model.label} cannot take input images. Choose an editing model.` : `${model.label} needs an input image.`);
      }
      if (inputAssetIds.length > model.maxReferences) throw new RequestError(400, `${model.label} accepts at most ${model.maxReferences} input image(s).`);
      const size = model.sizes.includes(input.size) ? input.size : model.sizes[0];
      const quality = model.qualities.length ? (model.qualities.includes(input.quality) ? input.quality : model.qualities[Math.min(1, model.qualities.length - 1)]) : null;
      params = { size, quality };
    }
    if (operation !== 'speech') {
      try {
        const chosen = checkPresets(input.presets, operation);
        if (chosen.length) params.presets = chosen;
      } catch (error) {
        throw new RequestError(400, error.message);
      }
    }
    const generation = repo.generations.create({
      projectId: project.id, operation, provider: provider.id, model: model.id, prompt, director: media === 'speech' ? null : resolveDirector(input.director),
      params, inputAssetIds, canvasRunId: input.canvasRunId, nodeId: input.nodeId, bookPageId: input.bookPageId, bookTarget: input.bookTarget,
    });
    jobs.enqueue(generation.id);
    return generation;
  }

  function retry(id) {
    const previous = repo.generations.get(id);
    if (!previous) throw new RequestError(404, 'Generation not found.');
    if (!['failed', 'interrupted'].includes(previous.status)) throw new RequestError(400, 'Only failed or interrupted generations can be retried.');
    // Speech/video keep their operation; image variations keep theirs via the operation field too.
    return submit({ ...previous, ...previous.params, canvasRunId: null, nodeId: null, director: previous.director });
  }

  return { submit, retry, resolveDirector };
}
