import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { modelInstalled, animeModelInstalled } from './providers/local.js';
import { faceModels } from './faces.js';
import { gpuQueue, stopIdleLuminaWorkers } from './gpu.js';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const exec = promisify(execFile);
const workerNames = ['wan', 'anime', 'voice', 'lipsync', 'train'];
const advisory = 'Advisory snapshot only: a go decision cannot prevent every out-of-memory error. Runtime dependencies and model installation must also be checked.';

// Headroom, in GiB, for Lumina's usual 720p Wan / ~1 MP anime work and PNG finishing up to 1080p.
// The disk floor includes temporary frames. Larger finishing requests increase it below.
export const preflightThresholds = Object.freeze({
  'wan-clip': Object.freeze({ vramGiB: 12, ramGiB: 32, diskGiB: 40, maxTemperatureC: 80 }),
  'anime-frame': Object.freeze({ vramGiB: 8, ramGiB: 8, diskGiB: 20, maxTemperatureC: 80 }),
  bake: Object.freeze({ vramGiB: 12, ramGiB: 24, diskGiB: 30, maxTemperatureC: 80 }),
  upscale: Object.freeze({ vramGiB: 4, ramGiB: 8, diskGiB: 20, maxTemperatureC: 80 }),
  interpolate: Object.freeze({ vramGiB: 4, ramGiB: 8, diskGiB: 20, maxTemperatureC: 80 }),
});

// csv,noheader,nounits: device totals only, never --query-compute-apps or a process listing.
export function parseNvidiaSmi(stdout) {
  const number = (value) => /^\d+(?:\.\d+)?$/.test(value ?? '') && Number.isFinite(Number(value)) ? Number(value) : null;
  return String(stdout).trim().split(/\r?\n/).flatMap((line, index) => {
    const cells = line.split(',').map((cell) => cell.trim());
    if (cells.length !== 7 || !cells[0]) return [];
    const [used, total, temperatureC, powerWatts, powerLimitWatts, utilisationPercent] = cells.slice(1).map(number);
    return [{ index, name: cells[0], usedBytes: used === null ? null : used * MiB,
      totalBytes: total === null ? null : total * MiB, temperatureC, powerWatts, powerLimitWatts, utilisationPercent }];
  });
}

const present = async (file) => { try { return (await stat(file)).isFile(); } catch { return false; } };
async function complete(root, files) { return (await Promise.all(files.map((file) => present(path.join(root, file))))).every(Boolean); }
async function snapshotHas(hub, repo, files) {
  const dir = path.join(hub, `models--${repo.replace('/', '--')}`, 'snapshots');
  try { return (await Promise.all((await readdir(dir)).map((entry) => complete(path.join(dir, entry), files)))).some(Boolean); }
  catch { return false; }
}

