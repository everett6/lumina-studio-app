import { extractJson } from './books.js';
import { nearestDuration, RequestError } from './generation.js';
import { presets } from './presets.js';
import { hasFfmpeg, lastFrame, stitchClips } from './video.js';

const cameraPresets = presets.filter((p) => p.group === 'camera');
const stylePresets = presets.filter((p) => p.group === 'style');
const aspects = { '16:9': '1536x1024', '9:16': '1024x1536', '1:1': '1024x1024' };
export const maxShots = 60;
export const maxTargetSeconds = 900;

const realism = 'Photorealistic live-action film footage, shot on a cinema camera: natural light and skin, real-world physics and motion, consistent characters and set from shot to shot.';

const system = 'You are a film director and storyboard artist. You break an idea into a short sequence of shots that cut together well: '
  + 'vary shot sizes and angles, keep continuity of characters, wardrobe, location and light between shots, and give each shot one clear action. '
  + 'Respond with JSON only, no markdown fences.';

export function cleanSequenceSettings(input = {}, base = {}) {
  const pick = (key, ok, fallback) => (ok(input[key]) ? input[key] : base[key] ?? fallback);
  const text = (v) => typeof v === 'string' && v.length < 200;
  return {
    shotCount: Math.min(maxShots, Math.max(1, Math.round(Number(input.shotCount ?? base.shotCount ?? 5)) || 5)),
    // Optional total running time the writer aims for (0 = let the shot count decide).
    targetSeconds: Math.min(maxTargetSeconds, Math.max(0, Math.round(Number(input.targetSeconds ?? base.targetSeconds ?? 0)) || 0)),
    aspect: pick('aspect', (v) => v in aspects, '16:9'),
    style: pick('style', (v) => v === '' || stylePresets.some((p) => p.id === v), ''),
    characterIds: Array.isArray(input.characterIds) ? input.characterIds.filter((id) => typeof id === 'string').slice(0, 4) : base.characterIds ?? [],
    imageProvider: pick('imageProvider', text, ''), imageModel: pick('imageModel', text, ''),
    videoProvider: pick('videoProvider', text, ''), videoModel: pick('videoModel', text, ''),
    // Film settings. continuity 'chain': each clip starts from the last frame of the one before, for unbroken
    // action; 'frames': every shot starts from its own still. clipLength: preferred seconds per clip (0 = writer
    // decides). realistic: direct everything as photoreal live action. transition and finish apply when joining.
    continuity: pick('continuity', (v) => ['frames', 'chain'].includes(v), 'frames'),
    clipLength: Math.min(30, Math.max(0, Math.round(Number(input.clipLength ?? base.clipLength ?? 0)) || 0)),
    realistic: typeof input.realistic === 'boolean' ? input.realistic : base.realistic ?? true,
    transition: pick('transition', (v) => ['cut', 'crossfade'].includes(v), 'cut'),
    finish: pick('finish', (v) => ['none', 'cinematic'].includes(v), 'none'),
  };
}

