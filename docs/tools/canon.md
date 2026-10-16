# Film canon

A storyboard has one film bible, independently of whether it has a film controller. Creation copies the global characters, locations and products referenced by the storyboard cast, shot details or declared scene states, plus the storyboard look and look bible. Unrelated globals are excluded. Subsequent global edits never alter saved canon.

All ten tools are free and local: no model calls, GPU work or credits.

| Tool | Inputs beyond `storyboardId` | Result |
| --- | --- | --- |
| `create_film_canon` | None | Creates revision 1; an existing canon returns 409. |
| `get_film_canon` | Optional `revision` | Current or historical document, frozen reference revisions, current revision and lock. |
| `update_canon` | `expectedRevision`, `patch` | New immutable revision; locked or stale writes return 409. |
| `lock_canon` | Nonblank `reason` | Blocks updates and applied sync; records the reason. |
| `unlock_canon` | Nonblank `reason` | Allows explicit revisions; records the reason. |
| `canon_diff` | `fromRevision`, `toRevision` | Entity changes with fields and before/after, plus style/story changes. |
| `canon_affected_shots` | Either `change` or both revision numbers | Matching shot IDs, positions and reasons. |
| `invalidate_affected_approvals` | `revision` | Explicit resets for changes from revision − 1; before/after reviews. |
| `canon_snapshot_for_job` | None | Stored immutable snapshot ID, SHA-256 hash, canonical hash input, content and references. |
| `canon_sync_from_globals` | `apply` (default false) | Canon/global diff and source-baseline diff; explicit application creates a revision. |

Every tool has a title, description, Zod input schema and metadata flags/cost note. Storyboard IDs are UUIDs; revisions are positive integers. Lock reasons are trimmed, nonempty strings of at most 1,000 characters.

## Document and patch schema

```js
{
  characters: [{
    id, name, description, designTags,
    identity, proportions, hair, eyes,
    distinguishingFeatures: ["left cheek scar"],
    referenceAssetIds: [assetId],
    approvedReferenceAssetIds: [assetId],
    wardrobeVariants: [{ id: "kimono", description: "Blue silk", allowedWhen: ["duel"] }],
    voice: { provider, model, voice } // or null; voice string may be null
  }],
  locations: [{
    id, name, description, designTags, layout,
    landmarks: ["east tower"], lightingRules: ["sun from the river"],
    referenceAssetIds: [assetId], approvedReferenceAssetIds: [assetId]
  }],
  props: [{ id, name, owner: characterId, description, referenceAssetIds: [assetId] }],
  style: { look: "anime", palette: ["indigo", "gold"], description: "Look bible", referenceArt: [assetId] },
  storyFacts: {
    relationships: ["Aiko protects Ren"], motivations: ["return home"],
    prohibitedContradictions: ["Aiko cannot swim"],
    setupPayoffs: [{ setup: "notched blade", payoff: "blade breaks" }]
  }
}
```

The persisted document requires all five top-level sections. Entity `id` values are nonempty strings, unique within each collection; wardrobe IDs are unique within a character. Characters and locations require `id` and `name`; their remaining fields are optional. Props require `id`, `owner` (nullable) and `description`. A supplied wardrobe variant requires all three shown fields. Style and story-fact fields are required in a complete document.

A patch may contain any subset of the five sections. Arrays replace in full; `style` and `storyFacts` merge supplied fields with their prior objects. Unknown fields, duplicate entity/wardrobe IDs and invalid types are rejected. Strings are bounded to 4,000 characters, IDs to 200 characters, entity and text arrays to 200 entries, and wardrobe variants to 100 entries. API patch bodies are limited to 512 KiB. Include the entire entity array when editing one character. An explicit update creates a revision even if the content is unchanged.

The current global description/design tags are copied without inferring structured anatomy, wardrobe or layout rules. Those fields start empty and must be authored explicitly. Existing global reference IDs seed both reference lists; this copies the current declared references rather than verifying their contents or approval history.

## Revisions, locking and audit

One appended SQLite migration adds:

- `film_canons`: mutable storyboard head, content revision and lock/reason.
- `canon_revisions`: immutable documents, source-global baselines and frozen reference revisions, keyed by storyboard/revision.
- `canon_events`: append-only audit of creation, edits, locks, unlocks, sync, snapshots and approval resets.
- `canon_snapshots`: immutable job snapshot ID, revision, hash and payload.

