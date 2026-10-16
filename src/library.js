import { lstatSync, readdirSync, statfsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { RequestError } from './generation.js';
import { maxShots } from './sequences.js';

const invalid = (message) => { throw new RequestError(400, message); };
const idSchema = z.string().regex(/^[a-f0-9-]{36}$/i);
const record = z.record(z.string(), z.unknown());
const optionalText = z.string().max(6000).optional();
const optionalNumber = z.number().finite().optional();
const voiceSchema = z.object({ provider: z.string(), model: z.string(), voice: z.string().nullable().optional() }).passthrough().nullable().optional();
const bedSchema = z.object({ assetId: idSchema.nullable(), volume: optionalNumber }).passthrough().nullable().optional();
const strings = (...keys) => Object.fromEntries(keys.map((key) => [key, optionalText]));
const booleans = (...keys) => Object.fromEntries(keys.map((key) => [key, z.boolean().optional()]));
const settingsSchema = z.object({
  ...strings('style', 'imageProvider', 'imageModel', 'videoProvider', 'videoModel', 'lookBible'),
  ...booleans('lipSync', 'requireApproval', 'realistic'),
  shotCount: z.number().int().min(1).max(maxShots).optional(), targetSeconds: z.number().int().min(0).max(900).optional(),
  videoSecondsBudget: z.number().int().min(0).max(900).optional(), clipLength: z.number().int().min(0).max(30).optional(),
  aspect: z.enum(['16:9', '9:16', '1:1']).optional(), look: z.enum(['live-action', 'anime', 'as-written']).optional(),
  continuity: z.enum(['frames', 'keyframes', 'chain']).optional(), seed: z.number().int().nonnegative().nullable().optional(),
  transition: z.enum(['cut', 'crossfade']).optional(), finish: z.enum(['none', 'cinematic', 'anime']).optional(),
  outputHeight: z.union([z.literal(720), z.literal(1080), z.literal(1440), z.literal(2160)]).optional(),
  upscale: z.enum(['none', 'fast', 'anime', 'ai']).optional(), interpolateFps: z.union([z.literal(0), z.literal(30)]).optional(),
  colorMatch: z.enum(['off', 'scene', 'film']).optional(), clipVolume: z.number().min(0).max(2).optional(),
  characterIds: z.array(idSchema).max(8).optional(), music: bedSchema, ambience: bedSchema,
  musicCues: z.array(z.object({ shotId: idSchema, assetId: idSchema.nullable(), volume: optionalNumber }).passthrough()).max(20).optional(),
  narratorVoice: voiceSchema, themes: z.array(z.string().max(300)).max(8).optional(),
}).passthrough();
const detailsSchema = z.object({
  ...strings('scene', 'action', 'startState', 'endState', 'forbidden', 'model', 'motion'),
  ...booleans('directorKeepAutomatic', 'interpolate', 'keepPitch', 'muteClipSound', 'locked'),
  directorFramePrompt: z.string().nullable().optional(), directorClipPrompt: z.string().nullable().optional(), directorNegative: z.string().nullable().optional(),
  method: z.enum(['video', 'still']).optional(), timing: z.enum(['auto', 'ones', 'twos', 'threes']).optional(),
  trimStart: z.number().min(0).max(600).optional(), speed: z.number().min(0.25).max(4).optional(),
  cutTransition: z.object({ transition: z.string(), seconds: z.number().min(0).max(10) }).passthrough().nullable().optional(),
  overlays: z.array(z.object({ text: z.string().max(2000), position: z.string(), style: z.string(),
    start: z.number().finite().nonnegative(), seconds: z.number().finite().positive() }).passthrough()).max(24).optional(),
  grade: z.object({ brightness: optionalNumber, contrast: optionalNumber, saturation: optionalNumber, warmth: optionalNumber }).passthrough().nullable().optional(),
  characterIds: z.array(idSchema).max(6).optional(), locationId: idSchema.nullable().optional(),
  dialogue: z.array(z.object({ speaker: z.string(), text: z.string().max(1000), assetId: idSchema.nullable().optional(),
    style: optionalText, start: z.number().finite().nonnegative().nullable().optional(), seconds: z.number().finite().nonnegative().nullable().optional() }).passthrough()).max(12).optional(),
  sfx: z.array(z.object({ assetId: idSchema.nullable(), at: optionalNumber, volume: optionalNumber, label: optionalText }).passthrough()).max(12).optional(),
  attachedClips: z.array(idSchema).max(200).optional(), themes: z.array(z.string()).max(4).optional(),
  holds: z.array(z.object({ start: z.number().finite().nonnegative(), seconds: z.number().finite().positive() }).passthrough()).max(8).optional(),
}).passthrough();
const unsafeKey = (key) => /path|(?:file(?:name)?s?|url|uri)s?$/i.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key);
const planSchema = z.object({
  format: z.literal('lumina-storyboard'), version: z.literal(1), title: z.string().trim().min(1).max(80),
  idea: z.string().max(6000), screenplay: z.string().max(60000), settings: settingsSchema,
  shots: z.array(z.object({
    id: idSchema, description: z.string().max(2000), camera: z.string().max(200).nullable(),
    duration: z.number().finite().min(1 / 24).max(30).nullable(), details: detailsSchema,
    imageAssetId: idSchema.nullable(), videoAssetId: idSchema.nullable(), sceneState: record.nullable().optional(),
  }).strict()).max(maxShots),
}).strict();
const idsSchema = z.array(idSchema).min(1).max(200);
const tagSchema = z.array(z.string().trim().min(1).max(80)).max(50);
const compare = (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
const compact = ({ id, projectId, kind, mimeType, size, label, createdAt, parentAssetId }) => ({ id, projectId, kind, mimeType, size, label: label?.slice(0, 200) ?? null, createdAt, parentAssetId });
const parse = (schema, value) => { const result = schema.safeParse(value); if (!result.success) invalid(`Invalid library input: ${result.error.issues[0].path.join('.')}: ${result.error.issues[0].message}`); return result.data; };
const pagination = (input) => parse(z.object({ offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(100).default(30) }), input);
const page = (items, { offset, limit }, key) => ({ [key]: items.slice(offset, offset + limit), total: items.length, offset, limit, nextOffset: offset + limit < items.length ? offset + limit : null });

// Plans contain IDs, never locations on disk. Reject path-bearing keys at every depth,
// including unfamiliar extension fields, rather than passing them to another service.
function checkPortable(value, depth = 0) {
  if (depth > 30) invalid('Plan is nested too deeply.');
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (unsafeKey(key)) invalid(`Embedded paths or unsafe keys are not allowed: ${key}.`);
    if (/AssetIds$|characterIds$/.test(key)) parse(z.array(idSchema).max(200), child);
    else if (/AssetId$/.test(key) || key === 'assetId' || key === 'locationId' || key === 'shotId') parse(idSchema.nullable(), child);
    if (key === 'speaker' && !['narrator', 'none'].includes(child)) parse(idSchema, child);
    if (['dialogue', 'sfx', 'musicCues', 'characters', 'holds', 'themes'].includes(key) && !Array.isArray(child)) invalid(`${key} must be an array.`);
    checkPortable(child, depth + 1);
  }
}
function stripRuntime(value) {
  if (Array.isArray(value)) return value.map(stripRuntime);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !unsafeKey(key)
    && !['review', 'frameApproved', 'approvals', 'approved', 'outputAssetId', 'post', 'lipsync', 'production', 'join'].includes(key))
    .map(([key, child]) => [key, stripRuntime(child)]));
}

