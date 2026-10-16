import { createAnimatic, cutTransitions, editTimeline, overlayPositions, overlayStyles, playbackSeconds, renderEdit } from './animatic.js';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractJson } from './books.js';
import { confirmSpend, nearestDuration, providerPrompt, RequestError } from './generation.js';
import { presets } from './presets.js';
import { priceFor } from './pricing.js';
import { colourStats, curveFilter, matchCurve } from './grade.js';
import { animeChecks, checkClip, driftChecks, identityNotVerified, suggestedStatus, withStatus } from './qc.js';
import { imageSize } from './assets.js';
import { encodePng } from './png.js';
import { lineTimes, mixSoundtrack } from './soundtrack.js';
import { deliverFilm, filmFps, hasFfmpeg, lastFrame, mediaSeconds, probe, renderStill, run, stillMotions, stitchClips } from './video.js';
import { drawMouths, findMouth, lipSync, lipSyncInstalled } from './providers/local.js';
import { writeFile } from 'node:fs/promises';

const cameraPresets = presets.filter((p) => p.group === 'camera');
const stylePresets = presets.filter((p) => p.group === 'style');
const aspects = { '16:9': '1536x1024', '9:16': '1024x1536', '1:1': '1024x1024' };
const ratios = { '16:9': [16, 9], '9:16': [9, 16], '1:1': [1, 1] };
export const maxShots = 60;
export const maxTargetSeconds = 900;
export const reviewStatuses = ['pending', 'accepted', 'needs_review', 'needs_repair', 'needs_regeneration', 'rejected'];
const fadeSeconds = 0.5;

// How each look is directed. Every frame and clip prompt carries the same look line, the film's look bible and
// the same seed, so the models' free choices (faces, palette, lens, grain) don't wander from shot to shot.
const looks = {
  'live-action': 'Photorealistic live-action film footage, shot on a cinema camera: natural light and skin, real-world physics and motion.',
  anime: 'High-end Japanese anime feature film: clean consistent line art, cel shading, painterly backgrounds, on-model characters in every frame, smooth deliberate animation.',
  'as-written': '',
};
const consistency = 'Consistency: identical faces, hairstyles, body shapes, clothing and colours to the references and earlier shots; the same location layout, props and lighting; no extra people; no captions, text or watermarks.';

const system = 'You are a film director and storyboard artist. You break an idea into a sequence of shots that cut together well: '
  + 'vary shot sizes and angles, keep continuity of characters, wardrobe, location and light between shots, and give each shot one clear action. '
  + 'Respond with JSON only, no markdown fences.';

export function cleanSequenceSettings(input = {}, base = {}) {
  const pick = (key, ok, fallback) => (ok(input[key]) ? input[key] : base[key] ?? fallback);
  const text = (v) => typeof v === 'string' && v.length < 200;
  const volume = (key, fallback) => Math.min(2, Math.max(0, Number(input[key] ?? base[key] ?? fallback)));
  const bed = (key) => {
    const value = input[key] === undefined ? base[key] : input[key];
    return value?.assetId ? { assetId: String(value.assetId), volume: Math.min(2, Math.max(0, Number(value.volume ?? 0.3))) } : null;
  };
  // Music that changes per scene: from the start of shot `shotId` the film plays `assetId` until the next cue
  // (crossfaded). settings.music plays before the first cue.
  const cues = (value) => (Array.isArray(value) ? value.filter((c) => c && typeof c.shotId === 'string' && c.assetId)
    .slice(0, 20).map((c) => ({ shotId: c.shotId, assetId: String(c.assetId), volume: Math.min(2, Math.max(0, Number(c.volume ?? 0.3))) })) : null);
  const voice = (value) => (value && typeof value.provider === 'string' && typeof value.model === 'string'
    ? { provider: value.provider, model: value.model, voice: typeof value.voice === 'string' ? value.voice : null } : null);
  // Older storyboards stored realistic: true/false instead of a look.
  const legacyLook = base.look ?? (base.realistic === false ? 'as-written' : 'live-action');
  return {
    shotCount: Math.min(maxShots, Math.max(1, Math.round(Number(input.shotCount ?? base.shotCount ?? 5)) || 5)),
    // Optional total running time the writer aims for (0 = let the shot count decide).
    targetSeconds: Math.min(maxTargetSeconds, Math.max(0, Math.round(Number(input.targetSeconds ?? base.targetSeconds ?? 0)) || 0)),
    aspect: pick('aspect', (v) => v in aspects, '16:9'),
    style: pick('style', (v) => v === '' || stylePresets.some((p) => p.id === v), ''),
    characterIds: Array.isArray(input.characterIds) ? input.characterIds.filter((id) => typeof id === 'string').slice(0, 8) : base.characterIds ?? [],
    imageProvider: pick('imageProvider', text, ''), imageModel: pick('imageModel', text, ''),
    videoProvider: pick('videoProvider', text, ''), videoModel: pick('videoModel', text, ''),
    // continuity 'frames': every clip starts from its own approved still. 'keyframes': it also ends on the next
    // shot's still (same scene, models with last-frame support) — the strongest guard against drift. 'chain':
    // each clip starts from the last frame of the clip before, for unbroken action.
    continuity: pick('continuity', (v) => ['frames', 'keyframes', 'chain'].includes(v), 'frames'),
    clipLength: Math.min(30, Math.max(0, Math.round(Number(input.clipLength ?? base.clipLength ?? 0)) || 0)),
    look: pick('look', (v) => v in looks, legacyLook),
    // Mouth movement on shots with recorded dialogue (anime flaps / live-action MuseTalk). On unless turned off.
    lipSync: typeof input.lipSync === 'boolean' ? input.lipSync : typeof base.lipSync === 'boolean' ? base.lipSync : false, // off unless turned on
    lookBible: typeof input.lookBible === 'string' ? input.lookBible.slice(0, 1500) : base.lookBible ?? '',
    // Themes the audience must clearly see, e.g. "Chaos agent: a grinning trickster who breaks every plan". The writer
    // gives each one people, actions and a recurring image on screen, and tags the shots that carry it.
    themes: Array.isArray(input.themes) ? input.themes.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 300)).slice(0, 8) : base.themes ?? [],
    // One seed for every frame and clip (where the model accepts one). New storyboards get a random one.
    seed: input.seed === null ? null : Number.isInteger(Number(input.seed ?? base.seed)) && (input.seed ?? base.seed) !== undefined
      ? Math.abs(Math.trunc(Number(input.seed ?? base.seed))) % 2147483647 : Math.floor(Math.random() * 2147483646) + 1,
    transition: pick('transition', (v) => ['cut', 'crossfade'].includes(v), 'cut'),
    finish: pick('finish', (v) => ['none', 'cinematic', 'anime'].includes(v), 'none'),
    // Delivery: assemble/mix at master size, then upscale the completed film.
    outputHeight: pick('outputHeight', (v) => [720, 1080, 1440, 2160].includes(v), 1080),
    upscale: pick('upscale', (v) => ['none', 'fast', 'anime', 'ai'].includes(v), 'none'),
    interpolateFps: pick('interpolateFps', (v) => [0, 30].includes(v), 0),
    // Colour matching between shots: 'scene' matches every shot to the first shot of its scene, 'film' to the first
    // shot of the film, 'off' leaves the models' colours as they are.
    colorMatch: pick('colorMatch', (v) => ['off', 'scene', 'film'].includes(v), 'scene'),
    requireApproval: typeof input.requireApproval === 'boolean' ? input.requireApproval : base.requireApproval ?? false,
    // Seconds of generated video the writer may plan; other shots become free still shots (0 = no limit).
    videoSecondsBudget: Math.min(maxTargetSeconds, Math.max(0, Math.round(Number(input.videoSecondsBudget ?? base.videoSecondsBudget ?? 0)) || 0)),
    music: bed('music'), ambience: bed('ambience'), musicCues: input.musicCues === undefined ? base.musicCues ?? [] : cues(input.musicCues) ?? [],
    clipVolume: volume('clipVolume', 1),
    narratorVoice: input.narratorVoice === undefined ? base.narratorVoice ?? null : voice(input.narratorVoice),
  };
}

// Normalize and select only settings consumed by the film pipeline (including smoothing's look).
function joinSettingsFingerprint(settings) {
  const clean = cleanSequenceSettings(settings);
  return createHash('sha256').update(JSON.stringify([
    clean.music, clean.ambience, clean.musicCues, clean.clipVolume, clean.finish, clean.outputHeight, clean.aspect,
    clean.transition, clean.colorMatch, clean.upscale, clean.interpolateFps, clean.narratorVoice, clean.look,
  ])).digest('hex');
}

// Everything a shot must keep: who and where, what happens, what is said, how it starts and ends, what must not
// change. `locked` freezes the story fields (description, dialogue, states) until a deliberate revision.
// Themes are written as "Name: how it shows on screen" (the part after the colon is optional).
const themeParts = (theme) => {
  const at = theme.indexOf(':');
  return at > 0 ? [theme.slice(0, at).trim(), theme.slice(at + 1).trim()] : [theme.trim(), ''];
};
// The writer's theme label matched back to one of the film's themes (by name, ignoring case).
function themeName(themes = [], label) {
  const wanted = String(label ?? '').trim().toLowerCase();
  return themes.map((t) => themeParts(t)[0]).find((name) => name.toLowerCase() === wanted || (wanted && wanted.startsWith(name.toLowerCase()))) ?? null;
}
// What a theme looks like, for the prompts of the shots that carry it.
function themeVisual(themes = [], name) {
  const theme = themes.find((t) => themeParts(t)[0] === name);
  if (!theme) return '';
  const [label, look] = themeParts(theme);
  return `Theme on screen: ${label}${look ? ` (${look})` : ''}; make it unmistakable in the image.`;
}
function themeBrief(themes = [], count) {
  if (!themes.length) return '';
  const each = Math.max(2, Math.round(count / (themes.length + 1)));
  return `Themes the audience must clearly SEE, not only hear about:\n${themes.map((t) => `- ${t}`).join('\n')}\n`
    + `For each theme: give it a person, place or object that embodies it, a recurring image or motif that comes back, and actions that show it; `
    + `show each theme in at least ${Math.min(each, count)} shots spread across the film (beginning, middle and end), and let the climax bring them into open conflict. `
    + 'List the themes each shot shows in its "themes" field, using the names before the colon.';
}

// Where each theme appears: shot positions per theme name, and the names that never appear.
export function themeCoverage(themes = [], shots = []) {
  const names = themes.map((t) => themeParts(t)[0]);
  const where = Object.fromEntries(names.map((name) => [name, shots.filter((shot) => shot.details?.themes?.includes(name)).map((shot) => shot.position)]));
  return { where, missing: names.filter((name) => !where[name].length) };
}

// A shot's own look ("make shot 3 darker"), applied when the film is joined. Neutral values are dropped.
const gradeLimits = { brightness: [-0.3, 0.3, 0], contrast: [0.5, 1.5, 1], saturation: [0, 2, 1], warmth: [-1, 1, 0] };
export function cleanGrade(input = {}) {
  const grade = {};
  for (const [key, [min, max, neutral]] of Object.entries(gradeLimits)) {
    const value = Number(input[key]);
    if (input[key] == null || !Number.isFinite(value)) continue;
    const clamped = Math.round(Math.min(max, Math.max(min, value)) * 1000) / 1000;
    if (clamped !== neutral) grade[key] = clamped;
  }
  return Object.keys(grade).length ? grade : null;
}
// The ffmpeg filter for a grade: eq for brightness/contrast/saturation, colour balance for warmth.
export function gradeFilter(grade) {
  if (!grade) return '';
  const parts = [];
  const { brightness = 0, contrast = 1, saturation = 1, warmth = 0 } = grade;
  if (brightness || contrast !== 1 || saturation !== 1) parts.push(`eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}`);
  if (warmth) {
    const w = (warmth * 0.15).toFixed(3);
    const c = (-warmth * 0.15).toFixed(3);
    parts.push(`colorbalance=rs=${w}:rm=${w}:bs=${c}:bm=${c}`);
  }
  return parts.join(',');
}

// Anime exposure ("timing"): how long each drawing stays on screen. 'twos'/'threes' hold every drawing 2/3 frames at the
// film's frame rate; 'ones' draws a new picture every frame; 'auto' leaves the clip as it is. `holds` freeze the picture
// for a span of seconds from the start of the shot (after the trim).
export const shotTimings = ['auto', 'ones', 'twos', 'threes'];
const holdsOf = (input) => {
  if (!Array.isArray(input)) return null;
  const clean = input.slice(0, 8).map((hold) => ({ start: Math.round(Math.min(600, Number(hold?.start)) * 1000) / 1000, seconds: Math.round(Math.min(10, Number(hold?.seconds)) * 1000) / 1000 }))
    .filter((hold) => Number.isFinite(hold.start) && hold.start >= 0 && Number.isFinite(hold.seconds) && hold.seconds > 0)
    .sort((a, b) => a.start - b.start);
  return clean.filter((hold, i) => i === 0 || hold.start >= clean[i - 1].start + clean[i - 1].seconds); // overlapping holds are dropped
};
// The ffmpeg filter that gives a clip its exposure at `rate` frames per second ('' when nothing changes).
export function exposureFilter(details = {}, rate = 24) {
  const parts = [];
  const step = { twos: 2, threes: 3 }[details.timing];
  if (step) parts.push(`fps=${(rate / step).toFixed(6)}`, `fps=${rate}`); // keep every Nth drawing, then repeat it up to the film rate
  // A hold drops the frames after its first one and keeps their time slots; the second fps filter then repeats the
  // held frame into the gap (the same trick works the same way in every ffmpeg version).
  const dropped = (details.holds ?? []).map((hold) => {
    const first = Math.round(hold.start * rate);
    const extra = Math.round(hold.seconds * rate) - 1; // the drawing already shows once; `extra` more frames freeze
    return extra >= 1 ? `between(n,${first + 1},${first + extra})` : null;
  }).filter(Boolean);
  if (dropped.length) parts.push(`fps=${rate}`, `select='not(${dropped.join('+')})'`, `fps=${rate}`);
  return parts.join(',');
}
// Frame interpolation (RIFE) would smear the held drawings of anime timing, so it is skipped for those shots, and
// anime storyboards only smooth shots on 'auto' timing when asked (the shot's interpolate switch, or the storyboard's
// "smooth to 30 fps" setting, passed as `wanted`).
export function skipsSmoothing(details, look, wanted = false) {
  return ['twos', 'threes'].includes(details.timing) || (details.holds?.length ?? 0) > 0 || (look === 'anime' && (details.timing ?? 'auto') === 'auto' && !details.interpolate && !wanted);
}

