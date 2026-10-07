import { checkPresets, composePrompt } from './presets.js';

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Image tools take exactly one image and return a changed copy of it.
export const toolOperations = ['upscale', 'remove-background', 'inpaint'];
const toolLabels = { upscale: 'Upscale', 'remove-background': 'Remove background' };
const toolVerbs = { upscale: 'upscale images', 'remove-background': 'remove backgrounds', inpaint: 'inpaint' };

// The text a job sends to its provider: the user's prompt plus preset and character notes.
export function providerPrompt(job) {
  const composed = composePrompt(job.prompt, job.params?.presets);
  return job.params?.characterNote ? `${composed}\n\n${job.params.characterNote}` : composed;
}

// The model's supported clip length closest to the one asked for (ties go to the longer one); the model's first
// length when none was asked for.
export function nearestDuration(durations, wanted) {
  if (!durations?.length) return undefined;
  const target = Number(wanted);
  if (!Number.isFinite(target) || target <= 0) return durations[0];
  return durations.reduce((best, d) => (Math.abs(d - target) < Math.abs(best - target) || (Math.abs(d - target) === Math.abs(best - target) && d > best) ? d : best));
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

  const imageAsset = (id) => {
    const asset = typeof id === 'string' ? repo.assets.get(id) : null;
    return asset?.mimeType.startsWith('image/') ? asset : null;
  };

  // Characters add their description to the prompt, and their reference photos when the model has room for them.
  function applyCharacters(input, { model, inputAssetIds, canTakeImages }) {
    const ids = [...new Set(Array.isArray(input.characterIds) ? input.characterIds.filter((id) => typeof id === 'string') : [])];
    if (!ids.length) return {};
    if (ids.length > 4) throw new RequestError(400, 'Use at most 4 characters in one generation.');
    const chosen = ids.map((id) => repo.characters.get(id) ?? (() => { throw new RequestError(404, 'A character no longer exists.'); })());
    const references = [...new Set(chosen.flatMap((c) => c.referenceAssetIds))].filter((id) => imageAsset(id));
    const room = canTakeImages ? Math.max(0, model.maxReferences - inputAssetIds.length) : 0;
    inputAssetIds.push(...references.filter((id) => !inputAssetIds.includes(id)).slice(0, room));
    const attached = references.filter((id) => inputAssetIds.includes(id)).length;
    const note = `Characters (keep each one exactly as described${attached ? ' and as shown in the reference image(s)' : ''}): ${
      chosen.map((c) => `${c.name} — ${c.description || 'as shown in the reference image'}`).join('; ')}.`.slice(0, 2500);
    return { characterIds: ids, characterNote: note, ...(references.length > attached ? { droppedCharacterRefs: references.length - attached } : {}) };
  }

  function submit(input) {
    const project = repo.projects.get(input.projectId);
    if (!project) throw new RequestError(404, 'Project not found.');
    const media = input.operation === 'speech' || input.operation === 'video' ? input.operation : null;
    const tool = toolOperations.includes(input.operation) ? input.operation : null;
    let prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (tool && tool !== 'inpaint' && !prompt) prompt = toolLabels[tool];
    const limit = media === 'speech' ? 200_000 : 4000;
    if (!prompt || prompt.length > limit) {
      throw new RequestError(400, media === 'speech' ? 'Nothing to narrate (or the text is over 200,000 characters).'
        : tool === 'inpaint' ? 'Describe what should appear in the painted area.' : 'Enter a prompt between 1 and 4000 characters.');
    }

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
      if (!imageAsset(id)) throw new RequestError(400, 'Input files must be images.');
    }
    let operation;
    let params;
    if (tool) {
      operation = tool;
      if (!model.operations.includes(tool)) throw new RequestError(400, `${model.label} cannot ${toolVerbs[tool]}.`);
      if (inputAssetIds.length !== 1) throw new RequestError(400, 'Choose one image for this tool.');
      params = {};
      if (tool === 'upscale') params.scale = model.scales?.includes(Number(input.scale)) ? Number(input.scale) : model.scales?.[0] ?? 2;
      if (tool === 'inpaint') {
        if (!imageAsset(input.maskAssetId)) throw new RequestError(400, 'Paint the area to change first.');
        params.maskAssetId = input.maskAssetId;
      }
    } else if (media) {
      operation = media;
      if (!model.operations.includes(media)) throw new RequestError(400, `${model.label} cannot ${media === 'speech' ? 'narrate' : 'make video'}.`);
      if (inputAssetIds.length > model.maxReferences) throw new RequestError(400, `${model.label} accepts at most ${model.maxReferences} input image(s).`);
      if (model.requiresImage && !inputAssetIds.length) throw new RequestError(400, `${model.label} needs a start image.`);
      params = media === 'speech'
        ? { voice: model.voices?.includes(input.voice) ? input.voice : model.voices?.[0] ?? null, style: typeof input.style === 'string' ? input.style.slice(0, 500) : null }
        : { duration: nearestDuration(model.durations, input.duration), aspect: model.aspects?.includes(input.aspect) ? input.aspect : model.aspects?.[0] ?? null };
      // A video's input image is its start frame, so characters contribute their description only.
      if (media === 'video') Object.assign(params, applyCharacters(input, { model, inputAssetIds, canTakeImages: false }));
    } else {
      if (inputAssetIds.length > model.maxReferences) throw new RequestError(400, `${model.label} accepts at most ${model.maxReferences} input image(s).`);
      const characters = applyCharacters(input, { model, inputAssetIds, canTakeImages: model.operations.includes('edit') });
      operation = inputAssetIds.length ? (input.operation === 'variation' ? 'variation' : 'edit') : 'generate';
      const needed = operation === 'generate' ? 'generate' : 'edit';
      if (!model.operations.includes(needed)) {
        throw new RequestError(400, needed === 'edit' ? `${model.label} cannot take input images. Choose an editing model.` : `${model.label} needs an input image.`);
      }
      const size = model.sizes.includes(input.size) ? input.size : model.sizes[0];
      const quality = model.qualities.length ? (model.qualities.includes(input.quality) ? input.quality : model.qualities[Math.min(1, model.qualities.length - 1)]) : null;
      params = { size, quality, ...characters };
    }
    if (operation !== 'speech' && !tool) {
      try {
        const chosen = checkPresets(input.presets, operation);
        if (chosen.length) params.presets = chosen;
      } catch (error) {
        throw new RequestError(400, error.message);
      }
    }
    const generation = repo.generations.create({
      projectId: project.id, operation, provider: provider.id, model: model.id, prompt, director: media === 'speech' || tool ? null : resolveDirector(input.director),
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
