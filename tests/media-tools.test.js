import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { startTestApp, tempRoot, tinyPng } from './helpers.js';
import { encodePng } from '../src/png.js';
import { imageSize } from '../src/assets.js';
import { createMediaService, boxMask } from '../src/media.js';
import { createEnhancer } from '../src/enhance.js';
import { register } from '../mcp/tools-media.js';
import { z } from 'zod';
import { callLumina } from '../mcp/tools.js';

const parse = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text);
function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-v', 'error', ...args], { maxBuffer: 16 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr?.toString());
  return r.stdout;
}
function handlers(client) {
  const out = {};
  register({ client, z, path, tool: (name, config, handler) => { out[name] = (args) => handler(z.object(config.inputSchema).parse(args)); },
    text: (value) => ({ type: 'text', text: JSON.stringify(value) }), ok: (...content) => ({ content }), safe: (fn) => fn,
    pickModel: async (op, provider, model) => ({ provider: provider ?? 'mock', model: model ?? (op === 'video' ? 'mock-video' : op === 'generate' || op === 'edit' ? 'mock-image' : 'mock-tools') }),
    summarizeGeneration: (g) => g, imageContent: async () => [],
  });
  return out;
}
const apiClient = (app) => ({ call: (method, route, body) => callLumina({ origin: app.origin, token: app.token, method, route, body }) });
async function upload(t, projectId, bytes) {
  const r = await fetch(`${t.app.origin}/api/projects/${projectId}/media/upload`, { method: 'POST', headers: { authorization: `Bearer ${t.app.token}` }, body: bytes });
  assert.equal(r.status, 201, await r.clone().text());
  return (await r.json()).asset;
}

test('box masks rasterize the selected fractional area white, keep the rest black and reject overflow', () => {
  const bytes = boxMask(8, 4, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  assert.deepEqual(imageSize(bytes), { width: 8, height: 4 });
  const chunks = [];
  for (let p = 8; p < bytes.length;) { const n = bytes.readUInt32BE(p); if (bytes.toString('ascii', p + 4, p + 8) === 'IDAT') chunks.push(bytes.subarray(p + 8, p + 8 + n)); p += n + 12; }
  const pixels = inflateSync(Buffer.concat(chunks));
  assert.equal(pixels[1], 0);
  assert.equal(pixels[25 + 1 + 2 * 3], 255);
  assert.equal(pixels[25 + 1 + 6 * 3], 0);
  assert.throws(() => boxMask(8, 4, { x: 0.8, y: 0, w: 0.5, h: 1 }), /box/i);
});

test('URL imports enforce public HTTPS on every hop, sniff bytes and stop oversized streams', async () => {
  const saved = [];
  let requests = 0;
  const media = createMediaService({ assetStore: { save: async (a) => { saved.push(a); return { id: 'saved', ...a }; } },
    lookupImpl: async (host) => [{ address: host === 'internal.example' ? '10.0.0.4' : '93.184.216.34' }],
    fetchImpl: async (url) => {
      requests++;
      if (url.endsWith('/redirect')) return new Response(null, { status: 302, headers: { location: 'https://internal.example/secret' } });
      if (url.endsWith('/huge')) { let first = true; return new Response(new ReadableStream({ pull(c) { c.enqueue(first ? tinyPng() : Buffer.alloc(1024 * 1024)); first = false; } })); }
      if (url.endsWith('/audio')) return new Response(ffmpeg(['-f', 'lavfi', '-i', 'sine=d=0.1', '-f', 'wav', '-']));
      if (url.endsWith('/html')) return new Response('<html>not media</html>', { headers: { 'content-type': 'image/png' } });
      return new Response(tinyPng(), { headers: { 'content-type': 'video/mp4' } });
    } });
  for (const url of ['http://files.example/p.png', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://[::ffff:7f00:1]/x', 'https://internal.example/x']) await assert.rejects(media.importUrl('p', url), /https|private|public/i);
  assert.equal(requests, 0);
  await assert.rejects(media.importUrl('p', 'https://files.example/redirect'), /private|public/i);
  await assert.rejects(media.importUrl('p', 'https://files.example/huge'), /large|limit/i);
  await assert.rejects(media.importUrl('p', 'https://files.example/html'), /supported|media/i);
  await media.importUrl('p', 'https://files.example/not-an-image.mp4', 'Photo');
  assert.equal(saved[0].kind, 'reference');
  assert.equal(saved[0].label, 'Photo');
  assert.equal(saved[0].projectId, 'p');
  await media.importUrl('p', 'https://files.example/audio');
  assert.equal(saved[1].kind, 'audio');
});

test('image and video reframing produces crop/pad dimensions and retains the source as parent', async () => {
  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Media' })).body.project;
    const image = await upload(t, project.id, encodePng(160, 90, (x) => x < 80 ? [255, 0, 0] : [0, 0, 255]));
    const clip = path.join(t.dataRoot, 'clip.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'color=red:s=160x90:r=10:d=0.4', '-c:v', 'libx264', '-y', clip]);
    const video = await upload(t, project.id, await readFile(clip));
    for (const asset of [image, video]) {
      for (const [mode, width, height] of [['crop', 90, 90], ['pad', 160, 160]]) {
        const r = await t.call('POST', `/api/assets/${asset.id}/reframe`, { mode, aspect: '1:1', focusX: 1, focusY: 0.5 });
        assert.equal(r.status, 201, r.text);
        assert.deepEqual([r.body.width, r.body.height], [width, height]);
        assert.equal(r.body.asset.parentAssetId, asset.id);
        const output = path.join(t.dataRoot, 'storage', 'assets', r.body.asset.file);
        const probe = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output], { encoding: 'utf8' }).stdout);
        assert.deepEqual([probe.streams[0].width, probe.streams[0].height], [width, height]);
      }
    }
    assert.equal((await t.call('POST', `/api/assets/${image.id}/reframe`, { mode: 'crop', aspect: 'wrong' })).status, 400);
    assert.equal((await t.call('POST', `/api/assets/${image.id}/reframe`, { mode: 'crop', aspect: '1:1', focusX: 2 })).status, 400);
  } finally { await t.close(); }
});

