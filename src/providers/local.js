import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderError } from './http.js';

// Local GPU: open-weight models run on this computer with Hugging Face diffusers — no API, no key, no cost.
// Wan 2.2 TI2V-5B (Apache 2.0) makes both the still frame (one-frame generation) and the clip (text-to-video, or
// image-to-video from the shot's approved frame), at 720p, 24 fps. A Python worker (local/wan_worker.py) loads the
// model once with FP8 weights and stays up between jobs; it is stopped after 10 idle minutes so the GPU is free for
// other programs. If a job runs out of GPU memory, the worker moves the model into main memory (streamed to the GPU
// layer by layer) and runs the job again: slower, same result. Jobs run one at a time. The model must already be in the Hugging Face cache (downloaded with
// `hf download Wan-AI/Wan2.2-TI2V-5B-Diffusers`); the worker never downloads.

const repoId = 'Wan-AI/Wan2.2-TI2V-5B-Diffusers';
const workerFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'local', 'wan_worker.py').replace('app.asar', 'app.asar.unpacked');
const idleMs = 10 * 60_000;
const sizes = { '16:9': [1280, 704], '9:16': [704, 1280], '1:1': [960, 960] };
const fps = 24;

const hubDir = () => process.env.HF_HUB_CACHE || path.join(process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface'), 'hub');

// Is the whole model in the cache? (Every file the snapshot's shard indexes name must be present.)
export function modelInstalled(dir = hubDir()) {
  const snapshots = path.join(dir, `models--${repoId.replace('/', '--')}`, 'snapshots');
  if (!existsSync(snapshots)) return false;
  return readdirSync(snapshots).some((snap) => {
    const root = path.join(snapshots, snap);
    if (!existsSync(path.join(root, 'model_index.json'))) return false;
    return ['transformer/diffusion_pytorch_model.safetensors.index.json', 'text_encoder/model.safetensors.index.json'].every((index) => {
      const file = path.join(root, index);
      if (!existsSync(file)) return false;
      const shards = new Set(Object.values(JSON.parse(readFileSync(file, 'utf8')).weight_map));
      return [...shards].every((shard) => existsSync(path.join(path.dirname(file), shard)));
    }) && existsSync(path.join(root, 'vae', 'diffusion_pytorch_model.safetensors'));
  });
}

// A Python that has torch (with CUDA) and diffusers: LUMINA_PYTHON, then common conda locations, then PATH.
let pythonFound;
export function findPython() {
  if (pythonFound !== undefined) return pythonFound;
  const home = os.homedir();
  const candidates = [process.env.LUMINA_PYTHON, path.join(home, 'miniconda3', 'bin', 'python3'), path.join(home, 'anaconda3', 'bin', 'python3'),
    path.join(home, 'miniforge3', 'bin', 'python3'), 'python3'].filter(Boolean);
  pythonFound = candidates.find((python) => (python === 'python3' || existsSync(python))
    && spawnSync(python, ['-c', 'import torch, diffusers; assert torch.cuda.is_available()'], { stdio: 'ignore', timeout: 60_000 }).status === 0) ?? null;
  return pythonFound;
}

function createWorker() {
  let child = null;
  let buffer = '';
  let idleTimer = null;
  const waiting = new Map(); // request id → { resolve, reject, onProgress }
  let queue = Promise.resolve();
  let counter = 0;

  function stop() {
    clearTimeout(idleTimer);
    if (child) child.kill('SIGTERM');
    child = null;
  }

  function start() {
    if (child) return;
    const python = findPython();
    if (!python) throw new ProviderError('provider', 'No Python with PyTorch (CUDA) and diffusers was found. Set LUMINA_PYTHON to one.');
    child = spawn(python, [workerFile], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const job = waiting.get(message.id);
        if (!job) continue;
        if (message.progress) job.onProgress?.(message.progress, message.total);
        else if (message.notice) console.info(`[local] ${message.notice}`);
        else if (message.done) { waiting.delete(message.id); job.resolve(message); }
        else if (message.error) { waiting.delete(message.id); job.reject(new ProviderError('provider', message.error)); }
      }
    });
    child.on('exit', (code) => {
      const error = new ProviderError('provider', `The local model stopped unexpectedly (exit ${code}). ${stderr.split('\n').filter(Boolean).slice(-3).join(' ')}`);
      for (const job of waiting.values()) job.reject(error);
      waiting.clear();
      child = null;
    });
  }

  // One job at a time; the worker stays loaded until it has been idle for a while.
  function request(payload, onProgress) {
    const run = async () => {
      clearTimeout(idleTimer);
      start();
      const id = `job-${++counter}`;
      const result = new Promise((resolve, reject) => waiting.set(id, { resolve, reject, onProgress }));
      child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
      try {
        return await result;
      } finally {
        idleTimer = setTimeout(stop, idleMs);
        idleTimer.unref?.();
      }
    };
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  }

  return { request, stop };
}

