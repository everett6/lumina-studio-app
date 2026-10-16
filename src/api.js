import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDataUrl, sniffMedia } from './assets.js';
import { registerRoutes as directorRoutes } from './routes/director.js';
import { registerRoutes as audioRoutes } from './routes/audio.js';
import { registerRoutes as canonRoutes } from './routes/canon.js';
import { registerRoutes as editRoutes } from './routes/edit.js';
import { registerRoutes as filmRoutes } from './routes/film.js';
import { registerRoutes as libraryRoutes } from './routes/library.js';
import { registerRoutes as reviewRoutes } from './routes/review.js';
import { registerRoutes as localRoutes } from './routes/local.js';
import { registerRoutes as mediaRoutes } from './routes/media.js';
import { registerRoutes as voiceRoutes } from './routes/voice.js';
import { bookKinds, briefFor, cleanBible, cleanBrief, trimSizes } from './books.js';
import { emptyGraph, nodeTypes, templates, validateGraph } from './canvas.js';
import { confirmSpend, defaultResolution, nearestDuration, RequestError } from './generation.js';
import { envNames } from './keys.js';
import { presetGroups, presets } from './presets.js';
import { estimateUsd, priceFor, pricesAsOf } from './pricing.js';
import { videoRate } from './catalog.js';
import { userMessage } from './providers/http.js';
import { cleanSequenceSettings, maxShots, maxTargetSeconds } from './sequences.js';
import { createSearch } from './search.js';
import { currentRequest, requestContext } from './context.js';
import { contactSheet, hasFfmpeg, inspectVideo, probe, stillMotions } from './video.js';

const staticTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.mp4': 'video/mp4',
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

