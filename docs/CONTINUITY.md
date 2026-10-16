# Film plan validators

These standalone ESM modules perform no I/O, mutate no inputs, use no randomness,
and do not integrate with the application. They validate declarations, not generated
pictures or inferred story meaning. Supply shots in edit order; `position` is a label
and never changes the supplied order.

## API

- `cleanSceneState(input = {}) -> SceneState`
- `validateContinuity(shots = [], canon = {}) -> Finding[]`
- `buildTimeline(shots = [], { fps = 24, transition = 'cut', crossfadeSeconds = 0.5 } = {}) -> Timeline`
- `validateTimeline(timeline, { targetSeconds, toleranceSeconds = 0 } = {}) -> Finding[]`

Every finding has `{ id, severity, kind, shotId, previousShotId, rule, message,
evidence }`. IDs are deterministic and unique within one result. They identify a
finding in that plan revision, not across edits. Severity is `blocking` or `warning`;
kind is `deterministic` or `needs-review`. Film-level findings use null shot IDs.
Evidence contains the involved character, prop, fact, phase/boundary or line index
as appropriate. Line and event indices are zero based. No warning represents a
visual or artistic pass. Continuity emits a `review-scope` warning for each shot,
with `evidence.checked` and `evidence.notCheckable`, even for a clean plan.

## Scene state

A shot is `{ id, position, start, end, dialogue, action, events?, transitions?,
exceptions? }`. `start` and `end` each use this schema:

```js
{
  characters: [{
    id: 'hero',
    position: 'left',           // left | center | right | offscreen
    facing: 'right',            // left | right | camera | away
    wardrobe: 'red-jacket',     // variant ID, not a prose description
    props: { held: ['sword'], worn: ['ring'] },
    injuries: ['left-arm-cut'],
    knows: ['gate-password']    // fact IDs
  }],
  location: 'bridge',           // locationId is accepted as an input alias
  timeOfDay: 'dusk',            // dawn | day | dusk | night
  events: [],
  transitions: []              // exceptions is accepted and merged into this list
}
```

The cleaner trims IDs, removes empty/non-string/duplicate entries in ID lists,
selects known fields, and returns fresh nested arrays and objects. Missing lists
normalize to empty lists, missing or invalid scalar values to null. It does not
invent wardrobe, position, location, or time defaults. Supply complete endpoints;
missing required fields generate review warnings. The normalizer preserves
character duplicates for validation rather than silently removing them.
The validator also retains raw-field availability internally: omitted cast/prop
lists cannot prove a disappearance, and omitted injury lists cannot prove healing.
Use explicit empty lists to declare that no characters, props, or injuries remain.
Pass raw endpoints to validation so missing-field information is still available.

Transitions and events have string fields `{ type, id?, who?, what?, to?, reason? }`;
missing fields normalize to null. Unknown types remain available for human review
but do not waive rules. An exception needs a nonempty `reason` and must match the
specific character/prop/destination involved:

| Type | Matching fields | Meaning |
| --- | --- | --- |
| `character-enter`, `character-exit` | `who` | Deliberate entrance or exit |
| `wardrobe-change` | `who`, `what` = new variant ID | Intentional costume change |
| `location-change` | `what` = destination location ID | Intentional new location |
| `time-skip` | `what` = destination timeOfDay | Intentional time change |
| `prop-transfer` | `who` = old holder, `what` = prop ID, optional `to` = new holder | Declared transfer |
| `prop-appears`, `prop-lost` | `who`, `what` = prop ID | Acquisition or removal |
| `injury` | `who`, `what` = injury ID | New injury with a cause |
| `injury-healed` | `who`, `what` = injury ID | Explicit healing |
| `crossing` | `who` | Declared screen-axis crossing |

`start.transitions` explains the incoming cut; `end.transitions` explains changes
within that shot. Shot-level `transitions`/`exceptions` applies to both. A previous
shot's end declarations are not reused for the next cut. Characters leaving with
props need explicit removal declarations or should stay in state as `offscreen`.
Props have unique object IDs; use distinct IDs for two otherwise identical swords.
Held-to-worn movement by the same owner needs no transfer.

