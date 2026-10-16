// API routes: canon. Called by createApiServer (src/api.js) with { route, readBody, readRaw, needProject, RequestError, sniffMedia, uuid, catalog, ...services }.
// Never return a top-level `status` field in a JSON body: the router treats it as the HTTP status code.
import { createCanonService } from '../canon.js';

export function registerRoutes({ route, readBody, RequestError, uuid, repo, sequences }) {
  const canon = createCanonService({ repo });
  const guard = (fn) => async (...args) => {
    try { return await fn(...args); } catch (error) {
      throw error instanceof RequestError ? error : new RequestError(error.status ?? (error instanceof TypeError ? 400 : 500), error.message);
    }
  };
  const base = `/api/storyboards/${uuid}/canon`;
  route('POST', base, guard((req, [id]) => canon.create(id)));
  route('GET', base, guard((req, [id], url) => canon.get(id, url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : undefined)));
  route('PATCH', base, guard(async (req, [id]) => {
    const { expectedRevision, patch } = await readBody(req, 512 * 1024);
    return canon.update(id, expectedRevision, patch);
  }));
  for (const [action, locked] of [['lock', true], ['unlock', false]]) route('POST', `${base}/${action}`, guard(async (req, [id]) => canon.lock(id, locked, (await readBody(req, 4096)).reason)));
  route('GET', `${base}/diff`, guard((req, [id], url) => canon.diff(id, Number(url.searchParams.get('fromRevision')), Number(url.searchParams.get('toRevision')))));
  route('POST', `${base}/affected-shots`, guard(async (req, [id]) => canon.affected(id, await readBody(req, 8192))));
  // Use the existing review functions through this API; all resets and their audit event commit atomically.
  route('POST', `${base}/invalidate-approvals`, guard(async (req, [id]) => canon.invalidate(id, (await readBody(req, 4096)).revision, sequences)));
  route('POST', `${base}/snapshots`, guard((req, [id]) => canon.snapshot(id)));
  route('POST', `${base}/sync`, guard(async (req, [id]) => canon.sync(id, (await readBody(req, 4096)).apply ?? false)));
}
