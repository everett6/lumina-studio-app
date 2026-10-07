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
    fps: num && den ? num / den : 30, hasAudio: Boolean(info.streams?.some((s) => s.codec_type === 'audio')),
  };
}

// H.264 encoder settings: NVIDIA NVENC when this computer's ffmpeg and GPU can use it (much faster), otherwise
// libx264. Checked once with a tiny test encode. LUMINA_NO_NVENC=1 forces the CPU encoder.
let encoderChoice = null;
export function videoEncoder() {
  encoderChoice ??= (async () => {
    if (process.env.LUMINA_NO_NVENC !== '1') {
      try {
        await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.2', '-c:v', 'h264_nvenc', '-f', 'null', '-'], 20_000);
        return { name: 'nvenc', args: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '19', '-b:v', '0', '-pix_fmt', 'yuv420p'] };
      } catch { /* no usable NVIDIA encoder */ }
    }
    return { name: 'x264', args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p'] };
  })();
  return encoderChoice;
}

const audioArgs = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'];
const audioFormat = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';

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

// Joins clips end to end into one H.264/AAC MP4 at the first clip's frame size, 30 fps.
// Each clip is first re-encoded on its own (scaled and padded, silence added when it has no sound); with
// transition 'crossfade' every boundary becomes a short dissolve rendered from just the two neighbouring
// clips; the uniform pieces are then concatenated without re-encoding. Working piece by piece keeps memory
// flat, so many minutes of footage from dozens of shots joins as reliably as two.
// finish 'cinematic' adds a final pass: 2.39:1 letterbox (landscape only), a light film grain and grade, and
// fades in from and out to black. `onProgress(done, total)` reports progress in steps.
export async function stitchClips(files, { onProgress, transition = 'cut', finish = 'none', fadeSeconds = 0.5 } = {}) {
  if (!files.length) throw new Error('There are no clips to join.');
  const infos = [];
  for (const file of files) infos.push(await probe(file));
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const [width, height] = [even(infos[0].width), even(infos[0].height)];
  const { args: encode } = await videoEncoder();
  const dissolve = transition === 'crossfade' && files.length > 1 && infos.every((info) => info.duration > fadeSeconds * 2 + 0.3);
  const total = files.length + (dissolve ? files.length * 2 - 1 : 0) + (finish === 'cinematic' ? 1 : 0) + 1;
  let done = 0;
  const step = () => onProgress?.(++done, total);
  const dir = await mkdtemp(path.join(tmpdir(), 'lumina-stitch-'));
  try {
    const parts = [];
    for (const [index, file] of files.entries()) {
      const info = infos[index];
      const part = path.join(dir, `part-${String(index).padStart(4, '0')}.mp4`);
      const audioInput = info.hasAudio ? [] : ['-f', 'lavfi', '-t', String(Math.max(0.1, info.duration)), '-i', 'anullsrc=r=48000:cl=stereo'];
      await run('ffmpeg', ['-v', 'error', '-i', file, ...audioInput,
        '-map', '0:v:0', '-map', info.hasAudio ? '0:a:0' : '1:a:0',
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p`,
        '-af', audioFormat, ...encode, '-video_track_timescale', '15360', ...audioArgs, '-shortest', '-y', part], 600_000);
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
        const body = path.join(dir, `body-${String(index).padStart(4, '0')}.mp4`);
        await run('ffmpeg', ['-v', 'error', '-i', part.file, '-ss', start.toFixed(3), '-t', (end - start).toFixed(3),
          ...encode, '-video_track_timescale', '15360', ...audioArgs, '-y', body], 600_000);
        pieces.push(body);
        step();
        if (index === parts.length - 1) break;
        const blend = path.join(dir, `blend-${String(index).padStart(4, '0')}.mp4`);
        await run('ffmpeg', ['-v', 'error', '-ss', (part.duration - fade).toFixed(3), '-i', part.file, '-t', fade.toFixed(3), '-i', parts[index + 1].file,
          '-filter_complex', `[0:v]setpts=PTS-STARTPTS,fps=30[a];[1:v]setpts=PTS-STARTPTS,fps=30[b];[a][b]xfade=transition=fade:duration=${fade}:offset=0,format=yuv420p[v];`
            + `[0:a]asetpts=PTS-STARTPTS[x];[1:a]asetpts=PTS-STARTPTS[y];[x][y]acrossfade=d=${fade}[au]`,
          '-map', '[v]', '-map', '[au]', '-t', fade.toFixed(3), ...encode, '-video_track_timescale', '15360', ...audioArgs, '-y', blend], 600_000);
        pieces.push(blend);
        step();
      }
    }

    const list = path.join(dir, 'list.txt');
    await writeFile(list, pieces.map((piece) => `file '${piece.replace(/'/g, "'\\''")}'`).join('\n'));
    let out = path.join(dir, 'joined.mp4');
    await run('ffmpeg', ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', '-y', out], 600_000);
    step();

    if (finish === 'cinematic') {
      const duration = (await probe(out)).duration;
      const fadeOut = Math.max(0, duration - 1.5).toFixed(3);
      const filters = ['eq=contrast=1.05:saturation=0.94:gamma=0.98'];
      const bar = even((height - width / 2.39) / 2);
      if (width > height && bar >= 4) filters.push(`drawbox=x=0:y=0:w=iw:h=${bar}:color=black:t=fill`, `drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:color=black:t=fill`);
      filters.push('noise=alls=5:allf=t', `fade=t=in:st=0:d=1`, `fade=t=out:st=${fadeOut}:d=1.5`, 'format=yuv420p');
      const finished = path.join(dir, 'finished.mp4');
      await run('ffmpeg', ['-v', 'error', '-i', out, '-vf', filters.join(','), '-af', `afade=t=in:st=0:d=1,afade=t=out:st=${fadeOut}:d=1.5`,
        ...encode, ...audioArgs, '-movflags', '+faststart', '-y', finished], 1_800_000);
      out = finished;
      step();
    }
    const duration = (await probe(out)).duration;
    return { bytes: await readFile(out), width, height, duration };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