// Follow HF snapshot symlinks but count each physical blob only once, including hard links and multiple snapshots.
async function diskSize(roots) {
  const seen = new Set();
  let bytes = 0, available = true;
  async function visit(file) {
    try {
      const info = await stat(file);
      const key = `${info.dev}:${info.ino}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (info.isDirectory()) {
        for (const name of await readdir(file)) await visit(path.join(file, name));
      } else if (info.isFile()) bytes += info.size;
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') available = false; }
  }
  for (const root of roots) await visit(root);
  return { sizeBytes: bytes, sizeAvailable: available };
}

async function defaultDisk(dir) {
  const info = await statfs(dir, { bigint: true });
  return { freeBytes: Number(info.bavail * info.bsize), totalBytes: Number(info.blocks * info.bsize) };
}
const defaultRam = () => ({ freeBytes: os.freemem(), totalBytes: os.totalmem() });
const shellQuote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const invalid = (message) => Object.assign(new Error(message), { status: 400 });

export function createLocalStatus({ dataRoot, env = process.env, commandRunner = exec,
  ram = defaultRam, disk = defaultDisk, queue = gpuQueue, stopIdleWorkers = stopIdleLuminaWorkers } = {}) {
  if (!dataRoot) throw new Error('A Lumina dataRoot is required.');
  const home = env.HOME || os.homedir();
  const hub = env.HF_HUB_CACHE || path.join(env.HF_HOME || path.join(home, '.cache', 'huggingface'), 'hub');
  const share = path.join(home, '.local', 'share', 'lumina-studio');
  const bin = path.join(dataRoot, 'bin');
  const voicePython = env.LUMINA_VOICE_PYTHON || path.join(share, 'voice-env', 'bin', 'python');
  const cascade = env.LUMINA_ANIME_FACE || path.join(share, 'anime-face', 'lbpcascade_animeface.xml');
  const hfRoot = (repo) => path.join(hub, `models--${repo.replace('/', '--')}`);
  const has = (repo, files) => snapshotHas(hub, repo, files);
  async function gpu() {
    try {
      const result = await commandRunner('nvidia-smi', [
        '--query-gpu=name,memory.used,memory.total,temperature.gpu,power.draw,power.limit,utilization.gpu',
        '--format=csv,noheader,nounits',
      ], { timeout: 5000, maxBuffer: 64 * 1024, encoding: 'utf8' });
      const gpus = parseNvidiaSmi(typeof result === 'string' ? result : result.stdout);
      return { available: gpus.length > 0, gpus, note: gpus.length ? null : 'NVIDIA GPU telemetry unavailable or malformed.' };
    } catch { return { available: false, gpus: [], note: 'NVIDIA GPU telemetry unavailable (nvidia-smi failed or exceeded 5 seconds).' }; }
  }
  async function status() {
    const [gpuStatus, memory, storage] = await Promise.all([gpu(), Promise.resolve().then(ram).catch(() => ({ freeBytes: null, totalBytes: null })),
      Promise.resolve().then(() => disk(path.join(dataRoot, 'data'))).catch(() => ({ freeBytes: null, totalBytes: null }))]);
    const warnings = [];
    if (memory.freeBytes !== null && memory.freeBytes < 4 * GiB) warnings.push('Free RAM is below 4 GiB.');
    if (storage.freeBytes !== null && storage.freeBytes < 20 * GiB) warnings.push('Free disk space is below 20 GiB.');
    for (const device of gpuStatus.gpus) if (device.temperatureC > 80) warnings.push(`GPU ${device.index} temperature exceeds 80 C.`);
    return { gpu: gpuStatus, ram: memory, disk: { ...storage, path: path.join(dataRoot, 'data') }, queue: queue.snapshot(),
      workers: { available: false, items: workerNames.map((name) => ({ name, loaded: null })),
        note: 'Loaded-worker state is private to the local provider; unknown, not unloaded. No processes were enumerated.' }, warnings };
  }
  async function freeMemory() {
    const before = await gpu();
    let result;
    try { result = await stopIdleWorkers(); }
    catch (error) { result = { released: false, reason: `Lumina worker shutdown failed: ${error.message}` }; }
    const after = await gpu();
    return { ...result, before, after, note: 'VRAM totals include all applications; no other application is inspected or stopped. Driver accounting may lag worker exit.' };
  }

  async function listModels() {
    const voiceReady = await present(voicePython);
    const kokoro = 'onnx-community/Kokoro-82M-v1.0-ONNX';
    const chatterbox = 'ResembleAI/chatterbox';
    const trackerRepos = ['hysts/anime-face-detector-yolov3', 'hysts/anime-face-detector-hrnetv2'];
    const cascadeReady = await present(cascade);
    const trackerReady = (await Promise.all(trackerRepos.map((repo) => has(repo, ['model.safetensors'])))).every(Boolean);
    const specs = [
      { id: 'wan2.2-ti2v-5b', name: 'Wan 2.2 TI2V 5B', purpose: '720p text/image-to-video and still frames on NVIDIA CUDA.', licence: 'Apache-2.0',
        roots: [hfRoot('Wan-AI/Wan2.2-TI2V-5B-Diffusers')], installed: () => modelInstalled(hub), setup: 'hf download Wan-AI/Wan2.2-TI2V-5B-Diffusers' },
      { id: 'animagine-xl-4', name: 'Animagine XL 4.0', purpose: 'Anime frames and base model for character LoRA baking.', licence: 'OpenRAIL++',
        roots: [hfRoot('cagliostrolab/animagine-xl-4.0')], installed: () => animeModelInstalled(hub), setup: 'bash scripts/setup-voices.sh && bash scripts/setup-anime.sh' },
      { id: 'ip-adapter', name: 'IP-Adapter Plus SDXL', purpose: 'Steer anime frames and bake pictures with character reference images.', licence: 'Apache-2.0',
        roots: [hfRoot('h94/IP-Adapter')], installed: () => has('h94/IP-Adapter', ['sdxl_models/ip-adapter-plus_sdxl_vit-h.safetensors', 'models/image_encoder/config.json', 'models/image_encoder/model.safetensors']), setup: 'bash scripts/setup-anime.sh' },
      { id: 'kokoro-82m', name: 'Kokoro 82M', purpose: 'Local English preset voices on CPU.', licence: 'Apache-2.0', roots: [hfRoot(kokoro)],
        installed: async () => voiceReady && await has(kokoro, ['onnx/model.onnx', 'voices/af_heart.bin']), setup: 'bash scripts/setup-voices.sh', runtimePresent: voiceReady },
      { id: 'chatterbox', name: 'Chatterbox', purpose: 'Expressive speech and voice cloning on NVIDIA GPU; uses Kokoro presets.', licence: 'MIT', roots: [hfRoot(chatterbox)],
        installed: async () => voiceReady && await has(chatterbox, ['ve.safetensors', 't3_cfg.safetensors', 's3gen.safetensors', 'tokenizer.json', 'conds.pt']) && await has(kokoro, ['onnx/model.onnx']), setup: 'bash scripts/setup-voices.sh', runtimePresent: voiceReady },
      { id: 'anime-face-detector', name: 'Anime face detector', purpose: 'Anime face landmarks for mouth tracking; legacy cascade for mouth finding and MuseTalk.', licence: 'MIT (tracker and legacy cascade)',
        roots: [...trackerRepos.map(hfRoot), cascade], installed: () => voiceReady && trackerReady,
        setup: 'bash scripts/setup-voices.sh && bash scripts/setup-anime.sh', runtimePresent: voiceReady,
        legacyCascadeInstalled: cascadeReady, note: 'setup-anime.sh installs the landmark tracker, not the legacy cascade. The provider lip-sync readiness check still requires the cascade.',
        legacyCascadeSetup: `mkdir -p ${shellQuote(path.dirname(cascade))} && curl -fL https://raw.githubusercontent.com/nagadomi/lbpcascade_animeface/master/lbpcascade_animeface.xml -o ${shellQuote(cascade)}` },
      { id: 'realesrgan', name: 'Real-ESRGAN', purpose: 'AI upscaling for live action and anime (NCNN/Vulkan).', licence: 'BSD-3-Clause', roots: [path.join(bin, 'realesrgan')],
        installed: () => complete(path.join(bin, 'realesrgan'), ['realesrgan-ncnn-vulkan', 'models/realesrgan-x4plus.param', 'models/realesrgan-x4plus.bin', 'models/realesr-animevideov3-x2.param', 'models/realesr-animevideov3-x2.bin']),
        setup: "POST /api/enhancer/install with JSON {\"tool\":\"ai\"} (or Storyboard → Picture quality → AI upscale)", note: 'Checks Lumina bin directory only; a separately installed executable on PATH may also be usable.' },
      { id: 'rife', name: 'RIFE v4.6', purpose: 'Frame interpolation (NCNN/Vulkan).', licence: 'MIT', roots: [path.join(bin, 'rife')],
        installed: () => complete(path.join(bin, 'rife'), ['rife-ncnn-vulkan', 'rife-v4.6/flownet.bin', 'rife-v4.6/flownet.param']), setup: 'POST /api/enhancer/install with JSON {"tool":"rife"} (or Storyboard → Picture quality → Smooth)' },
      { id: 'face-check', name: 'Face check (YuNet + SFace)', purpose: 'Human face detection and identity comparison on CPU; not an anime identity check.', licence: 'YuNet: MIT; SFace: Apache-2.0', roots: [path.join(bin, 'faces')],
        installed: () => complete(path.join(bin, 'faces'), Object.values(faceModels).map((model) => model.file)), setup: 'POST /api/faces/install (or install the face check in Lumina)' },
      { id: 'musetalk', name: 'MuseTalk 1.5', purpose: 'Live action lip sync; also needs SD VAE, Whisper-tiny, voice runtime and legacy cascade.', licence: 'MuseTalk: MIT; SD VAE: CreativeML Open RAIL-M; Whisper: Apache-2.0',
        roots: ['TMElyralab/MuseTalk', 'stabilityai/sd-vae-ft-mse', 'openai/whisper-tiny'].map(hfRoot),
        installed: async () => voiceReady && cascadeReady && await has('TMElyralab/MuseTalk', ['musetalkV15/unet.pth', 'musetalkV15/musetalk.json']) && await has('stabilityai/sd-vae-ft-mse', ['config.json', 'diffusion_pytorch_model.safetensors']) && await has('openai/whisper-tiny', ['config.json', 'pytorch_model.bin']),
        setup: 'bash scripts/setup-voices.sh && hf download TMElyralab/MuseTalk musetalkV15/unet.pth musetalkV15/musetalk.json && hf download stabilityai/sd-vae-ft-mse config.json diffusion_pytorch_model.safetensors && hf download openai/whisper-tiny config.json pytorch_model.bin',
        note: 'Also run the anime face detector legacyCascadeSetup command for the cascade; no dedicated MuseTalk setup script exists.' },
    ];
    return Promise.all(specs.map(async ({ roots, installed, ...spec }) => {
      let ready = false;
      try { ready = Boolean(await installed()); } catch { /* unreadable or partial cache is not installed */ }
      return { ...spec, installed: ready, ...await diskSize(roots) };
    }));
  }

  async function preflight(task, options = {}) {
    if (!Object.hasOwn(preflightThresholds, task)) throw invalid('Unknown preflight task. Choose wan-clip, anime-frame, bake, upscale or interpolate.');
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw invalid('options must be an object.');
    const limits = { width: [1, 16384], height: [1, 16384], durationSeconds: [0.01, 86400], fps: [1, 240] };
    for (const [key, value] of Object.entries(options)) {
      if (!Object.hasOwn(limits, key)) throw invalid(`Unknown preflight option: ${key}.`);
      const [min, max] = limits[key];
      if (!Number.isFinite(value) || value < min || value > max || (['width', 'height'].includes(key) && !Number.isInteger(value))) throw invalid(`${key} must be between ${min} and ${max}${['width', 'height'].includes(key) ? ' (whole pixels)' : ''}.`);
    }
    const requirements = { ...preflightThresholds[task] };
    const width = options.width ?? (task === 'wan-clip' ? 1280 : ['anime-frame', 'bake'].includes(task) ? 1344 : 1920);
    const height = options.height ?? (task === 'wan-clip' ? 704 : ['anime-frame', 'bake'].includes(task) ? 768 : 1080);
    const pixels = width * height;
    // For larger images, scale the VRAM budget rather than claiming the baseline covers any resolution.
    requirements.vramGiB *= Math.max(1, pixels / (task === 'anime-frame' || task === 'bake' ? 1344 * 768 : task === 'wan-clip' ? 1280 * 704 : 1920 * 1080));
    if (task === 'upscale' || task === 'interpolate') {
      const frames = (options.durationSeconds ?? 5) * (options.fps ?? 30);
      requirements.diskGiB = Math.max(requirements.diskGiB, Math.ceil(pixels * 3 * frames * 3 / GiB) + 2);
    }
    const current = await status();
    const reasons = [];
    let decision = 'go';
    const no = (reason) => { decision = 'no'; reasons.push(reason); };
    const wait = (reason) => { if (decision !== 'no') decision = 'wait'; reasons.push(reason); };
    // Lumina currently uses the default device; never add VRAM from different devices together.
    const device = current.gpu.gpus[0];
    if (!device || device.totalBytes === null || device.usedBytes === null) no('NVIDIA VRAM telemetry unavailable or unknown.');
    else if (device.totalBytes < requirements.vramGiB * GiB) no(`GPU VRAM capacity is below ${requirements.vramGiB.toFixed(1)} GiB.`);
    else if (device.totalBytes - device.usedBytes < requirements.vramGiB * GiB) wait(`Free GPU VRAM is below ${requirements.vramGiB.toFixed(1)} GiB; finish work or free idle Lumina workers.`);
    if (!device || device.temperatureC === null) no('GPU temperature is unavailable or unknown.');
    else if (device.temperatureC > requirements.maxTemperatureC) wait('GPU temperature exceeds 80 C; let it cool.');
    if (current.ram.freeBytes === null || current.ram.totalBytes === null) no('RAM telemetry unavailable.');
    else if (current.ram.totalBytes < requirements.ramGiB * GiB) no(`RAM capacity is below ${requirements.ramGiB} GiB.`);
    else if (current.ram.freeBytes < requirements.ramGiB * GiB) wait(`Free RAM is below ${requirements.ramGiB} GiB.`);
    if (current.disk.freeBytes === null) no('Free disk space is unavailable.');
    else if (current.disk.freeBytes < requirements.diskGiB * GiB) no(`Free disk space is below ${requirements.diskGiB} GiB.`);
    if (current.queue.running.length || current.queue.queued.length) wait('Lumina GPU work is running or queued.');
    if (!reasons.length) reasons.push('Measured resource headroom meets the conservative thresholds.');
    return { task, options, decision, reasons, requirements, advisory, snapshot: current }; // not `status`: the router reads a top-level status as the HTTP code
  }
  return { status, listModels, freeMemory, queue: () => queue.snapshot(), preflight };
}
