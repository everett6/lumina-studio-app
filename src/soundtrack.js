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
export async function mixSoundtrack(videoFile, outFile, { lines = [], music = null, ambience = null, clipVolume = 1, duration = null } = {}) {
  const info = await probe(videoFile);
  const length = duration ?? info.duration;
  const inputs = ['-i', videoFile];
  const filters = [];
  const fmt = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  let index = 1;
  const bus = [];
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
    filters.push(`${labels}amix=inputs=${placed.length}:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-2:LRA=11,${fmt},asplit=2[dia][key]`);
    bus.push('[dia]');
  }
  for (const [name, bed] of [['mus', music], ['amb', ambience]]) {
    if (!bed?.file) continue;
    inputs.push('-stream_loop', '-1', '-i', bed.file);
    const raw = `[${index}:a]${fmt},atrim=0:${length.toFixed(3)},volume=${Number(bed.volume ?? 0.3).toFixed(3)}`;
    index += 1;
    if (name === 'mus' && placed.length) filters.push(`${raw}[mraw]`, '[key]apad[keypad]', '[mraw][keypad]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=350[mus]');
    else filters.push(`${raw}[${name}]`);
    bus.push(`[${name}]`);
  }
  if (placed.length && !bus.includes('[mus]')) filters.push('[key]anullsink');
  filters.push(`${bus.join('')}amix=inputs=${bus.length}:normalize=0:duration=first:dropout_transition=0,alimiter=limit=0.89:level=false,${fmt}[out]`);
  await run('ffmpeg', ['-v', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[out]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-t', length.toFixed(3), '-movflags', '+faststart', '-y', outFile], 1_800_000);
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
