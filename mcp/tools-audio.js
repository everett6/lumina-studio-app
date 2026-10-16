// Audio extension: all tools use authenticated API routes and local CPU ffmpeg. No providers or billing.
const free = 'Free. Local CPU ffmpeg; no network or GPU.';
export const meta = {
  validate_delivery: ['r', free, 'fix failed checks, then validate_delivery again'],
  measure_loudness: ['r', free, 'normalize_loudness or validate_delivery'],
  normalize_loudness: ['', free, 'measure_loudness on the new asset'],
  waveform_image: ['', free, 'trim_audio or detect_silence'],
  detect_silence: ['r', free, 'review flagged intervals'],
  set_mix: ['i', free, 'mix_preview; join_storyboard applies clipVolume only'],
  mix_preview: ['', free, 'set_mix or export_stems'],
  export_stems: ['', free, 'mix the WAV files at unity gain'],
  trim_audio: ['', free, 'measure_loudness on the new asset'],
  audio_report: ['r', free, 'validate_delivery'],
};
export function register({ tool, text, ok, safe, client, z, mediaParts }) {
  const add = (name, title, description, inputSchema, handler, readOnly = false) => tool(name, {
    title, description: `${description} ${free}`, inputSchema,
    annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false },
  }, safe(handler));
  const json = (method, url, body) => client.call(method, url, body).then((result) => ok(text(result)));
  const show = async (url, kind) => {
    const result = await client.call('POST', url, {});
    return ok(text(result), ...await mediaParts([[result.asset.path, kind, 'Waveform']]));
  };
  add('validate_delivery', 'Validate audio delivery', 'Pass exactly one of storyboardId or assetId. Returns passed/failed/unavailable per check. Remeasures and decodes every dialogue recording, checks recorded voice metadata against the current assignment, shot clipping and overlaps; measures -16 LUFS ±1 LU and maximum -1 dBTP, stereo channels, silence ≥0.5 s below -50 dB and audio/video duration within one frame. Missing or clipped dialogue blocks delivery. Asset-only validation cannot check the dialogue ledger. This reports a gate; it does not intercept publish_film.', {
    storyboardId: z.string().optional(), assetId: z.string().optional(),
  }, (args) => json('POST', '/api/audio/validate-delivery', args), true);
  add('measure_loudness', 'Measure integrated loudness and true peak', 'Measure the first audio stream using ebur128: integrated LUFS, LRA in LU and oversampled true peak in dBTP.', { assetId: z.string() }, ({ assetId }) => json('GET', `/api/assets/${assetId}/audio/loudness`), true);
  add('normalize_loudness', 'Normalize audio with two-pass loudnorm', 'Create a new 48 kHz WAV with two-pass loudnorm at -14, -16 (default) or -23 LUFS, true peak -1 dBTP and LRA 11. Keeps the original asset. Video input produces audio only.', {
    assetId: z.string(), targetLufs: z.union([z.literal(-14), z.literal(-16), z.literal(-23)]).optional(),
  }, ({ assetId, ...body }) => json('POST', `/api/assets/${assetId}/audio/normalize`, body));
  add('waveform_image', 'Show an audio waveform', 'Create a PNG waveform asset and show it inline.', { assetId: z.string() }, ({ assetId }) => show(`/api/assets/${assetId}/audio/waveform`, 'image'));
  add('detect_silence', 'Detect quiet intervals', 'Run silencedetect and return start/end/seconds for every quiet interval, including trailing silence. Defaults: 0.5 seconds, -50 dB. Intentional pauses need review.', {
    assetId: z.string(), minSeconds: z.number().min(0.01).max(3600).optional(), thresholdDb: z.number().min(-100).max(0).optional(),
  }, ({ assetId, ...body }) => json('POST', `/api/assets/${assetId}/audio/silence`, body), true);
  add('set_mix', 'Save storyboard mix controls', 'Store mix controls. clipVolume (linear 0–2) is applied by the next join today. dialogueGainDb, musicDuckDb and sfxGainDb affect mix_preview and export_stems only; join_storyboard does not yet read those saved gains. Dialogue gain follows -16 LUFS bus normalization; musicDuckDb caps the possible duck depth (0 disables ducking, up to 24 dB), with actual reduction following speech.', {
    storyboardId: z.string(), mix: z.object({ dialogueGainDb: z.number().min(-60).max(24).optional(), musicDuckDb: z.number().min(0).max(24).optional(), sfxGainDb: z.number().min(-60).max(24).optional(), clipVolume: z.number().min(0).max(2).optional() }).strict(),
  }, ({ storyboardId, mix }) => json('PUT', `/api/storyboards/${storyboardId}/audio/mix`, { mix }));
  add('mix_preview', 'Listen to a mix preview', 'Render an audio-only MP3 span, up to 30 seconds, and play it inline. Uses saved mix controls without joining or re-encoding the picture. Keeps full-timeline loudness/ducking context; long timelines take longer. Missing or clipped dialogue is refused.', {
    storyboardId: z.string(), from: z.number().min(0).optional(), seconds: z.number().min(0.01).max(30).optional(),
  }, async ({ storyboardId, from = 0, seconds = 10 }) => {
    const result = await client.call('POST', `/api/storyboards/${storyboardId}/audio/preview`, { from, seconds });
    return ok(text(result), ...await mediaParts([[result.asset.path, 'audio', 'Mix preview']]));
  });
  add('export_stems', 'Export dialogue, music, effects and clip sound', 'Export four time-aligned 48 kHz stereo float WAVs to a new exports subfolder. Music includes ambience and dialogue-driven ducking. Stems are before the final limiter: their unity sum roughly matches the mix unless it limits. Uses preview gains, which the join does not yet read except clipVolume.', { storyboardId: z.string() }, ({ storyboardId }) => json('POST', `/api/storyboards/${storyboardId}/audio/stems`, {}));
  add('trim_audio', 'Trim audio with fades', 'Create a new WAV from start to end seconds, with optional fadeIn/fadeOut seconds. Keeps the source. Fades must fit within the trimmed span. Video input produces audio only.', {
    assetId: z.string(), start: z.number().min(0), end: z.number().positive(), fadeIn: z.number().min(0).optional(), fadeOut: z.number().min(0).optional(),
  }, ({ assetId, ...body }) => json('POST', `/api/assets/${assetId}/audio/trim`, body));
  add('audio_report', 'Read a storyboard audio report', 'Per shot: decoded recording lengths, line slots and overruns, voice provenance, effects, clip trim/mute and active music cue. Also returns overlaps, saved mix controls and measured loudness of the last joined film. Missing media stays explicit.', { storyboardId: z.string() }, ({ storyboardId }) => json('GET', `/api/storyboards/${storyboardId}/audio/report`), true);
}
