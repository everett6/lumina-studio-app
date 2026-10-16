import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { probe, run, runCapture, runVideo, videoEncoder } from './video.js';
import { fetchZipEntries, readZip } from './zip.js';
import { withGpuLease } from './providers/local.js';

// Align to source timestamps rather than stretching the last source frame to the end of the audio.
export function interpolationTimeline(sourceFrames, sourceFps, targetFps) {
  if (!Number.isInteger(sourceFrames) || sourceFrames < 2 || !Number.isFinite(sourceFps) || sourceFps <= 0 || !Number.isFinite(targetFps) || targetFps <= sourceFps) {
    throw new Error('Interpolation requires at least two frames and a higher finite target frame rate.');
  }
  const generatedFrames = Math.round((sourceFrames - 1) * targetFps / sourceFps) + 1;
  const deliveryFrames = Math.ceil(sourceFrames * targetFps / sourceFps - 1e-6);
  const anchors = Array.from({ length: sourceFrames }, (_, index) => ({ source: index + 1, target: Math.round(index * targetFps / sourceFps) + 1 }));
  return { generatedFrames, deliveryFrames, anchors, duration: deliveryFrames / targetFps };
}

// Video enhancement on this computer's GPU.
//
// DLSS itself only works inside games (it upscales frames a game engine renders, using its motion vectors), and
// NVIDIA's RTX Video Super Resolution only works during playback in a browser or player, so neither can improve a
// saved video file. The closest options that do:
//  - 'fast': ffmpeg's libplacebo (Vulkan, runs on the GPU) with the EWA Lanczos-sharp scaler: 2x, seconds per minute.
//  - 'ai':   Real-ESRGAN (realesrgan-x4plus, a photo-realistic super-resolution network) through
//            realesrgan-ncnn-vulkan, which runs on NVIDIA RTX cards via Vulkan. It adds real detail but is slow
//            (roughly a second per frame per 720p frame). Lumina downloads the official release on request.
//  - 'anime': Real-ESRGAN's realesr-animevideov3, trained for animation and video (clean line art, less flicker
//            between frames, several times faster than x4plus). Same download.
// Each mode scales to a chosen size (default twice the size, capped at 3840x2160): the AI models enlarge by a
// whole factor and Lanczos brings the result to the exact size, so detail is never thrown away and re-invented.
// AI output can be smoothed with a light luminance deflicker. Working files are lossless PNG frames and
// near-lossless video; only the last step encodes at delivery quality. Sound is kept untouched.
//
// Frame interpolation (smoother motion, e.g. 24 → 30 fps) uses RIFE v4.6 through rife-ncnn-vulkan (MIT licence),
// also on the GPU. Only the program and that one model (about 20 MB) are fetched from the official 431 MB release
// archive. Clips containing a cut are refused: interpolating across a cut smears two shots together.

const releaseZip = 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-ubuntu.zip';
const rifeZip = 'https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-ubuntu.zip';
const chunkFrames = 48;
export const enhanceModes = ['fast', 'ai', 'anime'];

const exec = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, args, { maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
    if (error) reject(new Error(error.code === 'ENOENT' ? `${command} is not installed` : String(stderr || error.message).trim().split('\n').slice(-3).join(' ')));
    else resolve(stdout);
  });
});

function targetSize(width, height, target = null) {
  const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
  // A requested size keeps the clip's shape: it is fitted inside target.width × target.height.
  if (target?.width && target?.height) {
    const fit = Math.min(target.width / width, target.height / height);
    // Within a few pixels of the target (rounding, 854×480 → 1920×1080), use the target exactly.
    const snap = (value, wanted) => (Math.abs(value - wanted) <= 4 ? wanted : even(Math.round(value)));
    return { width: snap(width * fit, target.width), height: snap(height * fit, target.height) };
  }
  // Twice the size, but never beyond 3840x2160 (or 2160x3840 for portrait).
  const factor = Math.min(2, 3840 / Math.max(width, height), 2160 / Math.min(width, height));
  return { width: even(width * Math.max(1, factor)), height: even(height * Math.max(1, factor)) };
}

