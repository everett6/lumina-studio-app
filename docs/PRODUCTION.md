# Persistent film production

`createProductionController({ repo, sequences, generations, log, now })` in
`src/production.js` orchestrates the existing sequence service. Construct it over
the application's repository and sequence service; no controller state is stored
in an MCP connection. `now` is an optional clock returning milliseconds, a Date,
or an ISO date string. No API, MCP, app lifecycle, runner or provider wiring is
included in this change.

## API

```js
const production = createProductionController({ repo, sequences, generations });
const film = production.open(sequenceId, {
  brief: { targetSeconds: 60, acceptanceCriteria: ['The ending resolves the conflict'] },
  policy: {},
});
const owner = 'desktop:unique-session-id';
if (production.acquire(film.id, owner, 120_000)) {
  try {
    const { filmRevision } = production.status(film.id);
    await production.step(film.id, { owner, expectedRevision: filmRevision });
  } finally {
    production.release(film.id, owner);
  }
}
```

- `open(sequenceId, { brief, policy })` returns the existing film when called
  again for that sequence; it does not overwrite its brief or policy.
- `status(filmId)` returns only `state`, `filmRevision`, `stage`, `reason`,
  `blockingFindings`, `allowedActions`, `requiresUserAction`, `retryable`, and
  unique `jobIds`. It is read-only. `retryable` describes advancing/reconciling
  the controller, **not permission to repeat a generation**.
- `acquire(filmId, owner, ttlMs = 30000)` and `release(filmId, owner)` return
  booleans. Owners must be nonempty strings; TTLs must be positive integers.
- `step(filmId, { owner, expectedRevision })` returns the compact status. Missing
  leases, expired leases and stale revisions throw errors with `status: 409`
  and `code: 'conflict'`. A stage can require multiple calls, including calls
  that only wait for jobs. A call crosses at most one stage boundary.
- `resume(filmId, owner)` acquires/renews a 30-second lease, reconciles the
  journal and generation table, then performs one `step`. Call it again on the
  next host tick. It does not start an unbounded background producer.
- `pause(filmId, reason)` records an explicit manual pause.
  `unpause(filmId)` records an explicit resume. Neither cancels jobs nor erases
  approvals, findings or takes. Manual pauses stay paused across `resume`.
  Unpausing does not bypass billing or finding gates.

The brief and policy are JSON objects. `brief.shots` optionally contains a plan
accepted by `sequences.importPlan`; otherwise import a plan before advancing.
`brief.targetSeconds` is the desired runtime. `policy.runtimeToleranceSeconds`
defaults to one second. Actual duration is persisted in the join checkpoint and
used after restart; planned shot lengths are never substituted for a missing
measurement. A recovered output without measured metadata pauses runtime
validation until metadata is supplied. Acceptance criteria remain human decisions;
`policy.acceptanceCriteriaApproved: true` explicitly acknowledges them.
`policy.autoApproveFrames` and `policy.autoAcceptClips` default to false. Setting
these to true authorizes the corresponding existing sequence-service approval
functions. Automatic clip acceptance never overrides blocking checks. Warnings
remain visible in the journal; technical checks do not establish artistic quality.

## State machine

```text
plan -> frames -> approve-frames -> clips -> review -> voices -> join -> deliver
                                                                          |
                                                                      delivered
Any unfinished stage -> paused -> the saved stage after explicit unpause
```

`films.state` contains the current stage, `paused`, or `delivered`. Checkpoints
retain the stage while paused. Planning adopts an existing shot list or imports
`brief.shots`. It never replaces a populated storyboard. Frames and clips use
`generateFrame` and `animate`, with a stable key for each film/stage/shot. Plan
imports run in a SQLite transaction so a partial shot list cannot be mistaken for
completed planning. Still
clips use `renderStillShot`. Recording uses `makeDialogue`; completed recordings
are skipped. Reviews use `runChecks`, `approveFrame` and `review`. Joining uses
`stitch({ wait: true })`, and delivery records the selected output once.
The legacy `produce` function is deliberately not called: its in-memory producer
would advance independently of the lease and journal.

The controller pauses for missing resources, a failed/interrupted job needing an
explicit decision, uncertain billing, a submitted generation without its result,
unresolved blocking findings, approval gates, and unsupported operations. It does
not select a substitute model or voice, relax criteria, delete assets, regenerate
completed takes, retry a provider POST, or perform autonomous repairs. The host
can restore a resource, select an existing take, approve a frame/clip, or make an
explicit permitted retry/repair through existing services and then reconcile.
The job runner remains responsible for polling/downloading the **same** remote job.

## Tables and repository access

One migration is appended to the existing migrations array:

| Table | Columns and purpose |
| --- | --- |
| `films` | `id`, unique `sequence_id`, JSON `brief`, JSON `policy`, integer `revision`, `state`, `pause_reason`, `lease_owner`, `lease_expires_at`, `created_at`, `updated_at` |
| `film_events` | Monotonic integer `id`, `film_id`, `revision`, `at`, `kind`, JSON `data` |

Event kinds are `checkpoint`, `approval`, `job`, `finding`, `repair`, `delivery`,
`pause`, `resume`, and `edit`. SQLite triggers reject UPDATE and DELETE of events.
Foreign keys restrict deletion of films and their storyboards while the audit
trail exists. No old migration or existing data is rewritten by this migration.

