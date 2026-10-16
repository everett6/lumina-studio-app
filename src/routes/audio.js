import { createAudioTools } from '../audiotools.js';

// API routes: audio. Registered with the shared API services; all work is local ffmpeg.
// Keep result states under `result`: the router reserves a top-level `status` for HTTP.
export function registerRoutes({ route, readBody, RequestError, uuid, repo, assetStore, sequences, exportDir }) {
  const audio = createAudioTools({ repo, assetStore, sequences, exportDir });
  const guard = (handler) => async (...args) => {
    try { return await handler(...args); }
    catch (e) { throw e instanceof RequestError ? e : new RequestError(e.status ?? 400, e.message); }
  };
  route('POST', '/api/audio/validate-delivery', guard(async (req) => audio.validate(await readBody(req, 4096))));
  route('GET', `/api/assets/${uuid}/audio/loudness`, guard((req, [id]) => audio.measure(id)));
  route('POST', `/api/assets/${uuid}/audio/normalize`, guard(async (req, [id]) => audio.normalize(id, await readBody(req, 4096))));
  route('POST', `/api/assets/${uuid}/audio/waveform`, guard((req, [id]) => audio.waveform(id)));
  route('POST', `/api/assets/${uuid}/audio/silence`, guard(async (req, [id]) => audio.silence(id, await readBody(req, 4096))));
  route('POST', `/api/assets/${uuid}/audio/trim`, guard(async (req, [id]) => audio.trim(id, await readBody(req, 4096))));
  route('PUT', `/api/storyboards/${uuid}/audio/mix`, guard(async (req, [id]) => audio.setMix(id, (await readBody(req, 4096)).mix)));
  route('POST', `/api/storyboards/${uuid}/audio/preview`, guard(async (req, [id]) => audio.preview(id, await readBody(req, 4096))));
  route('POST', `/api/storyboards/${uuid}/audio/stems`, guard((req, [id]) => audio.exportStems(id)));
  route('GET', `/api/storyboards/${uuid}/audio/report`, guard((req, [id]) => audio.report(id)));
}