test('inpaint and extension preparation make masks and keep new canvases in the same project', async () => {
  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Masks' })).body.project;
    const image = await upload(t, project.id, encodePng(80, 40, () => [255, 0, 0]));
    const mask = await t.call('POST', `/api/assets/${image.id}/media-mask`, { mask: { x: 0, y: 0, w: 0.5, h: 1 } });
    assert.equal(mask.status, 201, mask.text);
    const extension = await t.call('POST', `/api/assets/${image.id}/extend`, { padding: { left: 10, right: 20, top: 5, bottom: 15 } });
    assert.equal(extension.status, 201, extension.text);
    assert.deepEqual([extension.body.width, extension.body.height], [110, 60]);
    const generation = await t.call('POST', '/api/generate', { projectId: project.id, operation: 'inpaint', provider: 'mock', model: 'mock-tools', prompt: 'extend the beach', inputAssetIds: [extension.body.inputAssetId], maskAssetId: extension.body.maskAssetId });
    assert.equal(generation.status, 202, generation.text);
    const done = await t.call('POST', `/api/generations/${generation.body.generation.id}/wait`, { timeoutMs: 10000 });
    assert.equal(done.body.generation.status, 'completed');
  } finally { await t.close(); }
});

test('image and video batches return N distinct job ids without waiting', async () => {
  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Batch' })).body.project;
    const tools = handlers(apiClient(t.app));
    for (const name of ['generate_image_batch', 'generate_video_batch']) {
      const result = parse(await tools[name]({ projectId: project.id, prompts: ['one', 'two', 'three'], provider: 'mock', model: name.includes('image') ? 'mock-image' : 'mock-video', seed: 17 }));
      assert.equal(result.jobIds.length, 3);
      assert.equal(new Set(result.jobIds).size, 3);
      for (const id of result.jobIds) assert.ok(t.app.repo.generations.get(id));
    }
  } finally { await t.close(); }
});

test('batch stops on 402 and reports already queued jobs without another submission', async () => {
  let submissions = 0;
  const tools = handlers({ call: async () => { if (++submissions === 2) throw Object.assign(new Error('Budget refuses'), { status: 402, data: { approvalId: 'approval' } }); return { generation: { id: 'first', status: 'queued' } }; } });
  const r = await tools.generate_image_batch({ projectId: 'p', prompts: ['one', 'two', 'three'], provider: 'mock', model: 'mock-image' });
  assert.equal(r.isError, true);
  assert.equal(parse(r).status, 402);
  assert.deepEqual(parse(r).jobIds, ['first']);
  assert.equal(submissions, 2);
});

