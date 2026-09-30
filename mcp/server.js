#!/usr/bin/env node
// Lumina Studio MCP server (stdio). Lets Claude Code / Claude Desktop drive a running Lumina app.
// It talks to the app's local HTTP API using the endpoint and token files the app writes on start.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configHome = process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
// Desktop app data first, then a dev server started from the repo.
const candidates = process.env.LUMINA_DATA_DIR ? [process.env.LUMINA_DATA_DIR] : [path.join(configHome, 'Lumina Studio'), repoRoot];
const maxInlineImageBytes = 3 * 1024 * 1024;

function connection() {
  for (const root of candidates) {
    const endpointFile = path.join(root, 'data', 'endpoint.json');
    const tokenFile = path.join(root, 'data', 'api-token');
    if (existsSync(endpointFile) && existsSync(tokenFile)) {
      return { root, url: JSON.parse(readFileSync(endpointFile, 'utf8')).url, token: readFileSync(tokenFile, 'utf8').trim() };
    }
  }
  throw new Error('Lumina Studio is not running. Open the app, then try again.');
}

// Installed locations of the desktop app, most specific first. LUMINA_APP_COMMAND overrides.
function appCommand() {
  const options = [
    process.env.LUMINA_APP_COMMAND,
    path.join(homedir(), 'Applications', 'Lumina-Studio.AppImage'),
    '/opt/Lumina Studio/lumina-studio',
    '/usr/bin/lumina-studio',
    path.join(repoRoot, 'dist', 'linux-unpacked', 'lumina-studio'),
  ];
  return options.find((option) => option && existsSync(option)) ?? null;
}

async function reachable() {
  try {
    const { url, token } = connection();
    const response = await fetch(`${url}/api/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

// If Lumina is closed, open the desktop app and wait for it to come up (once per call).
async function ensureRunning() {
  if (await reachable()) return;
  const command = process.env.LUMINA_NO_AUTOLAUNCH === '1' ? null : appCommand();
  if (!command) throw new Error('Lumina Studio is not running. Open the app, then try again.');
  const child = spawn(command, [], { detached: true, stdio: 'ignore', env: process.env });
  child.on('error', () => {});
  child.unref();
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await reachable()) return;
  }
  throw new Error(`Started Lumina Studio (${command}) but it did not respond within 30 seconds.`);
}

async function call(method, route, body) {
  await ensureRunning();
  const { url, token } = connection();
  let response;
  try {
    response = await fetch(`${url}${route}`, {
      method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(660_000),
    });
  } catch {
    throw new Error('Lumina Studio is not running. Open the app, then try again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Lumina returned HTTP ${response.status}`);
  return data;
}

const text = (value) => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) });
const ok = (...content) => ({ content });
const fail = (error) => ({ content: [text(error.message)], isError: true });
const safe = (handler) => async (args) => {
  try {
    return await handler(args);
  } catch (error) {
    return fail(error);
  }
};

function summarizeGeneration(g) {
  return {
    id: g.id, status: g.status, operation: g.operation, provider: g.provider, model: g.model, prompt: g.prompt,
    finalPrompt: g.finalPrompt, assetId: g.assetId, error: g.userError ?? undefined, createdAt: g.createdAt,
  };
}

async function imageContent(assetPath) {
  if (!assetPath) return [];
  const { url, token, root } = connection();
  const file = path.join(root, 'storage', 'assets', path.basename(assetPath));
  const response = await fetch(`${url}${assetPath}`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) return [text(`Image saved at ${file}`)];
  const bytes = Buffer.from(await response.arrayBuffer());
  const mimeType = response.headers.get('content-type') || 'image/png';
  if (bytes.length > maxInlineImageBytes) return [text(`Image saved at ${file} (too large to inline).`)];
  return [{ type: 'image', data: bytes.toString('base64'), mimeType }, text(`Image file: ${file}`)];
}

async function pickModel(operation, provider, model) {
  const { providers } = await call('GET', '/api/catalog');
  if (provider && model) return { provider, model };
  const options = providers.filter((p) => p.ready && (!provider || p.id === provider))
    .flatMap((p) => p.models.filter((m) => m.operations.includes(operation)).map((m) => ({ provider: p.id, model: m.id })));
  if (!options.length) throw new Error(`No ${operation}-capable model has an API key configured. Add a key in Lumina → Settings.`);
  return options[0];
}

const server = new McpServer({ name: 'lumina-studio', version: '0.3.0' });

server.registerTool('list_projects', {
  title: 'List projects',
  description: 'List Lumina Studio projects, most recently updated first.',
  inputSchema: {},
}, safe(async () => ok(text((await call('GET', '/api/projects')).projects))));

