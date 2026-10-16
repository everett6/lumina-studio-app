import { probe, run } from './video.js';

// The film's sound, mixed over the joined picture in one ffmpeg pass:
//  - the clips' own sound (the video models' sound effects and ambience), at `clipVolume`;
//  - dialogue and narration lines, each placed at its exact time, the whole dialogue bus loudness-normalised to
//    -16 LUFS so voices match from line to line;
//  - a music bed and an ambience bed, looped to the film's length, the music ducked automatically (sidechain
//    compression) whenever someone speaks;
//  - a limiter at the end so nothing clips.
// The ducking key is padded with silence: without it the compressor stops when the last line ends and the music
// is cut off for the rest of the film.
// The picture is copied untouched, so mixing never costs picture quality, and the sound can be remixed any time
// (new music, a re-recorded line) without touching the footage.
// `music` is one bed for the whole film, or a list of segments [{ file, volume, start, end }] (music per scene):
// each segment loops its track over its own span and crossfades (1.5 s) into the next. `effects` are sound
// effects [{ file, at, volume }], mixed on their own bus: not loudness-normalised with the voices, and they
// do not duck the music.
const crossfade = 1.5;
export async function mixSoundtrack(videoFile, outFile, { lines = [], music = null, ambience = null, effects = [], clipVolume = 1, duration = null, dialogueGainDb = 0, musicDuckDb = null, sfxGainDb = 0, audioOnly = false, from = 0, seconds = null, stems = null } = {}) {
  const info = audioOnly ? { duration, hasAudio: true } : await probe(videoFile);
  const length = duration ?? info.duration;
  const inputs = ['-i', videoFile];
  const filters = [];
  const fmt = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  let index = 1;
  const bus = [];
  const groups = { dialogue: [], music: [], effects: [], clip: info.hasAudio ? ['[clip]'] : [] };
  if (info.hasAudio) {
    filters.push(`[0:a]${fmt},volume=${Number(clipVolume).toFixed(3)}[clip]`);
    bus.push('[clip]');
  } else {
    filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${length.toFixed(3)}[clip]`);
    bus.push('[clip]');
  }
  const placed = lines.filter((line) => line.file && Number.isFinite(line.at) && line.at < length);
  for (const [n, line] of placed.entries()) {
    inputs.push('-i', line.file);
    const ms = Math.max(0, Math.round(line.at * 1000));
    filters.push(`[${index}:a]${fmt},volume=${Number(line.volume ?? 1).toFixed(3)},adelay=${ms}|${ms}[l${n}]`);
    index += 1;
  }
  if (placed.length) {
    const labels = placed.map((_, n) => `[l${n}]`).join('');
    filters.push(`${labels}amix=inputs=${placed.length}:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-2:LRA=11,${fmt}${dialogueGainDb ? `,volume=${dialogueGainDb}dB` : ''},asplit=2[dia][key]`);
    bus.push('[dia]');
    groups.dialogue.push('[dia]');
  }
  // Music: one or more segments, each looped over its span, faded in/out where it meets another segment.
  const segments = (Array.isArray(music) ? music : music?.file ? [{ ...music, start: 0, end: length }] : [])
    .filter((m) => m?.file && m.end > m.start && m.start < length).map((m) => ({ ...m, end: Math.min(m.end, length) }));
  if (segments.length) {
    const parts = [];
    for (const [n, m] of segments.entries()) {
      inputs.push('-stream_loop', '-1', '-i', m.file);
      const fadeIn = m.start > 0 ? crossfade : 0;
      const fadeOut = m.end < length - 0.001 ? crossfade : 0;
      const from = Math.max(0, m.start - fadeIn / 2);
      const span = Math.min(length, m.end + fadeOut / 2) - from;
      const ms = Math.round(from * 1000);
      filters.push(`[${index}:a]${fmt},atrim=0:${span.toFixed(3)},volume=${Number(m.volume ?? 0.3).toFixed(3)}`
        + `${fadeIn ? `,afade=t=in:d=${fadeIn}` : ''}${fadeOut ? `,afade=t=out:st=${(span - fadeOut).toFixed(3)}:d=${fadeOut}` : ''},adelay=${ms}|${ms}[m${n}]`);
      parts.push(`[m${n}]`);
      index += 1;
    }
    const joined = parts.length > 1 ? `${parts.join('')}amix=inputs=${parts.length}:normalize=0:duration=longest:dropout_transition=0,${fmt}` : `${parts[0]}anull`;
    filters.push(`${joined},apad,atrim=0:${length.toFixed(3)}[mraw]`);
    if (placed.length && musicDuckDb === 0) filters.push('[mraw]anull[mus]', '[key]anullsink');
    else if (placed.length) filters.push('[key]apad[keypad]', `[mraw][keypad]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=350${musicDuckDb == null ? '' : `:mix=${(1 - 10 ** (-musicDuckDb / 20)).toFixed(4)}`}[mus]`);
    else filters.push('[mraw]anull[mus]');
    bus.push('[mus]');
    groups.music.push('[mus]');
  }
  if (ambience?.file) {
    inputs.push('-stream_loop', '-1', '-i', ambience.file);
    filters.push(`[${index}:a]${fmt},atrim=0:${length.toFixed(3)},volume=${Number(ambience.volume ?? 0.3).toFixed(3)}[amb]`);
    index += 1;
    bus.push('[amb]');
    groups.music.push('[amb]');
  }
  const hits = effects.filter((e) => e?.file && Number.isFinite(e.at) && e.at < length);
  for (const [n, e] of hits.entries()) {
    inputs.push('-i', e.file);
    const ms = Math.max(0, Math.round(e.at * 1000));
    filters.push(`[${index}:a]${fmt},volume=${(sfxGainDb ? Number((e.volume ?? 0.8) * 10 ** (sfxGainDb / 20)).toFixed(6) : Number(e.volume ?? 0.8).toFixed(3))},adelay=${ms}|${ms}[x${n}]`);
    bus.push(`[x${n}]`);
    groups.effects.push(`[x${n}]`);
    index += 1;
  }
  if (placed.length && !bus.includes('[mus]')) filters.push('[key]anullsink');
  if (stems) {
    for (const [name, labels] of Object.entries(groups)) {
      const copies = labels.map((label, i) => {
        filters.push(`${label}asplit=2[stem_${name}_${i}][mix_${name}_${i}]`);
        bus[bus.indexOf(label)] = `[mix_${name}_${i}]`;
        return `[stem_${name}_${i}]`;
      });
      filters.push(copies.length
        ? `${copies.join('')}amix=inputs=${copies.length}:normalize=0:duration=longest:dropout_transition=0,apad,atrim=0:${length.toFixed(3)}[stem_${name}]`
        : `anullsrc=r=48000:cl=stereo,atrim=0:${length.toFixed(3)}[stem_${name}]`);
    }
  }
  filters.push(`${bus.join('')}amix=inputs=${bus.length}:normalize=0:duration=first:dropout_transition=0,alimiter=limit=0.89:level=false,${fmt}[out]`);
  const output = audioOnly
    ? ['-map', '[out]', '-vn', ...(outFile.endsWith('.mp3') ? ['-c:a', 'libmp3lame', '-b:a', '192k'] : ['-c:a', 'pcm_f32le']), '-ar', '48000', '-ss', String(from), '-t', String(seconds ?? length - from), '-y', outFile]
    : ['-map', '0:v:0', '-map', '[out]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-t', length.toFixed(3), '-movflags', '+faststart', '-y', outFile];
  if (stems) for (const name of Object.keys(groups)) output.push('-map', `[stem_${name}]`, '-c:a', 'pcm_f32le', '-ar', '48000', '-t', length.toFixed(3), '-y', stems[name]);
  await run('ffmpeg', ['-v', 'error', ...inputs, '-filter_complex', filters.join(';'), ...output], 1_800_000);
}

// Where each dialogue line of a shot starts: its own `start` (seconds into the shot) when set, otherwise one after
// another from 0.4 s with 0.25 s between lines. Returns times relative to the shot plus any overrun past its end.
export function lineTimes(lines, shotSeconds, lengths) {
  let cursor = 0.4;
  const times = lines.map((line, i) => {
    const at = Number.isFinite(line.start) ? line.start : cursor;
    cursor = at + (lengths[i] ?? 0) + 0.25;
    return at;
  });
  const ends = times.map((at, i) => at + (lengths[i] ?? 0));
  return { times, overrun: Math.max(0, Math.max(0, ...ends) - shotSeconds) };
}
