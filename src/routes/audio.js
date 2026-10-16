// API routes: audio. Called by createApiServer (src/api.js) with { route, readBody, readRaw, needProject, RequestError, sniffMedia, uuid, catalog, ...services }.
// route(method, pattern, handler(req, params, url, res)); pattern is a regex string such as `/api/assets/${uuid}/x`.
// Never return a top-level `status` field in a JSON body: the router treats it as the HTTP status code.
export function registerRoutes(ctx) { // eslint-disable-line no-unused-vars
}