server.registerTool('create_project', {
  title: 'Create project',
  description: 'Create a new Lumina Studio project.',
  inputSchema: { name: z.string().min(1).max(80) },
}, safe(async ({ name }) => ok(text((await call('POST', '/api/projects', { name })).project))));

server.registerTool('list_models', {
  title: 'List image models',
  description: 'List image providers and models, whether each provider has a key configured, and what each model supports (generate, edit, sizes, max input images). Also lists creative directors.',
  inputSchema: {},
}, safe(async () => {
  const { providers, directors } = await call('GET', '/api/catalog');
  return ok(text({
    providers: providers.map((p) => ({ id: p.id, label: p.label, ready: p.ready, models: p.models.map(({ id, label, operations, sizes, qualities, maxReferences }) => ({ id, label, operations, sizes, qualities, maxReferences })) })),
    directors: directors.map((d) => ({ id: d.id, ready: d.ready, options: d.models.map((m) => `${d.id}:${m}`) })),
  }));
}));

server.registerTool('generate_image', {
  title: 'Generate or edit an image',
  description: 'Generate an image in a Lumina project using the user\'s own provider keys. Pass inputAssetIds to edit or combine existing images. Waits for the result by default and returns the image. Costs money on the user\'s provider account.',
  inputSchema: {
    projectId: z.string().describe('Project id from list_projects'),
    prompt: z.string().min(1).max(4000),
    provider: z.string().optional().describe('Provider id from list_models; defaults to the first ready provider'),
    model: z.string().optional().describe('Model id from list_models'),
    size: z.enum(['1024x1024', '1536x1024', '1024x1536']).optional(),
    quality: z.enum(['low', 'medium', 'high']).optional(),
    inputAssetIds: z.array(z.string()).max(4).optional().describe('Asset ids to edit or use as references'),
    director: z.string().optional().describe('Optional creative director, e.g. "anthropic:claude-opus-5-5"'),
    wait: z.boolean().optional().describe('Wait for completion (default true)'),
  },
}, safe(async (args) => {
  const operation = args.inputAssetIds?.length ? 'edit' : 'generate';
  const choice = await pickModel(operation, args.provider, args.model);
  const { generation } = await call('POST', '/api/generate', { ...args, ...choice });
  if (args.wait === false) return ok(text({ ...summarizeGeneration(generation), note: 'Queued. Poll with get_generation.' }));
  const done = (await call('POST', `/api/generations/${generation.id}/wait`, { timeoutMs: 600_000 })).generation;
  if (done.status !== 'completed') return { content: [text(summarizeGeneration(done))], isError: done.status === 'failed' };
  return ok(text(summarizeGeneration(done)), ...(await imageContent(done.assetPath)));
}));

server.registerTool('get_generation', {
  title: 'Get generation',
  description: 'Get the status of a generation; returns the image when it is complete.',
  inputSchema: { generationId: z.string(), includeImage: z.boolean().optional() },
}, safe(async ({ generationId, includeImage = true }) => {
  const { generation } = await call('GET', `/api/generations/${generationId}`);
  const image = includeImage && generation.status === 'completed' ? await imageContent(generation.assetPath) : [];
  return ok(text(summarizeGeneration(generation)), ...image);
}));

server.registerTool('list_assets', {
  title: 'List project images',
  description: 'List images (generated and uploaded references) in a project, plus its canvases.',
  inputSchema: { projectId: z.string() },
}, safe(async ({ projectId }) => {
  const detail = await call('GET', `/api/projects/${projectId}`);
  const prompts = new Map(detail.generations.filter((g) => g.assetId).map((g) => [g.assetId, g.prompt]));
  return ok(text({
    assets: detail.assets.map((a) => ({ id: a.id, kind: a.kind, label: a.label ?? prompts.get(a.id) ?? null, createdAt: a.createdAt })),
    canvases: detail.canvases.map((c) => ({ id: c.id, name: c.name, nodeCount: c.nodeCount })),
  }));
}));