export function createLibraryService({ repo, assetStore, exportDir, sequences }) {
  const needProject = (id) => repo.projects.get(id) ?? (() => { throw new RequestError(404, 'Project not found.'); })();
  const needAsset = (id) => repo.assets.get(id) ?? (() => { throw new RequestError(404, 'Asset not found.'); })();
  const needBoard = (id) => repo.sequences.get(id) ?? (() => { throw new RequestError(404, 'Storyboard not found.'); })();
  const allAssets = () => repo.projects.list().flatMap((p) => repo.assets.listByProject(p.id));
  const allGenerations = () => repo.projects.list().flatMap((p) => repo.generations.listByProject(p.id, -1));
  const tagsOf = (id) => repo.settings.get(`asset-tags:${id}`, []);
  function tagAssets({ assetIds, add = [], remove = [] }) {
    const ids = [...new Set(parse(idsSchema, assetIds))];
    add = parse(tagSchema, add); remove = parse(tagSchema, remove);
    ids.forEach(needAsset);
    return repo.transaction(() => {
      const index = new Set(repo.settings.get('asset-tags:index', []));
      const assets = ids.map((id) => {
        const tags = [...new Set([...tagsOf(id), ...add])].filter((tag) => !remove.includes(tag)).sort();
        repo.settings.set(`asset-tags:${id}`, tags);
        if (tags.length) index.add(id); else index.delete(id);
        return { id, tags };
      });
      repo.settings.set('asset-tags:index', [...index].sort());
      return { assets };
    });
  }
  function generationInfo(g) {
    if (!g) return null;
    const spend = repo.spend.get(g.id);
    return { id: g.id, projectId: g.projectId, status: g.status, operation: g.operation, provider: g.provider, model: g.model,
      prompt: g.prompt?.slice(0, 2000) ?? '', createdAt: g.createdAt, assetId: g.assetId,
      billing: g.billing, billingState: g.billingState,
      cost: { estimatedUsd: spend?.estimatedUsd ?? null, actualUsd: spend?.actualUsd ?? null, state: spend?.status ?? null } };
  }
  function searchAssets(input = {}) {
    const paging = pagination(input);
    if (input.projectId) needProject(input.projectId);
    const date = (v) => { if (v === undefined) return null; if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\d(?:T.*)?$/.test(v) || !Number.isFinite(Date.parse(v))) invalid('from and to must be ISO dates.'); return Date.parse(v); };
    const from = date(input.from), to = date(input.to);
    if (from !== null && to !== null && from > to) invalid('from must be before to.');
    const text = String(input.text ?? '').toLowerCase();
    const list = (input.projectId ? repo.assets.listByProject(input.projectId) : allAssets()).filter((a) =>
      (!input.kind || a.kind === input.kind) && (!input.tag || tagsOf(a.id).includes(input.tag))
      && (from === null || Date.parse(a.createdAt) >= from) && (to === null || Date.parse(a.createdAt) <= to)
      && (!text || [a.label, ...tagsOf(a.id), a.generationId ? repo.generations.get(a.generationId)?.prompt : ''].some((v) => String(v ?? '').toLowerCase().includes(text))))
      .sort(compare).map((a) => ({ ...compact(a), tags: tagsOf(a.id) }));
    return page(list, paging, 'assets');
  }
  function lineage(assetId) {
    const asset = needAsset(assetId), seen = new Set([assetId]), parents = [], warnings = [];
    const view = (a) => ({ ...compact(a), generation: generationInfo(a.generationId ? repo.generations.get(a.generationId) : null) });
    let parent = asset.parentAssetId;
    while (parent) {
      if (seen.has(parent)) { warnings.push('Cycle in parent lineage.'); break; }
      seen.add(parent);
      const found = repo.assets.get(parent);
      if (!found) { warnings.push(`Missing parent ${parent}.`); break; }
      parents.push(view(found)); parent = found.parentAssetId;
    }
    return { asset: view(asset), parents, children: allAssets().filter((a) => a.parentAssetId === assetId).sort(compare).map(view), warnings };
  }

  // Scan every project: global characters and canvases can refer to another project's assets.
  // Match IDs in arbitrary nested values/keys and paths, so unfamiliar detail fields err toward retention.
  function referenceScan() {
    const assets = allAssets(), used = new Map(), generations = allGenerations();
    const use = (id, reason) => { if (!used.has(id)) used.set(id, new Set()); used.get(id).add(reason); };
    // Ids and stored file names are UUID-based, so each string is matched through an index instead of
    // against every asset; only files with other names (old imports) fall back to a substring check.
    const byToken = new Map(), odd = [];
    const uuidOf = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    for (const a of assets) {
      byToken.set(String(a.id).toLowerCase(), a.id);
      const stem = /^([0-9a-f-]{36})\.[a-z0-9]+$/i.exec(String(a.file ?? ''));
      if (stem) byToken.set(stem[1].toLowerCase(), a.id); else if (a.file) odd.push(a);
    }
    const scan = (value, reason) => {
      if (value === null || value === undefined) return;
      if (typeof value === 'string') {
        for (const token of value.match(uuidOf) ?? []) { const hit = byToken.get(token.toLowerCase()); if (hit) use(hit, reason); }
        for (const a of odd) if (value.includes(a.file)) use(a.id, reason);
      } else if (typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) { scan(key, reason); scan(child, reason); }
      }
    };
    const liveTargets = new Set();
    for (const character of repo.characters.list()) {
      scan({ ...character, id: null }, `character:${character.id}`);
      scan(repo.settings.get(`bake-review:${character.id}`, null), `character:${character.id}`);
    }
    for (const project of repo.projects.list()) {
      for (const board of repo.sequences.listByProject(project.id)) {
        scan({ ...board, id: null }, `storyboard:${board.id}`);
        scan(repo.settings.get(`joinSettings:${board.id}`, null), `storyboard:${board.id}`);
        scan(repo.settings.get(`visual-review:${board.id}`, []), `visual-review:${board.id}`);
        // These optional repositories are supplied by the film-canon extension when installed.
        const canon = repo.canonHeads?.get(board.id);
        if (canon) {
          for (let revision = 1; revision <= canon.revision; revision += 1) scan(repo.canonRevisions.get(board.id, revision), `canon:${board.id}:${revision}`);
          for (const event of repo.canonEvents.list(board.id)) {
            scan(event.data, `canon-event:${board.id}`);
            if (event.data.snapshotId) scan(repo.canonSnapshots.get(event.data.snapshotId), `canon-snapshot:${board.id}`);
          }
        }
        for (const shot of repo.shots.listBySequence(board.id)) {
          scan({ ...shot, id: null }, `shot:${shot.id}`);
          if (sequences?.takes) scan(sequences.takes(shot.id), `shot-takes:${shot.id}`);
          scan(repo.settings.get(`scene-state:${shot.id}`, null), `shot:${shot.id}`);
          for (const prefix of ['shot-image', 'shot-repair', 'shot-video', 'shot-line']) liveTargets.add(`${prefix}:${shot.id}`);
        }
        const film = repo.films.bySequence(board.id);
        if (film) {
          scan(film, `film:${film.id}`);
          for (const event of repo.filmEvents.list(film.id)) {
            scan(event.data, `film-event:${event.id}`);
            const text = JSON.stringify(event.data);
            for (const g of generations) if (text.includes(g.id)) scan([g.assetId, g.inputAssetIds, g.params], `film-event:${event.id}`);
          }
        }
      }
      for (const book of repo.books.listByProject(project.id)) {
        scan(book, `book:${book.id}`); liveTargets.add(`cover:${book.id}`);
        for (const page of repo.pages.listByBook(book.id)) {
          scan(page, `page:${page.id}`);
          for (const prefix of ['page', 'page-video', 'page-narration']) liveTargets.add(`${prefix}:${page.id}`);
        }
        for (const chapter of repo.chapters.listByBook(book.id)) {
          scan(chapter, `chapter:${chapter.id}`);
          for (const prefix of ['chapter-art', 'chapter-narration']) liveTargets.add(`${prefix}:${chapter.id}`);
        }
      }
      for (const canvas of repo.canvases.listByProject(project.id)) {
        scan(canvas.graph, `canvas:${canvas.id}`);
        for (const run of repo.runs.listByCanvas(canvas.id, -1)) scan(run.nodeState, `canvas-run:${run.id}`);
      }
    }
    for (const template of repo.canvasTemplates.list()) scan(template.graph, `canvas-template:${template.id}`);
    for (const a of assets) if (a.parentAssetId) use(a.parentAssetId, `derived-asset:${a.id}`);
    for (const g of generations) {
      // Inputs and masks remain available for retries; ordinary unattached outputs can be cleaned up.
      scan([g.inputAssetIds, g.params], `generation-input:${g.id}`);
      const target = g.bookTarget?.split(':').slice(0, 2).join(':');
      if (liveTargets.has(target) || ['queued', 'running'].includes(g.status)) scan(g.assetId, `take-or-job:${g.id}`);
      if (g.bookPageId && repo.pages.get(g.bookPageId)) scan(g.assetId, `page-take:${g.bookPageId}`);
    }
    return used;
  }
  function fileInfo(asset) {
    if (path.basename(asset.file) !== asset.file) throw new RequestError(409, 'Unsafe stored asset filename.');
    try {
      const info = lstatSync(assetStore.path(asset));
      if (!info.isFile() || info.isSymbolicLink()) throw new RequestError(409, 'Asset is not a regular local file.');
      return { bytes: info.size, missing: false };
    } catch (error) { if (error.code === 'ENOENT') return { bytes: 0, missing: true }; throw error; }
  }
  function unused(projectId) {
    needProject(projectId);
    const used = referenceScan();
    const assets = repo.assets.listByProject(projectId).filter((a) => !used.has(a.id)).sort(compare).flatMap((a) => {
      try { return [{ ...compact(a), size: fileInfo(a).bytes }]; } catch { return []; } // uncertainty retains the file
    });
    return { projectId, dryRun: true, assets, total: assets.length, bytes: assets.reduce((n, a) => n + a.size, 0) };
  }
  function deleteAssets({ assetIds, confirm }) {
    if (confirm !== true) invalid('Deleting assets requires confirm: true.');
    const ids = [...new Set(parse(idsSchema, assetIds))];
    // Synchronous scan + filesystem work inside the write transaction: no app callback can
    // attach a candidate between the reference check and deletion. Preflight the entire batch.
    return repo.transaction(() => {
      const assets = ids.map(needAsset), used = referenceScan();
      for (const a of assets) if (used.has(a.id)) throw new RequestError(409, `Asset ${a.id} is still referenced (${[...used.get(a.id)].slice(0, 5).join(', ')}).`);
      const files = assets.map(fileInfo), deleted = [], failed = [];
      let bytesFreed = 0;
      for (const [i, a] of assets.entries()) {
        let freed = 0;
        try { if (!files[i].missing) { unlinkSync(assetStore.path(a)); freed = files[i].bytes; } }
        catch (error) { if (error.code !== 'ENOENT') { failed.push({ id: a.id, error: error.message }); continue; } }
        repo.assets.remove(a.id); repo.settings.set(`asset-tags:${a.id}`, []);
        deleted.push(a.id); bytesFreed += freed;
      }
      repo.settings.set('asset-tags:index', repo.settings.get('asset-tags:index', []).filter((id) => !deleted.includes(id)));
      return { deleted, failed, bytesFreed };
    });
  }
  function storageUsage(projectId) {
    if (projectId) needProject(projectId);
    const projects = repo.projects.list().filter((p) => !projectId || p.id === projectId);
    const byKind = Object.create(null), largest = [], warnings = [];
    const summaries = projects.map((p) => {
      let bytes = 0;
      for (const a of repo.assets.listByProject(p.id)) {
        try { const size = fileInfo(a).bytes; bytes += size; byKind[a.kind] = (byKind[a.kind] ?? 0) + size; largest.push({ ...compact(a), size }); }
        catch { warnings.push(`Could not measure asset ${a.id}.`); }
      }
      return { projectId: p.id, name: p.name, bytes };
    });
    const folderBytes = (folder) => {
      let bytes = 0;
      try {
        for (const name of readdirSync(folder)) {
          const file = path.join(folder, name), info = lstatSync(file);
          if (info.isSymbolicLink()) continue;
          if (info.isDirectory()) bytes += folderBytes(file); else if (info.isFile()) bytes += info.size;
        }
      } catch (error) { if (error.code !== 'ENOENT') warnings.push(`Could not fully measure ${path.basename(folder)}.`); }
      return bytes;
    };
    const root = exportDir ? path.dirname(exportDir) : path.resolve(assetStore.dir, '../..');
    const disk = statfsSync(root);
    return { assetBytes: summaries.reduce((n, p) => n + p.bytes, 0), projects: summaries, byKind,
      largest: largest.sort((a, b) => b.size - a.size || a.id.localeCompare(b.id)).slice(0, 10),
      dataFolderBytes: folderBytes(path.join(root, 'data')), dataRootBytes: folderBytes(root),
      freeDiskBytes: disk.bavail * disk.bsize, warnings };
  }

  function exportPlan(storyboardId) {
    const board = needBoard(storyboardId);
    const plan = { format: 'lumina-storyboard', version: 1, title: board.title, idea: board.idea, screenplay: board.screenplay,
      settings: stripRuntime(board.settings), shots: repo.shots.listBySequence(storyboardId).map((s) => ({
        id: s.id, description: s.description, camera: s.camera, duration: s.duration,
        details: stripRuntime(s.details), imageAssetId: s.imageAssetId, videoAssetId: s.videoAssetId,
        sceneState: stripRuntime(repo.settings.get(`scene-state:${s.id}`, null)),
      })) };
    return { json: JSON.stringify(plan, null, 2) };
  }
  function writePlan(projectId, plan, { title = plan.title, warnings = [] } = {}) {
    return repo.transaction(() => {
      const board = repo.sequences.create({ projectId, title, idea: plan.idea, settings: {} });
      repo.sequences.update(board.id, { screenplay: plan.screenplay });
      const shotIds = new Map();
      for (const [i, shot] of plan.shots.entries()) {
        const copy = repo.shots.insert(board.id, { position: i + 1, description: shot.description, camera: shot.camera, duration: shot.duration, details: stripRuntime(shot.details) });
        shotIds.set(shot.id, copy.id);
      }
      const remap = (v) => {
        if (Array.isArray(v)) return v.map(remap);
        if (!v || typeof v !== 'object') return v;
        return Object.fromEntries(Object.entries(v).map(([key, value]) => [key, key === 'shotId' ? shotIds.get(value) ?? null : remap(value)]));
      };
      repo.sequences.update(board.id, { settings: remap(stripRuntime(plan.settings)) });
      for (const shot of plan.shots) {
        const id = shotIds.get(shot.id);
        repo.shots.update(id, { imageAssetId: shot.imageAssetId, videoAssetId: shot.videoAssetId, details: remap(stripRuntime(shot.details)), review: {} });
        if (shot.sceneState) repo.settings.set(`scene-state:${id}`, remap(shot.sceneState));
      }
      return { sequence: repo.sequences.get(board.id), shots: repo.shots.listBySequence(board.id), warnings };
    });
  }
  function importPlan(projectId, json) {
    needProject(projectId);
    if (typeof json !== 'string' || Buffer.byteLength(json) > 1024 * 1024) invalid('Pass storyboard JSON text, at most 1 MB.');
    let input; try { input = JSON.parse(json); } catch { invalid('Invalid storyboard JSON.'); }
    checkPortable(input);
    const plan = parse(planSchema, input);
    if (plan.shots.reduce((n, s) => n + (s.duration ?? 0), 0) > 900) invalid('The film may not exceed 15 minutes.');
    if (new Set(plan.shots.map((s) => s.id)).size !== plan.shots.length) invalid('Duplicate shot IDs in plan.');
    const warnings = new Set();
    const character = (id) => {
      if (!id || id === 'none' || id === 'narrator') return id;
      if (repo.characters.get(id)) return id;
      warnings.add(`Character ${id} is missing; mapped to none.`); return null;
    };
    const media = (id) => {
      if (!id) return id;
      const found = repo.assets.get(id);
      if (found?.projectId === projectId) return id;
      warnings.add(`Asset ${id} is missing from the destination project; mapped to none.`); return null;
    };
    const map = (v) => {
      if (Array.isArray(v)) return v.map(map);
      if (!v || typeof v !== 'object') return v;
      return Object.fromEntries(Object.entries(v).map(([key, value]) => {
        if (key === 'characterIds') return [key, value.map(character).filter(Boolean)];
        if (key === 'locationId') return [key, character(value)];
        if (key === 'speaker') return [key, character(value) ?? 'none'];
        if (/AssetIds$/.test(key)) return [key, value.map(media).filter(Boolean)];
        if (/AssetId$/.test(key) || key === 'assetId') return [key, media(value)];
        if (key === 'characters' && Array.isArray(value)) return [key, value.filter((c) => character(c?.id)).map(map)];
        return [key, map(value)];
      }));
    };
    const mapped = map(plan);
    return writePlan(projectId, mapped, { warnings: [...warnings] });
  }
  function duplicate(storyboardId, title) {
    const source = needBoard(storyboardId);
    title = parse(z.string().trim().min(1).max(80), title);
    return writePlan(source.projectId, JSON.parse(exportPlan(storyboardId).json), { title });
  }
  function generationHistory(input) {
    needProject(input.projectId);
    return page(repo.generations.listByProject(input.projectId, -1).filter((g) =>
      (!input.status || g.status === input.status) && (!input.operation || g.operation === input.operation) && (!input.model || g.model === input.model))
      .sort(compare).map(generationInfo), pagination(input), 'generations');
  }
  return { tagAssets, searchAssets, lineage, unused, deleteAssets, storageUsage, exportPlan, importPlan, duplicate, generationHistory };
}
