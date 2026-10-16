// MCP tools: edit. Registered by registerLuminaTools (mcp/tools.js) with the shared helpers in `ctx`:
// { tool, text, ok, safe, client, z, path, summarizeGeneration, waitAndShow, imageContent, mediaParts, pickModel, pickVoice, resolveAudio }.
// `meta` adds entries to TOOL_META: name -> [flags (r read-only, d destructive, i idempotent, o external/paid), cost, next].
const free = 'Free, CPU only; no provider calls.';
export const meta = {
  insert_shot: ['', free, 'shot_timeline'], duplicate_shot: ['', free, 'shot_timeline'],
  split_shot: ['', free, 'shot_timeline'], delete_shot: ['d', free, 'shot_timeline'],
  set_cut_transition: ['i', free, 'join_storyboard'], set_shot_speed: ['i', free, 'join_storyboard'],
  add_text_overlay: ['', free, 'join_storyboard'], make_animatic: ['', free, 'inspect_video'],
  reorder_scene: ['i', free, 'shot_timeline'], shot_timeline: ['r', free, null],
};

export function register({ tool, text, ok, safe, client, z }) {
  const add = (name, title, description, inputSchema, method, url, annotations) => tool(name, {
    title, description: `${description} ${free}`, inputSchema, ...(annotations ? { annotations } : {}),
  }, safe(async (args) => {
    const { storyboardId, shotId, ...body } = args;
    return ok(text(await client.call(method, url(storyboardId ?? shotId), method === 'GET' ? undefined : body)));
  }));
  const shotId = z.string(), storyboardId = z.string();
  add('insert_shot', 'Insert a shot', 'Insert after afterShotId; null inserts first; leave it out to add the shot at the end. Saves a plan without generating media.', {
    storyboardId, afterShotId: z.string().nullable().optional(), shot: z.object({ description: z.string().trim().min(1).max(2000), duration: z.number().min(1 / 24).max(30), camera: z.string().nullable().optional(), details: z.record(z.string(), z.unknown()).optional() }),
  }, 'POST', (id) => `/api/storyboards/${id}/edit/insert`);
  add('duplicate_shot', 'Duplicate a shot plan', 'Insert a copy immediately after this shot. withMedia=true references the same assets, including recordings; files are never copied. Approvals reset.', {
    shotId, withMedia: z.boolean().default(false),
  }, 'POST', (id) => `/api/shots/${id}/edit/duplicate`);
  add('split_shot', 'Split a shot', 'Split at playback seconds from the shot start. Keeps media references, advances the second clip trim, and assigns dialogue by line start time. Unlock first. Picture approvals reset.', {
    shotId, atSeconds: z.number().positive(),
  }, 'POST', (id) => `/api/shots/${id}/edit/split`);
  add('delete_shot', 'Delete a shot', 'Destructive: confirm=true is required. Removes the shot and renumbers; generated takes stay in the asset library. Unlock first.', {
    shotId, confirm: z.literal(true),
  }, 'POST', (id) => `/api/shots/${id}/edit/delete`, { destructiveHint: true });
  add('set_cut_transition', 'Set the outgoing cut', 'Set cut, crossfade, fade-black or fade-white after this shot. Uses outgoing handles to preserve planned runtime, like the storyboard default. seconds is frame-rounded and limited by the neighbouring shots. Final-shot transition is inactive.', {
    shotId, transition: z.enum(['cut', 'crossfade', 'fade-black', 'fade-white']), seconds: z.number().min(0).max(10),
  }, 'POST', (id) => `/api/shots/${id}/edit/transition`);
  add('set_shot_speed', 'Set shot playback speed', 'Playback duration is source duration / speed, rounded to frames at join. Changes clip picture and sound; keepPitch=true preserves clip sound pitch. Recorded dialogue is not sped up. Picture approvals reset.', {
    shotId, speed: z.number().min(0.25).max(4), keepPitch: z.boolean().default(true),
  }, 'POST', (id) => `/api/shots/${id}/edit/speed`);
  add('add_text_overlay', 'Add timed shot text', 'Burn literal text over the shot at join. start/seconds use playback time, with an exclusive end. Picture approvals reset.', {
    shotId, text: z.string().trim().min(1).max(2000), position: z.enum(['top', 'center', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right']), start: z.number().min(0), seconds: z.number().positive(), style: z.enum(['sign', 'caption', 'title']),
  }, 'POST', (id) => `/api/shots/${id}/edit/overlay`);
  add('make_animatic', 'Make a free pacing animatic', 'Render 640×360 from frames (placeholder cards when missing), with burned shot numbers/labels and optional existing recorded dialogue. Saves an asset and reports runtime, missing frames and speech overruns. Does not generate or replace media or approvals.', {
    storyboardId, fps: z.union([z.literal(12), z.literal(24)]).default(12), includeDialogue: z.boolean().default(true),
  }, 'POST', (id) => `/api/storyboards/${id}/edit/animatic`);
  add('reorder_scene', 'Move a whole scene', 'Gather all shots with this scene label, preserving their order, and move them before beforeScene; null moves them to the end.', {
    storyboardId, scene: z.string().max(80), beforeScene: z.string().max(80).nullable(),
  }, 'POST', (id) => `/api/storyboards/${id}/edit/reorder-scene`);
  add('shot_timeline', 'Read the exact shot timeline', 'Start, end, duration, outgoing transition, speed and overlays per shot, in seconds and frames at 24 fps. Uses the same timing rules as join and animatic.', {
    storyboardId,
  }, 'GET', (id) => `/api/storyboards/${id}/edit/timeline`, { readOnlyHint: true });
}
