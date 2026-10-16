# Film delivery

`src/delivery.js` exports six async functions for Node ESM. They use the existing
`run`, `runCapture`, and `probe` helpers and local font lookup. No API calls, GPU,
project state, or caller wiring is involved.

All file arguments must be absolute paths. Inputs must exist and be regular
files. Output directories must already exist; destinations must **not** exist,
including symlinks or hardlinks. This deliberately refuses replacement of any
existing file. Rendering uses a temporary directory, cleaned on success or
failure, and publishes with an exclusive copy. A failed final filesystem copy
can still leave an incomplete destination (for example, a full disk).

MP4 output uses CPU H.264 (`libx264`), constant frame rate, square pixels,
`yuv420p`, and `+faststart`. Dimensions must be positive even integers. Requested
durations round to the nearest whole frame (at least one frame), with an error
of less than one frame; returned `seconds` is the actual video frame duration.
AAC/container timestamps can differ slightly from the video duration. PNG is a
single RGB image, so video timing, audio, `yuv420p`, and faststart do not apply.

## API

```js
import {
  makeThumbnail, titleCard, endCredits, makeShort, burnSubtitles, srtFromCues,
} from '../src/delivery.js';
```

### `makeThumbnail(framePath, outPng, options)`

Options: required `title`, optional `subtitle`, `width=1280`, `height=720`.
Returns `{ file, width, height }`.

Cover-scales and centre-crops the image to a required 16:9 output. The bold white
title has a black outline/shadow and occupies at most two word-wrapped lines in
the lower third. A smaller subtitle can also use two lines. Font sizes shrink
to fit the width and combined vertical space; extremely long text may become
small or fail if it cannot fit. Long unbroken tokens wrap between characters.

### `titleCard(outMp4, options)`

Options: required `title`, optional `subtitle`, `seconds=3`, `width=1920`,
`height=1080`, `fps=30`, and `backgroundImage` (absolute path).
Returns `{ file, seconds }`.

Centred title/subtitle over black or a cover-cropped, blurred, darkened image.
The whole picture fades in and out over up to 0.5 seconds at each end; shorter
cards use shorter fades. Includes silent stereo AAC at 48 kHz. Use the same
dimensions and fps as the other shots. Joining AAC pieces by stream copy can
introduce codec padding; decode/re-encode audio when assembling a film.

### `endCredits(outMp4, options)`

Options: non-empty `sections: [{ heading, lines: [] }]`, optional `seconds`,
`width=1920`, `height=1080`, `fps=30`.
Returns `{ file, seconds }`.

White, outlined text rolls upward over black, from below the frame to above it.
Headings are slightly larger; long lines wrap and sections have a blank spacer.
Default duration is 2 seconds plus 0.8 seconds per wrapped row/spacer, excluding
the final spacer, rounded to a whole frame. Explicit duration overrides that
reading-time estimate. Includes silent stereo AAC at 48 kHz.

The roll follows a linear trajectory sampled at the output fps. Libass is
preferred for fractional text positions; drawtext uses frame-indexed positions
when libass is missing. Timestamps stay uniformly spaced. Integer-pixel
drawtext positioning, low fps, or a very short explicit duration can make motion
look stepped; choose sufficient duration and fps for readable credits. Rendering
cost grows with the number of credits rows.

### `makeShort(filmPath, outMp4, options={})`

Options: `aspect='9:16'`, `maxSeconds=60`, `start=0`, `focusX=0.5`.
Returns `{ file, seconds, width: 1080, height: 1920 }`.

Creates a portrait centre-height crop around a fixed horizontal source point:
`focusX=0` follows the left edge, `0.5` the centre, and `1` the right edge.
The crop clamps to the source bounds. The source film should be landscape with
square pixels; even source dimensions are required. Only `9:16` is supported.
Crop geometry rounds to even source pixels before scaling, so tiny inputs can
have a small aspect approximation. There is no moving subject tracking.

Starts at `start` seconds, limits duration to `maxSeconds` or the remaining video
length, and retains the source frame rate as CFR. Existing audio tracks are
trimmed and encoded as stereo AAC at 48 kHz; an input without audio remains
without audio. A cut not aligned to a frame may move by up to one frame.

### `burnSubtitles(filmPath, srtPath, outMp4, options={})`

Options: `fontSize` (positive pixel size, default approximately 4.5% of height,
minimum 8), `style='anime'` (the only style). Returns `{ file }`.

Burns a UTF-8 SRT using white bold text, a black outline/shadow, bottom-centred
alignment, and 6% safe margins. Picture size, source fps, and duration are
preserved for the CFR films produced by this project. All audio tracks are
stream-copied untouched; incompatible audio codecs cause an MP4 muxing error
rather than being silently transcoded. No audio is added to silent inputs.

Video is re-encoded, so arbitrary source pictures can have small compression
differences even outside cue times. The pixel-isolation test uses uniform black
frames so it can check exact equality outside cues. Variable-frame-rate inputs
are normalised to the average fps reported by ffprobe; original irregular frame
timestamps cannot also be preserved as CFR. Non-square-pixel/rotation metadata
and unusual timestamp offsets are outside the supported film workflow.

### `srtFromCues(cues)`

Accepts `[{ from, to, text }]`, with times in seconds. Returns SRT text, numbered
in supplied order, or an empty string for no cues. Times round to milliseconds,
including carry across minute/hour boundaries. Each cue must have a non-negative
start and an end after the start, including after millisecond rounding.

Lines wrap at 42 Unicode code points, preferring word boundaries. Text is plain:
HTML-like tags, ASS override blocks, backslashes/braces, controls, and bidi
override/isolate controls are removed; whitespace collapses and embedded SRT
arrow delimiters become `→`. Empty text is rejected. Existing line breaks are
rewrapped. Cue order and overlaps are preserved; translation, reading-speed
adjustment, grapheme-aware wrapping, and timing alignment are the caller's job.

## Filter and font availability

The module caches `ffmpeg -filters` once per process. Thumbnail/card text prefers
`drawtext`, with generated ASS through `subtitles`/libass as its fallback. Credits
prefer libass and fall back to drawtext. If neither renderer exists, these
functions throw a clear error; they never silently produce text-free output.
`burnSubtitles` specifically requires `subtitles`/libass and throws an error
naming that dependency when unavailable.

Background blur uses `gblur`, then `boxblur`; if both are absent, the image is
still darkened. If `fade` is absent, title cards are produced without fades.
Other basic filters and the CPU H.264/AAC/PNG encoders must be installed; ffmpeg
errors are propagated. No fonts are downloaded. Latin text prefers fontconfig's
bold sans-serif, and `resolveFonts` supplies a font for non-Latin scripts.
Drawtext uses one font per composition, so mixed scripts depend on that font's
coverage. Libass can use installed fallback fonts. Layout uses conservative
glyph-width estimates, not exact typography measurements.

## Verification

```sh
timeout 180 node --test tests/delivery.test.js
```

Fixtures are generated locally with lavfi at 160×90 or 320×180 and no more than
three seconds. Tests check dimensions (including the mandated 1080×1920 Short),
fps, uniform frame timestamps, duration, pixel format, faststart, silent stereo
AAC, fades, credits movement, subtitle cue pixels, copied audio packet hashes,
validation, and input alias protection. A subprocess with a reduced ffmpeg filter
inventory exercises the libass text fallback and missing-libass error. Tests
skip only when the installed ffmpeg lacks a needed rendering filter.
