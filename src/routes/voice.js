// API routes: voice. Called by createApiServer (src/api.js) with { route, readBody, readRaw, needProject, RequestError, ...services }.
// route(method, pattern, handler(req, params, url, res)); pattern is a regex string, e.g. `/api/assets/${uuid}/x` with uuid from ctx.
import path from 'node:path';
import { configureVoiceLibrary } from '../voices.js';
import { changeVoice } from '../providers/local.js';

export function registerRoutes({ route, readBody, repo, assetStore, RequestError }) {
  const library = configureVoiceLibrary({ dir: path.join(assetStore.dir, '..', 'custom-voices') });
  function audioAsset(id) {
    const asset = typeof id === 'string' ? repo.assets.get(id) : null;
    if (!asset) throw new RequestError(404, 'Audio asset not found.');
    if (!asset.mimeType?.startsWith('audio/')) throw new RequestError(400, 'Choose an audio asset containing clean speech.');
    return asset;
  }
  route('GET', '/api/voices', () => ({ voices: library.list() }));
  route('POST', '/api/voices', async (req) => {
    const body = await readBody(req, 16384);
    if (body.consent !== true) throw new RequestError(400, 'consent must be true: use only your own voice or a voice you have permission to use.');
    const asset = audioAsset(body.audioAssetId);
    const voice = await library.create({ name: body.name, audio: assetStore.path(asset), audioAssetId: asset.id, consent: body.consent });
    return { status: 201, body: { voice } };
  });
  route('DELETE', '/api/voices/([^/]+)', (req, [id]) => {
    let decoded;
    try { decoded = decodeURIComponent(id); } catch { throw new RequestError(400, 'Invalid custom voice id.'); }
    library.delete(decoded);
    return { deleted: true, id: decoded };
  });
  route('POST', '/api/voice-change', async (req) => {
    const body = await readBody(req, 16384);
    const source = audioAsset(body.audioAssetId);
    if (typeof body.targetVoice !== 'string' || !body.targetVoice) throw new RequestError(400, 'targetVoice is required (choose a voice from list_voices).');
    const result = await changeVoice({ audio: assetStore.path(source), targetVoice: body.targetVoice });
    const asset = await assetStore.save({ bytes: result.bytes, projectId: source.projectId, kind: 'audio', label: `Voice change · ${body.targetVoice}`, parentAssetId: source.id });
    return { status: 201, body: { assetId: asset.id, assetPath: asset.path, targetVoice: body.targetVoice, usage: result.usage } };
  });
}
