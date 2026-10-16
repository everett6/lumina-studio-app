import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveFonts } from './fonts.js';
import { lineTimes, mixSoundtrack } from './soundtrack.js';
import { mediaSeconds, probe, run } from './video.js';

export const cutTransitions = ['cut', 'crossfade', 'fade-black', 'fade-white'];
export const overlayPositions = ['top', 'center', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];
export const overlayStyles = ['sign', 'caption', 'title'];
export const playbackSeconds = (shot) => (shot.duration ?? 5) / (shot.details?.speed ?? 1);

// Outgoing handles preserve the planned runtime, matching the existing storyboard-wide dissolve.
export function editTimeline(shots, settings = {}, fps = 24) {
  // Keep the 24 fps ledger authoritative. Quantize cumulative boundaries for a 12 fps preview,
  // rather than accumulating a half-frame rounding error at every cut.
  let canonical = 0, rounded = 0;
  const durations = shots.map((shot) => {
    canonical += Math.max(1, Math.round(playbackSeconds(shot) * 24));
    const end = Math.round(canonical * fps / 24), count = end - rounded;
    rounded = end;
    return count;
  });
  let clock = 0;
  const rows = shots.map((shot, i) => {
    const own = shot.details?.cutTransition;
    const type = own?.transition ?? settings.transition ?? 'cut';
    const defaultEnabled = shots.length > 1 && durations.every((d) => d / fps > 1.3);
    const wanted = i < shots.length - 1 && type !== 'cut' && (own || defaultEnabled);
    const frames = wanted ? Math.max(0, Math.min(Math.round((own?.seconds ?? 0.5) * fps), durations[i] - 1, durations[i + 1] - 1)) : 0;
    const startFrame = clock;
    clock += durations[i];
    return { shotId: shot.id, position: shot.position, label: shot.description, scene: shot.details?.scene ?? '',
      start: startFrame / fps, end: clock / fps, duration: durations[i] / fps,
      startFrame, endFrame: clock, durationFrames: durations[i],
      transition: { transition: frames ? type : 'cut', seconds: frames / fps, frames },
      speed: shot.details?.speed ?? 1, keepPitch: shot.details?.keepPitch ?? true, overlays: shot.details?.overlays ?? [] };
  });
  return { fps, totalSeconds: clock / fps, totalFrames: clock, shots: rows };
}

const encode = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '0', '-threads', '2', '-pix_fmt', 'yuv420p'];
const audio = ['-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2'];
// Bound decoder threads too: ffmpeg 8 can stall frame-threaded H.264 decoding when
// sped-up timestamps and atempo share a source. A single decoder thread also caps preview CPU.
const ffmpeg = (args) => run('ffmpeg', ['-v', 'error', '-nostdin', '-filter_threads', '1', '-filter_complex_threads', '1', '-threads', '1', ...args], 600_000);
const tempo = (speed) => {
  const factors = [];
  while (speed < 0.5) { factors.push(0.5); speed /= 0.5; }
  while (speed > 2) { factors.push(2); speed /= 2; }
  factors.push(speed);
  return factors.map((n) => `atempo=${n}`).join(',');
};

// Literal UTF-8 text files plus expansion=none keep quotes, %, backslashes and filter syntax inert.
export async function overlayFilters(dir, overlays, width, height, prefix = 'overlay') {
  const filters = [];
  for (const [i, layer] of overlays.entries()) {
    const file = path.join(dir, `${prefix}-${i}.txt`);
    await writeFile(file, layer.text);
    const resolved = resolveFonts(layer.text, { serif: false });
    let font = resolved?.fonts?.[Object.keys(resolved?.fonts ?? {}).find((key) => key !== 'base')]?.file ?? resolved?.fonts?.base?.file;
    if (!font) font = (await run('fc-match', ['-f', '%{file}', 'sans-serif:style=Bold'], 5000)).trim();
    const fontFile = path.join(dir, `${prefix}-${i}.ttf`);
    if (font) await copyFile(font, fontFile);
    const fs = Math.max(12, Math.round(height * (layer.style === 'title' ? 0.08 : layer.style === 'sign' ? 0.06 : 0.045)));
    const position = layer.position ?? 'bottom';
    const x = position.endsWith('left') ? 'w*0.05' : position.endsWith('right') ? 'w*0.95-text_w' : '(w-text_w)/2';
    const y = position.startsWith('top') ? 'h*0.06' : position === 'center' ? '(h-text_h)/2' : 'h*0.94-text_h';
    filters.push(`drawtext=${font ? `fontfile=${fontFile}:` : ''}textfile=${file}:expansion=none:fontsize=${fs}:fontcolor=white:borderw=2:bordercolor=black:box=${layer.style === 'caption' ? 1 : 0}:boxcolor=black@0.55:x=${x}:y=${y}:enable='gte(t,${layer.start})*lt(t,${layer.start + layer.seconds})'`);
  }
  return filters.join(',');
}

