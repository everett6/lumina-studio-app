// MCP tools: media. Registered by registerLuminaTools (mcp/tools.js) with the shared helpers in `ctx`:
// { tool, text, ok, safe, client, z, path, summarizeGeneration, waitAndShow, imageContent, mediaParts, pickModel }.
// `meta` adds entries to TOOL_META: name -> [flags (r read-only, d destructive, i idempotent, o external/paid), cost, next].
import { open } from 'node:fs/promises';
import { validateMedia, mediaLimits } from '../src/media.js';

const paid = 'Paid fal credits; existing budget approvals and confirm-spend apply. Stop on 402.';
export const meta = {
  upscale_image: ['o', 'Free with installed local Real-ESRGAN (GPU, default); fal spends credits (budget approvals apply).', null],
  upscale_video: ['', 'Free, local GPU queue; requires installed Real-ESRGAN for anime/ai.', 'upscale_video checkOnly=true or enhance_video checkOnly=true'],
  remove_background: ['o', `${paid} No local background remover is installed/integrated.`, null],
  outpaint_image: ['o', paid, null], inpaint_image: ['o', paid, null],
  reframe: ['o', 'Free local ffmpeg crop/pad; outpaint spends fal credits (budget approvals apply).', null],
  import_media_url: ['o', 'Free; downloads from a public HTTPS host.', null],
  import_media_file: ['', 'Free; local connections only.', null],
  generate_image_batch: ['o', 'Free with local models; provider models spend credits. Budget rules apply unchanged; stop on 402.', 'get_generation or watch_jobs'],
  generate_video_batch: ['o', 'Free with local models; provider models spend credits. Budget rules apply unchanged; stop on 402.', 'get_generation or watch_jobs'],
  analyze_video: ['r', 'Free, local CPU ffmpeg analysis and four preview frames.', null],
};

