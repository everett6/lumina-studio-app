// API routes: local. Called by createApiServer (src/api.js) with { route, readBody, readRaw, needProject, RequestError, ...services }.
// route(method, pattern, handler(req, params, url, res)); pattern is a regex string, e.g. `/api/assets/${uuid}/x` with uuid from ctx.
import path from 'node:path';
import { createLocalStatus } from '../localstatus.js';

export function registerRoutes(ctx) {
  const { route, readBody, RequestError } = ctx;
  // startLumina passes exports under the actual data root, for both desktop and source instances.
  const local = ctx.localStatus ?? createLocalStatus({ dataRoot: path.dirname(ctx.exportDir) });
  route('GET', '/api/local/status', () => local.status());
  route('GET', '/api/local/models', () => local.listModels());
  route('GET', '/api/local/gpu-queue', () => local.queue());
  route('POST', '/api/local/free-gpu-memory', () => local.freeMemory());
  route('POST', '/api/local/preflight', async (req) => {
    const body = await readBody(req, 4096);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(400, 'Preflight needs a task and optional options object.');
    try { return await local.preflight(body.task, body.options); }
    catch (error) { if (error.status === 400) throw new RequestError(400, error.message); throw error; }
  });
}