`repo.films` exposes `get`, `bySequence`, `open`, `acquire`, `release`, `commit`,
and `edit`; `repo.filmEvents.list(filmId)` returns events in insertion order.
`commit(id, { expectedRevision, owner?, at?, state?, pauseReason?, brief?, policy? }, events)`
conditionally changes the film, increments its revision, and appends events in
one SQLite transaction. A mismatch returns null. Supplying `owner` also checks
that its lease is still live. This low-level method is for trusted host code;
clients should use the controller. Events have `{ kind, data }` form.

`repo.films.edit(id, { expectedRevision, brief?, policy?, at? })` records an edit
and returns the film to `plan`, preserving all assets and prior events. Brief and
policy values replace the complete JSON object when supplied. API/MCP adapters
must check the null conflict result. Lease renewals do not change the revision;
checkpoints, observations, pauses, resumes and edits do. Re-read the revision
before each step.

External findings can be appended through `commit` with data such as
`{ id, blocking: true, resolved: false, detail }`. Resolve one by appending another
finding with the same ID and `resolved: true`. External repair operations should
append `repair` events with the shot, input asset, attempt, instruction, job ID and
outcome; the controller never infers authorization to repair from a failed check.

## Lease and recovery

A lease is a single conditional UPDATE of `films`, not a read followed by a write.
Only an absent, expired or same-owner lease can be acquired. Release checks the
owner. Every controller transition also compares the revision and live owner.
Use distinct owner IDs per client session. Renew with `acquire` during long
operations, or choose a sufficient TTL before calling `step`. An expired worker
cannot commit a later stage, even if its local render completes successfully.

Before calling a service capable of producing work, the controller commits an
action intent. Generation creation and its shot target already commit before the
runner can dispatch. Recovery reads every journaled job ID **and** scans all
current shot/image/video/dialogue targets, so a dropped response between submit
and journal append cannot lose a job. Each job observation records its ID,
provider/model, target, idempotency key, billing state and full provider submission
metadata (including any accumulated provider request IDs). Updated observations
are appended rather than replacing history.

Queued and running generations are adopted and awaited. Completed outputs fill
only missing selected slots, using `onGenerationUpdate`. Already attached takes
are never replayed through that callback: frame callbacks revoke approval, and
clip callbacks reset reviews. Approvals and check findings are mirrored from
persisted shots into events, including revocations/resolutions, without erasing
prior decisions. A missing generation or completed output pauses instead of
buying a replacement. A submitted or billing-unknown generation is never retried
by the controller. `billing_pending` pauses clear automatically after reconciliation
establishes a finished, nonambiguous result; other pauses require explicit action.

Frame and clip idempotency keys remain stable across controller restarts and
brief edits. Dialogue submission is currently synchronous and writes durable
line targets; recovery fills missing slots before calling `makeDialogue` again.
This is essential because `makeDialogue` does not yet accept idempotency keys.
Adoption checks the requested speaker's voice provider, model, voice and acting
style as well as the words. If a completed recording differs, the controller
pauses for explicit selection or re-recording instead of restoring an invalidated
take or silently buying another. A completed unselected still take similarly
requires selection rather than another render.
An unfinished local operation with no output is treated conservatively while its
executor may still be alive. Intents record the executor PID and a process token;
same-process live actions are tracked until they return, and other PIDs are
checked for liveness without sending a signal. Confirmed dead executors permit
unfinished local joins/still renders to restart using the retained inputs.
Unknown/PID-reused executors conservatively pause. This assumes one local PID
namespace, matching the app's local SQLite deployment. A returned service error
also proves that invocation stopped and permits an explicit retry.

## Integration hooks and limits

- Wire host scheduling and startup to `resume` and normal ticks to `step`. Keep
  the existing job runner startup recovery and generation completion callbacks.
  Route sequence edits through `repo.films.edit` as part of the edit operation so
  controllers see conflicts. Direct changes through today's sequence APIs do not
  automatically increment a film revision.
- The writer planner calls a provider directly, outside the generation ledger.
  Durable paid planning needs a persisted planner job/result and idempotency key
  before `sequences.plan` can safely be used here. Until then import a shot plan.
- Chain continuity extracts the preceding clip's last frame inside legacy
  `advance`. Expose that as an independently recoverable sequence-service method
  before enabling chain production here. Frame/keyframe modes already use the
  existing public methods.
- A per-line idempotency override on `makeDialogue`/`queueLine` would strengthen
  the recording contract if those methods ever become asynchronous.
- For immediate audit visibility, notify/reconcile the controller when jobs or
  provider submission metadata change and when approvals/repairs are made.
  Without that hook, events reflect durable job metadata on the next tick or
  resume. The original generation row is the source of truth during disconnects.
- Joining and still rendering use existing local tools; absent ffmpeg or required
  enhancers pause the film. There is no GPU requirement for the controller. Tests
  use mock providers and CPU ffmpeg, with offline mode and an empty GPU model cache.
- No integration is installed in `app.js`, API or MCP. Existing callers that bypass
  the controller do not honor its lease; do not run a legacy producer concurrently.

## Verification

Run `timeout 180 node --test tests/production.test.js`. Coverage includes restart
at every stage, actual app/database reopen, lost frame/dialogue responses,
submitted and queued job adoption, unknown billing, missing outputs, approval
persistence, blocking findings, competing SQLite connections, stale revisions,
lease expiry during join, and edits during checks. Also run each existing test
file importing `db.js` or `repo.js` under its own timeout. Do not run the full
suite for this change.