SQLite transactions and conditional revision updates permit only one writer at a supplied `expectedRevision`. Locks do not change the content revision. Historical reads show the requested document and the **current** lock state. Triggers refuse updates and direct deletion of revision, snapshot and audit rows; deleting their storyboard cascades its canon data. If a film controller exists, each action is also appended to `film_events`, using `edit` or `approval` with `source: "canon"` and the canon revision. No controller is implicitly created.

## Affected shots and approvals

A `change` has `section` equal to `characters`, `locations`, `props`, `wardrobe`, `style` or `storyFacts`. Entity changes require `id`; wardrobe additionally requires `characterId`, with `id` identifying the variant.

Matching reads `shot.details.characterIds`, `shot.details.locationId` and settings key `scene-state:<shotId>`. Both scene-state `start` and `end` contribute character IDs, `location`, character `wardrobe`, and `props.held`/`props.worn`. A revision that only changes wardrobe variants targets the changed variants of that character. Other character changes match the character’s declared appearances. Style and story facts conservatively affect every shot.

Invalidation compares the supplied revision with its immediate predecessor. Revision 1 has no predecessor and resets nothing. Only existing frame approvals and accepted clip decisions are reset, using the existing `sequences.approveFrame(shotId, false)` and `sequences.review(shotId, {status: "pending", ...})` functions through the canon API route. Resets and audit entries commit in one transaction. The response lists every changed shot’s before/after review. Repeating the call without new approvals changes nothing. Media and unrelated approvals are retained. Neither update nor sync silently invalidates approvals.

## Global sync and job snapshots

`canon_sync_from_globals` defaults to a preview. `changes` compares canon with the result of copying live shared global fields (`name`, `description`, `designTags`, `referenceAssetIds`, and character `voice`); `sourceChanges` separately compares the captured global baseline to live globals. Thus film-local edits to shared fields appear even when the source has not changed. `apply=true` explicitly aligns those fields, adds newly referenced globals, removes deleted tracked globals, and handles global kind changes. Film-only identity/anatomy, location rules, wardrobe, approved reference lists, style and story facts are retained. No source/content differences means no new revision. Preview and apply each compute against current records; apply does not reserve a preview. Applying while locked returns 409, even if nothing changed.

Each revision freezes source-record hashes and records, plus referenced asset metadata and hashes. Global records have no numeric revision, so their normalized content hash is their reference revision. Missing referenced assets are recorded as null rather than silently substituted. A job snapshot copies the saved canon and its reference revisions, never current live globals. Its hash is SHA-256 of the stable JSON `hashInput` containing `{canon, referenceRevisions}` with recursively sorted object keys. Arrays keep their order. Repeated calls produce distinct snapshot IDs and the same hash for the same saved content. Store the returned ID and hash with the job; this extension does not alter job creation or generation schemas.

## API and limitations

Base path: `/api/storyboards/:storyboardId/canon`.

- `POST` creates, `GET ?revision=N` reads, `PATCH` revises.
- `POST /lock`, `/unlock`, `/affected-shots`, `/invalidate-approvals`, `/snapshots`, `/sync` perform the corresponding operations.
- `GET /diff?fromRevision=N&toRevision=M` compares revisions.

This is a declared film bible, not visual or semantic validation. Undeclared props/wardrobe cannot be inferred from prompts or pictures. Reference hashes cover frozen records/asset metadata, not media bytes, and do not prevent deletion of the underlying assets. The canon and snapshot are not automatically injected into generation prompts or attached to jobs; callers record their snapshot ID/hash. Invalidating an old revision explicitly rechecks its affected shots and can reset newer approvals for those shots. Snapshots survive canon edits but are removed with their storyboard.

## Verification

`tests/canon-tools.test.js` uses the same stdio MCP client and temporary mock app setup as the film tests, with offline providers. Coverage includes seeding, all ten schemas, revision history, stale and concurrent writes, locks/audit, diffs, character/location/prop/wardrobe matches, real approved mock-frame invalidation, preserving unrelated approvals, immutable stored snapshots/reference revisions, global drift/explicit sync, malformed input and storyboard deletion.

Run only:

```sh
timeout 180 node --test tests/canon-tools.test.js tests/mcp.test.js tests/production.test.js
```
