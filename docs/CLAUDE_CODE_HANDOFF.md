# Lumina overnight handoff log

## Owner instructions

Polish/debug/optimize the anime pipeline; use 2–3 Sonnet 5.5 Claude Code reviewers at the 30-minute mark; add active MCP visibility of OpenRouter credits; use cloud and local Wan clips together; upscale after film assembly; rigorously check audio/interpolation/continuity; skip lip sync; preserve the existing hard cap; push verified changes to GitHub when finished and stop workers.

## Baseline and schedule

- Baseline: v0.9.0 / 392ddda, public repository `everett6/lumina-studio-app`, branch `studio-v1` tracking public main.
- Baseline validation: 78 passing tests, two skipped; real local pilot 1920×1080, 30 fps, 3.712 seconds, H.264/AAC.
- Overnight work started about 11:08 pm Pacific, October 12; first review launch about 11:38 pm; end around 7:08 am October 13.
- Heartbeat `lumina-overnight-polish`: every 30 minutes, 16 runs. Stop/disable on completion or at window end.
- No new paid generation is authorized beyond the existing $12 workflow/hard cap. Read-only credit checks are authorized. Do not increase/reset caps or print keys.

## Verified external API facts

OpenRouter `GET /api/v1/key` reports the current key's usage and `limit_remaining`; `GET /api/v1/credits` reports account credits and requires a management key. Return permission/missing-key information instead of inventing a balance.

Sources:
- https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key
- https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits

## Pending

1. Finish and inspect the running 50-step/49-frame local anime pilot; run interpolation/audio/whole-film finishing on it only after successful completion.
2. Broader motion/occlusion/drift assessment; keep originals and avoid claiming ground truth or perfection.
3. Live signed-in ChatGPT/claude.ai and bounded paid cloud acceptance remain unavailable. No paid tests until cost and credits can be bounded.
4. Sonnet reviews remain auth-blocked after the single scheduled launch; workers have exited, no duplicates or model substitutions.
5. Keep verification evidence current and stop/disable the heartbeat on actual completion or at 14:08:24 UTC. Published/install checkpoints are recorded below.

Append evidence and decisions as work progresses. Do not turn earlier “planned” checks into “passed” claims without command output/artifacts.

## First work segment completed

- Added `src/credits.js`: read-only OpenRouter `/key` monitor with a 30-second cache, fetch timestamps, numeric limit/usage fields, explicit unknown/unavailable values, and no raw labels/hashes/credentials returned.
- Added `GET /api/providers/openrouter/credits` and MCP `openrouter_credit_status` (readOnlyHint). These changes are in source; they are not yet in the installed v0.9.0 AppImage or published release.
- Added `tests/credits.test.js`. `npm run check` passed; `node --test tests/credits.test.js tests/remote.test.js` passed five tests. Diff whitespace check passed.
- Credit monitoring is visibility only so far. Next: integrate conservative, fresh provider allowance with paid-job preflight/reservations; do not claim that integration is complete.
- `scripts/run-sonnet-night-reviews.mjs` is ready and syntax-checked. It rejects early launches, uses exact `claude-sonnet-5-5`, launches three read-only custom reviewer roles once, limits each CLI API session to $1 where supported, and saves private reports in `/tmp/lumina-overnight/sonnet/`. Per-worker timeout is 30 minutes. No generation or MCP tools are exposed to reviewers.
- First reviewer launch remains scheduled for 30 minutes after the request; no Sonnet reviewers have been launched early.

## Current source changes to preserve

`src/credits.js`, `src/app.js`, `src/api.js`, `mcp/tools.js`, `tests/credits.test.js`, the overnight plan/log, and reviewer launcher. The pre-existing untracked `.claude/` directory belongs to the user and should not be removed or published blindly.

## First heartbeat: credit and finishing implementation