const worker = createWorker();
process.once('exit', () => worker.stop());

async function inTemp(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lumina-local-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const sizeFor = (size, aspect) => {
  if (aspect && sizes[aspect]) return sizes[aspect];
  const [w, h] = String(size ?? '').split('x').map(Number);
  if (!w || !h) return sizes['16:9'];
  return w > h * 1.2 ? sizes['16:9'] : h > w * 1.2 ? sizes['9:16'] : sizes['1:1'];
};
const log = (label) => (step, total) => { if (step === total || step % 10 === 0) console.info(`[local] ${label} step ${step}/${total}`); };

export default {
  id: 'local',
  label: 'Local GPU (open models)',
  keyless: true,
  // Ready when the model is downloaded (a quick file check). The Python check is slow, so it runs with the first job.
  available: () => modelInstalled(),
  unavailableNote: `Download the model first: hf download ${repoId} (34 GB), with Python, PyTorch (CUDA) and diffusers installed.`,
  models: [
    {
      id: 'wan2.2-ti2v-5b', label: 'Wan 2.2 TI2V 5B · FP8 (your GPU)', operations: ['generate', 'video'],
      sizes: ['1280x704', '704x1280', '960x960'], qualities: [], maxReferences: 1, seed: true,
      durations: [2, 3, 4, 5], aspects: ['16:9', '9:16', '1:1'], resolutions: ['720p'], lastFrame: false,
      note: 'Open weights (Apache 2.0), runs on this computer: free, private, no API. A 5-second clip takes several minutes on a 12 GB GPU.',
    },
  ],
  async validateKey() {
    return { ok: true, verified: true };
  },
  // A still frame: Wan generating a single frame.
  async run({ prompt, size, seed }) {
    const [width, height] = sizeFor(size);
    return inTemp(async (dir) => {
      const out = path.join(dir, 'frame.png');
      await worker.request({ task: 'image', prompt, width, height, seed: seed ?? 0, steps: 40, out }, log('frame'));
      return { bytes: await readFile(out), usage: { local: true, cost: 0 } };
    });
  },
  // A clip: image-to-video from the start frame when given, otherwise text-to-video.
  async video({ prompt, image, duration, aspect, seed }) {
    const [width, height] = sizeFor(null, aspect);
    const seconds = Math.min(5, Math.max(1, Math.round(Number(duration) || 5)));
    return inTemp(async (dir) => {
      let imagePath = null;
      if (image?.bytes) {
        imagePath = path.join(dir, 'start.png');
        await writeFile(imagePath, image.bytes);
      }
      const out = path.join(dir, 'clip.mp4');
      await worker.request({ task: 'video', prompt, image: imagePath, width, height, frames: seconds * fps + 1, fps, seed: seed ?? 0, steps: 50, out }, log('clip'));
      return { bytes: await readFile(out), usage: { local: true, cost: 0 } };
    });
  },
};
