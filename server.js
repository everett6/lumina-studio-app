import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, stat, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const dataDir = path.join(root, 'data');
const assetDir = path.join(root, 'storage', 'assets');
const allowedMime = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp']]);
const maxUploadBytes = 8 * 1024 * 1024;
const rateWindows = new Map();
const defaultImageModel = 'gpt-image-2.5-flare';
const staticTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

await mkdir(dataDir, { recursive: true });
await mkdir(assetDir, { recursive: true });

async function readStore(name, fallback) {
  try { return JSON.parse(await readFile(path.join(dataDir, name), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function writeStore(name, value) {
  const target = path.join(dataDir, name);
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2));
  await rename(temp, target);
}
const store = {
  projects: () => readStore('projects.json', []),
  generations: () => readStore('generations.json', []),
  assets: () => readStore('assets.json', []),
};
async function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(payload);
}
function safeError(error) {
  const msg = String(error?.message || 'The provider could not complete the request.');
  if (/401|403|api key|unauthorized/i.test(msg)) return 'Check the server API key and provider access.';
  if (/429|rate limit/i.test(msg)) return 'The provider is busy. Wait a moment, then try again.';
  if (/timeout|timed out|abort/i.test(msg)) return 'The provider took too long to respond. Please try again.';
  if (/content_policy|safety|moderation/i.test(msg)) return 'This prompt could not be generated. Try changing its wording.';
  return 'The image provider could not complete this request. Please try again.';
}
function rateLimit(req) {
  const key = req.socket.remoteAddress || 'local';
  const now = Date.now();
  const prior = rateWindows.get(key) || { start: now, count: 0 };
  if (now - prior.start > 60_000) { prior.start = now; prior.count = 0; }
  prior.count += 1;
  rateWindows.set(key, prior);
  return prior.count <= 8;
}
async function bodyJson(req, cap = 12 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > cap) throw Object.assign(new Error('Payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid request body'), { status: 400 }); }
}
function validImageData(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return null;
  const mime = match[1]; const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > maxUploadBytes) return null;
  return { mime, bytes };
}
async function saveImage(b64, projectId, kind = 'generation') {
  const bytes = Buffer.from(b64, 'base64');
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('Image output exceeded the storage limit.');
  const id = randomUUID(); const file = `${id}.png`;
  await writeFile(path.join(assetDir, file), bytes, { flag: 'wx' });
  const assets = await store.assets();
  const asset = { id, projectId, kind, mimeType: 'image/png', path: `/assets/${file}`, createdAt: new Date().toISOString(), size: bytes.length };
  assets.unshift(asset); await writeStore('assets.json', assets);
  return asset;
}
async function openAIImage({ prompt, size, quality, image }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not configured.');
  const model = process.env.OPENAI_IMAGE_MODEL || defaultImageModel;
  let response;
  if (image) {
    const form = new FormData();
    form.set('model', model); form.set('prompt', prompt); form.set('size', size); form.set('quality', quality);
    form.set('image[]', new Blob([image.bytes], { type: image.mime }), `reference.${allowedMime.get(image.mime)}`);
    response = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(180_000) });
  } else {
    response = await fetch('https://api.openai.com/v1/images/generations', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, prompt, size, quality, n: 1 }), signal: AbortSignal.timeout(180_000) });
  }
  if (!response.ok) {
    const detail = await response.text();
    console.error('OpenAI image request failed', response.status, detail.slice(0, 1000));
    throw new Error(`OpenAI request failed (${response.status}). ${detail.slice(0, 300)}`);
  }
  const result = await response.json();
  const b64 = result?.data?.[0]?.b64_json;
  if (!b64) throw new Error('Provider returned no image data.');
  return { b64, provider: 'openai', model, usage: result.usage || null };
}
async function enhancePrompt(idea) {
  const key = process.env.NEMOTRON_API_KEY;
  if (!key) return { prompt: idea, enhanced: false };
  const base = (process.env.NEMOTRON_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '');
  const model = process.env.NEMOTRON_MODEL || 'nvidia/nemotron-3.5-lightning-30b-a3b';
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0.5, max_tokens: 500, messages: [
      { role: 'system', content: 'You are an expert visual creative director. Translate the user idea into a single concise image-generation prompt. Preserve the intended subject and meaning. Add useful details for composition, lighting, materials, color, and camera only when appropriate. Return only the prompt, with no preamble or markdown.' },
      { role: 'user', content: idea },
    ] }), signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) { const detail = await response.text(); console.error('Nemotron request failed', response.status, detail.slice(0, 800)); throw new Error('Creative director is temporarily unavailable.'); }
  const body = await response.json(); const text = body?.choices?.[0]?.message?.content?.trim();
  if (!text || text.length > 6000) throw new Error('Creative director returned an invalid prompt.');
  return { prompt: text, enhanced: true, model };
}
async function createProject(name = 'Untitled campaign') {
  const projects = await store.projects();
  const project = { id: randomUUID(), name: String(name).trim().slice(0, 80) || 'Untitled campaign', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  projects.unshift(project); await writeStore('projects.json', projects); return project;
}
async function serveStatic(pathname, res) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const isAsset = relative.startsWith('assets/');
  const rootDir = isAsset ? assetDir : path.join(root, 'public');
  const file = path.resolve(rootDir, isAsset ? relative.slice(7) : relative);
  if (!file.startsWith(rootDir + path.sep)) return json(res, 404, { error: 'Not found' });
  try {
    const info = await stat(file); if (!info.isFile()) return json(res, 404, { error: 'Not found' });
    const ext = path.extname(file); const type = staticTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'content-length': info.size, 'x-content-type-options': 'nosniff', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
    res.end(await readFile(file));
  } catch { json(res, 404, { error: 'Not found' }); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, providers: { image: Boolean(process.env.OPENAI_API_KEY), creativeDirector: Boolean(process.env.NEMOTRON_API_KEY) } });
    if (req.method === 'GET' && url.pathname === '/api/projects') return json(res, 200, { projects: await store.projects() });
    if (req.method === 'POST' && url.pathname === '/api/projects') {
      const body = await bodyJson(req, 16_384); const name = typeof body.name === 'string' ? body.name : 'Untitled campaign';
      const project = await createProject(name); return json(res, 201, { project });
    }
    const projectMatch = /^\/api\/projects\/([a-f0-9-]+)$/.exec(url.pathname);
    if (req.method === 'GET' && projectMatch) {
      const [projects, generations, assets] = await Promise.all([store.projects(), store.generations(), store.assets()]);
      const project = projects.find((item) => item.id === projectMatch[1]);
      if (!project) return json(res, 404, { error: 'Project not found' });
      return json(res, 200, { project, generations: generations.filter((g) => g.projectId === project.id), assets: assets.filter((a) => a.projectId === project.id) });
    }
    const historyMatch = /^\/api\/projects\/([a-f0-9-]+)\/generations$/.exec(url.pathname);
    if (req.method === 'GET' && historyMatch) {
      const projects = await store.projects(); if (!projects.some((p) => p.id === historyMatch[1])) return json(res, 404, { error: 'Project not found' });
      const generations = await store.generations(); return json(res, 200, { generations: generations.filter((g) => g.projectId === historyMatch[1]) });
    }
    if (req.method === 'POST' && url.pathname === '/api/projects/assets') {
      const body = await bodyJson(req, 12 * 1024 * 1024); const parsed = validImageData(body.dataUrl);
      if (!parsed) return json(res, 400, { error: 'Upload a PNG, JPEG or WebP image under 8 MB.' });
      const projects = await store.projects(); const project = projects.find((p) => p.id === body.projectId);
      if (!project) return json(res, 404, { error: 'Project not found' });
      const id = randomUUID(); const ext = allowedMime.get(parsed.mime); const file = `${id}.${ext}`;
      await writeFile(path.join(assetDir, file), parsed.bytes, { flag: 'wx' });
      const asset = { id, projectId: project.id, kind: 'reference', mimeType: parsed.mime, path: `/assets/${file}`, createdAt: new Date().toISOString(), size: parsed.bytes.length };
      const assets = await store.assets(); assets.unshift(asset); await writeStore('assets.json', assets); return json(res, 201, { asset });
    }
    if (req.method === 'POST' && url.pathname === '/api/generate') {
      if (!rateLimit(req)) return json(res, 429, { error: 'Too many generations. Wait a minute and try again.' });
      const body = await bodyJson(req, 12 * 1024 * 1024);
      const projectId = typeof body.projectId === 'string' ? body.projectId : '';
      const idea = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (!idea || idea.length > 4000) return json(res, 400, { error: 'Enter a prompt between 1 and 4000 characters.' });
      const projects = await store.projects(); const project = projects.find((p) => p.id === projectId);
      if (!project) return json(res, 404, { error: 'Project not found' });
      const size = ['1024x1024', '1536x1024', '1024x1536'].includes(body.size) ? body.size : '1024x1024';
      const quality = ['low', 'medium', 'high'].includes(body.quality) ? body.quality : 'medium';
      const baseImage = typeof body.sourceAssetId === 'string' ? (await store.assets()).find((a) => a.id === body.sourceAssetId && a.projectId === projectId) : null;
      if (body.sourceAssetId && !baseImage) return json(res, 404, { error: 'Source image not found in this project.' });
      const refAsset = typeof body.referenceAssetId === 'string' ? (await store.assets()).find((a) => a.id === body.referenceAssetId && a.projectId === projectId) : null;
      if (body.referenceAssetId && !refAsset) return json(res, 404, { error: 'Reference image not found in this project.' });
      let image = validImageData(body.referenceDataUrl);
      const fileAsset = refAsset || baseImage;
      if (!image && fileAsset) image = { mime: fileAsset.mimeType, bytes: await readFile(path.join(assetDir, path.basename(fileAsset.path))) };
      if (body.referenceDataUrl && !image) return json(res, 400, { error: 'Reference must be PNG, JPEG or WebP and under 8 MB.' });
      const jobId = randomUUID(); const generation = { id: jobId, projectId, prompt: idea, status: 'processing', operation: fileAsset ? (baseImage && body.operation === 'variation' ? 'variation' : 'edit') : 'generate', provider: 'openai', model: process.env.OPENAI_IMAGE_MODEL || defaultImageModel, createdAt: new Date().toISOString() };
      const generations = await store.generations(); generations.unshift(generation); await writeStore('generations.json', generations);
      try {
        let finalPrompt = idea; let enhanced = false;
        if (body.enhance === true && process.env.NEMOTRON_API_KEY) { const result = await enhancePrompt(idea); finalPrompt = result.prompt; enhanced = true; }
        const started = Date.now(); const output = await openAIImage({ prompt: finalPrompt, size, quality, image });
        const asset = await saveImage(output.b64, projectId);
        Object.assign(generation, { status: 'completed', assetId: asset.id, assetPath: asset.path, finalPrompt, enhanced, provider: output.provider, model: output.model, durationMs: Date.now() - started, usage: output.usage, completedAt: new Date().toISOString() });
        generation.size = size; generation.quality = quality;
        const updated = await store.generations(); const index = updated.findIndex((g) => g.id === jobId); updated[index] = generation; await writeStore('generations.json', updated);
        project.updatedAt = new Date().toISOString(); await writeStore('projects.json', projects);
        return json(res, 200, { generation, asset });
      } catch (error) {
        console.error('Generation failed', { id: jobId, category: error?.name || 'provider_error', detail: error?.message });
        Object.assign(generation, { status: 'failed', errorCategory: error?.name || 'provider_error', userError: safeError(error), completedAt: new Date().toISOString() });
        const updated = await store.generations(); const index = updated.findIndex((g) => g.id === jobId); updated[index] = generation; await writeStore('generations.json', updated);
        const status = /not configured/.test(error.message) ? 503 : 502;
        return json(res, status, { error: safeError(error), generationId: jobId });
      }
    }
    const generationMatch = /^\/api\/generations\/([a-f0-9-]+)$/.exec(url.pathname);
    if (req.method === 'GET' && generationMatch) {
      const generations = await store.generations(); const generation = generations.find((g) => g.id === generationMatch[1]);
      return generation ? json(res, 200, { generation }) : json(res, 404, { error: 'Generation not found' });
    }
    if (req.method === 'GET') return serveStatic(url.pathname, res);
    return json(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    console.error('Request failed', { path: url.pathname, category: error?.name || 'internal_error', detail: error?.message });
    return json(res, error.status || 500, { error: error.status === 413 ? 'Request is too large.' : 'The request could not be completed.' });
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Lumina Studio listening on http://localhost:${port}`));
