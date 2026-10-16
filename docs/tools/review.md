# Visual review and bounded repair

These ten review workflows expose **11 MCP names**: workflow 9 has separate `accept_repair` and `reject_take` tools. Every tool has a title, schema, annotations and cost note. No visual model runs automatically: local ffmpeg measurements help a reviewer inspect the pictures, and explicit findings record the review.

| MCP tool | Input | Result / cost |
| --- | --- | --- |
| `get_review_bundle` | `shotId` | Approved character references; timestamped opening, middle and ending images; neighbouring cut images; recorded dialogue as MCP audio; declared `scene-state:<shotId>`; current-take findings. Free. |
| `compare_takes` | `shotId, takeA, takeB` (asset IDs) | One sheet, A left and B right, at identical timestamps within the shared duration; mean absolute RGB difference (0–255) per moment. Free. |
| `sample_frames` | `assetId`, either `times[]` or `count` (default 3, maximum 12) | Individually timestamped inline frames. Out-of-range times are rejected. Free. |
| `adjacent_shot_check` | `storyboardId` | Every cut, last/first images beside one another, colour and brightness jump scores (0–255). Missing/undecodable media remains unavailable. Free. |
| `record_finding` | `shotId, area, result, evidence, confidence, reviewer`, optional `takeId` | Persistent finding scoped to the reviewed take. Free. |
| `review_summary` | `storyboardId` | Each shot and each area: `passed`, `failed`, `unavailable` or `not reviewed`. Technical checks are separate. Free. |
| `propose_repair` | `shotId, findingId` | Specific changed frame prompt addressing the evidence, plus the existing budget route's estimate. Free; no job submission. |
| `execute_repair` | `shotId, plan`, optional `maxAttempts` (default 2) | Preserves originals and stages candidates. Provider generation can spend credits; trim is free. |
| `accept_repair` / `reject_take` | `shotId, takeId, reason` | Accept selects only after explicit review; reject records the reason without deleting or switching takes. Free. |
| `repair_history` | Exactly one of `shotId, storyboardId` | Attempts, original selections, plans, estimates, reconciled job results and decision reasons. Free. |

Areas are `identity`, `wardrobe`, `location`, `props`, `action`, `flicker`, `deformation`, `text`, `cross-shot`. Results are `passed`, `failed`, `uncertain`. Confidence is 0–1. Evidence is nonempty text (maximum 2,048 characters). A reviewer is either a name or `{ name, model, version }`; missing versions are recorded as `unspecified`. Supply actual model/version when a model performs review.

Findings default to the selected clip, or selected frame if there is no clip. Supply a candidate's `takeId` to review it before acceptance. A new take inherits no visual passes. A failed finding dominates passed findings for the same area and take; uncertain findings become `unavailable`. All findings remain in the journal. An area with no findings stays `not reviewed`; no automatic colour score fills in identity or wardrobe. Acceptance requires at least one finding on the candidate and refuses any failed/uncertain findings on it. This is deliberately conservative: a previously failed take must be replaced rather than made acceptable by appending an unrelated pass.

## Inline limits

All images are rendered on the CPU at review resolution. A response shares a **1 MiB encoded media cap**, with **120 KiB per image**, **256 KiB per audio**, at most **8 references**, the latest **50 findings** and **16 KiB of scene state** in a bundle. This keeps a bundle below 2 MiB, including its JSON manifest. Large or missing items are listed in `omitted`, never silently replaced with passing evidence. References are the locked character/location sheets in the shot's cast (or storyboard cast fallback). Unlocking a character makes its references unapproved for this purpose.

Shot and neighbouring cut timestamps respect trimStart and planned source duration, rather than unused source-clip tails.

For long boards, every cut retains its numeric measurement, while images beyond the shared cap are labelled omitted. Use `sample_frames` to inspect those clips separately. Large dialogue recordings are labelled omitted rather than downloaded in full just to exceed the cap. Media labels precede the corresponding MCP image/audio blocks; the first text block is a JSON manifest.

## Repair plans

Examples of the five accepted plan types:

