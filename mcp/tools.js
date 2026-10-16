// Lumina's MCP tools, shared by the local stdio server (mcp/server.js) and the remote HTTPS endpoint
// (src/remote.js). `client` supplies: call(method, route, body) → JSON, fetchRaw(route) → Response,
// exportDir() → folder for exported files, and optionally localFile(assetPath) → path on disk.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { nextStep, shotFacts } from './wizard.js';

const maxInlineImageBytes = 3 * 1024 * 1024;

// Playbook sent to every MCP client in the server's `instructions` (stdio and remote endpoints share it).
export const LUMINA_INSTRUCTIONS = `Lumina Studio makes images, books and films on the user's own computer and provider accounts.

MAKING A FILM (the usual path)
1. create_project, then create_character for each cast member (a locked "designTags" block keeps the design stable) and make_character_sheet; bake_character (local LoRA, free, ~15-25 min GPU; draws pictures first, then you review them: reject bad ones, set mirror off for asymmetric designs, train on the approved) keeps anime faces on-model.
2. create_storyboard (set look, targetMinutes, characterIds). Under a strict budget use plan=false and import_shot_plan with a plan you write yourself.
3. Loop: film_next_step -> show its question and preview images to the user -> make the chosen call -> repeat. It proposes one stage at a time (plan, frames, approve frames, animate, review, voices, fix, join) and never spends anything itself.
4. Look before you pay: preview_storyboard (all frames), preview_shot (one shot, with video samples and dialogue audio), inspect_video. Accept or reject with review_shot; fix with update_shot, trim_shot, move_shot, adjust_shot_look.
5. join_storyboard makes the final MP4; enhance_video / interpolate_video are optional polish.
6. Every frame and clip is kept as a take: list_shot_takes, select_shot_take (also undoes a bad revision), repair_frame for one area, rerecord_line / set_line_timing for dialogue, export_production for an editable folder.

MONEY
- Local work (local image/video models, still shots, lip sync, bake, join, colour grade, previews, estimates) is free. Provider work (frames, clips, speech, writer models, covers, upscales) can spend the user's credits.
- Paid requests are controlled by budget approvals, not by a confirm dialog. A refusal with status 402 means: call budget_status, show the estimate to the user, and only if they agree use decide_approval (works only if the user allowed MCP approvals; otherwise they approve it in the Lumina app), then repeat the identical call.
- Call estimate_film_cost before produce_film or generate_storyboard_shots for clips. Never loop paid retries or submit a second paid take while one is still running; check the first with get_generation / watch_jobs.

RULES OF THE ROAD
- Anime storyboards (look: "anime") are English only. Japanese and other languages are not supported for anime dialogue.
- Voices: cast_voices gives the narrator and every character of a storyboard a distinct free local voice in one call (record=true also records the lines); list_voices shows every voice; preview_voice plays a sample; set_character_voice changes one; voice_dialogue records a shot's lines.
- Lip sync is OFF by default per storyboard (setting lipSync, chosen at create_storyboard or in the storyboard's Settings in the app). When off, lip_sync_shot is refused. It needs recorded dialogue first (voice_dialogue).
- Local models are free but slow and share one GPU: run one heavy job at a time. Do not poll; use watch_jobs with waitSeconds to wait for jobs.
- Replacing work (import_shot_plan replace, plan_storyboard/plan_pages/outline_book replace, draft_bible, bake_character remove) needs the user's OK first.
- Ids come from list_* tools or earlier results: list_projects, list_characters, list_assets, list_books, get_storyboard. search and fetch read the user's work by keywords.`;

// Title, flags and cost/next hints per tool. Flags: r read-only, d destructive (overwrites or removes), i idempotent,
// o may call external (paid) providers. Everything else is local. Descriptions get "Cost" and "Next" appended when listed.
const free = 'Free.';
const local = 'Free (runs on this computer).';
const paid = 'May spend credits on the user\'s provider account (budget approvals apply).';
const TOOL_META = {
  search: ['r', free, 'fetch'], fetch: ['r', free, null],
  list_projects: ['r', free, 'create_project or list_assets'], create_project: ['', free, 'create_character, create_storyboard or generate_image'], update_storyboard: ['i', free, 'film_next_step'],
  list_models: ['ro', free, 'generate_image / create_storyboard'], list_presets: ['r', free, 'generate_image, generate_video or create_storyboard'],
  list_characters: ['r', free, 'create_storyboard (characterIds)'], create_character: ['', free, 'make_character_sheet'],
  update_character: ['i', free, null], make_character_sheet: ['o', 'Free with the local anime model, otherwise may spend credits.', 'get_generation, then bake_character'],
  enhance_image: ['o', paid, null], generate_image: ['o', paid, 'list_assets or add_to_canvas'],
  get_generation: ['r', free, null], list_assets: ['r', free, null], add_to_canvas: ['', free, 'run_canvas'], run_canvas: ['o', paid, null],
  create_book: ['', free, 'draft_bible'], get_book: ['r', free, null], list_books: ['r', free, 'get_book'],
  update_book: ['i', free, null], draft_bible: ['do', 'Uses the writer model (may spend credits).', 'plan_pages or outline_book'],
  plan_pages: ['do', 'Uses the writer model (may spend credits); with replace=false existing pages are kept.', 'generate_illustration'],
  edit_page: ['i', free, null], revise_page: ['o', 'Uses the writer model (may spend credits).', null],
  generate_illustration: ['o', paid, 'generate_cover or export_book'], outline_book: ['do', 'Uses the writer model (may spend credits).', 'draft_chapter'],
  draft_chapter: ['do', 'Uses the writer model (may spend credits).', 'read_chapter'], read_chapter: ['r', free, null],
  revise_chapter: ['o', 'Uses the writer model (may spend credits).', null], edit_chapter: ['i', free, null],
  generate_cover: ['o', paid, 'export_book'], narrate: ['o', paid, 'export_book'], generate_speech: ['o', 'Free with a local voice (Kokoro, Chatterbox); provider voices may spend credits.', null],
  list_voices: ['r', free, 'preview_voice, then cast_voices or set_character_voice'], find_music: ['ro', 'Free (searches Openverse on the internet).', 'set_background_music (trackId)'], set_background_music: ['io', 'Free; may download a track from the internet (CC0 / CC BY music).', 'join_storyboard (the music is mixed in when the film is joined)'], cast_voices: ['i', 'Free with the local voices (the default); provider voices may spend a little per line when record=true.', 'preview_voice, then voice_dialogue (or record=true)'], preview_voice: ['o', 'Free with a local voice; provider voices may spend a little.', 'set_character_voice or generate_speech'],
  generate_video: ['o', paid, 'get_generation (if wait=false)'], import_manuscript: ['', free, 'read_chapter or revise_chapter'],
  create_storyboard: ['o', 'Planning uses the writer model (a little credit); plan=false is free.', 'film_next_step'],
  import_shot_plan: ['d', free, 'film_next_step'], production_readiness: ['r', free, 'estimate_film_cost'],
  get_storyboard: ['r', free, 'film_next_step'], update_shot: ['i', free, null], review_shot: ['i', free, 'film_next_step'],
  render_still_shot: ['i', local, null], voice_dialogue: ['o', 'May spend a little per line on the voice provider (free with a local voice).', 'lip_sync_shot (if enabled)'],
  estimate_film_cost: ['r', free, 'produce_film or generate_storyboard_shots'], openrouter_credit_status: ['ro', free, 'budget_status'],
  budget_status: ['r', free, 'decide_approval'], decide_approval: ['', free, 'repeat the refused call unchanged'],
  refresh_models: ['io', free, 'list_models'], generate_shot: ['o', paid, 'preview_shot then review_shot'],
  generate_storyboard_shots: ['o', paid, 'watch_jobs, then film_next_step'], produce_film: ['o', paid, 'get_storyboard (production)'],
  enhance_video: ['', local, null], bake_character: ['d', local, 'generate_shot / generate_storyboard_shots'],
  lip_sync_shot: ['i', local, 'preview_shot'], inspect_video: ['r', free, null], interpolate_video: ['', local, null],
  import_video: ['', free, null], join_storyboard: ['i', free, 'enhance_video (optional)'], export_book: ['', free, null],
  preview_shot: ['r', free, 'review_shot'], preview_storyboard: ['r', free, 'review_shot'],
  plan_storyboard: ['do', 'Uses the writer model (may spend credits); refused under a strict budget.', 'film_next_step'],
  film_next_step: ['r', free, 'the tool call in the choice the user picks'], watch_jobs: ['r', free, 'film_next_step'],
  cancel_job: ['d', free, null], film_checklist: ['r', free, null], adjust_shot_look: ['i', free, 'join_storyboard'],
  move_shot: ['', free, 'join_storyboard'], trim_shot: ['i', free, 'join_storyboard'], set_character_voice: ['i', free, 'voice_dialogue'],
  list_shot_takes: ['r', free, 'select_shot_take'], select_shot_take: ['i', local, 'review_shot'],
  attach_clip_to_shot: ['i', local, 'review_shot'],
  repair_frame: ['o', 'Free with a local inpaint model; a paid one (for example fal.ai FLUX.1 Fill pro) may spend credits (budget approvals apply).', 'get_generation, then select_shot_take'],
  rerecord_line: ['o', 'May spend a little on the voice provider (free with a local voice).', 'get_generation or watch_jobs, then preview_shot'],
  set_line_timing: ['i', free, 'preview_shot'], set_shot_timing: ['i', free, 'join_storyboard'], export_production: ['', free, null],
};

export function toolAnnotations(name) {
  const flags = TOOL_META[name]?.[0] ?? '';
  const readOnlyHint = flags.includes('r');
  return {
    readOnlyHint,
    ...(readOnlyHint ? {} : { destructiveHint: flags.includes('d'), idempotentHint: flags.includes('i') }),
    openWorldHint: flags.includes('o'),
  };
}
export const toolNames = () => Object.keys(TOOL_META);

// A short hint for an API error, so the model knows what to do next. Never hides the API's own message.
export function errorHint(error) {
  const status = error?.status;
  const message = String(error?.message ?? '');
  if (status === 402) {
    return error.data?.approvalId || /approv/i.test(message)
      ? 'Hint: this paid request needs a spending approval. Call budget_status, show the estimate to the user and, only if they agree, decide_approval (needs MCP approvals enabled in the app; otherwise the user approves it in Lumina Settings -> Budget), then repeat the identical call. Do not retry in a loop.'
      : 'Hint: the budget refuses this spend. Call budget_status to see the limits; they can only be changed in the Lumina app. Do not retry paid work.';
  }
  if (status === 403 && /approval/i.test(message)) return 'Hint: ask the user to approve it in the Lumina app (Settings -> Budget).';
  if (status === 409) {
    if (/lip sync is turned off/i.test(message)) return 'Hint: lip sync is off by default per storyboard. Ask the user to turn it on in the storyboard\'s Settings (or create the storyboard with lipSync: true).';
    if (/locked/i.test(message)) return 'Hint: the item is locked (approved). Send locked: false in the same call only if the user wants it changed.';
    return 'Hint: Lumina is busy with this item or its state does not allow it. Call watch_jobs (waitSeconds up to 60) and try again when the job has finished; do not submit a duplicate paid job.';
  }
  if (status === 422 && error.data?.needBox) return 'Hint: the mouth was not found. Look at preview_shot, then call lip_sync_shot again with mouthBox [x1, y1, x2, y2] as fractions of the frame (0-1).';
  if (status === 428 || error.data?.needsDownload) return 'Hint: a local tool or model must be installed first. Ask the user to install it in the Lumina app (Storyboard -> Picture quality for RIFE / Real-ESRGAN, Settings for local models).';
  if (status === 501) {
    if (/ffmpeg/i.test(message)) return 'Hint: ffmpeg is not installed on the computer running Lumina (Debian/Ubuntu: sudo apt install ffmpeg).';
    return 'Hint: not available on this computer (not installed or not supported). The message above says what is missing; ask the user to install it from the Lumina app.';
  }
  if (status === 404) return 'Hint: that id was not found. Get a fresh id from list_projects / get_storyboard / list_characters / list_books.';
  if (status === 429) return 'Hint: rate limited. Wait a minute before retrying.';
  return '';
}

function filmPrompt(text) {
  return { messages: [{ role: 'user', content: { type: 'text', text } }] };
}