test('video analysis detects a cut, freeze, black segment and loudness, and returns four inline samples', async () => {
  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Analysis' })).body.project;
    const file = path.join(t.dataRoot, 'analysis.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'color=white:s=160x90:r=10:d=1.5', '-f', 'lavfi', '-i', 'color=black:s=160x90:r=10:d=1.5', '-f', 'lavfi', '-i', 'sine=f=440:d=3', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-c:a', 'aac', '-y', file]);
    const asset = await upload(t, project.id, await readFile(file));
    const tools = handlers(apiClient(t.app));
    const r = await tools.analyze_video({ assetId: asset.id });
    const info = parse(r);
    assert.ok(info.sceneCuts.some((c) => Math.abs(c.time - 1.5) < 0.2), JSON.stringify(info.sceneCuts));
    assert.ok(info.freezes.some((f) => f.duration >= 1));
    assert.ok(info.black.some((b) => b.duration >= 1));
    assert.ok(Number.isFinite(info.loudness.integratedLufs));
    assert.ok(Number.isFinite(info.loudness.truePeakDbfs));
    assert.deepEqual([info.width, info.height, info.fps], [160, 90, 10]);
    assert.equal(r.content.filter((c) => c.type === 'image').length, 4);
  } finally { await t.close(); }
});

test('local image upscaling builds anime and photo commands using a fake binary, with exact 2x/4x output', async () => {
  const dir = tempRoot();
  try {
    const bin = path.join(dir, 'bin', 'realesrgan');
    await mkdir(path.join(bin, 'models'), { recursive: true });
    for (const name of ['realesrgan-x4plus.param', 'realesr-animevideov3-x2.param']) await writeFile(path.join(bin, 'models', name), 'fake');
    const binary = path.join(bin, 'realesrgan-ncnn-vulkan');
    // This fake never accesses a GPU: it records argv and lets CPU ffmpeg produce a 4x PNG.
    await writeFile(binary, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nconst a=process.argv.slice(2); if(a.includes('-h')) process.exit(0);\nwriteFileSync(${JSON.stringify(path.join(dir, 'argv.json'))},JSON.stringify(a));\nconst r=spawnSync('ffmpeg',['-v','error','-i',a[a.indexOf('-i')+1],'-vf','scale=16:16','-threads','1','-y',a[a.indexOf('-o')+1]]); process.exit(r.status);\n`, { mode: 0o755 });
    const source = path.join(dir, 'input.png'); await writeFile(source, tinyPng());
    const enhancer = createEnhancer({ binDir: path.join(dir, 'bin'), workDir: dir, log: {} });
    for (const [engine, scale, network] of [['local-anime', 2, 'realesr-animevideov3'], ['local-photo', 2, 'realesrgan-x4plus'], ['local-photo', 4, 'realesrgan-x4plus']]) {
      const result = await enhancer.upscaleImage(source, { engine, scale, preparedTool: { binary, models: path.join(bin, 'models') } });
      assert.deepEqual(imageSize(result.bytes), { width: 4 * scale, height: 4 * scale });
      const argv = JSON.parse(await readFile(path.join(dir, 'argv.json'), 'utf8'));
      assert.equal(argv[argv.indexOf('-n') + 1], network);
      assert.equal(argv[argv.indexOf('-s') + 1], engine === 'local-photo' ? '4' : '2');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('prepared masks and outpaint canvases stay stable across approval retries', async () => {
  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Retry' })).body.project;
    const image = await upload(t, project.id, tinyPng());
    for (const [route, body] of [['media-mask', { mask: { x: 0, y: 0, w: 0.5, h: 1 } }], ['extend', { padding: { left: 4 } }]]) {
      const first = await t.call('POST', `/api/assets/${image.id}/${route}`, body);
      const second = await t.call('POST', `/api/assets/${image.id}/${route}`, body);
      assert.equal(first.status, 201, first.text);
      assert.deepEqual(second.body, first.body, 'Stable input ids keep spending approval signatures unchanged');
    }
  } finally { await t.close(); }
});

test('local file import sniffs mislabeled files and remote connections cannot read files', async () => {
  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Upload' })).body.project;
    const filePath = path.join(t.dataRoot, 'photo.mp4'); await writeFile(filePath, tinyPng());
    const tools = handlers({ ...apiClient(t.app), upload: async (route, bytes, label) => {
      const r = await fetch(`${t.app.origin}${route}`, { method: 'POST', headers: { authorization: `Bearer ${t.app.token}`, 'x-lumina-label': label }, body: bytes });
      assert.equal(r.status, 201); return r.json();
    } });
    const saved = parse(await tools.import_media_file({ projectId: project.id, filePath, label: 'Imported photo' }));
    assert.equal(saved.mimeType, 'image/png');
    assert.equal(saved.label, 'Imported photo');
    assert.equal(t.app.repo.assets.get(saved.assetId).kind, 'reference');
    const remote = handlers(apiClient(t.app));
    await assert.rejects(remote.import_media_file({ projectId: project.id, filePath: '/file/that/does/not/exist' }), /local connection/i);
  } finally { await t.close(); }
});

test('batch obeys the real budget and keeps the first submitted job on refusal', async () => {
  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Limited' })).body.project;
    await t.call('PUT', '/api/budget', { enabled: true, totalUsd: 0.05, retryReserveUsd: 0, approvalAboveUsd: 1, perRequestUsd: 1 });
    const tools = handlers(apiClient(t.app));
    const result = await tools.generate_video_batch({ projectId: project.id, prompts: ['one', 'two', 'three'], provider: 'mock', model: 'mock-video', duration: 4 });
    assert.equal(result.isError, true);
    assert.equal(parse(result).status, 402);
    assert.equal(parse(result).jobIds.length, 1);
    assert.equal(t.app.repo.generations.listByProject(project.id).length, 1);
  } finally { await t.close(); }
});

test('paid image tools use fal through the generation API and preserve refusal details', async () => {
  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Paid route checks' })).body.project;
    const image = await upload(t, project.id, encodePng(80, 40, () => [200, 40, 40]));
    const calls = [];
    const api = apiClient(t.app);
    const tools = handlers({ call: async (method, route, body) => {
      if (route !== '/api/generate') return api.call(method, route, body);
      calls.push({ method, body });
      throw Object.assign(new Error('Budget approval required'), { status: 402, data: { approvalId: 'pending' } });
    } });
    for (const [name, args, operation, model] of [
      ['upscale_image', { scale: 2, engine: 'fal' }, 'upscale', 'fal-ai/esrgan'],
      ['remove_background', {}, 'remove-background', 'fal-ai/birefnet/v2'],
      ['inpaint_image', { prompt: 'a boat', mask: { x: 0, y: 0, w: 0.5, h: 1 } }, 'inpaint', 'fal-ai/flux-pro/v1/fill'],
      ['outpaint_image', { prompt: 'the sea', direction: 'left' }, 'inpaint', 'fal-ai/flux-pro/v1/fill'],
      ['reframe', { aspect: '1:1', mode: 'outpaint' }, 'inpaint', 'fal-ai/flux-pro/v1/fill'],
    ]) {
      await assert.rejects(tools[name]({ assetId: image.id, ...args }), (e) => e.status === 402 && e.data.approvalId === 'pending');
      const { method, body } = calls.at(-1);
      assert.equal(method, 'POST');
      assert.equal(body.provider, 'fal'); assert.equal(body.model, model); assert.equal(body.operation, operation);
      assert.equal(body.projectId, project.id);
      if (operation === 'inpaint') assert.ok(t.app.repo.assets.get(body.maskAssetId));
    }
    await assert.rejects(tools.outpaint_image({ assetId: image.id, direction: 'left' }), (e) => e.status === 402);
    assert.equal(calls.at(-1).body.inputAssetIds[0], calls[3].body.inputAssetIds[0], 'A retry reuses the working canvas');
  } finally { await t.close(); }
});

test('upscale video starts the existing pipeline once and uses a bounded wait handle', async () => {
  const calls = [];
  const tools = handlers({ call: async (method, route, body) => {
    calls.push({ method, route, body });
    return route.endsWith('/wait') ? { sourceAssetId: 'video', enhance: { state: 'running' }, statusUrl: '/status' } : { enhance: { state: 'running' } };
  } });
  const r = parse(await tools.upscale_video({ assetId: 'video', height: 1440, engine: 'ai', waitSeconds: 0 }));
  assert.equal(r.sourceAssetId, 'video'); assert.equal(r.enhance.state, 'running');
  assert.deepEqual(calls[0], { method: 'POST', route: '/api/assets/video/enhance', body: { mode: 'ai', height: 1440 } });
  assert.deepEqual(calls[1].body, { waitSeconds: 0 });
  await tools.upscale_video({ assetId: 'video', checkOnly: true, waitSeconds: 0 });
  assert.equal(calls.filter((c) => c.route.endsWith('/enhance')).length, 1);
});
