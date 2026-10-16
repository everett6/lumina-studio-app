// MCP tools: canon. Registered by registerLuminaTools (mcp/tools.js) with the shared helpers in `ctx`.
// `meta`: name -> [flags (r read-only, d destructive, i idempotent, o external/paid), cost, next].
import { canonPatchSchema, canonChangeSchema } from '../src/canon.js';

const free = 'Free and local. No provider calls, GPU work or credits.';
export const meta = {
  create_film_canon: ['', free, 'get_film_canon, then update_canon'],
  get_film_canon: ['r', free, 'update_canon or lock_canon'],
  update_canon: ['', free, 'canon_diff, then canon_affected_shots'],
  lock_canon: ['i', free, 'canon_snapshot_for_job'],
  unlock_canon: ['i', free, 'update_canon'],
  canon_diff: ['r', free, 'canon_affected_shots'],
  canon_affected_shots: ['r', free, 'invalidate_affected_approvals'],
  invalidate_affected_approvals: ['di', free, 'review_shot'],
  canon_snapshot_for_job: ['', free, 'record snapshot id and hash with the job'],
  canon_sync_from_globals: ['', free, 'canon_diff, then invalidate_affected_approvals'],
};

export function register({ tool, text, ok, safe, client, z }) {
  const storyboardId = z.string().uuid();
  const revision = z.number().int().min(1);
  const base = (id) => `/api/storyboards/${id}/canon`;
  const add = (name, title, description, inputSchema, handler, readOnly = false) => tool(name, {
    title, description, inputSchema, ...(readOnly ? { annotations: { readOnlyHint: true } } : {}),
  }, safe(async (args) => ok(text(await handler(args)))));

  add('create_film_canon', 'Create a film canon',
    'Seed revision 1 of a storyboard’s film bible from its current cast, locations, products and look. Records are copied into a snapshot: later global edits never change it. Existing canon returns 409. Free and local.',
    { storyboardId }, ({ storyboardId }) => client.call('POST', base(storyboardId), {}));
  add('get_film_canon', 'Read a film canon revision',
    'Read the current film canon or an explicit historical revision, its frozen reference revisions and current lock state. Free and local.',
    { storyboardId, revision: revision.optional() }, ({ storyboardId, revision }) => client.call('GET', `${base(storyboardId)}${revision ? `?revision=${revision}` : ''}`), true);
  add('update_canon', 'Revise the film canon',
    'Create a new immutable revision with expectedRevision (stale returns 409). Locked canon refuses edits. Arrays replace in full; style and storyFacts merge supplied fields. Set identity, proportions, hair, eyes, distinguishingFeatures, approvedReferenceAssetIds, wardrobeVariants with allowedWhen, voice, location layout/landmarks/lightingRules, props, style and storyFacts. Approvals are never silently reset; inspect affected shots then explicitly invalidate. Free and local.',
    { storyboardId, expectedRevision: revision, patch: canonPatchSchema }, ({ storyboardId, ...body }) => client.call('PATCH', base(storyboardId), body));
  for (const [name, action] of [['lock_canon', 'lock'], ['unlock_canon', 'unlock']]) add(name, `${action === 'lock' ? 'Lock' : 'Unlock'} the film canon`,
    `${action === 'lock' ? 'Block canon updates and applied global sync' : 'Allow explicit canon revisions again'}. Requires a reason; records the action in the canon audit and any film journal. Content revision is unchanged. Free and local.`,
    { storyboardId, reason: z.string().trim().min(1).max(1000) }, ({ storyboardId, reason }) => client.call('POST', `${base(storyboardId)}/${action}`, { reason }));
  add('canon_diff', 'Compare film canon revisions',
    'Compare two saved canon revisions. Returns changed entities with before/after and fields, plus style and story facts changes. Free and local.',
    { storyboardId, fromRevision: revision, toRevision: revision }, ({ storyboardId, fromRevision, toRevision }) => client.call('GET', `${base(storyboardId)}/diff?fromRevision=${fromRevision}&toRevision=${toRevision}`), true);
  add('canon_affected_shots', 'Find shots affected by a canon change',
    'Pass either change {section, id?, characterId?} or both fromRevision and toRevision. Sections: characters, locations, props, wardrobe, style, storyFacts. Wardrobe needs characterId and variant id. Matches shot details.characterIds/locationId and scene-state start/end props and wardrobe; style/story facts affect all shots. Does not inspect pictures or infer undeclared use. Free and local.',
    { storyboardId, change: canonChangeSchema.optional(), fromRevision: revision.optional(), toRevision: revision.optional() }, ({ storyboardId, ...body }) => client.call('POST', `${base(storyboardId)}/affected-shots`, body), true);
  add('invalidate_affected_approvals', 'Reset approvals affected by a canon revision',
    'Explicitly reset approved frames and accepted clips on shots affected by revision versus its predecessor (revision 1 has none). Calls existing shot review functions through the API. Returns every changed shot’s before/after review and records the operation. Leaves media intact. Free and local.',
    { storyboardId, revision }, ({ storyboardId, revision }) => client.call('POST', `${base(storyboardId)}/invalidate-approvals`, { revision }));
  add('canon_snapshot_for_job', 'Freeze a job’s film canon',
    'Store an immutable snapshot of the current canon and its frozen global/asset reference revisions. Returns id, revision, SHA-256 hash, canonical hashInput and content; record the id and hash with a job. Does not submit or modify jobs. Free and local.',
    { storyboardId }, ({ storyboardId }) => client.call('POST', `${base(storyboardId)}/snapshots`, {}));
  add('canon_sync_from_globals', 'Preview or apply global canon changes',
    'Compare current canon with live global character/location/product fields used by this storyboard. Default apply=false reports canon/global and source-baseline diffs only. apply=true explicitly copies shared global fields into a new revision when changed (blocked while locked); preserves film-only fields such as wardrobe and approved references. No changes means no new revision. Free and local.',
    { storyboardId, apply: z.boolean().optional() }, ({ storyboardId, apply = false }) => client.call('POST', `${base(storyboardId)}/sync`, { apply }));
}
