import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const run = (command, args, timeout) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(new Error(error.code === 'ENOENT' ? `${command} is not installed` : String(stderr || error.message).trim().split('\n').slice(-3).join(' ')), { missing: error.code === 'ENOENT' }));
    else resolve(stdout);
  });
});

// A small NVENC probe can succeed even when a real encode later fails (for example after a driver reset).
// Retry that command once with libx264 so a transient or unavailable GPU does not strand the job.
export async function runVideo(args, timeout) {
  try {
    return await run('ffmpeg', args, timeout);
  } catch (error) {
    if (!args.includes('h264_nvenc')) throw error;
    // Later encodes in this process use the CPU encoder too, so pieces of one film stay alike.
    nvenc = Promise.resolve(false);
    const cq = Number(args[args.indexOf('-cq') + 1]) || 17;
    const fallback = [];
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '-c:v' && args[index + 1] === 'h264_nvenc') {
        fallback.push(...(cq <= 12 ? cpuProfiles.mezzanine : cpuProfiles.final).slice(0, -2));
        index += 1;
      } else if (['-preset', '-tune', '-rc', '-cq', '-b:v', '-spatial-aq', '-temporal-aq', '-aq-strength', '-bf', '-b_ref_mode'].includes(args[index])) index += 1;
      else fallback.push(args[index]);
    }
    return run('ffmpeg', fallback, timeout);
  }
}

// Like run(), but resolves with stderr too (ffmpeg's analysis filters report there).
export const runCapture = (command, args, timeout) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(error.code === 'ENOENT' ? `${command} is not installed` : String(stderr || error.message).trim().split('\n').slice(-3).join(' ')));
    else resolve({ stdout: String(stdout), stderr: String(stderr) });
  });
});

export async function hasFfmpeg() {
  try {
    await run('ffmpeg', ['-version'], 10_000);
    await run('ffprobe', ['-version'], 10_000);
    return true;
  } catch {
    return false;
  }
}

export async function probe(file) {
  const info = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], 30_000));
  const video = info.streams?.find((s) => s.codec_type === 'video');
  if (!video) throw new Error('A clip has no video track.');
  const [num, den] = String(video.avg_frame_rate || video.r_frame_rate || '30/1').split('/').map(Number);
  return {
    width: video.width, height: video.height, duration: Number(info.format?.duration ?? video.duration ?? 0),
    fps: num && den ? num / den : 30, frames: Number(video.nb_frames) || null,
    hasAudio: Boolean(info.streams?.some((s) => s.codec_type === 'audio')),
  };
}

// Length in seconds of any media file, audio-only included.
export async function mediaSeconds(file) {
  const info = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', file], 30_000));
  return Number(info.format?.duration ?? 0);
}

// H.264 encoder settings, in two quality profiles so a film loses as little as possible on its way through
// several processing steps:
//  - 'mezzanine': working files between steps, near-lossless (x264 CRF 10 / NVENC CQ 12). Large but transparent.
//  - 'final':     the one delivery encode at the end (x264 CRF 16 slow / NVENC P7 CQ 17 with adaptive quantization).
// NVIDIA NVENC is used when this computer's ffmpeg and GPU can (much faster), otherwise libx264. Checked once
// with a tiny test encode. LUMINA_NO_NVENC=1 forces the CPU encoder.
const cpuProfiles = {
  mezzanine: ['-c:v', 'libx264', '-preset', 'faster', '-crf', '10', '-pix_fmt', 'yuv420p'],
  final: ['-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p'],
};
const gpuProfiles = {
  mezzanine: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '12', '-b:v', '0', '-spatial-aq', '1', '-pix_fmt', 'yuv420p'],
  final: ['-c:v', 'h264_nvenc', '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-cq', '17', '-b:v', '0', '-spatial-aq', '1', '-temporal-aq', '1', '-bf', '3', '-b_ref_mode', 'middle', '-pix_fmt', 'yuv420p'],
};
let nvenc = null;
export function videoEncoder(profile = 'final') {
  nvenc ??= (async () => {
    if (process.env.LUMINA_NO_NVENC === '1') return false;
    try {
      await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.2', '-c:v', 'h264_nvenc', '-f', 'null', '-'], 20_000);
      return true;
    } catch {
      return false; // no usable NVIDIA encoder
    }
  })();
  return nvenc.then((gpu) => ({ name: gpu ? 'nvenc' : 'x264', args: (gpu ? gpuProfiles : cpuProfiles)[profile] ?? cpuProfiles.final }));
}

