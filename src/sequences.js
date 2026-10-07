import { extractJson } from './books.js';
import { nearestDuration, RequestError } from './generation.js';
import { presets } from './presets.js';
import { hasFfmpeg, stitchClips } from './video.js';

const cameraPresets = presets.filter((p) => p.group === 'camera');
const stylePresets = presets.filter((p) => p.group === 'style');
const aspects = { '16:9': '1536x1024', '9:16': '1024x1536', '1:1': '1024x1024' };
export const maxShots = 60;
export const maxTargetSeconds = 900;

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
  };
}

// Storyboards: an idea becomes a shot list, each shot gets a still frame and then a clip, and the clips are
// joined into one video.
export function createSequenceService({ repo, directors, keys, generations, assetStore, providers }) {
  const joining = new Map(); // storyboard id -> { state, done, total, error }
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
      sequence: { ...sequence, outputPath: asset(sequence.outputAssetId)?.path ?? null, join: joining.get(id) ?? null },
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
    const length = targetSeconds
      ? `The whole film should run about ${targetSeconds} seconds (${(targetSeconds / 60).toFixed(1)} minutes), so the shot durations must add up to roughly ${targetSeconds}. Tell the story with a clear beginning, middle and end across all ${count} shots.`
      : '';
    const prompt = [
      `Break this idea into a sequence of shots. SHOT_COUNT=${count}`,
      `Idea: ${sequence.idea}`,
      characterLines(sequence),
      length,
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
      duration: allowed ? nearestDuration(allowed, Number(shot?.duration) || 5) : Math.min(high, Math.max(low, Math.round(Number(shot?.duration)) || 5)),
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
        projectId: sequence.projectId, prompt: `Film still. ${shot.description}`.slice(0, 3900), ...choice(sequence, 'image', override),
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
    return {
      generation: generations.submit({
        projectId: sequence.projectId, operation: 'video', prompt: shot.description.slice(0, 3900), provider, model,
        duration: shot.duration, aspect: sequence.settings.aspect, inputAssetIds: shot.imageAssetId && repo.assets.get(shot.imageAssetId) ? [shot.imageAssetId] : [],
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
    const state = { state: 'running', done: 0, total: ready.length, skipped: clips.length - ready.length, error: null, duration: null };
    joining.set(id, state);
    const job = (async () => {
      try {
        const result = await stitchClips(ready.map((asset) => assetStore.path(asset)), { onProgress: (done) => { state.done = done; } });
        const asset = await assetStore.save({ bytes: result.bytes, projectId: sequence.projectId, kind: 'video', label: `${sequence.title} (storyboard)` });
        repo.sequences.update(id, { outputAssetId: asset.id });
        Object.assign(state, { state: 'completed', duration: result.duration });
      } catch (error) {
        Object.assign(state, { state: 'failed', error: `Could not join the clips: ${error.message}` });
      }
    })();
    if (wait) {
      await job;
      if (state.state === 'failed') throw new RequestError(502, state.error);
    }
    return { ...detail(id), joined: ready.length, skipped: state.skipped, duration: state.duration };
  }

  function onGenerationUpdate(generation) {
    if (generation.status !== 'completed' || !generation.bookTarget) return;
    const [kind, id] = generation.bookTarget.split(':');
    if (kind === 'shot-image' && repo.shots.get(id)) repo.shots.update(id, { imageAssetId: generation.assetId });
    if (kind === 'shot-video' && repo.shots.get(id)) repo.shots.update(id, { videoAssetId: generation.assetId });
  }

  return { detail, create, update, plan, generateFrame, animate, stitch, onGenerationUpdate, needShot, needSequence };
}
