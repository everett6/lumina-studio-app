#!/usr/bin/env node
// Lumina Studio MCP server (stdio). Lets Claude Code / Claude Desktop drive a running Lumina app.
// It talks to the app's local HTTP API using the endpoint and token files the app writes on start.
import { existsSync, readFileSync } from 'node:fs';
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
  throw new Error('Lumina Studio has not been started on this computer yet. Open the app, then try again.');
}

async function call(method, route, body) {
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

const server = new McpServer({ name: 'lumina-studio', version: '0.2.0' });

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

await server.connect(new StdioServerTransport());