// One HTTP call from an MCP server to Lumina's API. Calls are marked as coming from MCP (budget approvals look
// at this) and may carry an approval id. Budget refusals keep their details (approvalId, estimate) for the client.
export async function callLumina({ origin, token, method, route, body, approvalId, timeoutMs = 660_000 }) {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`, 'x-lumina-client': 'mcp',
      ...(approvalId ? { 'x-lumina-approval-id': approvalId } : {}), ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const { error, ...details } = data;
    const extra = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
    throw Object.assign(new Error(`${error || `Lumina returned HTTP ${response.status}`}${extra}`), { status: response.status, data });
  }
  return data;
}

export function registerLuminaTools(server, client) {
  // The remote endpoint builds its McpServer without options: give it the shared playbook before it connects.
  if (server.server && !server.server._instructions) server.server._instructions = LUMINA_INSTRUCTIONS;
  // Every tool gets annotations and a title; cost and next-step hints from TOOL_META are appended to the description.
  const tool = (name, config, handler) => {
    const meta = TOOL_META[name];
    const extra = meta && !/\bCost:/.test(config.description) ? ` Cost: ${meta[1]}${meta[2] ? ` Next: ${meta[2]}.` : ''}` : '';
    return server.registerTool(name, {
      ...config, title: config.title ?? name.replace(/_/g, ' '), description: `${config.description}${extra}`,
      annotations: { ...toolAnnotations(name), ...config.annotations },
    }, handler);
  };
  const text = (value) => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) });
  const ok = (...content) => ({ content });
  const hintFor = (error) => errorHint(error);
  const fail = (error) => {
    const hint = hintFor(error);
    return { content: [text(hint ? `${error.message}\n\n${hint}` : error.message)], isError: true };
  };
  const safe = (handler) => async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      return fail(error);
    }
  };

  function summarizeGeneration(g) {
    return {
      id: g.id, status: g.status, operation: g.operation, provider: g.provider, model: g.model, prompt: g.prompt,
      seed: g.params?.seed, presets: g.params?.presets, finalPrompt: g.finalPrompt, assetId: g.assetId, error: g.userError ?? undefined, createdAt: g.createdAt,
    };
  }

  async function imageContent(assetPath) {
      if (!assetPath) return [];
      const where = client.localFile ? ` ${client.localFile(assetPath)}` : '';
      const response = await client.fetchRaw(assetPath);
      if (!response.ok) return [text(`Image saved in Lumina.${where}`)];
      const bytes = Buffer.from(await response.arrayBuffer());
      const mimeType = response.headers.get('content-type') || 'image/png';
      if (bytes.length > maxInlineImageBytes) return [text(`Image saved in Lumina (too large to show inline).${where}`)];
      return [{ type: 'image', data: bytes.toString('base64'), mimeType }, ...(where ? [text(`Image file:${where}`)] : [])];
    }

    async function pickModel(operation, provider, model) {
    const { providers } = await client.call('GET', '/api/catalog');
    if (provider && model) return { provider, model };
    const options = providers.filter((p) => p.ready && (!provider || p.id === provider))
      .flatMap((p) => p.models.filter((m) => m.available !== false && m.operations.includes(operation)).map((m) => ({ provider: p.id, model: m.id })));
    if (!options.length) throw new Error(`No ${operation}-capable model has an API key configured. Add a key in Lumina → Settings.`);
    return options[0];
  }

  // search + fetch: the read-only pair ChatGPT connectors and deep research require (OpenAI's compatibility schema).
  const citeUrl = (id) => (client.siteUrl ? `${client.siteUrl.replace(/\/$/, '')}/#${id}` : `lumina://${id.replace(':', '/')}`);
  const structured = (value) => ({ structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] });
  tool('search', {
    title: 'Search Lumina',
    description: 'Search the user\'s Lumina work — projects, books, chapters, storyboards and characters — by keywords. Returns ids to pass to fetch. An empty query lists recent items.',
    inputSchema: { query: z.string().describe('Keywords to look for') },
    annotations: { readOnlyHint: true },
  }, safe(async ({ query }) => {
    const { results } = await client.call('GET', `/api/search?q=${encodeURIComponent(query ?? '')}`);
    return structured({ results: results.map((d) => ({ id: d.id, title: d.title, url: citeUrl(d.id) })) });
  }));
  tool('fetch', {
    title: 'Fetch a Lumina item',
    description: 'Read the full text of a search result (a book with its pages or chapter list, a chapter\'s text, a storyboard\'s shots, a character\'s look) by its id from search.',
    inputSchema: { id: z.string().describe('An id returned by search, such as "chapter:<uuid>"') },
    annotations: { readOnlyHint: true },
  }, safe(async ({ id }) => {
    const doc = await client.call('GET', `/api/search/document?id=${encodeURIComponent(id)}`);
    return structured({ id: doc.id, title: doc.title, text: doc.text, url: citeUrl(doc.id), metadata: doc.metadata });
  }));

  tool('list_projects', {
    title: 'List projects',
    description: 'List Lumina Studio projects, most recently updated first.',
    inputSchema: {},
  }, safe(async () => ok(text((await client.call('GET', '/api/projects')).projects))));

  tool('create_project', {
    title: 'Create project',
    description: 'Create a new Lumina Studio project.',
    inputSchema: { name: z.string().min(1).max(80) },
  }, safe(async ({ name }) => ok(text((await client.call('POST', '/api/projects', { name })).project))));

  tool('list_models', {
    title: 'List providers and models',
    description: 'List providers and models, whether each provider has a key configured, and what each model supports (generate, edit, video, speech, upscale, remove-background, inpaint; sizes, durations, max input images). listPrice is the provider\'s list price when known (USD per image, megapixel or second) — an estimate, not a bill. Also lists creative directors.',
    inputSchema: {},
  }, safe(async () => {
    const { providers, directors } = await client.call('GET', '/api/catalog');
    return ok(text({
      providers: providers.map((p) => ({ id: p.id, label: p.label, ready: p.ready, models: p.models.map(({ id, label, operations, sizes, qualities, maxReferences, durations, scales, price, available }) => ({ id, label, operations, sizes, qualities, maxReferences, durations, scales, available, listPrice: price ?? undefined })) })),
      directors: directors.map((d) => ({ id: d.id, ready: d.ready, options: d.models.map((m) => `${d.id}:${m}`) })),
    }));
  }));

  tool('list_presets', {
    title: 'List presets',
    description: 'List Lumina\'s creative presets: camera moves (video only), effects (time, weather, atmosphere) and styles. Pass preset ids as `presets` to generate_image or generate_video; at most one per group.',
    inputSchema: { mode: z.enum(['image', 'video']).optional().describe('Only presets that work for this mode') },
  }, safe(async ({ mode }) => {
    const { presets } = await client.call('GET', '/api/presets');
    return ok(text(presets.filter((p) => !mode || p.modes.includes(mode)).map(({ id, group, label, blurb, modes }) => ({ id, group, label, blurb, modes }))));
  }));

  const presetsArg = z.array(z.string()).max(3).optional().describe('Preset ids from list_presets, e.g. ["dolly-in", "cinematic"]; one per group');

  const charactersArg = z.array(z.string()).max(8).optional().describe('Character and location ids from list_characters. Their look is added to the prompt; their reference photos are attached when the model accepts input images.');

  tool('list_characters', {
    title: 'List characters',
    description: 'List saved characters and products (name, look description, reference photo asset ids). Pass their ids as characterIds to generate_image, generate_video or create_storyboard to keep them consistent.',
    inputSchema: {},
  }, safe(async () => ok(text((await client.call('GET', '/api/characters')).characters.map(characterView)))));

  const characterSchema = {
    description: z.string().max(2500).optional().describe('What must never change: face, hair, build, clothing, colours (for a location: layout, architecture, props, light)'),
    kind: z.enum(['character', 'product', 'location']).optional(),
    referenceAssetIds: z.array(z.string()).max(6).optional().describe('Up to 6 reference images (front, side, three-quarter, back, close-up, full body)'),
    voice: z.object({ provider: z.string(), model: z.string(), voice: z.string().optional() }).nullable().optional().describe('Speech model for this character\'s dialogue'),
    designTags: z.string().max(400).optional().describe('Locked anime tag block for consistent design, e.g. "1girl, silver hair, long hair, red eyes, black coat, red lining"'),
    locked: z.boolean().optional().describe('Locked (approved) looks cannot change until unlocked with locked: false'),
  };
  const characterView = ({ id, name, kind, description, referenceAssetIds, voice, locked, designTags }) => ({ id, name, kind, description, designTags, referenceAssetIds, voice, locked });
  tool('create_character', {
    title: 'Create character or location',
    description: 'Save a reusable character, product or location: a name, a description of what must stay the same, and reference image asset ids from list_assets. Used in each shot to guide consistent appearances; generated results still need review.',
    inputSchema: { name: z.string().min(1).max(80), ...characterSchema },
  }, safe(async (args) => ok(text(characterView((await client.call('POST', '/api/characters', args)).character)))));

  tool('update_character', {
    title: 'Update character or location',
    description: 'Change a saved character, product or location (look, references, voice, lock). A locked look is refused unless locked: false is sent in the same call.',
    inputSchema: { characterId: z.string(), name: z.string().min(1).max(80).optional(), ...characterSchema },
  }, safe(async ({ characterId, ...changes }) => ok(text(characterView((await client.call('PATCH', `/api/characters/${characterId}`, changes)).character)))));

  tool('make_character_sheet', {
    title: 'Make character sheet',
    description: 'Generate a turnaround model sheet (front, side, back) or, with expressions: true, an expression sheet for a saved character from its designTags (or description), and add it as the character\'s first reference image when done. Uses the default anime model on this computer when installed, else the given or default provider (may cost money). Returns the queued generation; wait with watch_jobs or get_generation.',
    inputSchema: { characterId: z.string(), projectId: z.string(), expressions: z.boolean().optional(), provider: z.string().optional(), model: z.string().optional() },
  }, safe(async ({ characterId, ...rest }) => ok(text((await client.call('POST', `/api/characters/${characterId}/sheet`, rest)).generation))));

  tool('enhance_image', {
    title: 'Upscale or remove background',
    description: 'Run an image tool on one existing image: "upscale" (2× or 4×) or "remove-background" (cut-out on transparency). Returns the new image. Costs money on the user\'s provider account. Inpainting needs a painted mask, so it is only available in the Lumina app.',
    inputSchema: {
      projectId: z.string(), assetId: z.string().describe('Image asset id from list_assets or a generation'), operation: z.enum(['upscale', 'remove-background']),
      scale: z.number().int().optional().describe('Upscale factor, 2 or 4'), provider: z.string().optional(), model: z.string().optional(),
    },
  }, safe(async ({ projectId, assetId, operation, scale, provider, model }) => {
    const choice = await pickModel(operation, provider, model);
    const { generation } = await client.call('POST', '/api/generate', { projectId, operation, scale, inputAssetIds: [assetId], ...choice });
    const done = (await client.call('POST', `/api/generations/${generation.id}/wait`, { timeoutMs: 600_000 })).generation;
    if (done.status !== 'completed') return { content: [text(summarizeGeneration(done))], isError: done.status === 'failed' };
    return ok(text(summarizeGeneration(done)), ...(await imageContent(done.assetPath)));
  }));

  tool('generate_image', {
    title: 'Generate or edit an image',
    description: 'Generate an image in a Lumina project using the user\'s own provider keys. Pass inputAssetIds to edit or combine existing images. Waits for the result by default and returns the image. Costs money on the user\'s provider account.',
    inputSchema: {
      projectId: z.string().describe('Project id from list_projects'),
      prompt: z.string().min(1).max(4000),
      provider: z.string().optional().describe('Provider id from list_models; defaults to the first ready provider'),
      model: z.string().optional().describe('Model id from list_models'),
      size: z.enum(['1024x1024', '1536x1024', '1024x1536']).optional(),
      quality: z.enum(['low', 'medium', 'high']).optional(),
      seed: z.number().int().min(0).max(2147483646).optional().describe('Repeatable seed when the provider supports it; not an identity guarantee'),
      inputAssetIds: z.array(z.string()).max(4).optional().describe('Asset ids to edit or use as references'),
      director: z.string().optional().describe('Optional creative director, e.g. "anthropic:claude-opus-5-5"'),
      presets: presetsArg,
      characterIds: charactersArg,
      wait: z.boolean().optional().describe('Wait for completion (default true)'),
    },
  }, safe(async (args) => {
    const operation = args.inputAssetIds?.length ? 'edit' : 'generate';
    const choice = await pickModel(operation, args.provider, args.model);
    const { generation } = await client.call('POST', '/api/generate', { ...args, ...choice });
    if (args.wait === false) return ok(text({ ...summarizeGeneration(generation), note: 'Queued. Poll with get_generation.' }));
    const done = (await client.call('POST', `/api/generations/${generation.id}/wait`, { timeoutMs: 600_000 })).generation;
    if (done.status !== 'completed') return { content: [text(summarizeGeneration(done))], isError: done.status === 'failed' };
    return ok(text(summarizeGeneration(done)), ...(await imageContent(done.assetPath)));
  }));

  tool('get_generation', {
    title: 'Get generation',
    description: 'Get the status of one generation; returns the image when it is complete. To wait for several jobs use watch_jobs instead of polling this.',
    inputSchema: { generationId: z.string(), includeImage: z.boolean().optional() },
  }, safe(async ({ generationId, includeImage = true }) => {
    const { generation } = await client.call('GET', `/api/generations/${generationId}`);
    const image = includeImage && generation.status === 'completed' ? await imageContent(generation.assetPath) : [];
    return ok(text(summarizeGeneration(generation)), ...image);
  }));

  tool('list_assets', {
    title: 'List project images',
    description: 'List images (generated and uploaded references) in a project, plus its canvases.',
    inputSchema: { projectId: z.string() },
  }, safe(async ({ projectId }) => {
    const detail = await client.call('GET', `/api/projects/${projectId}`);
    const prompts = new Map(detail.generations.filter((g) => g.assetId).map((g) => [g.assetId, g.prompt]));
    return ok(text({
      assets: detail.assets.map((a) => ({ id: a.id, kind: a.kind, label: a.label ?? prompts.get(a.id) ?? null, createdAt: a.createdAt })),
      canvases: detail.canvases.map((c) => ({ id: c.id, name: c.name, nodeCount: c.nodeCount })),
    }));
  }));

  tool('add_to_canvas', {
    title: 'Add image to canvas',
    description: 'Add an image to a project canvas as a reference node. Uses the most recent canvas, or creates one, when canvasId is omitted.',
    inputSchema: { assetId: z.string(), canvasId: z.string().optional(), projectId: z.string().describe('Project that owns the canvas') },
  }, safe(async ({ assetId, canvasId, projectId }) => {
    let id = canvasId;
    if (!id) {
      const { canvases } = await client.call('GET', `/api/projects/${projectId}`);
      id = canvases[0]?.id ?? (await client.call('POST', `/api/projects/${projectId}/canvases`, { name: 'Canvas 1' })).canvas.id;
    }
    const { canvas } = await client.call('GET', `/api/canvases/${id}`);
    const maxY = canvas.graph.nodes.reduce((y, n) => Math.max(y, n.y + 260), 40);
    const node = { id: `r${Date.now().toString(36)}`, type: 'reference', x: 40, y: maxY, data: { assetId } };
    const saved = await client.call('PUT', `/api/canvases/${id}`, { graph: { ...canvas.graph, nodes: [...canvas.graph.nodes, node] }, version: canvas.version });
    return ok(text({ canvasId: id, canvasName: saved.canvas.name, nodeId: node.id }));
  }));

  tool('run_canvas', {
    title: 'Run canvas',
    description: 'Run a canvas workflow (or only what one node needs) and wait for it to finish. Generate/edit nodes spend money on the user\'s provider accounts.',
    inputSchema: { canvasId: z.string(), nodeId: z.string().optional(), timeoutSeconds: z.number().int().min(10).max(1800).optional() },
  }, safe(async ({ canvasId, nodeId, timeoutSeconds = 600 }) => {
    let { run } = await client.call('POST', `/api/canvases/${canvasId}/run`, { nodeId });
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (run.status === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      run = (await client.call('GET', `/api/canvas-runs/${run.id}`)).run;
    }
    const nodes = Object.fromEntries(Object.entries(run.nodeState).map(([id, s]) => [id, { status: s.status, assetId: s.assetId, error: s.error }]));
    return { content: [text({ runId: run.id, status: run.status, nodes })], isError: run.status === 'failed' };
  }));

  // ---------- Book Studio ----------

  const briefShape = {
    premise: z.string().max(4000).optional(), audience: z.string().max(200).optional(), language: z.string().max(80).optional(),
    genre: z.string().max(120).optional(), tone: z.string().max(200).optional(), pageCount: z.number().int().min(1).max(48).optional(),
    trimSize: z.enum(['8x8', '8.5x11', '10x8', '6x9', '5.5x8.5']).optional(), illustrationStyle: z.string().max(1000).optional(), author: z.string().max(120).optional(),
    chapterCount: z.number().int().min(1).max(60).optional(), wordsPerChapter: z.number().int().min(200).max(8000).optional(),
    layout: z.enum(['art-top', 'full-bleed']).optional(), bleed: z.boolean().optional(),
    narration: z.object({ provider: z.string(), model: z.string(), voice: z.string().optional(), style: z.string().optional() }).optional().describe('Default narration voice (speech model from list_models)'),
  };

  // Chapter text can be long; get_book returns an excerpt and read_chapter returns the full text.
  function bookSummary({ book, pages, chapters }) {
    return {
      id: book.id, kind: book.kind, title: book.title, projectId: book.projectId, writer: book.writer, brief: book.brief, bible: book.bible,
      hasCover: Boolean(book.coverAssetId),
      pages: book.kind === 'picture_book' ? pages.map((p) => ({ id: p.id, position: p.position, text: p.text, illustrationBrief: p.illustrationBrief, hasIllustration: Boolean(p.assetId), narrated: Boolean(p.narrationAssetId), animated: Boolean(p.videoAssetId) })) : undefined,
      chapters: book.kind !== 'picture_book' ? chapters.map((c) => ({ id: c.id, position: c.position, title: c.title, summary: c.summary, beats: c.beats, words: c.words, excerpt: c.text.slice(0, 400), narrated: Boolean(c.narrationAssetId), hasArt: Boolean(c.assetId) })) : undefined,
    };
  }

  async function waitAndShow(generation, extra = {}) {
    const done = (await client.call('POST', `/api/generations/${generation.id}/wait`, { timeoutMs: 600_000 })).generation;
    if (done.status !== 'completed') return { content: [text({ ...summarizeGeneration(done), ...extra })], isError: done.status === 'failed' };
    const media = done.operation === 'speech' || done.operation === 'video'
      ? [text(`${done.operation === 'speech' ? 'Audio' : 'Video'} saved in Lumina's library${client.localFile ? `: ${client.localFile(done.assetPath)}` : ''}.`)]
      : await imageContent(done.assetPath);
    return ok(text({ ...summarizeGeneration(done), ...extra }), ...media);
  }

  tool('create_book', {
    title: 'Create book',
    description: 'Create a book in a Lumina project from a brief. kind: picture_book (pages with illustrations), novel, or nonfiction (chapters). Next: draft_bible; then plan_pages (picture books) or outline_book + draft_chapter (novels/nonfiction); then illustrations/cover/narration and export_book.',
    inputSchema: {
      projectId: z.string(), title: z.string().min(1).max(80), kind: z.enum(['picture_book', 'novel', 'nonfiction']).optional(),
      writer: z.string().optional().describe('Writer model as "provider:model" (see list_models directors), e.g. "anthropic:claude-opus-5-5"'), ...briefShape,
    },
  }, safe(async ({ projectId, title, kind, writer, ...brief }) => {
    const { book } = await client.call('POST', `/api/projects/${projectId}/books`, { title, kind, writer, brief });
    return ok(text(bookSummary(await client.call('GET', `/api/books/${book.id}`))));
  }));

  tool('get_book', {
    title: 'Get book',
    description: 'Read a book: brief, story bible and every page\'s text, illustration brief and illustration status. Use list_books to find ids.',
    inputSchema: { bookId: z.string() },
  }, safe(async ({ bookId }) => ok(text(bookSummary(await client.call('GET', `/api/books/${bookId}`))))));

  tool('list_books', {
    title: 'List books',
    description: 'List books in a project.',
    inputSchema: { projectId: z.string() },
  }, safe(async ({ projectId }) => ok(text((await client.call('GET', `/api/projects/${projectId}/books`)).books.map(({ id, title, pageCount, updatedAt }) => ({ id, title, pageCount, updatedAt }))))));

  tool('update_book', {
    title: 'Update book brief or story bible',
    description: 'Edit a book\'s title, brief fields, writer, or story bible (characters with name/description/visual, setting, voice, styleNotes). Pass the whole bible object when changing it.',
    inputSchema: {
      bookId: z.string(), title: z.string().max(80).optional(), writer: z.string().optional(), brief: z.object(briefShape).optional(),
      bible: z.object({
        characters: z.array(z.object({ name: z.string(), description: z.string().optional(), visual: z.string().optional(), referenceAssetIds: z.array(z.string()).max(4).optional() })).optional(),
        setting: z.string().optional(), voice: z.string().optional(), styleNotes: z.string().optional(), styleReferenceAssetIds: z.array(z.string()).max(4).optional(),
      }).optional(),
    },
  }, safe(async ({ bookId, ...changes }) => {
    await client.call('PATCH', `/api/books/${bookId}`, changes);
    return ok(text(bookSummary(await client.call('GET', `/api/books/${bookId}`))));
  }));

  tool('draft_bible', {
    title: 'Draft story bible',
    description: 'Have the book\'s writer model draft the story bible (characters, setting, voice, visual style) from the brief. Replaces the current bible; uses the user\'s text-model credits.',
    inputSchema: { bookId: z.string(), writer: z.string().optional() },
  }, safe(async ({ bookId, writer }) => {
    await client.call('POST', `/api/books/${bookId}/bible`, { writer });
    return ok(text(bookSummary(await client.call('GET', `/api/books/${bookId}`))));
  }));

  tool('plan_pages', {
    title: 'Plan pages',
    description: 'Have the writer model write every page (text + illustration brief) from the brief and story bible. Set replace=true to overwrite existing pages — ask the user first.',
    inputSchema: { bookId: z.string(), writer: z.string().optional(), replace: z.boolean().optional() },
  }, safe(async ({ bookId, writer, replace }) => ok(text(bookSummary(await client.call('POST', `/api/books/${bookId}/plan`, { writer, replace }))))));

  tool('edit_page', {
    title: 'Edit page',
    description: 'Set a page\'s text and/or illustration brief directly (previous version kept in history).',
    inputSchema: { pageId: z.string(), text: z.string().max(4000).optional(), illustrationBrief: z.string().max(2000).optional() },
  }, safe(async ({ pageId, ...changes }) => ok(text((await client.call('PATCH', `/api/pages/${pageId}`, changes)).page))));

  tool('revise_page', {
    title: 'Revise page with the writer',
    description: 'Ask the writer model to revise one page following an instruction, keeping it consistent with the story bible and neighbouring pages.',
    inputSchema: { pageId: z.string(), instruction: z.string().min(1).max(2000), writer: z.string().optional() },
  }, safe(async (args) => ok(text((await client.call('POST', `/api/pages/${args.pageId}/revise`, args)).page))));

  tool('generate_illustration', {
    title: 'Illustrate page',
    description: 'Generate an illustration for one page using its brief plus the story bible\'s character looks and reference images. Waits and returns the image. Costs money on the user\'s image provider — confirm with the user before illustrating many pages.',
    inputSchema: { pageId: z.string(), provider: z.string().optional(), model: z.string().optional(), wait: z.boolean().optional() },
  }, safe(async ({ pageId, provider, model, wait = true }) => {
    const choice = await pickModel('generate', provider, model);
    const { generation, droppedReferences } = await client.call('POST', `/api/pages/${pageId}/illustrate`, choice);
    const note = droppedReferences ? `${droppedReferences} reference image(s) not sent: this model does not accept input images.` : undefined;
    if (!wait) return ok(text({ ...summarizeGeneration(generation), note }));
    const done = (await client.call('POST', `/api/generations/${generation.id}/wait`, { timeoutMs: 600_000 })).generation;
    if (done.status !== 'completed') return { content: [text(summarizeGeneration(done))], isError: true };
    return ok(text({ ...summarizeGeneration(done), note }), ...(await imageContent(done.assetPath)));
  }));

  tool('outline_book', {
    title: 'Outline novel or nonfiction',
    description: 'Have the writer model outline every chapter (title, summary, scenes or sections) from the brief and bible. replace=true overwrites existing chapters — ask the user first.',
    inputSchema: { bookId: z.string(), writer: z.string().optional(), replace: z.boolean().optional() },
  }, safe(async ({ bookId, writer, replace }) => ok(text(bookSummary(await client.call('POST', `/api/books/${bookId}/outline`, { writer, replace }))))));

  tool('draft_chapter', {
    title: 'Draft chapter',
    description: 'Have the writer model write a chapter in full from its outline, the bible and earlier chapters (keeps continuity). Replaces the chapter text; the previous version stays in history. Takes a minute or more.',
    inputSchema: { chapterId: z.string(), writer: z.string().optional(), instructions: z.string().max(2000).optional() },
  }, safe(async ({ chapterId, ...rest }) => {
    const { chapter } = await client.call('POST', `/api/chapters/${chapterId}/draft`, rest);
    return ok(text({ id: chapter.id, position: chapter.position, title: chapter.title, words: (chapter.text.match(/\S+/g) ?? []).length, excerpt: chapter.text.slice(0, 1200) }));
  }));

  tool('read_chapter', {
    title: 'Read chapter',
    description: 'Return a chapter\'s full text, outline and beats.',
    inputSchema: { bookId: z.string(), chapterId: z.string() },
  }, safe(async ({ bookId, chapterId }) => {
    const { chapters } = await client.call('GET', `/api/books/${bookId}`);
    const chapter = chapters.find((c) => c.id === chapterId);
    if (!chapter) throw new Error('Chapter not found in this book.');
    const { assetPath, narrationPath, artJobs, narrationJobs, ...rest } = chapter;
    return ok(text(rest));
  }));

  tool('revise_chapter', {
    title: 'Revise chapter with the writer',
    description: 'Ask the writer model to rewrite a drafted chapter following an instruction (e.g. "tighten the opening", "more dialogue"). Previous version kept in history.',
    inputSchema: { chapterId: z.string(), instruction: z.string().min(1).max(2000), writer: z.string().optional() },
  }, safe(async ({ chapterId, ...rest }) => {
    const { chapter } = await client.call('POST', `/api/chapters/${chapterId}/revise`, rest);
    return ok(text({ id: chapter.id, words: (chapter.text.match(/\S+/g) ?? []).length, excerpt: chapter.text.slice(0, 1200) }));
  }));

  tool('edit_chapter', {
    title: 'Edit chapter',
    description: 'Set a chapter\'s title, summary, beats (scenes/sections) and/or full text directly. Previous version kept in history.',
    inputSchema: { chapterId: z.string(), title: z.string().max(200).optional(), summary: z.string().max(3000).optional(), beats: z.array(z.string().max(1000)).max(30).optional(), text: z.string().max(400000).optional() },
  }, safe(async ({ chapterId, ...changes }) => {
    const { chapter } = await client.call('PATCH', `/api/chapters/${chapterId}`, changes);
    return ok(text({ id: chapter.id, title: chapter.title, words: (chapter.text.match(/\S+/g) ?? []).length }));
  }));

  tool('generate_cover', {
    title: 'Generate book cover',
    description: 'Generate cover art from the brief and bible (title is typeset separately in exports). Costs money on the image provider.',
    inputSchema: { bookId: z.string(), provider: z.string().optional(), model: z.string().optional() },
  }, safe(async ({ bookId, provider, model }) => {
    const { generation, droppedReferences } = await client.call('POST', `/api/books/${bookId}/cover`, await pickModel('generate', provider, model));
    return waitAndShow(generation, droppedReferences ? { note: `${droppedReferences} reference image(s) not sent (model does not accept input images).` } : {});
  }));

  tool('narrate', {
    title: 'Narrate page or chapter',
    description: 'Turn a picture-book page or a chapter into narration audio with the book\'s narration voice (set it with update_book brief.narration, or pass provider/model/voice). Costs money on the voice provider.',
    inputSchema: { pageId: z.string().optional(), chapterId: z.string().optional(), provider: z.string().optional(), model: z.string().optional(), voice: z.string().optional(), style: z.string().max(500).optional() },
  }, safe(async ({ pageId, chapterId, ...voice }) => {
    if (!pageId === !chapterId) throw new Error('Pass exactly one of pageId or chapterId.');
    const { generation } = await client.call('POST', pageId ? `/api/pages/${pageId}/narrate` : `/api/chapters/${chapterId}/narrate`, voice);
    return waitAndShow(generation);
  }));

  // Speech models with their voices; local voices (free, on this computer) first.
  async function speechModels() {
    const { providers } = await client.call('GET', '/api/catalog');
    return providers.flatMap((p) => p.models.filter((m) => m.operations.includes('speech')).map((m) => ({
      provider: p.id, model: m.id, label: m.label, local: p.id === 'local', ready: Boolean(p.ready && m.available !== false),
      voices: m.voices ?? [], note: m.note, setup: p.ready && m.available !== false ? undefined : p.id === 'local' ? 'Run scripts/setup-voices.sh (free, about 1 GB), then restart Lumina.' : 'Add this provider\'s key in Lumina → Settings.',
    }))).sort((a, b) => Number(b.local) - Number(a.local));
  }
  async function pickVoice(provider, model) {
    if (provider && model) return { provider, model };
    const all = await speechModels();
    const ready = all.filter((m) => m.ready && (!provider || m.provider === provider) && (!model || m.model === model));
    const choice = ready.find((m) => m.model === 'kokoro-82m') ?? ready[0];
    if (!choice) {
      const named = model && all.find((m) => m.model === model);
      throw new Error(named ? `${named.label} is not ready. ${named.setup}` : 'No voice is ready. Install the free local voices (scripts/setup-voices.sh) or add a voice provider key in Lumina → Settings.');
    }
    return { provider: choice.provider, model: choice.model, voices: choice.voices };
  }
  const kokoroVoiceNote = 'Kokoro/Chatterbox voice names: first letter is the accent (a American, b British), second is f female / m male, e.g. af_heart, am_michael, bf_emma, bm_george.';

  tool('list_voices', {
    title: 'List voices',
    description: `List every voice model (local and provider) with its voice names, whether it is ready to use, and how to set it up if not. ${kokoroVoiceNote} Chatterbox acts the line with emotion (style text such as "furious" or "whispering"); Kokoro is fast and plain.`,
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, safe(async () => ok(text({ models: await speechModels(), tip: 'Try one with preview_voice, then give a character its voice with set_character_voice.' }))));

  tool('preview_voice', {
    title: 'Preview a voice',
    description: `Speak a short sample in one voice and return the audio so the user can hear it (also saved to the project library). Without provider/model the local Kokoro voice is used. ${kokoroVoiceNote}`,
    inputSchema: {
      projectId: z.string(), voice: z.string().optional().describe('Voice name from list_voices, e.g. "af_heart"'),
      text: z.string().min(1).max(300).optional().describe('What to say (default: a short test line)'),
      provider: z.string().optional(), model: z.string().optional(), style: z.string().max(200).optional().describe('Chatterbox / provider voices: how to act the line, e.g. "excited"'),
    },
  }, safe(async ({ projectId, voice, text: words, provider, model, style }) => {
    const { voices, ...choice } = await pickVoice(provider, model);
    if (voice && voices?.length && !voices.includes(voice)) throw new Error(`${choice.model} has no voice "${voice}". Its voices: ${voices.join(', ')}.`);
    const line = words ?? 'Hi! This is how I sound. Shall we start the story?';
    const { generation } = await client.call('POST', '/api/generate', { projectId, operation: 'speech', prompt: line, voice, style, ...choice });
    const done = (await client.call('POST', `/api/generations/${generation.id}/wait`, { timeoutMs: 240_000 })).generation;
    if (done.status !== 'completed') return { content: [text(summarizeGeneration(done))], isError: done.status === 'failed' };
    const used = done.params?.voice ?? voice ?? null;
    const parts = await mediaParts([[done.assetPath, 'audio', `Voice sample (${used ?? 'default voice'})`]]);
    return ok(text({ ...choice, voice: used, text: line, assetId: done.assetId, file: client.localFile ? client.localFile(done.assetPath) : undefined }), ...parts);
  }));

  tool('generate_speech', {
    title: 'Generate speech',
    description: 'Turn any text into spoken audio (saved to the project library). Long text is split and joined automatically. Without provider/model a local voice (Kokoro) is used when installed. See list_voices for voice names.',
    inputSchema: { projectId: z.string(), text: z.string().min(1).max(200000), provider: z.string().optional(), model: z.string().optional(), voice: z.string().optional(), style: z.string().max(500).optional() },
  }, safe(async ({ projectId, text: words, provider, model, voice, style }) => {
    const { voices: _voices, ...choice } = await pickVoice(provider, model);
    const { generation } = await client.call('POST', '/api/generate', { projectId, operation: 'speech', prompt: words, voice, style, ...choice });
    return waitAndShow(generation);
  }));

  tool('generate_video', {
    title: 'Generate video',
    description: 'Generate a short video clip from a prompt, optionally animating an image (inputAssetId). Slow (minutes) and dearer than images; paid requests go through budget approvals. Use wait=false for long jobs and never submit a second paid take while one is running.',
    inputSchema: { projectId: z.string(), prompt: z.string().min(1).max(4000), inputAssetId: z.string().optional(), provider: z.string().optional(), model: z.string().optional(), duration: z.number().int().optional(), aspect: z.string().optional(), seed: z.number().int().min(0).max(2147483646).optional(), wait: z.boolean().optional().describe('Use false for long jobs; poll get_generation'), presets: presetsArg, characterIds: charactersArg },
  }, safe(async ({ projectId, prompt, inputAssetId, provider, model, duration, aspect, seed, wait = true, presets, characterIds }) => {
    const choice = await pickModel('video', provider, model);
    const { generation } = await client.call('POST', '/api/generate', { projectId, operation: 'video', prompt, inputAssetIds: inputAssetId ? [inputAssetId] : [], duration, aspect, seed, presets, characterIds, ...choice });
    if (!wait) return ok(text({ ...summarizeGeneration(generation), note: 'Queued. Poll get_generation; do not submit another paid take while this one runs.' }));
    return waitAndShow(generation);
  }));

  tool('import_manuscript', {
    title: 'Import manuscript',
    description: 'Create a novel or nonfiction book from existing text. Chapters are split at Markdown headings ("# Title", "## Chapter") or lines like "Chapter 3". Afterwards use read_chapter, revise_chapter, edit_chapter, or add chapters and draft_chapter to continue the book.',
    inputSchema: {
      projectId: z.string(), text: z.string().min(1).max(2_000_000), title: z.string().max(80).optional(), kind: z.enum(['novel', 'nonfiction']).optional(),
      writer: z.string().optional().describe('Writer model for later revisions, e.g. "anthropic:claude-opus-5-5"'),
    },
  }, safe(async ({ projectId, text: body, title, kind, writer }) => ok(text(bookSummary(await client.call('POST', `/api/projects/${projectId}/books/import`, { text: body, fileName: 'manuscript.md', title, kind, writer }))))));

  // ---------- Storyboards ----------
  const storyboardSummary = ({ sequence, shots }) => ({
    id: sequence.id, projectId: sequence.projectId, title: sequence.title, idea: sequence.idea, writer: sequence.writer, settings: sequence.settings,
    hasJoinedVideo: Boolean(sequence.outputAssetId), joinedVideoAssetId: sequence.outputAssetId ?? undefined, join: sequence.join ?? undefined,
    runningSeconds: shots.reduce((sum, s) => sum + (s.duration ?? 0), 0),
    production: sequence.production ?? undefined, screenplay: sequence.screenplay ? `${sequence.screenplay.length} characters` : undefined,
    themes: sequence.settings.themes?.length ? sequence.themeCoverage : undefined,
    shots: shots.map((s) => ({
      id: s.id, position: s.position, description: s.description, camera: s.camera, duration: s.duration, frameAssetId: s.imageAssetId, clipAssetId: s.videoAssetId,
      frameStatus: s.frameJob?.status, clipStatus: s.clipJob?.status,
      scene: s.details?.scene || undefined, method: s.details?.method, characterIds: s.details?.characterIds, locationId: s.details?.locationId ?? undefined,
      action: s.details?.action || undefined, startState: s.details?.startState || undefined, endState: s.details?.endState || undefined,
      dialogue: s.details?.dialogue?.length ? s.details.dialogue.map((l) => ({ speaker: l.speaker, text: l.text, recorded: Boolean(l.assetId) })) : undefined,
      themes: s.details?.themes?.length ? s.details.themes : undefined, locked: s.details?.locked || undefined, review: s.review?.status, frameApproved: s.review?.frameApproved ? true : undefined,
      problems: s.review?.checks?.filter((c) => !c.ok).map((c) => c.detail),
    })),
  });

  tool('create_storyboard', {
    title: 'Create storyboard',
    description: 'Turn an idea into a storyboard: a writer model plans the shots (description, camera move, length). For a film of a given length set targetMinutes (up to 15) and enough shots (a 5-minute film is about 30-40 shots). Next: generate_storyboard_shots (or generate_shot) for frames and clips, then join_storyboard for one video. Planning costs a little on the writer\'s provider account.',
    inputSchema: {
      projectId: z.string(), title: z.string().min(1).max(80), idea: z.string().min(1).max(6000), shotCount: z.number().int().min(1).max(60).optional(),
      targetMinutes: z.number().min(0).max(15).optional().describe('Total running time the writer aims for'),
      clipLength: z.number().int().min(0).max(30).optional().describe('Seconds per clip for every shot (0 = writer decides); long takes like 10-15 s need a model that supports them'),
      continuity: z.enum(['frames', 'keyframes', 'chain']).optional().describe('"frames": each clip starts from its own approved still; "keyframes": also ends on the next shot\'s still within a scene (strongest against drift; needs a model with last-frame support); "chain": each clip starts from the previous clip\'s last frame'),
      look: z.enum(['live-action', 'anime', 'as-written']).optional().describe('How every frame and clip is directed (default live-action). Anime is English only'),
      lookBible: z.string().max(1500).optional().describe('Palette, lenses, lighting, era, grain: added to every prompt so the film looks like one film'),
      themes: z.array(z.string().max(300)).max(8).optional().describe('Themes the audience must clearly see, as "Name: how it shows on screen" (e.g. "Chaos agent: a grinning trickster who breaks every plan with fire"). The writer gives each one people, actions and a recurring image, and tags the shots; get_storyboard reports where each appears'),
      screenplay: z.string().max(60000).optional().describe('A screenplay to follow scene by scene, dialogue word for word (instead of inventing from the idea)'),
      seed: z.number().int().min(0).optional().describe('One seed for every frame and clip (random by default)'),
      outputHeight: z.union([z.literal(720), z.literal(1080), z.literal(1440), z.literal(2160)]).optional().describe('Delivery height (default 1080)'),
      upscale: z.enum(['none', 'fast', 'anime', 'ai']).optional().describe('How clips smaller than the delivery size are enlarged (once each, from the original): "anime" Real-ESRGAN anime model, "ai" Real-ESRGAN live action, "fast" Lanczos'),
      colorMatch: z.enum(['scene', 'film', 'off']).optional().describe('Match every shot\'s colours to the first shot of its scene (default) or of the film, free and local'),
      narratorVoice: z.object({ provider: z.string(), model: z.string(), voice: z.string().optional() }).optional(),
      interpolateFps: z.union([z.literal(0), z.literal(30)]).optional(),
      lipSync: z.boolean().optional().describe('Allow lip sync (mouth movement) on shots with recorded dialogue (default false: off unless turned on). When false, lip_sync_shot is refused.'),
      requireApproval: z.boolean().optional().describe('Frames and clips must be accepted (review_shot) before video is paid for and before the film is joined'),
      videoSecondsBudget: z.number().int().min(0).max(900).optional().describe('Seconds of paid video the writer may plan; the rest become free still shots'),
      transition: z.enum(['cut', 'crossfade']).optional(), finish: z.enum(['none', 'cinematic', 'anime']).optional().describe('"cinematic": 2.39:1 bars, film grain, fades; "anime": cleaner flat colour, richer colour, crisp line art, short fades'),
      aspect: z.enum(['16:9', '9:16', '1:1']).optional(), style: z.string().optional().describe('A style preset id from list_presets'), characterIds: charactersArg,
      imageProvider: z.string().optional(), imageModel: z.string().optional(), videoProvider: z.string().optional(), videoModel: z.string().optional(),
      writer: z.string().optional().describe('Writer model as "provider:model" (see list_models directors); defaults to the first ready one'),
      plan: z.boolean().optional().describe('Plan the shots now (default true)'),
    },
  }, safe(async ({ projectId, title, idea, screenplay, shotCount, targetMinutes, clipLength, transition, finish, aspect, style, characterIds, writer, plan = true, ...rest }) => {
    const { providers, directors } = await client.call('GET', '/api/catalog');
    const first = (operation) => providers.filter((p) => p.ready).flatMap((p) => p.models.filter((m) => m.operations.includes(operation)).map((m) => [p.id, m.id]))[0] ?? [];
    const readyWriter = directors.find((d) => d.ready);
    const [defaultImageProvider, defaultImageModel] = first('generate');
    const imageProvider = rest.imageProvider ?? defaultImageProvider;
    const imageModel = rest.imageModel ?? defaultImageModel;
    const [defaultVideoProvider, defaultVideoModel] = first('video');
    const videoProvider = rest.videoProvider ?? defaultVideoProvider;
    const videoModel = rest.videoModel ?? defaultVideoModel;
    const created = await client.call('POST', `/api/projects/${projectId}/storyboards`, {
      title, idea, screenplay, writer: writer ?? (readyWriter ? `${readyWriter.id}:${readyWriter.models[0]}` : null),
      settings: { shotCount, targetSeconds: targetMinutes ? Math.round(targetMinutes * 60) : undefined, clipLength, transition, finish, aspect, style, characterIds, imageProvider, imageModel, videoProvider, videoModel, ...rest },
    });
    return ok(text(storyboardSummary(plan ? await client.call('POST', `/api/storyboards/${created.sequence.id}/plan`, {}) : created)));
  }));

  tool('update_storyboard', {
    title: 'Change storyboard settings',
    description: 'Change a storyboard\'s title, idea or settings after it was created, for example turn lip sync on (lipSync: true), switch the look, the delivery size, the finish, the cast or the image/video models. Only the fields given change. Shots already made are kept; new settings apply to frames, clips and joins made afterwards.',
    inputSchema: {
      storyboardId: z.string(), title: z.string().min(1).max(80).optional(), idea: z.string().min(1).max(6000).optional(),
      settings: z.object({
        lipSync: z.boolean().optional(), look: z.enum(['live-action', 'anime', 'as-written']).optional(), lookBible: z.string().max(1500).optional(),
        themes: z.array(z.string().max(300)).max(8).optional(), seed: z.number().int().min(0).optional(),
        outputHeight: z.union([z.literal(720), z.literal(1080), z.literal(1440), z.literal(2160)]).optional(),
        upscale: z.enum(['none', 'fast', 'anime', 'ai']).optional(), colorMatch: z.enum(['scene', 'film', 'off']).optional(),
        narratorVoice: z.object({ provider: z.string(), model: z.string(), voice: z.string().optional() }).optional(),
        interpolateFps: z.union([z.literal(0), z.literal(30)]).optional(), requireApproval: z.boolean().optional(),
        transition: z.enum(['cut', 'crossfade']).optional(), finish: z.enum(['none', 'cinematic', 'anime']).optional(),
        aspect: z.enum(['16:9', '9:16', '1:1']).optional(), style: z.string().optional(), characterIds: charactersArg,
        imageProvider: z.string().optional(), imageModel: z.string().optional(), videoProvider: z.string().optional(), videoModel: z.string().optional(),
      }).optional(),
    },
  }, safe(async ({ storyboardId, title, idea, settings }) => ok(text(storyboardSummary(await client.call('PATCH', `/api/storyboards/${storyboardId}`, { title, idea, settings }))))));

  tool('import_shot_plan', {
    title: 'Import a shot plan written in this chat',
    description: 'Save a complete shot plan you wrote yourself, without a paid writer-model call: create_storyboard with plan=false, then import here. replace=true discards the existing shots, so ask the user first. Models can be assigned per shot using details.model as provider|model, e.g. local|wan2.2-ti2v-5b. Never replace a plan without user approval.',
    inputSchema: { storyboardId: z.string(), replace: z.boolean().optional(), shots: z.array(z.object({ description: z.string().min(1).max(2000), duration: z.number().int().min(1).max(30), camera: z.string().optional(), details: z.record(z.string(), z.unknown()).optional() })).min(1).max(60) },
  }, safe(async ({ storyboardId, ...plan }) => ok(text(storyboardSummary(await client.call('POST', `/api/storyboards/${storyboardId}/import-plan`, plan))))));

  tool('production_readiness', {
    title: 'Check anime production readiness',
    description: 'Check required frames/clips/voices, installed local models and NVIDIA runtime, ffmpeg, requested RIFE/Real-ESRGAN tools, and budget before production. Never spend until ready=true and the user approves the estimate. Lip sync is excluded.',
    inputSchema: { storyboardId: z.string() },
  }, safe(async ({ storyboardId }) => ok(text(await client.call('GET', `/api/storyboards/${storyboardId}/readiness`)))));

  tool('get_storyboard', {
    title: 'Get storyboard',
    description: 'Read a storyboard: its settings and every shot with frame and clip status.',
    inputSchema: { storyboardId: z.string() },
  }, safe(async ({ storyboardId }) => ok(text(storyboardSummary(await client.call('GET', `/api/storyboards/${storyboardId}`))))));

  tool('update_shot', {
    title: 'Edit a storyboard shot',
    description: 'Change a shot: description, camera move (a camera preset id from list_presets, or "" for none), length, and its continuity details (scene, cast and location ids, action, dialogue, start and end state, what must not change, video or free still shot, per-shot video model, anime timing: details.timing auto|ones|twos|threes and details.holds [{start, seconds}], see set_shot_timing; lock). Locked shots refuse story changes unless locked: false is sent.',
    inputSchema: {
      shotId: z.string(), description: z.string().max(2000).optional(), camera: z.string().optional(), duration: z.number().int().min(1).max(30).optional(),
      details: z.object({
        scene: z.string().max(80).optional(), locationId: z.string().nullable().optional(), characterIds: z.array(z.string()).max(6).optional(),
        action: z.string().max(1000).optional(), startState: z.string().max(500).optional(), endState: z.string().max(500).optional(), forbidden: z.string().max(500).optional(),
        dialogue: z.array(z.object({ speaker: z.string().describe('A character id or "narrator"'), text: z.string().max(1000), style: z.string().max(500).optional(), start: z.number().min(0).nullable().optional() })).max(12).optional(),
        method: z.enum(['video', 'still']).optional(), motion: z.string().optional().describe('Still-shot move: push-in, pull-out, pan-left, pan-right, rise, hold'),
        model: z.string().optional().describe('Per-shot video model as "provider|model" ("" = storyboard default)'),
        interpolate: z.boolean().optional(),
        timing: z.enum(['auto', 'ones', 'twos', 'threes']).optional().describe('Anime exposure applied when the film is joined: "twos"/"threes" hold each drawing 2/3 frames (the classic anime rhythm, no smoothing), "ones" a new drawing every frame, "auto" leaves the clip as it is (anime storyboards are not auto-smoothed). Not applied to still shots\' camera moves.'),
        holds: z.array(z.object({ start: z.number().min(0).max(600), seconds: z.number().min(0.04).max(10) })).max(8).optional().describe('Freeze the picture for `seconds` starting `start` seconds into the shot (after the trim); non-overlapping, up to 8. [] clears them.'),
        trimStart: z.number().min(0).max(10).optional(), muteClipSound: z.boolean().optional(), locked: z.boolean().optional(),
      }).optional(),
    },
  }, safe(async ({ shotId, ...changes }) => ok(text(storyboardSummary(await client.call('PATCH', `/api/shots/${shotId}`, changes))))));

  tool('review_shot', {
    title: 'Review a shot',
    description: 'Record a decision on a shot. status "accepted" uses its clip in the film; needs_repair / needs_regeneration / rejected keep it out; approveFrame: true approves its still before any video is paid for (with requireApproval). Look at the frame and clip first (and at problems from the free checks).',
    inputSchema: {
      shotId: z.string(), status: z.enum(['accepted', 'needs_review', 'needs_repair', 'needs_regeneration', 'rejected']).optional(), notes: z.string().max(1000).optional(),
      approveFrame: z.boolean().optional(),
    },
  }, safe(async ({ shotId, status, notes, approveFrame }) => {
    let result;
    if (approveFrame !== undefined) result = await client.call('POST', `/api/shots/${shotId}/approve-frame`, { approved: approveFrame });
    if (status) result = await client.call('POST', `/api/shots/${shotId}/review`, { status, notes });
    if (!result) throw new Error('Give a status or approveFrame.');
    return ok(text(storyboardSummary(result)));
  }));

  tool('render_still_shot', {
    title: 'Render a still shot (free)',
    description: 'Render a still shot locally: the shot\'s frame with a slow camera move, at the film\'s size. Costs nothing. The shot\'s method should be "still".',
    inputSchema: { shotId: z.string() },
  }, safe(async ({ shotId }) => ok(text(storyboardSummary(await client.call('POST', `/api/shots/${shotId}/still`, {}))))));

  tool('voice_dialogue', {
    title: 'Record a shot\'s dialogue',
    description: 'Queue speech for every unrecorded dialogue line of a shot, in each character\'s saved voice (or the storyboard\'s narrator voice). Costs a little per line on the voice provider. Reports characters with no voice set.',
    inputSchema: { shotId: z.string() },
  }, safe(async ({ shotId }) => {
    const result = await client.call('POST', `/api/shots/${shotId}/dialogue`, {});
    const hint = result.missingVoices.length ? 'Give each a voice first: set_character_voice for characters, update_storyboard narratorVoice for the narrator (list_voices; the local Kokoro voices are free, e.g. {"provider":"local","model":"kokoro-82m","voice":"af_heart"}). Then call voice_dialogue again.' : undefined;
    return ok(text({ queued: result.queued.length, missingVoices: result.missingVoices, next: hint }));
  }));

  tool('estimate_film_cost', {
    title: 'Estimate what a film will cost',
    description: 'Price everything a storyboard still needs (frames, clips, dialogue) from the providers\' published prices, and whether it fits the budget. Free to call. Show this to the user before produce_film.',
    inputSchema: { storyboardId: z.string() },
  }, safe(async ({ storyboardId }) => {
    const result = await client.call('GET', `/api/storyboards/${storyboardId}/estimate`);
    const byKind = {};
    for (const line of result.lines) byKind[line.operation] = Math.round(((byKind[line.operation] ?? 0) + (line.usd ?? 0)) * 100) / 100;
    return ok(text({ totalUsd: result.totalUsd, byOperation: byKind, jobs: result.lines.length, unpriced: result.unpriced, remainingUsd: result.remainingUsd, fits: result.fits,
      videoSeconds: result.videoSeconds, freeStillSeconds: result.stillSeconds }));
  }));

  tool('openrouter_credit_status', {
    title: 'Check OpenRouter remaining key allowance',
    description: 'Read the current OpenRouter API key spending limit, remaining allowance and usage, with a timestamp. Does not spend credits or change limits. Account-wide credits require a management key and are reported unavailable here. Null is unknown, not free or unlimited. Check before paid work and compare with budget_status and reservations.',
    annotations: { readOnlyHint: true },
    inputSchema: { refresh: z.boolean().optional().describe('Fetch a fresh snapshot instead of a cache up to 30 seconds old') },
  }, safe(async ({ refresh = false }) => ok(text(await client.call('GET', `/api/providers/openrouter/credits?refresh=${refresh}`)))));

  tool('budget_status', {
    title: 'Budget status',
    description: 'Spending limits, what has been spent or reserved, and approvals waiting for a decision. Limits can only be changed in the app.',
    inputSchema: {},
  }, safe(async () => ok(text(await client.call('GET', '/api/budget')))));

  tool('decide_approval', {
    title: 'Approve or deny a spend',
    description: 'Approve or deny a pending spending approval. Only works when the user allowed MCP approvals in the app; otherwise ask the user to approve it in Lumina. After approving, repeat the exact same call with the same arguments: the approval is matched automatically (no tool takes an approvalId). Never approve on the user\'s behalf unless they said so.',
    inputSchema: { approvalId: z.string(), approve: z.boolean() },
  }, safe(async ({ approvalId, approve }) => ok(text(await client.call('POST', `/api/budget/approvals/${approvalId}`, { approve })))));

  tool('refresh_models', {
    title: 'Refresh the model list',
    description: 'Re-read OpenRouter\'s public model list and prices (free; no key used).',
    inputSchema: {},
  }, safe(async () => {
    const { catalog, ...status } = await client.call('POST', '/api/models/refresh', {});
    return ok(text(status));
  }));

  tool('generate_shot', {
    title: 'Generate a shot frame or clip',
    description: 'Make the still frame ("frame") or the video clip ("clip") for one storyboard shot. A clip starts from the shot\'s frame when the video model accepts a start image. Clips are slow and cost more than images; paid requests go through budget approvals (402 -> budget_status / decide_approval). Do not retry a paid shot in a loop: preview_shot it first. Pass idempotencyKey to make a repeat safe.',
    inputSchema: {
      shotId: z.string(), kind: z.enum(['frame', 'clip']), provider: z.string().optional(), model: z.string().optional(),
      resolution: z.string().optional().describe('Clip resolution such as 480p or 720p (default: 720p where offered); higher costs more'),
      idempotencyKey: z.string().min(8).max(128).optional().describe('Repeat a request safely: the same key returns the same job instead of paying twice'),
    },
  }, safe(async ({ shotId, kind, provider, model, resolution, idempotencyKey }) => {
    const { generation } = await client.call('POST', `/api/shots/${shotId}/${kind === 'frame' ? 'frame' : 'animate'}`, { provider, model, resolution, idempotencyKey });
    return waitAndShow(generation, { shotId });
  }));

  tool('generate_storyboard_shots', {
    title: 'Generate all storyboard frames or clips',
    description: 'Queue the still frame ("frames") or video clip ("clips") for every shot that does not have one yet (or every shot with redo: true). Returns at once; the jobs run in the background two at a time. Check progress with watch_jobs or get_storyboard. Clips for a long film cost real money (e.g. 300 seconds of video) — confirm the price with the user first.',
    inputSchema: { storyboardId: z.string(), kind: z.enum(['frames', 'clips']), redo: z.boolean().optional() },
  }, safe(async ({ storyboardId, kind, redo = false }) => {
    const detail = await client.call('GET', `/api/storyboards/${storyboardId}`);
    const busy = (job) => job && ['queued', 'running'].includes(job.status);
    const todo = detail.shots.filter((s) => s.description.trim() && (kind === 'frames'
      ? (redo || !s.imageAssetId) && !busy(s.frameJob)
      : (redo || !s.videoAssetId) && !busy(s.clipJob)));
    const queued = [];
    for (const shot of todo) queued.push((await client.call('POST', `/api/shots/${shot.id}/${kind === 'frames' ? 'frame' : 'animate'}`, {})).generation.id);
    return ok(text({ queued: queued.length, generationIds: queued, next: 'Call get_storyboard to follow progress; join_storyboard once the clips are done.' }));
  }));

  tool('produce_film', {
    title: 'Produce the whole film',
    description: 'Make every missing frame and clip of a storyboard and join them into the finished film, in the background. With continuity "chain" (set via create_storyboard or the app) each clip starts from the last frame of the one before for unbroken action. Still shots are rendered free. With requireApproval, production stops at "review" twice: once for the frames (approve each with review_shot approveFrame), once for the clips (accept each) — then call produce_film again. Costs real money for every clip — call estimate_film_cost and confirm the price with the user first. Follow progress with get_storyboard (production).',
    inputSchema: { storyboardId: z.string() },
  }, safe(async ({ storyboardId }) => {
    const result = await client.call('POST', `/api/storyboards/${storyboardId}/produce`, {});
    return ok(text({ ...storyboardSummary(result), production: result.sequence.production }));
  }));

  tool('enhance_video', {
    title: 'Enhance (upscale) a video',
    description: 'Make a 2x larger, sharper copy of a video (up to 4K) on the computer running Lumina: mode "fast" uses GPU scaling (seconds to minutes); mode "ai" uses Real-ESRGAN on the GPU (much slower, adds detail; must be installed from the app first); mode "anime" uses Real-ESRGAN\'s anime-video model (trained for animation; review for altered details). height picks an exact target (1080, 1440 or 2160). Runs in the background; returns the job status. Call again with the same assetId to check.',
    inputSchema: { assetId: z.string(), mode: z.enum(['fast', 'ai', 'anime']).optional(), height: z.union([z.literal(1080), z.literal(1440), z.literal(2160)]).optional(), checkOnly: z.boolean().optional() },
  }, safe(async ({ assetId, mode = 'fast', height, checkOnly = false }) => {
    if (checkOnly) return ok(text(await client.call('GET', `/api/assets/${assetId}/enhance`)));
    return ok(text(await client.call('POST', `/api/assets/${assetId}/enhance`, { mode, height })));
  }));

  tool('bake_character', {
    title: 'Bake a character (LoRA)',
    description: 'Train a small LoRA of one character for the local anime image model, from its character sheet and design tags, on the computer running Lumina (free, about 15-25 minutes of GPU time in all; other GPU work waits). Afterwards every local anime frame with that character uses it, so the face, hair and outfit stay on-model. Make a character sheet first (make_character_sheet). Baking has a REVIEW step so bad pictures are not learned: (1) action "start" draws about 16 training pictures and stops (job.state "drawing", then "review"); (2) action "status" (the default) returns the pictures with index, framing, url (open it with fetch to look at it) and local file path; (3) action "review" with approved:[indexes], rejected:[indexes] and optionally mirror:{index:boolean} or mirrorOk (default true: each picture is also trained flipped; set false for asymmetric costumes, scars, one-sided hair); (4) action "redraw" draws the rejected pictures (or the given indexes) again with new seeds, then review again; (5) action "train" trains on the approved pictures only (at least 8 must be approved; job.state "training", then "completed"). Look at the pictures yourself and reject ones with wrong hair or eye colour, extra limbs, merged characters or a different outfit. action "start" with auto:true skips the review (draws and trains on everything; not recommended). Action "remove" deletes the trained LoRA and any pictures: ask the user first.',
    inputSchema: {
      characterId: z.string(), action: z.enum(['start', 'status', 'review', 'redraw', 'train', 'remove']).default('status'),
      auto: z.boolean().optional().describe('start only: draw and train in one go without the review step'),
      approved: z.array(z.number().int().min(0)).optional(), rejected: z.array(z.number().int().min(0)).optional(),
      mirror: z.record(z.string(), z.boolean()).optional().describe('review: per-picture mirror flag, e.g. {"3": false}'),
      mirrorOk: z.boolean().optional().describe('start/review: false for asymmetric designs (no flipped copies at all)'),
      indexes: z.array(z.number().int().min(0)).optional().describe('redraw: pictures to draw again (default: every rejected one)'),
    },
  }, safe(async ({ characterId, action, auto, approved, rejected, mirror, mirrorOk, indexes }) => {
    const base = `/api/characters/${characterId}/bake`;
    if (action === 'start') return ok(text(await client.call('POST', base, { auto, mirrorOk })));
    if (action === 'review') return ok(text(await client.call('POST', `${base}/review`, { approved, rejected, mirror, mirrorOk })));
    if (action === 'redraw') return ok(text(await client.call('POST', `${base}/redraw`, { indexes })));
    if (action === 'train') return ok(text(await client.call('POST', `${base}/train`, {})));
    return ok(text(await client.call(action === 'remove' ? 'DELETE' : 'GET', base)));
  }));

  tool('lip_sync_shot', {
    title: 'Lip sync a shot',
    description: 'Make a storyboard shot\'s mouth move with its recorded dialogue, on the computer running Lumina (free). Lip sync is OFF by default: the storyboard\'s lipSync setting must be on, otherwise this is refused (409). Anime look (storyboard Look: anime): five mouth shapes (closed, small, open a, wide i/e, round u/o) are drawn in the shot\'s own style and switched in time with the words like theatrical anime: shapes follow the vowels, close on m/b/p and at pauses, held two frames or more, and follow the face as it moves. Live-action lip sync is not available (501). Record the dialogue first (voice_dialogue). The mouth is found automatically; if that fails, pass mouthBox as fractions of the frame [x1, y1, x2, y2].',
    inputSchema: { shotId: z.string(), mouthBox: z.array(z.number().min(0).max(1)).length(4).optional() },
  }, safe(async ({ shotId, mouthBox }) => ok(text(storyboardSummary(await client.call('POST', `/api/shots/${shotId}/lipsync`, { box: mouthBox }))))));

  tool('inspect_video', {
    title: 'View video samples for review',
    description: 'Read video dimensions, duration, fps and audio presence, and view up to six timestamped thumbnail frames. Free local decoding; no generation, billing or edits. Use on a clip before accepting it or buying another take. Samples cannot prove motion accuracy or rule out drift between sampled frames.',
    annotations: { readOnlyHint: true },
    inputSchema: { assetId: z.string(), times: z.array(z.number().min(0)).min(1).max(6).optional() },
  }, safe(async ({ assetId, times }) => {
    const result = await client.call('GET', `/api/assets/${assetId}/inspect${times ? `?times=${times.join(',')}` : ''}`);
    return ok(text({ assetId, ...result.metadata, sampleTimes: result.frames.map((frame) => frame.requestedTimeSeconds), note: result.note }),
      ...result.frames.map((frame) => ({ type: 'image', mimeType: frame.mimeType, data: frame.data })));
  }));

  tool('interpolate_video', {
    title: 'Interpolate a video (smoother motion)',
    description: 'Make the in-between frames of a video with RIFE v4.6 on the GPU of the computer running Lumina, so it plays at `fps` within one target frame of the original duration (e.g. 12 → 24 fps rebuilds every other frame; 24 → 60 for smooth motion). Saves a new video in the library and returns its asset id (and file path on a local connection). Clips containing a cut are refused. RIFE must be installed from the app first (Storyboard → Picture quality → Smooth).',
    inputSchema: { assetId: z.string(), fps: z.number().int().min(2).max(120) },
  }, safe(async ({ assetId, fps }) => {
    const result = await client.call('POST', `/api/assets/${assetId}/interpolate`, { fps });
    return ok(text({ assetId: result.asset.id, fps: result.fps, seconds: result.duration, size: `${result.width}x${result.height}`, file: client.localFile ? client.localFile(result.asset.path) : undefined }));
  }));

  if (client.upload) {
    tool('import_video', {
      title: 'Import a video file',
      description: 'Add an MP4 file from this computer to a project\'s library (up to 300 MB), so other tools (interpolate_video, enhance_video) can work on it. Local connections only.',
      inputSchema: { projectId: z.string(), filePath: z.string().describe('Absolute path of an .mp4 file'), label: z.string().max(120).optional() },
    }, safe(async ({ projectId, filePath, label }) => {
      const { readFile } = await import('node:fs/promises');
      const bytes = await readFile(path.resolve(filePath));
      const result = await client.upload(`/api/projects/${projectId}/video`, bytes, label ?? path.basename(filePath));
      return ok(text({ assetId: result.asset.id, label: result.asset.label, file: client.localFile ? client.localFile(result.asset.path) : undefined }));
    }));
  }

  tool('find_music', {
    title: 'Find background music',
    description: 'Search free music on the internet (Openverse: Jamendo, Freesound, Wikimedia and more) by mood, genre or instruments, e.g. "calm emotional piano", "epic orchestral battle", "lofi chill", "j-pop upbeat". Only tracks you may use in a film are returned: CC0 / public domain (no conditions) and CC BY (credit the artist; the credit line is kept). Pass a trackId to set_background_music to download and use it.',
    inputSchema: { query: z.string().min(1).max(200), minSeconds: z.number().int().min(0).max(1800).optional().describe('Skip tracks shorter than this (default 30)'), limit: z.number().int().min(1).max(20).optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, safe(async ({ query, minSeconds, limit }) => {
    const params = new URLSearchParams({ q: query, ...(minSeconds !== undefined ? { minSeconds: String(minSeconds) } : {}), ...(limit ? { limit: String(limit) } : {}) });
    const { tracks } = await client.call('GET', `/api/music/search?${params}`);
    return ok(text({ tracks: tracks.map(({ id, title, creator, seconds, license, needsCredit, source, page }) => ({ trackId: id, title, creator, seconds, license, needsCredit, source, page })), note: tracks.length ? undefined : 'Nothing found: try broader words (e.g. "piano", "orchestral", "ambient").' }));
  }));

  tool('set_background_music', {
    title: 'Set background music',
    description: 'Put a music bed (and optionally an ambience bed such as rain or city noise) under a storyboard\'s film. The track loops to the film\'s length and is ducked automatically whenever someone speaks; dialogue stays loudness-matched. The music can come from the internet: search (a mood, e.g. "gentle piano") downloads the best free track automatically, or trackId downloads one picked with find_music (CC0 / CC BY only; the artist credit is returned, put it in the video description). Or give an audio assetId from the library, or on a local connection filePath to an MP3/WAV/OGG/FLAC file. volume 0-2 (default 0.3 for music, 0.25 for ambience). remove=true takes that bed off. clipVolume sets the clips\' own sound (default 1). Then join_storyboard to hear it.',
    inputSchema: {
      storyboardId: z.string(), role: z.enum(['music', 'ambience']).optional().describe('Default music'),
      search: z.string().max(200).optional().describe('Find and download a free track for this mood, e.g. "calm emotional piano"'),
      trackId: z.string().optional().describe('A trackId from find_music'),
      assetId: z.string().optional(), filePath: z.string().optional().describe('Absolute path of an audio file (local connections only)'),
      volume: z.number().min(0).max(2).optional(), clipVolume: z.number().min(0).max(2).optional(), remove: z.boolean().optional(),
    },
  }, safe(async ({ storyboardId, role = 'music', search, trackId, assetId, filePath, volume, clipVolume, remove = false }) => {
    const detail = await client.call('GET', `/api/storyboards/${storyboardId}`);
    const settings = {};
    if (clipVolume !== undefined) settings.clipVolume = clipVolume;
    let label;
    let skipped = [];
    if (remove) settings[role] = null;
    else if (search || trackId || assetId || filePath) {
      if (search && !trackId && !assetId && !filePath) {
        const filmSeconds = detail.shots.reduce((sum, shot) => sum + (shot.duration ?? 0), 0);
        const { tracks } = await client.call('GET', `/api/music/search?${new URLSearchParams({ q: search, minSeconds: String(Math.min(60, Math.max(20, Math.round(filmSeconds)))), limit: '5' })}`);
        if (!tracks.length) throw new Error(`No free music found for "${search}". Try broader words (e.g. "piano", "orchestral", "ambient"), or find_music.`);
        // The first track that downloads cleanly wins; broken links are skipped.
        for (const candidate of tracks) {
          try { ({ asset: { id: assetId, label } } = await client.call('POST', `/api/projects/${detail.sequence.projectId}/music`, { trackId: candidate.id })); break; } catch (error) { skipped.push(`${candidate.title}: ${error.message}`); }
        }
        if (!assetId) throw new Error(`Could not download any of the tracks found: ${skipped.join('; ')}`);
      } else if (trackId) {
        ({ asset: { id: assetId, label } } = await client.call('POST', `/api/projects/${detail.sequence.projectId}/music`, { trackId }));
      }
      if (filePath) {
        if (!client.upload) throw new Error('filePath works on a local connection only. Add the file to the project in the Lumina app, then pass its assetId.');
        const { readFile } = await import('node:fs/promises');
        const uploaded = await client.upload(`/api/projects/${detail.sequence.projectId}/audio`, await readFile(path.resolve(filePath)), path.basename(filePath));
        assetId = uploaded.asset.id; label = uploaded.asset.label;
      }
      settings[role] = { assetId, volume: volume ?? (role === 'music' ? 0.3 : 0.25) };
    } else if (volume !== undefined) {
      const current = detail.sequence.settings[role];
      if (!current) throw new Error(`This storyboard has no ${role} yet: pass assetId or filePath.`);
      settings[role] = { ...current, volume };
    } else if (clipVolume === undefined) throw new Error('Pass assetId or filePath (or volume, clipVolume, remove).');
    const updated = await client.call('PATCH', `/api/storyboards/${storyboardId}`, { settings });
    const { music, ambience, clipVolume: clips } = updated.sequence.settings;
    const creditOf = async (bed) => (bed?.assetId ? (await client.call('GET', `/api/assets/${bed.assetId}/credit`).catch(() => ({ credit: null }))).credit : null);
    const credits = (await Promise.all([creditOf(music), creditOf(ambience)])).filter(Boolean).map(({ title, creator, license, needsCredit, credit, page }) => ({ title, creator, license, needsCredit, credit, page }));
    return ok(text({ storyboardId, music, ambience, clipVolume: clips, imported: label, credits: credits.length ? credits : undefined, skipped: skipped.length ? skipped : undefined,
      creditNote: credits.some((c) => c.needsCredit) ? 'CC BY music: put the credit line in the video description or end credits when you publish.' : undefined, next: updated.sequence.outputAssetId ? 'join_storyboard again to remix the film with it (the picture is reused).' : 'join_storyboard to make the film with it.' }));
  }));

  tool('join_storyboard', {
    title: 'Join storyboard clips',
    description: 'Join the storyboard\'s clips, in shot order, into one MP4 saved in the project library. Needs ffmpeg on the computer running Lumina. Shots without a clip are skipped. Long films take a few minutes; if it is still running when this returns, call get_storyboard later.',
    inputSchema: { storyboardId: z.string() },
  }, safe(async ({ storyboardId }) => {
    let result = await client.call('POST', `/api/storyboards/${storyboardId}/stitch`, {});
    const deadline = Date.now() + 8 * 60_000;
    while (result.sequence.join?.state === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      result = await client.call('GET', `/api/storyboards/${storyboardId}`);
    }
    const join = result.sequence.join;
    if (join?.state === 'failed') throw new Error(join.error);
    const file = client.localFile && join?.state === 'completed' && result.sequence.outputPath ? client.localFile(result.sequence.outputPath) : undefined;
    return ok(text({ ...storyboardSummary(result), joined: join?.clips, skipped: join?.skipped, progress: join ? `${join.done}/${join.total}` : undefined, state: join?.state,
      seconds: join?.duration ? Math.round(join.duration * 10) / 10 : undefined, filmAssetId: join?.state === 'completed' ? result.sequence.outputAssetId ?? undefined : undefined, file }));
  }));

  tool('export_book', {
    title: 'Export book',
    description: 'Export a book as a print-layout PDF, EPUB e-book, Word document (docx), Markdown text, or audiobook (joined narration). Saves the file on the computer running Lumina and returns its path.',
    inputSchema: { bookId: z.string(), format: z.enum(['pdf', 'epub', 'docx', 'md', 'audio']).optional(), fixedLayout: z.boolean().optional().describe('EPUB only, picture books only: fixed-layout pages (art and text placed like the print book) instead of reflowable text'), outputPath: z.string().optional().describe('Absolute file path (local connections only); defaults to the Lumina exports folder') },
  }, safe(async ({ bookId, format = 'pdf', fixedLayout, outputPath }) => {
    const response = await client.fetchRaw(`/api/books/${bookId}/export.${format}${format === 'epub' && fixedLayout ? '?layout=fixed' : ''}`);
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Export failed (HTTP ${response.status})`);
    const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? `book.${format}`);
    const target = outputPath && client.allowOutputPath ? path.resolve(outputPath) : path.join(client.exportDir(), name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(await response.arrayBuffer()));
    const notes = [
      Number(response.headers.get('x-lumina-skipped-webp') ?? 0) ? 'WebP illustrations could not be embedded in the PDF.' : '',
      response.headers.get('x-lumina-missing-scripts') ? `No installed font covers: ${response.headers.get('x-lumina-missing-scripts')}.` : '',
      Number(response.headers.get('x-lumina-missing-narration') ?? 0) ? `${response.headers.get('x-lumina-missing-narration')} item(s) without narration were skipped.` : '',
    ].filter(Boolean);
    return ok(text({ savedOnUsersComputer: target, format, notes: notes.length ? notes : undefined }));
  }));

  // ---------- Interactive tools: previews, step-by-step wizard, progress, edit-by-chat ----------
  const maxInlineAudioBytes = 2 * 1024 * 1024;
  const audioTypes = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac' };

  // The whole storyboard a shot belongs to (read-only).
  const storyboardOfShot = async (shotId) => client.call('GET', `/api/storyboards/${(await client.call('GET', `/api/shots/${shotId}`)).sequenceId}`);
  const shotIn = (detail, shotId) => detail.shots.find((s) => s.id === shotId);

  async function mediaFrom(route, kind, label) {
    const response = await client.fetchRaw(route);
    if (!response.ok) return { note: `${label}: not available (HTTP ${response.status}).` };
    const bytes = Buffer.from(await response.arrayBuffer());
    const limit = kind === 'audio' ? maxInlineAudioBytes : maxInlineImageBytes;
    if (bytes.length > limit) return { note: `${label}: skipped, ${(bytes.length / 1048576).toFixed(1)} MB is too large to show inline.` };
    const header = response.headers.get('content-type')?.split(';')[0];
    const mimeType = header && header !== 'application/octet-stream' ? header : (kind === 'audio' ? audioTypes[route.split('?')[0].split('.').pop().toLowerCase()] ?? 'audio/wav' : 'image/png');
    return { content: { type: kind, mimeType, data: bytes.toString('base64') } };
  }
  async function mediaParts(items) {
    const parts = [];
    for (const [route, kind, label] of items) {
      const { content, note } = await mediaFrom(route, kind, label).catch((error) => ({ note: `${label}: ${error.message}` }));
      parts.push(content ?? text(note));
    }
    return parts;
  }

  const shotLine = (s) => {
    const spoken = s.details?.dialogue ?? [];
    const failed = (s.review?.checks ?? []).filter((c) => !c.ok).map((c) => c.detail);
    return {
      shot: s.position, id: s.id, description: s.description, method: s.details?.method ?? 'video', seconds: s.duration,
      frame: s.imageAssetId ? 'yes' : (s.frameJob ? s.frameJob.status : 'no'), clip: s.videoAssetId ? 'yes' : (s.clipJob ? s.clipJob.status : 'no'),
      review: s.review?.status ?? 'pending', frameApproved: s.imageAssetId ? s.review?.frameApproved === s.imageAssetId : false,
      failedChecks: failed.length ? failed : undefined,
      dialogue: spoken.length ? spoken.map((l) => ({ speaker: l.speaker, text: l.text, recorded: Boolean(l.assetId), seconds: l.seconds ?? undefined })) : undefined,
      themes: s.details?.themes?.length ? s.details.themes : undefined,
    };
  };

  tool('preview_shot', {
    title: 'Preview a shot (images and audio)',
    description: 'See one shot the way a person would: a text summary (description, method, length, review status, failed checks, dialogue lines with recorded yes/no, themes), its frame image, a contact sheet of six timestamped frames sampled across its clip, and each recorded dialogue line as audio. Free and read-only. Use it before asking the user to accept, redo or trim a shot. Files over the inline size limits are skipped with a note.',
    annotations: { readOnlyHint: true },
    inputSchema: { shotId: z.string() },
  }, safe(async ({ shotId }) => {
    const detail = await storyboardOfShot(shotId);
    const shot = shotIn(detail, shotId);
    if (!shot) throw new Error('Shot not found.');
    const items = [];
    if (shot.imagePath) items.push([shot.imagePath, 'image', 'Frame']);
    if (shot.videoPath) items.push([`/api/shots/${shotId}/contact-sheet`, 'image', 'Clip contact sheet']);
    for (const [i, line] of (shot.details?.dialogue ?? []).entries()) if (line.audioPath) items.push([line.audioPath, 'audio', `Dialogue line ${i + 1}`]);
    return ok(text(shotLine(shot)), ...(await mediaParts(items)));
  }));

  tool('preview_storyboard', {
    title: 'Preview every shot at once',
    description: 'Status of every shot (frame, clip, review, dialogue recorded) plus one contact sheet image with all shots numbered: kind "frames" (default) shows each shot\'s still, "clips" shows the middle frame of each clip. Free and read-only. Use it to show the user the whole film at a glance.',
    annotations: { readOnlyHint: true },
    inputSchema: { storyboardId: z.string(), kind: z.enum(['frames', 'clips']).optional() },
  }, safe(async ({ storyboardId, kind = 'frames' }) => {
    const detail = await client.call('GET', `/api/storyboards/${storyboardId}`);
    return ok(text({ title: detail.sequence.title, kind, shots: detail.shots.map(shotLine) }),
      ...(await mediaParts([[`/api/storyboards/${storyboardId}/contact-sheet?kind=${kind}`, 'image', `Contact sheet (${kind})`]])));
  }));

  tool('plan_storyboard', {
    title: 'Plan the shots with the writer model',
    description: 'Have the storyboard\'s writer model plan its shots (costs a little on the writer\'s provider; refused under a strict budget, where you should write the shot list yourself and use import_shot_plan). replace: true discards existing shots, so ask the user first.',
    inputSchema: { storyboardId: z.string(), replace: z.boolean().optional() },
  }, safe(async ({ storyboardId, replace }) => ok(text(storyboardSummary(await client.call('POST', `/api/storyboards/${storyboardId}/plan`, { replace }))))));

  tool('film_next_step', {
    title: 'Film wizard: what to do next',
    description: 'Step-by-step film making. Looks at the storyboard and proposes the ONE next stage (plan, frames, approve frames, animate, review, voices, fix, join, done) with a plain-language question for the user and `choices`, each an exact tool call (tool + arguments) you can make once the user agrees. Includes preview images of the shots involved. It never changes anything or spends money itself. Loop: call film_next_step, show the question and images to the user, make the chosen call, repeat.',
    annotations: { readOnlyHint: true },
    inputSchema: { storyboardId: z.string() },
  }, safe(async ({ storyboardId }) => {
    const detail = await client.call('GET', `/api/storyboards/${storyboardId}`);
    const estimate = await client.call('GET', `/api/storyboards/${storyboardId}/estimate`).catch(() => null);
    const step = nextStep(detail, estimate);
    const { preview, ...rest } = step;
    const items = [];
    if (preview?.sheet) items.push([`/api/storyboards/${storyboardId}/contact-sheet?kind=${preview.sheet}`, 'image', 'Contact sheet']);
    else for (const id of preview?.shotIds ?? []) {
      const path_ = shotIn(detail, id)?.imagePath;
      if (path_) items.push([path_, 'image', 'Frame']);
    }
    return ok(text(rest), ...(items.length ? await mediaParts(items) : []));
  }));

  const jobView = (j) => ({
    id: j.id, status: j.status, operation: j.operation, provider: j.provider, model: j.model, prompt: j.prompt?.slice(0, 120), target: j.bookTarget ?? undefined,
    percent: j.progress ? Math.round((j.progress.fraction ?? (j.progress.total ? j.progress.done / j.progress.total : 0)) * 100) : undefined,
    etaSeconds: j.progress?.etaSeconds ?? undefined,
  });
  const jobsKey = (jobs) => JSON.stringify(jobs.map((j) => [j.id, j.status, j.progress?.done ?? null]).sort());

  tool('watch_jobs', {
    title: 'Watch running jobs',
    description: 'List the queued and running generation jobs of a project with percent done and time left. With waitSeconds (up to 60) it waits, checking every 2 seconds, and returns as soon as a job starts, finishes or advances, or when the time is up. Free and read-only. Use it instead of repeatedly polling get_generation.',
    annotations: { readOnlyHint: true },
    inputSchema: { projectId: z.string(), waitSeconds: z.number().min(0).max(60).optional() },
  }, safe(async ({ projectId, waitSeconds = 0 }) => {
    const fetchJobs = async () => (await client.call('GET', `/api/projects/${projectId}/active-jobs`)).jobs;
    let jobs = await fetchJobs();
    const first = jobsKey(jobs);
    const deadline = Date.now() + waitSeconds * 1000;
    while (Date.now() + 2000 <= deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      jobs = await fetchJobs();
      if (jobsKey(jobs) !== first) break;
    }
    return ok(text({ active: jobs.length, jobs: jobs.map(jobView), note: jobs.length ? undefined : 'Nothing is running.' }));
  }));

  tool('cancel_job', {
    title: 'Cancel a job',
    description: 'Cancel a queued job (any provider) or a running local-model job. A paid job already submitted to a provider cannot be stopped: it is reported as not cancellable and will still be billed.',
    inputSchema: { generationId: z.string() },
  }, safe(async ({ generationId }) => {
    try {
      const { generation } = await client.call('POST', `/api/generations/${generationId}/cancel`, {});
      return ok(text({ cancelled: true, ...summarizeGeneration(generation) }));
    } catch (error) {
      if (error.status !== 409) throw error;
      return ok(text({ cancelled: false, reason: error.message, note: 'A paid job already sent to the provider cannot be cancelled and will still be billed.' }));
    }
  }));

  tool('film_checklist', {
    title: 'What is left to finish the film',
    description: 'A text checklist of what remains per shot (frame, clip, review, voices, dialogue overrun) plus the cost estimate for what is missing. Free and read-only. Use film_next_step for a guided single step instead.',
    annotations: { readOnlyHint: true },
    inputSchema: { storyboardId: z.string() },
  }, safe(async ({ storyboardId }) => {
    const detail = await client.call('GET', `/api/storyboards/${storyboardId}`);
    const estimate = await client.call('GET', `/api/storyboards/${storyboardId}/estimate`).catch(() => null);
    const facts = detail.shots.map(shotFacts);
    const requireApproval = Boolean(detail.sequence.settings?.requireApproval);
    const shots = facts.map((f) => ({
      shot: f.position, id: f.id,
      todo: [
        !f.hasFrame && 'make frame', f.hasFrame && requireApproval && !f.frameApproved && 'approve frame',
        !f.hasClip && (f.method === 'still' ? 'render still clip (free)' : 'animate clip'),
        f.hasClip && f.review !== 'accepted' && requireApproval && 'accept clip',
        f.linesRecorded < f.linesTotal && `record ${f.linesTotal - f.linesRecorded} dialogue line(s)`,
        f.overrun && 'dialogue runs past the shot: lengthen it or shorten the line',
      ].filter(Boolean),
    }));
    const left = shots.filter((s) => s.todo.length);
    return ok(text({
      title: detail.sequence.title, joined: Boolean(detail.sequence.outputAssetId), shotsFinished: shots.length - left.length, shotsTotal: shots.length,
      missingThemes: detail.sequence.themeCoverage?.missing?.length ? detail.sequence.themeCoverage.missing : undefined,
      remaining: left, readyToJoin: shots.length > 0 && !left.length && !detail.sequence.outputAssetId,
      estimate: estimate ? { totalUsd: estimate.totalUsd, remainingUsd: estimate.remainingUsd, fits: estimate.fits, unpriced: estimate.unpriced } : undefined,
    }));
  }));

  tool('adjust_shot_look', {
    title: 'Adjust a shot\'s colour (brightness, contrast, saturation, warmth)',
    description: 'Colour-grade one shot; it is applied when the film is joined (free). Values you give are merged into the shot\'s current grade. Examples: "darker" = brightness -0.1; "brighter" = brightness 0.1; "moodier" = saturation 0.8 and contrast 1.1; "warmer" = warmth 0.4; "cooler" = warmth -0.4; "washed out" = saturation 0.6. Neutral is brightness 0, contrast 1, saturation 1, warmth 0. reset: true clears the grade. Rejoin the film (join_storyboard) to see it.',
    inputSchema: {
      shotId: z.string(), brightness: z.number().min(-0.3).max(0.3).optional(), contrast: z.number().min(0.5).max(1.5).optional(),
      saturation: z.number().min(0).max(2).optional(), warmth: z.number().min(-1).max(1).optional(), reset: z.boolean().optional(),
    },
  }, safe(async ({ shotId, reset, ...values }) => {
    const given = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
    if (!reset && !Object.keys(given).length) throw new Error('Give at least one of brightness, contrast, saturation, warmth, or reset: true.');
    let grade = null;
    if (!reset) {
      const current = shotIn(await storyboardOfShot(shotId), shotId)?.details?.grade;
      grade = { brightness: 0, contrast: 1, saturation: 1, warmth: 0, ...(current ?? {}), ...given };
    }
    const detail = await client.call('PATCH', `/api/shots/${shotId}`, { details: { grade } });
    return ok(text({ shotId, grade: shotIn(detail, shotId)?.details?.grade ?? grade, note: 'Applied when the film is joined; run join_storyboard to see it.' }));
  }));

  tool('move_shot', {
    title: 'Move a shot to another position',
    description: 'Reorder the film: move a shot so it ends up at toPosition (1 = first). Other shots shift. Returns the new order. Rejoin the film afterwards.',
    inputSchema: { shotId: z.string(), toPosition: z.number().int().min(1) },
  }, safe(async ({ shotId, toPosition }) => {
    let detail = await storyboardOfShot(shotId);
    const index = () => detail.shots.findIndex((s) => s.id === shotId);
    const target = Math.min(toPosition, detail.shots.length) - 1;
    for (let guard = detail.shots.length * 2; index() !== target && guard > 0; guard--) {
      detail = await client.call('POST', `/api/shots/${shotId}/move`, { direction: index() > target ? 'up' : 'down' });
    }
    return ok(text({ movedTo: index() + 1, order: detail.shots.map((s, i) => ({ position: i + 1, id: s.id, description: s.description.slice(0, 60) })) }));
  }));

  // ---------- Takes, repairs, dialogue revision, editable export ----------
  tool('list_shot_takes', {
    title: 'List a shot\'s takes',
    description: 'List every frame and clip a shot has had (newest first), with assetId, path, createdAt and which one is current. Includes repaired frames, attached clips and lip-synced clips. Look at them (inspect_video / preview_shot) and pick one with select_shot_take.',
    inputSchema: { shotId: z.string() },
  }, safe(async ({ shotId }) => {
    const result = await client.call('GET', `/api/shots/${shotId}/takes`);
    const slim = (t) => ({ assetId: t.assetId, source: t.source, createdAt: t.createdAt, current: t.current || undefined, generationId: t.generationId ?? undefined, path: t.path });
    return ok(text({ shotId, position: result.position, frames: result.frames.map(slim), clips: result.clips.map(slim) }));
  }));

  tool('select_shot_take', {
    title: 'Switch a shot to another take',
    description: 'Make an earlier (or repaired, or attached) frame or clip the shot\'s current one. This is also how to undo a bad revision: pick the previous take. The shot\'s review goes back to pending and a chosen clip is re-checked (free technical checks). Choosing a frame does not remake the clip. Only assetIds from list_shot_takes are accepted.',
    inputSchema: { shotId: z.string(), kind: z.enum(['frame', 'clip']), assetId: z.string() },
  }, safe(async ({ shotId, kind, assetId }) => ok(text(storyboardSummary(await client.call('POST', `/api/shots/${shotId}/takes/select`, { kind, assetId }))))));

  tool('attach_clip_to_shot', {
    title: 'Attach an imported clip to a shot',
    description: 'Use a video already in the project library (for example from import_video, or made with generate_video) as the shot\'s clip. It becomes a clip take and is selected; the shot\'s review goes back to pending and the free checks run. The video must be in the same project as the storyboard.',
    inputSchema: { shotId: z.string(), assetId: z.string() },
  }, safe(async ({ shotId, assetId }) => ok(text(storyboardSummary(await client.call('POST', `/api/shots/${shotId}/attach-clip`, { assetId }))))));

  tool('repair_frame', {
    title: 'Repair part of a shot\'s frame',
    description: 'Repaint one area of the shot\'s current frame (a hand, a face, a prop) with an inpaint model, leaving the rest alone. box is [x1, y1, x2, y2] as fractions of the frame (0-1, origin top-left); instruction says what should appear there. Starts a job; the result becomes a NEW frame take that is not selected automatically: look at it, then choose it with select_shot_take (kind "frame") and re-animate the shot if the clip should follow. Refuses with a clear message when no inpaint-capable model is ready. Repairing a section of a CLIP is not supported (no replace_clip_section): repair the frame and generate a new clip instead.',
    inputSchema: {
      shotId: z.string(), box: z.array(z.number().min(0).max(1)).length(4), instruction: z.string().min(1).max(3000),
      provider: z.string().optional().describe('Optional: force an inpaint provider'), model: z.string().optional(),
    },
  }, safe(async ({ shotId, box, instruction, provider, model }) => {
    const { generation, alreadyRunning } = await client.call('POST', `/api/shots/${shotId}/repair-frame`, { box, instruction, provider, model });
    return ok(text({ generationId: generation.id, status: generation.status, provider: generation.provider, model: generation.model, alreadyRunning: alreadyRunning || undefined,
      note: 'Check with get_generation or watch_jobs; then list_shot_takes and select_shot_take to use the repaired frame.' }));
  }));

  tool('rerecord_line', {
    title: 'Re-record one dialogue line',
    description: 'Re-voice a single dialogue line of a shot (lineIndex counts from 0): its old recording is cleared and only that line is queued, optionally with a new acting direction in style (for example "whispering, tired"). The line\'s timing is kept (see set_line_timing). A lip-synced clip must be lip-synced again afterwards. Costs a little on the voice provider unless the voice is local.',
    inputSchema: { shotId: z.string(), lineIndex: z.number().int().min(0).max(11), style: z.string().max(500).optional() },
  }, safe(async ({ shotId, lineIndex, style }) => {
    const result = await client.call('POST', `/api/shots/${shotId}/dialogue/${lineIndex}/rerecord`, style === undefined ? {} : { style });
    return ok(text({ queued: result.queued.map((g) => g.id), note: 'Wait with watch_jobs, then preview_shot to hear it.' }));
  }));

  tool('set_line_timing', {
    title: 'Set when a dialogue line starts',
    description: 'Set when dialogue line lineIndex starts, in seconds from the start of the shot (start: null goes back to automatic placement: one line after another from 0.4 s). The recording is kept. This is the same as update_shot with details.dialogue[i].start. Works on locked shots and does not reset the review.',
    inputSchema: { shotId: z.string(), lineIndex: z.number().int().min(0).max(11), start: z.number().min(0).max(120).nullable() },
  }, safe(async ({ shotId, lineIndex, start }) => {
    const { shot } = await client.call('GET', `/api/shots/${shotId}`);
    const lines = shot?.details?.dialogue ?? [];
    if (!lines[lineIndex]) throw new Error(`This shot has no dialogue line ${lineIndex} (it has ${lines.length}; lines count from 0).`);
    const dialogue = lines.map((l, i) => ({ speaker: l.speaker, text: l.text, style: l.style, start: i === lineIndex ? start : l.start }));
    const detail = await client.call('PATCH', `/api/shots/${shotId}`, { details: { dialogue } });
    const updated = shotIn(detail, shotId);
    return ok(text({ shotId, dialogue: updated?.details?.dialogue?.map((l, i) => ({ lineIndex: i, text: l.text.slice(0, 60), start: l.start, recorded: Boolean(l.assetId) })) }));
  }));

  tool('export_production', {
    title: 'Export an editable production folder',
    description: 'Write a folder on the computer running Lumina for finishing in an editor: every shot\'s selected frame and clip (original files), all dialogue recordings, the music/ambience, timeline.json (shot order, in/out, durations, trimStart, dialogue start times), timeline.edl (CMX 3600, 24 fps) and subtitles.srt built from the dialogue. Returns the folder and file list.',
    inputSchema: { storyboardId: z.string() },
  }, safe(async ({ storyboardId }) => {
    const result = await client.call('POST', `/api/storyboards/${storyboardId}/export-project`, {});
    return ok(text({ folder: result.folder, files: result.files }));
  }));

  tool('trim_shot', {
    title: 'Trim or resize a shot',
    description: 'Cut the start off a shot\'s clip (trimStart, 0-10 seconds skipped from the beginning) and/or change its length (duration, 1-30 whole seconds). The clip itself is not regenerated; a longer duration than the clip may need a new take. Free.',
    inputSchema: { shotId: z.string(), trimStart: z.number().min(0).max(10).optional(), duration: z.number().int().min(1).max(30).optional() },
  }, safe(async ({ shotId, trimStart, duration }) => {
    if (trimStart === undefined && duration === undefined) throw new Error('Give trimStart and/or duration.');
    const detail = await client.call('PATCH', `/api/shots/${shotId}`, { ...(duration !== undefined ? { duration } : {}), ...(trimStart !== undefined ? { details: { trimStart } } : {}) });
    const shot = shotIn(detail, shotId);
    return ok(text({ shotId, position: shot?.position, duration: shot?.duration, trimStart: shot?.details?.trimStart }));
  }));

  tool('set_shot_timing', {
    title: 'Set a shot\'s anime timing (exposure)',
    description: 'Choose how long each drawing stays on screen when the film is joined: timing "twos" or "threes" holds every drawing 2 or 3 frames at the film\'s frame rate (the anime rhythm; frame smoothing is skipped for the shot), "ones" draws a new picture every frame, "auto" (the default) leaves the clip as it is (in an anime storyboard it is not auto-smoothed either). holds freezes the picture for a span: [{start, seconds}] from the start of the shot after the trim (also no smoothing). Applies to the shot\'s drawn clip only, not to the camera move of a free still shot. Works on locked shots, does not reset the review; join_storyboard again to see it. Free.',
    inputSchema: {
      shotId: z.string(), timing: z.enum(['auto', 'ones', 'twos', 'threes']).optional(),
      holds: z.array(z.object({ start: z.number().min(0).max(600), seconds: z.number().min(0.04).max(10) })).max(8).optional().describe('[] clears the holds'),
    },
  }, safe(async ({ shotId, timing, holds }) => {
    if (timing === undefined && holds === undefined) throw new Error('Give timing and/or holds.');
    const detail = await client.call('PATCH', `/api/shots/${shotId}`, { details: { ...(timing !== undefined ? { timing } : {}), ...(holds !== undefined ? { holds } : {}) } });
    const shot = shotIn(detail, shotId);
    return ok(text({ shotId, position: shot?.position, timing: shot?.details?.timing, holds: shot?.details?.holds }));
  }));

  // Kokoro/Chatterbox voice pools for automatic casting, most natural first.
  const castPools = {
    female: ['af_heart', 'bf_emma', 'af_bella', 'af_nicole', 'bf_isabella', 'af_sarah', 'af_nova', 'bf_alice', 'af_sky', 'af_kore', 'bf_lily', 'af_aoede', 'af_jessica', 'af_river', 'af_alloy'],
    male: ['am_michael', 'bm_george', 'am_fenrir', 'bm_lewis', 'am_puck', 'am_eric', 'bm_daniel', 'am_liam', 'am_onyx', 'am_echo', 'am_adam', 'am_santa'],
    narrator: ['bm_fable', 'af_heart', 'bf_emma', 'bm_george'],
  };
  const genderOf = (character) => {
    const words = `${character.designTags ?? ''} ${character.description ?? ''}`.toLowerCase();
    const count = (re) => (words.match(re) ?? []).length;
    const female = count(/\b(1girl|\d?girls?|woman|women|female|lady|she|her|princess|queen|mother|sister|daughter|witch)\b/g);
    const male = count(/\b(1boy|\d?boys?|man|men|male|guy|he|his|him|prince|king|father|brother|son)\b/g);
    return female > male ? 'female' : male > female ? 'male' : null;
  };

  tool('cast_voices', {
    title: 'Cast voices for a storyboard',
    description: 'Give the narrator and every character in a storyboard (its cast and every dialogue speaker) a voice in one call. Characters without a voice get a distinct free local voice (female/male guessed from designTags and description); voices already chosen are kept unless replace=true. Pick specific ones with narrator / voices (voice names from list_voices). engine "chatterbox" acts lines with emotion on the GPU; "kokoro" (default) is fast. record=true then records every unrecorded line. Changing a voice does not re-record existing lines (use rerecord_line).',
    inputSchema: {
      storyboardId: z.string(),
      narrator: z.string().optional().describe('Narrator voice name, e.g. "bm_fable"'),
      voices: z.record(z.string(), z.string()).optional().describe('characterId -> voice name, e.g. {"<id>": "af_bella"}'),
      engine: z.enum(['kokoro', 'chatterbox']).optional(),
      provider: z.string().optional().describe('Use a provider voice model instead of the local voices (with model)'), model: z.string().optional(),
      replace: z.boolean().optional().describe('Also re-cast characters that already have a voice (default false)'),
      record: z.boolean().optional().describe('Record every unrecorded dialogue line afterwards (default false)'),
    },
  }, safe(async ({ storyboardId, narrator, voices: chosen = {}, engine = 'kokoro', provider, model, replace = false, record = false }) => {
    const wantProvider = provider ?? (model ? undefined : 'local');
    const wantModel = model ?? (provider ? undefined : engine === 'chatterbox' ? 'chatterbox' : 'kokoro-82m');
    const matches = (await speechModels()).filter((m) => (!wantProvider || m.provider === wantProvider) && (!wantModel || m.model === wantModel));
    const target = matches.find((m) => m.ready);
    if (!target) throw new Error(matches[0] ? `${matches[0].label} is not ready. ${matches[0].setup}` : `No voice model ${[wantProvider, wantModel].filter(Boolean).join(':')} (see list_voices).`);
    const speech = { provider: target.provider, model: target.model };
    const available = target.voices;
    const check = (name, who) => {
      if (available.length && !available.includes(name)) throw new Error(`${speech.model} has no voice "${name}" (for ${who}). Its voices: ${available.join(', ')}.`);
      return name;
    };
    const detail = await client.call('GET', `/api/storyboards/${storyboardId}`);
    const speakers = new Set(detail.sequence.settings.characterIds ?? []);
    let narratorLines = 0;
    for (const shot of detail.shots) for (const line of shot.details?.dialogue ?? []) line.speaker === 'narrator' ? narratorLines += 1 : speakers.add(line.speaker);
    const everyone = (await client.call('GET', '/api/characters')).characters;
    const cast = [...speakers].map((id) => everyone.find((c) => c.id === id)).filter((c) => c && c.kind !== 'location');
    for (const id of Object.keys(chosen)) if (!cast.some((c) => c.id === id)) throw new Error(`Character ${id} is not in this storyboard.`);

    const used = new Set();
    const sameModel = (v) => v?.provider === speech.provider && v?.model === speech.model;
    for (const c of cast) if (!replace && c.voice && sameModel(c.voice) && !chosen[c.id]) used.add(c.voice.voice);
    const current = detail.sequence.settings.narratorVoice;
    if (!replace && current && sameModel(current) && !narrator) used.add(current.voice);
    for (const name of Object.values(chosen)) used.add(name);
    if (narrator) used.add(narrator);
    const kokoroNames = available.some((v) => castPools.female.includes(v));
    const next = (pool) => {
      const options = kokoroNames ? [...castPools[pool], ...castPools.female, ...castPools.male] : available;
      const pick = options.find((v) => !used.has(v)) ?? options[used.size % Math.max(1, options.length)];
      if (pick) used.add(pick);
      return pick ?? null;
    };

    // Work out every assignment first and check it, then save: an invalid choice changes nothing.
    const result = { model: `${speech.provider}:${speech.model}`, narrator: null, characters: [], queued: 0 };
    const voiceOf = (name) => ({ ...speech, ...(name ? { voice: name } : {}) });
    const writes = [];
    for (const c of cast) {
      if (!chosen[c.id] && c.voice && !replace) { result.characters.push({ id: c.id, name: c.name, voice: c.voice.voice, model: `${c.voice.provider}:${c.voice.model}`, kept: true }); continue; }
      const gender = genderOf(c);
      const name = chosen[c.id] ? check(chosen[c.id], c.name) : next(gender ?? (result.characters.length % 2 ? 'male' : 'female'));
      writes.push(['PATCH', `/api/characters/${c.id}`, { voice: voiceOf(name) }]);
      result.characters.push({ id: c.id, name: c.name, voice: name, guessed: chosen[c.id] ? undefined : gender ?? 'unknown (alternating)' });
    }
    if (narrator || !current || replace) {
      const name = narrator ? check(narrator, 'the narrator') : next('narrator');
      writes.push(['PATCH', `/api/storyboards/${storyboardId}`, { settings: { narratorVoice: voiceOf(name) } }]);
      result.narrator = { voice: name, lines: narratorLines };
    } else result.narrator = { voice: current.voice, model: `${current.provider}:${current.model}`, kept: true, lines: narratorLines };
    const voiceNames = [...result.characters.map((c) => c.voice), result.narrator.voice].filter(Boolean);
    const shared = voiceNames.filter((v, i) => voiceNames.indexOf(v) !== i);
    if (shared.length) result.warning = `${speech.model} has too few voices for everyone to sound different: ${[...new Set(shared)].join(', ')} is used more than once.`;
    for (const [method, route, body] of writes) await client.call(method, route, body);

    if (record) {
      for (const shot of detail.shots) {
        if (!(shot.details?.dialogue ?? []).some((l) => !l.assetId)) continue;
        result.queued += (await client.call('POST', `/api/shots/${shot.id}/dialogue`, {})).queued.length;
      }
    }
    result.next = record ? 'Lines are recording: watch_jobs, then preview_shot to listen.' : 'Listen with preview_voice, change any with voices / narrator, then record with voice_dialogue (or cast_voices record=true).';
    return ok(text(result));
  }));

  tool('set_character_voice', {
    title: 'Set a character\'s voice',
    description: 'Choose the speech model and voice for a character (voices from list_models). New dialogue uses it. Lines already recorded keep the OLD voice: to re-record one, call rerecord_line (shotId, lineIndex). With revoice: true, every line by this character that has no recording yet is queued now in the new voice (costs a little per line); the result lists which recorded lines were left alone.',
    inputSchema: {
      characterId: z.string(), provider: z.string(), model: z.string(), voice: z.string().optional(),
      revoice: z.boolean().optional().describe('Also record this character\'s unrecorded lines now'),
    },
  }, safe(async ({ characterId, provider, model, voice, revoice = false }) => {
    const { character } = await client.call('PATCH', `/api/characters/${characterId}`, { voice: { provider, model, ...(voice ? { voice } : {}) } });
    const result = { character: character.name, voice: character.voice, queued: 0, keptOldVoice: [] };
    if (revoice) {
      for (const project of (await client.call('GET', '/api/projects')).projects) {
        for (const board of (await client.call('GET', `/api/projects/${project.id}/storyboards`)).storyboards) {
          const detail = await client.call('GET', `/api/storyboards/${board.id}`);
          for (const shot of detail.shots) {
            const mine = (shot.details?.dialogue ?? []).filter((l) => l.speaker === characterId);
            if (!mine.length) continue;
            for (const line of mine.filter((l) => l.assetId)) result.keptOldVoice.push({ storyboard: detail.sequence.title, shot: shot.position, shotId: shot.id, text: line.text.slice(0, 80) });
            if (mine.some((l) => !l.assetId)) result.queued += (await client.call('POST', `/api/shots/${shot.id}/dialogue`, {})).queued.length;
          }
        }
      }
      result.note = result.keptOldVoice.length ? 'Recorded lines listed in keptOldVoice still have the old voice. To re-record one, call rerecord_line with its shotId and lineIndex.' : undefined;
    }
    return ok(text(result));
  }));

  // Tool schemas are generated with a "$schema" keyword; some clients (ChatGPT's connector validator among the
  // strict ones) only want the plain object schema, so list tools without it.
  const handlers = server.server._requestHandlers;
  const listTools = handlers?.get('tools/list');
  if (listTools) {
    handlers.set('tools/list', async (...args) => {
      const result = await listTools(...args);
      for (const tool of result.tools ?? []) {
        if (tool.inputSchema) delete tool.inputSchema.$schema;
        if (tool.outputSchema) delete tool.outputSchema.$schema;
      }
      return result;
    });
  }

  // ---------- Prompts: ready-made step plans that use the real tool names ----------
  const arg = (description) => z.string().optional().describe(description);
  server.registerPrompt('make_anime_short', {
    title: 'Make an anime short',
    description: 'Step-by-step plan for an English-language anime short, from idea to joined MP4, using Lumina\'s film tools.',
    argsSchema: { idea: z.string().describe('The story idea'), minutes: arg('Running time in minutes, e.g. 1'), characters: arg('Cast: names and looks, comma separated') },
  }, ({ idea, minutes, characters }) => filmPrompt(`Make an English-language anime short in Lumina Studio.
Idea: ${idea}
Running time: ${minutes || '1'} minute(s).
Cast: ${characters || 'invent a small cast that fits the idea'}.

Plan (ask the user before anything that spends credits; local models are free but slow, one GPU job at a time):
1. list_projects, then create_project (or reuse one).
2. For each cast member: create_character with a precise description and designTags, then make_character_sheet, check it, and bake_character (action "start") for the main characters. Lock approved looks with update_character locked: true.
3. create_storyboard with look "anime", finish "anime", the targetMinutes above, characterIds, and lipSync false unless the user wants mouths animated. If the budget is strict, use plan=false and write the shots yourself with import_shot_plan.
4. production_readiness, then estimate_film_cost; show the numbers to the user.
5. Loop film_next_step: show its question and images to the user, make the chosen call, repeat. Use watch_jobs (waitSeconds) to wait, never poll.
6. Record dialogue with set_character_voice and voice_dialogue (English only); lip_sync_shot only if lipSync is on.
7. preview_storyboard, preview_shot and review_shot every shot; fix problems with update_shot, trim_shot, adjust_shot_look.
8. join_storyboard, then report the final video asset id and the total spent (budget_status).`));

  server.registerPrompt('fix_a_shot', {
    title: 'Fix a shot',
    description: 'Look at one shot, find what is wrong and fix it with the cheapest tool that works.',
    argsSchema: { storyboardId: z.string().describe('Storyboard id'), shotId: z.string().describe('Shot id'), problem: arg('What looks wrong, in the user\'s words') },
  }, ({ storyboardId, shotId, problem }) => filmPrompt(`Fix shot ${shotId} of storyboard ${storyboardId}.${problem ? ` Reported problem: ${problem}` : ''}

1. preview_shot (shotId ${shotId}) and read the failed checks. Do not buy another take before you know what is wrong.
2. Cheapest fixes first (all free): trim_shot (cut the start or change length), adjust_shot_look (colour), move_shot (order), update_shot (description, dialogue, camera, method "still" instead of video), render_still_shot.
3. If the frame is wrong: update_shot the description, review_shot status "needs_regeneration", then generate_shot kind "frame". If only the clip is wrong: generate_shot kind "clip" once, with an idempotencyKey. Check estimate_film_cost / budget_status first; on a 402 stop and ask the user. Never loop retries.
4. If dialogue overruns the shot, lengthen it with trim_shot duration or shorten the lines, then voice_dialogue again.
5. preview_shot again, then review_shot "accepted" if it is good, and join_storyboard to rebuild the film.`));

  server.registerPrompt('finish_film', {
    title: 'Finish a film',
    description: 'Take an existing storyboard to the finished MP4 with the guided wizard.',
    argsSchema: { storyboardId: z.string().describe('Storyboard id') },
  }, ({ storyboardId }) => filmPrompt(`Finish the film for storyboard ${storyboardId}.
1. get_storyboard and budget_status, then estimate_film_cost; tell the user what is left and what it costs.
2. Loop film_next_step (storyboardId ${storyboardId}): show the question and preview images, wait for the user's answer, make the chosen call. Use watch_jobs to wait for jobs.
3. On a 402 stop and ask the user (decide_approval only if they agree). On a 409 call watch_jobs.
4. When film_next_step says the film is ready, join_storyboard and give the user the result.`));
}