Knowledge events are `{ type: 'learn' | 'use', who, what }`. Initial start-state
knowledge is a premise. Process start events in array order, dialogue `uses` fact
IDs, shot-level action events, then end events in array order. A learn updates
knowledge immediately; snapshot knowledge additions require that learning to have
already happened. Knowledge and injuries remain tracked while a character is absent.
Use shot events to specify the exact ordering of interleaved learning and use;
free-text `action` and dialogue are never parsed to infer facts. Dialogue may
include `uses: ['fact-id']` for facts used at the dialogue phase.

Dialogue speakers must occur in either endpoint, including characters whose
position is `offscreen`. Explicit `offscreen: true`, `voiceOver: true`, or
`delivery: 'offscreen' | 'voice-over'` also declares an allowed absent speaker.
The existing `speaker: 'narrator'` convention implies voice-over. Application-shaped
`details.dialogue` is accepted when top-level dialogue is absent.

Canon declares obligations as `{ setups: [{ setup: 'plant-id', payoff: 'reveal-id' }] }`.
`payoff` may also be an array of required IDs. IDs refer to shot IDs or structured
event IDs. Both setup and every payoff must occur, and payoffs must not precede
the setup, including within a shot's ordered event sequence. A repeated payoff
after its setup satisfies the obligation even if it also occurred earlier. This
checks declared coverage and ordering, not dramatic effectiveness.

## Continuity rules

| Finding rule | Kind / severity | Check |
| --- | --- | --- |
| `character-presence` | deterministic / blocking | End-to-start and within-shot character entrance/exit must be intentional |
| `duplicate-character` | deterministic / blocking | Character IDs must be unique at an endpoint |
| `wardrobe-change` | deterministic / blocking | Wardrobe changes need matching declarations |
| `location-change` | deterministic / blocking | Location changes need matching declarations |
| `time-change` | deterministic / blocking | Time-of-day changes need a time skip |
| `prop-duplicate` | deterministic / blocking | A unique prop occupies one holder/slot at an endpoint |
| `prop-transfer` | deterministic / blocking | Changes of owner need a declared transfer |
| `prop-appears`, `prop-lost` | deterministic / blocking | Prop additions/removals need declarations |
| `speaker-presence` | deterministic / blocking with complete cast; otherwise needs-review / warning | Speaker must be present or explicitly offscreen/voice-over |
| `injury-change` | deterministic / blocking | New injury requires a declared cause |
| `injury-persistence` | deterministic / blocking | Prior injuries remain until declared healed, including after an absence |
| `knowledge-before-use` | deterministic / blocking | Structured fact use must follow learning |
| `knowledge-change` | deterministic / blocking | A later snapshot cannot invent knowledge |
| `setup-payoff` | deterministic / blocking | Canon setup and required subsequent payoffs must exist |
| `screen-direction` | needs-review / warning | Left/right position or facing flips across cuts without declared crossing |
| `incomplete-state` | needs-review / warning | Missing/invalid required endpoint data limits validation |
| `incomplete-event` | needs-review / warning | Knowledge event lacks character or fact ID |
| `incomplete-setup` | needs-review / warning | Canon obligation lacks setup/payoff IDs |
| `review-scope` | needs-review / warning | Lists checked rules and uncheckable judgements |

Eyelines, visual character/wardrobe identity, physical plausibility, facts implied
by prose, and dramatic setup/payoff quality always require review. Agreement of
structured declarations does not prove agreement of rendered media. Arbitrary
mid-shot movement and event details not represented by the endpoints are also
outside these deterministic checks.

## Timeline data and frame convention

Input uses existing shot fields: `{ id, position, duration, videoAssetId,
imageAssetId, review: { status }, details: { method, trimStart, holds, dialogue } }`.
`method` defaults to `video` as in `cleanShotDetails`; `still` intentionally allows
a frame or a rendered video asset. Add `clipSeconds` with the measured selected
source duration (before trim). An optional `clip: { assetId, seconds, status }`
is also accepted. Pure code cannot probe media, verify an asset ID exists, or
choose among takes. The integration worker must supply selected asset metadata
and remove stale IDs or mark deleted assets `missing`.

Slots are rounded once with `Math.round(duration * fps)`. Frame ranges are
`[startFrame, endFrame)` with integer frames. Cut slots abut. Crossfades round the
overlap once and subtract it at every boundary: two five-second slots with a
half-second dissolve total 9.5 seconds. This is this planning API's overlap
contract; integration must explicitly map renderer handles to these slot lengths.
Invalid fps/transition/overlap or unsafe frame counts throw; overlaps that exhaust
a slot or create triple overlaps throw rather than silently becoming cuts.
Missing/invalid slot durations remain as zero-frame entries and block validation.
An empty plan has zero frames.

