# Architecture

Lumina is one Node.js backend with three front doors: the browser UI (dev server), the Electron desktop app, and
the MCP server. Everything runs on your computer.

```
            ┌──────────── Electron main ─────────────┐     ┌─ npm start ─┐     ┌─ mcp/server.js ─┐
            │ safeStorage cipher · window lockdown    │     │ server.js   │     │ stdio MCP tools │
            └───────────────┬────────────────────────┘     └──────┬──────┘     └───────┬─────────┘
                            └───────────── startLumina() ─────────┘      HTTP + bearer │
                                                 │                                     │
   src/api.js  ── HTTP API on 127.0.0.1 (token, Host/Origin checks, CSP) ◄─────────────┘
       │
       ├─ src/generation.js   validate against model capabilities, enqueue
       ├─ src/jobs.js         durable queue (generation rows), concurrency 2
       │     ├─ src/directors/  prompt refinement: OpenAI, Anthropic, Nemotron
       │     └─ src/providers/  media adapters: OpenRouter, OpenAI, fal.ai, Gemini, Replicate, mock
       ├─ src/canvas.js       graph validation, templates, parallel execution via jobs
       ├─ src/books.js        picture books, novels, nonfiction; covers, narration, video; PDF/EPUB/DOCX/MD/audio export
       │     ├─ src/fonts.js    per-script system fonts (fontconfig) for PDF
       │     ├─ src/audio.js    TTS chunking, WAV/MP3 joining
       │     └─ src/zip.js      EPUB container writer
       ├─ src/sequences.js    storyboards: shot planning, frames, clips; src/video.js joins clips with ffmpeg
       ├─ src/manuscript.js   .txt/.md/.docx import into chapters
       ├─ src/pricing.js      list prices per model, shown as estimates
       ├─ src/remote.js       MCP over Streamable HTTP + OAuth 2.1 (account sign-in consent), website proxy for claude.ai / ChatGPT
       │     └─ mcp/tools.js    the tool set, shared with the local stdio server
       ├─ src/keys.js         0600 key file, encrypted when a cipher is supplied
       ├─ src/assets.js       image files, type sniffing, lineage
       └─ src/repo.js + src/db.js   node:sqlite, WAL, migrations, v0.1 JSON import
```

## Data

A data root holds `data/` (`lumina.db`, `keys.json`, `api-token`, `endpoint.json`) and `storage/assets/` (images).

- Desktop: `~/.config/Lumina Studio`
- Dev server: the repository folder, or `LUMINA_DATA_DIR`

Tables: `projects`, `assets` (kind `generation` or `reference`, with `generation_id` and `parent_asset_id` for
lineage), `generations` (also the job queue), `canvases` (versioned JSON graph), `canvas_runs` (per-node state),
`settings`, `schema_migrations`, `books`, `book_pages`, `book_chapters` (with revision tables), `characters` (global),
`sequences` and `shots` (storyboards), `canvas_templates`, `oauth_clients`, `oauth_tokens`. Assets of kind `mask` are
working files for inpainting and are hidden from the library.

## Films: continuity, checks and post-production

`src/sequences.js` drives storyboards. Each shot stores `details` (scene, cast and location ids, action, dialogue,
start/end state, what must not change, video or still, per-shot model, lock, cached post files) and `review`
(status, check results, frame approval). Every frame and clip prompt is built in one fixed order: shot text, action,
scene and location, start or end state, the film's look line, its look bible, the "keep everyone identical" line and
the forbidden list; the film's seed and the shot's character and location references go with it. In keyframe mode
a clip gets the next shot's approved frame as its last frame when both shots share a scene and the model supports it.

After a clip arrives, `src/qc.js` runs free ffmpeg checks: length, black and frozen picture, sound, and drift — the
clip's first and last frames are shrunk to 32×18 thumbnails and compared with the approved frames (mean absolute
difference; matching frames score 3–20, unrelated pictures 110+, threshold 30) plus a colour-shift check. Checks
suggest a status; only a person (or an orchestrator via MCP) accepts a shot.

