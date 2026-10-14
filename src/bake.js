import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { RequestError } from './generation.js';

// "Bake character": train a small LoRA of one character for the local anime image model, from its character sheet
// and design tags (local/train_lora.py, on this computer's GPU, about 15-25 minutes). Afterwards every local anime
// frame with that character loads the LoRA and its trigger word, so the character stays on-model.
//
// Baking has a review step so bad pictures are never learned: "drawing" (the trainer draws ~16 pictures and stops)
// -> "review" (the person, or an MCP client, approves or rejects each picture, can redraw rejected ones and turns
// the mirrored copy off per picture) -> "training" (only approved pictures, at least MIN_APPROVED) -> "completed".
// {auto: true} keeps the old one-shot behaviour: draw and train on everything in one go.
// The baked LoRA is recorded in settings under `bake:<characterId>`; jobs read it from there.
export const bakeKey = (characterId) => `bake:${characterId}`;
export const triggerFor = (characterId) => `lmn${characterId.replace(/[^a-f0-9]/g, '').slice(0, 8)}`;

export const MIN_APPROVED = 8;
const reviewKey = (characterId) => `bake-review:${characterId}`;
const busy = (job) => job?.state === 'drawing' || job?.state === 'training';

export function createBakeService({ repo, assetStore, dir, trainer, log = console }) {
  const running = new Map(); // character id -> { state, stage, done, total, startedAt, error, auto }
  const outOf = (characterId) => path.join(dir, characterId);

  // The review (which pictures are approved, mirror flags, redraw counts) lives in settings so it survives a restart.
  const reviewOf = (characterId) => ({ approved: {}, mirror: {}, revs: {}, mirrorOk: true, redraws: 0, ...repo.settings.get(reviewKey(characterId), null) });
  const saveReview = (characterId, review) => repo.settings.set(reviewKey(characterId), review);

  function listPictures(characterId) {
    try {
      const entries = JSON.parse(readFileSync(path.join(outOf(characterId), 'pictures.json'), 'utf8'));
      return Array.isArray(entries) ? entries : [];
    } catch { return []; }
  }

  function picturesOf(characterId) {
    const review = reviewOf(characterId);
    return listPictures(characterId).map((entry, index) => ({
      index, framing: entry.framing, file: entry.file,
      url: `/api/characters/${characterId}/bake/pictures/${index}?v=${review.revs[index] ?? 0}`,
      approved: review.approved[index] ?? null, mirror: review.mirror[index] ?? review.mirrorOk,
    }));
  }

  function status(characterId) {
    const baked = repo.settings.get(bakeKey(characterId), null);
    let job = running.get(characterId) ?? null;
    const pictures = picturesOf(characterId);
    // After a restart the pictures are still on disk: pick the review up again.
    if (!job && pictures.length) job = { state: 'review', stage: 'review', done: 0, total: 0, startedAt: null, error: null, auto: false };
    const shown = pictures;
    const review = reviewOf(characterId);
    return {
      characterId,
      baked: baked ? { trigger: baked.trigger, bakedAt: baked.bakedAt, scale: baked.scale, minutes: baked.minutes } : null,
      job: job ? { ...job, busy: busy(job) } : null,
      pictures: shown,
      review: shown.length ? { approved: shown.filter((p) => p.approved === true).length, rejected: shown.filter((p) => p.approved === false).length, undecided: shown.filter((p) => p.approved === null).length, mirrorOk: review.mirrorOk, minApproved: MIN_APPROVED } : null,
    };
  }

  function guard(characterId) {
    const character = repo.characters.get(characterId) ?? (() => { throw new RequestError(404, 'Character not found.'); })();
    if (character.kind === 'location') throw new RequestError(400, 'Only characters can be baked, not locations.');
    if (busy(running.get(characterId))) throw new RequestError(409, 'This character is being baked right now.');
    if (!trainer) throw new RequestError(501, 'Baking needs the local anime model (Animagine XL 4.0) on this computer.');
    return character;
  }

  function inputs(characterId, character) {
    const tags = (character.designTags || character.description || '').trim();
    if (!tags) throw new RequestError(400, 'Give the character design tags (or a description) first.');
    const refs = character.referenceAssetIds.map((id) => repo.assets.get(id)).filter((a) => a?.mimeType?.startsWith('image/')).slice(0, 2).map((a) => assetStore.path(a));
    if (!refs.length) throw new RequestError(400, 'Make a character sheet (or add a reference picture) first; baking learns the character from it.');
    return { tags, refs, trigger: triggerFor(characterId), out: outOf(characterId), seed: parseInt(characterId.slice(0, 6), 16) || 0 };
  }

  // Runs one trainer task and moves the job to `after` when it finishes.
  function run(characterId, startState, payload, onDone, onFail) {
    const job = { state: startState, stage: startState === 'training' ? 'training' : 'drawing', done: 0, total: 0, startedAt: new Date().toISOString(), error: null, auto: payload.task === 'bake' };
    running.set(characterId, job);
    trainer(payload, (done, total, stage) => {
      Object.assign(job, { done, total });
      if (stage) Object.assign(job, { stage }, stage === 'drawing' || stage === 'training' ? { state: stage } : {});
    })
      .then(async (result) => {
        if (!repo.characters.get(characterId)) { running.delete(characterId); await rm(outOf(characterId), { recursive: true, force: true }); return; }
        await onDone(result, job);
      })
      .catch((error) => {
        log.error?.('Baking failed', { characterId, detail: error.message });
        Object.assign(job, { state: 'failed', error: error.message });
        onFail?.();
      });
    return job;
  }

  async function finish(characterId, result, job, trigger, started) {
    repo.settings.set(bakeKey(characterId), { path: result.lora, trigger, scale: 0.6, bakedAt: new Date().toISOString(), minutes: Math.round((Date.now() - started) / 60000) });
    repo.settings.set(reviewKey(characterId), null);
    await rm(path.join(outOf(characterId), 'pictures'), { recursive: true, force: true });
    await rm(path.join(outOf(characterId), 'pictures.json'), { force: true });
    Object.assign(job, { state: 'completed', stage: 'done' });
  }

  async function start(characterId, { steps, auto = false, mirrorOk = true } = {}) {
    const character = guard(characterId);
    const base = inputs(characterId, character);
    await rm(path.join(base.out, 'pictures'), { recursive: true, force: true });
    await rm(path.join(base.out, 'pictures.json'), { force: true });
    saveReview(characterId, { approved: {}, mirror: {}, revs: {}, mirrorOk: mirrorOk !== false, redraws: 0 });
    const started = Date.now();
    if (auto) run(characterId, 'drawing', { task: 'bake', ...base, steps, mirror: mirrorOk !== false }, (result, job) => finish(characterId, result, job, base.trigger, started));
    else run(characterId, 'drawing', { task: 'bake-draw', ...base }, (result, job) => {
      Object.assign(job, { state: 'review', stage: 'review', done: 0, total: 0 });
      if (!listPictures(characterId).length) throw new Error('The trainer drew no pictures.');
    });
    return status(characterId);
  }

  function needReview(characterId) {
    guard(characterId);
    if (!listPictures(characterId).length) throw new RequestError(409, 'There are no drawn pictures to review. Start baking first.');
  }

  const indexList = (value, count, what) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((i) => !Number.isInteger(i) || i < 0 || i >= count)) throw new RequestError(400, `${what} must be picture numbers between 0 and ${count - 1}.`);
    return [...new Set(value)];
  };

  // Approve / reject pictures and set per-picture mirror flags (and the character-wide default, mirrorOk).
  function review(characterId, { approved, rejected, mirror, mirrorOk } = {}) {
    needReview(characterId);
    const count = listPictures(characterId).length;
    const current = reviewOf(characterId);
    const yes = indexList(approved, count, 'approved');
    const no = indexList(rejected, count, 'rejected');
    if (yes.some((i) => no.includes(i))) throw new RequestError(400, 'A picture cannot be both approved and rejected.');
    for (const i of yes) current.approved[i] = true;
    for (const i of no) current.approved[i] = false;
    if (mirror !== undefined) {
      if (!mirror || typeof mirror !== 'object' || Array.isArray(mirror)) throw new RequestError(400, 'mirror must map picture numbers to true or false.');
      for (const [key, value] of Object.entries(mirror)) {
        if (!/^\d+$/.test(key) || Number(key) >= count || typeof value !== 'boolean') throw new RequestError(400, 'mirror must map picture numbers to true or false.');
        current.mirror[Number(key)] = value;
      }
    }
    if (mirrorOk !== undefined) {
      current.mirrorOk = mirrorOk !== false;
      current.mirror = {}; // the character-wide switch replaces earlier per-picture choices
    }
    saveReview(characterId, current);
    return status(characterId);
  }

  // Draw the given pictures again with new seeds (default: every rejected one); they come back undecided.
  function redraw(characterId, { indexes } = {}) {
    needReview(characterId);
    const count = listPictures(characterId).length;
    const current = reviewOf(characterId);
    const chosen = indexes === undefined ? Object.keys(current.approved).filter((i) => current.approved[i] === false).map(Number) : indexList(indexes, count, 'indexes');
    if (!chosen.length) throw new RequestError(400, 'Nothing to redraw: reject some pictures first, or pass indexes.');
    const base = inputs(characterId, repo.characters.get(characterId));
    current.redraws += 1;
    const seeds = chosen.map((i) => base.seed + current.redraws * 7919 + i * 31);
    for (const i of chosen) { delete current.approved[i]; current.revs[i] = (current.revs[i] ?? 0) + 1; }
    saveReview(characterId, current);
    run(characterId, 'drawing', { task: 'bake-redraw', ...base, indexes: chosen, seeds }, (result, job) => Object.assign(job, { state: 'review', stage: 'review', done: 0, total: 0 }));
    return status(characterId);
  }

  // Train on the approved pictures only.
  function train(characterId, { steps } = {}) {
    needReview(characterId);
    const current = reviewOf(characterId);
    const chosen = picturesOf(characterId).filter((p) => p.approved === true);
    if (chosen.length < MIN_APPROVED) throw new RequestError(400, `Approve at least ${MIN_APPROVED} pictures first (${chosen.length} approved). Redraw the rejected ones if too few are left.`);
    const base = inputs(characterId, repo.characters.get(characterId));
    const started = Date.now();
    const pictures = chosen.map((p) => ({ file: p.file, framing: p.framing, mirror: current.mirror[p.index] ?? current.mirrorOk }));
    run(characterId, 'training', { task: 'bake-train', ...base, steps, pictures }, (result, job) => finish(characterId, result, job, base.trigger, started));
    return status(characterId);
  }

  // The path of one drawn picture for the safe picture route (a number into pictures.json, never a client path).
  function pictureFile(characterId, index) {
    const entry = listPictures(characterId)[index];
    if (!entry) throw new RequestError(404, 'No such picture.');
    return path.join('pictures', path.basename(entry.file));
  }

  async function remove(characterId) {
    if (busy(running.get(characterId))) throw new RequestError(409, 'Wait for baking to finish.');
    repo.settings.set(bakeKey(characterId), null);
    repo.settings.set(reviewKey(characterId), null);
    running.delete(characterId);
    await rm(outOf(characterId), { recursive: true, force: true });
    return status(characterId);
  }

  return { start, status, review, redraw, train, remove, pictureFile, dir };
}