`Timeline` contains `fps`, `transition`, `crossfadeFrames`, `shots`, `totalFrames`,
`totalSeconds`, `generatedMotionFrames/Seconds`, and `intentionalStillFrames/Seconds`.
Motion/still totals classify the planned source slots by `details.method`, including
missing-media demand. They are before overlap subtraction, so their sum can exceed
film runtime. They report planned video/still allocation, not a visual motion
measurement or provider billing estimate.

Each shot entry includes `shotId`, `previousShotId`, `position`, `startFrame`,
`endFrame`, `durationFrames`, `durationSeconds`, `requestedSeconds`, `method`,
`overlapInFrames`, `overlapOutFrames`, media availability/IDs/statuses, `clipSeconds`,
`trimStartSeconds`, `availableFrames`, normalized frame `holds`, and `dialogue`.
Every planned shot retains a slot, regardless of its media status. Missing assets
and `missing`, `failed`, `rejected`, `needs_regeneration`, `interrupted`, `queued`,
or `running` selected media block validation; pending/accepted review states do
not alone indicate missing media.

Dialogue follows `soundtrack.lineTimes`: finite explicit `start`, otherwise 0.4
seconds for the first line and previous end plus 0.25 seconds thereafter. Measured
`seconds` and recording `assetId` are separate requirements. Missing lengths are
never replaced by word-count estimates; later implicit starts become uncertain
until an explicit start resets the cursor. Dialogue entries contain line index,
speaker/text/asset, recording status, relative start/end seconds, absolute start/end
frames, `timingKnown`, and nullable `fits`. Start frames round to nearest; end frames
round outward to contain the audio. Fit compares measured seconds against the
frame-quantized slot; an unknown duration/timing has `fits: null`. Crossfaded dialogue
starts at its shot's overlapped timeline start.

Holds use existing `{ start, seconds }` in seconds after trim. As in
`exposureFilter`, they freeze existing time slots and do not add runtime. Frozen
padding greater than one frame requires the union of declared holds to cover the
entire shortfall at the tail; an unrelated early hold does not authorize padding.
Anime twos/threes alone does not declare a tail hold.
Measured available clip time rounds down to complete frames, so fractional
shortfalls greater than one frame cannot be hidden by rounding to nearest.

## Timeline rules

| Finding rule | Kind / severity | Check |
| --- | --- | --- |
| `runtime` | deterministic / blocking | Total runtime outside inclusive target ± tolerance, when target is supplied |
| `shot-duration` | deterministic / blocking | Duration missing, invalid, or rounding to zero frames |
| `shot-method` | deterministic / blocking | Method other than video/still |
| `missing-media` | deterministic / blocking | Selected media missing, failed, rejected, or otherwise unavailable; slot retained |
| `dialogue-recording` | deterministic / blocking | Nonempty dialogue lacks a usable recording ID |
| `dialogue-start` | deterministic / blocking | Dialogue starts before its slot |
| `dialogue-overrun` | deterministic / blocking | Known line ends after its slot |
| `frozen-padding` | deterministic / blocking | Trimmed video short by more than one frame without covering hold declarations |
| `clip-duration` | needs-review / warning | Measured clip duration unavailable |
| `dialogue-duration` | needs-review / warning | Measured audio duration or preceding timing unavailable |

`validateTimeline` validates a ledger returned by `buildTimeline`; it is not a
schema validator for hand-edited ledgers. Negative/nonfinite runtime targets or
tolerances throw. Frame/recording IDs are declarations of availability; filesystem
existence and actual measured durations belong to the later integration layer.

## Verification

Run only:

```sh
timeout 120 node --test tests/continuity.test.js tests/timeline.test.js
```

The continuity file preserves its existing integration tests and adds pure
contradiction fixtures. New cases include the vanishing sword, unexplained jacket,
dusk-to-day jump, absent speaker, early knowledge use, unpaid setup, cross-cut
screen direction, duplication/transfer, injury persistence, and a clean declared
plan. Timeline fixtures cover 112 seconds versus 120 ± 3, missing/failed/rejected
slots, long/unrecorded lines, exact crossfade frames, trim/hold coverage, unknown
measurements, inclusive tolerance, repeatability, and input immutability.