- Three exact `claude-sonnet-5-5` custom reviewers launched at 06:39 UTC. All exited immediately with `authentication_failed`: Claude Code OAuth expired and could not refresh. Reports show zero API tokens/cost. No model substitution. Manifest/status/results retained under `/tmp/lumina-overnight/sonnet`; do not launch duplicates. User must sign Claude Code back in for these reviews.
- Fresh OpenRouter `/key` preflight now runs before new provider requests. Missing allowance/cost fails closed; all reserved and unknown OpenRouter ledger rows count, plus protected retry reserve. Accepted provider-job recovery skips new-spend checks and polls the same job. Cap settings and historical spending are unchanged. Key rotation cannot return another key's cached allowance.
- Fixed settlement of null/empty/negative charges: retain the estimate rather than counting them as zero.
- Credit/budget regression command: `node --test tests/credits.test.js tests/credit-jobs.test.js tests/budget.test.js`: 12 passed, zero failures. No real paid requests.
- Film stitching now resolves missing shot lengths from media, snaps timeline lengths to delivery frames, mixes at native master size, then upscales the entire mixed film. Whole-film temporal deflicker is disabled to avoid crossing cuts. Content/settings-addressed master cache avoids repeating the upscale. Final checks require audio and duration within one frame. Stitch jobs are awaited during shutdown.
- `node --test tests/continuity.test.js`: eight passed. Full suite before the interpolation adjustment: 86 tests, 84 passed, two skipped, zero failures. A second full run including new interpolation tests is in progress; do not call it passed yet.
- RIFE timing fix: generated span ends at the last source frame timestamp, then holds the tail through the original video-frame duration. Source anchors are restored before encoding; non-integer ratios land within half a delivery frame. Exact contiguous output count required. Original source remains intact on failure.
- Real installed RIFE run on `/tmp/lumina-shipping-smoke/wan.mp4`: 17 original anchors, output 1280×704 at 30 fps, 0.733008 seconds. Source is the previously generated low-step Wan smoke clip, not a full-quality anime benchmark. Output/comparison artifacts saved under `/tmp/lumina-overnight/real`.
- Remaining: signed-in web-client/live-cloud verification, broader cut/occlusion/audio/mixed-source checks, Sonnet reviews (auth blocked), full suite result, packaging and release. No live credit snapshot recorded yet; do not infer available funds.

## Verification checkpoint at first heartbeat

- Full regression after the interpolation change: 88 tests, 86 passed, two skipped, zero failures (`/tmp/lumina-night-regression-final.log`). Added a subsequent hard-cut regression: three interpolation tests pass, including refusal before GPU/download work.
- MCP end-to-end credit call initially exposed an API envelope bug: string `status` fields were mistaken for HTTP status wrappers. Fixed the route to return `{status: 200, body: snapshot}`. Re-run `node --test tests/mcp.test.js`: all five tests pass, including `openrouter_credit_status` and missing-key semantics.
- Actual source-anchor comparison at source frame 8 / target frame 10: PSNR 42.82 dB after delivery encoding. Side-by-side visually retains this sampled silhouette, costume and background. This measures one restored anchor, not interpolation ground truth or unseen occlusions. Saved `anchor-comparison.png` and logs in the private real-test directory.
- Actual installed-model whole-film pilot: existing Wan clip plus an existing local still-motion clip, source-size 640×360 assembly, real Kokoro soundtrack, Real-ESRGAN anime upscale after mixing, anime finish. Output `/tmp/lumina-overnight/real/whole-film.mp4`: 1920×1080, 30 fps, 45 frames, 1.509 seconds, audio present. Expected video timeline 1.5 seconds; container deviation 9 ms (< one frame). Decode timestamps monotonic on both streams; audio mean -24.0 dB, peak -6.7 dB (not clipped).
- This pilot uses local media, not a paid cloud render, and is too short to establish production-quality motion. No cloud credits spent. Real cloud/Wan interoperability is represented by adapter/mixed-provider regressions, not falsely claimed as a live cloud test.
- Sonnet worker PIDs have exited. OAuth failure remains actionable; no duplicate launches or substitutions.
- Next heartbeat: broader interpolation/occlusion and error/restart coverage, packaging smoke/release preparation, public README verification, and remaining live-client checks where accessible. Existing v0.9.0 installation remains unchanged until the new build passes.

## Second heartbeat: GPU isolation, shutdown and exact frame clocks