export function cleanShotDetails(input = {}, base = {}) {
  const str = (key, max) => (typeof input[key] === 'string' ? input[key].slice(0, max) : base[key] ?? '');
  const directorText = (key) => input[key] === null ? null : typeof input[key] === 'string' ? input[key] : base[key] ?? null;
  const ids = (key, max) => (Array.isArray(input[key]) ? [...new Set(input[key].filter((id) => typeof id === 'string'))].slice(0, max) : base[key] ?? []);
  const dialogue = Array.isArray(input.dialogue)
    ? input.dialogue.slice(0, 12).map((line, i) => {
      const previous = base.dialogue?.[i];
      const textValue = String(line?.text ?? '').trim().slice(0, 1000);
      const speaker = typeof line?.speaker === 'string' ? line.speaker : 'narrator';
      const same = previous && previous.text === textValue && previous.speaker === speaker && (previous.style ?? '') === (line.style ?? previous.style ?? '');
      return {
        speaker, text: textValue, style: typeof line?.style === 'string' ? line.style.slice(0, 500) : previous?.style ?? '', start: Number.isFinite(Number(line?.start)) && line?.start !== null && line?.start !== '' ? Math.max(0, Number(line.start)) : null,
        // Recorded audio stays only while the words and speaker are unchanged.
        assetId: same ? previous.assetId ?? null : null, seconds: same ? previous.seconds ?? null : null,
      };
    }).filter((line) => line.text)
    : base.dialogue ?? [];
  return {
    directorFramePrompt: directorText('directorFramePrompt'), directorClipPrompt: directorText('directorClipPrompt'),
    directorNegative: directorText('directorNegative'),
    directorKeepAutomatic: typeof input.directorKeepAutomatic === 'boolean' ? input.directorKeepAutomatic : base.directorKeepAutomatic ?? true,
    scene: str('scene', 80), locationId: typeof input.locationId === 'string' || input.locationId === null ? input.locationId : base.locationId ?? null,
    characterIds: ids('characterIds', 6), action: str('action', 1000), dialogue,
    themes: Array.isArray(input.themes) ? [...new Set(input.themes.filter((t) => typeof t === 'string').map((t) => t.trim().slice(0, 60)).filter(Boolean))].slice(0, 4) : base.themes ?? [],
    startState: str('startState', 500), endState: str('endState', 500), forbidden: str('forbidden', 500),
    method: ['video', 'still'].includes(input.method) ? input.method : base.method ?? 'video',
    motion: stillMotions.includes(input.motion) ? input.motion : base.motion ?? 'push-in',
    model: typeof input.model === 'string' && /^[\w.-]+\|[\w./:-]+$/.test(input.model) ? input.model : input.model === '' ? '' : base.model ?? '',
    interpolate: typeof input.interpolate === 'boolean' ? input.interpolate : base.interpolate ?? false,
    timing: shotTimings.includes(input.timing) ? input.timing : shotTimings.includes(base.timing) ? base.timing : 'auto',
    holds: input.holds === null ? [] : holdsOf(input.holds) ?? holdsOf(base.holds) ?? [],
    speed: Number.isFinite(input.speed) && input.speed >= 0.25 && input.speed <= 4 ? input.speed : base.speed ?? 1,
    keepPitch: typeof input.keepPitch === 'boolean' ? input.keepPitch : base.keepPitch ?? true,
    cutTransition: input.cutTransition === null ? null : cutTransitions.includes(input.cutTransition?.transition) && Number.isFinite(input.cutTransition.seconds) && input.cutTransition.seconds >= 0 && input.cutTransition.seconds <= 10 ? { transition: input.cutTransition.transition, seconds: input.cutTransition.seconds } : base.cutTransition ?? null,
    overlays: Array.isArray(input.overlays) ? input.overlays.filter((o) => typeof o?.text === 'string' && o.text.trim() && overlayPositions.includes(o.position) && overlayStyles.includes(o.style) && Number.isFinite(o.start) && o.start >= 0 && Number.isFinite(o.seconds) && o.seconds > 0).slice(0, 24).map((o) => ({ text: o.text.slice(0, 2000), position: o.position, style: o.style, start: o.start, seconds: o.seconds })) : base.overlays ?? [],
    // Public trim edits keep their existing 10-second limit; internal splits may retain a later source in-point.
    trimStart: Math.min(input.trimStart === undefined ? 600 : 10, Math.max(0, Number(input.trimStart ?? base.trimStart ?? 0) || 0)),
    // Sound effects placed in the shot: `at` seconds after the shot starts, at `volume` (mixed on their own bus).
    sfx: Array.isArray(input.sfx) ? input.sfx.filter((e) => e?.assetId).slice(0, 12).map((e) => ({
      assetId: String(e.assetId), at: Math.min(30, Math.max(0, Number(e.at) || 0)), volume: Math.min(2, Math.max(0, Number(e.volume ?? 0.8))),
      label: typeof e.label === 'string' ? e.label.slice(0, 80) : '',
    })) : base.sfx ?? [],
    muteClipSound: typeof input.muteClipSound === 'boolean' ? input.muteClipSound : base.muteClipSound ?? false,
    locked: typeof input.locked === 'boolean' ? input.locked : base.locked ?? false,
    grade: input.grade === null ? null : input.grade && typeof input.grade === 'object' ? cleanGrade(input.grade) : base.grade ? cleanGrade(base.grade) : null,
    post: base.post ?? {}, // cached derived clips (upscaled / interpolated), keyed by source and settings
    lipsync: base.lipsync ?? null, // { source, result, mode, box } once the clip has been lip-synced
    attachedClips: base.attachedClips ?? [], // imported video assets attached to this shot as clip takes
  };
}

