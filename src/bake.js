import { rm } from 'node:fs/promises';
import path from 'node:path';
import { RequestError } from './generation.js';

// "Bake character": train a small LoRA of one character for the local anime image model, from its character sheet
// and design tags (local/train_lora.py, on this computer's GPU, about 15-25 minutes). Afterwards every local anime
// frame with that character loads the LoRA and its trigger word, so the character stays on-model.
// The baked LoRA is recorded in settings under `bake:<characterId>`; jobs read it from there.
export const bakeKey = (characterId) => `bake:${characterId}`;
export const triggerFor = (characterId) => `lmn${characterId.replace(/[^a-f0-9]/g, '').slice(0, 8)}`;

export function createBakeService({ repo, assetStore, dir, trainer, log = console }) {
  const running = new Map(); // character id -> { state, stage, done, total, startedAt, error }

  function status(characterId) {
    const baked = repo.settings.get(bakeKey(characterId), null);
    return { characterId, baked: baked ? { trigger: baked.trigger, bakedAt: baked.bakedAt, scale: baked.scale, minutes: baked.minutes } : null, job: running.get(characterId) ?? null };
  }

  function start(characterId, { steps } = {}) {
    const character = repo.characters.get(characterId) ?? (() => { throw new RequestError(404, 'Character not found.'); })();
    if (character.kind === 'location') throw new RequestError(400, 'Only characters can be baked, not locations.');
    if (running.get(characterId)?.state === 'running') throw new RequestError(409, 'This character is already being baked.');
    if (!trainer) throw new RequestError(501, 'Baking needs the local anime model (Animagine XL 4.0) on this computer.');
    const tags = (character.designTags || character.description || '').trim();
    if (!tags) throw new RequestError(400, 'Give the character design tags (or a description) first.');
    const refs = character.referenceAssetIds.map((id) => repo.assets.get(id)).filter((a) => a?.mimeType?.startsWith('image/')).slice(0, 2).map((a) => assetStore.path(a));
    if (!refs.length) throw new RequestError(400, 'Make a character sheet (or add a reference picture) first; baking learns the character from it.');
    const job = { state: 'running', stage: 'drawing', done: 0, total: 0, startedAt: new Date().toISOString(), error: null };
    running.set(characterId, job);
    const out = path.join(dir, characterId);
    const trigger = triggerFor(characterId);
    const started = Date.now();
    trainer({ refs, tags, trigger, out, steps, seed: parseInt(characterId.slice(0, 6), 16) || 0 }, (done, total, stage) => Object.assign(job, { done, total, stage: stage ?? job.stage }))
      .then((result) => {
        if (!repo.characters.get(characterId)) return rm(out, { recursive: true, force: true });
        repo.settings.set(bakeKey(characterId), { path: result.lora, trigger, scale: 0.6, bakedAt: new Date().toISOString(), minutes: Math.round((Date.now() - started) / 60000) });
        Object.assign(job, { state: 'completed', stage: 'done' });
        return null;
      })
      .catch((error) => {
        log.error?.('Baking failed', { characterId, detail: error.message });
        Object.assign(job, { state: 'failed', error: error.message });
      });
    return status(characterId);
  }

  async function remove(characterId) {
    if (running.get(characterId)?.state === 'running') throw new RequestError(409, 'Wait for baking to finish.');
    repo.settings.set(bakeKey(characterId), null);
    running.delete(characterId);
    await rm(path.join(dir, characterId), { recursive: true, force: true });
    return status(characterId);
  }

  return { start, status, remove };
}