```json
{ "type": "re-frame", "prompt": "Revised frame prompt correcting the evidenced wardrobe error.", "provider": "mock", "model": "mock-image" }
{ "type": "repair_frame", "box": [0.1, 0.2, 0.4, 0.6], "instruction": "Restore the approved red hat.", "provider": "mock", "model": "mock-tools" }
{ "type": "new_clip", "frameId": "<approved-frame-asset-id>", "prompt": "Keep the approved hat throughout the head turn." }
{ "type": "trim", "trimStart": 0.2, "duration": 3 }
{ "type": "re-record", "lineIndex": 0, "style": "Slower, calm and clear." }
```

Each may carry `findingId`. A `new_clip` requires the shot's currently approved frame; it never implicitly approves one. The estimate is recalculated from the normalized provider/model/operation through `/api/budget/estimate`, even if a caller changes a proposed plan. The normal budget gates remain authoritative at submission.

The execution journal reserves an attempt **before** submission. Hard cumulative limits are **2 per shot** and **10 per storyboard/film**, including attempts before a film was created, failed jobs and budget refusals. A film policy can lower these limits, but cannot raise them. Concurrent MCP clients share the same durable counters. Opening a film or restarting the app does not reset them.

Execution stops on the first completed candidate (`needs_review`), queued/running work (`pending_attempt`), a hard limit (`shot_limit` / `film_limit`), or a budget refusal (`budget_refused`, with HTTP 402 details). It retries only terminal failed jobs within the requested and cumulative limits. A request/transport error stops the call rather than risking duplicate paid submission. A reservation whose job response was lost remains reserved; no automatic retry guesses whether it spent money. Existing budget approval mechanisms still apply; this module never approves spending or raises a budget.

Frames use the existing unselected repair target. Clip and audio generations use separate candidate targets so completion cannot replace a selected take. History reconciles their state directly from saved generation records. Successful candidates are available to `sample_frames` / `compare_takes` by their asset ID; generated frame candidates also appear in `list_shot_takes`. Clip candidates enter that list when explicitly accepted through the existing attach/select routes.

Trim is a staged edit with a `trim:<attempt-id>` take ID; the original file is retained, and duration/trimStart change only on acceptance. Record a finding against this ID after reviewing the intended interval. Audio is staged as a new recording and adopted only after explicit acceptance; the attempt retains the original line. There is no existing API for adopting an already generated dialogue asset, so that one attachment updates the shot's dialogue record in the review service; it does not re-submit speech. Word changes between recording and adoption are refused. No clip is selected automatically. Frames still require normal frame approval before animation.

Findings and repairs use `film_events` kinds `finding` and `repair` when a film exists, otherwise append to settings `visual-review:<storyboardId>`. Reads combine pre-film and film records. Technical QC exports and the existing `passed` / `failed` / `unavailable` contract are unchanged.

## Labelled check evaluation

`evaluateCheck(labels, results)` is exported from `src/review.js`. Pass equal-length arrays of `passed` / `failed` human labels and automatic results. Automatic `unavailable`, `uncertain`, null and undefined results are counted as abstentions and excluded from the rate denominators. Objects with `status` or `result` also work.

A defect (`failed`) is positive. False-positive rate is FP / (FP + TN); false-negative rate is FN / (FN + TP). The result includes all four confusion counts, `evaluated`, `unavailable`, and both rates. A missing denominator yields `null`, not a misleading zero. This helper does not claim any visual check has been validated without human labels.

## Verification

Offline mock providers and tiny synthetic lavfi clips exercise these tools through a real MCP stdio client. Run only:

```sh
timeout 180 node --test tests/review-tools.test.js tests/mcp.test.js tests/qc-status.test.js tests/takes.test.js
```

Limitations: sampled frames can miss brief defects; RGB differences and cut jumps do not verify identity, deformation, text or narrative continuity; reviewer judgements are recorded without independent semantic verification. The limits govern repairs submitted by this module, not direct generation calls or other producers. Full-resolution media and long audio can require separate inspection. No GPU, paid vision model, network service, dependency, database migration or automatic spending approval is needed.