// Storyboards: an idea (or a screenplay) becomes a shot list, each shot gets an approved still frame and then a
// clip (or a free still shot), and the clips, dialogue and music become one finished film.
export function createSequenceService({ repo, directors, keys, generations, assetStore, providers, enhancer, budget = null, faces = null, log = console, progressOf = () => null }) {
  const joining = new Map(); // storyboard id -> { state, done, total, error }
  const pending = new Set(); // background checks and probes, awaited on shutdown
  const track = (promise) => {
    pending.add(promise);
    promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  };
  const idle = async () => { while (pending.size) await Promise.allSettled([...pending]); };
  const producing = new Map(); // storyboard id -> { state, step, error }
  const needSequence = (id) => repo.sequences.get(id) ?? (() => { throw new RequestError(404, 'Storyboard not found.'); })();
  // Shots added by hand (or made before details existed) get every detail field filled in on read.
  const normal = (shot) => (shot ? { ...shot, details: cleanShotDetails({}, shot.details ?? {}), review: shot.review ?? {} } : null);
  const getShot = (id) => normal(repo.shots.get(id));
  const shotsOf = (sequenceId) => repo.shots.listBySequence(sequenceId).map(normal);
  const needShot = (id) => getShot(id) ?? (() => { throw new RequestError(404, 'Shot not found.'); })();
  const asset = (assetId) => (assetId ? repo.assets.get(assetId) : null);

  function latest(target) {
    const g = repo.generations.listByTarget(target)[0];
    return g ? { id: g.id, status: g.status, error: g.userError ?? null, billing: g.billing ?? null, provider: g.provider, progress: g.status === 'running' ? progressOf(g.id) : null } : null;
  }

  function detail(id) {
    const sequence = needSequence(id);
    const shots = shotsOf(id);
    let clock = 0;
    const timing = editTimeline(shots, sequence.settings);
    // The joined film is stale when any shot changed after it was made. shots.updated_at moves on every edit
    // (trim, grade, duration, reorder, new frame/clip/dialogue take). Settings are tracked separately.
    const joinedAt = asset(sequence.outputAssetId)?.createdAt ?? null;
    const joinedSettings = repo.settings.get(`joinSettings:${id}`, null);
    const joinStale = Boolean(joinedAt) && (joinedSettings?.outputAssetId !== sequence.outputAssetId
      || joinedSettings?.fingerprint !== joinSettingsFingerprint(sequence.settings)
      || (joinedSettings?.editRevision ?? null) !== repo.settings.get(`editRevision:${id}`, null)
      || (joinedSettings?.shotOrder && joinedSettings.shotOrder !== JSON.stringify(shots.map((s) => s.id)))
      || shots.some((s) => s.updatedAt && s.updatedAt > joinedAt));
    return {
      sequence: { ...sequence, joinStale, outputPath: asset(sequence.outputAssetId)?.path ?? null, join: joining.get(id) ?? null, production: producing.get(id) ?? null,
        enhance: sequence.outputAssetId ? enhancer?.status(sequence.outputAssetId) ?? null : null, themeCoverage: themeCoverage(sequence.settings.themes, shots) },
      shots: shots.map((shot, index) => {
        const startsAt = timing.shots[index].start;
        clock = timing.shots[index].end;
        return {
          ...shot, startsAt, imagePath: asset(shot.imageAssetId)?.path ?? null, videoPath: asset(shot.videoAssetId)?.path ?? null,
          frameJob: latest(`shot-image:${shot.id}`), clipJob: latest(`shot-video:${shot.id}`),
          details: { ...cleanShotDetails({}, shot.details), dialogue: (shot.details.dialogue ?? []).map((line) => ({ ...line, audioPath: asset(line.assetId)?.path ?? null })) },
        };
      }),
      runningSeconds: clock,
    };
  }

  function create({ projectId, title, idea, writer, settings, screenplay }) {
    if (!repo.projects.get(projectId)) throw new RequestError(404, 'Project not found.');
    const sequence = repo.sequences.create({
      projectId, title, idea: String(idea ?? '').slice(0, 6000), writer: typeof writer === 'string' && writer ? writer : null, settings: cleanSequenceSettings(settings),
    });
    return typeof screenplay === 'string' ? repo.sequences.update(sequence.id, { screenplay: screenplay.slice(0, 60_000) }) : sequence;
  }

  function update(id, body) {
    const sequence = needSequence(id);
    return repo.sequences.update(id, {
      title: body.title, idea: typeof body.idea === 'string' ? body.idea.slice(0, 6000) : undefined,
      writer: body.writer === undefined ? undefined : body.writer || null,
      settings: body.settings ? cleanSequenceSettings(body.settings, sequence.settings) : undefined,
      screenplay: typeof body.screenplay === 'string' ? body.screenplay.slice(0, 60_000) : undefined,
    });
  }

  // The film's cast and sets (storyboard-level), each with its description, for prompts and the writer.
  const castOf = (sequence) => (sequence.settings.characterIds ?? []).map((cid) => repo.characters.get(cid)).filter(Boolean);

  function characterLines(sequence) {
    const cast = castOf(sequence);
    const people = cast.filter((c) => c.kind !== 'location');
    const places = cast.filter((c) => c.kind === 'location');
    return [
      people.length ? `Characters (use these exact names; never change how they look):\n${people.map((c) => `- ${c.name}: ${c.description}`).join('\n')}` : '',
      places.length ? `Locations (use these exact names):\n${places.map((c) => `- ${c.name}: ${c.description}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
  }

  async function plan(id, { writer, replace = false } = {}) {
    const sequence = needSequence(id);
    if (!sequence.idea.trim() && !sequence.screenplay.trim()) throw new RequestError(400, 'Describe the idea or paste a screenplay first.');
    const existing = shotsOf(id);
    if (existing.length && !replace) throw new RequestError(409, 'This storyboard already has shots. Confirm to replace them.');
    const locked = existing.filter((s) => s.details.locked);
    if (locked.length) throw new RequestError(409, `${locked.length} shot(s) are locked. Unlock them (a deliberate screenplay revision) before re-planning.`);
    const spec = writer || sequence.writer;
    if (!spec) throw new RequestError(400, 'Choose a writer model for this storyboard.');
    const [directorId, model] = spec.split(':');
    const director = directors.get(directorId);
    if (!director || !director.models.includes(model)) throw new RequestError(400, 'Unknown writer model.');
    if (!director.keyless && budget?.settings().enabled && budget.settings().strictPrices) {
      throw new RequestError(402, 'Strict budget: write the shot plan in your MCP chat and import it; paid planning has no bounded price.');
    }
    const key = director.keyless ? null : keys.get(director.keyProvider);
    if (!director.keyless && !key) throw new RequestError(400, `Add a ${director.label} key in Settings to use this writer.`);
    if (!director.keyless) confirmSpend({ estimateUsd: null, what: `the paid writer ${spec} plans the shots` });
    const { shotCount: count, targetSeconds, clipLength, continuity, look, videoSecondsBudget } = sequence.settings;
    const videoModel = providers?.model(sequence.settings.videoProvider, sequence.settings.videoModel);
    const allowed = videoModel?.durations?.length ? videoModel.durations : null;
    const [low, high] = allowed ? [Math.min(...allowed), Math.max(...allowed)] : [4, 10];
    const fixed = clipLength ? (allowed ? nearestDuration(allowed, clipLength) : Math.min(high, Math.max(low, clipLength))) : 0;
    const prompt = [
      `Break this into a sequence of shots. SHOT_COUNT=${count}`,
      sequence.screenplay.trim() ? `Screenplay (canonical: keep its scenes in order and its dialogue word for word; never add events it does not have):\n${sequence.screenplay}` : `Idea: ${sequence.idea}`,
      characterLines(sequence),
      targetSeconds ? `The whole film should run about ${targetSeconds} seconds (${(targetSeconds / 60).toFixed(1)} minutes), so the shot durations must add up to roughly ${targetSeconds}. Tell the story with a clear beginning, middle and end across all ${count} shots.` : '',
      looks[look] ? `Look: ${looks[look]} Write every description in that look.${look === 'anime' ? ' All dialogue and narration is written in English, whatever the setting.' : ''}` : '',
      sequence.settings.lookBible ? `Look bible (applies to every shot): ${sequence.settings.lookBible}` : '',
      themeBrief(sequence.settings.themes, count),
      continuity === 'chain' ? 'Continuity: every clip will start from the exact last frame of the clip before it, so each shot must continue directly from where the previous one ends. Only move to a new place or time where the story needs a cut, and say so at the start of that shot.' : '',
      continuity === 'keyframes' ? 'Continuity: within a scene, each clip will run from its own opening frame to the next shot\'s opening frame, so make each shot end where the next one begins.' : '',
      fixed ? `Every shot lasts ${fixed} seconds; give each one enough action to fill that time.` : '',
      videoSecondsBudget ? `Budget: at most ${videoSecondsBudget} seconds in total may be "video" shots (generated motion). Use "still" shots (a slow camera move over one frame) for establishing views, quiet reactions, narration and anything where motion adds little.` : '',
      `Frame: ${sequence.settings.aspect}.`,
      `Camera moves for video shots (by id): ${cameraPresets.map((p) => `${p.id} (${p.blurb})`).join('; ')}. Still-shot moves: ${stillMotions.join(', ')}.`,
      `Return JSON: {"shots":[{"scene":"short scene label, e.g. 3 – Rooftop at night","location":"a location name from the list, or a short description","characters":["names in shot"],"description":"what we see and what happens, one or two sentences that stand alone as an image prompt","action":"the one required action","dialogue":[{"speaker":"a character name or Narrator","line":"exact words"}],"startState":"situation at the start of the shot","endState":"situation at the end","themes":["names of the themes this shot shows on screen, from the list; [] if none"],"method":"video or still","camera":"camera id (video shots)","motion":"still-shot move (still shots)","duration":5}]} with exactly ${count} shots. Durations are whole seconds${allowed ? `, each one of: ${allowed.join(', ')}` : `, between ${low} and ${high}`}. Keep each shot's dialogue short enough to be spoken within its duration.`,
    ].filter(Boolean).join('\n\n');
    let text;
    try {
      text = await director.complete({ key, model, system, prompt, task: 'shots', maxTokens: Math.max(8000, count * 700) });
    } catch (error) {
      if (error.category === 'budget_limit') throw new RequestError(402, error.message);
      throw new RequestError(502, `Writer failed: ${error.detail || error.message}`);
    }
    const parsed = extractJson(text);
    const cast = castOf(sequence);
    const byName = (name) => cast.find((c) => c.name.toLowerCase() === String(name ?? '').trim().toLowerCase());
    const list = (Array.isArray(parsed.shots) ? parsed.shots : []).map((shot) => {
      const location = byName(shot?.location);
      const people = (Array.isArray(shot?.characters) ? shot.characters : []).map(byName).filter((c) => c && c.kind !== 'location');
      const dialogue = (Array.isArray(shot?.dialogue) ? shot.dialogue : []).map((line) => ({
        speaker: byName(line?.speaker)?.id ?? 'narrator', text: String(line?.line ?? line?.text ?? ''), start: null,
      }));
      return {
        description: String(shot?.description ?? '').trim().slice(0, 2000),
        camera: cameraPresets.some((p) => p.id === shot?.camera) ? shot.camera : null,
        duration: fixed || (allowed ? nearestDuration(allowed, Number(shot?.duration) || 5) : Math.min(high, Math.max(low, Math.round(Number(shot?.duration)) || 5))),
        details: cleanShotDetails({
          scene: String(shot?.scene ?? ''), locationId: location?.kind === 'location' ? location.id : null, characterIds: people.map((c) => c.id),
          action: String(shot?.action ?? ''), dialogue, startState: String(shot?.startState ?? ''), endState: String(shot?.endState ?? ''),
          method: shot?.method === 'still' ? 'still' : 'video', motion: shot?.motion,
          themes: (Array.isArray(shot?.themes) ? shot.themes : []).map((t) => themeName(sequence.settings.themes, t)).filter(Boolean),
          ...(location || !shot?.location ? {} : { forbidden: '' }),
        }),
      };
    }).filter((shot) => shot.description).slice(0, maxShots);
    if (!list.length) throw new RequestError(502, 'The writer returned no shots. Try again.');
    repo.shots.replaceAll(id, list);
    return detail(id);
  }

  function importPlan(id, { shots: incoming, replace = false } = {}) {
    needSequence(id);
    const current = shotsOf(id);
    if (current.length && !replace) throw new RequestError(409, 'Confirm replacement of the existing shot plan.');
    if (current.some((s) => s.details.locked)) throw new RequestError(409, 'Unlock the existing shots before replacing the plan.');
    if (current.some((s) => active(`shot-image:${s.id}`) || active(`shot-video:${s.id}`))) throw new RequestError(409, 'Wait for active shot jobs before replacing the plan.');
    if (!Array.isArray(incoming) || incoming.length < 1 || incoming.length > maxShots) throw new RequestError(400, `Import 1–${maxShots} shots.`);
    const list = incoming.map((shot) => {
      if (typeof shot.description !== 'string' || !shot.description.trim() || shot.description.length > 2000) throw new RequestError(400, 'Every shot needs a description under 2000 characters.');
      const duration = Number(shot.duration);
      if (!Number.isInteger(duration) || duration < 1 || duration > 30) throw new RequestError(400, 'Shot durations must be whole seconds between 1 and 30.');
      const details = cleanShotDetails(shot.details ?? {});
      for (const characterId of [...details.characterIds, details.locationId].filter(Boolean)) if (!repo.characters.get(characterId)) throw new RequestError(404, 'A shot character or location does not exist.');
      return { description: shot.description.trim(), duration, camera: cameraPresets.some((p) => p.id === shot.camera) ? shot.camera : null, details };
    });
    if (list.reduce((sum, shot) => sum + shot.duration, 0) > maxTargetSeconds) throw new RequestError(400, 'The film may not exceed 15 minutes.');
    repo.shots.replaceAll(id, list);
    return detail(id);
  }

  // Shot edits. Locked shots keep their story (description, dialogue, start/end state) until unlocked on purpose.
  function updateShot(shotId, body) {
    const shot = needShot(shotId);
    const story = ['description', 'scene', 'locationId', 'characterIds', 'action', 'dialogue', 'startState', 'endState', 'forbidden', 'method', 'themes',
      'directorFramePrompt', 'directorClipPrompt', 'directorNegative', 'directorKeepAutomatic'];
    // Moving a dialogue line in time (only `start` differs) is not a story change: no lock, no review reset.
    const sameWords = Array.isArray(body.details?.dialogue) && body.details.dialogue.length === shot.details.dialogue.length
      && body.details.dialogue.every((l, i) => l?.text?.trim() === shot.details.dialogue[i].text && (l.speaker ?? 'narrator') === shot.details.dialogue[i].speaker && (l.style ?? shot.details.dialogue[i].style ?? '') === (shot.details.dialogue[i].style ?? ''));
    const touchesStory = 'description' in body || story.some((key) => body.details && key in body.details && !(key === 'dialogue' && sameWords));
    if (shot.details.locked && touchesStory && body.details?.locked !== false) {
      throw new RequestError(409, `Shot ${shot.position} is locked (approved screenplay). Unlock it first to revise it.`);
    }
    const details = body.details ? cleanShotDetails(body.details, shot.details) : shot.details;
    for (const id of [...details.characterIds, details.locationId].filter(Boolean)) {
      if (!repo.characters.get(id)) throw new RequestError(404, 'A character or location in this shot no longer exists.');
    }
    repo.shots.update(shotId, {
      description: typeof body.description === 'string' ? body.description.slice(0, 2000) : undefined,
      camera: body.camera === undefined ? undefined : cameraPresets.some((p) => p.id === body.camera) ? body.camera : null,
      duration: body.duration === undefined ? undefined : Math.min(30, Math.max(1, Math.round(Number(body.duration)) || 5)),
      details,
      review: touchesStory ? { ...shot.review, status: 'pending', frameApproved: null } : undefined,
    });
    return detail(shot.sequenceId);
  }

  // Editing revisions cover removals and repository moves, which do not touch shot timestamps.
  function invalidateEdit(id) {
    repo.settings.set(`editRevision:${id}`, (repo.settings.get(`editRevision:${id}`, 0) ?? 0) + 1);
  }
  const pictureReview = (shot) => ({ ...shot.review, status: 'pending', frameApproved: null });
  function editable(shot, story = false) {
    if (story && shot.details.locked) throw new RequestError(409, 'Unlock this shot before splitting or deleting it.');
    if (active(`shot-image:${shot.id}`) || active(`shot-video:${shot.id}`)
      || shot.details.dialogue.some((_, i) => active(`shot-line:${shot.id}:${i}`))) throw new RequestError(409, 'Wait for active shot jobs before editing.');
  }
  function shotTimeline(id) {
    const sequence = needSequence(id);
    return { storyboardId: id, ...editTimeline(shotsOf(id), sequence.settings) };
  }
  function insertShot(id, { afterShotId = null, shot } = {}) {
    needSequence(id);
    const shots = shotsOf(id);
    if (shots.length >= maxShots) throw new RequestError(400, `A storyboard supports at most ${maxShots} shots.`);
    const after = afterShotId === null ? null : shots.find((s) => s.id === afterShotId);
    if (afterShotId !== null && !after) throw new RequestError(400, 'afterShotId must belong to this storyboard.');
    if (!shot || typeof shot.description !== 'string' || !shot.description.trim() || shot.description.length > 2000
      || !Number.isFinite(shot.duration) || shot.duration < 1 / 24 || shot.duration > 30) throw new RequestError(400, 'A shot needs a description and duration between 1/24 and 30 seconds.');
    const details = cleanShotDetails(shot.details ?? {});
    for (const cid of [...details.characterIds, details.locationId].filter(Boolean)) if (!repo.characters.get(cid)) throw new RequestError(404, 'A shot character or location does not exist.');
    if (shots.reduce((sum, s) => sum + playbackSeconds(s), 0) + shot.duration / details.speed > maxTargetSeconds) throw new RequestError(400, 'The film may not exceed 15 minutes.');
    repo.shots.insert(id, { description: shot.description.trim(), duration: shot.duration, camera: cameraPresets.some((p) => p.id === shot.camera) ? shot.camera : null, details, position: after ? after.position + 1 : 1 });
    repo.shots.renumber(id);
    invalidateEdit(id);
    return detail(id);
  }
  function duplicateShot(shotId, { withMedia = false } = {}) {
    const shot = needShot(shotId);
    editable(shot);
    if (typeof withMedia !== 'boolean') throw new RequestError(400, 'withMedia must be boolean.');
    const details = { ...shot.details, locked: false, post: {}, lipsync: null, attachedClips: withMedia ? shot.details.attachedClips : [], sfx: withMedia ? shot.details.sfx : [],
      dialogue: shot.details.dialogue.map((line) => ({ ...line, ...(withMedia ? {} : { assetId: null, seconds: null }) })) };
    insertShot(shot.sequenceId, { afterShotId: shotId, shot: { ...shot, details } });
    const copy = shotsOf(shot.sequenceId).find((s) => s.position === shot.position + 1);
    // cleanShotDetails deliberately discards untrusted audio ids on insert; only this internal copy restores them.
    repo.shots.update(copy.id, { details, imageAssetId: withMedia ? shot.imageAssetId : null, videoAssetId: withMedia ? shot.videoAssetId : null, review: {} });
    return detail(shot.sequenceId);
  }
  async function splitShot(shotId, { atSeconds } = {}) {
    const shot = needShot(shotId);
    editable(shot, true);
    const speed = shot.details.speed, duration = playbackSeconds(shot);
    if (!Number.isFinite(atSeconds) || atSeconds < 1 / 24 || duration - atSeconds < 1 / 24) throw new RequestError(400, 'Split strictly inside the shot, leaving at least one frame on each side.');
    if (shotsOf(shot.sequenceId).length >= maxShots) throw new RequestError(400, `A storyboard supports at most ${maxShots} shots.`);
    const lengths = await Promise.all(shot.details.dialogue.map((line) => asset(line.assetId) ? mediaSeconds(assetStore.path(asset(line.assetId))) : line.seconds ?? 0));
    const { times } = lineTimes(shot.details.dialogue, duration, lengths);
    const dialogue = [[], []];
    shot.details.dialogue.forEach((line, i) => { const side = times[i] >= atSeconds ? 1 : 0; dialogue[side].push({ ...line, start: times[i] - (side ? atSeconds : 0) }); });
    const spans = (list, key, side) => list.flatMap((item) => {
      const from = Math.max(item.start, side ? atSeconds : 0), end = Math.min(item.start + item[key], side ? duration : atSeconds);
      return end > from ? [{ ...item, start: from - (side ? atSeconds : 0), [key]: end - from }] : [];
    });
    const detailsFor = (side) => ({ ...shot.details, dialogue: dialogue[side], post: {}, lipsync: null,
      cutTransition: side ? shot.details.cutTransition : { transition: 'cut', seconds: 0 },
      trimStart: shot.details.trimStart + (side && shot.videoAssetId ? atSeconds * speed : 0),
      overlays: spans(shot.details.overlays, 'seconds', side),
      holds: spans(shot.details.holds, 'seconds', side),
      sfx: shot.details.sfx.filter((e) => (e.at >= atSeconds) === Boolean(side)).map((e) => ({ ...e, at: e.at - (side ? atSeconds : 0) })) });
    const second = repo.shots.insert(shot.sequenceId, { position: shot.position + 1, description: shot.description, camera: shot.camera, duration: (duration - atSeconds) * speed, details: detailsFor(1) });
    repo.shots.update(second.id, { imageAssetId: shot.imageAssetId, videoAssetId: shot.videoAssetId, review: pictureReview(shot) });
    repo.shots.update(shotId, { duration: atSeconds * speed, details: detailsFor(0), review: pictureReview(shot) });
    repo.shots.renumber(shot.sequenceId);
    invalidateEdit(shot.sequenceId);
    return detail(shot.sequenceId);
  }
  function deleteShot(shotId, { confirm } = {}) {
    const shot = needShot(shotId);
    if (confirm !== true) throw new RequestError(400, 'Deleting a shot requires confirm: true.');
    editable(shot, true);
    repo.shots.remove(shotId); // generation rows and their assets intentionally survive
    invalidateEdit(shot.sequenceId);
    return detail(shot.sequenceId);
  }
  function pictureEdit(shot, fields) {
    editable(shot);
    repo.shots.update(shot.id, { details: { ...shot.details, ...fields }, review: pictureReview(shot) });
    invalidateEdit(shot.sequenceId);
    return detail(shot.sequenceId);
  }
  function setCutTransition(shotId, { transition, seconds } = {}) {
    const shot = needShot(shotId);
    if (!cutTransitions.includes(transition) || !Number.isFinite(seconds) || seconds < 0 || seconds > 10 || (transition !== 'cut' && seconds === 0)) throw new RequestError(400, 'Choose a valid transition and positive seconds (up to 10).');
    // The cut changes the film's picture, while the approved source frame remains the same.
    editable(shot);
    repo.shots.update(shotId, { details: { ...shot.details, cutTransition: { transition, seconds: transition === 'cut' ? 0 : seconds } }, review: { ...shot.review, status: 'pending' } });
    invalidateEdit(shot.sequenceId);
    return detail(shot.sequenceId);
  }
  function setShotSpeed(shotId, { speed, keepPitch = true } = {}) {
    const shot = needShot(shotId);
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 4 || typeof keepPitch !== 'boolean') throw new RequestError(400, 'speed must be 0.25–4 and keepPitch must be boolean.');
    return pictureEdit(shot, { speed, keepPitch });
  }
  function addTextOverlay(shotId, overlay = {}) {
    const shot = needShot(shotId);
    if (typeof overlay.text !== 'string' || !overlay.text.trim() || overlay.text.length > 2000 || !overlayPositions.includes(overlay.position)
      || !overlayStyles.includes(overlay.style) || !Number.isFinite(overlay.start) || overlay.start < 0 || !Number.isFinite(overlay.seconds) || overlay.seconds <= 0
      || overlay.start + overlay.seconds > playbackSeconds(shot) + 1e-9 || shot.details.overlays.length >= 24) throw new RequestError(400, 'A valid overlay must fit within the shot (maximum 24 overlays).');
    return pictureEdit(shot, { overlays: [...shot.details.overlays, { text: overlay.text, position: overlay.position, start: overlay.start, seconds: overlay.seconds, style: overlay.style }] });
  }
  function reorderScene(id, { scene, beforeScene = null } = {}) {
    needSequence(id);
    const shots = shotsOf(id);
    if (typeof scene !== 'string' || (beforeScene !== null && typeof beforeScene !== 'string')) throw new RequestError(400, 'Use scene labels and beforeScene or null.');
    const moved = shots.filter((s) => s.details.scene === scene);
    if (!moved.length || (beforeScene !== null && !shots.some((s) => s.details.scene === beforeScene))) throw new RequestError(404, 'Scene not found.');
    if (scene === beforeScene) return detail(id);
    const rest = shots.filter((s) => s.details.scene !== scene);
    const index = beforeScene === null ? rest.length : rest.findIndex((s) => s.details.scene === beforeScene);
    const order = [...rest.slice(0, index), ...moved, ...rest.slice(index)];
    for (let i = 0; i < order.length; i++) {
      while (repo.shots.get(order[i].id).position > i + 1) repo.shots.move(order[i].id, -1);
    }
    repo.shots.renumber(id);
    invalidateEdit(id);
    return detail(id);
  }
  async function makeAnimatic(id, { fps = 12, includeDialogue = true } = {}) {
    const sequence = needSequence(id);
    const shots = shotsOf(id);
    if (!shots.length) throw new RequestError(400, 'Add shots before making an animatic.');
    return createAnimatic({ shots, sequence, repo, assetStore, fps, includeDialogue });
  }

  // Review: accepted shots are the only ones a strict film uses; anyone (the person or the orchestrator) can mark.
  function review(shotId, { status, notes }) {
    const shot = needShot(shotId);
    if (!reviewStatuses.includes(status)) throw new RequestError(400, `Status must be one of: ${reviewStatuses.join(', ')}.`);
    if (status === 'accepted' && !shot.videoAssetId) throw new RequestError(400, 'This shot has no clip to accept yet.');
    repo.shots.update(shotId, { review: { ...shot.review, status, notes: typeof notes === 'string' ? notes.slice(0, 1000) : shot.review.notes ?? '', decidedAt: new Date().toISOString() } });
    return detail(shot.sequenceId);
  }

  const choice = (sequence, kind, override = {}, shot = null) => {
    const [shotProvider, shotModel] = kind === 'video' && shot?.details.model ? shot.details.model.split('|') : [];
    const provider = override.provider || shotProvider || sequence.settings[`${kind}Provider`];
    const model = override.model || shotModel || sequence.settings[`${kind}Model`];
    if (!provider || !model) throw new RequestError(400, `Choose ${kind === 'image' ? 'an image' : 'a video'} model for this storyboard first.`);
    return { provider, model };
  };

  // The cast and set of one shot: its own characters and location when set, otherwise the film's cast.
  function shotCast(sequence, shot) {
    const own = [...shot.details.characterIds, shot.details.locationId].filter(Boolean);
    return own.length ? own : sequence.settings.characterIds;
  }

  // The words every frame and clip prompt shares, in a fixed order, so nothing about the look is left to chance.
  function promptFor(sequence, shot, kind) {
    const d = shot.details;
    const directed = d[kind === 'frame' ? 'directorFramePrompt' : 'directorClipPrompt'];
    if (directed !== null && directed !== undefined && d.directorKeepAutomatic === false) return directed;
    const location = d.locationId ? repo.characters.get(d.locationId) : null;
    const automatic = [
      kind === 'frame' ? 'Film still, the opening frame of this shot.' : '',
      shot.description,
      d.action ? `Action: ${d.action}` : '',
      d.scene ? `Scene: ${d.scene}${location ? `, at ${location.name}` : ''}.` : location ? `At ${location.name}.` : '',
      d.startState && kind === 'frame' ? `At this moment: ${d.startState}` : '',
      d.endState && kind === 'clip' ? `By the end of the shot: ${d.endState}` : '',
      looks[sequence.settings.look] ?? '',
      sequence.settings.lookBible,
      kind === 'clip' ? 'Keep every person exactly as in the start frame: same face, hair, clothes and colours; same set and lighting.' : '',
      // Anime lip sync draws the mouth afterwards: a clip that animates talking by itself would fight the drawn mouth.
      kind === 'clip' && sequence.settings.look === 'anime' && sequence.settings.lipSync === true && d.dialogue.length
        ? 'Mouths stay closed and still (the dialogue is added afterwards); move the head, eyes, hair and body instead.' : '',
      d.forbidden ? `Must not change: ${d.forbidden}` : '',
      ...d.themes.map((name) => themeVisual(sequence.settings.themes, name)).filter(Boolean),
      consistency,
    ].filter(Boolean).join('\n').slice(0, 3900);
    const prompt = directed == null ? automatic : [
      directed,
      looks[sequence.settings.look] ?? '', sequence.settings.lookBible,
      kind === 'clip' ? 'Keep every person exactly as in the start frame: same face, hair, clothes and colours; same set and lighting.' : '',
      consistency,
    ].filter(Boolean).join('\n');
    // The provider/job interface has no negative channel: exclusions travel as plain prompt instructions.
    const composed = d.directorNegative ? `${prompt}\nAvoid: ${d.directorNegative}` : prompt;
    if (composed.length > 4000) throw new RequestError(400, `The ${kind} prompt plus automatic blocks exceeds 4000 characters. Shorten the direction or use keepAutomatic: false.`);
    return composed;
  }

  const verbatim = (shot, kind) => shot.details.directorKeepAutomatic === false
    && shot.details[kind === 'frame' ? 'directorFramePrompt' : 'directorClipPrompt'] != null;
  const promptPresets = (sequence, shot, kind) => verbatim(shot, kind) ? []
    : [kind === 'clip' ? shot.camera : null, sequence.settings.style].filter(Boolean);
  const promptCast = (sequence, shot, kind) => verbatim(shot, kind) ? [] : shotCast(sequence, shot);

  // Read-only counterpart of generation.applyCharacters: mirror its identity note, including whether the selected
  // image model can attach reference images. providerPrompt supplies the same camera/style fragments as jobs use.
  // No job is submitted, no references are read from disk, and no writer or provider is called.
  function composedPrompts(shotId, changes = {}) {
    const current = needShot(shotId);
    // Optional proposed edits let the director route validate a batch without writing any of it.
    const shot = { ...current, ...changes, details: cleanShotDetails(changes.details ?? {}, current.details) };
    const sequence = needSequence(shot.sequenceId);
    const compose = (kind) => {
      const chosen = [...new Set(promptCast(sequence, shot, kind))].map((id) => repo.characters.get(id));
      if (chosen.some((c) => !c)) throw new RequestError(404, 'A character no longer exists.');
      chosen.sort((a, b) => (a.kind === 'location') - (b.kind === 'location'));
      const refs = [...new Set(chosen.flatMap((c) => c.referenceAssetIds))]
        .filter((id) => asset(id)?.mimeType?.startsWith('image/'));
      const model = kind === 'frame' ? providers?.model(sequence.settings.imageProvider, sequence.settings.imageModel) : null;
      const attached = kind === 'frame' && (model?.operations.includes('edit') || model?.styleReferences)
        ? refs.slice(0, model.maxReferences).length : 0;
      const shown = attached ? ' and as shown in the reference image(s)' : '';
      const people = chosen.filter((c) => c.kind !== 'location');
      const places = chosen.filter((c) => c.kind === 'location');
      const characterNote = [
        people.length ? `Characters (keep each one exactly as described${shown}: same face, hair, body, clothes and colours): ${
          people.map((c) => `${c.name} — ${[c.designTags, c.description].filter(Boolean).join('; ') || 'as shown in the reference image'}`).join('; ')}.` : '',
        places.length ? `Location (keep the layout, architecture, props and lighting exactly as described${shown}): ${
          places.map((c) => `${c.name} — ${c.description || 'as shown in the reference image'}`).join('; ')}.` : '',
      ].filter(Boolean).join('\n').slice(0, 3500);
      return providerPrompt({ prompt: promptFor(sequence, shot, kind).trim(), params: { presets: promptPresets(sequence, shot, kind), characterNote } });
    };
    return { shotId: shot.id, framePrompt: compose('frame'), clipPrompt: compose('clip') };
  }

  // A job already queued or running for this shot is returned instead of starting (and paying for) another.
  const active = (target) => {
    const g = repo.generations.listByTarget(target)[0];
    return g && ['queued', 'running'].includes(g.status) ? g : null;
  };

  function generateFrame(shotId, override = {}) {
    const shot = needShot(shotId);
    const sequence = needSequence(shot.sequenceId);
    if (!shot.description.trim()) throw new RequestError(400, 'Describe this shot first.');
    const running = active(`shot-image:${shot.id}`);
    if (running && !override.force) return { generation: running, alreadyRunning: true };
    return {
      generation: generations.submit({
        projectId: sequence.projectId, prompt: promptFor(sequence, shot, 'frame'), ...choice(sequence, 'image', override),
        size: aspects[sequence.settings.aspect], quality: 'high', presets: promptPresets(sequence, shot, 'frame'),
        characterIds: promptCast(sequence, shot, 'frame'), seed: sequence.settings.seed ?? undefined, bookTarget: `shot-image:${shot.id}`,
        idempotencyKey: override.idempotencyKey,
      }),
    };
  }

  function paidClip(sequence, shot) {
    if (shot.details.method === 'still') return false;
    const { provider, model } = choice(sequence, 'video', {}, shot);
    const p = providers.get(provider);
    const price = priceFor(provider, model, providers.model(provider, model));
    return !p?.keyless || Boolean(price?.usd || price?.skus);
  }

  // Clips start from the shot's approved frame when the model accepts a start image; in keyframe mode they also
  // end on the next shot's frame when it is in the same scene and the model supports a last frame.
  function animate(shotId, override = {}) {
    const shot = needShot(shotId);
    const sequence = needSequence(shot.sequenceId);
    if (!shot.description.trim()) throw new RequestError(400, 'Describe this shot first.');
    if (shot.details.method === 'still') throw new RequestError(400, 'This is a still shot: render it locally instead (free).');
    if (sequence.settings.requireApproval && (!shot.imageAssetId || shot.review.frameApproved !== shot.imageAssetId)) throw new RequestError(409, 'Approve this shot’s current frame before making a clip.');
    if (budget?.settings().enabled && budget.settings().strictPrices && paidClip(sequence, shot)) {
      if (!shot.imageAssetId || shot.review.frameApproved !== shot.imageAssetId) throw new RequestError(409, 'Strict budget: approve the current frame before a paid clip.');
      const waiting = shotsOf(sequence.id).find((s) => s.id !== shot.id && paidClip(sequence, s) && ((s.videoAssetId && s.review.status !== 'accepted') || active(`shot-video:${s.id}`)));
      if (waiting) throw new RequestError(409, `Strict budget: review shot ${waiting.position} before paying for the next clip.`);
    }
    const running = active(`shot-video:${shot.id}`);
    if (running && !override.force) return { generation: running, alreadyRunning: true };
    const { provider, model } = choice(sequence, 'video', override, shot);
    const info = providers?.model(provider, model);
    const takesImage = (info?.maxReferences ?? 1) > 0;
    const start = takesImage && shot.imageAssetId && repo.assets.get(shot.imageAssetId) ? shot.imageAssetId : null;
    let endFrameAssetId;
    if (sequence.settings.continuity === 'keyframes' && start && info?.lastFrame) {
      const shots = shotsOf(sequence.id);
      const next = shots[shots.findIndex((s) => s.id === shot.id) + 1];
      if (next?.imageAssetId && next.details.scene === shot.details.scene && repo.assets.get(next.imageAssetId)) endFrameAssetId = next.imageAssetId;
    }
    return {
      generation: generations.submit({
        projectId: sequence.projectId, operation: 'video', prompt: promptFor(sequence, shot, 'clip'), provider, model,
        duration: shot.duration, aspect: sequence.settings.aspect, resolution: override.resolution, inputAssetIds: start ? [start] : [], endFrameAssetId,
        presets: promptPresets(sequence, shot, 'clip'), characterIds: promptCast(sequence, shot, 'clip'), seed: sequence.settings.seed ?? undefined,
        bookTarget: `shot-video:${shot.id}`, idempotencyKey: override.idempotencyKey,
      }),
    };
  }

  const outputSize = (sequence) => {
    const [w, h] = ratios[sequence.settings.aspect] ?? [16, 9];
    const height = sequence.settings.outputHeight ?? 1080;
    const even = (n) => Math.round(n / 2) * 2;
    return w >= h ? { width: even(height * w / h), height } : { width: height, height: even(height * h / w) };
  };

  // A still shot: the approved frame with a slow camera move, rendered here at the film's size. Free.
  async function renderStillShot(shotId) {
    const shot = needShot(shotId);
    const sequence = needSequence(shot.sequenceId);
    const frame = asset(shot.imageAssetId);
    if (!frame) throw new RequestError(400, 'Make (and approve) this shot\'s frame first.');
    const size = outputSize(sequence);
    const bytes = await renderStill(assetStore.path(frame), { duration: shot.duration ?? 5, motion: shot.details.motion, width: size.width, height: size.height });
    const clip = await assetStore.save({ bytes, projectId: sequence.projectId, kind: 'video', label: `Shot ${shot.position} (still, ${shot.details.motion})`, parentAssetId: frame.id });
    repo.shots.update(shot.id, { videoAssetId: clip.id, review: { status: 'pending' } });
    await runChecks(shot.id);
    return detail(sequence.id);
  }

  // Lip sync, free and local. Anime: three mouths are drawn on the clip's first frame by the anime image model and
  // switched with the voice (mouth flaps, on twos); live action: MuseTalk redraws the lower face. It always starts
  // from the original clip, so it can be redone after the dialogue changes. Still shots are synced without the camera
  // move, which is added afterwards. `box` is the mouth's box as fractions of the frame [x1, y1, x2, y2]; without it
  // the mouth is found automatically (anime face detector), and a 422 asks for a box when that fails.
  async function lipSyncShot(shotId, { box = null } = {}) {
    const shot = needShot(shotId);
    const sequence = needSequence(shot.sequenceId);
    if (sequence.settings.lipSync !== true) throw new RequestError(409, 'Lip sync is turned off for this storyboard (Settings).');
    const synced = shot.details.lipsync;
    const source = asset(synced && synced.result === shot.videoAssetId ? synced.source : shot.videoAssetId);
    if (!source) throw new RequestError(400, 'Make this shot\'s clip first.');
    const lines = shot.details.dialogue.filter((line) => line.assetId && asset(line.assetId));
    if (!lines.length) throw new RequestError(400, 'Voice this shot\'s dialogue first.');
    const mode = sequence.settings.look === 'anime' ? 'flaps' : 'musetalk';
    if (!lipSyncInstalled(mode)) throw new RequestError(501, mode === 'flaps' ? 'Anime lip sync needs Animagine XL 4.0 and the voice environment (see docs: Local voices and lip sync).' : 'Lip sync needs MuseTalk and the voice environment (see docs: Local voices and lip sync).');
    const still = shot.details.method === 'still';
    const duration = shot.duration ?? 5;
    const dir = await mkdtemp(path.join(tmpdir(), 'lumina-lipsync-'));
    try {
      // The voice track, placed in the shot exactly as the film's soundtrack will place it.
      const lengths = [];
      lengths.push(...await Promise.all(lines.map((line) => mediaSeconds(assetStore.path(asset(line.assetId))))));
      const { times } = lineTimes(lines, duration, lengths);
      const voice = path.join(dir, 'voice.wav');
      await run('ffmpeg', ['-v', 'error', ...lines.flatMap((line) => ['-i', assetStore.path(asset(line.assetId))]),
        '-filter_complex', `${lines.map((_, i) => `[${i}:a]aresample=24000,aformat=channel_layouts=mono,adelay=${Math.round(times[i] * 1000)}:all=1[a${i}]`).join(';')};`
          + `${lines.map((_, i) => `[a${i}]`).join('')}amix=inputs=${lines.length}:normalize=0,apad,atrim=0:${duration}[out]`,
        '-map', '[out]', '-y', voice], 300_000);
      // The picture: a still shot is synced as a still picture, then gets its camera move.
      let video = assetStore.path(source);
      const size = outputSize(sequence);
      if (still) {
        video = path.join(dir, 'hold.mp4');
        await writeFile(video, await renderStill(assetStore.path(asset(shot.imageAssetId) ?? source), { duration, motion: 'static', width: size.width, height: size.height }));
      }
      const info = await probe(video);
      const first = path.join(dir, 'first.png');
      await run('ffmpeg', ['-v', 'error', '-i', video, '-frames:v', '1', '-y', first], 120_000);
      const pixels = Array.isArray(box) && box.length === 4
        ? box.map((v, i) => Math.round(Math.min(1, Math.max(0, Number(v))) * (i % 2 ? info.height : info.width)))
        : await findMouth(first);
      if (!pixels || pixels[2] - pixels[0] < 8 || pixels[3] - pixels[1] < 6) {
        throw Object.assign(new RequestError(422, 'The mouth could not be found automatically. Drag a box over the speaker\'s mouth on the shot\'s picture, then press Lip sync again.'), { needBox: true });
      }
      const out = path.join(dir, 'synced.mp4');
      const mouths = mode === 'flaps' ? await drawMouths({ image: first, box: pixels, seed: sequence.settings.seed ?? 0, out: path.join(dir, 'mouths') }) : null;
      // The words and where they sit in the shot: the mouth shapes follow the vowels (a / i-e / u-o, closed on m-b-p).
      const spoken = lines.map((line, i) => ({ text: line.text, at: times[i], seconds: lengths[i] }));
      await lipSync({ lines: spoken, video, audio: voice, mode, box: mode === 'flaps' ? pixels : [pixels[0] - (pixels[2] - pixels[0]), pixels[1] - 2 * (pixels[3] - pixels[1]), pixels[2] + (pixels[2] - pixels[0]), pixels[3] + (pixels[3] - pixels[1])], mouths, out });
      const bytes = still
        ? await renderStill(out, { duration, motion: shot.details.motion, width: size.width, height: size.height, video: true })
        : await readFile(out);
      const saved = await assetStore.save({ bytes, projectId: sequence.projectId, kind: 'video', label: `Shot ${shot.position} (lip-synced)`, parentAssetId: source.id });
      const current = needShot(shot.id);
      repo.shots.update(shot.id, { videoAssetId: saved.id, review: { status: 'pending' },
        details: { ...current.details, lipsync: { source: source.id, result: saved.id, mode, box: pixels } } });
      await runChecks(shot.id);
      return detail(sequence.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // Free checks after every new clip: technical problems and drift from the approved frames.
  async function runChecks(shotId) {
    const shot = needShot(shotId);
    const clip = asset(shot.videoAssetId);
    if (!clip) return null;
    const sequence = needSequence(shot.sequenceId);
    const still = shot.details.method === 'still';
    const checks = await checkClip(assetStore.path(clip), { expectedSeconds: shot.duration, expectAudio: !still && !shot.details.muteClipSound, still });
    if (!still) {
      const generation = repo.generations.listByTarget(`shot-video:${shot.id}`).find((g) => g.assetId === clip.id);
      const start = asset(generation?.inputAssetIds?.[0]);
      const end = asset(generation?.params?.endFrameAssetId);
      checks.push(...await driftChecks(assetStore.path(clip), { startFrame: start ? assetStore.path(start) : null, endFrame: end ? assetStore.path(end) : null }));
      checks.push(...await animeChecks(assetStore.path(clip)));
    }
    // Identity: do the people in the shot still look like their reference photos? (Only when installed; real faces.)
    const hasCast = shotCast(sequence, shot).some((cid) => repo.characters.get(cid)?.kind === 'character');
    if (hasCast && (sequence.settings.look === 'anime' || !faces?.status().installed)) checks.push(identityNotVerified(sequence.settings.look));
    if (faces?.status().installed && sequence.settings.look !== 'anime') {
      const people = shotCast(sequence, shot).map((cid) => repo.characters.get(cid)).filter((c) => c && c.kind === 'character')
        .map((c) => ({ name: c.name, referencePaths: c.referenceAssetIds.map((rid) => asset(rid)).filter((a) => a?.mimeType?.startsWith('image/')).map((a) => assetStore.path(a)) }));
      checks.push(...await faces.checkClip(assetStore.path(clip), people, { duration: shot.duration ?? 4 }).catch((error) => [
        { id: 'faces', ok: false, status: 'unavailable', severity: 'warning', detail: `Face check could not run: ${error.message}` }]));
    }
    const speechChecks = dialogueFit(shot);
    if (speechChecks) checks.push(speechChecks);
    const current = needShot(shotId);
    if (current.videoAssetId !== clip.id) return null; // a newer clip arrived meanwhile
    const keep = current.review.status === 'accepted' && current.review.assetId === clip.id;
    repo.shots.update(shotId, {
      review: { ...current.review, assetId: clip.id, checks: checks.map(withStatus), checkedAt: new Date().toISOString(), status: keep ? 'accepted' : suggestedStatus(checks) },
    });
    log.info?.('Shot checked', { sequence: sequence.id, shot: shot.position, problems: checks.filter((c) => !c.ok).length });
    return checks;
  }

  // Does the recorded dialogue fit inside the shot?
  function dialogueFit(shot) {
    const lines = shot.details.dialogue ?? [];
    if (!lines.length) return null;
    const lengths = lines.map((line) => line.seconds ?? 0);
    if (lengths.some((s) => !s)) return null;
    const { overrun } = lineTimes(lines, playbackSeconds(shot), lengths);
    return { id: 'dialogue-fit', ok: overrun <= 0.05, severity: 'warning', detail: overrun > 0.05 ? `The dialogue runs ${overrun.toFixed(1)} s past the end of the shot` : 'The dialogue fits the shot' };
  }

  // Voices for a shot's dialogue: each line spoken in its character's voice (or the narrator's).
  function queueLine(shot, sequence, index) {
    const line = shot.details.dialogue[index];
    const target = `shot-line:${shot.id}:${index}`;
    if (active(target)) return { missing: null, generation: null };
    const speaker = line.speaker === 'narrator' ? null : repo.characters.get(line.speaker);
    const voice = speaker?.voice ?? sequence.settings.narratorVoice;
    if (!voice) return { missing: speaker?.name ?? 'Narrator', generation: null };
    return {
      missing: null,
      generation: generations.submit({
        projectId: sequence.projectId, operation: 'speech', prompt: line.text, provider: voice.provider, model: voice.model, voice: voice.voice, style: line.style,
        bookTarget: target,
      }),
    };
  }

  function makeDialogue(shotId) {
    const shot = needShot(shotId);
    const sequence = needSequence(shot.sequenceId);
    const queued = [];
    const missing = [];
    shot.details.dialogue.forEach((line, index) => {
      if (line.assetId && asset(line.assetId)) return;
      const result = queueLine(shot, sequence, index);
      if (result.missing) missing.push(result.missing);
      if (result.generation) queued.push(result.generation);
    });
    return { queued, missingVoices: [...new Set(missing)] };
  }

  // Re-voice ONE line: clears its recording (and measured length), optionally sets a new acting direction, and queues
  // only that line. Timing (`start`) is kept; change it with updateShot (details.dialogue[i].start).
  function rerecordLine(shotId, index, { style } = {}) {
    const shot = needShot(shotId);
    const sequence = needSequence(shot.sequenceId);
    const line = shot.details.dialogue[index];
    if (!Number.isInteger(index) || !line) throw new RequestError(404, `This shot has no dialogue line ${index} (lines count from 0).`);
    if (style !== undefined && typeof style !== 'string') throw new RequestError(400, 'style must be text.');
    if (active(`shot-line:${shot.id}:${index}`)) throw new RequestError(409, 'That line is being recorded right now. Wait for it to finish, then re-record it.');
    const speaker = line.speaker === 'narrator' ? null : repo.characters.get(line.speaker);
    if (!(speaker?.voice ?? sequence.settings.narratorVoice)) throw new RequestError(400, `${speaker?.name ?? 'The narrator'} has no voice yet. Set one first (set_character_voice).`);
    const dialogue = shot.details.dialogue.map((l, i) => (i === index ? { ...l, assetId: null, seconds: null, ...(style === undefined ? {} : { style: style.slice(0, 500) }) } : l));
    repo.shots.update(shot.id, { details: { ...shot.details, dialogue } });
    const result = queueLine(needShot(shotId), sequence, index);
    return { queued: result.generation ? [result.generation] : [], missingVoices: [] };
  }

  // Derived clips are made once per source clip and settings and kept with the shot.
  async function derived(shot, key, make) {
    const cached = asset(shot.details.post?.[key]);
    if (cached) return cached;
    const bytes = await make();
    if (!bytes) return null;
    const sequence = needSequence(shot.sequenceId);
    const saved = await assetStore.save({ bytes, projectId: sequence.projectId, kind: 'video', label: `Shot ${shot.position} (${key.split('|')[0]})`, parentAssetId: shot.videoAssetId });
    const current = needShot(shot.id);
    repo.shots.update(shot.id, { details: { ...current.details, post: { ...current.details.post, [key]: saved.id } } });
    return saved;
  }

  // Joining runs in the background: per-shot interpolation and upscaling (each made once, from the original),
  // the exact-length join, the soundtrack mix and the single delivery encode. Poll detail().join for progress.
  // `wait: true` resolves when it finishes.
  async function stitch(id, { wait = false } = {}) {
    const sequence = needSequence(id);
    if (joining.get(id)?.state === 'running') throw new RequestError(409, 'This storyboard is already being joined.');
    const shots = shotsOf(id);
    const usable = shots.filter((shot) => shot.videoAssetId && asset(shot.videoAssetId) && !['rejected', 'needs_regeneration'].includes(shot.review.status));
    if (!usable.length) throw new RequestError(400, 'Animate at least one shot first.');
    if (sequence.settings.requireApproval) {
      const waiting = shots.filter((shot) => shot.review.status !== 'accepted');
      if (waiting.length) throw new RequestError(409, `Approval required: accept every shot first (${waiting.length} not accepted yet: shot ${waiting.slice(0, 8).map((s) => s.position).join(', ')}${waiting.length > 8 ? '…' : ''}).`);
    }
    if (!(await hasFfmpeg())) throw new RequestError(501, 'Joining clips needs ffmpeg, which is not installed on this computer (on Debian/Ubuntu: sudo apt install ffmpeg).');
    const settings = sequence.settings;
    const editRevision = repo.settings.get(`editRevision:${id}`, null);
    const shotOrder = JSON.stringify(shots.map((s) => s.id));
    const size = outputSize(sequence);
    const postSteps = usable.length + (settings.upscale !== 'none' ? 1 : 0);
    const state = { state: 'running', done: 0, total: postSteps + 3, clips: usable.length, skipped: shots.length - usable.length, error: null, duration: null, step: 'Preparing shots' };
    joining.set(id, state);
    const progress = (step) => Object.assign(state, { done: Math.min(state.total, state.done + 1), step });
    const job = (async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'lumina-film-'));
      try {
        // 1. Interpolate within shots; never interpolate across the assembled film's cuts.
        const items = [];
        for (const shot of usable) {
          let clip = asset(shot.videoAssetId);
          const source = clip.id;
          if ((shot.details.interpolate || settings.interpolateFps) && shot.details.method !== 'still' && enhancer && !skipsSmoothing(shot.details, settings.look, Boolean(settings.interpolateFps))) {
            const smooth = await derived(shot, `smooth|${source}|30`, async () => (await enhancer.interpolate(assetStore.path(clip), { fps: 30 }))?.bytes ?? null);
            if (smooth) clip = smooth;
          }
          progress(`Shot ${shot.position}: smoothing`);
          items.push({ file: assetStore.path(clip), duration: shot.duration == null ? undefined : playbackSeconds(shot), trimStart: shot.details.trimStart || 0, mute: shot.details.muteClipSound, shot });
        }
        const sourceInfos = [];
        for (const item of items) sourceInfos.push(await probe(item.file));
        const rate = settings.interpolateFps === 30 ? 30 : filmFps(sourceInfos.map((info) => info.fps));
        items.forEach((item, index) => {
          const seconds = item.duration ?? Math.max(0, sourceInfos[index].duration - item.trimStart);
          if (!(seconds > 0)) throw new Error(`Shot ${item.shot.position} has no usable duration.`);
          item.duration = Math.max(1, Math.round(seconds * rate)) / rate;
        });
        // Preserve native detail through assembly; do not resize to delivery size before AI upscaling.
        const masterHeight = settings.upscale === 'none' ? size.height : Math.min(size.height,
          Math.max(...sourceInfos.map((info) => Math.min(info.height, info.width * size.height / size.width))));
        const even = (n) => Math.max(2, Math.round(n / 2) * 2);
        const masterSize = { width: even(masterHeight * size.width / size.height), height: even(masterHeight) };
        // 2. One colour grade across the film: each shot matched to its scene's (or the film's) first shot, applied
        // inside the join's own encode.
        if (settings.colorMatch !== 'off' && items.length > 1) {
          state.step = 'Matching colours between shots';
          const stats = [];
          for (const item of items) stats.push(await colourStats(item.file).catch(() => null));
          const anchors = new Map();
          items.forEach((item, i) => {
            const group = settings.colorMatch === 'film' ? '' : item.shot.details.scene || `shot-${i}`;
            if (!anchors.has(group) && stats[i]) anchors.set(group, i);
            const anchor = anchors.get(group);
            if (anchor !== undefined && anchor !== i && stats[i]) item.vf = curveFilter(matchCurve(stats[i], stats[anchor])) || undefined;
          });
        }
        // Anime exposure (twos / threes / holds) comes first, on the drawn clip only; a still shot's camera move stays smooth.
        for (const item of items) {
          const exposure = item.shot.details.method === 'still' ? '' : exposureFilter(item.shot.details, rate);
          if (exposure) item.vf = item.vf ? `${exposure},${item.vf}` : exposure;
        }
        // The shot's own look goes on top of the match, so "darker" stays darker than its neighbours.
        for (const item of items) {
          const look = gradeFilter(item.shot.details.grade);
          if (look) item.vf = item.vf ? `${item.vf},${look}` : look;
        }
        // 3. The picture: exact lengths, crossfades, near-lossless.
        state.step = 'Joining the shots';
        const edited = items.some(({ shot }) => shot.details.cutTransition || shot.details.speed !== 1 || shot.details.overlays.length || (editRevision !== null && shot.duration != null && !Number.isInteger(shot.duration)));
        const joined = edited
          ? await renderEdit(items, { settings, fps: rate, ...masterSize })
          : await stitchClips(items.map(({ shot, ...item }) => item), { transition: settings.transition, finish: 'none', size: masterSize, deliver: false, fps: rate });
        if (joined.timeline) items.forEach((item, i) => { item.duration = joined.timeline.shots[i].duration; });
        const picture = path.join(dir, 'picture.mp4');
        await import('node:fs/promises').then((fs) => fs.writeFile(picture, joined.bytes));
        progress('Mixing the sound');
        // 4. The sound: dialogue at its times, music and ambience under it.
        let clockSeconds = 0;
        const lines = [];
        const effects = [];
        const shotStarts = new Map();
        for (const item of items) {
          shotStarts.set(item.shot.id, clockSeconds);
          for (const effect of item.shot.details.sfx ?? []) {
            const audio = asset(effect.assetId);
            if (!audio) throw new Error(`Shot ${item.shot.position} has a deleted sound effect${effect.label ? ` (${effect.label})` : ''}.`);
            if (effect.at < (item.duration ?? 0)) effects.push({ file: assetStore.path(audio), at: clockSeconds + effect.at, volume: effect.volume });
          }
          const shotLines = (item.shot.details.dialogue ?? []).filter((line) => line.assetId);
          for (const line of shotLines) {
            if (!asset(line.assetId)) throw new Error(`Shot ${item.shot.position} has a deleted dialogue recording.`);
          }
          // Measured from the files every time (a cached length can still belong to the previous take), all at once.
          const measured = await Promise.all(shotLines.map((line) => mediaSeconds(assetStore.path(asset(line.assetId)))));
          const { times, overrun } = lineTimes(shotLines, item.duration ?? 0, measured);
          if (overrun > 1 / 48000) throw new Error(`Shot ${item.shot.position}: recorded dialogue exceeds the shot by ${overrun.toFixed(2)} seconds. Shorten the speech or extend the shot before finishing; original audio is retained.`);
          shotLines.forEach((line, i) => {
            const audio = asset(line.assetId);
            if (audio) lines.push({ file: assetStore.path(audio), at: clockSeconds + times[i] });
          });
          clockSeconds += item.duration ?? 0;
        }
        const bed = (value) => {
          const file = asset(value?.assetId);
          return file ? { file: assetStore.path(file), volume: value.volume } : null;
        };
        const mixed = path.join(dir, 'mixed.mp4');
        // Music per scene: settings.music until the first cue, then each cue's track from its shot's start.
        const starts = (settings.musicCues ?? []).filter((c) => shotStarts.has(c.shotId))
          .map((c) => ({ ...c, start: shotStarts.get(c.shotId) })).sort((a, b) => a.start - b.start);
        for (const cue of settings.musicCues ?? []) if (!shotStarts.has(cue.shotId)) log.warn?.('Music cue on a shot that is not in the film', { shotId: cue.shotId });
        const plan = [...(settings.music && (!starts.length || starts[0].start > 0) ? [{ ...settings.music, start: 0 }] : []), ...starts];
        const music = plan.map((m, i) => ({ ...bed(m), start: m.start, end: plan[i + 1]?.start ?? joined.duration })).filter((m) => m.file);
        for (const cue of starts) if (!asset(cue.assetId)) throw new Error('A music cue\'s track was deleted. Pick new music for that scene.');
        await mixSoundtrack(picture, mixed, { lines, music, effects, ambience: bed(settings.ambience), clipVolume: settings.clipVolume, duration: joined.duration });
        let deliverySource = mixed;
        if (settings.upscale !== 'none' && masterSize.height < size.height - 8) {
          if (!enhancer) throw new Error('The requested film upscaler is unavailable.');
          state.step = 'Upscaling the completed film';
          const digest = createHash('sha256').update(await readFile(mixed)).update(JSON.stringify([settings.upscale, size])).digest('hex');
          const cacheName = `filmUpscale:${id}`;
          const cache = repo.settings.get(cacheName, {});
          let upscaled = cache.digest === digest ? asset(cache.assetId) : null;
          if (!upscaled) {
            const result = await enhancer.enhanceVideo(mixed, { mode: settings.upscale, target: size,
              profile: 'mezzanine', deflicker: false }); // temporal deflicker would blend across hard cuts
            upscaled = await assetStore.save({ bytes: result.bytes, projectId: sequence.projectId,
              kind: 'video', label: `${sequence.title} (upscaled master)` });
            repo.settings.set(cacheName, { digest, assetId: upscaled.id });
          }
          deliverySource = assetStore.path(upscaled);
          state.upscaledMasterAssetId = upscaled.id;
          progress('Completed-film upscale');
        }
        progress('Final encode');
        // 5. One delivery encode, with the finish.
        const finished = path.join(dir, 'film.mp4');
        await deliverFilm(deliverySource, finished, { finish: settings.finish });
        const info = await probe(finished);
        if (Math.abs(info.duration - joined.duration) > 1 / rate + 0.005) throw new Error('Final film duration differs from the edit timeline by more than one frame.');
        if (!info.hasAudio) throw new Error('Final film lost its mixed audio track.');
        const saved = await assetStore.save({ bytes: await readFile(finished), projectId: sequence.projectId, kind: 'video', label: `${sequence.title} (film)` });
        repo.settings.set(`joinSettings:${id}`, { outputAssetId: saved.id, fingerprint: joinSettingsFingerprint(settings), editRevision, shotOrder });
        repo.sequences.update(id, { outputAssetId: saved.id });
        Object.assign(state, { state: 'completed', duration: info.duration, width: info.width, height: info.height, done: state.total, step: 'Done' });
        const production = producing.get(id);
        if (production?.state === 'running') Object.assign(production, { state: 'completed', step: `Done: ${Math.round(info.duration)} s film at ${info.width}×${info.height}` });
      } catch (error) {
        Object.assign(state, { state: 'failed', error: `Could not finish the film: ${error.message}` });
        const production = producing.get(id);
        if (production?.state === 'running') Object.assign(production, { state: 'paused', error: state.error });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    })();
    track(job);
    if (wait) {
      await job;
      if (state.state === 'failed') throw new RequestError(502, state.error);
    }
    return { ...detail(id), joined: usable.length, skipped: state.skipped, duration: state.duration };
  }

  // "Produce film": frames, clips, still shots, voices and the final film, run to the end without clicking
  // through each shot. Chained films go one shot at a time; otherwise all frames are made first (so they can be
  // approved together), then all clips. A failure pauses production; producing again resumes where it stopped.
  async function produce(id) {
    const sequence = needSequence(id);
    const shots = shotsOf(id).filter((s) => s.description.trim());
    if (!shots.length) throw new RequestError(400, 'Plan or add shots first.');
    if (shots.some((s) => s.details.method !== 'still')) {
      const video = choice(sequence, 'video');
      if (sequence.settings.continuity === 'chain' && !(providers?.model(video.provider, video.model)?.maxReferences > 0)) {
        throw new RequestError(400, 'Chained shots need a video model that can start from an image (for example Kling 3.0, Seedance 2.0 or Veo 3.1). Choose one, or switch continuity.');
      }
    }
    if (shots.some((s) => !s.imageAssetId)) choice(sequence, 'image');
    if (!(await hasFfmpeg())) throw new RequestError(501, 'Producing a film needs ffmpeg (on Debian/Ubuntu: sudo apt install ffmpeg).');
    const missingVoices = new Set();
    for (const shot of shots) for (const line of shot.details.dialogue) {
      if (line.assetId && asset(line.assetId)) continue;
      const character = line.speaker === 'narrator' ? null : repo.characters.get(line.speaker);
      const voice = character?.voice ?? sequence.settings.narratorVoice;
      if (!voice) missingVoices.add(character?.name ?? 'Narrator');
      else if (!providers?.model(voice.provider, voice.model)?.operations.includes('speech')) throw new RequestError(400, 'Choose an available speech model for every speaker.');
    }
    if (missingVoices.size) throw new RequestError(400, `Configure a voice before production for: ${[...missingVoices].join(', ')}.`);
    if (shots.some((s) => s.details.interpolate) || sequence.settings.interpolateFps) await enhancer?.rifeTool({ allowDownload: false });
    if (['anime', 'ai'].includes(sequence.settings.upscale)) await enhancer?.aiTool({ allowDownload: false });
    if (producing.get(id)?.state === 'running') throw new RequestError(409, 'This film is already in production.');
    producing.set(id, { state: 'running', step: 'Starting', error: null, startedAt: Date.now() });
    for (const shot of shots) makeDialogue(shot.id);
    await advance(id);
    return detail(id);
  }

  function stopAllProductions() {
    for (const production of producing.values()) if (production.state === 'running') Object.assign(production, { state: 'paused', step: 'App closing; queued jobs will finish' });
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
      const shots = shotsOf(id).filter((s) => s.description.trim());
      const lineBusy = (s) => (s.details.dialogue ?? []).some((_, i) => busyJob(`shot-line:${s.id}:${i}`));
      if (shots.some((s) => busyJob(`shot-image:${s.id}`) || busyJob(`shot-video:${s.id}`) || lineBusy(s))) return;
      const total = shots.length;
      if (budget?.settings().enabled && budget.settings().strictPrices) {
        const waiting = shots.find((s) => s.videoAssetId && paidClip(sequence, s) && s.review.status !== 'accepted');
        if (waiting) {
          Object.assign(production, { state: 'review', step: `Review paid shot ${waiting.position} before spending on the next clip` });
          return;
        }
      }
      if (sequence.settings.continuity === 'chain') {
        const index = shots.findIndex((s) => !s.videoAssetId);
        if (index >= 0) {
          const shot = shots[index];
          const previous = shots[index - 1];
          if (shot.details.method === 'still' || index === 0 || !previous?.videoAssetId) {
            if (!shot.imageAssetId) {
              production.step = `Shot ${index + 1} of ${total}: making the frame`;
              generateFrame(shot.id);
              return;
            }
          } else {
            // The previous clip's last frame becomes this shot's start frame.
            const before = repo.assets.get(previous.videoAssetId);
            const bytes = await lastFrame(assetStore.path(before));
            const frame = await assetStore.save({ bytes, projectId: sequence.projectId, kind: 'image', label: `Shot ${shot.position} start (end of shot ${previous.position})`, parentAssetId: before.id });
            repo.shots.update(shot.id, { imageAssetId: frame.id });
          }
          if (shot.details.method === 'still') {
            production.step = `Shot ${index + 1} of ${total}: rendering the still shot`;
            await renderStillShot(shot.id);
            rerun.add(id);
            return;
          }
          if (sequence.settings.requireApproval && (!shot.imageAssetId || shot.review.frameApproved !== shot.imageAssetId)) {
            Object.assign(production, { state: 'review', step: `Approve the frame of shot ${shot.position}, then press Produce film again` });
            return;
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
        // Frames first, all of them: with approval required, production waits here so the frames (which decide
        // every face and set) are approved before any money goes on video.
        if (sequence.settings.requireApproval && !production.framesApproved) {
          const unapproved = shots.filter((s) => !s.videoAssetId && s.review.frameApproved !== s.imageAssetId);
          if (unapproved.length) {
            Object.assign(production, { state: 'review', step: `Approve the frames of ${unapproved.length} shot(s), then press Produce film again` });
            return;
          }
        }
        for (const shot of shots.filter((s) => !s.videoAssetId && s.details.method === 'still')) {
          production.step = `Shot ${shot.position}: rendering the still shot`;
          await renderStillShot(shot.id);
        }
        const needClips = shotsOf(id).filter((s) => s.description.trim() && !s.videoAssetId);
        if (needClips.length) {
          production.step = `Making ${needClips.length} clip(s) (${total - needClips.length} of ${total} done)`;
          if (budget?.settings().enabled && budget.settings().strictPrices) {
            for (const shot of needClips.filter((s) => !paidClip(sequence, s))) animate(shot.id);
            const paid = needClips.find((s) => paidClip(sequence, s));
            if (paid) animate(paid.id);
          } else for (const shot of needClips) animate(shot.id);
          return;
        }
      }
      const fresh = shotsOf(id).filter((s) => s.description.trim());
      if (sequence.settings.requireApproval && fresh.some((s) => s.review.status !== 'accepted')) {
        const waiting = fresh.filter((s) => s.review.status !== 'accepted').length;
        Object.assign(production, { state: 'review', step: `All clips are made. Accept (or redo) ${waiting} shot(s), then press Produce film again to finish the film` });
        return;
      }
      production.step = 'Finishing the film';
      await stitch(id);
    } catch (error) {
      Object.assign(production, { state: 'paused', error: error.message });
    } finally {
      advancing.delete(id);
      if (rerun.delete(id)) await advance(id);
    }
  }

  // Frame approval (before any video is paid for, when approval is required).
  function approveFrame(shotId, approved = true) {
    const shot = needShot(shotId);
    if (approved && !shot.imageAssetId) throw new RequestError(400, 'This shot has no frame yet.');
    repo.shots.update(shotId, { review: { ...shot.review, frameApproved: approved ? shot.imageAssetId : null } });
    return detail(shot.sequenceId);
  }

  function onGenerationUpdate(generation) {
    if (!generation.bookTarget) return;
    const [kind, id, lineIndex] = generation.bookTarget.split(':');
    if (!['shot-image', 'shot-video', 'shot-line'].includes(kind)) return;
    const shot = getShot(id);
    if (!shot) return;
    if (generation.status === 'completed') {
      if (kind === 'shot-image') repo.shots.update(id, { imageAssetId: generation.assetId, review: { ...shot.review, frameApproved: null, status: 'pending' } });
      if (kind === 'shot-video') {
        repo.shots.update(id, { videoAssetId: generation.assetId, review: { status: 'pending' } });
        track(runChecks(id).catch((error) => log.error?.('Shot checks failed', { detail: error.message })));
      }
      if (kind === 'shot-line') {
        const index = Number(lineIndex);
        const dialogue = [...(shot.details.dialogue ?? [])];
        const line = dialogue[index];
        // Only keep the audio if the line still says what was recorded.
        if (line && line.text === generation.prompt) {
          const audio = asset(generation.assetId);
          dialogue[index] = { ...line, assetId: generation.assetId, seconds: null }; // measured just below
          repo.shots.update(id, { details: { ...shot.details, dialogue } });
          if (audio) {
            track(mediaSeconds(assetStore.path(audio)).catch(() => null).then((seconds) => {
              const current = getShot(id);
              if (!seconds || !current) return;
              const lines = [...current.details.dialogue];
              if (lines[index]?.assetId === generation.assetId) {
                lines[index] = { ...lines[index], seconds: Math.round(seconds * 100) / 100 };
                repo.shots.update(id, { details: { ...current.details, dialogue: lines } });
              }
            }));
          }
        }
      }
    }
    const production = producing.get(shot.sequenceId);
    if (production?.state !== 'running') return;
    if (['failed', 'interrupted'].includes(generation.status)) {
      const what = kind === 'shot-image' ? 'frame' : kind === 'shot-video' ? 'clip' : 'voice line';
      Object.assign(production, { state: 'paused', error: `Shot ${shot.position} ${what} failed: ${generation.userError ?? 'unknown error'}. Fix it, then press Produce film to continue.` });
      return;
    }
    if (generation.status === 'completed') track(advance(shot.sequenceId).catch((error) => log.error?.('Production step failed', { detail: error.message })));
  }

  // ---------- Takes: every frame and clip a shot ever had, and picking between them ----------
  // Frames: every finished frame job (and repair job) of the shot. Clips: every finished clip job, clips attached by
  // hand, and clips made from those (lip-synced or still renders). The current choice is flagged and always listed.
  function takes(shotId) {
    const shot = needShot(shotId);
    const sequence = needSequence(shot.sequenceId);
    const done = (target) => repo.generations.listByTarget(target).filter((g) => g.status === 'completed' && g.assetId && asset(g.assetId));
    const entry = (id, extra = {}) => {
      const a = asset(id);
      return { assetId: id, path: a.path, createdAt: a.createdAt, label: a.label ?? null, ...extra };
    };
    const frames = new Map();
    for (const g of done(`shot-image:${shot.id}`)) frames.set(g.assetId, entry(g.assetId, { generationId: g.id, source: 'frame' }));
    for (const g of done(`shot-repair:${shot.id}`)) frames.set(g.assetId, entry(g.assetId, { generationId: g.id, source: 'repair' }));
    if (shot.imageAssetId && asset(shot.imageAssetId) && !frames.has(shot.imageAssetId)) frames.set(shot.imageAssetId, entry(shot.imageAssetId, { generationId: null, source: 'other' }));
    const clips = new Map();
    for (const g of done(`shot-video:${shot.id}`)) clips.set(g.assetId, entry(g.assetId, { generationId: g.id, source: 'clip' }));
    for (const id of shot.details.attachedClips ?? []) if (asset(id)) clips.set(id, entry(id, { generationId: null, source: 'attached' }));
    // Clips made from a take (lip sync, still renders): walk up each project video's parents until a take is found.
    const byId = new Map(repo.assets.listByProject(sequence.projectId).map((a) => [a.id, a]));
    const belongs = (a) => {
      for (let hop = 0, cur = a; cur?.parentAssetId && hop < 6; hop += 1, cur = byId.get(cur.parentAssetId)) {
        if (clips.has(cur.parentAssetId) || frames.has(cur.parentAssetId)) return true;
      }
      return false;
    };
    for (const a of byId.values()) {
      if (a.kind === 'video' && !clips.has(a.id) && /\((lip-synced|still,)/.test(a.label ?? '') && belongs(a)) clips.set(a.id, entry(a.id, { generationId: null, source: /lip-synced/.test(a.label) ? 'lip-synced' : 'still' }));
    }
    if (shot.videoAssetId && asset(shot.videoAssetId) && !clips.has(shot.videoAssetId)) clips.set(shot.videoAssetId, entry(shot.videoAssetId, { generationId: null, source: 'other' }));
    const list = (map, current) => [...map.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map((t) => ({ ...t, current: t.assetId === current }));
    return { shotId: shot.id, position: shot.position, frames: list(frames, shot.imageAssetId), clips: list(clips, shot.videoAssetId) };
  }

  // Switch the shot to another take. Like any new frame/clip, the review goes back to pending and a clip is checked again.
  // Lip sync bookkeeping follows the clip: choosing a lip-synced take records it as the shot's synced result, so a later
  // lip sync starts from its original clip; derived caches (smooth/upscale) are keyed by source clip and stay valid.
  async function selectTake(shotId, { kind, assetId } = {}) {
    if (!['frame', 'clip'].includes(kind)) throw new RequestError(400, 'kind must be "frame" or "clip".');
    const shot = needShot(shotId);
    const chosen = takes(shotId)[kind === 'frame' ? 'frames' : 'clips'].find((t) => t.assetId === assetId);
    if (!chosen) throw new RequestError(404, `That ${kind} is not one of this shot's takes. List them with GET /api/shots/${shotId}/takes.`);
    if (kind === 'frame') {
      repo.shots.update(shotId, { imageAssetId: assetId, review: { ...shot.review, frameApproved: null } });
      return detail(shot.sequenceId);
    }
    const parent = asset(assetId)?.parentAssetId;
    const syncedTake = chosen.source === 'lip-synced' && parent && asset(parent);
    repo.shots.update(shotId, {
      videoAssetId: assetId, review: { status: 'pending' },
      ...(syncedTake ? { details: { ...shot.details, lipsync: { ...(shot.details.lipsync ?? {}), source: parent, result: assetId, mode: shot.details.lipsync?.mode ?? null, box: shot.details.lipsync?.box ?? null } } } : {}),
    });
    await runChecks(shotId);
    return detail(shot.sequenceId);
  }

  // Use an imported video (library asset) as this shot's clip.
  async function attachClip(shotId, { assetId } = {}) {
    const shot = needShot(shotId);
    const sequence = needSequence(shot.sequenceId);
    const clip = asset(assetId);
    if (!clip) throw new RequestError(404, 'Video not found. Import one first (import_video).');
    if (clip.kind !== 'video') throw new RequestError(400, 'Choose a video asset.');
    if (clip.projectId !== sequence.projectId) throw new RequestError(400, 'That video belongs to another project.');
    if (!(shot.details.attachedClips ?? []).includes(assetId)) repo.shots.update(shotId, { details: { ...shot.details, attachedClips: [...(shot.details.attachedClips ?? []), assetId] } });
    return selectTake(shotId, { kind: 'clip', assetId });
  }

  // Repair part of a frame: a mask is drawn from the box (white = repaint, black = keep) at the frame's own size and an
  // inpaint job repaints just that area. The result is a new frame take; it is NOT selected (selectTake does that).
  function pickInpaint(override = {}) {
    const ready = (p) => (p.keyless ? p.available?.() ?? true : Boolean(keys.get(p.id)));
    const options = (providers?.list ?? []).filter((p) => (!override.provider || p.id === override.provider) && ready(p))
      .flatMap((p) => p.models.filter((m) => m.operations?.includes('inpaint') && (p.modelAvailable?.(m.id) ?? true) && (!override.model || m.id === override.model)).map((m) => ({ provider: p.id, model: m.id, keyless: p.keyless })));
    return options.sort((a, b) => Number(Boolean(b.keyless)) - Number(Boolean(a.keyless)))[0] ?? null;
  }
  async function repairFrame(shotId, { box, instruction, provider, model } = {}) {
    const shot = needShot(shotId);
    const sequence = needSequence(shot.sequenceId);
    const frame = asset(shot.imageAssetId);
    if (!frame) throw new RequestError(400, 'This shot has no frame to repair yet.');
    if (!Array.isArray(box) || box.length !== 4 || box.some((v) => !Number.isFinite(Number(v)) || v < 0 || v > 1)) throw new RequestError(400, 'box must be [x1, y1, x2, y2] as fractions of the frame (0-1).');
    const [x1, y1, x2, y2] = box.map(Number);
    if (x2 - x1 < 0.01 || y2 - y1 < 0.01) throw new RequestError(400, 'The box is empty: x2 must be greater than x1 and y2 greater than y1.');
    if (typeof instruction !== 'string' || !instruction.trim()) throw new RequestError(400, 'Describe what should appear in the box (instruction).');
    const running = active(`shot-repair:${shot.id}`);
    if (running) return { generation: running, alreadyRunning: true };
    const picked = pickInpaint({ provider, model });
    if (!picked) throw new RequestError(409, 'No inpaint-capable image model is ready. Add an API key for one (for example fal.ai FLUX.1 Fill pro) or install a local one in Lumina Settings, then try again.');
    const size = imageSize((await assetStore.read(frame)).bytes) ?? { width: 1024, height: 1024 };
    const mask = encodePng(size.width, size.height, (x, y) => {
      const inside = x >= x1 * size.width && x < x2 * size.width && y >= y1 * size.height && y < y2 * size.height;
      return inside ? [255, 255, 255] : [0, 0, 0];
    });
    const saved = await assetStore.save({ bytes: mask, projectId: sequence.projectId, kind: 'mask', label: `Shot ${shot.position} repair mask` });
    const prompt = `${instruction.trim().slice(0, 3000)}\nMatch the surrounding art style, line work, colours and lighting; change nothing outside the painted area.`;
    return {
      generation: generations.submit({
        projectId: sequence.projectId, operation: 'inpaint', prompt, provider: picked.provider, model: picked.model,
        inputAssetIds: [frame.id], maskAssetId: saved.id, bookTarget: `shot-repair:${shot.id}`,
      }),
    };
  }

  // ---------- Editable export: originals plus a timeline an editor can open ----------
  const timecode = (seconds, fps) => {
    const total = Math.round(Math.max(0, seconds) * fps);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(Math.floor(total / (fps * 3600)))}:${pad(Math.floor(total / (fps * 60)) % 60)}:${pad(Math.floor(total / fps) % 60)}:${pad(total % fps)}`;
  };
  const srtTime = (seconds) => {
    const ms = Math.round(Math.max(0, seconds) * 1000);
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
  };
  const safeName = (text) => String(text).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'film';

  // Subtitle cues for the joined film: every line at its start, as long as its recording (or a reading estimate).
  const speakerName = (line) => (line.speaker === 'narrator' ? 'Narrator' : repo.characters.get(line.speaker)?.name ?? 'Unknown');
  function subtitleCues(shots) {
    const cues = [];
    let clock = 0;
    for (const shot of shots) {
      const duration = Math.max(1, Math.round(playbackSeconds(shot) * 24)) / 24;
      const lines = shot.details.dialogue ?? [];
      const lengths = lines.map((l) => l.seconds ?? Math.max(1, l.text.split(/\s+/).length / 2.5));
      const { times } = lineTimes(lines, duration, lengths);
      lines.forEach((line, i) => cues.push({ shotId: shot.id, line: i, from: clock + times[i], to: Math.min(clock + duration, clock + times[i] + lengths[i]),
        text: line.speaker === 'narrator' ? line.text : `${speakerName(line)}: ${line.text}` }));
      clock += duration;
    }
    return cues;
  }

  // Everything a published film must credit: the voice cast, and the music and sound effects downloaded from
  // the internet (credit lines kept by src/music.js under music-credit:<assetId>).
  function filmCredits(id) {
    const sequence = needSequence(id);
    const shots = shotsOf(id);
    const creditOf = (assetId) => (assetId ? repo.settings.get(`music-credit:${assetId}`, null) : null);
    const speakers = new Set(shots.flatMap((s) => (s.details.dialogue ?? []).map((l) => l.speaker)));
    const voiceLabel = (v) => (v ? `${v.voice ?? 'default'} (${v.model})` : 'no voice set');
    const voices = [...speakers].map((speaker) => (speaker === 'narrator'
      ? { name: 'Narrator', voice: voiceLabel(sequence.settings.narratorVoice) }
      : { name: repo.characters.get(speaker)?.name ?? 'Unknown', voice: voiceLabel(repo.characters.get(speaker)?.voice) }));
    const musicIds = [sequence.settings.music?.assetId, sequence.settings.ambience?.assetId, ...(sequence.settings.musicCues ?? []).map((c) => c.assetId)].filter(Boolean);
    const soundIds = shots.flatMap((s) => (s.details.sfx ?? []).map((e) => e.assetId));
    const unique = (ids) => [...new Set(ids)].map(creditOf).filter(Boolean)
      .map(({ title, creator, license, needsCredit, credit, page }) => ({ title, creator, license, needsCredit, credit, page }));
    return { title: sequence.title, voices, music: unique(musicIds), sounds: unique(soundIds) };
  }

  async function exportProject(id, exportDir, { fps = 24 } = {}) {
    const sequence = needSequence(id);
    const shots = shotsOf(id);
    const folder = path.join(exportDir, `${safeName(sequence.title)}-edit-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    for (const sub of ['frames', 'clips', 'dialogue', 'music']) await mkdir(path.join(folder, sub), { recursive: true });
    const files = [];
    const copy = async (a, sub, name) => {
      const out = `${sub}/${name}${path.extname(a.file)}`;
      await copyFile(assetStore.path(a), path.join(folder, out));
      files.push(out);
      return out;
    };
    const pad = (n) => String(n).padStart(2, '0');
    const timeline = [];
    const subtitles = subtitleCues(shots);
    let clock = 0;
    for (const shot of shots) {
      const duration = Math.max(1, Math.round(playbackSeconds(shot) * 24)) / 24;
      const frame = asset(shot.imageAssetId);
      const clip = asset(shot.videoAssetId);
      const lines = shot.details.dialogue ?? [];
      const lengths = lines.map((l) => l.seconds ?? Math.max(1, l.text.split(/\s+/).length / 2.5));
      const { times } = lineTimes(lines, duration, lengths);
      const dialogue = [];
      for (const [i, line] of lines.entries()) {
        const voice = asset(line.assetId);
        const speaker = speakerName(line);
        const file = voice ? await copy(voice, 'dialogue', `${pad(shot.position)}-${pad(i + 1)}-${safeName(speaker)}`) : null;
        dialogue.push({ speaker, text: line.text, file, start: Math.round(times[i] * 1000) / 1000, seconds: lengths[i], recorded: Boolean(voice), timingSet: Number.isFinite(line.start) });
      }
      timeline.push({
        shot: shot.position, shotId: shot.id, description: shot.description, scene: shot.details.scene || null, start: clock, duration, sourceDuration: shot.duration, speed: shot.details.speed, keepPitch: shot.details.keepPitch, transition: shot.details.cutTransition, overlays: shot.details.overlays, trimStart: shot.details.trimStart || 0,
        frame: frame ? await copy(frame, 'frames', pad(shot.position)) : null, clip: clip ? await copy(clip, 'clips', pad(shot.position)) : null,
        muteClipSound: Boolean(shot.details.muteClipSound), review: shot.review.status ?? 'pending', dialogue,
      });
      clock += duration;
    }
    const beds = [];
    for (const [role, bed] of [['music', sequence.settings.music], ['ambience', sequence.settings.ambience]]) {
      const a = bed?.assetId ? asset(bed.assetId) : null;
      if (a) beds.push({ role, file: await copy(a, 'music', role), volume: bed.volume });
    }
    const write = async (name, content) => {
      await writeFile(path.join(folder, name), content);
      files.push(name);
    };
    await write('timeline.json', JSON.stringify({ title: sequence.title, fps, aspect: sequence.settings.aspect, transition: sequence.settings.transition, totalSeconds: clock, clipVolume: sequence.settings.clipVolume, audioBeds: beds, shots: timeline }, null, 2));
    // CMX 3600 EDL: one video event per shot that has a clip; source in/out follow trimStart and the shot's length.
    const events = timeline.filter((s) => s.clip);
    await write('timeline.edl', [`TITLE: ${sequence.title.replace(/\s+/g, ' ')}`, 'FCM: NON-DROP FRAME', '',
      ...events.flatMap((s, i) => [
        `${String(i + 1).padStart(3, '0')}  AX       V     C        ${timecode(s.trimStart, fps)} ${timecode(s.trimStart + s.duration * s.speed, fps)} ${timecode(s.start, fps)} ${timecode(s.start + s.duration, fps)}`,
        `* FROM CLIP NAME: ${path.basename(s.clip)}`, `* SHOT ${s.shot}${s.scene ? ` (${s.scene})` : ''}`, '']),
    ].join('\n'));
    await write('subtitles.srt', subtitles.map((c, i) => `${i + 1}\n${srtTime(c.from)} --> ${srtTime(c.to)}\n${c.text}\n`).join('\n'));
    return { folder, files };
  }

  // Signature of what a shot's film depends on (for reports): its clip, frame and recorded lines.
  const shotFingerprint = (shot) => createHash('sha256').update(JSON.stringify([shot.videoAssetId, shot.imageAssetId, shot.details.dialogue?.map((l) => l.assetId)])).digest('hex').slice(0, 12);

  return {
    subtitleCues: (id) => subtitleCues(shotsOf(needSequence(id).id)), filmCredits, srtTime,
    insertShot, duplicateShot, splitShot, deleteShot, setCutTransition, setShotSpeed, addTextOverlay, reorderScene, shotTimeline, makeAnimatic,
    detail, create, update, plan, importPlan, updateShot, review, approveFrame, composedPrompts, generateFrame, animate, renderStillShot, runChecks, makeDialogue, rerecordLine, lipSyncShot, takes, selectTake, attachClip, repairFrame, exportProject,
    stitch, produce, stopProduction, stopAllProductions, onGenerationUpdate, idle, needShot, needSequence, outputSize, shotFingerprint,
  };
}