With the face check installed (`src/faces.js`), each clip of a live-action film is also sampled at three points;
YuNet finds faces and landmarks, each face is aligned to SFace's 112×112 template and turned into an identity vector,
and the best cosine similarity against each person's reference photos is reported (same person at ≥ 0.363, OpenCV's
published threshold).

Joining (`stitch`): per shot, optional RIFE interpolation, then one upscale from the original straight to the
delivery size (Real-ESRGAN anime-video or x4plus, cached per source and size) → `stitchClips` builds an exact-length
near-lossless picture, with each shot colour-matched to its scene's first shot (per-channel mean and spread,
clamped and blended, `src/grade.js`) inside the same encode (crossfades borrow from the outgoing shot, so the film runs the sum of its shot lengths) →
`src/soundtrack.js` mixes clip sound, dialogue (placed and loudness-normalised), music (ducked under speech) and
ambience with a limiter, copying the picture → `deliverFilm` makes the single final encode with the optional
cinematic finish.

## Budget

`src/budget.js` prices each paid request (`src/pricing.js`, from OpenRouter's live SKUs where available), checks the
limits and reserves the amount in `spend_ledger` inside the same synchronous step that creates the job, so concurrent
requests cannot jointly overspend. Completion settles with the provider's reported cost; a failure after submission is
marked unknown and its retry needs explicit confirmation. Requests above the approval threshold create a single-use
approval bound to the exact request; limits and approvals from MCP clients are refused unless the person allowed them.
Provider job ids are saved as soon as a job is accepted, so a restart resumes polling instead of paying again.

## Jobs

`POST /api/generate` inserts a `queued` row and returns `202`. Jobs have an `operation`: `generate`/`edit`/`variation` (images), `speech`, `video`, or an image tool
(`upscale`, `remove-background`, `inpaint`), and the runner calls the provider's `run`, `speak`, `video` or `tool` accordingly. Presets and characters are
added to the prompt by `providerPrompt()` when the job runs. The runner picks rows up (two at a time). It
optionally refines the prompt with a director, loads input images, calls the provider, sniffs and stores the
output, and marks the row `completed` or `failed` with a category (`auth`, `rate_limit`, `policy`,
`invalid_request`, `timeout`, `provider`, `missing_key`) and a plain-language message. On start, `queued` rows
resume and `running` rows become `interrupted` (retryable).

## Providers

Each adapter declares its models with `operations` (`generate`, `edit`), `sizes`, `qualities` and `maxReferences`.
The UI, canvas and MCP all read this catalog, and `generation.js` enforces it. To add a provider, write an adapter
with `validateKey(key)` and `run({ key, model, prompt, size, quality, images })` returning `{ bytes, usage }`,
register it in `src/providers/index.js`, add its key name to `src/keys.js`, and add a faked-HTTP test.

## Canvas

Node types and ports live in `src/canvas.js` (`text` and `image` port types). A run evaluates each node as a
memoized promise, so independent branches run in parallel, and each generate or edit node becomes one job. Running
a single node reuses cached results for upstream generate, edit and director nodes from earlier runs. Saves use
optimistic concurrency (`version`), so a stale save gets `409` and the latest graph.

## Security model

- The server binds to `127.0.0.1` only and rejects non-loopback `Host` headers (DNS rebinding) and cross-origin
  writes.
- `/api` and `/assets` require the per-install token, as an HttpOnly SameSite=Strict cookie (set by opening the
  launch link) or a bearer header (MCP).
- Keys never reach the renderer. The desktop app encrypts them with the OS keyring; the dev server stores them in
  a 0600 file and says so in Settings.
- Electron renderer: `contextIsolation`, `sandbox`, no `nodeIntegration`, no preload bridge, navigation locked to
  the app origin, permission requests denied, strict CSP.