async function readRaw(req, cap) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > cap) throw new RequestError(413, 'The file is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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
  const { music, publisher, repo, assetStore, providers, directors, keys, generations, canvasRunner, books, sequences, enhancer, faces, jobs, token, remote, budget, credits, modelCatalog, bake, publicDir, exportDir, info } = ctx;
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern: new RegExp(`^${pattern}$`), handler });

  const needProject = (id) => repo.projects.get(id) ?? (() => { throw new RequestError(404, 'Project not found.'); })();
  const needCanvas = (id) => repo.canvases.get(id) ?? (() => { throw new RequestError(404, 'Canvas not found.'); })();

  function catalog() {
    const keyStatus = keys.status();
    return {
      providers: providers.list.map((p) => ({
        id: p.id, label: p.label, keyUrl: p.keyUrl ?? null, keyless: Boolean(p.keyless),
        ready: Boolean(p.keyless ? (p.available?.() ?? true) : keyStatus[p.id]?.configured), note: p.keyless && p.available && !p.available() ? p.unavailableNote : undefined, models: p.models.map(({ liveSkus, livePrice, ...m }) => ({ ...m, available: p.modelAvailable?.(m.id) ?? true, defaultResolution: defaultResolution(m), price: catalogPrice(p.id, { ...m, liveSkus, livePrice }) })),
      })),
      directors: directors.list.map((d) => ({
        id: d.id, label: d.label, models: d.models, ready: Boolean(d.keyless || keyStatus[d.keyProvider]?.configured),
      })),
      nodeTypes, pricesAsOf,
    };
  }

  const finder = createSearch(repo);
  route('GET', '/api/search', (req, match, url) => ({ results: finder.search(url.searchParams.get('q') ?? '', Math.min(50, Number(url.searchParams.get('limit')) || 20)) }));
  route('GET', '/api/search/document', (req, match, url) => finder.fetch(url.searchParams.get('id') ?? '') ?? (() => { throw new RequestError(404, 'No document with that id.'); })());
  // The price shown in pickers. Live per-second video prices are listed per resolution; `usd` is the dearest.
  function catalogPrice(providerId, model) {
    const price = priceFor(providerId, model.id, model);
    if (!price?.skus) return price;
    const byResolution = Object.fromEntries((model.resolutions?.length ? model.resolutions : ['any'])
      .map((r) => [r, videoRate(price.skus, { resolution: r === 'any' ? null : r })?.perSecond ?? null]));
    const rates = Object.values(byResolution).filter((v) => v != null);
    return rates.length ? { per: 'second', live: true, usd: Math.max(...rates), byResolution } : { live: true, usd: null, text: 'Billed per video token; no estimate' };
  }

  route('GET', '/api/health', () => ({ ok: true, version: info.version, mode: info.mode, jobs: jobs.stats() }));
  route('GET', '/api/catalog', catalog);
  // Route modules (each owns its file under src/routes/).
  for (const add of [mediaRoutes, voiceRoutes, localRoutes, directorRoutes, filmRoutes, canonRoutes, reviewRoutes, audioRoutes, editRoutes, libraryRoutes]) add({ ...ctx, route, readBody, readRaw, needProject, RequestError, sniffMedia, uuid, catalog });
  route('GET', '/api/presets', () => ({ groups: presetGroups, presets }));

  route('GET', '/api/projects', () => ({ projects: repo.projects.list() }));
  route('POST', '/api/projects', async (req) => ({ status: 201, body: { project: repo.projects.create((await readBody(req, 16_384)).name) } }));
  route('GET', `/api/projects/${uuid}`, (req, [id]) => ({
    project: needProject(id), generations: repo.generations.listByProject(id), assets: repo.assets.listByProject(id).filter((a) => a.kind !== 'mask'),
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

  route('GET', `/api/assets/${uuid}/inspect`, async (req, [id], url) => {
    const asset = repo.assets.get(id);
    if (!asset) throw new RequestError(404, 'Asset not found.');
    if (!asset.mimeType?.startsWith('video/')) throw new RequestError(400, 'Choose a video asset to inspect.');
    const raw = url.searchParams.get('times');
    if (raw !== null && (!raw || raw.split(',').length > 6)) throw new RequestError(400, 'Choose one to six sample times.');
    const times = raw === null ? null : raw.split(',').map((value) => value.trim() ? Number(value) : NaN);
    return inspectVideo(assetStore.path(asset), times);
  });
  route('GET', '/api/assets', (req, params, url) => ({ assets: repo.assets.listByKind(url.searchParams.get('kind') === 'generation' ? 'generation' : 'reference') }));
  route('POST', '/api/assets', async (req) => {
    const body = await readBody(req, 12 * 1024 * 1024);
    needProject(body.projectId);
    const image = parseDataUrl(body.dataUrl);
    if (!image) throw new RequestError(400, 'Upload a PNG, JPEG or WebP image under 8 MB.');
    const label = typeof body.label === 'string' ? body.label.slice(0, 120) : null;
    // Masks are working files for inpainting; they stay out of the library.
    return { status: 201, body: { asset: await assetStore.save({ bytes: image.bytes, projectId: body.projectId, kind: body.kind === 'mask' ? 'mask' : 'reference', label }) } };
  });
  // Background music from the internet (Openverse; CC0, public domain and CC BY only), downloaded on request.
  route('GET', '/api/music/search', async (req, params, url) => {
    if (!music) throw new RequestError(501, 'Music search is not available.');
    const kind = url.searchParams.get('kind') === 'sound' ? 'sound' : 'music';
    return { tracks: await music.search(url.searchParams.get('q'), { kind, minSeconds: Number(url.searchParams.get('minSeconds') ?? (kind === 'sound' ? 0 : 30)) || 0,
      maxSeconds: Number(url.searchParams.get('maxSeconds')) || null, limit: Number(url.searchParams.get('limit') ?? 10) || 10 }) };
  });
  route('GET', `/api/music/preview/${uuid}`, async (req, [trackId], url, res) => {
    if (!music) throw new RequestError(501, 'Music preview is not available.');
    const { bytes } = await music.preview(trackId, { seconds: Number(url.searchParams.get('seconds') ?? 20) || 20, start: Number(url.searchParams.get('start') ?? 0) || 0 });
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': bytes.length, 'cache-control': 'no-store' });
    res.end(bytes);
  });
  route('POST', `/api/projects/${uuid}/music`, async (req, [projectId]) => {
    needProject(projectId);
    if (!music) throw new RequestError(501, 'Music download is not available.');
    const { trackId, kind } = await readBody(req, 4 * 1024);
    return { status: 201, body: await music.download(projectId, trackId, { kind: kind === 'sound' ? 'sound' : 'music' }) };
  });
  // The publish kit: film (+ title card / end credits), subtitles, description with credits, thumbnail, Short.
  route('POST', `/api/storyboards/${uuid}/publish`, async (req, [id]) => {
    if (!publisher) throw new RequestError(501, 'Publishing is not available.');
    return publisher.publish(id, await readBody(req, 8 * 1024));
  });
  route('GET', `/api/assets/${uuid}/credit`, (req, [id]) => ({ credit: music?.credit(id) ?? null }));
  // Music, ambience or recorded dialogue for films: the raw file as the body (MP3, WAV, OGG or FLAC, up to 80 MB).
  route('POST', `/api/projects/${uuid}/audio`, async (req, [projectId]) => {
    needProject(projectId);
    const bytes = await readRaw(req, 80 * 1024 * 1024);
    const mime = sniffMedia(bytes);
    if (!mime?.startsWith('audio/')) throw new RequestError(400, 'Upload an MP3, WAV, OGG or FLAC audio file.');
    const label = String(req.headers['x-lumina-label'] ?? 'audio').slice(0, 120);
    return { status: 201, body: { asset: await assetStore.save({ bytes, projectId, kind: 'audio', label }) } };
  });
  // A video file to work on (e.g. to smooth or upscale): the raw MP4 as the body, up to 300 MB.
  route('POST', `/api/projects/${uuid}/video`, async (req, [projectId]) => {
    needProject(projectId);
    const bytes = await readRaw(req, 300 * 1024 * 1024);
    if (sniffMedia(bytes) !== 'video/mp4') throw new RequestError(400, 'Upload an MP4 video.');
    const label = String(req.headers['x-lumina-label'] ?? 'video').slice(0, 120);
    return { status: 201, body: { asset: await assetStore.save({ bytes, projectId, kind: 'video', label }) } };
  });
  route('DELETE', `/api/assets/${uuid}`, async (req, [id]) => {
    const asset = repo.assets.get(id);
    if (!asset) throw new RequestError(404, 'Asset not found.');
    await assetStore.remove(asset);
    return { deleted: true };
  });

  route('POST', '/api/generate', async (req) => ({ status: 202, body: { generation: generations.submit(await readBody(req, 64 * 1024)) } }));
  const withProgress = (g) => (g.status === 'running' ? { ...g, progress: jobs.progress(g.id) } : g);
  route('GET', `/api/generations/${uuid}`, (req, [id]) => {
    const found = repo.generations.get(id) ?? (() => { throw new RequestError(404, 'Generation not found.'); })();
    return { generation: withProgress(found) };
  });
  // What is queued or running in a project right now, with progress (for "watch my jobs" in chat).
  route('GET', `/api/projects/${uuid}/active-jobs`, (req, [id]) => {
    if (!repo.projects.get(id)) throw new RequestError(404, 'Project not found.');
    const jobsNow = repo.generations.listByProject(id, 500).filter((g) => g.status === 'queued' || g.status === 'running').reverse()
      .map((g) => ({ id: g.id, status: g.status, operation: g.operation, provider: g.provider, model: g.model, prompt: g.prompt?.slice(0, 200) ?? '',
        bookTarget: g.bookTarget ?? null, createdAt: g.createdAt, progress: g.status === 'running' ? jobs.progress(g.id) : null }));
    return { jobs: jobsNow };
  });
  route('POST', `/api/generations/${uuid}/cancel`, (req, [id]) => {
    const result = jobs.cancel(id);
    if (!result.ok) throw new RequestError(result.status, result.reason);
    return { generation: result.generation };
  });
  route('POST', `/api/generations/${uuid}/wait`, async (req, [id]) => {
    const { timeoutMs } = await readBody(req, 1024);
    const done = await jobs.waitFor(id, Math.min(Number(timeoutMs) || 120_000, 600_000));
    if (!done) throw new RequestError(404, 'Generation not found.');
    return { generation: done };
  });
  route('POST', `/api/generations/${uuid}/retry`, async (req, [id]) => {
    const body = await readBody(req, 1024);
    return { status: 202, body: { generation: generations.retry(id, { confirmUncertain: body.confirmUncertain === true, approvalId: typeof body.approvalId === 'string' ? body.approvalId : undefined }) } };
  });

  // Budget. Limits can only be changed from the app itself, never by an MCP client.
  const appOnly = (what) => {
    if (currentRequest().source === 'mcp') throw new RequestError(403, `${what} can only be changed in the Lumina app.`);
  };
  const budgetCall = (fn) => {
    try {
      return fn();
    } catch (error) {
      throw error.status && !(error instanceof RequestError) ? new RequestError(error.status, error.message) : error;
    }
  };
  route('GET', '/api/providers/openrouter/credits', async (req, params, url) => ({ status: 200, body: await credits.status({ refresh: url.searchParams.get('refresh') === 'true' }) }));
  route('GET', '/api/budget', () => budget.status());
  route('PUT', '/api/budget', async (req) => {
    appOnly('Budget limits');
    const body = await readBody(req, 4096);
    return budgetCall(() => budget.update(body));
  });
  route('POST', `/api/budget/approvals/${uuid}`, async (req, [id]) => {
    const body = await readBody(req, 1024);
    return { approval: budgetCall(() => budget.decide(id, body.approve === true, currentRequest().source)) };
  });
  route('POST', `/api/budget/spend/${uuid}`, async (req, [id]) => {
    appOnly('Recorded charges');
    const body = await readBody(req, 1024);
    const row = budgetCall(() => budget.resolve(id, body.actualUsd));
    if (repo.generations.get(id)) repo.generations.update(id, { billing: row.status === 'released' ? 'none' : row.status });
    return { spend: row };
  });
  // Estimates for planning (no job is created): a list of { provider, model, operation, duration, resolution, size, image }.
  function estimate(items) {
    const lines = items.map((item) => {
      const model = providers.model(item.provider, item.model);
      if (!model) return { ...item, usd: null, note: 'Unknown model' };
      const resolution = item.operation === 'video' && model.resolutions?.length ? (model.resolutions.includes(item.resolution) ? item.resolution : defaultResolution(model)) : null;
      const duration = item.operation === 'video' ? nearestDuration(model.durations, item.duration) : undefined;
      let usd = estimateUsd(priceFor(item.provider, model.id, model), { size: item.size, duration, resolution, image: Boolean(item.image) });
      if (usd == null && item.operation === 'speech' && !budget.settings().strictPrices) usd = budget.settings().speechAssumedUsd ?? 0.05;
      return { ...item, duration, resolution, usd: usd == null ? null : Math.round(usd * 10000) / 10000, note: usd == null ? 'No published price' : null };
    });
    const known = lines.filter((l) => l.usd != null);
    const status = budget.status();
    const totalUsd = Math.round(known.reduce((sum, l) => sum + l.usd, 0) * 100) / 100;
    return {
      lines, totalUsd, unpriced: lines.length - known.length, remainingUsd: status.settings.enabled ? status.remainingUsd : null,
      fits: status.settings.enabled ? totalUsd <= status.remainingUsd - (status.settings.retryReserveUsd ?? 0) && lines.length === known.length : null,
    };
  }
  route('POST', '/api/budget/estimate', async (req) => {
    const body = await readBody(req, 256 * 1024);
    return estimate(Array.isArray(body.items) ? body.items.slice(0, 500) : []);
  });
  // What finishing a storyboard would still cost: missing frames, missing clips (still shots are free) and
  // unrecorded dialogue lines.
  route('GET', `/api/storyboards/${uuid}/estimate`, (req, [id]) => storyboardEstimate(id));
  function storyboardEstimate(id) {
    const { sequence, shots } = sequences.detail(id);
    const s = sequence.settings;
    const items = [];
    for (const shot of shots) {
      if (!shot.imageAssetId) items.push({ shot: shot.position, operation: 'generate', provider: s.imageProvider, model: s.imageModel, size: '1536x1024' });
      if (!shot.videoAssetId && shot.details.method !== 'still') {
        const [provider, model] = shot.details.model ? shot.details.model.split('|') : [s.videoProvider, s.videoModel];
        items.push({ shot: shot.position, operation: 'video', provider, model, duration: shot.duration, image: true });
      }
      for (const line of shot.details.dialogue) {
        const speaker = line.speaker === 'narrator' ? null : repo.characters.get(line.speaker);
        const voice = speaker?.voice ?? s.narratorVoice;
        if (!line.assetId && voice) items.push({ shot: shot.position, operation: 'speech', provider: voice.provider, model: voice.model });
      }
    }
    const result = estimate(items);
    const videoSeconds = shots.filter((sh) => sh.details.method !== 'still').reduce((sum, sh) => sum + (sh.duration ?? 0), 0);
    return { ...result, videoSeconds, stillSeconds: shots.reduce((sum, sh) => sum + (sh.duration ?? 0), 0) - videoSeconds };
  }
  // Face identity check: free models, downloaded only when the person asks in the app.
  route('GET', '/api/faces', () => faces?.status() ?? { installed: false, unavailable: true });
  route('POST', '/api/faces/install', async () => {
    appOnly('Installing the face check');
    if (!faces) throw new RequestError(501, 'The face check is not available here.');
    try {
      return await faces.install();
    } catch (error) {
      throw new RequestError(502, error.message);
    }
  });
  // Upscaler (Real-ESRGAN) and frame interpolation (RIFE): installed, or downloaded when the person asks in the app.
  route('GET', '/api/enhancer', async () => (enhancer ? enhancer.tools() : { ai: false, rife: false, unavailable: true }));
  route('POST', '/api/enhancer/install', async (req) => {
    appOnly('Installing the upscaler');
    const { tool } = await readBody(req, 1024);
    if (!enhancer) throw new RequestError(501, 'Enhancing is not available here.');
    if (!['ai', 'rife'].includes(tool)) throw new RequestError(400, 'Choose ai (Real-ESRGAN) or rife.');
    try {
      await (tool === 'ai' ? enhancer.aiTool({ allowDownload: true }) : enhancer.rifeTool({ allowDownload: true }));
    } catch (error) {
      throw new RequestError(error.status ?? 502, error.message);
    }
    return enhancer.tools();
  });
  route('GET', '/api/models/status', () => modelCatalog.status());
  route('POST', '/api/models/refresh', async () => {
    try {
      await modelCatalog.refresh();
    } catch (error) {
      throw new RequestError(502, `Could not read OpenRouter's model list: ${error.message}`);
    }
    return { ...modelCatalog.status(), catalog: catalog() };
  });

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
      return { ok: false, message: error.category === 'budget_limit' ? error.message : userMessage(error) };
    }
  });

  route('GET', '/api/settings/remote', () => remote.status());
  route('PUT', '/api/settings/remote', async (req) => remote.update(await readBody(req, 4096)));
  route('GET', '/api/settings/account', () => remote.account());
  route('PUT', '/api/settings/account', async (req) => {
    try {
      return remote.setAccount(await readBody(req, 4096));
    } catch (error) {
      throw error.status ? new RequestError(error.status, error.message) : error;
    }
  });
  route('POST', '/api/settings/remote/online', async (req) => {
    const body = await readBody(req, 1024);
    try {
      return await remote.goOnline({ allowDownload: body.download === true });
    } catch (error) {
      if (error.needsDownload || error.needsAccount) return { status: 428, body: { error: error.message, needsDownload: Boolean(error.needsDownload), needsAccount: Boolean(error.needsAccount) } };
      throw error.status ? new RequestError(error.status, error.message) : error;
    }
  });
  route('POST', '/api/settings/remote/offline', () => remote.goOffline());
  route('POST', '/api/settings/remote/revoke', () => {
    remote.revokeAll();
    return remote.status();
  });

  // ---------- Characters ----------
  const needCharacter = (id) => repo.characters.get(id) ?? (() => { throw new RequestError(404, 'Character not found.'); })();
  const withReferences = (character) => ({
    ...character,
    references: character.referenceAssetIds.map((id) => repo.assets.get(id)).filter((a) => a?.mimeType.startsWith('image/')).map((a) => ({ id: a.id, path: a.path })),
  });
  // Characters, products and locations (sets). Locked ones are approved model sheets: their look and reference
  // images cannot be changed until they are unlocked on purpose, so a shot can't silently get a different face.
  function characterFields(body, existing = null) {
    const fields = {};
    if (body.name !== undefined) fields.name = body.name;
    if (body.kind !== undefined) fields.kind = ['product', 'location'].includes(body.kind) ? body.kind : 'character';
    if (body.description !== undefined) fields.description = String(body.description ?? '').slice(0, 2500);
    if (body.referenceAssetIds !== undefined) {
      const ids = [...new Set(Array.isArray(body.referenceAssetIds) ? body.referenceAssetIds : [])];
      if (ids.length > 6) throw new RequestError(400, 'Use at most 6 reference images (for example front, side, three-quarter, back, close-up, full body).');
      if (ids.some((id) => !repo.assets.get(id)?.mimeType.startsWith('image/'))) throw new RequestError(404, 'A reference image was not found.');
      fields.referenceAssetIds = ids;
    }
    if (body.voice !== undefined) {
      if (body.voice === null) fields.voice = null;
      else {
        const { provider, model, voice } = body.voice ?? {};
        const found = providers.model(provider, model);
        if (!found?.operations.includes('speech')) throw new RequestError(400, 'Choose a voice model that can speak.');
        // A custom voice that no longer exists is an error, never silently another voice (as in generation.js).
        if (String(voice ?? '').startsWith('custom:') && !found.voices?.includes(voice)) throw new RequestError(400, `The custom voice ${voice} no longer exists. Pick another with list_voices.`);
        fields.voice = { provider, model, voice: found.voices?.includes(voice) ? voice : found.voices?.[0] ?? null };
      }
    }
    if (body.designTags !== undefined) fields.designTags = String(body.designTags ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (body.locked !== undefined) fields.locked = body.locked === true;
    const changesLook = ['name', 'kind', 'description', 'referenceAssetIds', 'designTags'].some((key) => key in fields);
    if (existing?.locked && fields.locked !== false && changesLook) {
      throw new RequestError(409, `${existing.name} is locked (approved). Unlock it first if you really mean to change the look.`);
    }
    return fields;
  }
  route('GET', '/api/characters', () => ({ characters: repo.characters.list().map(withReferences) }));
  route('POST', '/api/characters', async (req) => {
    const fields = characterFields(await readBody(req, 16_384));
    if (!String(fields.name ?? '').trim()) throw new RequestError(400, 'Give the character a name.');
    return { status: 201, body: { character: withReferences(repo.characters.create(fields)) } };
  });
  route('PATCH', `/api/characters/${uuid}`, async (req, [id]) => {
    needCharacter(id);
    return { character: withReferences(repo.characters.update(id, characterFields(await readBody(req, 16_384), needCharacter(id)))) };
  });
  // Character sheet: one turnaround (or expression) sheet generation whose result becomes the character's first reference.
  const stableSeed = (id) => {
    let hash = 2166136261;
    for (const ch of id) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
    return hash % 2147483646;
  };
  // Bake a character into a LoRA for the local anime model (free, this computer's GPU, ~15-25 minutes).
  route('GET', `/api/characters/${uuid}/bake`, (req, [id]) => bake.status(id));
  // Baking has a review step: POST draws the pictures and stops (state "review"); the person approves/rejects them
  // (+ mirror flags), can redraw rejected ones, then trains on the approved ones. {auto: true} does it all in one go.
  route('POST', `/api/characters/${uuid}/bake`, async (req, [id]) => {
    const body = await readBody(req, 1024);
    return { status: 202, body: await bake.start(id, { steps: Number.isFinite(Number(body.steps)) ? Number(body.steps) : undefined, auto: body.auto === true, mirrorOk: body.mirrorOk !== false }) };
  });
  route('POST', `/api/characters/${uuid}/bake/review`, async (req, [id]) => bake.review(id, await readBody(req, 8192)));
  route('POST', `/api/characters/${uuid}/bake/redraw`, async (req, [id]) => ({ status: 202, body: bake.redraw(id, await readBody(req, 4096)) }));
  route('POST', `/api/characters/${uuid}/bake/train`, async (req, [id]) => {
    const body = await readBody(req, 1024);
    return { status: 202, body: bake.train(id, { steps: Number.isFinite(Number(body.steps)) ? Number(body.steps) : undefined }) };
  });
  // The drawn pictures are served by number (never a client-supplied path), straight out of the character's bake folder.
  route('GET', `/api/characters/${uuid}/bake/pictures/(\\d{1,3})`, async (req, [id, index], url, res) => {
    needCharacter(id);
    return serveFile(res, path.resolve(bake.dir, id), bake.pictureFile(id, Number(index)), { 'cache-control': 'no-cache' });
  });
  route('DELETE', `/api/characters/${uuid}/bake`, async (req, [id]) => bake.remove(id));
  route('POST', `/api/characters/${uuid}/sheet`, async (req, [id]) => {
    const body = await readBody(req, 16_384);
    const character = needCharacter(id);
    if (character.locked) throw new RequestError(409, `${character.name} is locked (approved). Unlock it first to add a new sheet.`);
    const tags = character.designTags || character.description.replace(/\s+/g, ' ').slice(0, 600);
    const views = body.expressions === true
      ? 'expression sheet, multiple views, portrait, smile, angry, sad, surprised, closed eyes, open mouth'
      : 'character sheet, reference sheet, multiple views, turnaround, front view, side view, from behind, full body, standing, same character, simple background, white background';
    const animagine = providers.get('local')?.modelAvailable?.('animagine-xl-4') && providers.model('local', 'animagine-xl-4');
    const [provider, modelId] = animagine && !body.provider ? ['local', 'animagine-xl-4'] : [body.provider, body.model];
    const model = providers.model(provider, modelId);
    const size = model?.sizes?.find((s) => s === '1344x768') ?? model?.sizes?.find((s) => { const [w, h] = s.split('x').map(Number); return w > h; });
    const generation = generations.submit({
      projectId: body.projectId, operation: 'generate', provider, model: modelId, prompt: [views, tags].filter(Boolean).join(', '),
      size, seed: stableSeed(character.id),
    });
    // Attach the finished sheet in the background; the character may have been deleted or locked meanwhile.
    jobs.waitFor(generation.id).then((done) => {
      if (done?.status !== 'completed' || !done.assetId) return;
      const current = repo.characters.get(character.id);
      if (!current || current.locked) return;
      repo.characters.update(character.id, { referenceAssetIds: [done.assetId, ...current.referenceAssetIds.filter((a) => a !== done.assetId)].slice(0, 4) });
    }).catch(() => {});
    return { status: 202, body: { generation } };
  });
  route('DELETE', `/api/characters/${uuid}`, async (req, [id]) => {
    needCharacter(id);
    const deleted = repo.characters.remove(id);
    // Its baked LoRA goes too (a bake still running cleans up after itself when it finishes).
    if (!bake.status(id).job?.busy) await bake.remove(id);
    return { deleted };
  });

  // ---------- Storyboards ----------
  route('GET', '/api/storyboard-options', async () => ({ ffmpeg: await hasFfmpeg(), defaults: cleanSequenceSettings(), lipSync: true, maxShots, maxTargetSeconds, stillMotions }));
  route('GET', `/api/projects/${uuid}/storyboards`, (req, [projectId]) => {
    needProject(projectId);
    return { storyboards: repo.sequences.listByProject(projectId) };
  });
  route('POST', `/api/projects/${uuid}/storyboards`, async (req, [projectId]) => {
    const body = await readBody(req, 32 * 1024);
    return { status: 201, body: sequences.detail(sequences.create({ ...body, projectId }).id) };
  });
  route('POST', `/api/storyboards/${uuid}/import-plan`, async (req, [id]) => sequences.importPlan(id, await readBody(req, 256 * 1024)));
  route('GET', `/api/storyboards/${uuid}`, (req, [id]) => sequences.detail(id));
  route('PATCH', `/api/storyboards/${uuid}`, async (req, [id]) => {
    const body = await readBody(req, 32 * 1024);
    // Music and ambience beds must be audio files of this storyboard's project.
    const cueIds = Array.isArray(body.settings?.musicCues) ? body.settings.musicCues.map((c) => c?.assetId) : [];
    for (const [role, assetId] of [['music', body.settings?.music?.assetId], ['ambience', body.settings?.ambience?.assetId], ...cueIds.map((a) => ['music cue', a])]) {
      if (!assetId) continue;
      const found = repo.assets.get(String(assetId));
      if (!found?.mimeType?.startsWith('audio/') || found.projectId !== sequences.needSequence(id).projectId) throw new RequestError(400, `The ${role} must be an audio file in this storyboard's project.`);
    }
    sequences.update(id, body);
    return sequences.detail(id);
  });
  route('DELETE', `/api/storyboards/${uuid}`, (req, [id]) => {
    sequences.needSequence(id);
    return { deleted: repo.sequences.remove(id) };
  });
  async function productionReadiness(id) {
    const { sequence, shots } = sequences.detail(id);
    const blockers = [];
    const tools = await enhancer.tools();
    if (!(await hasFfmpeg())) blockers.push('Install ffmpeg.');
    if (!shots.length) blockers.push('Import or plan the shots first.');
    if ((sequence.settings.interpolateFps || shots.some((s) => s.details.interpolate)) && !tools.rife) blockers.push('Install RIFE before production.');
    if (['anime', 'ai'].includes(sequence.settings.upscale) && !tools.ai) blockers.push('Install Real-ESRGAN before production.');
    const catalogData = await catalog();
    const modelReady = (providerId, modelId) => {
      const provider = catalogData.providers.find((p) => p.id === providerId);
      const model = provider?.models.find((m) => m.id === modelId);
      return model && provider.ready && model.available !== false;
    };
    const localRuntime = await (providers.get('local')?.runtimeStatus?.() ?? null);
    const costs = [];
    for (const shot of shots) {
      const items = [];
      if (!shot.imageAssetId) items.push({ operation: 'generate', provider: sequence.settings.imageProvider, model: sequence.settings.imageModel, size: '1536x1024' });
      if (!shot.videoAssetId && shot.details.method !== 'still') {
        const [provider, model] = shot.details.model ? shot.details.model.split('|') : [sequence.settings.videoProvider, sequence.settings.videoModel];
        items.push({ operation: 'video', provider, model, duration: shot.duration, image: true });
      }
      for (const line of shot.details.dialogue) {
        if (line.assetId) continue;
        const voice = repo.characters.get(line.speaker)?.voice ?? sequence.settings.narratorVoice;
        if (!voice) blockers.push(`Shot ${shot.position}: configure a voice for ${line.speaker}.`);
        else items.push({ operation: 'speech', provider: voice.provider, model: voice.model });
      }
      for (const item of items) {
        if (!modelReady(item.provider, item.model)) blockers.push(`Shot ${shot.position}: ${item.provider}/${item.model} is unavailable.`);
        if (item.provider === 'local' && item.operation !== 'speech' && (!localRuntime?.gpuAvailable || !localRuntime?.pythonAvailable)) blockers.push(localRuntime?.note ?? 'Local GPU runtime is unavailable.');
      }
      costs.push(...estimate(items).lines);
    }
    const unknown = costs.filter((c) => c.usd == null).length;
    const estimatedUsd = costs.reduce((sum, c) => sum + (c.usd ?? 0), 0);
    const b = budget.status();
    if (b.settings.enabled && b.settings.strictPrices && unknown) blockers.push(`${unknown} request(s) have unknown prices; strict budget will refuse them.`);
    if (b.settings.enabled && estimatedUsd > b.remainingUsd - (b.settings.retryReserveUsd ?? 0)) blockers.push('Estimated work exceeds the remaining budget after the retry reserve.');
    return { ready: blockers.length === 0, blockers: [...new Set(blockers)], estimatedUsd, unknownPrices: unknown, budget: b, tools, localRuntime, lipSync: false };
  }
  route('GET', `/api/storyboards/${uuid}/readiness`, (req, [id]) => productionReadiness(id));
  route('POST', `/api/storyboards/${uuid}/plan`, async (req, [id]) => sequences.plan(id, await readBody(req, 4096)));
  route('POST', `/api/storyboards/${uuid}/stitch`, async (req, [id]) => {
    const body = await readBody(req, 1024);
    const result = await sequences.stitch(id, { wait: body.wait === true });
    return body.wait === true ? result : { status: 202, body: result };
  });
  route('POST', `/api/storyboards/${uuid}/produce`, async (req, [id]) => {
    const readiness = await productionReadiness(id);
    if (!readiness.ready) throw new RequestError(400, `Production not ready: ${readiness.blockers.join(' ')}`);
    // Production keeps submitting in the background, so a paid run is confirmed once, up front, for the whole film.
    const est = storyboardEstimate(id);
    const paidLines = est.lines.filter((line) => !providers.get(line.provider)?.keyless);
    if (paidLines.length) confirmSpend({ estimateUsd: est.totalUsd, unpriced: paidLines.filter((l) => l.usd == null).length, jobs: paidLines.length,
      what: `Produce the film: ${paidLines.length} paid job(s)` });
    return { status: 202, body: await sequences.produce(id) };
  });
  route('POST', `/api/storyboards/${uuid}/stop`, (req, [id]) => sequences.stopProduction(id));
  // Frame interpolation: RIFE makes the in-between frames so the video plays at `fps` (same length). The result is a
  // new video in the library. Clips with a cut are refused (it would blend two shots).
  route('POST', `/api/assets/${uuid}/interpolate`, async (req, [id]) => {
    const body = await readBody(req, 1024);
    const asset = repo.assets.get(id);
    if (!asset) throw new RequestError(404, 'Asset not found.');
    if (!asset.mimeType?.startsWith('video/')) throw new RequestError(400, 'Only videos can be interpolated.');
    const fps = Number(body.fps ?? 30);
    if (!Number.isInteger(fps) || fps < 2 || fps > 120) throw new RequestError(400, 'Choose a whole frame rate from 2 to 120.');
    if (!enhancer) throw new RequestError(501, 'Interpolation is not available here.');
    let result;
    try {
      result = await enhancer.interpolate(assetStore.path(asset), { fps });
    } catch (error) {
      throw new RequestError(error.status ?? 500, error.status === 428 ? `${error.message} Install it in the app (Storyboard → Picture quality → Smooth).` : error.message);
    }
    if (!result) throw new RequestError(400, `This video already plays at ${fps} fps or more.`);
    const saved = await assetStore.save({ bytes: result.bytes, projectId: asset.projectId, kind: 'video', label: `${asset.label ?? 'Video'} (${fps} fps)`, parentAssetId: asset.id });
    return { status: 201, body: { asset: saved, fps: result.fps, duration: result.duration, width: result.width, height: result.height } };
  });
  route('GET', `/api/assets/${uuid}/enhance`, (req, [id]) => ({ enhance: enhancer.status(id) }));
  route('POST', `/api/assets/${uuid}/enhance`, async (req, [id]) => {
    const asset = repo.assets.get(id);
    if (!asset) throw new RequestError(404, 'Video not found.');
    const body = await readBody(req, 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(400, 'Invalid request body.');
    if (body.mode !== undefined && !['fast', 'ai', 'anime'].includes(body.mode)) throw new RequestError(400, 'Choose fast, ai (live action) or anime enhancement.');
    const heights = { 1080: { width: 1920, height: 1080 }, 1440: { width: 2560, height: 1440 }, 2160: { width: 3840, height: 2160 } };
    if (body.height !== undefined && !heights[body.height]) throw new RequestError(400, 'Choose a height of 1080, 1440 or 2160, or leave it out for twice the size.');
    if (body.download !== undefined && typeof body.download !== 'boolean') throw new RequestError(400, 'Download must be true or false.');
    if (!asset.mimeType?.startsWith('video/')) throw new RequestError(400, 'Only videos can be enhanced here (use Upscale for images).');
    if (!(await hasFfmpeg())) throw new RequestError(501, 'Enhancing video needs ffmpeg (on Debian/Ubuntu: sudo apt install ffmpeg).');
    try {
      const job = await enhancer.start({ asset, assetStore, mode: body.mode ?? 'fast', allowDownload: body.download === true, target: heights[body.height] ?? null });
      return { status: 202, body: { enhance: job } };
    } catch (error) {
      if (error.needsDownload) return { status: 428, body: { error: error.message, needsDownload: true } };
      throw error.status ? new RequestError(error.status, error.message) : error;
    }
  });
  route('POST', `/api/storyboards/${uuid}/shots`, async (req, [id]) => {
    sequences.needSequence(id);
    const body = await readBody(req, 16_384);
    const count = repo.shots.listBySequence(id).length;
    if (count >= maxShots) throw new RequestError(400, `A storyboard can have at most ${maxShots} shots.`);
    repo.shots.insert(id, { position: count + 1, description: String(body.description ?? '').slice(0, 2000) });
    return { status: 201, body: sequences.detail(id) };
  });
  route('PATCH', `/api/shots/${uuid}`, async (req, [id]) => {
    const body = await readBody(req, 64 * 1024);
    // Sound effects must be audio files of the shot's project.
    if (Array.isArray(body.details?.sfx)) {
      const projectId = sequences.needSequence(sequences.needShot(id).sequenceId).projectId;
      for (const effect of body.details.sfx) {
        const found = effect?.assetId ? repo.assets.get(String(effect.assetId)) : null;
        if (!found?.mimeType?.startsWith('audio/') || found.projectId !== projectId) throw new RequestError(400, 'A sound effect must be an audio file in this storyboard\'s project.');
      }
    }
    return sequences.updateShot(id, body);
  });
  route('POST', `/api/shots/${uuid}/review`, async (req, [id]) => sequences.review(id, await readBody(req, 4096)));
  route('POST', `/api/shots/${uuid}/approve-frame`, async (req, [id]) => sequences.approveFrame(id, (await readBody(req, 1024)).approved !== false));
  route('POST', `/api/shots/${uuid}/still`, (req, [id]) => sequences.renderStillShot(id));
  // Lip sync a shot's clip to its recorded dialogue (local and free). `box`: the mouth, as fractions of the frame.
  route('POST', `/api/shots/${uuid}/lipsync`, async (req, [id]) => {
    // Anime lip sync (drawn mouth shapes) is on; the live-action model (MuseTalk) is still experimental.
    const settings = sequences.needSequence(sequences.needShot(id).sequenceId).settings;
    if (settings.lipSync !== true) throw new RequestError(409, 'Lip sync is turned off for this storyboard (Settings).');
    const anime = settings.look === 'anime';
    if (!anime && process.env.LUMINA_EXPERIMENTAL_LIPSYNC !== '1') throw new RequestError(501, 'Lip sync works on anime storyboards (Look: anime). Live-action lip sync is still experimental.');
    const body = await readBody(req, 4096);
    try {
      return await sequences.lipSyncShot(id, { box: Array.isArray(body.box) ? body.box.slice(0, 4).map(Number) : null });
    } catch (error) {
      if (error.needBox) return { status: 422, body: { error: error.message, needBox: true } };
      throw error;
    }
  });
  route('POST', `/api/shots/${uuid}/checks`, async (req, [id]) => {
    const checks = await sequences.runChecks(id);
    if (!checks) throw new RequestError(400, 'This shot has no clip to check yet.');
    return sequences.detail(sequences.needShot(id).sequenceId);
  });
  route('POST', `/api/shots/${uuid}/dialogue`, (req, [id]) => ({ status: 202, body: sequences.makeDialogue(id) }));
  // Re-voice one line (optionally with a new acting direction); its timing (details.dialogue[i].start) is kept.
  route('POST', `/api/shots/${uuid}/dialogue/(\\d{1,2})/rerecord`, async (req, [id, index]) => ({ status: 202, body: sequences.rerecordLine(id, Number(index), await readBody(req, 4096)) }));
  // Takes: every frame and clip the shot has had; pick one, attach an imported video, or repair part of the frame.
  route('GET', `/api/shots/${uuid}/takes`, (req, [id]) => sequences.takes(id));
  route('POST', `/api/shots/${uuid}/takes/select`, async (req, [id]) => sequences.selectTake(id, await readBody(req, 4096)));
  route('POST', `/api/shots/${uuid}/attach-clip`, async (req, [id]) => sequences.attachClip(id, await readBody(req, 4096)));
  route('POST', `/api/shots/${uuid}/repair-frame`, async (req, [id]) => ({ status: 202, body: await sequences.repairFrame(id, await readBody(req, 8192)) }));
  route('POST', `/api/storyboards/${uuid}/export-project`, async (req, [id]) => sequences.exportProject(id, exportDir));
  route('DELETE', `/api/shots/${uuid}`, (req, [id]) => {
    const shot = sequences.needShot(id);
    repo.shots.remove(id);
    return sequences.detail(shot.sequenceId);
  });
  route('POST', `/api/shots/${uuid}/move`, async (req, [id]) => {
    const shot = sequences.needShot(id);
    repo.shots.move(id, (await readBody(req, 1024)).direction === 'up' ? -1 : 1);
    return sequences.detail(shot.sequenceId);
  });
  route('GET', `/api/shots/${uuid}`, (req, [id]) => {
    const shot = sequences.needShot(id);
    const detail = sequences.detail(shot.sequenceId);
    return { shot: detail.shots.find((s) => s.id === id), sequenceId: shot.sequenceId };
  });
  // Contact sheets: one JPEG to show in chat. A storyboard's frames (or each clip's middle frame), or six moments of
  // one shot's clip.
  const sheetResponse = (res, bytes) => {
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(bytes);
  };
  const assetFile = (assetId) => {
    const found = assetId ? repo.assets.get(assetId) : null;
    return found ? assetStore.path(found) : null;
  };
  route('GET', `/api/storyboards/${uuid}/contact-sheet`, async (req, [id], url, res) => {
    sequences.needSequence(id);
    const clips = url.searchParams.get('kind') === 'clips';
    const tiles = [];
    for (const shot of sequences.detail(id).shots) {
      const file = assetFile(clips ? shot.videoAssetId : shot.imageAssetId);
      if (!file) continue;
      const time = clips ? Math.max(0, ((await probe(file).catch(() => null))?.duration ?? 0) / 2) : null;
      tiles.push({ file, time, label: `#${shot.position}` });
    }
    if (!tiles.length) throw new RequestError(404, clips ? 'No shot has a clip yet.' : 'No shot has a frame yet.');
    sheetResponse(res, await contactSheet(tiles, { columns: tiles.length > 9 ? 5 : 4, width: tiles.length > 12 ? 256 : 320 }));
  });
  route('GET', `/api/shots/${uuid}/contact-sheet`, async (req, [id], url, res) => {
    const shot = sequences.needShot(id);
    const file = assetFile(shot.videoAssetId);
    if (!file) throw new RequestError(404, 'This shot has no clip yet.');
    const info = await probe(file).catch(() => null);
    if (!info?.duration) throw new RequestError(422, 'The clip could not be read.');
    const last = Math.max(0, info.duration - 1 / (info.fps || 24));
    const tiles = Array.from({ length: 6 }, (_, i) => ({ file, time: last * i / 5, label: `${(last * i / 5).toFixed(1)}s` }));
    sheetResponse(res, await contactSheet(tiles, { columns: 3, width: 384 }));
  });
  route('POST', `/api/shots/${uuid}/frame`, async (req, [id]) => ({ status: 202, body: sequences.generateFrame(id, await readBody(req, 4096)) }));
  route('POST', `/api/shots/${uuid}/animate`, async (req, [id]) => ({ status: 202, body: sequences.animate(id, await readBody(req, 4096)) }));

  // ---------- Canvas ----------
  const userTemplate = (id) => (/^user:/.test(String(id)) ? repo.canvasTemplates.get(String(id).slice(5)) : null);
  route('GET', '/api/templates', () => ({
    templates: [
      ...Object.entries(templates).map(([id, t]) => ({ id, name: t.name, builtIn: true })),
      ...repo.canvasTemplates.list().map((t) => ({ id: `user:${t.id}`, name: t.name, builtIn: false })),
    ],
  }));
  route('POST', '/api/templates', async (req) => {
    const body = await readBody(req, 16_384);
    const canvas = needCanvas(body.canvasId);
    if (!canvas.graph.nodes.length) throw new RequestError(400, 'Add some nodes before saving a template.');
    const saved = repo.canvasTemplates.create(body.name || canvas.name, canvas.graph);
    return { status: 201, body: { template: { id: `user:${saved.id}`, name: saved.name, builtIn: false } } };
  });
  route('DELETE', `/api/templates/user:${uuid}`, (req, [id]) => ({ deleted: repo.canvasTemplates.remove(id) }));
  route('POST', `/api/projects/${uuid}/canvases`, async (req, [projectId]) => {
    needProject(projectId);
    const body = await readBody(req, 16_384);
    const template = templates[body.template] ?? userTemplate(body.template);
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
    // A canvas run submits in the background, so paid nodes are confirmed once, before it starts.
    const defaults = body.defaults ?? {};
    const paidNodes = needCanvas(id).graph.nodes.filter((node) => {
      const data = node.data ?? {};
      if (['generate', 'edit', 'video'].includes(node.type)) return !providers.get(data.provider || defaults.provider)?.keyless;
      if (node.type === 'director') return !directors.get(String(data.director || defaults.director || '').split(':')[0])?.keyless;
      return false;
    });
    if (paidNodes.length) confirmSpend({ estimateUsd: null, jobs: paidNodes.length, what: `this canvas run has ${paidNodes.length} paid step(s)` });
    const { run } = canvasRunner.start(id, { targetNodeId: body.nodeId ?? null, defaults });
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
  route('POST', `/api/projects/${uuid}/books/import`, async (req, [projectId]) => {
    needProject(projectId);
    const body = await readBody(req, 40 * 1024 * 1024);
    const bytes = typeof body.text === 'string' ? Buffer.from(body.text, 'utf8')
      : typeof body.dataBase64 === 'string' && /^[A-Za-z0-9+/=]*$/.test(body.dataBase64) ? Buffer.from(body.dataBase64, 'base64') : null;
    if (!bytes?.length) throw new RequestError(400, 'Choose a .txt, .md or .docx file.');
    const writer = typeof body.writer === 'string' && body.writer ? body.writer : null;
    return { status: 201, body: books.importManuscript({ projectId, fileName: text(body.fileName, 200) ?? '', bytes, title: text(body.title, 80), kind: body.kind, writer }) };
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
    if (format === 'epub') {
      const fixed = url.searchParams.get('layout') === 'fixed' && book.kind === 'picture_book';
      return sendDownload(res, await books.exportEpub(id, { layout: fixed ? 'fixed' : 'reflowable' }), 'application/epub+zip', `${name}${fixed ? '-fixed' : ''}.epub`);
    }
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
        // MCP servers mark their calls; the app's own pages do not. Budget approvals use this to keep the decision
        // with the person unless they allowed MCP clients to approve.
        const context = {
          source: req.headers['x-lumina-client'] === 'mcp' ? 'mcp' : 'app',
          confirmSpend: req.headers['x-lumina-confirm-spend'] === '1',
          confirmPaid: budget.settings().confirmPaid !== false,
          approvalId: /^[a-f0-9-]{36}$/.test(String(req.headers['x-lumina-approval-id'] ?? '')) ? req.headers['x-lumina-approval-id'] : null,
        };
        const result = await requestContext.run(context, () => r.handler(req, match.slice(1), url, res));
        if (res.headersSent) return undefined;
        return result?.status ? send(res, result.status, result.body) : send(res, 200, result);
      }
      if (protectedPath) return send(res, 404, { error: 'Not found' });
      if (req.method === 'GET') return serveFile(res, publicDir, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
      return send(res, 405, { error: 'Method not allowed' });
    } catch (error) {
      if (error instanceof RequestError) return send(res, error.status, { error: error.message, ...(error.extra ?? {}) });
      console.error('Request failed', { path: url.pathname, detail: error?.message });
      return send(res, error.status || 500, { error: error.status ? error.message : 'The request could not be completed.' });
    }
  });
  return server;
}
