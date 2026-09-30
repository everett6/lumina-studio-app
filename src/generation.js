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
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt || prompt.length > 4000) throw new RequestError(400, 'Enter a prompt between 1 and 4000 characters.');

    const provider = providers.get(input.provider);
    if (!provider) throw new RequestError(400, 'Choose an image provider.');
    const model = providers.model(input.provider, input.model);
    if (!model) throw new RequestError(400, `${provider.label} does not offer that model.`);
    if (!provider.keyless && !keys.get(provider.id)) throw new RequestError(400, `Add a ${provider.label} API key in Settings first.`);

    const inputAssetIds = [...new Set(Array.isArray(input.inputAssetIds) ? input.inputAssetIds.filter((id) => typeof id === 'string') : [])];
    for (const id of inputAssetIds) {
      if (!repo.assets.get(id)) throw new RequestError(404, 'An input image no longer exists.');
    }
    const operation = inputAssetIds.length ? (input.operation === 'variation' ? 'variation' : 'edit') : 'generate';
    const needed = operation === 'generate' ? 'generate' : 'edit';
    if (!model.operations.includes(needed)) {
      throw new RequestError(400, needed === 'edit' ? `${model.label} cannot take input images. Choose an editing model.` : `${model.label} needs an input image.`);
    }
    if (inputAssetIds.length > model.maxReferences) throw new RequestError(400, `${model.label} accepts at most ${model.maxReferences} input image(s).`);

    const size = model.sizes.includes(input.size) ? input.size : model.sizes[0];
    const quality = model.qualities.length ? (model.qualities.includes(input.quality) ? input.quality : model.qualities[Math.min(1, model.qualities.length - 1)]) : null;
    const generation = repo.generations.create({
      projectId: project.id, operation, provider: provider.id, model: model.id, prompt, director: resolveDirector(input.director),
      params: { size, quality }, inputAssetIds, canvasRunId: input.canvasRunId, nodeId: input.nodeId, bookPageId: input.bookPageId,
    });
    jobs.enqueue(generation.id);
    return generation;
  }

  function retry(id) {
    const previous = repo.generations.get(id);
    if (!previous) throw new RequestError(404, 'Generation not found.');
    if (!['failed', 'interrupted'].includes(previous.status)) throw new RequestError(400, 'Only failed or interrupted generations can be retried.');
    return submit({ ...previous, ...previous.params, canvasRunId: null, nodeId: null });
  }

  return { submit, retry, resolveDirector };
}