// Storyboards: an idea becomes a shot list, each shot gets a still frame and then a clip, and the clips are
// joined into one video.
export function createSequenceService({ repo, directors, keys, generations, assetStore, providers, enhancer, log = console }) {
  const joining = new Map(); // storyboard id -> { state, done, total, error }
  const producing = new Map(); // storyboard id -> { state, step, error }
  const needSequence = (id) => repo.sequences.get(id) ?? (() => { throw new RequestError(404, 'Storyboard not found.'); })();
  const needShot = (id) => repo.shots.get(id) ?? (() => { throw new RequestError(404, 'Shot not found.'); })();

  function latest(target) {
    const g = repo.generations.listByTarget(target)[0];
    return g ? { id: g.id, status: g.status, error: g.userError ?? null } : null;
  }

  function detail(id) {
    const sequence = needSequence(id);
    const asset = (assetId) => (assetId ? repo.assets.get(assetId) : null);
    return {
      sequence: { ...sequence, outputPath: asset(sequence.outputAssetId)?.path ?? null, join: joining.get(id) ?? null, production: producing.get(id) ?? null,
        enhance: sequence.outputAssetId ? enhancer?.status(sequence.outputAssetId) ?? null : null },
      shots: repo.shots.listBySequence(id).map((shot) => ({
        ...shot, imagePath: asset(shot.imageAssetId)?.path ?? null, videoPath: asset(shot.videoAssetId)?.path ?? null,
        frameJob: latest(`shot-image:${shot.id}`), clipJob: latest(`shot-video:${shot.id}`),
      })),
    };
  }

  function create({ projectId, title, idea, writer, settings }) {
    if (!repo.projects.get(projectId)) throw new RequestError(404, 'Project not found.');
    return repo.sequences.create({
      projectId, title, idea: String(idea ?? '').slice(0, 6000), writer: typeof writer === 'string' && writer ? writer : null, settings: cleanSequenceSettings(settings),
    });
  }

  function update(id, body) {
    const sequence = needSequence(id);
    return repo.sequences.update(id, {
      title: body.title, idea: typeof body.idea === 'string' ? body.idea.slice(0, 6000) : undefined,
      writer: body.writer === undefined ? undefined : body.writer || null,
      settings: body.settings ? cleanSequenceSettings(body.settings, sequence.settings) : undefined,
    });
  }

  function characterLines(sequence) {
    const list = (sequence.settings.characterIds ?? []).map((id) => repo.characters.get(id)).filter(Boolean);
    return list.length ? `Characters (use these names in the shots):\n${list.map((c) => `- ${c.name}: ${c.description}`).join('\n')}` : '';
  }

  async function plan(id, { writer, replace = false } = {}) {
    const sequence = needSequence(id);
    if (!sequence.idea.trim()) throw new RequestError(400, 'Describe the idea first.');
    if (repo.shots.listBySequence(id).length && !replace) throw new RequestError(409, 'This storyboard already has shots. Confirm to replace them.');
    const spec = writer || sequence.writer;
    if (!spec) throw new RequestError(400, 'Choose a writer model for this storyboard.');
    const [directorId, model] = spec.split(':');
    const director = directors.get(directorId);
    if (!director || !director.models.includes(model)) throw new RequestError(400, 'Unknown writer model.');
    const key = director.keyless ? null : keys.get(director.keyProvider);
    if (!director.keyless && !key) throw new RequestError(400, `Add a ${director.label} key in Settings to use this writer.`);
    const { shotCount: count, targetSeconds } = sequence.settings;
    const videoModel = providers?.model(sequence.settings.videoProvider, sequence.settings.videoModel);
    const allowed = videoModel?.durations?.length ? videoModel.durations : null;
    const [low, high] = allowed ? [Math.min(...allowed), Math.max(...allowed)] : [4, 10];
    const { clipLength, continuity } = sequence.settings;
    const fixed = clipLength ? (allowed ? nearestDuration(allowed, clipLength) : Math.min(high, Math.max(low, clipLength))) : 0;
    const length = targetSeconds
      ? `The whole film should run about ${targetSeconds} seconds (${(targetSeconds / 60).toFixed(1)} minutes), so the shot durations must add up to roughly ${targetSeconds}. Tell the story with a clear beginning, middle and end across all ${count} shots.`
      : '';
    const prompt = [
      `Break this idea into a sequence of shots. SHOT_COUNT=${count}`,
      `Idea: ${sequence.idea}`,
      characterLines(sequence),
      length,
      sequence.settings.realistic ? `Look: ${realism} Write every description as a live-action shot (real people, real places), never as animation or illustration.` : '',
      continuity === 'chain' ? 'Continuity: every clip will start from the exact last frame of the clip before it, so each shot must continue directly from where the previous one ends (same place, people and light, the action carrying on). Only move to a new place or time where the story needs a cut, and then say so at the start of that shot.' : '',
      fixed ? `Every shot lasts ${fixed} seconds; give each one enough action to fill that time.` : '',
      `Frame: ${sequence.settings.aspect}.`,
      `Camera moves you may use (by id): ${cameraPresets.map((p) => `${p.id} (${p.blurb})`).join('; ')}.`,
      `Return JSON: {"shots":[{"description":"what we see and what happens in this shot, in one or two sentences, written so it stands alone as an image prompt","camera":"one camera id from the list","duration":5}]} with exactly ${count} shots. Durations are whole seconds${allowed ? `, each one of: ${allowed.join(', ')}` : `, between ${low} and ${high}`}.`,
    ].filter(Boolean).join('\n\n');
    let text;
    try {
      text = await director.complete({ key, model, system, prompt, task: 'shots', maxTokens: Math.max(8000, count * 400) });
    } catch (error) {
      throw new RequestError(502, `Writer failed: ${error.detail || error.message}`);
    }
    const parsed = extractJson(text);
    const list = (Array.isArray(parsed.shots) ? parsed.shots : []).map((shot) => ({
      description: String(shot?.description ?? '').trim().slice(0, 2000),
      camera: cameraPresets.some((p) => p.id === shot?.camera) ? shot.camera : null,
      duration: fixed || (allowed ? nearestDuration(allowed, Number(shot?.duration) || 5) : Math.min(high, Math.max(low, Math.round(Number(shot?.duration)) || 5))),
    })).filter((shot) => shot.description).slice(0, maxShots);
    if (!list.length) throw new RequestError(502, 'The writer returned no shots. Try again.');
    repo.shots.replaceAll(id, list);
    return detail(id);
  }

  const choice = (sequence, kind, override = {}) => {
    const provider = override.provider || sequence.settings[`${kind}Provider`];
    const model = override.model || sequence.settings[`${kind}Model`];
    if (!provider || !model) throw new RequestError(400, `Choose ${kind === 'image' ? 'an image' : 'a video'} model for this storyboard first.`);
    return { provider, model };
  };

  function generateFrame(shotId, override) {
    const shot = needShot(shotId);
    const sequence = needSequence(shot.sequenceId);
    if (!shot.description.trim()) throw new RequestError(400, 'Describe this shot first.');
    return {
      generation: generations.submit({
        projectId: sequence.projectId, prompt: `${sequence.settings.realistic ? `Film still. ${realism}` : 'Film still.'} ${shot.description}`.slice(0, 3900), ...choice(sequence, 'image', override),
        size: aspects[sequence.settings.aspect], quality: 'high', presets: sequence.settings.style ? [sequence.settings.style] : [],
        characterIds: sequence.settings.characterIds, bookTarget: `shot-image:${shot.id}`,
      }),
    };
  }

  // Clips start from the shot's frame when the video model accepts a start image; otherwise from text alone.
  function animate(shotId, override) {
    const shot = needShot(shotId);
    const sequence = needSequence(shot.sequenceId);
    if (!shot.description.trim()) throw new RequestError(400, 'Describe this shot first.');
    const { provider, model } = choice(sequence, 'video', override);
    const takesImage = (providers?.model(provider, model)?.maxReferences ?? 1) > 0;
    return {
      generation: generations.submit({
        projectId: sequence.projectId, operation: 'video', prompt: (sequence.settings.realistic ? `${shot.description}\n\n${realism}` : shot.description).slice(0, 3900), provider, model,
        duration: shot.duration, aspect: sequence.settings.aspect, inputAssetIds: takesImage && shot.imageAssetId && repo.assets.get(shot.imageAssetId) ? [shot.imageAssetId] : [],
        presets: [shot.camera, sequence.settings.style].filter(Boolean), characterIds: sequence.settings.characterIds, bookTarget: `shot-video:${shot.id}`,
      }),
    };
  }

  // Joining runs in the background (a five-minute film can take several minutes); poll detail().join for
  // progress. `wait: true` resolves when the join finishes, for callers that want the result directly.
  async function stitch(id, { wait = false } = {}) {
    const sequence = needSequence(id);
    if (joining.get(id)?.state === 'running') throw new RequestError(409, 'This storyboard is already being joined.');
    const shots = repo.shots.listBySequence(id);
    const clips = shots.map((shot) => (shot.videoAssetId ? repo.assets.get(shot.videoAssetId) : null));
    const ready = clips.filter(Boolean);
    if (!ready.length) throw new RequestError(400, 'Animate at least one shot first.');
    if (!(await hasFfmpeg())) throw new RequestError(501, 'Joining clips needs ffmpeg, which is not installed on this computer (on Debian/Ubuntu: sudo apt install ffmpeg).');
    const state = { state: 'running', done: 0, total: ready.length + 1, clips: ready.length, skipped: clips.length - ready.length, error: null, duration: null };
    joining.set(id, state);
    const job = (async () => {
      try {
        const result = await stitchClips(ready.map((asset) => assetStore.path(asset)), {
          transition: sequence.settings.transition, finish: sequence.settings.finish, onProgress: (done, total) => Object.assign(state, { done, total }),
        });
        const asset = await assetStore.save({ bytes: result.bytes, projectId: sequence.projectId, kind: 'video', label: `${sequence.title} (storyboard)` });
        repo.sequences.update(id, { outputAssetId: asset.id });
        Object.assign(state, { state: 'completed', duration: result.duration });
        const production = producing.get(id);
        if (production?.state === 'running') Object.assign(production, { state: 'completed', step: `Done: ${Math.round(result.duration)} s film` });
      } catch (error) {
        Object.assign(state, { state: 'failed', error: `Could not join the clips: ${error.message}` });
        const production = producing.get(id);
        if (production?.state === 'running') Object.assign(production, { state: 'paused', error: state.error });
      }
    })();
    if (wait) {
      await job;
      if (state.state === 'failed') throw new RequestError(502, state.error);
    }
    return { ...detail(id), joined: ready.length, skipped: state.skipped, duration: state.duration };
  }

  // "Produce film": frames, clips and the join, run to the end without clicking through each shot.
  // Chained films go one shot at a time, each clip starting from the previous clip's last frame; otherwise all
  // frames are made, then all clips. A failure pauses production; producing again resumes where it stopped.
  async function produce(id) {
    const sequence = needSequence(id);
    const shots = repo.shots.listBySequence(id).filter((s) => s.description.trim());
    if (!shots.length) throw new RequestError(400, 'Plan or add shots first.');
    const video = choice(sequence, 'video');
    if (sequence.settings.continuity === 'chain' && !(providers?.model(video.provider, video.model)?.maxReferences > 0)) {
      throw new RequestError(400, 'Chained shots need a video model that can start from an image (for example Kling 3.0, Seedance 2.0 or Veo 3.1). Choose one, or switch continuity to separate frames.');
    }
    if (!shots[0].imageAssetId || sequence.settings.continuity !== 'chain') choice(sequence, 'image');
    if (!(await hasFfmpeg())) throw new RequestError(501, 'Producing a film needs ffmpeg to join the clips (on Debian/Ubuntu: sudo apt install ffmpeg).');
    if (producing.get(id)?.state === 'running') throw new RequestError(409, 'This film is already in production.');
    producing.set(id, { state: 'running', step: 'Starting', error: null, startedAt: Date.now() });
    await advance(id);
    return detail(id);
  }

  function stopProduction(id) {
    const production = producing.get(id);
    if (production?.state === 'running') Object.assign(production, { state: 'paused', step: 'Stopped (jobs already started will finish)' });
    return detail(id);
  }

  const busyJob = (target) => ['queued', 'running'].includes(latest(target)?.status);
  const advancing = new Set();
  const rerun = new Set(); // a job finished while advance() was busy: look again when it is done

  async function advance(id) {
    const production = producing.get(id);
    if (production?.state !== 'running') return;
    if (advancing.has(id)) {
      rerun.add(id);
      return;
    }
    advancing.add(id);
    try {
      const sequence = needSequence(id);
      const shots = repo.shots.listBySequence(id).filter((s) => s.description.trim());
      if (shots.some((s) => busyJob(`shot-image:${s.id}`) || busyJob(`shot-video:${s.id}`))) return;
      const total = shots.length;
      if (sequence.settings.continuity === 'chain') {
        const index = shots.findIndex((s) => !s.videoAssetId);
        if (index >= 0) {
          const shot = shots[index];
          if (index === 0) {
            if (!shot.imageAssetId) {
              production.step = `Shot 1 of ${total}: making the opening frame`;
              generateFrame(shot.id);
              return;
            }
          } else {
            // The previous clip's last frame becomes this shot's start frame.
            const previous = repo.assets.get(shots[index - 1].videoAssetId);
            const bytes = await lastFrame(assetStore.path(previous));
            const frame = await assetStore.save({ bytes, projectId: sequence.projectId, kind: 'image', label: `Shot ${shot.position} start (end of shot ${shots[index - 1].position})`, parentAssetId: previous.id });
            repo.shots.update(shot.id, { imageAssetId: frame.id });
          }
          production.step = `Shot ${index + 1} of ${total}: making the clip`;
          animate(shot.id);
          return;
        }
      } else {
        const needFrames = shots.filter((s) => !s.imageAssetId && !s.videoAssetId);
        if (needFrames.length) {
          production.step = `Making ${needFrames.length} frame(s)`;
          for (const shot of needFrames) generateFrame(shot.id);
          return;
        }
        const needClips = shots.filter((s) => !s.videoAssetId);
        if (needClips.length) {
          production.step = `Making ${needClips.length} clip(s) (${total - needClips.length} of ${total} done)`;
          for (const shot of needClips) animate(shot.id);
          return;
        }
      }
      production.step = 'Joining the clips';
      await stitch(id);
    } catch (error) {
      Object.assign(production, { state: 'paused', error: error.message });
    } finally {
      advancing.delete(id);
      if (rerun.delete(id)) await advance(id);
    }
  }

  function onGenerationUpdate(generation) {
    if (!generation.bookTarget) return;
    const [kind, id] = generation.bookTarget.split(':');
    if (kind !== 'shot-image' && kind !== 'shot-video') return;
    const shot = repo.shots.get(id);
    if (!shot) return;
    if (generation.status === 'completed') repo.shots.update(id, kind === 'shot-image' ? { imageAssetId: generation.assetId } : { videoAssetId: generation.assetId });
    const production = producing.get(shot.sequenceId);
    if (production?.state !== 'running') return;
    if (['failed', 'interrupted'].includes(generation.status)) {
      Object.assign(production, { state: 'paused', error: `Shot ${shot.position} ${kind === 'shot-image' ? 'frame' : 'clip'} failed: ${generation.userError ?? 'unknown error'}. Fix it, then press Produce film to continue.` });
      return;
    }
    if (generation.status === 'completed') advance(shot.sequenceId).catch((error) => log.error?.('Production step failed', { detail: error.message }));
  }

  return { detail, create, update, plan, generateFrame, animate, stitch, produce, stopProduction, onGenerationUpdate, needShot, needSequence };
}
