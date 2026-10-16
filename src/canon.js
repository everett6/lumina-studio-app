import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

const text = z.string().max(4000);
const id = z.string().min(1).max(200);
const texts = z.array(text).max(200);
const ids = z.array(id).max(200);
const voice = z.object({ provider: id, model: id, voice: text.nullable().optional() }).strict().nullable();
const wardrobe = z.object({ id, description: text, allowedWhen: texts }).strict();
const character = z.object({
  id, name: text, description: text.optional(), designTags: text.optional(), identity: text.optional(), proportions: text.optional(),
  hair: text.optional(), eyes: text.optional(), distinguishingFeatures: texts.optional(), referenceAssetIds: ids.optional(),
  approvedReferenceAssetIds: ids.optional(), wardrobeVariants: z.array(wardrobe).max(100).optional(), voice: voice.optional(),
}).strict();
const location = z.object({
  id, name: text, description: text.optional(), designTags: text.optional(), layout: text.optional(), landmarks: texts.optional(),
  lightingRules: texts.optional(), referenceAssetIds: ids.optional(), approvedReferenceAssetIds: ids.optional(),
}).strict();
const prop = z.object({ id, name: text.optional(), owner: id.nullable(), description: text, referenceAssetIds: ids.optional() }).strict();
const style = z.object({ look: text, palette: texts, description: text, referenceArt: ids }).strict();
const storyFacts = z.object({
  relationships: texts, motivations: texts, prohibitedContradictions: texts,
  setupPayoffs: z.array(z.object({ setup: text, payoff: text }).strict()).max(200),
}).strict();
export const canonSchema = z.object({
  characters: z.array(character).max(200), locations: z.array(location).max(200), props: z.array(prop).max(200), style, storyFacts,
}).strict();
// Top-level arrays replace in full; style and storyFacts merge their supplied fields.
export const canonPatchSchema = canonSchema.partial().extend({ style: style.partial().optional(), storyFacts: storyFacts.partial().optional() }).strict();
export const canonChangeSchema = z.object({
  section: z.enum(['characters', 'locations', 'props', 'wardrobe', 'style', 'storyFacts']), id: id.optional(), characterId: id.optional(),
}).strict();
export const affectedSchema = z.object({ change: canonChangeSchema.optional(), fromRevision: z.number().int().min(1).optional(), toRevision: z.number().int().min(1).optional() }).strict()
  .refine((v) => v.change ? v.fromRevision === undefined && v.toRevision === undefined : v.fromRevision !== undefined && v.toRevision !== undefined,
    'Pass either change or both fromRevision and toRevision.')
  .refine((v) => !v.change || ['style', 'storyFacts'].includes(v.change.section) || (v.change.id && (v.change.section !== 'wardrobe' || v.change.characterId)), 'Entity changes need id; wardrobe also needs characterId.');

// Stable object ordering makes hashes and diffs independent of JSON key insertion order.
export const canonicalJson = (value) => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]));
  return value;
}
const hash = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const parsed = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) fail(400, result.error.message);
  return result.data;
};
function validateDocument(value) {
  const doc = parsed(canonSchema, value);
  for (const section of ['characters', 'locations', 'props']) {
    if (new Set(doc[section].map((v) => v.id)).size !== doc[section].length) fail(400, `Duplicate id in ${section}.`);
  }
  for (const c of doc.characters) if (new Set((c.wardrobeVariants ?? []).map((v) => v.id)).size !== (c.wardrobeVariants ?? []).length) fail(400, `Duplicate wardrobe id for ${c.id}.`);
  return doc;
}

export function diffCanon(before, after) {
  const changes = [];
  for (const section of ['characters', 'locations', 'props']) {
    const a = new Map(before[section].map((v) => [v.id, v])), b = new Map(after[section].map((v) => [v.id, v]));
    for (const id of [...new Set([...a.keys(), ...b.keys()])].sort()) {
      if (equal(a.get(id), b.get(id))) continue;
      const old = a.get(id) ?? null, next = b.get(id) ?? null;
      const fields = [...new Set([...Object.keys(old ?? {}), ...Object.keys(next ?? {})])].filter((k) => !equal(old?.[k], next?.[k])).sort();
      changes.push({ section, id, fields, before: old, after: next });
    }
  }
  for (const section of ['style', 'storyFacts']) if (!equal(before[section], after[section])) changes.push({ section, before: before[section], after: after[section] });
  return changes;
}

