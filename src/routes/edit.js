// API routes: edit. Called by createApiServer (src/api.js) with { route, readBody, readRaw, needProject, RequestError, sniffMedia, uuid, catalog, ...services }.
// route(method, pattern, handler(req, params, url, res)); pattern is a regex string such as `/api/assets/${uuid}/x`.
// Never return a top-level `status` field in a JSON body: the router treats it as the HTTP status code.
export function registerRoutes({ route, readBody, uuid, sequences }) {
  const shot = (suffix, fn) => route('POST', `/api/shots/${uuid}/edit/${suffix}`, async (req, [id]) => fn(id, await readBody(req, 32 * 1024)));
  const board = (suffix, fn) => route('POST', `/api/storyboards/${uuid}/edit/${suffix}`, async (req, [id]) => fn(id, await readBody(req, 64 * 1024)));
  board('insert', (id, body) => sequences.insertShot(id, body));
  shot('duplicate', (id, body) => sequences.duplicateShot(id, body));
  shot('split', (id, body) => sequences.splitShot(id, body));
  shot('delete', (id, body) => sequences.deleteShot(id, body));
  shot('transition', (id, body) => sequences.setCutTransition(id, body));
  shot('speed', (id, body) => sequences.setShotSpeed(id, body));
  shot('overlay', (id, body) => sequences.addTextOverlay(id, body));
  board('animatic', (id, body) => sequences.makeAnimatic(id, body));
  board('reorder-scene', (id, body) => sequences.reorderScene(id, body));
  route('GET', `/api/storyboards/${uuid}/edit/timeline`, (req, [id]) => sequences.shotTimeline(id));
}
