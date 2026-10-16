import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as local from '../src/localstatus.js';
import { createGpuQueue, stopIdleLuminaWorkers } from '../src/gpu.js';
import { registerRoutes } from '../src/routes/local.js';
import { registerLuminaTools } from '../mcp/tools.js';

const GiB = 1024 ** 3;
const csv = 'RTX 5070, 1024, 12288, 45, 25.5, 250, 12\n';
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lumina-local-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'data'));
  const service = local.createLocalStatus({ dataRoot: root, env: { HOME: root, HF_HOME: path.join(root, 'hf') },
    commandRunner: async (command, args, options) => {
      assert.equal(command, 'nvidia-smi');
      assert.equal(options.timeout, 5000);
      assert.ok(args.every((arg) => !/query-compute|query-account|pmon/.test(arg)), 'must never inspect foreign processes');
      return { stdout: csv };
    }, ram: () => ({ freeBytes: 64 * GiB, totalBytes: 128 * GiB }),
    disk: async () => ({ freeBytes: 100 * GiB, totalBytes: 200 * GiB }), queue: createGpuQueue(), ...overrides });
  return { root, service };
}

test('NVIDIA CSV keeps unsupported values unknown and handles multiple devices', () => {
  const gpus = local.parseNvidiaSmi(csv + 'Other GPU, 0, 8192, [N/A], N/A, Not Supported, 0\n');
  assert.equal(gpus[0].usedBytes, GiB);
  assert.equal(gpus[0].totalBytes, 12 * GiB);
  assert.equal(gpus[0].powerWatts, 25.5);
  assert.equal(gpus[0].utilisationPercent, 12);
  assert.equal(gpus[1].temperatureC, null);
  assert.equal(gpus[1].powerLimitWatts, null);
  assert.deepEqual(local.parseNvidiaSmi('garbage'), []);
});

test('status warns for scarce RAM, disk and hot GPUs without probing runtimes', async (t) => {
  const { service } = await fixture(t, { commandRunner: async () => ({ stdout: csv.replace(', 45,', ', 81,') }),
    ram: () => ({ freeBytes: 3 * GiB, totalBytes: 16 * GiB }), disk: async () => ({ freeBytes: 19 * GiB, totalBytes: 100 * GiB }) });
  const status = await service.status();
  assert.equal(status.warnings.length, 3);
  assert.match(status.warnings.join(' '), /RAM.*disk.*80/s);
  assert.equal(status.workers.available, false);
  assert.ok(status.workers.items.every((worker) => worker.loaded === null));
});

test('missing NVIDIA and disk telemetry stays unknown and preflight cannot say go', async (t) => {
  const { service } = await fixture(t, { commandRunner: async () => { throw Error('not installed'); }, disk: async () => { throw Error('unavailable'); } });
  assert.equal((await service.status()).gpu.available, false);
  const result = await service.preflight('anime-frame');
  assert.equal(result.decision, 'no');
  assert.match(result.reasons.join(' '), /unavailable|unknown/);
});

