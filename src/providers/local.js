import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderError } from './http.js';
import { gpuQueue } from '../gpu.js';

// Local GPU: open-weight models run on this computer with Hugging Face diffusers — no API, no key, no cost.
// Wan 2.2 TI2V-5B (Apache 2.0) makes both the still frame (one-frame generation) and the clip (text-to-video, or
// image-to-video from the shot's approved frame), at 720p, 24 fps. A Python worker (local/wan_worker.py) loads the
// model once with FP8 weights and stays up between jobs; it is stopped after 10 idle minutes so the GPU is free for
// other programs. If a job runs out of GPU memory, the worker moves the model into main memory (streamed to the GPU
// layer by layer) and runs the job again: slower, same result. Jobs run one at a time. The model must already be in the Hugging Face cache (downloaded with
// `hf download Wan-AI/Wan2.2-TI2V-5B-Diffusers`); the worker never downloads.

const repoId = 'Wan-AI/Wan2.2-TI2V-5B-Diffusers';
const animeRepo = 'cagliostrolab/animagine-xl-4.0';
const workerPath = (name) => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'local', name).replace('app.asar', 'app.asar.unpacked');
const idleMs = 10 * 60_000;
const sizes = { '16:9': [1280, 704], '9:16': [704, 1280], '1:1': [960, 960] };
const fps = 24;

const animeSizes = { '16:9': [1344, 768], '9:16': [768, 1344], '1:1': [1024, 1024] };
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
      try {
        const weightMap = JSON.parse(readFileSync(file, 'utf8')).weight_map;
        if (!weightMap || typeof weightMap !== 'object') return false;
        const shards = new Set(Object.values(weightMap));
        return shards.size > 0 && [...shards].every((shard) => typeof shard === 'string' && existsSync(path.join(path.dirname(file), shard)));
      } catch {
        // A snapshot can be visible while Hugging Face is still writing its index.
        return false;
      }
    }) && existsSync(path.join(root, 'vae', 'diffusion_pytorch_model.safetensors'));
  });
}

