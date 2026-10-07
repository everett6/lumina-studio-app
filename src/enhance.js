import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { probe, run, videoEncoder } from './video.js';
import { readZip } from './zip.js';

// Video enhancement on this computer's GPU.
//
// DLSS itself only works inside games (it upscales frames a game engine renders, using its motion vectors), and
// NVIDIA's RTX Video Super Resolution only works during playback in a browser or player, so neither can improve a
// saved video file. The closest options that do:
//  - 'fast': ffmpeg's libplacebo (Vulkan, runs on the GPU) with the EWA Lanczos-sharp scaler: 2x, seconds per minute.
//  - 'ai':   Real-ESRGAN (realesrgan-x4plus, a photo-realistic super-resolution network) through
//            realesrgan-ncnn-vulkan, which runs on NVIDIA RTX cards via Vulkan. It adds real detail but is slow
//            (roughly a second per frame per 720p frame). Lumina downloads the official release on request.
// Both double the size (capped at 3840x2160) and keep the sound.

const releaseZip = 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-ubuntu.zip';
const chunkFrames = 24;

const exec = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, args, { maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
    if (error) reject(new Error(error.code === 'ENOENT' ? `${command} is not installed` : String(stderr || error.message).trim().split('\n').slice(-3).join(' ')));
    else resolve(stdout);
  });
});

function targetSize(width, height) {
  const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
  // Twice the size, but never beyond 3840x2160 (or 2160x3840 for portrait).
  const factor = Math.min(2, 3840 / Math.max(width, height), 2160 / Math.min(width, height));
  return { width: even(width * Math.max(1, factor)), height: even(height * Math.max(1, factor)) };
}

