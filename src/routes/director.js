// API routes: director. Called by createApiServer (src/api.js) with { route, readBody, readRaw, needProject, RequestError, ...services }.
// route(method, pattern, handler(req, params, url, res)); pattern is a regex string, e.g. `/api/assets/${uuid}/x` with uuid from ctx.
import { presets } from '../presets.js';
import { maxShots } from '../sequences.js';
import { stillMotions } from '../video.js';

export function registerRoutes({ route, readBody, RequestError, uuid, sequences, repo }) {
  const fields = { framePrompt: 'directorFramePrompt', clipPrompt: 'directorClipPrompt', negativePrompt: 'directorNegative', keepAutomatic: 'directorKeepAutomatic' };
  const overrides = (shot) => Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, shot.details[field]]));
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const fail = (message) => { throw new RequestError(400, message); };
  const pagination = (url) => {
    const number = (key, fallback, min, max) => {
      const raw = url.searchParams.get(key);
      const value = raw === null ? fallback : Number(raw);
      if (raw === '' || !Number.isSafeInteger(value) || value < min || value > max) fail(`${key} must be an integer between ${min} and ${max}.`);
      return value;
    };
    return { offset: number('offset', 0, 0, Number.MAX_SAFE_INTEGER), limit: number('limit', 6, 1, maxShots) };
  };
  const page = (id, url) => {
    sequences.needSequence(id);
    const { offset, limit } = pagination(url);
    const all = repo.shots.listBySequence(id);
    return { storyboardId: id, offset, limit, total: all.length,
      nextOffset: offset + limit < all.length ? offset + limit : null,
      shots: all.slice(offset, offset + limit).map((s) => sequences.needShot(s.id)) };
  };
  const shotBrief = (shot) => ({
    shotId: shot.id, position: shot.position, description: shot.description, camera: shot.camera, duration: shot.duration,
    scene: shot.details.scene, characterIds: shot.details.characterIds, locationId: shot.details.locationId,
    action: shot.details.action, dialogue: shot.details.dialogue, startState: shot.details.startState, endState: shot.details.endState,
    forbidden: shot.details.forbidden, themes: shot.details.themes, method: shot.details.method, motion: shot.details.motion,
    timing: shot.details.timing, holds: shot.details.holds, locked: shot.details.locked, model: shot.details.model,
    overrides: overrides(shot), ...sequences.composedPrompts(shot.id),
  });

  route('GET', `/api/storyboards/${uuid}/director-brief`, (req, [id], url) => {
    const sequence = sequences.needSequence(id);
    const result = page(id, url);
    const characters = repo.characters.list().map((c) => ({
      id: c.id, name: c.name, kind: c.kind, designTags: c.designTags, description: c.description, voice: c.voice,
      referenceAssetIds: c.referenceAssetIds, baked: Boolean(repo.settings.get(`bake:${c.id}`, null)),
    }));
    return { ...result, title: sequence.title, idea: sequence.idea, screenplay: sequence.screenplay,
      look: sequence.settings.look, lookBible: sequence.settings.lookBible, settings: sequence.settings,
      characters: characters.filter((c) => c.kind !== 'location'), locations: characters.filter((c) => c.kind === 'location'),
      shots: result.shots.map(shotBrief) };
  });
  route('GET', `/api/shots/${uuid}/prompts`, (req, [id]) => sequences.composedPrompts(id));
  route('GET', `/api/storyboards/${uuid}/prompts`, (req, [id], url) => {
    const result = page(id, url);
    return { ...result, shots: result.shots.map((shot) => sequences.composedPrompts(shot.id)) };
  });

  // Build and validate the whole edit before entering the write phase. The transaction also rolls back if any
  // subsequent update fails. Reuse updateShot's story lock and approval rules (including camera/motion revisions).
  function validate(shotId, input, storyboardId) {
    if (typeof shotId !== 'string' || !shotId) fail('Every direction needs a shotId.');
    const shot = sequences.needShot(shotId);
    if (storyboardId && shot.sequenceId !== storyboardId) fail('Every shot must belong to this storyboard.');
    if (!object(input)) fail('Direction must be an object.');
    const keys = Object.keys(input);
    if (!keys.length || keys.some((key) => !Object.hasOwn(fields, key) && !['camera', 'motion'].includes(key))) fail('Use framePrompt, clipPrompt, negativePrompt, keepAutomatic, camera or motion.');
    const details = {};
    for (const [key, field] of Object.entries(fields)) {
      if (!Object.hasOwn(input, key)) continue;
      const value = input[key];
      if (key === 'keepAutomatic') {
        if (typeof value !== 'boolean') fail('keepAutomatic must be a boolean.');
      } else if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 4000)) fail(`${key} must be null or nonempty text up to 4000 characters.`);
      details[field] = value;
    }
    if (input.camera !== undefined && input.camera !== null && !presets.some((p) => p.group === 'camera' && p.id === input.camera)) fail('Unknown camera preset. Use list_presets.');
    if (input.motion !== undefined) {
      if (!stillMotions.includes(input.motion)) fail(`motion must be one of: ${stillMotions.join(', ')}.`);
      details.motion = input.motion;
    }
    if (shot.details.locked) throw new RequestError(409, `Shot ${shot.position} is locked (approved screenplay). Unlock it first to revise it.`);
    for (const id of [...shot.details.characterIds, shot.details.locationId].filter(Boolean)) {
      if (!repo.characters.get(id)) throw new RequestError(404, 'A character or location in this shot no longer exists.');
    }
    const body = { description: shot.description, ...(input.camera !== undefined ? { camera: input.camera } : {}), details };
    sequences.composedPrompts(shotId, body);
    return { shotId, body };
  }
  const save = (edits) => repo.transaction(() => {
    for (const edit of edits) sequences.updateShot(edit.shotId, edit.body);
    return { storyboardId: sequences.needShot(edits[0].shotId).sequenceId, shots: edits.map((edit) => shotBrief(sequences.needShot(edit.shotId))) };
  });
  route('POST', `/api/shots/${uuid}/direct`, async (req, [id]) => save([validate(id, await readBody(req, 32 * 1024))]));
  route('POST', `/api/storyboards/${uuid}/direct`, async (req, [id]) => {
    sequences.needSequence(id);
    const body = await readBody(req, 1024 * 1024);
    if (!object(body) || !Array.isArray(body.shots) || body.shots.length < 1 || body.shots.length > maxShots) fail(`Supply 1–${maxShots} shot directions.`);
    const seen = new Set();
    const edits = body.shots.map((input) => {
      if (!object(input)) fail('Every shot direction must be an object.');
      const { shotId, ...direction } = input;
      if (seen.has(shotId)) fail('A shotId may appear only once.');
      seen.add(shotId);
      return validate(shotId, direction, id);
    });
    return save(edits);
  });
}
