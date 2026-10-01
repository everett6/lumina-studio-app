import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const run = (command, args, timeout) => new Promise((resolve, reject) => {
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

async function probe(file) {
  const info = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], 30_000));
  const video = info.streams?.find((s) => s.codec_type === 'video');
  if (!video) throw new Error('A clip has no video track.');
  return {
    width: video.width, height: video.height, duration: Number(info.format?.duration ?? video.duration ?? 0),
    hasAudio: Boolean(info.streams?.some((s) => s.codec_type === 'audio')),
  };
}

// Joins clips end to end into one H.264/AAC MP4. Clips are scaled and padded to the first clip's frame size,
// and clips without sound get silence so the audio track stays continuous.
export async function stitchClips(files) {
  if (!files.length) throw new Error('There are no clips to join.');
  const infos = [];
  for (const file of files) infos.push(await probe(file));
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const [width, height] = [even(infos[0].width), even(infos[0].height)];
  const args = ['-v', 'error'];
  files.forEach((file) => args.push('-i', file));
  const silent = [];
  infos.forEach((info, index) => {
    if (info.hasAudio) return;
    silent[index] = files.length + silent.filter((x) => x !== undefined).length;
    args.push('-f', 'lavfi', '-t', String(Math.max(0.1, info.duration)), '-i', 'anullsrc=r=44100:cl=stereo');
  });
  const filters = infos.map((info, index) => [
    `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${index}]`,
    `[${info.hasAudio ? index : silent[index]}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`,
  ].join(';'));
  const concat = `${infos.map((_, index) => `[v${index}][a${index}]`).join('')}concat=n=${files.length}:v=1:a=1[v][a]`;
  const dir = await mkdtemp(path.join(tmpdir(), 'lumina-stitch-'));
  const out = path.join(dir, 'out.mp4');
  try {
    await run('ffmpeg', [...args, '-filter_complex', `${filters.join(';')};${concat}`, '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-y', out], 900_000);
    return { bytes: await readFile(out), width, height, duration: infos.reduce((sum, info) => sum + info.duration, 0) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
