// MCP tools: review. Registered by registerLuminaTools with the shared ctx helpers.
// meta: name -> [flags (r read-only, d destructive, i idempotent, o external/paid), cost, next].
const free = 'Free; local CPU/ffmpeg only, no vision provider.';
export const meta = {
  get_review_bundle: ['r', free, 'record_finding'],
  compare_takes: ['r', free, 'record_finding'],
  sample_frames: ['r', free, 'record_finding'],
  adjacent_shot_check: ['r', free, 'record_finding'],
  record_finding: ['', 'Free; stores reviewer evidence only.', 'review_summary'],
  review_summary: ['r', 'Free.', 'propose_repair'],
  propose_repair: ['r', 'Free estimate; does not submit work.', 'execute_repair'],
  execute_repair: ['o', 'May spend on the chosen image, video or speech provider. Budget gates apply; stops on 402. Trim is free.', 'repair_history, then record_finding'],
  accept_repair: ['', 'Free; selects an already reviewed take and runs local checks.', 'review_summary'],
  reject_take: ['', 'Free; records a reason and keeps the selected take.', 'repair_history'],
  repair_history: ['r', 'Free.', null],
};

export function register({ tool, text, ok, safe, client, z }) {
  const shotId = z.string().uuid(), storyboardId = z.string().uuid();
  const takeId = z.string().min(1).max(100);
  const reason = z.string().trim().min(1).max(1000);
  const model = { provider: z.string().max(120).optional(), model: z.string().max(120).optional() };
  const prompt = z.string().trim().min(1).max(4000);
  const plan = z.discriminatedUnion('type', [
    z.object({ type: z.literal('re-frame'), prompt, ...model, findingId: z.string().nullable().optional() }),
    z.object({ type: z.literal('repair_frame'), box: z.array(z.number().min(0).max(1)).length(4), instruction: z.string().trim().min(1).max(3000), ...model, findingId: z.string().nullable().optional() }),
    z.object({ type: z.literal('new_clip'), frameId: z.string().uuid().optional(), prompt: prompt.optional(), ...model, findingId: z.string().nullable().optional() }),
    z.object({ type: z.literal('trim'), trimStart: z.number().min(0).max(10).optional(), duration: z.number().int().min(1).max(30).optional(), findingId: z.string().nullable().optional() }),
    z.object({ type: z.literal('re-record'), lineIndex: z.number().int().min(0).max(11), style: z.string().max(500).optional(), ...model, findingId: z.string().nullable().optional() }),
  ]);
  // Media is already capped by the API. Emit actual MCP image/audio blocks, with labels immediately
  // before each block, and keep a small JSON manifest as the first text item for machine readers.
  const show = ({ media = [], ...data }) => ok(text({ ...data, inline: media.map(({ type, label, mimeType }) => ({ type, label, mimeType })) }), ...media.flatMap(({ label, ...part }) => [text(label), part]));
  const add = (name, title, description, inputSchema, handler) => tool(name, { title, description, inputSchema }, safe(handler));
  add('get_review_bundle', 'Review a shot with its references and cuts', 'Approved (locked) character references, timestamped opening/middle/ending frames, neighbouring cut frames, dialogue audio, declared scene state and current-take findings, inline. Shared 1 MiB encoded media cap; 120 KiB per image, 256 KiB per audio, 8 references, 50 findings and 16 KiB scene state. Omissions are labelled. Looking at these is required for visual review: colour scores do not verify identity.', { shotId }, async ({ shotId }) => show(await client.call('GET', `/api/shots/${shotId}/review-bundle`)));
  add('compare_takes', 'Compare two takes at matching moments', 'One side-by-side contact sheet (A left, B right) at the same opening, middle and ending timestamps over the shared duration. Reports mean absolute RGB difference 0–255 per moment. A numeric difference measures pixels, not quality or character identity.', { shotId, takeA: takeId, takeB: takeId }, async ({ shotId, takeA, takeB }) => show(await client.call('POST', `/api/shots/${shotId}/compare-takes`, { takeA, takeB })));
  add('sample_frames', 'Sample timestamped frames inline', 'Return timestamped frames from an image or clip inline. Supply times or count (1–12, default 3), never both. Times must lie within the decodable clip. Uses the shared inline media caps and labels omissions.', { assetId: z.string().uuid(), times: z.array(z.number().min(0)).min(1).max(12).optional(), count: z.number().int().min(1).max(12).optional() }, async ({ assetId, ...body }) => show(await client.call('POST', `/api/assets/${assetId}/sample-frames`, body)));
  add('adjacent_shot_check', 'Inspect every cut in a storyboard', 'For each cut, show the last frame of shot N beside the first of shot N+1 with timestamps and colour/brightness jump scores (0–255). Missing media stays unavailable. These measurements do not establish continuity correctness. Shared media cap applies across all cuts.', { storyboardId }, async ({ storyboardId }) => show(await client.call('GET', `/api/storyboards/${storyboardId}/adjacent-shot-check`)));
  add('record_finding', 'Record a visual review finding', 'Record a reviewer’s passed, failed or uncertain finding with evidence and confidence (0–1); reviewer includes name, model and version (unspecified if not provided). Stored as a film finding event, or in settings before a film exists. takeId defaults to the selected clip/frame; supply it to review a repair candidate. Failed and uncertain are never promoted to passed.', {
    shotId, area: z.enum(['identity', 'wardrobe', 'location', 'props', 'action', 'flicker', 'deformation', 'text', 'cross-shot']), result: z.enum(['passed', 'failed', 'uncertain']), evidence: z.string().trim().min(1).max(2048), confidence: z.number().min(0).max(1), reviewer: z.union([z.string().trim().min(1).max(120), z.object({ name: z.string().trim().min(1).max(120), model: z.string().max(120).nullable().optional(), version: z.string().max(120).optional() })]), takeId: takeId.optional(),
  }, async ({ shotId, ...body }) => ok(text(await client.call('POST', `/api/shots/${shotId}/findings`, body))));
  add('review_summary', 'Summarize visual reviews without assumed passes', 'Per shot and area: passed, failed, unavailable (uncertain) or not reviewed. Only explicit current-take findings count; failed dominates passed and uncertain stays unavailable. Existing technical checks keep their passed/failed/unavailable contract and are listed separately. Nothing is filled in by default.', { storyboardId }, async ({ storyboardId }) => ok(text(await client.call('GET', `/api/storyboards/${storyboardId}/review-summary`))));
  add('propose_repair', 'Propose a specific repair and estimate its cost', 'Propose a changed frame prompt addressing a particular finding, with an estimate from the existing budget estimate route. Does not spend. Other supported plans: repair_frame with a reviewer-chosen region, new_clip from an approved frame, trim, re-record a dialogue line. Review the plan before execute_repair.', { shotId, findingId: z.string().uuid() }, async ({ shotId, findingId }) => ok(text(await client.call('POST', `/api/shots/${shotId}/propose-repair`, { findingId }))));
  add('execute_repair', 'Run a bounded repair without selecting the result', 'Execute a typed repair plan through existing generation, repair and estimate routes. Preserve originals, journal attempts before submission and keep candidates unselected. maxAttempts defaults to 2; durable hard limits are 2 per shot and 10 per storyboard/film (including pre-film attempts). Stop on a successful candidate, pending work, unknown billing/transport errors, or 402. Never loops paid work after a budget refusal. Trim is staged until acceptance.', { shotId, plan, maxAttempts: z.number().int().min(1).max(2).default(2) }, async ({ shotId, ...body }) => ok(text(await client.call('POST', `/api/shots/${shotId}/execute-repair`, body))));
  add('accept_repair', 'Select a take after reviewing it', 'Select an existing or repaired take only after at least one explicit finding on that take, with no failed or uncertain findings. A nonempty reason is recorded. Clip selection reruns existing local checks and records acceptance. Frames still need approveFrame before new_clip. Trim candidates apply only at acceptance; audio candidates adopt the reviewed recording.', { shotId, takeId, reason }, async ({ shotId, ...body }) => ok(text(await client.call('POST', `/api/shots/${shotId}/accept-repair`, body))));
  add('reject_take', 'Reject a take and record why', 'Record rejection of an existing or repaired take with a nonempty reason. Does not delete any take or switch selection. If the selected clip is rejected, its review is marked rejected through the existing review route.', { shotId, takeId, reason }, async ({ shotId, ...body }) => ok(text(await client.call('POST', `/api/shots/${shotId}/reject-take`, body))));
  add('repair_history', 'Read repair attempts and selection decisions', 'All repair attempts, original takes, plans, estimates, job results and accept/reject reasons for exactly one shotId or storyboardId. Durable across restarts and opening a film later. Pending jobs are reconciled from existing generation records without submitting again.', { shotId: shotId.optional(), storyboardId: storyboardId.optional() }, async ({ shotId, storyboardId }) => {
    if (Boolean(shotId) === Boolean(storyboardId)) throw new Error('Pass exactly one of shotId or storyboardId.');
    return ok(text(await client.call('GET', shotId ? `/api/shots/${shotId}/repair-history` : `/api/storyboards/${storyboardId}/repair-history`)));
  });
}