// Is Animagine XL 4.0 (diffusers layout) in the cache?
export function animeModelInstalled(dir = hubDir()) {
  const snapshots = path.join(dir, `models--${animeRepo.replace('/', '--')}`, 'snapshots');
  if (!existsSync(snapshots)) return false;
  return readdirSync(snapshots).some((snap) => ['model_index.json', 'unet/diffusion_pytorch_model.safetensors', 'vae/diffusion_pytorch_model.safetensors',
    'text_encoder/model.safetensors', 'text_encoder_2/model.safetensors'].every((file) => existsSync(path.join(snapshots, snap, file))));
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

// The voice models live in their own Python environment (their packages would replace the video models' ones).
const voicePython = () => {
  const python = process.env.LUMINA_VOICE_PYTHON || path.join(os.homedir(), '.local', 'share', 'lumina-studio', 'voice-env', 'bin', 'python');
  return existsSync(python) ? python : null;
};
const kokoroRepo = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const chatterboxRepo = 'ResembleAI/chatterbox';
const snapshotHas = (repo, files, dir = hubDir()) => {
  const snapshots = path.join(dir, `models--${repo.replace('/', '--')}`, 'snapshots');
  return existsSync(snapshots) && readdirSync(snapshots).some((snap) => files.every((file) => existsSync(path.join(snapshots, snap, file))));
};
export const voiceInstalled = (engine) => Boolean(voicePython()) && (engine === 'chatterbox'
  ? snapshotHas(chatterboxRepo, ['ve.safetensors', 't3_cfg.safetensors', 's3gen.safetensors', 'tokenizer.json', 'conds.pt']) && snapshotHas(kokoroRepo, ['onnx/model.onnx'])
  : snapshotHas(kokoroRepo, ['onnx/model.onnx', 'voices/af_heart.bin']));
// Kokoro's preset voices: the first letter is the accent (a American, b British, j Japanese, z Mandarin, ...), the
// second the voice (f female, m male).
const kokoroVoices = ['af_heart', 'af_bella', 'af_nicole', 'af_aoede', 'af_kore', 'af_sarah', 'af_nova', 'af_sky', 'af_alloy', 'af_jessica', 'af_river',
  'am_michael', 'am_fenrir', 'am_puck', 'am_echo', 'am_eric', 'am_liam', 'am_onyx', 'am_santa', 'am_adam',
  'bf_emma', 'bf_isabella', 'bf_alice', 'bf_lily', 'bm_george', 'bm_fable', 'bm_lewis', 'bm_daniel',
  'jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro', 'jm_kumo'];

export function createWorker(workerFile, python = findPython) {
  let child = null;
  let buffer = '';
  let idleTimer = null;
  const waiting = new Map(); // request id → { resolve, reject, onProgress }
  let counter = 0;
  let stopping = null;

  function stop() {
    clearTimeout(idleTimer);
    if (stopping) return stopping;
    if (!child) return Promise.resolve();
    const current = child;
    stopping = new Promise((resolve, reject) => {
      const forced = setTimeout(() => current.kill('SIGKILL'), 5000);
      const failed = setTimeout(() => reject(new ProviderError('provider', 'The previous local model did not exit; GPU work is paused to avoid memory contention.')), 10000);
      current.once('exit', () => { clearTimeout(forced); clearTimeout(failed); resolve(); });
      current.kill('SIGTERM');
    });
    stopping.then(() => { stopping = null; }, () => {});
    return stopping;
  }

  function start() {
    if (child) return;
    const executable = python();
    if (!executable) throw new ProviderError('provider', 'No Python with PyTorch (CUDA) and diffusers was found. Set LUMINA_PYTHON to one.');
    child = spawn(executable, [workerFile], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    buffer = '';
    child.on('error', (error) => {
      for (const job of waiting.values()) job.reject(new ProviderError('provider', `The local worker could not start: ${error.message}`));
      waiting.clear(); child = null;
    });
    child.stdin.on('error', (error) => {
      for (const job of waiting.values()) job.reject(new ProviderError('provider', `The local worker input closed: ${error.message}`));
      waiting.clear();
    });
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

  // The worker stays loaded until it has been idle for a while. Callers go through `gpu` (one job at a time).
  async function request(payload, onProgress) {
    clearTimeout(idleTimer);
    if (stopping) await stopping;
    start();
    const id = `job-${++counter}`;
    const result = new Promise((resolve, reject) => waiting.set(id, { resolve, reject, onProgress }));
    child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    try {
      return await result;
    } finally {
      idleTimer = setTimeout(() => { stop().catch((error) => console.error('Local model shutdown failed', { detail: error.message })); }, idleMs);
      idleTimer.unref?.();
    }
  }

  return { request, stop };
}

const workers = {
  wan: createWorker(workerPath('wan_worker.py')), anime: createWorker(workerPath('sdxl_worker.py')),
  voice: createWorker(workerPath('voice_worker.py'), voicePython), lipsync: createWorker(workerPath('lipsync_worker.py'), voicePython),
};
const animeFace = () => process.env.LUMINA_ANIME_FACE || path.join(os.homedir(), '.local', 'share', 'lumina-studio', 'anime-face', 'lbpcascade_animeface.xml');
// Lip sync: anime mouth flaps need the anime image model (to draw the mouths) and the anime face detector;
// MuseTalk (live action) needs its UNet, the Stable Diffusion VAE and Whisper-tiny.
export const lipSyncInstalled = (mode) => Boolean(voicePython()) && (mode === 'musetalk'
  ? snapshotHas('TMElyralab/MuseTalk', ['musetalkV15/unet.pth', 'musetalkV15/musetalk.json']) && snapshotHas('stabilityai/sd-vae-ft-mse', ['config.json', 'diffusion_pytorch_model.safetensors'])
    && snapshotHas('openai/whisper-tiny', ['config.json', 'pytorch_model.bin']) && existsSync(animeFace())
  : animeModelInstalled() && existsSync(animeFace()));

// Lumina-side helpers (not part of the provider contract): find the mouth on a picture, draw the three anime mouths,
// and lip-sync a clip. Paths in, files out; one GPU job at a time like everything else here.
export async function findMouth(image) {
  return (await gpu('lipsync', { task: 'find-mouth', image }, null, { exclusive: false })).box ?? null;
}
export async function drawMouths({ image, box, prompt, seed, out }) {
  await gpu('anime', { task: 'mouths', image, box, prompt, seed: seed ?? 0, out });
  return { closed: path.join(out, 'closed.png'), half: path.join(out, 'half.png'), open: path.join(out, 'open.png') };
}
export async function lipSync({ video, audio, mode, box, mouths, out }) {
  const flaps = mode !== 'musetalk';
  await gpu('lipsync', { task: 'lipsync', mode: flaps ? 'flaps' : 'musetalk', video, audio, box, mouths, out }, null, { exclusive: !flaps });
  return out;
}
process.once('exit', () => Object.values(workers).forEach((w) => { w.stop().catch(() => {}); }));
// One GPU job at a time across both models; the other model's worker is stopped first so the GPU is free for it.
function gpu(name, payload, onProgress, { exclusive = true } = {}) {
  return gpuQueue.run(async () => {
    // Await release of the previous model's VRAM before starting another allocation.
    if (exclusive) await Promise.all(Object.entries(workers).filter(([other]) => other !== name).map(([, w]) => w.stop()));
    return workers[name].request(payload, onProgress);
  });
}

// RIFE/Real-ESRGAN use the same GPU as Wan/Animagine. Idle Python workers must also release their weights.
export function withGpuLease(task) {
  return gpuQueue.run(async () => {
    await Promise.all(Object.values(workers).map((worker) => worker.stop()));
    return task();
  });
}

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
const animeSizeFor = (size) => {
  const [w, h] = String(size ?? '').split('x').map(Number);
  if (!w || !h) return animeSizes['16:9'];
  return w > h * 1.2 ? animeSizes['16:9'] : h > w * 1.2 ? animeSizes['9:16'] : animeSizes['1:1'];
};
const log = (label) => (step, total) => { if (step === total || step % 10 === 0) console.info(`[local] ${label} step ${step}/${total}`); };

export default {
  id: 'local',
  label: 'Local GPU (open models)',
  keyless: true,
  // Ready when the model is downloaded (a quick file check). The Python check is slow, so it runs with the first job.
  available: () => modelInstalled() || animeModelInstalled() || voiceInstalled('kokoro'),
  unavailableNote: `Download the model first: hf download ${repoId} (34 GB), with Python, PyTorch (CUDA) and diffusers installed.`,
  modelAvailable: (id) => id === 'wan2.2-ti2v-5b' ? modelInstalled() : id === 'animagine-xl-4' ? animeModelInstalled() : id === 'kokoro-82m' ? voiceInstalled('kokoro') : id === 'chatterbox' ? voiceInstalled('chatterbox') : false,
  runtimeStatus: () => {
    const cuda = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { encoding: 'utf8', timeout: 5000 });
    return { gpuAvailable: cuda.status === 0, gpu: cuda.status === 0 ? cuda.stdout.trim() : null, pythonAvailable: cuda.status === 0 ? Boolean(findPython()) : false, note: cuda.status === 0 ? null : 'NVIDIA driver is unavailable; local Wan cannot render in this environment.' };
  },
  models: [
    {
      id: 'wan2.2-ti2v-5b', label: 'Wan 2.2 TI2V 5B · FP8 (your GPU)', operations: ['generate', 'video'],
      sizes: ['1280x704', '704x1280', '960x960'], qualities: [], maxReferences: 1, seed: true,
      durations: [2, 3, 4, 5], aspects: ['16:9', '9:16', '1:1'], resolutions: ['720p'], lastFrame: false,
      note: 'Open weights (Apache 2.0), runs on this computer: free, private, no API. A 5-second clip takes several minutes on a 12 GB GPU.',
    },
    {
      id: 'animagine-xl-4', label: 'Animagine XL 4.0 · anime frames (your GPU)', operations: ['generate'],
      sizes: ['1344x768', '768x1344', '1024x1024'], qualities: [], maxReferences: 0, seed: true,
      note: 'Anime still frames on this computer (SDXL fine-tune, OpenRAIL++): about half a minute each. Use them as start frames for Wan clips. Download: hf download cagliostrolab/animagine-xl-4.0 (7 GB).',
    },
    {
      id: 'kokoro-82m', label: 'Kokoro 82M · voices (this computer)', operations: ['speech'], sizes: [], qualities: [], maxReferences: 0, voices: kokoroVoices,
      note: 'Open-weight voices (Apache 2.0) on the CPU, faster than real time. American, British and Japanese voices.',
    },
    {
      id: 'chatterbox', label: 'Chatterbox · expressive acted voices (your GPU)', operations: ['speech'], sizes: [], qualities: [], maxReferences: 0, voices: kokoroVoices,
      note: 'Open-weight acting voice (MIT): clones the chosen voice and plays the line with emotion; the style text sets how intense (e.g. "furious", "calm"). Adds an inaudible AI watermark.',
    },
  ],
  async validateKey() {
    return { ok: true, verified: true };
  },
  // A still frame: Animagine XL for anime frames, otherwise Wan generating a single frame.
  async run({ prompt, size, seed, model }) {
    const anime = model === 'animagine-xl-4';
    if (anime && !animeModelInstalled()) throw new ProviderError('provider', `Animagine XL 4.0 is not downloaded yet: hf download ${animeRepo} (7 GB).`);
    if (!anime && !modelInstalled()) throw new ProviderError('provider', `Wan 2.2 is not downloaded yet: hf download ${repoId} (34 GB).`);
    const [width, height] = anime ? animeSizeFor(size) : sizeFor(size);
    return inTemp(async (dir) => {
      const out = path.join(dir, 'frame.png');
      if (anime) await gpu('anime', { task: 'image', prompt, width, height, seed: seed ?? 0, steps: 28, out }, log('anime frame'));
      else await gpu('wan', { task: 'image', prompt, width, height, seed: seed ?? 0, steps: 40, out }, log('frame'));
      return { bytes: await readFile(out), usage: { local: true, cost: 0 } };
    });
  },
  // Speech: Kokoro preset voices, or Chatterbox acting the line in that voice. Returns WAV.
  async speak({ model, text, voice, style }) {
    const engine = model === 'chatterbox' ? 'chatterbox' : 'kokoro';
    if (!voiceInstalled(engine)) throw new ProviderError('provider', 'The local voice models are not set up yet (see docs: Local voices).');
    return inTemp(async (dir) => {
      const out = path.join(dir, 'line.wav');
      await gpu('voice', { task: 'speech', engine, text, voice, style, out }, null, { exclusive: engine === 'chatterbox' });
      return { bytes: await readFile(out), usage: { local: true, characters: text.length, cost: 0 } };
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
      if (!modelInstalled()) throw new ProviderError('provider', `Wan 2.2 is not downloaded yet: hf download ${repoId} (34 GB).`);
      await gpu('wan', { task: 'video', prompt, image: imagePath, width, height, frames: seconds * fps + 1, fps, seed: seed ?? 0, steps: 50, out }, log('clip'));
      return { bytes: await readFile(out), usage: { local: true, cost: 0 } };
    });
  },
};
