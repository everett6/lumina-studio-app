# Five-minute anime production — $12 OpenRouter ceiling

This is a production recipe, not an assertion that these capabilities are already integrated into the Lumina UI. Do not start paid batches automatically.

## Deliverable
300.0 seconds, 16:9, 1080p H.264 MP4, AAC 48 kHz stereo. Use 30 fps master. Keep all shot starts/ends in an edit decision list.

## Suggested source timeline
- Cloud video: up to 75 s of source footage, chosen based on live prices and actual remaining account balance.
- Animated still compositions: 135 s.
- Dialogue/reaction compositions: 60 s.
- Titles, atmospheres, transitions: 30 s.
- Crossfades reduce total timeline length if overlapped: compensate by lengthening shots or use butt cuts in the 300-second animatic. Probe final duration.

## Gate sequence
1. Script with 7 scenes and every spoken line.
2. Character bible with twin distinctions; approve 3 characters and costume/state changes.
3. Make all still keyframes. Protect identity through image-to-video first-frame references.
4. Build free local 300-second animatic with temporary stills and silence. Verify duration using ffprobe.
5. Call Wan 2.7 :free for ONE low-stakes shot; ensure video API accepts model ID and returns playable output. Do not assume free tier capacity.
6. If unavailable, use paid video with per-shot preflight and strictly cap estimated total at $12 inclusive of retries/images/sound. Do not start costly bulk calls.
7. Review every generated clip. Reject substantial identity drift. Interpolate only clips with good spatial consistency and uneven frame pacing.

## Interpolation (experimental)
"AnimeGenX" is not currently a verified executable/model integration. Do not claim support without its repository, input/output formats and verified installation. An optional baseline is FFmpeg motion-compensated minterpolate, which may create artifacts across hard cuts:
```bash
ffmpeg -i input.mp4 -vf "minterpolate=fps=30:mi_mode=mci" -an -c:v libx264 -crf 18 -pix_fmt yuv420p smooth.mp4
```
This is **not** a fix for distorted facial features or limbs. Run per-shot, not across cuts; compare original to interpolated before acceptance.

## Audio
Use one narration/dialogue stem per actor, ambience bed and licensed music. Do not sum audio by concatenating sources. Instead, timeline-align stems using adelay/atrim and loudness balancing, then mix with FFmpeg amix. Lower music under dialogue; listen for clipping and verify audio sync. Lumina stitchClips retains each clip's existing audio, but does not yet support global dialogue/music stems, so audio-master assembly requires a separate postprocess step.

## Local finish
Render to 720p or 1080p proxy/master with ffmpeg. Test NVIDIA Real-ESRGAN on a 10-second excerpt before upscaling the full output; compare moving hair, outlines, and text for flicker. NVENC is encoding, not motion generation.

## Repository integration checklist (not implemented yet)
- GUI choice for still vs video per shot, including durations.
- Separate text/audio tracks plus timing offsets and preview.
- Per-shot interpolation toggle with optional external runner.
- Paid-job preflight from live model pricing + an account-level hard spending ledger.
- Final duration auto-adjustment to 300.0 sec after crossfades.
- Automated tests for mock video, mixed audio, timing, error handling, and free-tier unavailable fallback.
