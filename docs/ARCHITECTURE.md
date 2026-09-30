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
       │     └─ src/providers/  image adapters: OpenAI, fal.ai, Gemini, Replicate, mock
       ├─ src/canvas.js       graph validation, templates, parallel execution via jobs
       ├─ src/books.js        picture books, novels, nonfiction; covers, narration, video; PDF/EPUB/DOCX/MD/audio export
       │     ├─ src/fonts.js    per-script system fonts (fontconfig) for PDF
       │     ├─ src/audio.js    TTS chunking, WAV/MP3 joining
       │     └─ src/zip.js      EPUB container writer
       ├─ src/remote.js       MCP over Streamable HTTP + OAuth 2.1 (pairing-code consent) for claude.ai / ChatGPT
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
`settings`, `schema_migrations`.

## Jobs

`POST /api/generate` inserts a `queued` row and returns `202`. Jobs have an `operation`: `generate`/`edit`/`variation` (images), `speech` or `video`, and the runner calls the
provider's `run`, `speak` or `video` accordingly. The runner picks rows up (two at a time). It
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
