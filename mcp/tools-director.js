// MCP tools: director. Registered by registerLuminaTools (mcp/tools.js) with the shared helpers in `ctx`:
// { tool, text, ok, safe, client, z, path, summarizeGeneration, waitAndShow, imageContent, mediaParts, pickModel }.
// `meta` adds entries to TOOL_META: name -> [flags (r read-only, d destructive, i idempotent, o external/paid), cost, next].
export const meta = {
  get_director_brief: ['r', 'Free.', 'direct_shot or direct_storyboard'],
  direct_shot: ['i', 'Free; saves prompts without generating.', 'preview_prompts, then generate_shot'],
  direct_storyboard: ['i', 'Free; saves prompts without generating.', 'preview_prompts, then generate_shot'],
  preview_prompts: ['r', 'Free; no model calls.', 'direct_shot or generate_shot'],
};

export function register({ tool, text, ok, safe, client, z }) {
  const role = 'You, the connected AI (Claude or ChatGPT), are Lumina’s creative director: write the shot plan with import_shot_plan and the prompts with direct_shot. No paid writer or director model is needed. Under a strict budget this is the recommended path: create_storyboard with plan=false; omit generate_image’s director option.';
  const direction = {
    framePrompt: z.string().min(1).max(4000).nullable().optional().describe('Your opening-frame prompt; null clears the override.'),
    clipPrompt: z.string().min(1).max(4000).nullable().optional().describe('Your animation prompt; null clears the override.'),
    negativePrompt: z.string().min(1).max(4000).nullable().optional().describe('Exclusions appended as an Avoid instruction (no separate provider negative channel); null clears. Ignored for a verbatim positive override.'),
    camera: z.string().nullable().optional().describe('A camera preset id from list_presets; null clears.'),
    motion: z.string().optional().describe('Local still-shot move, e.g. push-in, pan-left or static.'),
    keepAutomatic: z.boolean().optional().describe('Default true: keep designTags, look bible, consistency and camera/style blocks. False: send overridden text verbatim, bypassing automatic character text, character references/bakes and presets. Clear a prompt with null to restore its automatic composition.'),
  };
  const pagination = { offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(60).optional().describe('Shots per page (default 6, max 60).') };
  const query = ({ offset, limit }) => `?offset=${offset ?? 0}&limit=${limit ?? 6}`;
  tool('get_director_brief', {
    title: 'Read the creative director brief',
    description: `${role} Read the film brief, look bible, all characters and locations (designs, voices, references and bake status), and a page of shots with states, timing, dialogue, saved overrides and EXACT composed frame/clip prompts. Read-only; no generation.`,
    inputSchema: { storyboardId: z.string(), ...pagination },
  }, safe(async ({ storyboardId, ...page }) => ok(text(await client.call('GET', `/api/storyboards/${storyboardId}/director-brief${query(page)}`)))));
  tool('direct_shot', {
    title: 'Direct a shot with your own prompts',
    description: `${role} Save your frame/clip prompts and optional exclusions, camera and still motion. Unspecified values stay unchanged; keepAutomatic defaults to true on a new shot. Null clears a prompt override. This is a story revision: locked shots must be unlocked with update_shot first, and frame/clip approvals reset. Saves only; does not pay for generation.`,
    inputSchema: { shotId: z.string(), ...direction },
  }, safe(async ({ shotId, ...input }) => ok(text(await client.call('POST', `/api/shots/${shotId}/direct`, input)))));
  tool('direct_storyboard', {
    title: 'Direct several shots together',
    description: `${role} Apply shot directions in one atomic call. Every shot id, storyboard membership, field and story lock is validated before anything is saved; a bad entry saves nothing. Each entry follows direct_shot’s override, clearing and approval rules.`,
    inputSchema: { storyboardId: z.string(), shots: z.array(z.object({ shotId: z.string(), ...direction }).strict()).min(1).max(60) },
  }, safe(async ({ storyboardId, shots }) => ok(text(await client.call('POST', `/api/storyboards/${storyboardId}/direct`, { shots })))));
  tool('preview_prompts', {
    title: 'Preview the exact generation prompts for free',
    description: `${role} Read ONLY composed frame and clip prompts, including automatic look, identity and camera/style text, before paying. Supply exactly one shotId or storyboardId; storyboard results are paginated. Prompts assume the currently selected storyboard image model; a generate_shot model override can change reference wording.`,
    inputSchema: { storyboardId: z.string().optional(), shotId: z.string().optional(), ...pagination },
  }, safe(async ({ storyboardId, shotId, ...page }) => {
    if (Boolean(storyboardId) === Boolean(shotId)) throw new Error('Supply exactly one storyboardId or shotId.');
    return ok(text(await client.call('GET', shotId ? `/api/shots/${shotId}/prompts` : `/api/storyboards/${storyboardId}/prompts${query(page)}`)));
  }));
}
