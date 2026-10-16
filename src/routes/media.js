// API routes: media. Called by createApiServer (src/api.js) with { route, readBody, readRaw, needProject, RequestError, ...services }.
import { setTimeout as delay } from 'node:timers/promises';
import { createMediaService, mediaLimits } from '../media.js';

export function registerRoutes(ctx) {
  const { route, readBody, readRaw, needProject, RequestError, uuid, enhancer } = ctx;
  const media = createMediaService(ctx);
  route('GET', `/api/assets/${uuid}/media`, (req, [id]) => ({ asset: media.needAsset(id) }));
  route('POST', `/api/projects/${uuid}/media/import-url`, async (req, [projectId]) => {
    needProject(projectId);
    const { url, label } = await readBody(req, 8192);
    return { status: 201, body: { asset: await media.importUrl(projectId, url, label) } };
  });
  route('POST', `/api/projects/${uuid}/media/upload`, async (req, [projectId]) => {
    needProject(projectId);
    const bytes = await readRaw(req, mediaLimits.video);
    return { status: 201, body: { asset: await media.importBytes(projectId, bytes, req.headers['x-lumina-label']) } };
  });
  route('POST', `/api/assets/${uuid}/upscale-image`, async (req, [id]) => {
    const { scale = 2, engine = 'local-anime' } = await readBody(req, 1024);
    return { status: 201, body: await media.upscaleImage(id, { scale, engine }) };
  });
  route('POST', `/api/assets/${uuid}/reframe`, async (req, [id]) => ({ status: 201, body: await media.reframe(id, await readBody(req, 2048)) }));
  route('POST', `/api/assets/${uuid}/media-mask`, async (req, [id]) => ({ status: 201, body: await media.prepareMask(id, (await readBody(req, 2048)).mask) }));
  route('POST', `/api/assets/${uuid}/extend`, async (req, [id]) => ({ status: 201, body: await media.extend(id, await readBody(req, 2048)) }));
  route('GET', `/api/assets/${uuid}/analyze`, (req, [id]) => media.analyze(id));
  route('POST', `/api/assets/${uuid}/enhance/wait`, async (req, [id]) => {
    media.needAsset(id, 'video');
    const { waitSeconds = 1 } = await readBody(req, 1024);
    if (typeof waitSeconds !== 'number' || !Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 60) throw new RequestError(400, 'Wait between 0 and 60 seconds.');
    if (!enhancer) throw new RequestError(501, 'Video enhancement is unavailable here.');
    const deadline = Date.now() + waitSeconds * 1000;
    while (enhancer.status(id)?.state === 'running' && Date.now() < deadline) await delay(Math.min(250, deadline - Date.now()));
    return { enhance: enhancer.status(id), sourceAssetId: id, statusUrl: `/api/assets/${id}/enhance`, waitUrl: `/api/assets/${id}/enhance/wait` };
  });
}