test('queue snapshots show running and queued jobs with independent ages and cannot mutate queue state', async () => {
  let now = 1000, release;
  const queue = createGpuQueue({ now: () => now });
  const first = queue.run(() => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  now = 2000;
  const second = queue.run(async () => 'done');
  now = 4000;
  const snapshot = queue.snapshot();
  assert.equal(snapshot.running[0].ageMs, 3000);
  assert.equal(snapshot.queued[0].ageMs, 2000);
  snapshot.queued.length = 0;
  assert.equal(queue.snapshot().queued.length, 1);
  release(); await Promise.all([first, second]);
  assert.deepEqual(queue.snapshot(), { running: [], queued: [] });
});

test('free memory skips busy and queued work, stops only idle Lumina workers, and samples VRAM around release', async (t) => {
  const queue = createGpuQueue();
  let release, stopped = 0, foreignStopped = 0;
  const owned = { loaded: true };
  const foreign = { loaded: true, stop: () => { foreignStopped++; } };
  const lease = (task) => queue.run(async () => { owned.loaded = false; stopped++; return task(); });
  const stopIdleWorkers = () => stopIdleLuminaWorkers({ queue, loadLease: async () => lease });
  const { service } = await fixture(t, { queue, stopIdleWorkers, commandRunner: async () => ({ stdout: owned.loaded ? csv : csv.replace('1024,', '0,') }) });
  const busy = queue.run(() => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  assert.equal((await service.freeMemory()).released, false);
  assert.equal(stopped, 0);
  release(); await busy;
  const result = await service.freeMemory();
  assert.equal(result.released, true);
  assert.equal(result.before.gpus[0].usedBytes, GiB);
  assert.equal(result.after.gpus[0].usedBytes, 0);
  assert.equal(owned.loaded, false);
  assert.equal(foreign.loaded, true);
  assert.equal(foreignStopped, 0);
});

test('idle release rechecks after async hook loading and never waits behind a new job', async () => {
  const queue = createGpuQueue();
  let finishLoad, release, invoked = false;
  const unloading = stopIdleLuminaWorkers({ queue, loadLease: () => new Promise((resolve) => { finishLoad = resolve; }) });
  const busy = queue.run(() => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  finishLoad(() => { invoked = true; });
  assert.equal((await unloading).released, false);
  assert.equal(invoked, false);
  release(); await busy;
});

test('preflight distinguishes capacity failures, temporary pressure, heat and queue waits', async (t) => {
  for (const [changes, decision, pattern] of [
    [{}, 'go', /headroom/],
    [{ commandRunner: async () => ({ stdout: csv.replace('12288', '4096') }) }, 'no', /VRAM/],
    [{ commandRunner: async () => ({ stdout: csv.replace('1024,', '10000,') }) }, 'wait', /VRAM/],
    [{ commandRunner: async () => ({ stdout: csv.replace(', 45,', ', 81,') }) }, 'wait', /temperature/],
    [{ ram: () => ({ freeBytes: 1 * GiB, totalBytes: 128 * GiB }) }, 'wait', /RAM/],
    [{ disk: async () => ({ freeBytes: 1 * GiB, totalBytes: 200 * GiB }) }, 'no', /disk/],
  ]) {
    const { service } = await fixture(t, changes);
    const result = await service.preflight('anime-frame');
    assert.equal(result.decision, decision);
    assert.match(result.reasons.join(' '), pattern);
    assert.match(result.advisory, /out-of-memory/);
  }
  const queue = createGpuQueue();
  let release;
  const busy = queue.run(() => new Promise((resolve) => { release = resolve; }));
  const { service } = await fixture(t, { queue });
  assert.equal((await service.preflight('interpolate')).decision, 'wait');
  release(); await busy;
  await assert.rejects(service.preflight('unknown'), /task/);
  await assert.rejects(service.preflight('upscale', { width: -1 }), /width/);
  const normal = await service.preflight('upscale');
  const large = await service.preflight('upscale', { width: 3840, height: 2160, durationSeconds: 120, fps: 60 });
  assert.ok(large.requirements.diskGiB > normal.requirements.diskGiB);
});

async function put(root, name, value = 'weights') {
  const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value); return file;
}
async function snapshot(root, repo, files) {
  const dir = path.join(root, 'hf/hub', `models--${repo.replace('/', '--')}`, 'snapshots', 'test');
  for (const file of files) await put(dir, file);
  return dir;
}

test('model inventory checks complete snapshots, reports partial size and missing models without downloading', async (t) => {
  const { root, service } = await fixture(t);
  await snapshot(root, 'cagliostrolab/animagine-xl-4.0', ['model_index.json', 'unet/diffusion_pytorch_model.safetensors', 'vae/diffusion_pytorch_model.safetensors', 'text_encoder/model.safetensors', 'text_encoder_2/model.safetensors']);
  await snapshot(root, 'h94/IP-Adapter', ['sdxl_models/ip-adapter-plus_sdxl_vit-h.safetensors']);
  await snapshot(root, 'onnx-community/Kokoro-82M-v1.0-ONNX', ['onnx/model.onnx', 'voices/af_heart.bin']);
  await put(root, '.local/share/lumina-studio/voice-env/bin/python');
  await put(root, 'bin/rife/rife-ncnn-vulkan'); await put(root, 'bin/rife/rife-v4.6/flownet.bin');
  await put(root, 'bin/rife/rife-v4.6/flownet.param');
  const models = await service.listModels();
  assert.equal(models.length, 10);
  const by = (id) => models.find((model) => model.id === id);
  assert.equal(by('animagine-xl-4').installed, true);
  assert.equal(by('kokoro-82m').installed, true);
  assert.equal(by('ip-adapter').installed, false);
  assert.ok(by('ip-adapter').sizeBytes > 0);
  assert.equal(by('wan2.2-ti2v-5b').sizeBytes, 0);
  assert.equal(by('rife').installed, true);
  assert.equal(by('musetalk').installed, false);
  assert.ok(models.every((model) => model.purpose && model.licence && model.setup));
});

test('HF symlinks count weight blobs once and Wan installation requires shards', async (t) => {
  const { root, service } = await fixture(t);
  const dir = await snapshot(root, 'Wan-AI/Wan2.2-TI2V-5B-Diffusers', ['model_index.json', 'vae/diffusion_pytorch_model.safetensors']);
  for (const [index, shard] of [['transformer/diffusion_pytorch_model.safetensors.index.json', 't.safetensors'], ['text_encoder/model.safetensors.index.json', 'e.safetensors']]) {
    await put(dir, index, JSON.stringify({ weight_map: { a: shard } })); await put(dir, path.join(path.dirname(index), shard));
  }
  const blob = await put(root, 'hf/hub/models--h94--IP-Adapter/blobs/shared', '1234567890');
  const ip = await snapshot(root, 'h94/IP-Adapter', []);
  await mkdir(ip, { recursive: true });
  await symlink(blob, path.join(ip, 'one')); await symlink(blob, path.join(ip, 'two'));
  let models = await service.listModels();
  assert.equal(models.find((m) => m.id === 'wan2.2-ti2v-5b').installed, true);
  assert.equal(models.find((m) => m.id === 'ip-adapter').sizeBytes, 10);
  await rm(path.join(dir, 'transformer/t.safetensors'));
  models = await service.listModels();
  assert.equal(models.find((m) => m.id === 'wan2.2-ti2v-5b').installed, false);
});

test('MCP tools call the matching local routes and route validation returns 400', async (t) => {
  const { service, root } = await fixture(t);
  const routes = new Map();
  registerRoutes({ route: (method, pattern, handler) => routes.set(`${method} ${pattern}`, handler), readBody: async (req) => req,
    RequestError: class extends Error { constructor(status, message) { super(message); this.status = status; } },
    exportDir: path.join(root, 'exports'), localStatus: service });
  const tools = new Map();
  registerLuminaTools({ server: { _requestHandlers: new Map() }, registerPrompt() {}, registerTool: (name, config, handler) => tools.set(name, { config, handler }) }, {
    call: async (method, route, body) => {
      const handler = routes.get(`${method} ${route}`); assert.ok(handler, route); return handler(body);
    },
  });
  for (const name of ['local_status', 'list_local_models', 'gpu_queue', 'free_gpu_memory', 'preflight']) {
    const tool = tools.get(name); assert.ok(tool, name);
    assert.equal(tool.config.annotations.openWorldHint, false);
    assert.equal(tool.config.annotations.readOnlyHint, name !== 'free_gpu_memory');
    const result = await tool.handler(name === 'preflight' ? { task: 'anime-frame' } : {});
    assert.ok(!result.isError, JSON.stringify(result));
  }
  await assert.rejects(routes.get('POST /api/local/preflight')({ task: 'arbitrary' }), (error) => error.status === 400);
});

test('preflight applies each task budget at the boundary and never pools device VRAM', async (t) => {
  for (const [task, vramGiB, ramGiB, diskGiB] of [
    ['wan-clip', 12, 32, 40], ['anime-frame', 8, 8, 20], ['bake', 12, 24, 30], ['upscale', 4, 8, 20], ['interpolate', 4, 8, 20],
  ]) {
    const telemetry = `GPU, 0, ${vramGiB * 1024}, 80, 25, 250, 0\n`;
    const { service } = await fixture(t, { commandRunner: async () => telemetry,
      ram: () => ({ freeBytes: ramGiB * GiB, totalBytes: ramGiB * GiB }),
      disk: async () => ({ freeBytes: diskGiB * GiB, totalBytes: 200 * GiB }) });
    const result = await service.preflight(task);
    assert.equal(result.decision, 'go', `${task}: ${result.reasons}`);
    assert.equal(result.requirements.vramGiB, vramGiB);
    assert.equal(result.requirements.ramGiB, ramGiB);
    assert.equal(result.requirements.diskGiB, diskGiB);
  }
  const { service } = await fixture(t, { commandRunner: async () => 'Small, 0, 4096, 40, 10, 250, 0\nBig, 0, 24576, 40, 10, 250, 0\n' });
  assert.equal((await service.preflight('anime-frame')).decision, 'no');
});

test('queued work is busy before its callback starts and new work waits for idle shutdown', async () => {
  const queue = createGpuQueue();
  let releaseStop, workStarted = false, leaseCalls = 0;
  const loadLease = async () => (task) => queue.run(async () => { leaseCalls++; await new Promise((resolve) => { releaseStop = resolve; }); return task(); });
  const first = queue.run(async () => {});
  const result = await stopIdleLuminaWorkers({ queue, loadLease });
  assert.equal(result.released, false);
  assert.equal(leaseCalls, 0);
  await first;
  const stopping = stopIdleLuminaWorkers({ queue, loadLease });
  while (!releaseStop) await Promise.resolve();
  const next = queue.run(async () => { workStarted = true; });
  await Promise.resolve();
  assert.equal(workStarted, false);
  releaseStop(); await stopping; await next;
  assert.equal(workStarted, true);
});

test('installed auxiliary models require all files and use an explicit HF cache override', async (t) => {
  const { root } = await fixture(t);
  for (const [repo, files] of [
    ['onnx-community/Kokoro-82M-v1.0-ONNX', ['onnx/model.onnx', 'voices/af_heart.bin']],
    ['ResembleAI/chatterbox', ['ve.safetensors', 't3_cfg.safetensors', 's3gen.safetensors', 'tokenizer.json', 'conds.pt']],
    ['h94/IP-Adapter', ['sdxl_models/ip-adapter-plus_sdxl_vit-h.safetensors', 'models/image_encoder/config.json', 'models/image_encoder/model.safetensors']],
    ['hysts/anime-face-detector-yolov3', ['model.safetensors']], ['hysts/anime-face-detector-hrnetv2', ['model.safetensors']],
    ['TMElyralab/MuseTalk', ['musetalkV15/unet.pth', 'musetalkV15/musetalk.json']],
    ['stabilityai/sd-vae-ft-mse', ['config.json', 'diffusion_pytorch_model.safetensors']],
    ['openai/whisper-tiny', ['config.json', 'pytorch_model.bin']],
  ]) await snapshot(root, repo, files);
  await put(root, 'custom-python'); await put(root, 'custom-cascade.xml');
  for (const file of ['realesrgan-ncnn-vulkan', 'models/realesrgan-x4plus.param', 'models/realesrgan-x4plus.bin', 'models/realesr-animevideov3-x2.param', 'models/realesr-animevideov3-x2.bin']) await put(root, `bin/realesrgan/${file}`);
  for (const file of ['face_detection_yunet_2023mar.onnx', 'face_recognition_sface_2021dec.onnx']) await put(root, `bin/faces/${file}`);
  const service = local.createLocalStatus({ dataRoot: root, env: { HOME: '/unused-home', HF_HOME: '/unused-hf-home', HF_HUB_CACHE: path.join(root, 'hf/hub'),
    LUMINA_VOICE_PYTHON: path.join(root, 'custom-python'), LUMINA_ANIME_FACE: path.join(root, 'custom-cascade.xml') } });
  const models = await service.listModels();
  for (const id of ['chatterbox', 'ip-adapter', 'anime-face-detector', 'musetalk', 'realesrgan', 'face-check']) assert.equal(models.find((m) => m.id === id).installed, true, id);
  await rm(path.join(root, 'bin/realesrgan/models/realesrgan-x4plus.bin'));
  assert.equal((await service.listModels()).find((m) => m.id === 'realesrgan').installed, false);
  const fallback = local.createLocalStatus({ dataRoot: root, env: { HOME: root } });
  assert.equal((await fallback.listModels()).find((m) => m.id === 'ip-adapter').installed, false);
  await mkdir(path.join(root, '.cache/huggingface'), { recursive: true });
  await symlink(path.join(root, 'hf/hub'), path.join(root, '.cache/huggingface/hub'));
  assert.equal((await fallback.listModels()).find((m) => m.id === 'ip-adapter').installed, true);
});

test('failed idle worker shutdown is reported alongside a fresh VRAM sample', async (t) => {
  const { service } = await fixture(t, { stopIdleWorkers: async () => { throw Error('worker did not exit'); } });
  const result = await service.freeMemory();
  assert.equal(result.released, false);
  assert.match(result.reason, /did not exit/);
  assert.equal(result.after.gpus[0].totalBytes, 12 * GiB);
});

test('preflight over HTTP returns 200 with its report (no top-level status key)', async () => {
  const { startTestApp } = await import('./helpers.js');
  const app = await startTestApp();
  try {
    const r = await app.call('POST', '/api/local/preflight', { task: 'anime-frame' });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.ok(['go', 'wait', 'no'].includes(r.body.decision));
    assert.equal(r.body.status, undefined);
  } finally { await app.close(); }
});
