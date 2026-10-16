// API routes: review. Called by createApiServer with the shared services.
// Never return a top-level status: the router interprets it as an HTTP status code.
import { createReviewService } from '../review.js';

export function registerRoutes(ctx) {
  const { route, readBody, RequestError, uuid, token } = ctx;
  const service = createReviewService(ctx);
  const guard = (fn) => async (...args) => {
    try { return await fn(...args); }
    catch (e) { throw e instanceof RequestError ? e : new RequestError(e.status ?? (e instanceof TypeError ? 400 : 500), e.message); }
  };
  // Existing API routes own takes, checks, repair masks, estimates and budget gates.
  // Use the trusted bound port, never Host or a route supplied in a repair plan. Preserve MCP
  // attribution so a loopback request cannot turn an MCP refusal into an app approval.
  const caller = (req) => async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${req.socket.localPort}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(req.headers['x-lumina-client'] ? { 'x-lumina-client': req.headers['x-lumina-client'] } : {}), ...(req.headers['x-lumina-approval-id'] ? { 'x-lumina-approval-id': req.headers['x-lumina-approval-id'] } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000),
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error ?? `HTTP ${response.status}`), { status: response.status, data });
    return data;
  };
  route('GET', `/api/shots/${uuid}/review-bundle`, guard((req, [id]) => service.bundle(id)));
  route('POST', `/api/assets/${uuid}/sample-frames`, guard(async (req, [id]) => service.sample(id, await readBody(req, 4096))));
  route('POST', `/api/shots/${uuid}/compare-takes`, guard(async (req, [id]) => { const { takeA, takeB } = await readBody(req, 4096); return service.compare(id, takeA, takeB, caller(req)); }));
  route('GET', `/api/storyboards/${uuid}/adjacent-shot-check`, guard((req, [id]) => service.adjacent(id)));
  route('POST', `/api/shots/${uuid}/findings`, guard(async (req, [id]) => service.record(id, await readBody(req, 8192), caller(req))));
  route('GET', `/api/storyboards/${uuid}/review-summary`, guard((req, [id]) => service.summary(id)));
  route('POST', `/api/shots/${uuid}/propose-repair`, guard(async (req, [id]) => service.propose(id, (await readBody(req, 4096)).findingId, caller(req))));
  route('POST', `/api/shots/${uuid}/execute-repair`, guard(async (req, [id]) => { const { plan, maxAttempts = 2 } = await readBody(req, 16384); return service.execute(id, plan, maxAttempts, caller(req)); }));
  for (const [verb, accept] of [['accept-repair', true], ['reject-take', false]]) route('POST', `/api/shots/${uuid}/${verb}`, guard(async (req, [id]) => {
    const { takeId, reason } = await readBody(req, 4096);
    return service.decide(id, takeId, reason, accept, caller(req));
  }));
  route('GET', `/api/shots/${uuid}/repair-history`, guard((req, [shotId]) => service.history({ shotId })));
  route('GET', `/api/storyboards/${uuid}/repair-history`, guard((req, [storyboardId]) => service.history({ storyboardId })));
}
