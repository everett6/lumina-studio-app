import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDataUrl } from './assets.js';
import { bookKinds, briefFor, cleanBible, cleanBrief, trimSizes } from './books.js';
import { emptyGraph, nodeTypes, templates, validateGraph } from './canvas.js';
import { RequestError } from './generation.js';
import { envNames } from './keys.js';
import { presetGroups, presets } from './presets.js';
import { userMessage } from './providers/http.js';

const staticTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4',
};
const csp = [
  "default-src 'self'", "img-src 'self' data: blob:", "media-src 'self' blob:", "style-src 'self' https://fonts.googleapis.com",
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
  const { repo, assetStore, providers, directors, keys, generations, canvasRunner, books, jobs, token, remote, publicDir, exportDir, info } = ctx;
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
  route('GET', '/api/presets', () => ({ groups: presetGroups, presets }));

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

  route('GET', '/api/settings/remote', () => remote.status());
  route('PUT', '/api/settings/remote', async (req) => remote.update(await readBody(req, 4096)));
  route('POST', '/api/settings/remote/pairing', () => ({ pairing: remote.newPairingCode() }));
  route('POST', '/api/settings/remote/revoke', () => {
    remote.revokeAll();
    return remote.status();
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

  // ---------- Book Studio ----------
  const needPage = (id) => repo.pages.get(id) ?? (() => { throw new RequestError(404, 'Page not found.'); })();
  const needChapter = (id) => repo.chapters.get(id) ?? (() => { throw new RequestError(404, 'Chapter not found.'); })();
  const needBook = (id) => repo.books.get(id) ?? (() => { throw new RequestError(404, 'Book not found.'); })();
  const safeFileName = (title) => title.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'book';
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : undefined);

  route('GET', '/api/book-options', () => ({ trimSizes, bookKinds, briefs: Object.fromEntries(Object.keys(bookKinds).map((kind) => [kind, briefFor(kind)])) }));
  route('GET', `/api/projects/${uuid}/books`, (req, [projectId]) => {
    needProject(projectId);
    return { books: repo.books.listByProject(projectId) };
  });
  route('POST', `/api/projects/${uuid}/books`, async (req, [projectId]) => {
    needProject(projectId);
    const body = await readBody(req, 64 * 1024);
    const writer = typeof body.writer === 'string' && body.writer ? body.writer : null;
    return { status: 201, body: { book: books.createBook({ projectId, title: body.title, kind: body.kind, brief: body.brief, bible: body.bible, writer }) } };
  });
  route('GET', `/api/books/${uuid}`, (req, [id]) => books.detail(id));
  route('PATCH', `/api/books/${uuid}`, async (req, [id]) => {
    const book = needBook(id);
    const body = await readBody(req, 256 * 1024);
    if (body.coverAssetId && !repo.assets.get(body.coverAssetId)?.mimeType.startsWith('image/')) throw new RequestError(404, 'Cover image not found.');
    return {
      book: repo.books.update(id, {
        title: body.title, brief: body.brief ? cleanBrief(body.brief, book.brief) : undefined,
        bible: body.bible ? cleanBible(body.bible) : undefined, writer: body.writer === undefined ? undefined : body.writer || null,
        coverAssetId: body.coverAssetId === undefined ? undefined : body.coverAssetId || null,
      }),
    };
  });
  route('DELETE', `/api/books/${uuid}`, (req, [id]) => ({ deleted: repo.books.remove(id) }));
  route('POST', `/api/books/${uuid}/bible`, async (req, [id]) => ({ book: await books.draftBible(id, await readBody(req, 4096)) }));
  route('POST', `/api/books/${uuid}/plan`, async (req, [id]) => books.planPages(id, await readBody(req, 4096)));
  route('POST', `/api/books/${uuid}/outline`, async (req, [id]) => books.outline(id, await readBody(req, 4096)));
  route('POST', `/api/books/${uuid}/cover`, async (req, [id]) => ({ status: 202, body: books.generateCover(id, await readBody(req, 4096)) }));

  // Pages (picture books)
  route('POST', `/api/books/${uuid}/pages`, async (req, [id]) => {
    books.detail(id);
    const body = await readBody(req, 16_384);
    const count = repo.pages.listByBook(id).length;
    const position = Math.min(Math.max(1, Number(body.position) || count + 1), count + 1);
    return { status: 201, body: { page: repo.pages.insert(id, { position, text: String(body.text ?? '').slice(0, 4000), illustrationBrief: String(body.illustrationBrief ?? '').slice(0, 2000) }) } };
  });
  route('PATCH', `/api/pages/${uuid}`, async (req, [id]) => {
    needPage(id);
    const body = await readBody(req, 64 * 1024);
    if (body.assetId && !repo.assets.get(body.assetId)) throw new RequestError(404, 'Image not found.');
    return { page: repo.pages.update(id, { text: text(body.text, 4000), illustrationBrief: text(body.illustrationBrief, 2000), assetId: body.assetId === undefined ? undefined : body.assetId || null }) };
  });
  route('DELETE', `/api/pages/${uuid}`, (req, [id]) => {
    needPage(id);
    repo.pages.remove(id);
    return { deleted: true };
  });
  route('POST', `/api/pages/${uuid}/move`, async (req, [id]) => {
    needPage(id);
    return { page: repo.pages.move(id, (await readBody(req, 1024)).direction === 'up' ? -1 : 1) };
  });
  route('GET', `/api/pages/${uuid}/revisions`, (req, [id]) => {
    needPage(id);
    return { revisions: repo.pages.revisions(id) };
  });
  route('POST', `/api/pages/${uuid}/revise`, async (req, [id]) => ({ page: await books.revisePage(id, await readBody(req, 16_384)) }));
  route('POST', `/api/pages/${uuid}/illustrate`, async (req, [id]) => ({ status: 202, body: books.illustratePage(id, await readBody(req, 4096)) }));
  route('POST', `/api/pages/${uuid}/narrate`, async (req, [id]) => ({ status: 202, body: books.narrate(['page', id], await readBody(req, 4096)) }));
  route('POST', `/api/pages/${uuid}/animate`, async (req, [id]) => ({ status: 202, body: books.animatePage(id, await readBody(req, 4096)) }));

  // Chapters (novels, nonfiction)
  route('POST', `/api/books/${uuid}/chapters`, async (req, [id]) => {
    books.detail(id);
    const body = await readBody(req, 64 * 1024);
    const count = repo.chapters.listByBook(id).length;
    const position = Math.min(Math.max(1, Number(body.position) || count + 1), count + 1);
    return { status: 201, body: { chapter: repo.chapters.insert(id, { position, title: text(body.title, 200) ?? '', summary: text(body.summary, 3000) ?? '' }) } };
  });
  route('PATCH', `/api/chapters/${uuid}`, async (req, [id]) => {
    needChapter(id);
    const body = await readBody(req, 1024 * 1024);
    const beats = Array.isArray(body.beats) ? body.beats.map((b) => String(b).slice(0, 1000)).slice(0, 30) : undefined;
    if (body.assetId && !repo.assets.get(body.assetId)) throw new RequestError(404, 'Image not found.');
    return { chapter: repo.chapters.update(id, { title: text(body.title, 200), summary: text(body.summary, 3000), beats, text: text(body.text, 400_000), assetId: body.assetId === undefined ? undefined : body.assetId || null }) };
  });
  route('DELETE', `/api/chapters/${uuid}`, (req, [id]) => {
    needChapter(id);
    repo.chapters.remove(id);
    return { deleted: true };
  });
  route('POST', `/api/chapters/${uuid}/move`, async (req, [id]) => {
    needChapter(id);
    return { chapter: repo.chapters.move(id, (await readBody(req, 1024)).direction === 'up' ? -1 : 1) };
  });
  route('GET', `/api/chapters/${uuid}/revisions`, (req, [id]) => {
    needChapter(id);
    return { revisions: repo.chapters.revisions(id) };
  });
  route('POST', `/api/chapters/${uuid}/draft`, async (req, [id]) => ({ chapter: await books.draftChapter(id, await readBody(req, 16_384)) }));
  route('POST', `/api/chapters/${uuid}/revise`, async (req, [id]) => ({ chapter: await books.reviseChapter(id, await readBody(req, 16_384)) }));
  route('POST', `/api/chapters/${uuid}/illustrate`, async (req, [id]) => ({ status: 202, body: books.illustrateChapter(id, await readBody(req, 4096)) }));
  route('POST', `/api/chapters/${uuid}/narrate`, async (req, [id]) => ({ status: 202, body: books.narrate(['chapter', id], await readBody(req, 4096)) }));

  // Exports
  async function sendDownload(res, bytes, type, name, headers = {}) {
    res.writeHead(200, {
      'content-type': type, 'content-length': bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`, ...headers,
    });
    res.end(bytes);
  }
  route('GET', `/api/books/${uuid}/export\\.(pdf|epub|docx|md|audio)`, async (req, [id, format], url, res) => {
    const book = needBook(id);
    const name = safeFileName(book.title);
    if (format === 'pdf') {
      const { pdf, skippedWebp, missingScripts } = await books.exportPdf(id);
      return sendDownload(res, pdf, 'application/pdf', `${name}.pdf`, { 'x-lumina-skipped-webp': String(skippedWebp), 'x-lumina-missing-scripts': missingScripts.join(',') });
    }
    if (format === 'epub') return sendDownload(res, await books.exportEpub(id), 'application/epub+zip', `${name}.epub`);
    if (format === 'docx') return sendDownload(res, await books.exportDocx(id), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', `${name}.docx`);
    if (format === 'md') return sendDownload(res, Buffer.from(books.exportMarkdown(id)), 'text/markdown; charset=utf-8', `${name}.md`);
    const { audio, mime, missing } = await books.exportAudiobook(id);
    return sendDownload(res, audio, mime, `${name}-audiobook.${mime === 'audio/wav' ? 'wav' : 'mp3'}`, { 'x-lumina-missing-narration': String(missing) });
  });

  async function serveFile(res, rootDir, relative, extraHeaders = {}, range = null) {
    const file = path.resolve(rootDir, relative);
    if (!file.startsWith(rootDir + path.sep)) return send(res, 404, { error: 'Not found' });
    try {
      const info = await stat(file);
      if (!info.isFile()) return send(res, 404, { error: 'Not found' });
      const ext = path.extname(file);
      const headers = {
        'content-type': staticTypes[ext] || 'application/octet-stream', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes',
        'cache-control': ext === '.html' || ext === '.js' || ext === '.css' ? 'no-cache' : 'private, max-age=31536000, immutable',
        ...(ext === '.html' ? { 'content-security-policy': csp, 'referrer-policy': 'no-referrer' } : {}), ...extraHeaders,
      };
      // Byte ranges let audio/video players seek without downloading the whole file.
      const match = range && /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && (match[1] || match[2])) {
        const start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
        const end = match[1] && match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
        if (start > end || start >= info.size) {
          res.writeHead(416, { 'content-range': `bytes */${info.size}` });
          return res.end();
        }
        res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${info.size}`, 'content-length': end - start + 1 });
        return createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, { ...headers, 'content-length': info.size });
      return createReadStream(file).pipe(res);
    } catch {
      return send(res, 404, { error: 'Not found' });
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

      if (url.pathname.startsWith('/assets/') && req.method === 'GET') return serveFile(res, assetStore.dir, decodeURIComponent(url.pathname.slice(8)), {}, req.headers.range);
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const match = r.pattern.exec(url.pathname);
        if (!match) continue;
        const result = await r.handler(req, match.slice(1), url, res);
        if (res.headersSent) return undefined;
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
