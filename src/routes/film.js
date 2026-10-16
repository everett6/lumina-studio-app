import { randomUUID } from 'node:crypto';
import { validateContinuity } from '../continuity.js';
import { buildTimeline, validateTimeline } from '../timeline.js';
import { probe } from '../video.js';

// API routes for the persistent film controller (src/production.js) and plan validation (src/continuity.js,
// src/timeline.js). Structured scene states are stored per shot under settings key `scene-state:<shotId>`.
export const sceneStateKey = (shotId) => `scene-state:${shotId}`;

export function registerRoutes({ route, readBody, RequestError, uuid, production, sequences, repo, assetStore }) {
  if (!production) return;
  // Errors from the controller carry a status (409 conflict, 400 bad policy): keep it.
  const guard = (fn) => async (...args) => {
    try { return await fn(...args); } catch (error) {
      throw error instanceof RequestError ? error : new RequestError(error.status ?? (error instanceof TypeError || error instanceof RangeError ? 400 : 500), error.message);
    }
  };
  const view = (id) => {
    const film = production.film(id);
    // Not 'status': the router reads a top-level status as the HTTP status code.
    return { film: { id: film.id, sequenceId: film.sequenceId, brief: film.brief, policy: film.policy }, production: production.status(id) };
  };
  const filmOf = (sequenceId) => repo.films.bySequence(sequenceId) ?? (() => { throw new RequestError(404, 'This storyboard has no film controller yet. Start one first.'); })();
  const leased = (id, owner) => {
    if (!production.acquire(id, owner, 120_000)) throw new RequestError(409, 'Another client is producing this film right now (it holds the lease). Try again in a couple of minutes.');
  };

  route('POST', `/api/storyboards/${uuid}/film`, guard(async (req, [sequenceId]) => {
    const { brief = {}, policy = {} } = await readBody(req, 32 * 1024);
    return view(production.open(sequenceId, { brief, policy }).id);
  }));
  route('GET', `/api/storyboards/${uuid}/film`, guard((req, [sequenceId]) => view(filmOf(sequenceId).id)));
  route('GET', `/api/films/${uuid}`, guard((req, [id]) => view(id)));
  route('PATCH', `/api/films/${uuid}`, guard(async (req, [id]) => {
    const { expectedRevision, brief, policy } = await readBody(req, 32 * 1024);
    production.edit(id, { expectedRevision, brief, policy });
    return view(id);
  }));
  route('POST', `/api/films/${uuid}/step`, guard(async (req, [id]) => {
    const { owner: client = 'app', expectedRevision } = await readBody(req, 4 * 1024);
    // One lease owner per request, so two requests from the same client never release each other's lease.
    const owner = `${String(client).slice(0, 60)}:${randomUUID()}`;
    leased(id, owner);
    try {
      await production.step(id, { owner, expectedRevision: expectedRevision ?? production.status(id).filmRevision });
    } finally { production.release(id, owner); }
    return view(id);
  }));
  route('POST', `/api/films/${uuid}/resume`, guard(async (req, [id]) => {
    const { owner: client = 'app' } = await readBody(req, 4 * 1024);
    const owner = `${String(client).slice(0, 60)}:${randomUUID()}`;
    try { await production.resume(id, owner); } finally { production.release(id, owner); }
    return view(id);
  }));
  route('POST', `/api/films/${uuid}/pause`, guard(async (req, [id]) => {
    const { reason } = await readBody(req, 4 * 1024);
    production.pause(id, String(reason ?? 'Paused by user.').slice(0, 300));
    return view(id);
  }));
  route('POST', `/api/films/${uuid}/unpause`, guard((req, [id]) => { production.unpause(id); return view(id); }));
  route('GET', `/api/films/${uuid}/journal`, guard((req, [id], url) => production.journal(id, {
    offset: Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0), limit: Number(url.searchParams.get('limit') ?? 50) || 50,
  })));

  // Structured scene state for continuity validation (start and end of a shot).
  route('PUT', `/api/shots/${uuid}/scene-state`, guard(async (req, [shotId]) => {
    sequences.needShot(shotId);
    const { start = null, end = null, events = [], transitions = [] } = await readBody(req, 32 * 1024);
    const value = { start, end, events, transitions, updatedAt: new Date().toISOString() };
    repo.settings.set(sceneStateKey(shotId), value);
    return { shotId, sceneState: value };
  }));
  route('GET', `/api/shots/${uuid}/scene-state`, guard((req, [shotId]) => ({ shotId, sceneState: repo.settings.get(sceneStateKey(shotId), null) })));

  // Validate a storyboard's plan: continuity of the declared scene states, and the exact timeline (runtime,
  // missing media, dialogue fit, frozen padding). Deterministic findings are separate from needs-review ones.
  route('GET', `/api/storyboards/${uuid}/validate`, guard(async (req, [id], url) => {
    const { sequence, shots } = sequences.detail(id);
    const states = shots.map((s) => repo.settings.get(sceneStateKey(s.id), null));
    const continuityShots = shots.map((s, i) => ({
      id: s.id, position: s.position, start: states[i]?.start ?? undefined, end: states[i]?.end ?? undefined,
      events: states[i]?.events ?? [], transitions: states[i]?.transitions ?? [], action: s.description,
      dialogue: (s.details.dialogue ?? []).map((l) => ({ speaker: l.speaker, text: l.text })),
    }));
    const declared = states.filter(Boolean).length;
    // Every shot stays in order (undeclared ones as placeholders), so only real neighbours are compared.
    const continuity = declared ? validateContinuity(continuityShots) : [];
    const timelineShots = [];
    for (const s of shots) {
      const clip = s.videoAssetId ? repo.assets.get(s.videoAssetId) : null;
      const clipSeconds = clip ? (await probe(assetStore.path(clip)).catch(() => null))?.duration ?? null : null;
      // A deleted recording counts as missing.
      const lines = (s.details.dialogue ?? []).map((l) => ({ ...l, assetId: l.assetId && repo.assets.get(l.assetId) ? l.assetId : null }));
      timelineShots.push({ ...s, clipSeconds, details: { ...s.details, dialogue: lines } });
    }
    const fps = Number(url.searchParams.get('fps')) || 24;
    const timeline = buildTimeline(timelineShots, { fps, transition: sequence.settings.transition === 'crossfade' ? 'crossfade' : 'cut' });
    const targetSeconds = Number(url.searchParams.get('targetSeconds')) || sequence.settings.targetSeconds || undefined;
    const toleranceSeconds = Number(url.searchParams.get('toleranceSeconds') ?? 3);
    const timing = validateTimeline(timeline, { targetSeconds, toleranceSeconds });
    const all = [...continuity, ...timing];
    return {
      storyboardId: id, scenesDeclared: `${declared} of ${shots.length} shots have a structured scene state`,
      blocking: all.filter((f) => f.severity === 'blocking'), warnings: all.filter((f) => f.severity !== 'blocking'),
      runtime: { seconds: timeline.totalSeconds, targetSeconds: targetSeconds ?? null, toleranceSeconds },
      note: 'Deterministic findings are proven from the declared plan; needs-review findings need a human or visual check. Nothing here verifies the pictures themselves.',
    };
  }));
}