export function register(ctx) {
  const { tool, text, ok, safe, client, z, path, summarizeGeneration, imageContent, pickModel } = ctx;
  const id = z.string().min(1), prompt = z.string().min(1).max(4000);
  const aspect = z.enum(['16:9', '9:16', '1:1', '4:5']);
  const fraction = z.number().min(0).max(1);
  const focus = { focusX: fraction.optional(), focusY: fraction.optional() };
  const padding = z.object({ left: z.number().int().min(0).max(8192).optional(), right: z.number().int().min(0).max(8192).optional(), top: z.number().int().min(0).max(8192).optional(), bottom: z.number().int().min(0).max(8192).optional() });
  const extendOptions = { direction: z.enum(['left', 'right', 'up', 'down', 'top', 'bottom', 'all', 'horizontal', 'vertical']).optional(), aspect: aspect.optional(), padding: padding.optional(), prompt: prompt.optional() };
  const assetView = (asset) => ({ assetId: asset.id, projectId: asset.projectId, mimeType: asset.mimeType, label: asset.label, parentAssetId: asset.parentAssetId, path: `/assets/${asset.file}` });
  async function showAsset(result) {
    return ok(text({ ...assetView(result.asset), width: result.width, height: result.height }), ...(result.asset.mimeType?.startsWith('image/') ? await imageContent(`/assets/${result.asset.file}`) : []));
  }
  async function paidImage({ assetId, operation, model, prompt, scale, prepared }) {
    const { asset } = await client.call('GET', `/api/assets/${assetId}/media`);
    if (!asset.mimeType?.startsWith('image/')) throw new Error('Choose an image asset. Outpainting video is not supported.');
    const { generation } = await client.call('POST', '/api/generate', { projectId: asset.projectId, operation, provider: 'fal', model, prompt, scale,
      inputAssetIds: [prepared?.inputAssetId ?? assetId], ...(prepared ? { maskAssetId: prepared.maskAssetId } : {}) });
    const done = (await client.call('POST', `/api/generations/${generation.id}/wait`, { timeoutMs: 60_000 })).generation;
    return { content: [text(summarizeGeneration(done)), ...(done.status === 'completed' ? await imageContent(done.assetPath) : [])], ...(done.status === 'failed' ? { isError: true } : {}) };
  }
  async function outpaint({ assetId, prompt, ...options }) {
    const prepared = await client.call('POST', `/api/assets/${assetId}/extend`, options);
    return paidImage({ assetId, operation: 'inpaint', model: 'fal-ai/flux-pro/v1/fill', prompt: prompt ?? 'Extend the image naturally into the new canvas. Match the surrounding style, lighting and colours; preserve the existing image.', prepared });
  }

  tool('upscale_image', {
    title: 'Upscale an image',
    description: 'Make a 2× or 4× copy of an image, saved with its source as parent. Defaults to installed local Real-ESRGAN anime (free GPU); local-photo uses x4plus, fal is paid. Returns the new asset id and inline image when small enough. No automatic downloads.',
    inputSchema: { assetId: id, scale: z.union([z.literal(2), z.literal(4)]).default(2), engine: z.enum(['local-anime', 'local-photo', 'fal']).default('local-anime') },
  }, safe(async ({ assetId, scale = 2, engine = 'local-anime' }) => engine === 'fal'
    ? paidImage({ assetId, operation: 'upscale', model: 'fal-ai/esrgan', scale })
    : showAsset(await client.call('POST', `/api/assets/${assetId}/upscale-image`, { scale, engine }))));

  tool('upscale_video', {
    title: 'Upscale a video',
    description: 'Start the existing local enhancement pipeline at 1080, 1440 or 2160 height (fits the source aspect). anime/ai use installed Real-ESRGAN; fast uses the existing scaler. Returns a source job handle/status URL after a bounded wait (default 1s, maximum 60s). checkOnly waits/checks without starting another job.',
    inputSchema: { assetId: id, height: z.union([z.literal(1080), z.literal(1440), z.literal(2160)]).default(1080), engine: z.enum(['anime', 'ai', 'fast']).default('anime'), waitSeconds: z.number().min(0).max(60).default(1), checkOnly: z.boolean().optional() },
  }, safe(async ({ assetId, height = 1080, engine = 'anime', waitSeconds = 1, checkOnly = false }) => {
    if (!checkOnly) await client.call('POST', `/api/assets/${assetId}/enhance`, { mode: engine, height });
    return ok(text(await client.call('POST', `/api/assets/${assetId}/enhance/wait`, { waitSeconds })));
  }));

  tool('remove_background', {
    title: 'Remove an image background',
    description: 'Cut out the subject onto transparency with paid fal BiRefNet. No local background-removal option is installed/integrated; this tool always spends provider credits subject to budget approval.',
    inputSchema: { assetId: id },
  }, safe(async ({ assetId }) => paidImage({ assetId, operation: 'remove-background', model: 'fal-ai/birefnet/v2' })));

  tool('outpaint_image', {
    title: 'Extend an image canvas',
    description: 'Extend an image in a direction, to an aspect, or by pixel padding (padding takes priority). Builds a canvas/mask locally, then fills the new area using paid fal Fill via the existing generation API. Default direction all extends 25% on each side. Returns a generation handle if still running after 60s.',
    inputSchema: { assetId: id, ...extendOptions },
  }, safe(outpaint));

  tool('inpaint_image', {
    title: 'Repaint part of an image',
    description: 'Repaint a masked area with paid fal Fill through the existing generation API. mask is an image asset id with matching dimensions (white=repaint, black=keep), or a fractional box {x,y,w,h}, rasterized locally to PNG. Returns a generation handle if still running after 60s.',
    inputSchema: { assetId: id, prompt, mask: z.union([id, z.object({ x: fraction, y: fraction, w: fraction.positive(), h: fraction.positive() }).refine((b) => b.x + b.w <= 1 && b.y + b.h <= 1, 'Box must fit inside the image')]) },
  }, safe(async ({ assetId, prompt, mask }) => {
    const prepared = await client.call('POST', `/api/assets/${assetId}/media-mask`, { mask });
    return paidImage({ assetId, operation: 'inpaint', model: 'fal-ai/flux-pro/v1/fill', prompt, prepared });
  }));

  tool('reframe', {
    title: 'Reframe an image or video',
    description: 'Change aspect with free local ffmpeg crop/pad for images or videos. focusX/focusY (0–1, default centre) position the crop or original inside padding. outpaint fills new image canvas with paid fal Fill; video outpainting is unavailable. Saves a new copy.',
    inputSchema: { assetId: id, aspect, mode: z.enum(['crop', 'pad', 'outpaint']).default('crop'), ...focus, prompt: prompt.optional() },
  }, safe(async ({ assetId, mode = 'crop', ...options }) => mode === 'outpaint' ? outpaint({ assetId, ...options }) : showAsset(await client.call('POST', `/api/assets/${assetId}/reframe`, { mode, ...options }))));

  tool('import_media_url', {
    title: 'Import media from a URL',
    description: 'Download media into the project library from public HTTPS only, with every redirect checked. Sniffs bytes rather than filename or Content-Type. Caps images at 25 MB, audio at 80 MB and video at 300 MB. Supported: PNG/JPEG/WebP, MP3/WAV/OGG/FLAC, MP4.',
    inputSchema: { projectId: id, url: z.string().url().max(4096), label: z.string().max(120).optional() },
  }, safe(async ({ projectId, url, label }) => showAsset(await client.call('POST', `/api/projects/${projectId}/media/import-url`, { url, label }))));

  // Always list the tool so TOOL_META is identical on remote and local servers, but never read a
  // server-side file unless the connection supplies the trusted local-only upload capability.
  tool('import_media_file', {
    title: 'Import a local media file',
    description: 'Import a file from this computer into the library (local connections with client.upload only). Byte-sniffed PNG/JPEG/WebP, MP3/WAV/OGG/FLAC or MP4; limits 25/80/300 MB for images/audio/video. Remote connections cannot read local files.',
    inputSchema: { projectId: id, filePath: z.string().min(1), label: z.string().max(120).optional() },
  }, safe(async ({ projectId, filePath, label }) => {
    if (!client.upload) throw new Error('Local file import requires a local connection (client.upload); use import_media_url remotely.');
    const handle = await open(path.resolve(filePath), 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > mediaLimits.video) throw new Error('Choose a regular media file within the 300 MB size limit.');
      const prefix = Buffer.alloc(32);
      const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
      const { mimeType } = validateMedia(prefix.subarray(0, bytesRead));
      if (stat.size > mediaLimits[mimeType.split('/')[0]]) throw new Error('The media file is too large for its type (25/80/300 MB for images/audio/video).');
      // Read at most the cap plus one, even if a file changes after stat().
      const chunks = []; let size = 0;
      const cap = mediaLimits[mimeType.split('/')[0]];
      for await (const chunk of handle.createReadStream({ start: 0, end: cap, autoClose: false })) { size += chunk.length; chunks.push(chunk); }
      const bytes = Buffer.concat(chunks, size); validateMedia(bytes);
      return showAsset(await client.upload(`/api/projects/${projectId}/media/upload`, bytes, label ?? path.basename(filePath)));
    } finally { await handle.close(); }
  }));

  const shared = { projectId: id, prompts: z.array(prompt).min(1).max(8), provider: z.string().optional(), model: z.string().optional(),
    seed: z.number().int().min(0).max(2147483646).optional(), presets: z.array(z.string()).max(3).optional(), characterIds: z.array(id).max(8).optional() };
  for (const video of [false, true]) {
    tool(video ? 'generate_video_batch' : 'generate_image_batch', {
      title: video ? 'Queue a batch of videos' : 'Queue a batch of images',
      description: 'Queue 1–8 prompts with shared generation options and return all job ids immediately without waiting for completion. Submits in order and stops at the first refusal/error, preserving already queued ids. A 402 requires budget review/approval; never resubmit successful prompts.',
      inputSchema: { ...shared, ...(video ? { inputAssetId: id.optional(), duration: z.number().int().optional(), aspect: z.string().optional() }
        : { size: z.enum(['1024x1024', '1536x1024', '1024x1536']).optional(), quality: z.enum(['low', 'medium', 'high']).optional(), inputAssetIds: z.array(id).max(4).optional(), director: z.string().optional() }) },
    }, safe(async ({ prompts, ...args }) => {
      const operation = video ? 'video' : args.inputAssetIds?.length ? 'edit' : 'generate';
      const choice = await pickModel(operation, args.provider, args.model);
      const jobs = [];
      for (let index = 0; index < prompts.length; index++) {
        try {
          const { inputAssetId, ...options } = args;
          const { generation } = await client.call('POST', '/api/generate', { ...options, ...choice, operation, prompt: prompts[index], ...(video ? { inputAssetIds: inputAssetId ? [inputAssetId] : [] } : {}) });
          jobs.push(summarizeGeneration(generation));
        } catch (error) {
          return { content: [text({ jobIds: jobs.map((j) => j.id), jobs, stoppedAt: index, status: error.status, error: error.message, details: error.data,
            note: error.status === 402 ? 'STOP: call budget_status; obtain user approval before decide_approval or repeating only the refused prompt. Already queued prompts must not be resubmitted.' : 'Stopped. Inspect already queued jobs before retrying the remaining prompts.' })], isError: true };
        }
      }
      return ok(text({ jobIds: jobs.map((j) => j.id), jobs, note: 'Queued without waiting. Use get_generation or watch_jobs.' }));
    }));
  }

  tool('analyze_video', {
    title: 'Analyze a video locally',
    description: 'Inspect a video using free local ffmpeg: scene cuts (scdet), black/frozen stretches, EBU R128 integrated loudness and true peak, fps/size/duration, plus four inline sample frames. Read-only CPU analysis. Heuristics and samples require human review, not an automatic quality verdict.',
    inputSchema: { assetId: id },
  }, safe(async ({ assetId }) => {
    const { frames, ...result } = await client.call('GET', `/api/assets/${assetId}/analyze`);
    return ok(text({ ...result, sampleTimes: frames.map((f) => f.requestedTimeSeconds) }), ...frames.map((f) => ({ type: 'image', mimeType: f.mimeType, data: f.data })));
  }));
}