export function createEnhancer({ binDir, workDir, log = console }) {
  const aiDir = path.join(binDir, 'realesrgan');
  const aiBinary = path.join(aiDir, 'realesrgan-ncnn-vulkan');
  const rifeDir = path.join(binDir, 'rife');
  const rifeBinary = path.join(rifeDir, 'rife-ncnn-vulkan');

  async function rifeTool({ allowDownload }) {
    const model = path.join(rifeDir, 'rife-v4.6');
    if (existsSync(rifeBinary) && existsSync(path.join(model, 'flownet.bin'))) return { binary: rifeBinary, model };
    if (!allowDownload) throw Object.assign(new Error('Frame interpolation uses RIFE (about 20 MB, taken from its official release), which is not installed yet.'), { status: 428, needsDownload: true });
    if (process.platform !== 'linux' || process.arch !== 'x64') throw Object.assign(new Error('Automatic download is only set up for 64-bit Linux.'), { status: 501 });
    const entries = await fetchZipEntries(rifeZip, (name) => /\/(rife-ncnn-vulkan|LICENSE|rife-v4\.6\/flownet\.(param|bin))$/.test(name));
    mkdirSync(model, { recursive: true });
    for (const [name, bytes] of entries) {
      if (name.endsWith('/rife-ncnn-vulkan')) writeFileSync(rifeBinary, bytes, { mode: 0o755 });
      else if (name.endsWith('/LICENSE')) writeFileSync(path.join(rifeDir, 'LICENSE'), bytes);
      else writeFileSync(path.join(model, path.basename(name)), bytes);
    }
    if (!existsSync(rifeBinary) || !existsSync(path.join(model, 'flownet.bin'))) throw Object.assign(new Error('The RIFE download was incomplete.'), { status: 502 });
    chmodSync(rifeBinary, 0o755);
    log.info?.('Installed RIFE v4.6');
    return { binary: rifeBinary, model };
  }

  // Smoother motion: RIFE makes the in-between frames so the clip plays at `fps` (same length, same sound).
  // Returns null when the clip already runs at that rate or faster.
  async function interpolateInner(file, { fps = 30, allowDownload = false, onProgress } = {}) {
    const info = await probe(file);
    if (info.fps >= fps - 0.5) return null;
    const cuts = (await runCapture('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vf', "select='gt(scene,0.4)',showinfo", '-an', '-f', 'null', '-'], 300_000)).stderr;
    if (/pts_time:/.test(cuts)) throw Object.assign(new Error('This clip contains a cut; interpolating across it would blend two shots. Trim it first.'), { status: 400 });
    const tool = await rifeTool({ allowDownload });
    const { args: encode } = await videoEncoder('mezzanine');
    mkdirSync(workDir ?? path.dirname(file), { recursive: true });
    const dir = await mkdtemp(path.join(workDir ?? path.dirname(file), 'lumina-rife-'));
    try {
      const frames = path.join(dir, 'in');
      const out = path.join(dir, 'out');
      mkdirSync(frames);
      mkdirSync(out);
      await run('ffmpeg', ['-v', 'error', '-i', file, '-start_number', '1', path.join(frames, '%08d.png')], 600_000);
      onProgress?.(1, 3);
      const sources = readdirSync(frames).filter((name) => /^\d{8}\.png$/.test(name)).sort();
      const timeline = interpolationTimeline(sources.length, info.fps, fps);
      const count = timeline.generatedFrames;
      await exec(tool.binary, ['-i', frames, '-o', out, '-m', tool.model, '-n', String(count), '-f', '%08d.png'], { timeout: 3_600_000 });
      const made = readdirSync(out).filter((name) => /^\d{8}\.png$/.test(name)).sort();
      const frameName = (index) => `${String(index).padStart(8, '0')}.png`;
      if (made.length !== count || made.some((name, index) => name !== frameName(index + 1))) {
        throw new Error(`RIFE returned an incomplete or non-contiguous frame sequence (${made.length} of ${count}). Original clip retained.`);
      }
      // Restore source anchors losslessly before encoding. Non-integer ratios align to the nearest target
      // frame (at most half a delivery frame); this is timestamp preservation, not ground-truth motion QC.
      for (const anchor of timeline.anchors) await copyFile(path.join(frames, frameName(anchor.source)), path.join(out, frameName(anchor.target)));
      for (let index = count + 1; index <= timeline.deliveryFrames; index++) {
        await copyFile(path.join(frames, sources.at(-1)), path.join(out, frameName(index)));
      }
      onProgress?.(2, 3);
      const result = path.join(dir, 'smooth.mp4');
      await runVideo(['-v', 'error', '-framerate', String(fps), '-start_number', '1', '-i', path.join(out, '%08d.png'), '-i', file,
        '-map', '0:v:0', ...(info.hasAudio ? ['-map', '1:a:0', '-c:a', 'copy'] : []), '-vf', 'format=yuv420p', ...encode, '-t', String(timeline.duration), '-movflags', '+faststart', '-y', result], 600_000);
      onProgress?.(3, 3);
      const done = await probe(result);
      if (Math.abs(done.duration - timeline.duration) > 1 / fps + 0.005 || Math.abs(done.fps - fps) > 0.01 || (info.hasAudio && !done.hasAudio)) throw new Error('Interpolated output failed duration/frame-rate/audio checks. Original clip retained.');
      return { bytes: await readFile(result), width: done.width, height: done.height, duration: done.duration, fps: done.fps, sourceAnchors: timeline.anchors.length };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function aiTool({ allowDownload }) {
    for (const candidate of ['realesrgan-ncnn-vulkan', aiBinary]) {
      try {
        // The tool prints usage and exits non-zero without arguments; ENOENT means it is missing.
        await exec(candidate, ['-h'], { timeout: 15_000 }).catch((error) => { if (/not installed/.test(error.message)) throw error; });
        const models = candidate === aiBinary ? path.join(aiDir, 'models') : null;
        if (!models || (existsSync(path.join(models, 'realesrgan-x4plus.param')) && existsSync(path.join(models, 'realesr-animevideov3-x2.param')))) return { binary: candidate, models };
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

  // Returns { bytes, width, height, duration } for the enhanced MP4. `target` fits the result inside a size
  // (e.g. 1920×1080); `profile` 'mezzanine' keeps it near-lossless for further processing.
  async function enhanceVideoInner(file, { mode = 'fast', allowDownload = false, onProgress, preparedTool, target = null, profile = 'final', deflicker = true } = {}) {
    const info = await probe(file);
    const size = targetSize(info.width, info.height, target);
    if (size.width <= info.width) throw Object.assign(new Error(target ? 'This video is already at least that size.' : 'This video is already 4K; there is nothing to upscale.'), { status: 400 });
    const ai = mode === 'ai' || mode === 'anime';
    const tool = ai ? preparedTool ?? await aiTool({ allowDownload }) : null;
    const { args: encode } = await videoEncoder(profile);
    const { args: working } = await videoEncoder('mezzanine');
    // The AI enlarges by a whole factor at least as big as needed; Lanczos then fits the exact size.
    const need = size.width / info.width;
    const factor = mode === 'anime' ? (need <= 2 ? 2 : need <= 3 ? 3 : 4) : 4;
    const network = mode === 'anime' ? ['-n', 'realesr-animevideov3', '-s', String(factor)] : ['-n', 'realesrgan-x4plus', '-s', '4'];
    mkdirSync(workDir ?? path.dirname(file), { recursive: true });
    const dir = await mkdtemp(path.join(workDir ?? path.dirname(file), 'lumina-enhance-'));
    const out = path.join(dir, 'enhanced.mp4');
    const audio = info.hasAudio ? ['-map', '1:a:0', '-c:a', 'copy'] : [];
    try {
      if (!ai) {
        onProgress?.(0, 1);
        const gpu = `libplacebo=w=${size.width}:h=${size.height}:upscaler=ewa_lanczossharp:format=yuv420p`;
        const cpu = `scale=${size.width}:${size.height}:flags=lanczos,format=yuv420p`;
        const streams = ['-map', '0:v:0', ...(info.hasAudio ? ['-map', '0:a:0'] : [])];
        try {
          await runVideo(['-v', 'error', '-i', file, ...streams, '-vf', `${gpu},unsharp=5:5:0.4`, ...encode, '-c:a', 'copy', '-movflags', '+faststart', '-y', out], 1_800_000);
        } catch (error) {
          log.info?.('GPU scaler unavailable, using CPU Lanczos', { detail: error.message });
          await runVideo(['-v', 'error', '-i', file, ...streams, '-vf', `${cpu},unsharp=5:5:0.4`, ...encode, '-c:a', 'copy', '-movflags', '+faststart', '-y', out], 1_800_000);
        }
        onProgress?.(1, 1);
      } else {
        // In chunks of frames so the 4x intermediate images never fill the disk.
        const fps = info.fps || 30;
        const totalFrames = Math.max(1, info.frames ?? Math.round(info.duration * fps));
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
          const inputFrames = readdirSync(frames).filter((name) => /^\d{5}\.png$/.test(name)).length;
          // Container frame counts can overstate by a frame or two: an empty last chunk just ends the video.
          if (!inputFrames && index > 0) break;
          if (!inputFrames) throw new Error('Could not read any frames from this video.');
          await exec(tool.binary, ['-i', frames, '-o', upscaled, ...network, '-f', 'png', ...(tool.models ? ['-m', tool.models] : [])], { timeout: 1_800_000 });
          const outputFrames = readdirSync(upscaled).filter((name) => /^\d{5}\.png$/.test(name)).length;
          if (outputFrames !== inputFrames) throw new Error(`Real-ESRGAN returned ${outputFrames} of ${inputFrames} frames in chunk ${index + 1}.`);
          const part = path.join(dir, `part-${String(index).padStart(5, '0')}.mp4`);
          await runVideo(['-v', 'error', '-framerate', String(fps), '-start_number', '0', '-i', path.join(upscaled, '%05d.png'),
            '-vf', `scale=${size.width}:${size.height}:flags=lanczos,format=yuv420p`, ...working, '-video_track_timescale', '15360', '-y', part], 600_000);
          parts.push(part);
          onProgress?.(index + 1, chunks);
        }
        await rm(path.join(dir, 'in'), { recursive: true, force: true });
        await rm(path.join(dir, 'up'), { recursive: true, force: true });
        const list = path.join(dir, 'list.txt');
        await writeFile(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
        // One pass over the whole clip: light deflicker across chunk boundaries, then the requested quality.
        await runVideo(['-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-i', file, '-map', '0:v:0', ...audio,
          '-vf', deflicker ? 'deflicker=mode=pm:size=5,format=yuv420p' : 'format=yuv420p', ...encode, '-shortest', '-movflags', '+faststart', '-y', out], 1_800_000);
      }
      const result = await probe(out);
      return { bytes: await readFile(out), width: result.width, height: result.height, duration: result.duration };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // Background enhancement jobs, one per source video: { state, done, total, mode, error, assetId }.
  // Still-image variant: use only an installed binary, and keep photo x4plus at its native 4x
  // before resizing to 2x. Like video/RIFE this takes the shared GPU lease; no downloads here.
  async function upscaleImageInner(file, { scale = 2, engine = 'local-anime', preparedTool } = {}) {
    if (![2, 4].includes(scale) || !['local-anime', 'local-photo'].includes(engine)) throw Object.assign(new Error('Choose scale 2 or 4 and local-anime or local-photo.'), { status: 400 });
    const info = await probe(file);
    const width = info.width * scale, height = info.height * scale;
    if (width > 16384 || height > 16384 || width * height > 32_000_000) throw Object.assign(new Error('Upscaled image exceeds the 32 million pixel / 16384 per-side limit.'), { status: 400 });
    const tool = preparedTool ?? await aiTool({ allowDownload: false });
    mkdirSync(workDir ?? path.dirname(file), { recursive: true });
    const dir = await mkdtemp(path.join(workDir ?? path.dirname(file), 'lumina-image-upscale-'));
    try {
      const input = path.join(dir, 'input.png'), enlarged = path.join(dir, 'enlarged.png'), out = path.join(dir, 'output.png');
      // Decode JPEG/WebP first: the NCNN program's image support varies between releases.
      await run('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-threads', '1', '-y', input], 60_000);
      const anime = engine === 'local-anime';
      await exec(tool.binary, ['-i', input, '-o', enlarged, '-n', anime ? 'realesr-animevideov3' : 'realesrgan-x4plus', '-s', String(anime ? scale : 4), '-f', 'png', ...(tool.models ? ['-m', tool.models] : [])], { timeout: 600_000 });
      await run('ffmpeg', ['-v', 'error', '-i', enlarged, '-vf', `scale=${width}:${height}:flags=lanczos`, '-frames:v', '1', '-threads', '1', '-y', out], 60_000);
      return { bytes: await readFile(out), width, height };
    } finally { await rm(dir, { recursive: true, force: true }); }
  }

  const jobs = new Map();
  const pending = new Set();
  function track(promise) {
    pending.add(promise);
    promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  }
  async function idle() { while (pending.size) await Promise.allSettled([...pending]); }
  function start({ asset, assetStore, mode, allowDownload, onDone, target = null }) {
    if (jobs.get(asset.id)?.state === 'running') throw Object.assign(new Error('This video is already being enhanced.'), { status: 409 });
    for (const [id, old] of jobs) {
      if (jobs.size <= 100) break;
      if (old.state !== 'running') jobs.delete(id);
    }
    const job = { state: 'running', mode, done: 0, total: 1, error: null, assetId: null };
    jobs.set(asset.id, job);
    const ready = mode === 'ai' || mode === 'anime' ? aiTool({ allowDownload }) : Promise.resolve(null);
    return track(ready.then((preparedTool) => {
      track((async () => {
        try {
          const result = await enhanceVideo(assetStore.path(asset), { mode, preparedTool, target, onProgress: (done, total) => Object.assign(job, { done, total }) });
          const saved = await assetStore.save({ bytes: result.bytes, projectId: asset.projectId, kind: 'video', label: `${asset.label ?? 'Video'} (enhanced ${result.width}×${result.height})`, parentAssetId: asset.id });
          Object.assign(job, { state: 'completed', assetId: saved.id, width: result.width, height: result.height });
          await onDone?.(saved);
        } catch (error) {
          Object.assign(job, { state: 'failed', error: `Enhancing failed: ${error.message}` });
        }
      })());
      return job;
    }, (error) => {
      jobs.delete(asset.id);
      throw error;
    }));
  }

  // Which optional tools are installed (nothing is downloaded here).
  async function tools() {
    const ai = await aiTool({ allowDownload: false }).then(() => true, () => false);
    const rife = existsSync(rifeBinary) && existsSync(path.join(rifeDir, 'rife-v4.6', 'flownet.bin'));
    return { ai, rife, downloadMb: { ai: 47, rife: 20 } };
  }

  const interpolate = (...args) => withGpuLease(() => interpolateInner(...args));
  const enhanceVideo = (...args) => withGpuLease(() => enhanceVideoInner(...args));
  const upscaleImage = (...args) => withGpuLease(() => upscaleImageInner(...args));
  return { enhanceVideo, upscaleImage, interpolate, aiTool, rifeTool, tools, start, idle, status: (assetId) => jobs.get(assetId) ?? null, targetSize };
}