- Added a shared FIFO across local model generation and RIFE/Real-ESRGAN finishing. Idle Python workers release their weights before finishing starts. Model switching now awaits process exit, escalates SIGTERM to SIGKILL after five seconds, and fails closed after ten seconds if exit cannot be confirmed. Scope: one backend process; other programs/backends can still contend for VRAM.
- Worker startup/stdin errors reject the request explicitly. Regression fixture proves delayed shutdown finishes before replacement begins. Queue failures do not block later tasks. Four targeted GPU/worker tests passed.
- App close pauses production scheduling, drains queued generation, awaits finishing/check writes, and then closes SQLite. A five-job close/restart regression retains all completed images with working asset URLs. Sequence tracking no longer creates unhandled rejected cleanup promises.
- New synthetic mixed-provider regression initially found 24 fps became 24.02085 fps because Matroska intermediates quantized timestamps to milliseconds. Fixed intermediates to MOV with a 120000-Hz video timebase and explicit frame-derived concat durations. Tests now check 24/25/30/50/60 fps, exact frame counts, hard-cut colors, audio and monotonic decode timestamps. No real cloud call was used.
- `npm run doctor`: Wan, Animagine, Kokoro and Chatterbox installed; RTX 5070/Python runtime available; ffmpeg/ffprobe, RIFE and anime upscaler available. This is availability evidence, not proof every production workload fits memory.
- Full regression after frame-clock fix: 94 tests, 92 passed, two skipped, zero failures. Subsequent missing-executable test passed in the four-test GPU/worker run; a final full release suite is in progress.
- Built v0.9.1 `.deb` and AppImage. Final AppImage launched using a separate temporary profile and captured the rendered UI without logged startup errors. Artifacts: `/tmp/lumina-overnight/build-091-final.log`, `/tmp/lumina-overnight/smoke-091-final/window.png` and `electron.log`. Existing user data was not used for this smoke test.
- Real installed RIFE re-run through the new queue: 1280×704 / 30 fps / 0.733008 s / 17 restored anchors; `/tmp/lumina-overnight/real/wan-queued-interpolation.mp4`.
- README/MCP/architecture docs updated for 0.9.1 and corrected to show upscaling after the mixed native master. Reviewers remain stopped/auth blocked; no cap changes, top-ups, paid generation or lip-sync work.
- Still pending acceptance: real signed-in ChatGPT/claude.ai, bounded live cloud render, broader production-quality occlusion/drift evaluation, and a self-contained packaged stdio MCP command (current Claude Code setup uses the repository MCP script). Do not describe these as tested.

### v0.9.1 release gate

Final full suite (`/tmp/lumina-night-091-release-tests.log`): **95 tests, 93 passed, two skipped, zero failures**. JavaScript checks, local Python AST checks and diff whitespace checks passed. Final packaged AppImage smoke passed with an empty startup log and a rendered window. Checksums prepared under `/tmp/lumina-overnight/release-091`. Publishing this bounded verified patch; live-account/production-quality acceptance remains explicitly pending.

### Published checkpoint

- Code commit **771dc6e** pushed to public main.
- Release **v0.9.1** published: https://github.com/everett6/lumina-studio-app/releases/tag/v0.9.1
- GitHub reports all three assets uploaded. Published AppImage/deb SHA256 digests match locally generated `SHA256SUMS.txt`.
- `~/Applications/Lumina-Studio.AppImage` updated atomically to the verified build. Running user instances were not interrupted; the next launch uses v0.9.1.
- Overnight heartbeat remains active for outstanding acceptance work. Next useful tasks: self-contained packaged MCP entry, broader local reference/interpolation comparisons and failure recovery. Signed-in web/provider checks remain unavailable without credentials/login; do not fabricate success. Stop/disable the heartbeat on actual completion or at 14:08:24 UTC.

## Third/fourth heartbeat: self-contained MCP and visual review