// Shared CPU assembler for per-shot edits and animatics. Each item owns a temporary normalized piece;
// outgoing transitions lend extra source/held frames, never shorten the next shot or shift dialogue.
export async function renderEdit(items, { settings = {}, fps = 24, width = 640, height = 360 } = {}) {
  const timeline = editTimeline(items.map((item) => item.shot), settings, fps);
  if (!items.length) throw new Error('The storyboard has no shots.');
  const dir = await mkdtemp(path.join(tmpdir(), 'lumina-edit-'));
  try {
    const parts = [];
    // A shot shorter than one preview frame can disappear at 12 fps; the 24 fps timeline retains it.
    const visible = items.map((item, i) => ({ item, row: timeline.shots[i] })).filter(({ row }) => row.durationFrames > 0);
    for (const [i, { item, row }] of visible.entries()) {
      const shot = item.shot;
      const length = row.duration + row.transition.seconds;
      const still = item.still === true;
      const info = !still ? await probe(item.file) : null;
      const source = still ? item.file ? ['-loop', '1', '-framerate', String(fps), '-i', item.file] : ['-f', 'lavfi', '-i', `color=c=0x20232b:s=${width}x${height}:r=${fps}`]
        : [...(shot.details.trimStart ? ['-ss', String(shot.details.trimStart)] : []), '-i', item.file];
      const sound = !still && info.hasAudio && !shot.details.muteClipSound;
      const overlays = [...(shot.details.overlays ?? []), ...(item.labels ?? [])];
      const text = await overlayFilters(dir, overlays, width, height, `shot-${i}`);
      const vf = [!still && row.speed !== 1 ? `setpts=(PTS-STARTPTS)/${row.speed}` : 'setpts=PTS-STARTPTS',
        item.vf, `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
        `fps=${fps}`, `tpad=stop_mode=clone:stop_duration=${Math.ceil(length + 1)}`, text, `trim=duration=${length}`, `settb=1/${fps}`, 'format=yuv420p'].filter(Boolean).join(',');
      const af = sound && row.speed !== 1 ? row.keepPitch ? tempo(row.speed) : `asetrate=48000*${row.speed},aresample=48000` : '';
      const part = path.join(dir, `part-${i}.mov`);
      await ffmpeg([...source, ...(!sound ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'] : []), '-map', '0:v', '-map', sound ? '0:a' : '1:a',
        '-vf', vf, '-af', ['aresample=48000', af, 'aformat=sample_fmts=s16:channel_layouts=stereo', 'asetpts=PTS-STARTPTS', 'apad', `atrim=duration=${length}`].filter(Boolean).join(','),
        ...encode, ...audio, '-frames:v', String(row.durationFrames + row.transition.frames), '-t', String(length), '-y', part]);
      parts.push(part);
    }
    // Render each boundary once, then concatenate with stream copy. Work is linear in runtime,
    // rather than repeatedly encoding an ever-growing prefix of the film.
    const pieces = [];
    for (let i = 0; i < parts.length; i++) {
      const row = visible[i].row;
      const incoming = i ? visible[i - 1].row.transition.frames : 0;
      const body = path.join(dir, `body-${i}.mov`);
      await ffmpeg(['-i', parts[i], '-ss', String(incoming / fps), '-t', String((row.durationFrames - incoming) / fps),
        ...encode, ...audio, '-frames:v', String(row.durationFrames - incoming), '-y', body]);
      pieces.push({ file: body, duration: (row.durationFrames - incoming) / fps });
      const fade = row.transition.seconds;
      if (!fade || i === parts.length - 1) continue;
      const blend = path.join(dir, `blend-${i}.mov`);
      const transition = ({ crossfade: 'fade', 'fade-black': 'fadeblack', 'fade-white': 'fadewhite' })[row.transition.transition];
      await ffmpeg(['-ss', String(row.duration), '-i', parts[i], '-i', parts[i + 1],
        '-filter_complex', `[0:v]settb=1/${fps},setpts=PTS-STARTPTS[a];[1:v]settb=1/${fps},setpts=PTS-STARTPTS[b];[a][b]xfade=transition=${transition}:duration=${fade}:offset=0[v];[0:a]asetpts=PTS-STARTPTS[x];[1:a]asetpts=PTS-STARTPTS[y];[x][y]acrossfade=d=${fade}[a]`,
        '-map', '[v]', '-map', '[a]', ...encode, ...audio, '-frames:v', String(row.transition.frames), '-t', String(fade), '-y', blend]);
      pieces.push({ file: blend, duration: fade });
    }
    const list = path.join(dir, 'concat.txt');
    await writeFile(list, pieces.map((piece) => `file '${piece.file}'\nduration ${piece.duration.toFixed(9)}`).join('\n'));
    const out = path.join(dir, 'edit.mp4');
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'copy', '-c:a', 'aac', '-t', String(timeline.totalSeconds), '-movflags', '+faststart', '-y', out]);
    return { bytes: await readFile(out), duration: timeline.totalSeconds, width, height, timeline };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function createAnimatic({ shots, sequence, repo, assetStore, fps = 12, includeDialogue = true }) {
  if (![12, 24].includes(fps) || typeof includeDialogue !== 'boolean') throw Object.assign(new Error('fps must be 12 or 24; includeDialogue must be boolean.'), { status: 400 });
  const timeline = editTimeline(shots, sequence.settings, fps);
  const shotsWithoutFrames = [], dialogueOverruns = [], lines = [];
  const items = [];
  for (const [i, shot] of shots.entries()) {
    const frame = shot.imageAssetId ? repo.assets.get(shot.imageAssetId) : null;
    if (!frame) shotsWithoutFrames.push(shot.id);
    const row = timeline.shots[i];
    items.push({ shot, still: true, file: frame ? assetStore.path(frame) : null, labels: [
      { text: `${shot.position}. ${shot.description.slice(0, 90)}`, position: 'top-left', start: 0, seconds: row.duration + row.transition.seconds, style: 'caption' },
      ...(!frame ? [{ text: 'No frame', position: 'center', start: 0, seconds: row.duration + row.transition.seconds, style: 'title' }] : []),
    ] });
    const dialogue = shot.details.dialogue ?? [];
    const recordings = dialogue.map((line) => line.assetId ? repo.assets.get(line.assetId) : null);
    const lengths = await Promise.all(recordings.map((asset, j) => asset ? mediaSeconds(assetStore.path(asset)) : dialogue[j].seconds ?? 0));
    const { times } = lineTimes(dialogue, row.duration, lengths);
    dialogue.forEach((line, j) => {
      const overrun = times[j] + lengths[j] - row.duration;
      if (overrun > 1 / 48000) dialogueOverruns.push({ shotId: shot.id, lineIndex: j, seconds: overrun });
      if (includeDialogue && recordings[j] && times[j] < row.duration) lines.push({ file: assetStore.path(recordings[j]), at: row.start + times[j], seconds: Math.min(lengths[j], row.duration - times[j]) });
    });
  }
  const rendered = await renderEdit(items, { settings: sequence.settings, fps });
  const dir = await mkdtemp(path.join(tmpdir(), 'lumina-animatic-'));
  try {
    const picture = path.join(dir, 'picture.mp4'), mixed = path.join(dir, 'mixed.mp4');
    await writeFile(picture, rendered.bytes);
    // Clip each overrunning recording at its own shot boundary without modifying its library asset.
    const clipped = [];
    for (const [i, line] of lines.entries()) {
      const file = path.join(dir, `dialogue-${i}.wav`);
      await ffmpeg(['-i', line.file, '-t', String(line.seconds), '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-y', file]);
      clipped.push({ ...line, file });
    }
    await mixSoundtrack(picture, mixed, { lines: clipped, duration: timeline.totalSeconds, clipVolume: 0 });
    const asset = await assetStore.save({ projectId: sequence.projectId, kind: 'video', label: `${sequence.title} (animatic)`, bytes: await readFile(mixed) });
    return { asset, totalSeconds: timeline.totalSeconds, totalFrames: timeline.totalFrames, fps, shotsWithoutFrames, dialogueOverruns };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
