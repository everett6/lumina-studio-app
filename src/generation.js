import { billingState, BudgetError, requestSignature } from './budget.js';
import { currentRequest } from './context.js';
import { checkPresets, composePrompt } from './presets.js';
import { estimateUsd, priceFor } from './pricing.js';

// "Confirm spend": a click in the app that would use a paid provider is answered with 428 and the estimate until
// the person confirms (the app then sends the same request with x-lumina-confirm-spend: 1). MCP clients and background
// work started by an already-confirmed request are not asked again; MCP spending stays under the budget approvals.
export function confirmSpend({ estimateUsd, unpriced = 0, jobs = 1, what }) {
  const request = currentRequest();
  if (request.source !== 'app' || request.confirmSpend || request.confirmPaid === false) return;
  const cost = estimateUsd ? `about $${Number(estimateUsd).toFixed(2)}` : 'with no fixed price (billed by the provider)';
  throw Object.assign(new RequestError(428, `This uses paid credits: ${what}. Estimated ${cost}${unpriced && estimateUsd ? ` plus ${unpriced} job(s) without a published price` : ''}.`),
    { extra: { needsSpendConfirm: true, estimateUsd: estimateUsd ?? null, unpriced, jobs } });
}

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

// The resolution a video request asks for: 720p when offered (cheap enough, sharp enough to upscale), else the
// lowest listed. Models without listed resolutions get none and the provider decides.
export function defaultResolution(model) {
  const list = model?.resolutions ?? [];
  if (!list.length) return null;
  if (list.includes('720p')) return '720p';
  const height = (r) => (/(\d+)p$/i.test(r) ? Number(/(\d+)/.exec(r)[1]) : /(\d+)k$/i.test(r) ? Number(/(\d+)/.exec(r)[1]) * 1000 : 9999);
  return [...list].sort((a, b) => height(a) - height(b))[0];
}

