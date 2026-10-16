import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { filmFps, run, runCapture } from './video.js';
import { lineTimes, mixSoundtrack } from './soundtrack.js';

// Delivery policy, not a claim that every kind of programme should use these targets.
export const deliveryTargets = Object.freeze({ integratedLufs: -16, toleranceLu: 1, truePeakDbtp: -1, channels: 2, silenceThresholdDb: -50, silenceMinSeconds: 0.5 });
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const number = (value, name, min, max) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${name} must be between ${min} and ${max}.`);
  return value;
};
const ff = (args) => run('ffmpeg', ['-v', 'error', ...args], 300_000);
const finite = (value) => value != null && Number.isFinite(Number(value)) ? Number(value) : null;
export async function inspectMedia(file) {
  const data = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], 30_000));
  const audio = data.streams.find((s) => s.codec_type === 'audio');
  const video = data.streams.find((s) => s.codec_type === 'video');
  const [n, d] = String(video?.avg_frame_rate || video?.r_frame_rate || '0/1').split('/').map(Number);
  return { duration: finite(data.format?.duration), audio, video, fps: d ? n / d : null };
}
export async function measureLoudness(file) {
  const { stderr } = await runCapture('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'], 300_000);
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const get = (pattern) => finite(pattern.exec(summary)?.[1]);
  const integratedLufs = get(/I:\s*([-+\d.inf]+) LUFS/);
  if (integratedLufs == null) fail('Integrated loudness is unavailable (no measurable audio).');
  return { integratedLufs, lraLu: get(/LRA:\s*([-+\d.inf]+) LU/), truePeakDbtp: get(/Peak:\s*([-+\d.inf]+) dBFS/), method: 'ffmpeg ebur128, true-peak oversampling' };
}
export async function detectSilence(file, { minSeconds = 0.5, thresholdDb = -50, perChannel = false } = {}) {
  number(minSeconds, 'minSeconds', 0.01, 3600); number(thresholdDb, 'thresholdDb', -100, 0);
  const info = await inspectMedia(file);
  if (!info.audio) fail('Asset has no audio stream.');
  const { stderr } = await runCapture('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', `silencedetect=noise=${thresholdDb}dB:d=${minSeconds}${perChannel ? ':mono=1' : ''}`, '-f', 'null', '-'], 300_000);
  const intervals = [], pending = new Map();
  for (const row of stderr.split('\n')) {
    const channel = /channel:\s*(\d+)/.exec(row)?.[1] ?? 'all';
    const start = /silence_start:\s*([-\d.e+]+)/.exec(row);
    const end = /silence_end:\s*([-\d.e+]+)/.exec(row);
    if (start) pending.set(channel, Math.max(0, Number(start[1])));
    if (end) {
      const a = pending.get(channel) ?? 0, b = Number(end[1]);
      intervals.push({ start: a, end: b, seconds: b - a, ...(channel !== 'all' ? { channel: Number(channel) } : {}) });
      pending.delete(channel);
    }
  }
  for (const [channel, start] of pending) if (info.duration != null) intervals.push({ start, end: info.duration, seconds: info.duration - start, ...(channel !== 'all' ? { channel: Number(channel) } : {}) });
  return { minSeconds, thresholdDb, duration: info.duration, intervals };
}

export function createAudioTools({ repo, assetStore, sequences, exportDir }) {
  const asset = (id) => repo.assets.get(id) ?? fail('Asset not found.', 404);
  const mediaAsset = (id) => {
    const found = asset(id);
    if (!/^(audio|video)\//.test(found.mimeType)) fail('Choose an audio or video asset.');
    return found;
  };
  const work = async (fn) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lumina-audio-'));
    try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
  };
  const save = async (source, file, label, kind = 'audio') => assetStore.save({ bytes: await readFile(file), projectId: source.projectId, parentAssetId: source.id, label, kind });
  const measured = async (id) => measureLoudness(assetStore.path(mediaAsset(id)));
  async function normalize(id, { targetLufs = -16 } = {}) {
    if (![-14, -16, -23].includes(targetLufs)) fail('targetLufs must be -14, -16 or -23.');
    const source = mediaAsset(id), file = assetStore.path(source);
    const { stderr } = await runCapture('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', `loudnorm=I=${targetLufs}:TP=-1:LRA=11:print_format=json`, '-f', 'null', '-'], 300_000);
    const match = /\{\s*"input_i"[\s\S]*?\}/.exec(stderr);
    if (!match) fail('loudnorm measurement unavailable.');
    const m = JSON.parse(match[0]);
    if (['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'].some((key) => finite(m[key]) == null)) fail('Cannot normalize silent or unmeasurable audio.');
    return work(async (dir) => {
      const out = path.join(dir, 'normalized.wav');
      await ff(['-i', file, '-map', '0:a:0', '-af', `loudnorm=I=${targetLufs}:TP=-1:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`, '-ar', '48000', '-c:a', 'pcm_s24le', '-y', out]);
      const created = await save(source, out, `${source.label ?? 'Audio'} (${targetLufs} LUFS)`);
      return { asset: created, targetLufs, passes: 2, loudness: await measured(created.id), note: 'New audio-only WAV; original audio/video is kept.' };
    });
  }
  async function trim(id, { start, end, fadeIn = 0, fadeOut = 0 }) {
    const source = mediaAsset(id), file = assetStore.path(source), info = await inspectMedia(file);
    number(start, 'start', 0, info.duration ?? 86400); number(end, 'end', start, info.duration ?? 86400);
    if (end <= start) fail('end must be after start.');
    const length = end - start;
    number(fadeIn, 'fadeIn', 0, length); number(fadeOut, 'fadeOut', 0, length);
    return work(async (dir) => {
      const out = path.join(dir, 'trimmed.wav');
      const filters = [`atrim=start=${start}:end=${end}`, 'asetpts=PTS-STARTPTS', ...(fadeIn ? [`afade=t=in:d=${fadeIn}`] : []), ...(fadeOut ? [`afade=t=out:st=${length - fadeOut}:d=${fadeOut}`] : [])];
      await ff(['-i', file, '-map', '0:a:0', '-af', filters.join(','), '-c:a', 'pcm_s24le', '-y', out]);
      return { asset: await save(source, out, `${source.label ?? 'Audio'} (trimmed)`), seconds: length, fadeIn, fadeOut };
    });
  }
  async function waveform(id) {
    const source = mediaAsset(id);
    return work(async (dir) => {
      const out = path.join(dir, 'waveform.png');
      await ff(['-i', assetStore.path(source), '-filter_complex', 'aformat=channel_layouts=mono,showwavespic=s=1200x240:colors=0x58c4dc', '-frames:v', '1', '-threads', '1', '-y', out]);
      return { asset: await save(source, out, `${source.label ?? 'Audio'} (waveform)`, 'image') };
    });
  }
  async function report(id) {
    const { sequence, shots } = sequences.detail(id);
    const infos = await Promise.all(shots.map(async (s) => s.videoAssetId && repo.assets.get(s.videoAssetId) ? inspectMedia(assetStore.path(asset(s.videoAssetId))).catch(() => null) : null));
    const fps = sequence.settings.interpolateFps === 30 ? 30 : filmFps(infos.map((i) => i?.fps));
    const output = [], intervals = [];
    let clock = 0, cue = sequence.settings.music ?? null;
    for (const [index, shot] of shots.entries()) {
      const info = infos[index];
      const duration = Math.max(1, Math.round((shot.duration ?? Math.max(0, (info?.duration ?? 0) - (shot.details.trimStart || 0))) * fps)) / fps;
      const lines = await Promise.all((shot.details.dialogue ?? []).map(async (line, lineIndex) => {
        const recording = line.assetId ? repo.assets.get(line.assetId) : null;
        let seconds = null, playable = false, error = null;
        if (recording) try {
          const file = assetStore.path(recording), audio = await inspectMedia(file);
          if (!audio.audio) throw new Error('No audio stream.');
          await ff(['-i', file, '-map', '0:a:0', '-f', 'null', '-']); // Decode the entire recording, not just its header.
          seconds = finite(audio.audio.duration) ?? audio.duration;
          playable = seconds > 0;
        } catch (e) { error = e.message; }
        const speaker = line.speaker === 'narrator' ? null : repo.characters.get(line.speaker);
        const assignment = speaker?.voice ?? sequence.settings.narratorVoice ?? null;
        // Follow derived assets back to the original take; imports without provenance stay unavailable.
        let original = recording, generation = null;
        const seen = new Set();
        while (original && !seen.has(original.id)) {
          seen.add(original.id);
          if (original.generationId) { generation = repo.generations.get(original.generationId); break; }
          original = original.parentAssetId ? repo.assets.get(original.parentAssetId) : null;
        }
        const recordedVoice = generation ? { provider: generation.provider, model: generation.model, voice: generation.params.voice ?? null } : null;
        const voiceMatches = !assignment ? false : recordedVoice ? ['provider', 'model', 'voice'].every((k) => (assignment[k] ?? null) === recordedVoice[k]) : null;
        return { lineIndex, speaker: line.speaker, text: line.text, assetId: line.assetId ?? null, seconds, playable, error, assignment, recordedVoice, voiceMatches, explicitStart: line.start };
      }));
      const { times } = lineTimes(lines.map((l) => ({ start: l.explicitStart })), duration, lines.map((l) => l.seconds));
      let timingKnown = true;
      lines.forEach((line, i) => {
        if (Number.isFinite(line.explicitStart)) timingKnown = true;
        line.timingKnown = timingKnown;
        line.start = times[i]; line.end = line.seconds == null ? null : line.start + line.seconds;
        line.slot = { from: line.start, to: duration, seconds: Math.max(0, duration - line.start) };
        line.fits = line.end == null || !timingKnown ? null : line.start >= 0 && line.end <= duration + 1 / 48000;
        if (line.end != null && timingKnown) intervals.push({ shotId: shot.id, lineIndex: i, from: clock + line.start, to: clock + line.end });
        if (line.seconds == null) timingKnown = false;
      });
      cue = (sequence.settings.musicCues ?? []).findLast((c) => c.shotId === shot.id) ?? cue;
      output.push({ shotId: shot.id, position: shot.position, from: clock, seconds: duration, includedByJoin: Boolean(info?.video) && !['rejected', 'needs_regeneration'].includes(shot.review?.status), lines, effects: shot.details.sfx ?? [], music: cue, clip: { assetId: shot.videoAssetId, trimStart: shot.details.trimStart || 0, muted: Boolean(shot.details.muteClipSound) } });
      clock += duration;
    }
    const overlaps = [];
    intervals.sort((a, b) => a.from - b.from);
    for (let i = 0; i < intervals.length; i++) for (let j = i + 1; j < intervals.length && intervals[j].from < intervals[i].to; j++) overlaps.push({ first: intervals[i], second: intervals[j], seconds: Math.min(intervals[i].to, intervals[j].to) - intervals[j].from });
    const film = sequence.outputAssetId && repo.assets.get(sequence.outputAssetId);
    let lastJoinedFilm = null;
    if (film) { try { lastJoinedFilm = { assetId: film.id, loudness: await measured(film.id), stale: sequence.joinStale }; } catch (e) { lastJoinedFilm = { assetId: film.id, loudness: null, error: e.message }; } }
    return { storyboardId: id, fps, seconds: clock, shots: output, overlaps, lastJoinedFilm, mix: repo.settings.get(`mix:${id}`, {}), note: 'Current shot slots; last joined audio may precede edits. Music stem includes ambience. Imported recordings without generation metadata cannot verify voice identity.' };
  }
  async function validate({ storyboardId, assetId }) {
    if (Boolean(storyboardId) === Boolean(assetId)) fail('Pass exactly one of storyboardId or assetId.');
    const checks = [], blocking = [];
    const add = (check, result, detail, scope = {}, block = false) => { const item = { check, result, detail, ...scope }; checks.push(item); if (block && result === 'failed') blocking.push(item); };
    let source = null, story = null;
    if (storyboardId) {
      story = await report(storyboardId);
      for (const shot of story.shots) {
        add('shot-in-join', shot.includedByJoin ? 'passed' : 'failed', 'Shot has usable video and is not rejected.', { shotId: shot.shotId }, true);
        for (const line of shot.lines) {
          const scope = { shotId: shot.shotId, lineIndex: line.lineIndex };
          add('recording', line.playable ? 'passed' : 'failed', line.playable ? `Decoded ${line.seconds.toFixed(3)} seconds.` : line.error ?? 'Recording is missing or deleted.', scope, true);
          add('dialogue-fit', line.fits == null ? 'unavailable' : line.fits ? 'passed' : 'failed', { start: line.start, end: line.end, shotSeconds: shot.seconds }, scope, true);
          add('voice', line.voiceMatches == null ? 'unavailable' : line.voiceMatches ? 'passed' : 'failed', { assignment: line.assignment, recordedVoice: line.recordedVoice }, scope, true);
        }
      }
      add('overlap', story.overlaps.length ? 'failed' : 'passed', story.overlaps);
      const { sequence } = sequences.detail(storyboardId);
      source = sequence.outputAssetId ? repo.assets.get(sequence.outputAssetId) : null;
      add('joined-film', source ? 'passed' : 'unavailable', source ? source.id : 'Join the storyboard to measure delivery audio.');
      add('join-current', !source ? 'unavailable' : sequence.joinStale ? 'failed' : 'passed', 'Rejoin after editing the film.');
    } else {
      source = mediaAsset(assetId);
      add('dialogue', 'unavailable', 'An asset alone has no dialogue ledger or speaker assignments. Pass storyboardId to validate recordings and slots.');
    }
    if (!source) for (const check of ['loudness', 'true-peak', 'channels', 'silence', 'av-duration']) add(check, 'unavailable', 'No joined film.');
    else {
      const file = assetStore.path(source);
      let info;
      try { info = await inspectMedia(file); } catch (e) { add('playable', 'failed', e.message, {}, true); }
      if (!info?.audio) {
        add('channels', 'failed', 'Missing audio stream.', {}, true);
        for (const check of ['loudness', 'true-peak', 'silence', 'av-duration']) add(check, 'unavailable', 'Audio cannot be measured.');
      } else {
        try {
          const loudness = await measureLoudness(file);
          add('loudness', Math.abs(loudness.integratedLufs + 16) <= 1 ? 'passed' : 'failed', loudness);
          add('true-peak', loudness.truePeakDbtp == null ? 'unavailable' : loudness.truePeakDbtp <= -1 ? 'passed' : 'failed', { measuredDbtp: loudness.truePeakDbtp, maximumDbtp: -1 });
        } catch (e) { add('loudness', 'unavailable', e.message); add('true-peak', 'unavailable', e.message); }
        try {
          const silence = await detectSilence(file, { perChannel: true });
          const empty = silence.intervals.filter((s) => s.start < 0.05 && s.end >= (info.duration ?? Infinity) - 0.05);
          add('channels', info.audio.channels === 2 && !empty.length ? 'passed' : 'failed', { channels: info.audio.channels, layout: info.audio.channel_layout, silentChannels: empty }, {}, true);
          const globalSilence = await detectSilence(file);
          add('silence', globalSilence.intervals.length ? 'failed' : 'passed', { ...globalSilence, note: 'Silence is a review flag; intentional pauses may be valid.' });
        } catch (e) { add('channels', 'unavailable', e.message); add('silence', 'unavailable', e.message); }
        const a = finite(info.audio.duration), v = finite(info.video?.duration);
        const diff = a != null && v != null ? Math.abs(a - v) : null;
        add('av-duration', diff == null || !(info.fps > 0) ? 'unavailable' : diff <= 1 / info.fps + 1e-6 ? 'passed' : 'failed', { audioSeconds: a, videoSeconds: v, differenceSeconds: diff, frameSeconds: info.fps > 0 ? 1 / info.fps : null });
      }
    }
    const counts = Object.fromEntries(['passed', 'failed', 'unavailable'].map((s) => [s, checks.filter((c) => c.result === s).length]));
    return { storyboardId: storyboardId ?? null, assetId: source?.id ?? assetId ?? null, result: counts.failed ? 'failed' : counts.unavailable ? 'unavailable' : 'passed', blocked: blocking.length > 0, blocking, targets: deliveryTargets, checks, counts, note: 'This is a delivery gate report. It does not alter or intercept publish_film.' };
  }
  function setMix(id, mix) {
    sequences.needSequence(id);
    if (!mix || typeof mix !== 'object' || Array.isArray(mix)) fail('mix must be an object.');
    const limits = { dialogueGainDb: [-60, 24], musicDuckDb: [0, 24], sfxGainDb: [-60, 24], clipVolume: [0, 2] };
    for (const [key, value] of Object.entries(mix)) { if (!limits[key]) fail(`Unknown mix key: ${key}`); number(value, key, ...limits[key]); }
    const saved = { ...repo.settings.get(`mix:${id}`, {}), ...mix };
    // The existing join already reads this setting; its fingerprint also marks the old join stale.
    if ('clipVolume' in mix) sequences.update(id, { settings: { clipVolume: mix.clipVolume } });
    repo.settings.set(`mix:${id}`, saved);
    return { storyboardId: id, mix: saved, appliedByJoin: ['clipVolume'], previewAndStemsOnly: ['dialogueGainDb', 'musicDuckDb', 'sfxGainDb'], note: 'Only clipVolume affects join_storyboard today. Other saved controls affect mix_preview and export_stems; the join keeps its original dialogue normalization and automatic ducking.' };
  }
  // Rebuild only the clips' sound, never render or join video. Cut/trim/pad and borrowed crossfade
  // overlaps follow video.stitchClips; dialogue and cue clocks follow sequences.stitch.
  async function render(id, dir, { from = 0, seconds = null, stems = null } = {}) {
    const detail = sequences.detail(id), story = await report(id), { sequence, shots } = detail;
    if (!shots.length || story.shots.some((s) => !s.includedByJoin)) fail('Every shot needs a usable, non-rejected clip before mixing.', 409);
    if (story.shots.some((s) => s.lines.some((l) => !l.playable || l.fits !== true))) fail('Missing, unplayable or clipped dialogue blocks mixing.', 409);
    number(from, 'from', 0, story.seconds);
    if (from >= story.seconds) fail('from must be before the end.');
    if (seconds != null) number(seconds, 'seconds', 0.01, 30);
    const length = seconds == null ? story.seconds : Math.min(seconds, story.seconds - from);
    const dissolve = sequence.settings.transition === 'crossfade' && shots.length > 1 && story.shots.every((s) => s.seconds > 1.3);
    const parts = [];
    for (const [i, shot] of shots.entries()) {
      const slot = story.shots[i], source = asset(shot.videoAssetId), info = await inspectMedia(assetStore.path(source));
      const duration = slot.seconds + (dissolve && i < shots.length - 1 ? 0.5 : 0);
      const sound = info.audio && !shot.details.muteClipSound;
      const input = sound ? ['-i', assetStore.path(source)] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'];
      const out = path.join(dir, `clip-${i}.wav`);
      const edges = dissolve ? '' : `,afade=t=in:d=0.008,afade=t=out:st=${Math.max(0, duration - 0.008)}:d=0.008`;
      await ff([...input, '-map', '0:a:0', '-af', `atrim=start=${sound ? slot.clip.trimStart : 0},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${duration}${edges}`, '-t', String(duration), '-c:a', 'pcm_f32le', '-y', out]);
      parts.push(out);
    }
    const clipFile = path.join(dir, 'clips.wav'), filters = [];
    let prior = '[0:a]';
    for (let i = 1; i < parts.length; i++) { const out = `[joined${i}]`; filters.push(`${prior}[${i}:a]${dissolve ? 'acrossfade=d=0.5' : 'concat=n=2:v=0:a=1'}${out}`); prior = out; }
    await ff([...parts.flatMap((p) => ['-i', p]), ...(filters.length ? ['-filter_complex', filters.join(';'), '-map', prior] : ['-map', '0:a:0']), '-c:a', 'pcm_f32le', '-y', clipFile]);
    const bed = (value) => value?.assetId ? { file: assetStore.path(asset(value.assetId)), volume: value.volume } : null;
    const starts = new Map(story.shots.map((s) => [s.shotId, s.from]));
    const cues = (sequence.settings.musicCues ?? []).filter((c) => starts.has(c.shotId)).map((c) => ({ ...c, start: starts.get(c.shotId) })).sort((a, b) => a.start - b.start);
    const plan = [...(sequence.settings.music && (!cues.length || cues[0].start > 0) ? [{ ...sequence.settings.music, start: 0 }] : []), ...cues];
    const music = plan.map((cue, i) => ({ ...bed(cue), start: cue.start, end: plan[i + 1]?.start ?? story.seconds }));
    const lines = story.shots.flatMap((s) => s.lines.map((l) => ({ file: assetStore.path(asset(l.assetId)), at: s.from + l.start })));
    const effects = story.shots.flatMap((s) => s.effects.filter((e) => e.at < s.seconds).map((e) => ({ file: assetStore.path(asset(e.assetId)), at: s.from + e.at, volume: e.volume })));
    const mix = repo.settings.get(`mix:${id}`, {}), out = path.join(dir, stems ? 'mix.wav' : 'preview.mp3');
    await mixSoundtrack(clipFile, out, { lines, music, effects, ambience: bed(sequence.settings.ambience), duration: story.seconds, clipVolume: sequence.settings.clipVolume ?? 1, dialogueGainDb: mix.dialogueGainDb ?? 0, musicDuckDb: mix.musicDuckDb ?? null, sfxGainDb: mix.sfxGainDb ?? 0, audioOnly: true, from, seconds: length, stems });
    return { out, sequence, seconds: length };
  }
  async function preview(id, { from = 0, seconds = 10 } = {}) {
    return work(async (dir) => {
      const result = await render(id, dir, { from, seconds });
      const created = await assetStore.save({ bytes: await readFile(result.out), projectId: result.sequence.projectId, kind: 'audio', label: `${result.sequence.title} (mix preview)` });
      return { asset: created, from, seconds: result.seconds, note: 'Audio-only render; picture is untouched. Uses saved preview gains. Whole-timeline processing preserves normalization and ducking context.' };
    });
  }
  async function exportStems(id) {
    sequences.needSequence(id);
    const folder = path.join(exportDir, `audio-stems-${id}-${randomUUID()}`);
    await mkdir(folder, { recursive: true });
    try {
      return await work(async (dir) => {
        const stems = Object.fromEntries(['dialogue', 'music', 'effects', 'clip'].map((name) => [name, path.join(folder, `${name}.wav`)]));
        const result = await render(id, dir, { stems });
        return { storyboardId: id, folder, seconds: result.seconds, stems: Object.entries(stems).map(([bus, file]) => ({ bus, file })), note: '48 kHz stereo float WAVs, time aligned, before the final limiter. Music includes ambience and dialogue-keyed ducking. Sum at unity; limiter activity and MP3/AAC encoding can change the final mix.' };
      });
    } catch (e) { await rm(folder, { recursive: true, force: true }); throw e; }
  }
  return { measure: measured, normalize, trim, waveform, silence: (id, options) => detectSilence(assetStore.path(mediaAsset(id)), options), report, validate, setMix, preview, exportStems };
}