export function createEnhancer({ binDir, workDir, log = console }) {
  const aiDir = path.join(binDir, 'realesrgan');
  const aiBinary = path.join(aiDir, 'realesrgan-ncnn-vulkan');

  async function aiTool({ allowDownload }) {
    for (const candidate of ['realesrgan-ncnn-vulkan', aiBinary]) {
      try {
        // The tool prints usage and exits non-zero without arguments; ENOENT means it is missing.
        await exec(candidate, ['-h'], { timeout: 15_000 }).catch((error) => { if (/not installed/.test(error.message)) throw error; });
        const models = candidate === aiBinary ? path.join(aiDir, 'models') : null;
        if (!models || existsSync(path.join(models, 'realesrgan-x4plus.param'))) return { binary: candidate, models };
      } catch { /* try the next one */ }
    }
    if (!allowDownload) throw Object.assign(new Error('AI upscaling uses Real-ESRGAN (about 47 MB), which is not installed yet.'), { status: 428, needsDownload: true });
    if (process.platform !== 'linux' || process.arch !== 'x64') throw Object.assign(new Error('Automatic download is only set up for 64-bit Linux.'), { status: 501 });
    const response = await fetch(releaseZip, { redirect: 'follow', signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw Object.assign(new Error(`Could not download Real-ESRGAN (HTTP ${response.status}).`), { status: 502 });
    const entries = readZip(Buffer.from(await response.arrayBuffer()), { maxBytes: 200 * 1024 * 1024 });
    mkdirSync(path.join(aiDir, 'models'), { recursive: true });
    for (const [name, bytes] of entries) {
      const base = path.basename(name);
      if (!base) continue;
      if (base === 'realesrgan-ncnn-vulkan') writeFileSync(aiBinary, bytes, { mode: 0o755 });
      else if (/\.(param|bin)$/.test(base) && name.includes('models/')) writeFileSync(path.join(aiDir, 'models', base), bytes);
    }
    if (!existsSync(aiBinary)) throw Object.assign(new Error('The Real-ESRGAN download did not contain the Linux program.'), { status: 502 });
    chmodSync(aiBinary, 0o755);
    log.info?.('Installed Real-ESRGAN', { models: readdirSync(path.join(aiDir, 'models')).length });
    return { binary: aiBinary, models: path.join(aiDir, 'models') };
  }

  // Returns { bytes, width, height, duration } for the enhanced MP4.
  async function enhanceVideo(file, { mode = 'fast', allowDownload = false, onProgress } = {}) {
    const info = await probe(file);
    const size = targetSize(info.width, info.height);
    if (size.width <= info.width) throw Object.assign(new Error('This video is already 4K; there is nothing to upscale.'), { status: 400 });
    const tool = mode === 'ai' ? await aiTool({ allowDownload }) : null;
    const { args: encode } = await videoEncoder();
    mkdirSync(workDir ?? path.dirname(file), { recursive: true });
    const dir = await mkdtemp(path.join(workDir ?? path.dirname(file), 'lumina-enhance-'));
    const out = path.join(dir, 'enhanced.mp4');
    const audio = info.hasAudio ? ['-map', '1:a:0', '-c:a', 'copy'] : [];
    try {
      if (mode !== 'ai') {
        onProgress?.(0, 1);
        const gpu = `libplacebo=w=${size.width}:h=${size.height}:upscaler=ewa_lanczossharp:format=yuv420p`;
        const cpu = `scale=${size.width}:${size.height}:flags=lanczos,format=yuv420p`;
        try {
          await run('ffmpeg', ['-v', 'error', '-i', file, '-vf', `${gpu},unsharp=5:5:0.5`, ...encode, '-c:a', 'copy', '-movflags', '+faststart', '-y', out], 1_800_000);
        } catch (error) {
          log.info?.('GPU scaler unavailable, using CPU Lanczos', { detail: error.message });
          await run('ffmpeg', ['-v', 'error', '-i', file, '-vf', `${cpu},unsharp=5:5:0.5`, ...encode, '-c:a', 'copy', '-movflags', '+faststart', '-y', out], 1_800_000);
        }
        onProgress?.(1, 1);
      } else {
        // In chunks of frames so the 4x intermediate images never fill the disk.
        const fps = info.fps || 30;
        const totalFrames = Math.max(1, Math.round(info.duration * fps));
        const chunks = Math.ceil(totalFrames / chunkFrames);
        const parts = [];
        for (let index = 0; index < chunks; index += 1) {
          const frames = path.join(dir, 'in');
          const upscaled = path.join(dir, 'up');
          await rm(frames, { recursive: true, force: true });
          await rm(upscaled, { recursive: true, force: true });
          mkdirSync(frames);
          mkdirSync(upscaled);
          const first = index * chunkFrames;
          await run('ffmpeg', ['-v', 'error', '-ss', (first / fps).toFixed(4), '-i', file, '-frames:v', String(Math.min(chunkFrames, totalFrames - first)), '-start_number', '0', path.join(frames, '%05d.png')], 600_000);
          if (!readdirSync(frames).length) break;
          await exec(tool.binary, ['-i', frames, '-o', upscaled, '-n', 'realesrgan-x4plus', '-s', '4', '-f', 'png', ...(tool.models ? ['-m', tool.models] : [])], { timeout: 1_800_000 });
          const part = path.join(dir, `part-${String(index).padStart(5, '0')}.mp4`);
          await run('ffmpeg', ['-v', 'error', '-framerate', String(fps), '-start_number', '0', '-i', path.join(upscaled, '%05d.png'),
            '-vf', `scale=${size.width}:${size.height}:flags=lanczos,format=yuv420p`, ...encode, '-video_track_timescale', '15360', '-y', part], 600_000);
          parts.push(part);
          onProgress?.(index + 1, chunks);
        }
        await rm(path.join(dir, 'in'), { recursive: true, force: true });
        await rm(path.join(dir, 'up'), { recursive: true, force: true });
        const list = path.join(dir, 'list.txt');
        await writeFile(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
        await run('ffmpeg', ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-i', file, '-map', '0:v:0', ...audio, '-c:v', 'copy', '-shortest', '-movflags', '+faststart', '-y', out], 600_000);
      }
      const result = await probe(out);
      return { bytes: await readFile(out), width: result.width, height: result.height, duration: result.duration };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // Background enhancement jobs, one per source video: { state, done, total, mode, error, assetId }.
  const jobs = new Map();
  function start({ asset, assetStore, mode, allowDownload, onDone }) {
    if (jobs.get(asset.id)?.state === 'running') throw Object.assign(new Error('This video is already being enhanced.'), { status: 409 });
    const job = { state: 'running', mode, done: 0, total: 1, error: null, assetId: null };
    jobs.set(asset.id, job);
    const ready = mode === 'ai' ? aiTool({ allowDownload }) : Promise.resolve();
    return ready.then(() => {
      (async () => {
        try {
          const result = await enhanceVideo(assetStore.path(asset), { mode, onProgress: (done, total) => Object.assign(job, { done, total }) });
          const saved = await assetStore.save({ bytes: result.bytes, projectId: asset.projectId, kind: 'video', label: `${asset.label ?? 'Video'} (enhanced ${result.width}×${result.height})`, parentAssetId: asset.id });
          Object.assign(job, { state: 'completed', assetId: saved.id, width: result.width, height: result.height });
          onDone?.(saved);
        } catch (error) {
          Object.assign(job, { state: 'failed', error: `Enhancing failed: ${error.message}` });
        }
      })();
      return job;
    }, (error) => {
      jobs.delete(asset.id);
      throw error;
    });
  }

  return { enhanceVideo, start, status: (assetId) => jobs.get(assetId) ?? null, targetSize };
}