server.registerTool('add_to_canvas', {
  title: 'Add image to canvas',
  description: 'Add an image to a project canvas as a reference node. Uses the most recent canvas, or creates one, when canvasId is omitted.',
  inputSchema: { assetId: z.string(), canvasId: z.string().optional(), projectId: z.string().describe('Project that owns the canvas') },
}, safe(async ({ assetId, canvasId, projectId }) => {
  let id = canvasId;
  if (!id) {
    const { canvases } = await call('GET', `/api/projects/${projectId}`);
    id = canvases[0]?.id ?? (await call('POST', `/api/projects/${projectId}/canvases`, { name: 'Canvas 1' })).canvas.id;
  }
  const { canvas } = await call('GET', `/api/canvases/${id}`);
  const maxY = canvas.graph.nodes.reduce((y, n) => Math.max(y, n.y + 260), 40);
  const node = { id: `r${Date.now().toString(36)}`, type: 'reference', x: 40, y: maxY, data: { assetId } };
  const saved = await call('PUT', `/api/canvases/${id}`, { graph: { ...canvas.graph, nodes: [...canvas.graph.nodes, node] }, version: canvas.version });
  return ok(text({ canvasId: id, canvasName: saved.canvas.name, nodeId: node.id }));
}));

server.registerTool('run_canvas', {
  title: 'Run canvas',
  description: 'Run a canvas workflow (or only what one node needs) and wait for it to finish. Generate/edit nodes spend money on the user\'s provider accounts.',
  inputSchema: { canvasId: z.string(), nodeId: z.string().optional(), timeoutSeconds: z.number().int().min(10).max(1800).optional() },
}, safe(async ({ canvasId, nodeId, timeoutSeconds = 600 }) => {
  let { run } = await call('POST', `/api/canvases/${canvasId}/run`, { nodeId });
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (run.status === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    run = (await call('GET', `/api/canvas-runs/${run.id}`)).run;
  }
  const nodes = Object.fromEntries(Object.entries(run.nodeState).map(([id, s]) => [id, { status: s.status, assetId: s.assetId, error: s.error }]));
  return { content: [text({ runId: run.id, status: run.status, nodes })], isError: run.status === 'failed' };
}));

// ---------- Book Studio ----------

const briefShape = {
  premise: z.string().max(4000).optional(), audience: z.string().max(200).optional(), language: z.string().max(80).optional(),
  genre: z.string().max(120).optional(), tone: z.string().max(200).optional(), pageCount: z.number().int().min(1).max(48).optional(),
  trimSize: z.enum(['8x8', '8.5x11', '10x8', '6x9']).optional(), illustrationStyle: z.string().max(1000).optional(), author: z.string().max(120).optional(),
};

function bookSummary({ book, pages }) {
  return {
    id: book.id, title: book.title, projectId: book.projectId, writer: book.writer, brief: book.brief, bible: book.bible,
    pages: pages.map((p) => ({ id: p.id, position: p.position, text: p.text, illustrationBrief: p.illustrationBrief, hasIllustration: Boolean(p.assetId), illustrationStatus: p.illustrations[0]?.status ?? null })),
  };
}

server.registerTool('create_book', {
  title: 'Create picture book',
  description: 'Create a picture book in a Lumina project from a brief. Next steps: draft_bible, plan_pages, then generate_illustration per page and export_book.',
  inputSchema: { projectId: z.string(), title: z.string().min(1).max(80), writer: z.string().optional().describe('Writer model as "provider:model" (see list_models directors), e.g. "anthropic:claude-opus-5-5"'), ...briefShape },
}, safe(async ({ projectId, title, writer, ...brief }) => {
  const { book } = await call('POST', `/api/projects/${projectId}/books`, { title, writer, brief });
  return ok(text(bookSummary(await call('GET', `/api/books/${book.id}`))));
}));

server.registerTool('get_book', {
  title: 'Get book',
  description: 'Read a book: brief, story bible and every page\'s text, illustration brief and illustration status. Use list_books to find ids.',
  inputSchema: { bookId: z.string() },
}, safe(async ({ bookId }) => ok(text(bookSummary(await call('GET', `/api/books/${bookId}`))))));

server.registerTool('list_books', {
  title: 'List books',
  description: 'List books in a project.',
  inputSchema: { projectId: z.string() },
}, safe(async ({ projectId }) => ok(text((await call('GET', `/api/projects/${projectId}/books`)).books.map(({ id, title, pageCount, updatedAt }) => ({ id, title, pageCount, updatedAt }))))));

server.registerTool('update_book', {
  title: 'Update book brief or story bible',
  description: 'Edit a book\'s title, brief fields, writer, or story bible (characters with name/description/visual, setting, voice, styleNotes). Pass the whole bible object when changing it.',
  inputSchema: {
    bookId: z.string(), title: z.string().max(80).optional(), writer: z.string().optional(), brief: z.object(briefShape).optional(),
    bible: z.object({
      characters: z.array(z.object({ name: z.string(), description: z.string().optional(), visual: z.string().optional(), referenceAssetIds: z.array(z.string()).max(4).optional() })).optional(),
      setting: z.string().optional(), voice: z.string().optional(), styleNotes: z.string().optional(), styleReferenceAssetIds: z.array(z.string()).max(4).optional(),
    }).optional(),
  },
}, safe(async ({ bookId, ...changes }) => {
  await call('PATCH', `/api/books/${bookId}`, changes);
  return ok(text(bookSummary(await call('GET', `/api/books/${bookId}`))));
}));

