# Lumina overnight production polish

Requested by Everett on October 12, 2026 (Pacific time). Work window: roughly 11:08 pm–7:08 am Pacific. First Sonnet review launch: about 11:38 pm Pacific, 30 minutes after the request. The app heartbeat is scheduled every 30 minutes for this eight-hour window.

## Scope and boundaries

Ship a reliable anime production pipeline using OpenRouter cloud clips and local Wan 2.2, local voices, accurate per-shot interpolation, soundtrack assembly, and upscaling of the completed film. Expand MCP's ability to inspect state and make informed decisions. Skip lip sync. Preserve user projects, credentials, provider hard caps, and prior spending. No top-ups, cap increases, spending resets, or blind billed retries. Stop review workers when finished; system power-off is not assumed.

Baseline: v0.9.0, commit 392ddda. 78 tests passed; two skipped. Real RTX 5070 pilot verified Kokoro, Animagine, low-step Wan, RIFE, anime upscaling, and 1080p/30 fps audio/video output. A full-quality mixed cloud/Wan film and signed-in ChatGPT web session are not yet verified.

## Work schedule

| Window | Work | Evidence required |
| --- | --- | --- |
| Now–30 min | Implement read-only OpenRouter key allowance/usage status and expose it to MCP. Identify post-production ordering and job recovery gaps. | No secrets in responses/logs; missing/unauthorized/stale balances are explicit. |
| At 30 min | Launch three Claude Code Sonnet 5.5 custom reviewers with `node scripts/run-sonnet-night-reviews.mjs`. | Exact model, no silent fallback; role/PID/log manifest; no duplicate reviewers. |
| 30 min–2 h | Credit-aware cloud decisions, atomic reservations, uncertain-billing recovery, practical MCP progress and review tools. | Concurrent/retry/low-credit tests; effective allowance uses provider remaining limit and Lumina ledger conservatively. |
| 2–4 h | Normalize mixed cloud/Wan shots and preserve timing. Assemble and mix at source/master size, then upscale the completed film and encode once for delivery. | Mixed dimensions/frame rates/clip audio/voice tests; exact timeline and final output inspection. |
| 4–6 h | Interpolation and anime continuity review using real Wan footage, local voices and legally available references. Repair measurable defects. | Original/interpolated frame comparisons, cut protection, audio sync, preserved source anchors, drift notes; retain originals on QC failure. |
| 6–7 h | Integrate Sonnet findings; regression, restart and error-injection checks; inspect app/MCP behavior. | Required suites pass, no critical unresolved findings; explicit skipped or inaccessible checks. |
| 7–8 h | README and Claude Code log, release build and smoke test, verified GitHub push; stop workers and heartbeat. | Commit/release identity, checksums, run instructions, remaining limitations. |

Do not spend time merely to fill the window: finish early if acceptance checks pass. If a blocking condition persists, record it and continue independent work. No claim of “zero bugs,” “zero drift,” or ground-truth interpolation accuracy without evidence.

## Three Sonnet reviewers

1. **Credits/MCP:** OpenRouter key remaining limit, usage, account-credit permissions, stale snapshots, concurrent reservations, auth boundaries, idempotency and unknown-billing recovery.
2. **Mixed production/audio:** cloud/local shot ordering, duration and frame-rate normalization, restart behavior, sound placement, clipping/ducking, final-film upscaling and encoding.
3. **Anime/interpolation:** source-anchor preservation, cut/occlusion artifacts, character/costume/background drift, missing tests and misleading quality claims.

Reviewers read source only and return exact file/line findings. They do not read secrets, run paid jobs, edit shared files, or push. The parent agent integrates fixes and runs the verification. Claude Code model/auth failures must be logged, not hidden by substituting a model.

## Acceptance checks

- MCP exposes OpenRouter key remaining allowance with a timestamp, limit-reset information and explicit unknown/unavailable fields. Full account credits are optional because `/credits` requires a management key; normal-key `/key` status is the primary source.
- Before each paid request, compare a fresh provider allowance with local spent/reserved/unknown amounts; retain the existing provider cap and a retry reserve. Missing or unbounded cost uses local alternatives or stops.
- Paid generation is idempotent and staged. Drift/QC failures pause spending, not automatically buy repeated takes. A fixed seed is not proof of identity consistency.
- Cloud and Wan footage share an explicit edit timeline. Verify final duration within one delivery frame, sample-aligned speech placement, monotonic timestamps, expected resolution and fps, audible unclipped audio, and no broken assets.
- Interpolate within shots only, never across a cut. Compare originals and results at source timestamps; inspect occlusions and faces. If reliable interpolation cannot be demonstrated, keep original motion and report the reason. Do not confuse more frames with more accurate animation.
- Final order: shot generation → per-shot motion checks/interpolation → source-size assembly/colour match → soundtrack → completed-film upscale → anime finish/final encode → delivery QC.
- Compare with user-provided, local or openly licensed anime references where available. Do not fetch commercial anime just to manufacture a reference. Without reference footage, label comparisons as style/continuity review, not fidelity to “actual anime.”
- Fresh Electron install/startup and local/remote MCP client calls pass. Actual signed-in ChatGPT and paid cloud renders are reported separately from mock/SDK-client tests.

## Useful paths

`docs/CLAUDE_CODE_HANDOFF.md` is the running handoff log. Reviewer artifacts live in `/tmp/lumina-overnight/sonnet/`. Existing real local pilot artifacts are in `/tmp/lumina-shipping-smoke/`. `npm run doctor` reports installed runtimes without generating or spending.

## Current checkpoint

First scheduled review launch occurred at 06:39 UTC. All three Sonnet 5.5 sessions failed authentication (expired Claude Code OAuth), with zero tokens/cost; workers exited. Parent implementation continues without replacing the requested reviewers. Credit enforcement, completed-film upscaling and source-timestamp interpolation fixes are implemented and regression-tested. Real local whole-film pilot and comparison artifacts passed the bounded checks documented in the handoff log. Packaging/live cloud/web-client verification remains pending.

Second heartbeat: GPU contention and frame-clock defects fixed; shutdown/restart and mixed-rate/cut tests added. Version 0.9.1 packaged and smoke-tested in a temporary profile. Final regression/release verification in progress; live cloud/web-client and broader motion-quality acceptance remain pending.

Third/fourth heartbeat: v0.9.2 candidate adds packaged stdio MCP, bounded visual inspection and safe fresh-install budgets. Held-out local interpolation comparison saved; it shows measurable gains and individual failures, not perfect accuracy. Full 50-step/49-frame local anime pilot is running with a 20-minute timeout. Live provider/web login acceptance remains unavailable; paid generation stays unused.

Published checkpoint: v0.9.2 / 2abf82b, 98 tests (96 passed, two skipped), actual packaged MCP/default-startup checks passed, checksummed release installed for next launch. Main remaining independent work is the full-step pilot and finishing/QC; no live provider credit balance has been fabricated or spending limits reset.