// Validates a generation request against the chosen model's declared capabilities, then queues it.
export function createGenerationService({ repo, providers, directors, keys, jobs, budget, db, transaction }) {
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

  // Characters, products and locations add their description to the prompt, and their reference photos when the
  // model has room for them (people first, then the location, so the cast is never crowded out by the set).
  function applyCharacters(input, { model, inputAssetIds, canTakeImages }) {
    const ids = [...new Set(Array.isArray(input.characterIds) ? input.characterIds.filter((id) => typeof id === 'string') : [])];
    if (!ids.length) return {};
    if (ids.length > 8) throw new RequestError(400, 'Use at most 8 characters and locations in one generation.');
    const chosen = ids.map((id) => repo.characters.get(id) ?? (() => { throw new RequestError(404, 'A character no longer exists.'); })());
    chosen.sort((a, b) => (a.kind === 'location') - (b.kind === 'location'));
    const references = [...new Set(chosen.flatMap((c) => c.referenceAssetIds))].filter((id) => imageAsset(id));
    const room = canTakeImages ? Math.max(0, model.maxReferences - inputAssetIds.length) : 0;
    inputAssetIds.push(...references.filter((id) => !inputAssetIds.includes(id)).slice(0, room));
    const attached = references.filter((id) => inputAssetIds.includes(id)).length;
    const shown = attached ? ' and as shown in the reference image(s)' : '';
    const people = chosen.filter((c) => c.kind !== 'location');
    const places = chosen.filter((c) => c.kind === 'location');
    const note = [
      people.length ? `Characters (keep each one exactly as described${shown}: same face, hair, body, clothes and colours): ${
        people.map((c) => `${c.name} — ${[c.designTags, c.description].filter(Boolean).join('; ') || 'as shown in the reference image'}`).join('; ')}.` : '',
      places.length ? `Location (keep the layout, architecture, props and lighting exactly as described${shown}): ${
        places.map((c) => `${c.name} — ${c.description || 'as shown in the reference image'}`).join('; ')}.` : '',
    ].filter(Boolean).join('\n').slice(0, 3500);
    return { characterIds: ids, characterNote: note, ...(references.length > attached ? { droppedCharacterRefs: references.length - attached } : {}) };
  }

  function submit(input) {
    if (input.isRetry && (typeof input.retryOf !== 'string' || !input.retryOf)) throw new RequestError(400, 'isRetry requires an eligible retryOf job id.');
    const project = repo.projects.get(input.projectId);
    if (!project) throw new RequestError(404, 'Project not found.');
    // The same idempotency key returns the job already made instead of paying again (e.g. an MCP client
    // re-sending after a dropped connection).
    if (input.idempotencyKey != null) {
      const key = String(input.idempotencyKey);
      if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new RequestError(400, 'idempotencyKey must be 8–128 letters, digits or . _ : -');
    }
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
    if (model && provider.modelAvailable && !provider.modelAvailable(model.id)) throw new RequestError(400, 'Download this local model before generating.');
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
      // A custom voice that was deleted must not silently become the default voice.
      if (media === 'speech' && typeof input.voice === 'string' && input.voice.startsWith('custom:') && !model.voices?.includes(input.voice)) {
        throw new RequestError(400, `The custom voice ${input.voice} no longer exists (or ${model.label ?? model.id} cannot use it). Pick another voice (list_voices).`);
      }
      params = media === 'speech'
        ? { voice: model.voices?.includes(input.voice) ? input.voice : model.voices?.[0] ?? null, style: typeof input.style === 'string' ? input.style.slice(0, 500) : null }
        : {
          duration: nearestDuration(model.durations, input.duration), aspect: model.aspects?.includes(input.aspect) ? input.aspect : model.aspects?.[0] ?? null,
          resolution: model.resolutions?.length ? (model.resolutions.includes(input.resolution) ? input.resolution : defaultResolution(model)) : null,
        };
      if (media === 'video' && input.endFrameAssetId) {
        if (!model.lastFrame) throw new RequestError(400, `${model.label ?? model.id} cannot end on a chosen frame.`);
        if (!imageAsset(input.endFrameAssetId)) throw new RequestError(400, 'The end frame must be an image.');
        if (!inputAssetIds.length) throw new RequestError(400, 'An end frame needs a start frame too.');
        params.endFrameAssetId = input.endFrameAssetId;
      }
      // A video's input image is its start frame, so characters contribute their description only.
      if (media === 'video') Object.assign(params, applyCharacters(input, { model, inputAssetIds, canTakeImages: false }));
    } else {
      if (inputAssetIds.length > model.maxReferences) throw new RequestError(400, `${model.label} accepts at most ${model.maxReferences} input image(s).`);
      // `styleReferences`: the model takes pictures only as a look to follow (IP-Adapter), never as an image to edit.
      const characters = applyCharacters(input, { model, inputAssetIds, canTakeImages: model.operations.includes('edit') || Boolean(model.styleReferences) });
      operation = inputAssetIds.length && !model.styleReferences ? (input.operation === 'variation' ? 'variation' : 'edit') : 'generate';
      const needed = operation === 'generate' ? 'generate' : 'edit';
      if (!model.operations.includes(needed)) {
        throw new RequestError(400, needed === 'edit' ? `${model.label} cannot take input images. Choose an editing model.` : `${model.label} needs an input image.`);
      }
      const size = model.sizes.includes(input.size) ? input.size : model.sizes[0];
      const quality = model.qualities.length ? (model.qualities.includes(input.quality) ? input.quality : model.qualities[Math.min(1, model.qualities.length - 1)]) : null;
      params = { size, quality, ...characters };
    }
    // One seed across a film keeps the model's random choices (faces, palette, grain) from wandering between shots.
    if (!tool && operation !== 'speech' && Number.isInteger(Number(input.seed)) && input.seed !== null && input.seed !== '') params.seed = Math.abs(Math.trunc(Number(input.seed))) % 2147483647;
    if (operation !== 'speech' && !tool) {
      try {
        const chosen = checkPresets(input.presets, operation);
        if (chosen.length) params.presets = chosen;
      } catch (error) {
        throw new RequestError(400, error.message);
      }
    }
    const director = media === 'speech' || tool ? null : resolveDirector(input.director);
    if (director && budget?.settings().enabled && budget.settings().strictPrices && !directors.get(director.split(':')[0])?.keyless) {
      throw new RequestError(402, 'Strict budget: paid prompt refinement has no bounded price. Refine the prompt in your MCP chat instead.');
    }
    const fingerprint = (r) => requestSignature([r.operation, r.provider, r.model, r.prompt, Object.fromEntries(Object.entries(r.params ?? {}).filter(([key]) => key !== 'accounting')), r.inputAssetIds, r.director ?? null, r.bookTarget ?? null]);
    const record = {
      projectId: project.id, operation, provider: provider.id, model: model.id, prompt, director,
      params, inputAssetIds, canvasRunId: input.canvasRunId, nodeId: input.nodeId, bookPageId: input.bookPageId, bookTarget: input.bookTarget,
      idempotencyKey: input.idempotencyKey == null ? null : String(input.idempotencyKey),
    };

    const requestFingerprint = fingerprint(record);
    // Preserve approvals issued before fingerprints were introduced.
    const approvalSignature = requestSignature([provider.id, model.id, operation, prompt, params, inputAssetIds, input.bookTarget ?? null]);
    params.accounting = { billingState: 'not_submitted', requestFingerprint, retryOf: input.retryOf ?? null };
    const price = priceFor(provider.id, model.id, model);
    const paid = !provider.keyless || Boolean(price?.usd || price?.skus);
    const paidDirector = director && !directors.get(director.split(':')[0])?.keyless;
    const estimate = estimateUsd(price, { size: params.size, duration: params.duration, resolution: params.resolution, image: inputAssetIds.length > 0 });
    // A local ledger ceiling cannot bound an unpriced remote bill. Approval cannot make it safe.
    if ((paid && (!Number.isFinite(estimate) || estimate < 0)) || paidDirector) {
      throw new RequestError(402, paidDirector ? 'A paid creative director (writer model) cannot be priced in advance, so it is refused: run without a director, or use a local model.' : 'This paid request has no bounded price or estimate, so it is refused. Choose a local model.');
    }
    let authorizationError;
    const create = () => {
      let eligibleRetry = false;
      if (input.isRetry || input.retryOf != null) {
        const previous = typeof input.retryOf === 'string' ? repo.generations.get(input.retryOf) : null;
        eligibleRetry = previous && ['failed', 'interrupted'].includes(previous.status)
          && previous.projectId === project.id && previous.operation === operation
          && ['confirmed_unbilled', 'refused'].includes(billingState(previous));
        if (!eligibleRetry) throw new RequestError(400, 'isRetry requires retryOf: a failed job in this project and operation with confirmed-unbilled billing.');
      }
      // Key lookup, eligibility, authorization and reservation share the same SQLite write lock.
      if (record.idempotencyKey) {
        const existing = repo.generations.byIdempotencyKey(record.idempotencyKey);
        if (existing) {
          if (existing.projectId !== project.id || (existing.params?.accounting?.requestFingerprint ?? existing.requestFingerprint ?? fingerprint(existing)) !== requestFingerprint) {
            throw new RequestError(409, 'That idempotency key was already used with different request inputs.');
          }
          return existing;
        }
      }

      if (!provider.keyless || paidDirector) confirmSpend({ estimateUsd: estimate, jobs: 1, what: `${model.label ?? model.id} (${provider.label}), ${operation}` });
      let reservation;
      if (paid && budget) {
        try {
          reservation = budget.authorize({
            projectId: project.id, estimateUsd: estimate, isRetry: Boolean(eligibleRetry), approvalId: input.approvalId ?? currentRequest().approvalId ?? null,
            source: currentRequest().source ?? 'app', signature: approvalSignature,
            summary: { provider: provider.label, model: model.label ?? model.id, operation, prompt: prompt.slice(0, 300), duration: params.duration ?? null, resolution: params.resolution ?? null, projectId: project.id },
          });
        } catch (error) {
          if (!(error instanceof BudgetError)) throw error;
          // Commit an approval request, but never a generation or reservation, on a budget refusal.
          authorizationError = Object.assign(new RequestError(402, error.message), { extra: error.extra });
          return null;
        }
      }
      const generation = repo.generations.create({ ...record, billing: paid ? 'reserved' : null });
      if (paid && budget) {
        repo.spend.reserve({ generationId: generation.id, projectId: project.id, provider: provider.id, model: model.id, operation, estimatedUsd: reservation?.reserveUsd ?? estimate });
        if (reservation?.approval && !repo.approvals.use(reservation.approval.id, generation.id)) throw new RequestError(409, 'That approval has already been used.');
      }
      return generation;
    };
    const generation = transaction && db ? transaction(db, create) : repo.transaction(create);
    if (authorizationError) throw authorizationError;
    jobs.enqueue(generation.id);
    return generation;
  }

  function retry(id, options = {}) {
    const previous = repo.generations.get(id);
    if (!previous) throw new RequestError(404, 'Generation not found.');
    if (!['failed', 'interrupted'].includes(previous.status)) throw new RequestError(400, 'Only failed or interrupted generations can be retried.');
    // A request whose billing is unknown may already have been paid for (and may still finish at the provider).
    const safe = ['confirmed_unbilled', 'refused'].includes(billingState(previous));
    const confirmed = options.confirmUncertain === true && currentRequest().source === 'app';
    if (!safe && !confirmed) {
      throw Object.assign(new RequestError(409, 'Lumina cannot tell whether the provider already ran (and billed) this request. Check the provider\'s activity page and resolve its billing as unbilled before retrying.'), { extra: { uncertainBilling: true } });
    }
    // Speech/video keep their operation; image variations keep theirs via the operation field too.
    return submit({ ...previous, ...previous.params, canvasRunId: null, nodeId: null, director: previous.director, idempotencyKey: options.idempotencyKey ?? null, isRetry: safe, retryOf: safe ? previous.id : null, approvalId: options.approvalId });
  }

  return { submit, retry, resolveDirector };
}
