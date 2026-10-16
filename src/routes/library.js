// API routes: library. Called by createApiServer with the shared route helpers and services.
// Never return a top-level `status` field: the router treats it as the HTTP status code.
import { createLibraryService } from '../library.js';

export function registerRoutes(ctx) {
  const { route, readBody, uuid } = ctx;
  const library = createLibraryService(ctx);
  const query = (url) => Object.fromEntries(url.searchParams);
  route('POST', '/api/library/assets/tags', async (req) => library.tagAssets(await readBody(req, 64 * 1024)));
  route('GET', '/api/library/assets/search', (req, params, url) => library.searchAssets(query(url)));
  route('GET', `/api/assets/${uuid}/lineage`, (req, [id]) => library.lineage(id));
  route('GET', '/api/library/storage', (req, params, url) => library.storageUsage(url.searchParams.get('projectId') || undefined));
  route('GET', `/api/projects/${uuid}/unused-assets`, (req, [id]) => library.unused(id));
  route('POST', '/api/library/assets/delete', async (req) => library.deleteAssets(await readBody(req, 32 * 1024)));
  route('POST', `/api/storyboards/${uuid}/duplicate`, async (req, [id]) => library.duplicate(id, (await readBody(req, 1024)).title));
  route('GET', `/api/storyboards/${uuid}/export-json`, (req, [id]) => library.exportPlan(id));
  route('POST', `/api/projects/${uuid}/storyboards/import-json`, async (req, [id]) => library.importPlan(id, (await readBody(req, 2 * 1024 * 1024)).json));
  route('GET', `/api/projects/${uuid}/generation-history`, (req, [id], url) => library.generationHistory({ ...query(url), projectId: id }));
}
