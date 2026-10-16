# Local audio tools

All ten MCP tools run locally on CPU with ffmpeg/ffprobe. They are free, require no network or GPU, and use the authenticated API. No original recording or picture is overwritten. New media is stored in the same project; exported stems go into Lumina's exports folder.

| Tool | Inputs | Result |
| --- | --- | --- |
| `validate_delivery` | Exactly one of `storyboardId`, `assetId` | Checks with `passed`, `failed`, or `unavailable`, a summary, counts, `blocked` and blocking findings |
| `measure_loudness` | `assetId` | `integratedLufs`, `lraLu`, `truePeakDbtp` from ebur128 |
| `normalize_loudness` | `assetId`, optional `targetLufs`: -14, -16 (default), -23 | Two-pass loudnorm, new 48 kHz 24-bit WAV, measured result; source kept |
| `waveform_image` | `assetId` | New 1200×240 PNG waveform, shown inline |
| `detect_silence` | `assetId`, optional `minSeconds` (0.5), `thresholdDb` (-50) | Quiet intervals, including leading and trailing silence |
| `set_mix` | `storyboardId`, `mix` object | Persisted controls and explicit join/preview support |
| `mix_preview` | `storyboardId`, optional `from` (0), `seconds` (10, at most 30) | New MP3, played inline, without a picture join |
| `export_stems` | `storyboardId` | Four aligned stereo float WAVs at 48 kHz, in a new exports subfolder |
| `trim_audio` | `assetId`, `start`, `end`, optional `fadeIn`, `fadeOut` (0) | New 24-bit WAV; fades are in seconds within the trimmed span |
| `audio_report` | `storyboardId` | Measured lines/slots per shot, effects, active cue, overlaps, saved controls, last joined film loudness |

## Delivery targets and interpretation

This module's online-video delivery policy is **-16 LUFS integrated ±1 LU**, **true peak ≤-1 dBTP**, **two audible channels**, and audio/video stream durations within **one video frame**. These are project defaults, not a universal broadcast specification. `normalize_loudness` additionally offers -14 and -23 LUFS, with -1 dBTP and LRA 11; its second pass uses the first pass's measured I, TP, LRA, threshold and offset. Silent/unmeasurable material is refused.

Storyboard validation reads every declared dialogue line, including lines whose asset row or file has been deleted. It probes and fully decodes each recording, remeasures its length instead of trusting cached `seconds`, and uses the same `lineTimes` placement as the join (explicit start, otherwise 0.4 seconds initially and 0.25 seconds between lines). Recorded speech extending past the frame-rounded shot end by more than one audio sample is blocking. Missing/unplayable recordings, unusable shots, voice mismatches and absent/silent delivery channels also block. Overlapping line intervals are reported separately as failures.

Voice verification compares the take's generation provider/model/voice with the speaker's current assignment, using the narrator fallback exactly as the existing join does. Derived assets retain provenance through their parent chain. An imported recording without generation metadata has an **unavailable** voice check: this is metadata verification, not biometric speaker recognition. A missing current voice assignment fails.

Delivery checks use the last joined film, with a stale-join failure after changes. A storyboard without a joined film has unavailable delivery measurements. An asset alone has no dialogue ledger or assignments, so that part is unavailable. An audio-only asset has unavailable audio/video synchronization. Nothing unavailable counts as passed; the overall result is unavailable unless there is a failure. `blocked` highlights blocking findings; inspect the summary and all checks before delivery.

Silencedetect flags shared quiet intervals lasting at least 0.5 seconds below -50 dB. Per-channel detection also finds channels that are silent throughout. Silence is a review flag: intentional pauses and silent scenes can be correct. Measurement inspects the first audio stream; alternative language tracks are not certified. A true peak on digital silence can be unavailable.

`validate_delivery` returns a delivery gate report. It does **not** intercept `publish_film` or modify the publisher; callers must inspect its result before publishing.

## Mix controls

Settings are saved under `repo.settings` key `mix:<storyboardId>`, merging partial updates. Unknown keys and non-finite/out-of-range values are refused.

| Control | Range | Applied by next `join_storyboard` | Preview and stems |
| --- | --- | --- | --- |
| `clipVolume` | Linear 0–2 | Yes: also updates the storyboard's existing `settings.clipVolume` | Yes |
| `dialogueGainDb` | -60 to +24 dB | Recorded only | Gain after dialogue bus normalization |
| `musicDuckDb` | 0–24 dB | Recorded only | Maximum possible duck depth; 0 disables ducking |
| `sfxGainDb` | -60 to +24 dB | Recorded only | Effects bus gain |

The existing join keeps its original -16 LUFS dialogue normalization, original sidechain compression, existing music/ambience volumes and final limiter. It does not read the three saved gain controls. Changing only these controls does not require or change the picture. The response always spells out this distinction.

For previews, an unset duck amount preserves the original compressor. An explicit amount blends dry music with compressed music, with dry fraction `10^(-musicDuckDb/20)`; this bounds maximum attenuation rather than promising a fixed drop. Actual reduction follows the dialogue key. Ambience is not ducked.

The added `mixSoundtrack` options default to the original filter graph and output. `dialogueGainDb=0`, `sfxGainDb=0`, `musicDuckDb=null`, `audioOnly=false`, `from=0`, `seconds=null`, `stems=null` retain today's video mix. Audio-only mode requires an audio input and explicit timeline duration. Stem paths are internal server-generated paths.

## Preview and stems

Previews rebuild clip sound from the source clips with trim, mute, padding, short cut fades, and the existing borrowed crossfade convention. Dialogue, music cues, looped ambience and effects follow the current shot clock. Rejected/missing clips and missing/clipped dialogue are refused rather than silently omitted. No video is encoded or joined, and the storyboard's last joined asset is unchanged.

The preview output is at most 30 seconds and clamps to the remaining timeline. Processing retains the full timeline's normalization and ducking context; runtime scales with source length and the number of lines. This is faster than rejoining picture but is not a real-time playback engine. Specialized picture processing or future timeline semantics may require corresponding audio support.

The four exported files are `dialogue.wav`, `music.wav`, `effects.wav`, and `clip.wav`. Music includes ambience and uses the dialogue sidechain even though the dialogue is exported separately. Empty buses produce aligned silence. All files start at timeline zero and have the same length. They are taken **before the final limiter**, so their unity sum roughly matches a preview; limiter activity, its latency, and MP3/AAC encoding can prevent sample-exact reconstruction. Export does not include a separate ambience stem.

## API mapping

`POST /api/audio/validate-delivery`; asset operations under `/api/assets/:id/audio/` (`GET loudness`, `POST normalize`, `POST waveform`, `POST silence`, `POST trim`); storyboard operations under `/api/storyboards/:id/audio/` (`PUT mix`, `POST preview`, `POST stems`, `GET report`). Request bodies match MCP arguments without the path ID. The mix body is `{ "mix": { ... } }`.

## Verification

Run only the requested focused suite:

```sh
timeout 180 node --test tests/audio-tools.test.js tests/mcp.test.js tests/soundtrack-music.test.js
```

The audio tests use lavfi tones, silence and small videos plus mock-provider speech over MCP. They cover registration, LUFS/peak measurements, all three normalization targets, missing/deleted/clipped dialogue, overlaps, voice assignment changes, silence, channel loss, preview media, gain persistence/effects, stem summing, trim fades, stale joined audio, and default-output loudness against a captured pre-extension mixer reference (-16.4 LUFS, tolerance 0.1 LU).
