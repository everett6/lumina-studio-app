import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

// Joins clips end to end into one H.264/AAC MP4. Each clip is first re-encoded on its own to the first clip's frame
// size (scaled and padded), 30 fps and stereo AAC, with silence added to clips that have no sound; the uniform
// pieces are then concatenated without re-encoding. Working clip by clip keeps memory flat, so a few minutes of
// footage from dozens of shots joins as reliably as two. `onProgress(done, total)` reports each finished clip.
export async function stitchClips(files, { onProgress } = {}) {
  if (!files.length) throw new Error('There are no clips to join.');
  const infos = [];
  for (const file of files) infos.push(await probe(file));
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const [width, height] = [even(infos[0].width), even(infos[0].height)];
  const dir = await mkdtemp(path.join(tmpdir(), 'lumina-stitch-'));
  try {
    const parts = [];
    for (const [index, file] of files.entries()) {
      const info = infos[index];
      const part = path.join(dir, `part-${String(index).padStart(4, '0')}.mp4`);
      const audioInput = info.hasAudio ? [] : ['-f', 'lavfi', '-t', String(Math.max(0.1, info.duration)), '-i', 'anullsrc=r=44100:cl=stereo'];
      await run('ffmpeg', ['-v', 'error', '-i', file, ...audioInput,
        '-map', '0:v:0', '-map', info.hasAudio ? '0:a:0' : '1:a:0',
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p`,
        '-af', 'aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-video_track_timescale', '15360',
        '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2', '-shortest', '-y', part], 600_000);
      parts.push(part);
      onProgress?.(index + 1, files.length);
    }
    const list = path.join(dir, 'list.txt');
    await writeFile(list, parts.map((part) => `file '${part.replace(/'/g, "'\\''")}'`).join('\n'));
    const out = path.join(dir, 'out.mp4');
    await run('ffmpeg', ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', '-y', out], 600_000);
    const duration = (await probe(out)).duration;
    return { bytes: await readFile(out), width, height, duration };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