export function createCanonService({ repo }) {
  const needBoard = (id) => repo.sequences.get(id) ?? fail(404, 'Storyboard not found.');
  const need = (id) => { needBoard(id); return repo.canonHeads.get(id) ?? fail(404, 'Create this storyboard’s film canon first.'); };
  const revisionNumber = (v) => parsed(z.number().int().min(1), v);
  const revision = (id, n) => repo.canonRevisions.get(id, revisionNumber(n)) ?? fail(404, `Canon revision ${n} not found.`);
  const view = (id, n) => {
    const head = need(id), record = revision(id, n ?? head.revision);
    const { globals, ...publicRecord } = record;
    return { ...publicRecord, currentRevision: head.revision, locked: head.locked, lockReason: head.lockReason };
  };
  const audit = (id, n, action, data = {}) => {
    repo.canonEvents.append(id, n, action, data);
    const film = repo.films.bySequence(id);
    if (film) repo.filmEvents.append(film.id, film.revision, action === 'invalidate_affected_approvals' ? 'approval' : 'edit',
      { source: 'canon', action, canonRevision: n, ...data });
  };
  const writable = (head, expectedRevision) => {
    if (head.locked) fail(409, 'Canon is locked. Unlock it with an explicit reason before revising it.');
    if (head.revision !== revisionNumber(expectedRevision)) fail(409, `Stale expectedRevision: current canon revision is ${head.revision}.`);
  };
  const statesOf = (shot) => {
    const state = repo.settings.get(`scene-state:${shot.id}`, null);
    return [state?.start, state?.end].filter(Boolean);
  };
  // Capture only records used by this storyboard, plus previously tracked records. Unrelated global edits do not enter the film.
  function globalsFor(id, tracked = {}) {
    const board = needBoard(id), wanted = new Set([...(board.settings.characterIds ?? []), ...Object.keys(tracked)]);
    for (const shot of repo.shots.listBySequence(id)) {
      for (const cid of shot.details.characterIds ?? []) wanted.add(cid);
      if (shot.details.locationId) wanted.add(shot.details.locationId);
      for (const state of statesOf(shot)) {
        if (state.location) wanted.add(state.location);
        for (const c of state.characters ?? []) {
          wanted.add(c.id);
          for (const prop of [...(c.props?.held ?? []), ...(c.props?.worn ?? [])]) wanted.add(prop);
        }
      }
    }
    return Object.fromEntries([...wanted].sort().flatMap((id) => {
      const c = repo.characters.get(id);
      if (!c || !['character', 'location', 'product'].includes(c.kind)) return [];
      return [[id, { id, kind: c.kind, name: c.name, description: c.description, designTags: c.designTags, referenceAssetIds: c.referenceAssetIds, voice: c.voice }]];
    }));
  }
  const entry = (c) => {
    if (c.kind === 'location') return { id: c.id, name: c.name, description: c.description, designTags: c.designTags, layout: '', landmarks: [], lightingRules: [], referenceAssetIds: c.referenceAssetIds, approvedReferenceAssetIds: [...c.referenceAssetIds] };
    if (c.kind === 'product') return { id: c.id, name: c.name, owner: null, description: c.description, referenceAssetIds: c.referenceAssetIds };
    return { id: c.id, name: c.name, description: c.description, designTags: c.designTags, identity: c.name, proportions: '', hair: '', eyes: '', distinguishingFeatures: [], referenceAssetIds: c.referenceAssetIds, approvedReferenceAssetIds: [...c.referenceAssetIds], wardrobeVariants: [], voice: c.voice };
  };
  const sectionFor = (c) => c.kind === 'location' ? 'locations' : c.kind === 'product' ? 'props' : 'characters';
  function references(canon, globals) {
    const refs = Object.values(globals).map((c) => ({ type: 'global', id: c.id, revision: hash(c), record: c }));
    const ids = new Set(canon.style.referenceArt);
    for (const c of [...canon.characters, ...canon.locations, ...canon.props]) for (const id of [...(c.referenceAssetIds ?? []), ...(c.approvedReferenceAssetIds ?? [])]) ids.add(id);
    for (const id of [...ids].sort()) {
      const record = repo.assets.get(id) ?? null;
      refs.push({ type: 'asset', id, revision: hash(record), record });
    }
    return refs.sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
  }
  function write(id, expectedRevision, canon, globals, source, data = {}) {
    writable(need(id), expectedRevision);
    canon = validateDocument(canon);
    const changes = diffCanon(revision(id, expectedRevision).canon, canon);
    if (!repo.canonHeads.advance(id, expectedRevision)) fail(409, 'Canon changed or was locked; reload before revising.');
    const n = expectedRevision + 1;
    repo.canonRevisions.insert(id, n, { canon, globals, referenceRevisions: references(canon, globals), source });
    audit(id, n, source, { fromRevision: expectedRevision, changes, ...data });
    return view(id);
  }
  function diff(id, fromRevision, toRevision) {
    need(id);
    return { storyboardId: id, fromRevision, toRevision, changes: diffCanon(revision(id, fromRevision).canon, revision(id, toRevision).canon) };
  }
  function affected(id, input) {
    need(id);
    const { change, fromRevision, toRevision } = parsed(affectedSchema, input);
    const changes = change ? [change] : diff(id, fromRevision, toRevision).changes;
    const shots = [];
    for (const shot of repo.shots.listBySequence(id)) {
      const states = statesOf(shot), people = states.flatMap((s) => s.characters ?? []);
      const characters = new Set([...(shot.details.characterIds ?? []), ...people.map((c) => c.id)]);
      const locations = new Set([shot.details.locationId, ...states.map((s) => s.location)].filter(Boolean));
      const props = new Set(people.flatMap((c) => [...(c.props?.held ?? []), ...(c.props?.worn ?? [])]));
      const reasons = changes.filter((c) => {
        if (['style', 'storyFacts'].includes(c.section)) return true;
        if (c.section === 'locations') return locations.has(c.id);
        if (c.section === 'props') return props.has(c.id);
        if (c.section === 'wardrobe') return people.some((p) => p.id === c.characterId && p.wardrobe === c.id);
        if (c.section === 'characters' && c.fields?.length === 1 && c.fields[0] === 'wardrobeVariants' && c.before && c.after) {
          const a = new Map((c.before.wardrobeVariants ?? []).map((v) => [v.id, v])), b = new Map((c.after.wardrobeVariants ?? []).map((v) => [v.id, v]));
          const changed = new Set([...a.keys(), ...b.keys()].filter((id) => !equal(a.get(id), b.get(id))));
          return people.some((p) => p.id === c.id && changed.has(p.wardrobe));
        }
        return c.section === 'characters' && characters.has(c.id);
      });
      if (reasons.length) shots.push({ shotId: shot.id, position: shot.position, reasons });
    }
    return { storyboardId: id, ...(change ? { change } : { fromRevision, toRevision }), changes, shots, note: 'Matches declared shot details and scene-state start/end. Style and story fact changes affect every shot; undeclared prop/wardrobe use cannot be inferred.' };
  }
  return {
    get: view, diff, affected,
    create: (id) => repo.transaction(() => {
      const board = needBoard(id);
      if (repo.canonHeads.get(id)) fail(409, 'Film canon already exists. Use update_canon with expectedRevision.');
      const globals = globalsFor(id);
      const canon = { characters: [], locations: [], props: [], style: { look: board.settings.look ?? 'live-action', palette: [], description: board.settings.lookBible ?? '', referenceArt: [] }, storyFacts: { relationships: [], motivations: [], prohibitedContradictions: [], setupPayoffs: [] } };
      for (const c of Object.values(globals)) canon[sectionFor(c)].push(entry(c));
      validateDocument(canon);
      repo.canonHeads.create(id);
      repo.canonRevisions.insert(id, 1, { canon, globals, referenceRevisions: references(canon, globals), source: 'create_film_canon' });
      audit(id, 1, 'create_film_canon');
      return view(id);
    }),
    update: (id, expectedRevision, patch) => repo.transaction(() => {
      const head = need(id);
      writable(head, expectedRevision);
      patch = parsed(canonPatchSchema, patch);
      const previous = revision(id, head.revision);
      const canon = { ...previous.canon, ...patch, style: { ...previous.canon.style, ...patch.style }, storyFacts: { ...previous.canon.storyFacts, ...patch.storyFacts } };
      return write(id, expectedRevision, canon, previous.globals, 'update_canon');
    }),
    lock: (id, locked, reason) => repo.transaction(() => {
      const head = need(id);
      reason = parsed(z.string().trim().min(1).max(1000), reason);
      repo.canonHeads.lock(id, locked, reason);
      audit(id, head.revision, locked ? 'lock_canon' : 'unlock_canon', { reason });
      return view(id);
    }),
    invalidate: (id, n, { approveFrame, review }) => repo.transaction(() => {
      need(id); n = revisionNumber(n); revision(id, n);
      // Revision 1 is creation, with no preceding approvals to invalidate.
      const report = n === 1 ? { storyboardId: id, changes: [], shots: [] } : affected(id, { fromRevision: n - 1, toRevision: n });
      const changed = [];
      for (const { shotId } of report.shots) {
        const before = repo.shots.get(shotId).review;
        if (!before.frameApproved && before.status !== 'accepted') continue;
        if (before.frameApproved) approveFrame(shotId, false);
        if (before.status === 'accepted') review(shotId, { status: 'pending', notes: `Canon revision ${n} changed this shot; review its frame and clip again.` });
        changed.push({ shotId, before, after: repo.shots.get(shotId).review });
      }
      audit(id, n, 'invalidate_affected_approvals', { changed });
      return { ...report, revision: n, changed };
    }),
    snapshot: (id) => repo.transaction(() => {
      const head = need(id), record = revision(id, head.revision);
      const hashInput = canonicalJson({ canon: record.canon, referenceRevisions: record.referenceRevisions });
      const snapshot = repo.canonSnapshots.insert({ id: randomUUID(), storyboardId: id, revision: head.revision, hash: createHash('sha256').update(hashInput).digest('hex'), hashInput, canon: record.canon, referenceRevisions: record.referenceRevisions });
      audit(id, head.revision, 'canon_snapshot_for_job', { snapshotId: snapshot.id, hash: snapshot.hash });
      return snapshot;
    }),
    sync: (id, apply = false) => repo.transaction(() => {
      apply = parsed(z.boolean(), apply);
      const head = need(id), previous = revision(id, head.revision);
      if (apply) writable(head, head.revision);
      const fresh = globalsFor(id, previous.globals), canon = structuredClone(previous.canon);
      const sourceChanges = [];
      for (const cid of [...new Set([...Object.keys(previous.globals), ...Object.keys(fresh)])].sort()) {
        const old = previous.globals[cid], next = fresh[cid];
        if (!equal(old, next)) sourceChanges.push({ section: sectionFor(next ?? old), id: cid, before: old ?? null, after: next ?? null });
        if (old && (!next || old.kind !== next.kind)) canon[sectionFor(old)] = canon[sectionFor(old)].filter((c) => c.id !== cid);
        if (!next) continue;
        const list = canon[sectionFor(next)], current = list.find((c) => c.id === cid);
        if (!current) { list.push(entry(next)); continue; }
        // Sync the fields globals actually own, even if only the canon changed. Film-only rules stay intact.
        const nextEntry = entry(next);
        for (const key of ['name', 'description', 'designTags', 'referenceAssetIds', 'voice']) {
          if (key in nextEntry) current[key] = nextEntry[key];
        }
      }
      const changes = diffCanon(previous.canon, canon);
      const result = { storyboardId: id, revision: head.revision, changes, sourceChanges, applied: false };
      if (!apply || (!changes.length && !sourceChanges.length)) return result;
      const saved = write(id, head.revision, canon, fresh, 'canon_sync_from_globals', { sourceChanges });
      return { ...result, revision: saved.revision, applied: true };
    }),
  };
}