const audioArgs = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'];
const audioFormat = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
// Working pieces of a film keep uncompressed sound (in Matroska), so joining them is sample-exact: AAC pieces joined
// by copying would each bring their encoder delay (~21 ms) to every cut. The sound is encoded once, after the join.
const pieceAudio = ['-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2'];
const cutFade = 0.008; // seconds of fade at each hard cut: removes the click where two waveforms meet

// The last frame of a clip as PNG bytes: the start frame for the next shot when shots are chained.
export async function lastFrame(file) {
  const dir = await mkdtemp(path.join(tmpdir(), 'lumina-frame-'));
  const out = path.join(dir, 'last.png');
  try {
    await run('ffmpeg', ['-v', 'error', '-sseof', '-0.3', '-i', file, '-update', '1', '-frames:v', '30', '-y', out], 60_000);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A still frame made into a shot on this computer, for free: a slow camera move over the image (Ken Burns style),
// 24 fps by default, with a silent stereo track so it joins like any generated clip. The image is enlarged first so the
// move stays smooth. motion: push-in, pull-out, pan-left, pan-right, rise, static.
export const stillMotions = ['push-in', 'pull-out', 'pan-left', 'pan-right', 'rise', 'static'];
export async function renderStill(imageFile, { duration, motion = 'push-in', width = 1920, height = 1080, fps = 24 }) {
  const frames = Math.max(1, Math.round(duration * fps));
  const t = `(on/${Math.max(1, frames - 1)})`; // 0 → 1 over the shot
  const zoom = { 'push-in': `1+0.12*${t}`, 'pull-out': `1.12-0.12*${t}`, 'pan-left': '1.12', 'pan-right': '1.12', rise: '1.12', static: '1' }[motion] ?? '1';
  const x = { 'pan-left': `(iw-iw/zoom)*(1-${t})`, 'pan-right': `(iw-iw/zoom)*${t}` }[motion] ?? '(iw-iw/zoom)/2';
  const y = { rise: `(ih-ih/zoom)*(1-${t})` }[motion] ?? '(ih-ih/zoom)/2';
  const { args: encode } = await videoEncoder('mezzanine');
  const dir = await mkdtemp(path.join(tmpdir(), 'lumina-still-'));
  const out = path.join(dir, 'still.mp4');
  try {
    await runVideo(['-v', 'error', '-loop', '1', '-framerate', String(fps), '-i', imageFile, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-filter_complex', `[0:v]scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width * 2}:${height * 2},`
        + `zoompan=z='${zoom}':x='${x}':y='${y}':d=1:s=${width}x${height}:fps=${fps},setsar=1,format=yuv420p[v]`,
      '-map', '[v]', '-map', '1:a', '-t', duration.toFixed(3), ...encode, '-video_track_timescale', '15360', ...audioArgs, '-movflags', '+faststart', '-y', out], 600_000);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Joins clips end to end into one H.264/AAC MP4, 30 fps, at `size` (default: the first clip's frame size).
// Each clip is first re-encoded on its own (scaled and padded, silence added when it has no sound); with
// transition 'crossfade' every boundary becomes a short dissolve rendered from just the two neighbouring
// clips; the uniform pieces are then concatenated without re-encoding. Working piece by piece keeps memory
// flat, so many minutes of footage from dozens of shots joins as reliably as two.
// finish 'cinematic' adds a final pass: 2.39:1 letterbox (landscape only), a light film grain and grade, and
// fades in from and out to black. `onProgress(done, total)` reports progress in steps.
// A clip may be { file, duration, trimStart }: it is then cut to exactly `duration` seconds from `trimStart`,
// holding its last frame when it is too short, and crossfades borrow from the outgoing clip so the film's
// length is exactly the sum of the durations.
// Working pieces are near-lossless (the 'mezzanine' profile) and the film gets exactly one delivery encode at
// the end; `deliver: false` skips it and returns the near-lossless join (for a later soundtrack mix + delivery).
// The film's frame rate: the rate most of its clips were made at (most video models make 24 fps, the cinema rate),
// snapped to a standard rate, so no clip has frames duplicated or dropped unless it has to.
export function filmFps(rates) {
  const standard = [24, 25, 30, 50, 60];
  const snapped = rates.filter((r) => Number.isFinite(r) && r > 0).map((r) => standard.reduce((best, s) => (Math.abs(s - r) < Math.abs(best - r) ? s : best)));
  if (!snapped.length) return 24;
  const counts = new Map();
  for (const r of snapped) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}

export async function stitchClips(clips, { onProgress, transition = 'cut', finish = 'none', fadeSeconds = 0.5, size = null, deliver = true, fps = null } = {}) {
  if (!clips.length) throw new Error('There are no clips to join.');
  // Items: { file, duration, trimStart, vf } — `vf` is an optional filter (e.g. a colour match) applied first.
  const items = clips.map((clip) => (typeof clip === 'string' ? { file: clip } : clip));
  const files = items.map((item) => item.file);
  const infos = [];
  for (const file of files) infos.push(await probe(file));
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const [width, height] = size ? [even(size.width), even(size.height)] : [even(infos[0].width), even(infos[0].height)];
  const rate = fps ?? filmFps(infos.map((info) => info.fps));
  const { args: encode } = await videoEncoder('mezzanine');
  const length = (index) => items[index].duration ?? Math.max(0.1, infos[index].duration - (items[index].trimStart ?? 0));
  const dissolve = transition === 'crossfade' && files.length > 1 && items.every((_, index) => length(index) > fadeSeconds * 2 + 0.3);
  const total = files.length + (dissolve ? files.length * 2 - 1 : 0) + (deliver ? 1 : 0) + 1;
  let done = 0;
  const step = () => onProgress?.(++done, total);
  const dir = await mkdtemp(path.join(tmpdir(), 'lumina-stitch-'));
  try {
    const parts = [];
    for (const [index, file] of files.entries()) {
      const info = infos[index];
      const part = path.join(dir, `part-${String(index).padStart(4, '0')}.mkv`);
      const item = items[index];
      // With a set duration, the piece is that long (plus the crossfade overlap it lends to the next shot).
      const target = item.duration != null ? item.duration + (dissolve && index < files.length - 1 ? fadeSeconds : 0) : null;
      // Silence stands in for clips without sound and for clips whose own sound is muted.
      const ownSound = info.hasAudio && !item.mute;
      const audioInput = ownSound ? [] : ['-f', 'lavfi', '-t', String(Math.max(0.1, target ?? info.duration)), '-i', 'anullsrc=r=48000:cl=stereo'];
      const hold = target != null ? `,tpad=stop_mode=clone:stop_duration=${Math.ceil(target + 1)}` : '';
      // Hard cuts: every piece is a whole number of frames, and its sound fades over a few milliseconds at each end.
      const seconds = target ?? Math.max(0.1, info.duration - (item.trimStart ?? 0));
      const frames = Math.max(1, Math.round(seconds * rate));
      const edges = dissolve ? '' : `,afade=t=in:d=${cutFade},afade=t=out:st=${Math.max(0, frames / rate - cutFade).toFixed(4)}:d=${cutFade}`;
      await runVideo(['-v', 'error', ...(item.trimStart ? ['-ss', Number(item.trimStart).toFixed(3)] : []), '-i', file, ...audioInput,
        '-map', '0:v:0', '-map', ownSound ? '0:a:0' : '1:a:0',
        '-vf', `${item.vf ? `${item.vf},` : ''}scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${rate}${hold},format=yuv420p`,
        '-af', `${audioFormat}${target != null ? ',apad' : ''}${edges}`, ...encode, ...pieceAudio,
        '-frames:v', String(frames), '-t', (frames / rate).toFixed(4), '-y', part], 600_000);
      parts.push({ file: part, duration: (await probe(part)).duration });
      step();
    }

    // Pieces to concatenate: whole parts for cuts; for dissolves, each part's middle plus a rendered blend
    // of every boundary.
    let pieces = parts.map((p) => p.file);
    if (dissolve) {
      pieces = [];
      const fade = fadeSeconds;
      for (const [index, part] of parts.entries()) {
        const start = index > 0 ? fade : 0;
        const end = part.duration - (index < parts.length - 1 ? fade : 0);
        const body = path.join(dir, `body-${String(index).padStart(4, '0')}.mkv`);
        await runVideo(['-v', 'error', '-i', part.file, '-ss', start.toFixed(3), '-t', (end - start).toFixed(3),
          ...encode, ...pieceAudio, '-y', body], 600_000);
        pieces.push(body);
        step();
        if (index === parts.length - 1) break;
        const blend = path.join(dir, `blend-${String(index).padStart(4, '0')}.mkv`);
        await runVideo(['-v', 'error', '-ss', (part.duration - fade).toFixed(3), '-i', part.file, '-t', fade.toFixed(3), '-i', parts[index + 1].file,
          '-filter_complex', `[0:v]setpts=PTS-STARTPTS,fps=${rate}[a];[1:v]setpts=PTS-STARTPTS,fps=${rate}[b];[a][b]xfade=transition=fade:duration=${fade}:offset=0,format=yuv420p[v];`
            + `[0:a]asetpts=PTS-STARTPTS[x];[1:a]asetpts=PTS-STARTPTS[y];[x][y]acrossfade=d=${fade}[au]`,
          '-map', '[v]', '-map', '[au]', '-t', fade.toFixed(3), ...encode, ...pieceAudio, '-y', blend], 600_000);
        pieces.push(blend);
        step();
      }
    }

    const list = path.join(dir, 'list.txt');
    await writeFile(list, pieces.map((piece) => `file '${piece.replace(/'/g, "'\\''")}'`).join('\n'));
    let out = path.join(dir, 'joined.mp4');
    // With set durations the film is exactly their sum (the audio's last AAC frame would add ~21 ms).
    const exact = items.every((item) => item.duration != null) ? items.reduce((sum, item) => sum + item.duration, 0) : null;
    // Pictures are copied as they are; the joined sound is encoded once.
    await run('ffmpeg', ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'copy', ...audioArgs, ...(exact ? ['-t', exact.toFixed(3)] : []),
      '-video_track_timescale', '15360', '-movflags', '+faststart', '-y', out], 600_000);
    step();

    if (deliver) {
      const finished = path.join(dir, 'finished.mp4');
      await deliverFilm(out, finished, { finish });
      out = finished;
      step();
    }
    const duration = (await probe(out)).duration;
    return { bytes: await readFile(out), width, height, duration };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The one delivery encode of a film (the 'final' quality profile). finish 'anime' cleans flat colour, lifts colour and
// sharpens line art (see below). finish 'cinematic' also applies a gentle
// grade, 2.39:1 letterbox bars (landscape only), fine film grain and fades from and to black; grain is added only
// here, after any upscaling, so it is never enlarged or smeared. Without a finish the sound is copied untouched.
export async function deliverFilm(input, output, { finish = 'none' } = {}) {
  const info = await probe(input);
  const { args: encode } = await videoEncoder('final');
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const filters = [];
  let audio = ['-c:a', 'copy'];
  if (finish === 'cinematic') {
    const fadeOut = Math.max(0, info.duration - 1.5).toFixed(3);
    filters.push('eq=contrast=1.05:saturation=0.94:gamma=0.98');
    const bar = even((info.height - info.width / 2.39) / 2);
    if (info.width > info.height && bar >= 4) filters.push(`drawbox=x=0:y=0:w=iw:h=${bar}:color=black:t=fill`, `drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:color=black:t=fill`);
    filters.push('noise=alls=4:allf=t', 'fade=t=in:st=0:d=1', `fade=t=out:st=${fadeOut}:d=1.5`);
    audio = ['-af', `afade=t=in:st=0:d=1,afade=t=out:st=${fadeOut}:d=1.5`, ...audioArgs];
  }
  if (finish === 'anime') {
    // Anime finish: clean flat colour areas (light temporal denoise), richer but not garish colour (vibrance lifts
    // muted colours more than strong ones, so skin stays natural), crisp line art (contrast-adaptive sharpening adds
    // no halos), then smooth any banding in gradients. Short fades in and out; no grain or bars.
    const fadeOut = Math.max(0, info.duration - 1).toFixed(3);
    filters.push('hqdn3d=1.2:1.2:2.5:2.5', 'vibrance=intensity=0.18', 'cas=strength=0.55', 'gradfun=strength=0.9:radius=12',
      'fade=t=in:st=0:d=0.6', `fade=t=out:st=${fadeOut}:d=1`);
    audio = ['-af', `afade=t=in:st=0:d=0.6,afade=t=out:st=${fadeOut}:d=1`, ...audioArgs];
  }
  filters.push('format=yuv420p');
  await runVideo(['-v', 'error', '-i', input, '-map', '0:v:0', ...(info.hasAudio ? ['-map', '0:a:0'] : []), '-vf', filters.join(','),
    ...encode, ...(info.hasAudio ? audio : []), '-movflags', '+faststart', '-y', output], 3_600_000);
}
