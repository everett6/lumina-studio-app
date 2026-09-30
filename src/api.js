import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDataUrl } from './assets.js';
import { emptyGraph, nodeTypes, templates, validateGraph } from './canvas.js';
import { RequestError } from './generation.js';
import { envNames } from './keys.js';
import { userMessage } from './providers/http.js';

const staticTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};
const csp = [
  "default-src 'self'", "img-src 'self' data: blob:", "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'",
].join('; ');
const uuid = '([a-f0-9-]{36})';

function send(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(payload);
}

async function readBody(req, cap) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > cap) throw new RequestError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError(400, 'Invalid request body.');
  }
}

function sameToken(given, expected) {
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function cookieToken(req) {
  return /(?:^|;\s*)lumina_token=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1];
}

export function createApiServer(ctx) {
  const { repo, assetStore, providers, directors, keys, generations, canvasRunner, jobs, token, publicDir, exportDir, info } = ctx;
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern: new RegExp(`^${pattern}$`), handler });

  const needProject = (id) => repo.projects.get(id) ?? (() => { throw new RequestError(404, 'Project not found.'); })();
  const needCanvas = (id) => repo.canvases.get(id) ?? (() => { throw new RequestError(404, 'Canvas not found.'); })();

  function catalog() {
    const keyStatus = keys.status();
    return {
      providers: providers.list.map((p) => ({
        id: p.id, label: p.label, keyUrl: p.keyUrl ?? null, keyless: Boolean(p.keyless),
        ready: Boolean(p.keyless || keyStatus[p.id]?.configured), models: p.models,
      })),
      directors: directors.list.map((d) => ({
        id: d.id, label: d.label, models: d.models, ready: Boolean(d.keyless || keyStatus[d.keyProvider]?.configured),
      })),
      nodeTypes,
    };
  }

  route('GET', '/api/health', () => ({ ok: true, version: info.version, mode: info.mode, jobs: jobs.stats() }));
  route('GET', '/api/catalog', catalog);

  route('GET', '/api/projects', () => ({ projects: repo.projects.list() }));
  route('POST', '/api/projects', async (req) => ({ status: 201, body: { project: repo.projects.create((await readBody(req, 16_384)).name) } }));
  route('GET', `/api/projects/${uuid}`, (req, [id]) => ({
    project: needProject(id), generations: repo.generations.listByProject(id), assets: repo.assets.listByProject(id),
    canvases: repo.canvases.listByProject(id).map(({ graph, ...rest }) => ({ ...rest, nodeCount: graph.nodes.length })),
  }));
  route('PATCH', `/api/projects/${uuid}`, async (req, [id]) => {
    needProject(id);
    return { project: repo.projects.rename(id, (await readBody(req, 16_384)).name) };
  });
  route('DELETE', `/api/projects/${uuid}`, async (req, [id]) => {
    needProject(id);
    const assets = repo.assets.listByProject(id);
    repo.projects.remove(id);
    await Promise.all(assets.map((asset) => assetStore.remove(asset)));
    return { deleted: true };
  });
  // Export = a plain folder with project.json and the image files, readable without Lumina.
  route('POST', `/api/projects/${uuid}/export`, async (req, [id]) => {
    const project = needProject(id);
    const folder = path.join(exportDir, `${project.name.replace(/[^\w.-]+/g, '-').slice(0, 40)}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await mkdir(path.join(folder, 'assets'), { recursive: true });
    const assets = repo.assets.listByProject(id);
    for (const asset of assets) await copyFile(assetStore.path(asset), path.join(folder, 'assets', asset.file));
    const canvases = repo.canvases.listByProject(id);
    await writeFile(path.join(folder, 'project.json'), JSON.stringify({ project, generations: repo.generations.listByProject(id, 10_000), assets, canvases }, null, 2));
    return { folder, assets: assets.length };
  });

  route('GET', '/api/assets', (req, params, url) => ({ assets: repo.assets.listByKind(url.searchParams.get('kind') === 'generation' ? 'generation' : 'reference') }));
  route('POST', '/api/assets', async (req) => {
    const body = await readBody(req, 12 * 1024 * 1024);
    needProject(body.projectId);
    const image = parseDataUrl(body.dataUrl);
    if (!image) throw new RequestError(400, 'Upload a PNG, JPEG or WebP image under 8 MB.');
    const label = typeof body.label === 'string' ? body.label.slice(0, 120) : null;
    return { status: 201, body: { asset: await assetStore.save({ bytes: image.bytes, projectId: body.projectId, kind: 'reference', label }) } };
  });
  route('DELETE', `/api/assets/${uuid}`, async (req, [id]) => {
    const asset = repo.assets.get(id);
    if (!asset) throw new RequestError(404, 'Asset not found.');
    await assetStore.remove(asset);
    return { deleted: true };
  });

  route('POST', '/api/generate', async (req) => ({ status: 202, body: { generation: generations.submit(await readBody(req, 64 * 1024)) } }));
  route('GET', `/api/generations/${uuid}`, (req, [id]) => {
    const found = repo.generations.get(id) ?? (() => { throw new RequestError(404, 'Generation not found.'); })();
    return { generation: found };
  });
  route('POST', `/api/generations/${uuid}/wait`, async (req, [id]) => {
    const { timeoutMs } = await readBody(req, 1024);
    const done = await jobs.waitFor(id, Math.min(Number(timeoutMs) || 120_000, 600_000));
    if (!done) throw new RequestError(404, 'Generation not found.');
    return { generation: done };
  });
  route('POST', `/api/generations/${uuid}/retry`, (req, [id]) => ({ status: 202, body: { generation: generations.retry(id) } }));

  route('GET', '/api/settings/keys', () => ({ keys: keys.status(), encrypted: keys.encrypted }));
  route('PUT', '/api/settings/keys/([a-z]+)', async (req, [provider]) => {
    if (!(provider in envNames)) throw new RequestError(404, 'Unknown provider.');
    keys.set(provider, (await readBody(req, 4096)).key);
    return { keys: keys.status() };
  });
  route('DELETE', '/api/settings/keys/([a-z]+)', (req, [provider]) => {
    if (!(provider in envNames)) throw new RequestError(404, 'Unknown provider.');
    keys.remove(provider);
    return { keys: keys.status() };
  });
  route('POST', '/api/settings/keys/([a-z]+)/test', async (req, [provider]) => {
    const key = keys.get(provider);
    if (!key) throw new RequestError(400, 'No key saved for this provider.');
    const adapter = providers.get(provider);
    try {
      if (adapter) return await adapter.validateKey(key);
      // Director-only providers: a one-line refine is the cheapest real check.
      const director = directors.list.find((d) => d.keyProvider === provider);
      await director.refine({ key, model: director.models.at(-1), idea: 'a red apple' });
      return { ok: true, verified: true };
    } catch (error) {
      return { ok: false, message: userMessage(error) };
    }
  });

  route('GET', '/api/templates', () => ({ templates: Object.entries(templates).map(([id, t]) => ({ id, name: t.name })) }));
  route('POST', `/api/projects/${uuid}/canvases`, async (req, [projectId]) => {
    needProject(projectId);
    const body = await readBody(req, 16_384);
    const template = templates[body.template];
    return { status: 201, body: { canvas: repo.canvases.create(projectId, body.name || template?.name, structuredClone(template?.graph ?? emptyGraph())) } };
  });
  route('GET', `/api/canvases/${uuid}`, (req, [id]) => ({ canvas: needCanvas(id), lastRun: repo.runs.listByCanvas(id, 1)[0] ?? null }));
  route('PUT', `/api/canvases/${uuid}`, async (req, [id]) => {
    const body = await readBody(req, 2 * 1024 * 1024);
    if (body.graph) validateGraph(body.graph);
    const result = repo.canvases.save(id, { name: body.name, graph: body.graph, version: body.version });
    if (result.error === 'not_found') throw new RequestError(404, 'Canvas not found.');
    if (result.error === 'conflict') return { status: 409, body: { error: 'This canvas changed elsewhere. Reloaded the latest version.', canvas: result.canvas } };
    return { canvas: result.canvas };
  });
  route('DELETE', `/api/canvases/${uuid}`, (req, [id]) => ({ deleted: repo.canvases.remove(id) }));
  route('POST', `/api/canvases/${uuid}/run`, async (req, [id]) => {
    const body = await readBody(req, 16_384);
    const { run } = canvasRunner.start(id, { targetNodeId: body.nodeId ?? null, defaults: body.defaults ?? {} });
    return { status: 202, body: { run } };
  });
  route('GET', `/api/canvas-runs/${uuid}`, (req, [id]) => ({ run: repo.runs.get(id) ?? (() => { throw new RequestError(404, 'Run not found.'); })() }));

  async function serveFile(res, rootDir, relative, extraHeaders = {}) {
    const file = path.resolve(rootDir, relative);
    if (!file.startsWith(rootDir + path.sep)) return send(res, 404, { error: 'Not found' });
    try {
      const info = await stat(file);
      if (!info.isFile()) return send(res, 404, { error: 'Not found' });
      const ext = path.extname(file);
      res.writeHead(200, {
        'content-type': staticTypes[ext] || 'application/octet-stream', 'content-length': info.size, 'x-content-type-options': 'nosniff',
        'cache-control': ext === '.html' || ext === '.js' || ext === '.css' ? 'no-cache' : 'private, max-age=31536000, immutable',
        ...(ext === '.html' ? { 'content-security-policy': csp, 'referrer-policy': 'no-referrer' } : {}), ...extraHeaders,
      });
      res.end(await readFile(file));
    } catch {
      send(res, 404, { error: 'Not found' });
    }
  }

  function authorized(req) {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    return sameToken(cookieToken(req), token) || sameToken(bearer, token);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    try {
      // Reject DNS-rebinding and cross-site requests: only loopback hosts, only same-origin writes.
      const host = String(req.headers.host ?? '');
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return send(res, 403, { error: 'Forbidden host' });
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return send(res, 403, { error: 'Forbidden origin' });

      const protectedPath = url.pathname.startsWith('/api/') || url.pathname.startsWith('/assets/');
      // Opening the app with ?token= exchanges it for an HttpOnly cookie and strips it from the URL.
      if (url.pathname === '/' && url.searchParams.has('token')) {
        if (!sameToken(url.searchParams.get('token'), token)) return send(res, 401, { error: 'Invalid token' });
        res.writeHead(302, { location: '/', 'set-cookie': `lumina_token=${token}; HttpOnly; SameSite=Strict; Path=/`, 'cache-control': 'no-store' });
        return res.end();
      }
      if (protectedPath && !authorized(req)) return send(res, 401, { error: 'Open Lumina from its launch link or desktop app.' });

      if (url.pathname.startsWith('/assets/') && req.method === 'GET') return serveFile(res, assetStore.dir, decodeURIComponent(url.pathname.slice(8)));
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const match = r.pattern.exec(url.pathname);
        if (!match) continue;
        const result = await r.handler(req, match.slice(1), url);
        return result?.status ? send(res, result.status, result.body) : send(res, 200, result);
      }
      if (protectedPath) return send(res, 404, { error: 'Not found' });
      if (req.method === 'GET') return serveFile(res, publicDir, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
      return send(res, 405, { error: 'Method not allowed' });
    } catch (error) {
      if (error instanceof RequestError) return send(res, error.status, { error: error.message });
      console.error('Request failed', { path: url.pathname, detail: error?.message });
      return send(res, error.status || 500, { error: error.status ? error.message : 'The request could not be completed.' });
    }
  });
  return server;
}