server.registerTool('draft_bible', {
  title: 'Draft story bible',
  description: 'Have the book\'s writer model draft the story bible (characters, setting, voice, visual style) from the brief. Replaces the current bible; uses the user\'s text-model credits.',
  inputSchema: { bookId: z.string(), writer: z.string().optional() },
}, safe(async ({ bookId, writer }) => {
  await call('POST', `/api/books/${bookId}/bible`, { writer });
  return ok(text(bookSummary(await call('GET', `/api/books/${bookId}`))));
}));

server.registerTool('plan_pages', {
  title: 'Plan pages',
  description: 'Have the writer model write every page (text + illustration brief) from the brief and story bible. Set replace=true to overwrite existing pages — ask the user first.',
  inputSchema: { bookId: z.string(), writer: z.string().optional(), replace: z.boolean().optional() },
}, safe(async ({ bookId, writer, replace }) => ok(text(bookSummary(await call('POST', `/api/books/${bookId}/plan`, { writer, replace }))))));

server.registerTool('edit_page', {
  title: 'Edit page',
  description: 'Set a page\'s text and/or illustration brief directly (previous version kept in history).',
  inputSchema: { pageId: z.string(), text: z.string().max(4000).optional(), illustrationBrief: z.string().max(2000).optional() },
}, safe(async ({ pageId, ...changes }) => ok(text((await call('PATCH', `/api/pages/${pageId}`, changes)).page))));

server.registerTool('revise_page', {
  title: 'Revise page with the writer',
  description: 'Ask the writer model to revise one page following an instruction, keeping it consistent with the story bible and neighbouring pages.',
  inputSchema: { pageId: z.string(), instruction: z.string().min(1).max(2000), writer: z.string().optional() },
}, safe(async (args) => ok(text((await call('POST', `/api/pages/${args.pageId}/revise`, args)).page))));

server.registerTool('generate_illustration', {
  title: 'Illustrate page',
  description: 'Generate an illustration for one page using its brief plus the story bible\'s character looks and reference images. Waits and returns the image. Costs money on the user\'s image provider — confirm with the user before illustrating many pages.',
  inputSchema: { pageId: z.string(), provider: z.string().optional(), model: z.string().optional(), wait: z.boolean().optional() },
}, safe(async ({ pageId, provider, model, wait = true }) => {
  const choice = await pickModel('generate', provider, model);
  const { generation, droppedReferences } = await call('POST', `/api/pages/${pageId}/illustrate`, choice);
  const note = droppedReferences ? `${droppedReferences} reference image(s) not sent: this model does not accept input images.` : undefined;
  if (!wait) return ok(text({ ...summarizeGeneration(generation), note }));
  const done = (await call('POST', `/api/generations/${generation.id}/wait`, { timeoutMs: 600_000 })).generation;
  if (done.status !== 'completed') return { content: [text(summarizeGeneration(done))], isError: true };
  return ok(text({ ...summarizeGeneration(done), note }), ...(await imageContent(done.assetPath)));
}));

server.registerTool('export_book', {
  title: 'Export book',
  description: 'Export a book as a print-layout PDF (title page, one page per book page, art above real text) or as Markdown text. Saves the file on this computer and returns its path.',
  inputSchema: { bookId: z.string(), format: z.enum(['pdf', 'md']).optional(), outputPath: z.string().optional().describe('Absolute file path; defaults to the Lumina exports folder') },
}, safe(async ({ bookId, format = 'pdf', outputPath }) => {
  await ensureRunning();
  const { url, token, root } = connection();
  const response = await fetch(`${url}/api/books/${bookId}/export.${format}`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Export failed (HTTP ${response.status})`);
  const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? `book.${format}`;
  const target = outputPath ? path.resolve(outputPath) : path.join(root, 'exports', name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, Buffer.from(await response.arrayBuffer()));
  const skipped = Number(response.headers.get('x-lumina-skipped-webp') ?? 0);
  return ok(text({ file: target, format, note: skipped ? `${skipped} WebP illustration(s) could not be embedded in the PDF.` : undefined }));
}));

await server.connect(new StdioServerTransport());