- Added `electron/entry.js`; the packaged binary's `--mcp` path opens no renderer, takes no single-instance lock and creates no backend. It uses the same desktop API/data and exits on stdin close. Packaged helpers default autolaunch to their own AppImage/executable. Desktop session required; source Node MCP remains available for headless use.
- AppImage SDK-client test passed without a source checkout/Node requirement for the helper. A second fresh-package test verified bundled MCP, rendered startup, strict budget enabled, unknown prices refused by defaults, total $12 and zero queued/paid work. Both targeted packaged tests passed. `/tmp/lumina-overnight/092-installed-mcp-tests.log`.
- Actual live MCP local-budget snapshot during this segment: enforcement disabled, strict prices disabled, local ceiling $12, ledger spent/reserved $0, zero requests. This is NOT an OpenRouter credit snapshot. No paid calls were made. The running old app cannot report the new provider-allowance endpoint; restart is required. Provider key/account allowance remains unverified.
- Fresh budget defaults now enable strict $12 protection. Existing explicit settings, lower limits and history are preserved. Tests exercise both safe defaults and preservation. General mock workflow fixtures explicitly opt out of spending checks; dedicated budget tests enable them and test refusal/staging.
- Added read-only MCP `inspect_video`: authenticated asset-only decoding, metadata and at most six <=480px timestamped PNG samples, bounded decoder timeout/buffer, no generation or edits. MCP end-to-end tests verify thumbnails and refusal of out-of-range times. No perfect-motion inference is made from samples.
- Full suite after these source changes: 97 tests, 95 passed, two skipped, zero failures. A final release suite including the extra fresh-package regression is in progress.
- Local held-out comparison: existing generated Wan clip downsampled from 24 to 12 fps; real installed RIFE reconstructed 59 missing observed frames. Aggregate PSNR 40.65 dB vs repeat-frame 36.78 dB; 15/59 frames score worse than holding. Worst reconstructed-frame PSNR 35.47 dB. Saved `/tmp/lumina-overnight/heldout/report.json`, statistics and `worst-comparison.png`. Visual sample shows no large silhouette/coat discontinuity, but this is live-action-looking generated Wan footage, not a drawn-anime or physical-ground-truth test.
- Inspected an existing local anime-styled figurine comparison artifact; provenance and generation settings are not verified, so it is not used as a quantitative benchmark. No commercial footage was downloaded.
- Started an actual production-setting local anime pilot at 08:18 UTC: 49 frames at 24 fps, 1280×704, 50 steps, fixed seed, existing Animagine start image. GPU initially had about 11 GB free. 20-minute worker timeout; no API billing. Status `/tmp/lumina-overnight/production-pilot/status.json`. Do not mark this passed until completion/output QC.
- Sonnet review manifest still records the three expired-OAuth failures; no duplicate agents or substituted model.

### v0.9.2 release gate

Final full suite with the actual packaged AppImage configured: **98 tests, 96 passed, two skipped, zero failures** (`/tmp/lumina-overnight/092-release-tests.log`). Both packaged-MCP tests passed, including a fresh desktop app with strict budget defaults and rendered startup. JavaScript and whitespace checks passed. This release gate covers packaged MCP/inspection/defaults; the 50-step pilot is still running and is not counted as passed evidence.

### Published v0.9.2 checkpoint

Commit **2abf82b** pushed to public main. Release https://github.com/everett6/lumina-studio-app/releases/tag/v0.9.2 published with AppImage, .deb and checksums. GitHub asset SHA256 digests match the locally built artifacts. Installed `~/Applications/Lumina-Studio.AppImage` updated atomically; existing running user instances not interrupted. Runtime upgrade/new tools require restart. The 50-step pilot has reached inference step 50 but decode/save completion is still pending at this checkpoint; do not count it as passed.

### Production inference checkpoint

The bounded full-step Wan pilot completed successfully: 49 frames, 50 inference steps, 1280×704, 24 fps, 2.041667-second output. Wall time 435266 ms (~7.25 minutes); worker reported inference 413.1 seconds. No out-of-memory notice/error appeared in the captured log. The worker exited before GPU finishing started. This is one real workstation run, not a universal memory guarantee.

Started dependent finishing: fresh local Kokoro line (“Evening falls.”), speech-fit validation, per-shot RIFE to 30 fps, native 1280×720 assembly, audio mix, completed-film anime upscale to 1920×1080, final encode and five visual review samples. Status will be written to `/tmp/lumina-overnight/production-pilot/finish-status.json`; do not assume success before checking it. No paid cloud requests.

New follow-up found while planning audio validation: `lineTimes` reports dialogue overrun, but sequence stitching currently ignores that value. Next change should refuse or pause finishing when measured dialogue exceeds the shot, instead of silently truncating it; preserve all recorded audio and have MCP revise the line or extend the shot. Add a regression before changing this behavior.
