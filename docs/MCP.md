# Using Lumina from Claude (MCP)

Lumina ships a local [Model Context Protocol](https://modelcontextprotocol.io) server so Claude Code or Claude
Desktop can work with your projects: list them, generate and edit images with your own provider keys, add images to
a canvas, and run canvas workflows.

The MCP server is a small stdio process. It does not hold keys or data itself: it finds the **running** Lumina app
through `data/endpoint.json` and authenticates with `data/api-token` (both readable only by your user), then calls
the same local API the UI uses. If Lumina is closed, the first tool call opens the desktop app and waits for it.
It looks for `LUMINA_APP_COMMAND`, `~/Applications/Lumina-Studio.AppImage`, `/opt/Lumina Studio/lumina-studio`,
`/usr/bin/lumina-studio`, then `dist/linux-unpacked/lumina-studio`. Set `LUMINA_NO_AUTOLAUNCH=1` to turn this off.

## Tools

| Tool | What it does |
| --- | --- |
| `list_projects` | Projects, most recently updated first. |
| `create_project` | Create a project. |
| `list_models` | Providers, whether each has a key, each model's capabilities and its list price when known; creative directors. |
| `list_presets` | Camera moves, effects and styles; pass their ids as `presets` to `generate_image` / `generate_video`. |
| `generate_image` | Generate, or edit when `inputAssetIds` is given. Waits and returns the image by default. **Spends money on your provider account.** |
| `get_generation` | Status of a generation, with the image when complete. |
| `list_assets` | Images and canvases in a project. |
| `add_to_canvas` | Add an image to a canvas as a reference node. |
| `run_canvas` | Run a canvas (or only what one node needs) and report each node's result. |
| `create_book` / `list_books` / `get_book` / `update_book` | Create a picture book from a brief; read or edit its brief, story bible and pages. |
| `draft_bible` | Writer model drafts the story bible from the brief. |
| `plan_pages` | Writer model writes every page (text plus illustration brief). `replace: true` overwrites existing pages. |
| `edit_page` / `revise_page` | Set a page's text directly, or have the writer revise it from an instruction. History is kept. |
| `generate_illustration` | Illustrate one page with the bible's character looks and reference images. **Spends money.** |
| `outline_book` / `draft_chapter` / `read_chapter` / `revise_chapter` / `edit_chapter` | Novels and nonfiction: outline, write, read, revise and edit chapters. |
| `generate_cover` | Cover art from the brief and bible. **Spends money.** |
| `narrate` / `generate_speech` | Narrate a page or chapter with the book's voice, or turn any text into audio. Free with a local voice (Kokoro, the default when installed); provider voices spend money. |
| `list_voices` | Every voice model (local Kokoro/Chatterbox and provider voices) with its voice names, whether it is ready, and how to set it up. Free. |
| `preview_voice` | Speak a short sample in one voice and play it back inline, so you can pick a voice before `set_character_voice`. Free with a local voice. |
| `cast_voices` | Give the narrator and every character in a storyboard a distinct voice in one call (female/male guessed from design tags; voices you chose are kept unless `replace`). The whole request is checked before anything is saved. `record: true` records every unrecorded line. Free with the local voices. |
| `find_music` | Search free music on the internet (Openverse: Freesound, Jamendo, Wikimedia) by mood or genre. Only CC0 / public-domain / CC BY tracks are returned, so the music can be used in a film without changing the film's licence. |
| `set_background_music` | Put music (and optionally ambience) under a film: `search` downloads the best free track automatically, `trackId` one from `find_music`, or use a library `assetId` / local `filePath`. The music loops to the film's length and is ducked under speech. Returns the artist credit; put CC BY credits in the video description. Then `join_storyboard`. |
| `generate_video` | Text-to-video or animate an image. **Spends money; slow.** |
| `list_characters` / `create_character` / `update_character` | Reusable characters, products and locations (up to 6 reference images, a voice, a lock). Pass their ids as `characterIds` to `generate_image`, `generate_video` or `create_storyboard`. A locked look refuses changes unless `locked: false` is sent. |
| `make_character_sheet` | Queue a turnaround model sheet (or `expressions: true` for an expression sheet) for a character from its `designTags` (a locked anime tag block, settable in `create_character` / `update_character`) or description. Defaults to the local Animagine model when installed; the finished sheet becomes the first reference image. Poll `get_generation`. |
| `enhance_image` | Upscale (2× or 4×) or remove the background of one image. **Spends money.** Inpainting needs a painted mask, so it is app-only. |
| `import_manuscript` | Create a novel or nonfiction book from existing text, split into chapters at its headings. |
| `create_storyboard` / `get_storyboard` / `update_shot` | Plan shots from an idea or a screenplay with a writer model (look, look bible, seed, continuity incl. start-and-end frames, output size, upscaler, approval, paid-video limit), read the storyboard with each shot's review state and check results, edit a shot and its continuity details (scene, cast, location, action, dialogue, start/end state, what must not change, video or free still, lock). |
| `import_shot_plan` | Import a complete shot plan written in the chat, without a paid writer call. Use `create_storyboard` with `plan:false` first. |
| `production_readiness` | Check required assets, local models, NVIDIA runtime, ffmpeg, requested finishing tools and budget before production. |
| `review_shot` | Accept, flag or reject a shot's clip, or approve its frame before video is paid for. |
| `render_still_shot` | Render a free still shot (the frame with a slow camera move) locally. |
| `voice_dialogue` | Record a shot's dialogue in each character's voice. **Spends a little.** |
| `estimate_film_cost` | Price everything a storyboard still needs and whether it fits the budget. Free. |
| `inspect_video` | View up to six timestamped video thumbnails plus technical metadata, without generation or edits. Supports visual review before accepting a shot; samples do not prove motion correctness. |
| `openrouter_credit_status` | Read-only current-key allowance/usage and timestamp; account-wide credits explicitly unavailable without a management key. Unknown allowance blocks new paid OpenRouter jobs. |
| `budget_status` / `decide_approval` | Read limits, spending and pending approvals; approve only if the user allowed MCP approvals in the app. |
| `refresh_models` | Re-read OpenRouter's public model list and prices. Free. |
| `generate_shot` | Make one shot's still frame or video clip. **Spends money; clips are slow.** |
| `generate_storyboard_shots` | Queue frames or clips for every shot at once (they run in the background); follow with `get_storyboard`. |
| `produce_film` | Make every missing frame, clip, still shot and voice line and finish the film in the background. With approval on it stops twice for review. **Spends money; call `estimate_film_cost` first.** |
| `enhance_video` | Upscale any video to 2× or to 1080p/1440p/4K: fast GPU scaling, Real-ESRGAN anime-video or x4plus. |
| `import_video` | Add an MP4 from this computer to a project's library (local connections only). |
| `interpolate_video` | Rebuild in-between frames with RIFE on the GPU so a video plays at a chosen frame rate (e.g. 12 → 24 fps, or 24 → 60). RIFE is installed from the app (Storyboard → Picture quality → Smooth). |
| `join_storyboard` | Join the clips into one MP4 in the background and wait up to 8 minutes for it (needs ffmpeg on the computer running Lumina). |
| `export_book` | Save PDF, EPUB, Word, Markdown or an audiobook and return its path. `fixedLayout: true` makes a fixed-layout EPUB for a picture book. |
| `film_next_step` | Guided film making: looks at a storyboard and proposes the one next stage (plan, frames, approve frames, animate, review, voices, fix, join, done) with a plain question and `choices`, each an exact tool call to make once the user agrees. Includes preview images. Free; never changes anything itself. |
| `film_checklist` | Text checklist of what is left per shot (frame, clip, review, voices, dialogue overrun) plus the cost estimate for what is missing. Free. |
| `preview_shot` | One shot as a person would see it: summary, frame, a six-frame contact sheet of its clip and each recorded dialogue line as audio. Free, read-only. |
| `preview_storyboard` | Status of every shot plus one numbered contact sheet: `kind` `frames` (default) or `clips` (middle frame of each clip). Free, read-only. |
| `watch_jobs` | Queued and running jobs of a project with percent done and time left. `waitSeconds` (up to 60) waits and returns when a job starts, finishes or advances. Free, read-only. |
| `cancel_job` | Cancel a queued job (any provider) or a running local-model job. A paid job already sent to a provider cannot be stopped and is still billed. |
| `plan_storyboard` | Have the storyboard's writer model plan its shots (a small writer cost; refused under a strict budget, where you write the list and use `import_shot_plan`). `replace: true` discards existing shots. |
| `adjust_shot_look` | Colour-grade one shot (`brightness`, `contrast`, `saturation`, `warmth`, or `reset: true`). Free; applied when the film is joined. |
| `move_shot` | Move a shot to another position (1 = first); the others shift. Rejoin afterwards. |
| `set_shot_timing` | Anime exposure for a shot, applied when the film is joined: `timing` `twos`/`threes` holds each drawing 2/3 frames at the film's frame rate, `ones` a new drawing every frame, `auto` (default) leaves the clip alone; `holds` `[{start, seconds}]` freezes the picture for a span (seconds from the shot start, after the trim). Twos/threes/holds skip RIFE smoothing for the shot, and anime storyboards do not auto-smooth `auto` shots (a shot's own `interpolate` still works). Not applied to the camera move of a free still shot. Free; no review reset. Same as `update_shot` with `details.timing` / `details.holds`. |
| `trim_shot` | Skip the start of a shot's clip (`trimStart`, 0-10 s) and/or change its length (`duration`, 1-30 whole seconds). The clip is not regenerated. Free. |
| `set_character_voice` | Set a character's speech model and voice. New dialogue uses it; lines already recorded keep the old voice. `revoice: true` queues the character's unrecorded lines now (a little per line). |
| `list_shot_takes` / `select_shot_take` | Every frame and clip a shot has had (generated, repaired, attached, lip-synced) with the current one flagged; switch to another. `select_shot_take` is also how to undo a bad revision: pick the previous take. Review goes back to pending and a chosen clip is re-checked. Free. |
| `attach_clip_to_shot` | Use a video from the project library (for example from `import_video`) as the shot's clip. It becomes a clip take. |
| `repair_frame` | Repaint one box (`[x1, y1, x2, y2]`, fractions of the frame) of the shot's frame with an inpaint model. The result is a new frame take that is not selected; choose it with `select_shot_take`. Refuses with a clear message when no inpaint-capable model is ready. May spend credits on a paid inpaint model. |
| `rerecord_line` | Re-voice one dialogue line (`lineIndex` from 0), optionally with a new acting direction in `style`. Only that line is queued; its timing is kept. A little per line unless the voice is local. |
| `set_line_timing` | When a dialogue line starts (seconds into the shot; `null` = automatic). Same as `update_shot` with `details.dialogue[i].start`; the recording is kept and, because only timing changes, a locked shot is allowed and its review is not reset. |
| `export_production` | Write an editable folder: every shot's selected frame and clip, dialogue recordings, music, `timeline.json`, `timeline.edl` (CMX 3600, 24 fps) and `subtitles.srt`. Returns the folder and files. |

Example request in Claude Code: *"In Lumina, make a 12-page picture book about a fox who's afraid of water. Draft
the bible and pages, show me the text, then illustrate page 1."*

### What a client sees before it calls anything

- **Server instructions.** On connect, the server sends a short playbook (film workflow, budget rules, lip sync off by
  default, anime is English only, one GPU job at a time, use `watch_jobs` instead of polling). The local and the remote
  (claude.ai / ChatGPT) endpoints send the same text.
- **Tool annotations.** Every tool has a title and `readOnlyHint`, `destructiveHint`, `idempotentHint` and
  `openWorldHint` (true when it may call a paid provider). Replacing tools (`import_shot_plan` with `replace`,
  `plan_storyboard`, `plan_pages`, `outline_book`, `draft_bible`, `draft_chapter`, `bake_character`, `cancel_job`) are
  marked destructive. Each description ends with its cost and the usual next tool.
- **Prompts.** `make_anime_short` (idea, minutes, characters), `fix_a_shot` (storyboardId, shotId, problem) and
  `finish_film` (storyboardId) return a step plan that uses the real tool names.
- **Errors.** A failed call returns `isError` with the app's message plus a `Hint:` for common cases: 402 (budget or
  approval: `budget_status`, `decide_approval`), 409 (busy: `watch_jobs`; lip sync off; locked), 422 (lip sync needs
  `mouthBox`), 428/501 (something must be installed: ffmpeg, RIFE, Real-ESRGAN, local models), 404 (stale id).
- Paid work is gated by budget approvals only. The app's "confirm spend" dialog (HTTP 428) does not apply to MCP. After
  `decide_approval`, repeat the identical call; the approval is matched automatically.

## Interactive filmmaking in chat

The interactive tools let a chat client walk you through a film one decision at a time, show what was made, and
change it afterwards. Previews are free and read-only. Anything that spends money still follows your budget and
approval settings.

Example conversation (the tool calls are what Claude makes for you):

1. *"Continue my storyboard 'Harbor Night'."* Claude calls `film_next_step`. It answers that 3 shots have no frame
   yet and asks: "Make the still frames now? Estimated cost of everything still missing: $0.12." You say yes, and
   Claude makes the call listed in the first choice (`generate_storyboard_shots` with `kind: "frames"`).
2. *"How is it going?"* Claude calls `watch_jobs` with `waitSeconds: 30` and reports the running jobs with percent
   done and time left, then that nothing is running once they finish.
3. Claude calls `film_next_step` again. It now shows the frames as a contact sheet and asks whether to approve
   them. You approve (`review_shot`), then animate (`generate_storyboard_shots` with `kind: "clips"`), and
   `watch_jobs` follows the clips.
4. *"Show me shot 2."* Claude calls `preview_shot`: the summary, the frame and a six-frame contact sheet of the clip.
5. *"Make shot 2 darker."* Claude calls `adjust_shot_look` with `brightness: -0.1`. The reply shows the saved grade
   and notes that it appears when the film is joined.
6. *"Looks good, put it together."* Claude calls `join_storyboard`. `film_next_step` then reports the film is done.

Notes:

- `film_next_step` proposes one stage at a time. Its `choices` are suggestions; nothing runs until Claude makes the
  call after you agree. `film_checklist` gives the whole list at once instead.
- A colour grade is a shot setting, `details.grade`: `brightness` -0.3 to 0.3, `contrast` 0.5 to 1.5, `saturation`
  0 to 2, `warmth` -1 to 1 (neutral is 0, 1, 1, 0). It is applied only when the film is joined, so rejoin to see
  it. Values you send are merged into the shot's current grade.
- `move_shot` and `trim_shot` also need a rejoin to show up in the film.
- `cancel_job` works on queued jobs for any provider. A running job can be stopped only if it runs on this
  computer (local or mock providers). A paid job already sent to a provider cannot be stopped.
- `set_character_voice` does not change recordings that already exist. To re-record a line, use `rerecord_line`.
- Clip checks now also flag **flicker** (brightness jumps that bounce back) and **character-area colour drift**
  (the colours of the middle/upper part of the frame change a lot, which can mean costume or hair colour drift).
  They only warn, never fail a shot, and do not check who is on screen (no identity check).
  Every check in a shot review now carries `status`: `passed`, `failed` or `unavailable` (could not run, or nothing can verify it). Unavailable is never a pass. Anime shots with a cast always include `character-identity: unavailable`, because the colour check measures colour, not who it is.

### HTTP routes behind these tools

The tools use the same local API as the app. New or changed routes:

| Route | Purpose |
| --- | --- |
| `GET /api/generations/:id` | Now includes `progress` while the job is running. |
| `GET /api/projects/:id/active-jobs` | Queued and running jobs of a project, with progress for running ones. |
| `POST /api/generations/:id/cancel` | Cancel a queued job (any provider) or a running job on this computer (local/mock providers). Otherwise it answers 409, including for a paid job already sent to its provider. |
| `GET /api/shots/:id` | One shot with its details. |
| `GET /api/storyboards/:id/contact-sheet?kind=frames` or `clips` | One JPEG with every shot's frame, or the middle frame of each clip. 404 when none exist yet. |
| `GET /api/shots/:id/contact-sheet` | One JPEG with six timestamped frames of the shot's clip. |
| `GET /api/shots/:id/takes` | `{frames, clips}`: every take with `assetId`, `path`, `createdAt`, `generationId`, `source`, `current`. |
| `POST /api/shots/:id/takes/select` | `{kind: 'frame' \| 'clip', assetId}`: make a take current (review reset to pending, clip re-checked). |
| `POST /api/shots/:id/attach-clip` | `{assetId}`: attach a library video of the same project as the shot's clip. |
| `POST /api/shots/:id/repair-frame` | `{box, instruction, provider?, model?}`: inpaint a box of the frame; 202 with a generation whose result is a new frame take. |
| `POST /api/shots/:id/dialogue/:index/rerecord` | `{style?}`: re-voice one line. |
| `POST /api/storyboards/:id/export-project` | Write the editable production folder; returns `{folder, files}`. |

## Set up

Where Lumina keeps its data decides which app the tools talk to:

- Desktop app: `~/.config/Lumina Studio` (found automatically).
- `npm start` from the repository: the repository folder (found automatically when the desktop app has never run).
- Anything else: set `LUMINA_DATA_DIR` to the folder that contains `data/`.

### Claude Code

The installed desktop binary provides MCP directly (version 0.9.2 onward):

```bash
claude mcp add -s user lumina-studio -- "$HOME/Applications/Lumina-Studio.AppImage" --mcp
```

For a `.deb` installation use `/opt/Lumina Studio/lumina-studio --mcp` as the command. No repository checkout or separate Node install is needed for this desktop helper. It uses the running app's authenticated API and can open the desktop app on the first tool call. The helper requires a Linux desktop session; for a headless environment use the source Node server below.

Source/development setup:

```bash
claude mcp add -s user lumina-studio -- node /path/to/lumina-studio/mcp/server.js
```

Check it with `claude mcp get lumina-studio` (should show `✔ Connected`). In a Claude Code session, `/mcp` lists
the tools.

To point it at a specific data folder:

```bash
claude mcp add lumina-studio --env LUMINA_DATA_DIR=/path/to/data-root -- node /path/to/lumina-studio/mcp/server.js
```

### Claude Desktop

For the installed AppImage, add this to `claude_desktop_config.json` (replace the username/path):

```json
{
  "mcpServers": {
    "lumina-studio": {
      "command": "/home/YOUR_USER/Applications/Lumina-Studio.AppImage",
      "args": ["--mcp"]
    }
  }
}
```

For source/development setup:

```json
{
  "mcpServers": {
    "lumina-studio": {
      "command": "node",
      "args": ["/path/to/lumina-studio/mcp/server.js"]
    }
  }
}
```

### Codex (GPT-6 Astra as the orchestrator)

Any MCP client can drive Lumina; with Codex, GPT-6 Astra plans the work and calls Lumina's tools:

```bash
codex mcp add lumina-studio -- node /path/to/lumina-studio/mcp/server.js
codex -m gpt-6-astra
```

Codex asks before each MCP tool call. To let a non-interactive run (`codex exec`) call Lumina's tools without
asking, approve them for that run only:

```bash
codex exec -m gpt-6-astra -c 'mcp_servers.lumina-studio.default_tools_approval_mode="approve"' \
  "Import ~/clips/fight.mp4 into a new Lumina project and interpolate it to 60 fps."
```

Tested 2026-10-12: GPT-6 Astra created a project, imported a 6 fps anime clip and rebuilt it to 24 fps with
`interpolate_video`; GPT-6 Sol and GPT-6 Luna did the same task, and all results were identical frame for frame to the same calls made by Claude.

Node.js 22.13 or newer is required. Run `npm install` in the repository first so the MCP SDK is present.

## Version 0.9.1 anime production

For a strict $12 profile, turn on **Settings → Budget → Use $12 anime budget**. This profile checks known prices,
rejects requests without a known unit price, counts existing spending, sets a $2 per-request limit, requires approval
above $1, and reserves $1 for retries. MCP clients cannot change these limits or approve spending by default.
Estimates can differ from provider charges, so configure a provider-side prepaid credit cap or hard limit of at most
$12 on a dedicated account. Lumina cannot guarantee against bad generation or prevent a provider from invoicing more
than the estimate; without the provider-side cap, the $12 setting is not an invoice guarantee.

Write the screenplay and shot plan in ChatGPT or Claude, call `create_storyboard` with `plan:false`, then import the
plan with `import_shot_plan`. Assign local models per shot using `details.model` values such as
`local|animagine-xl-4` for anime stills and `local|wan2.2-ti2v-5b` for video. Use `local|kokoro-82m` for local
speech. The weights and runtime must be installed on the Lumina computer; Wan needs a supported NVIDIA GPU and
substantial model storage. Local inference avoids provider API charges but uses local compute and power. Call
`production_readiness` and `estimate_film_cost`, clear blockers, review and approve the estimate and frames, then
produce and review the clips. Lip sync is excluded and is not enabled by default. See
[docs/SHIPPING_ANIME.md](SHIPPING_ANIME.md) for settings, model setup, finishing steps and release verification.

## Not yet

- **Replacing a section of a clip** (`replace_clip_section`) is not available. Repair the frame with `repair_frame`
  and generate a new clip instead.
- **Pose or keyframe control**: local Wan has no end-frame support here, so a clip cannot be steered to end on a chosen
  pose. Hosted models with last-frame support can (`continuity: keyframes`); local ones cannot yet.
- Lip sync is not redone automatically after `rerecord_line` or a changed `set_line_timing`; call `lip_sync_shot` again.

## Verified

`tests/mcp.test.js` starts Lumina with the offline mock provider, connects a real MCP client over stdio, and calls
every tool: create a project, generate, edit, add to canvas, run the canvas, plus the error paths for a missing key
and for Lumina not running.

A real Claude Code session (`claude -p`) called `list_projects` and `list_models` against the installed AppImage.
The app was closed at the start and the MCP server opened it. Claude Desktop has not been tried.

## claude.ai and ChatGPT (remote access)

claude.ai connectors and ChatGPT apps call MCP servers from their own cloud, over HTTPS. Lumina has a remote endpoint
for them that keeps everything on your computer:

- Lumina serves **MCP over Streamable HTTP** at `/mcp` on `127.0.0.1:<port>` (default 8787). It exposes the same tools
  as the local server, except that remote clients can't choose where exported files are written.
- The same address serves the **Lumina website**: visitors sign in at `/login` with the Lumina account (30-day
  sign-in cookie, HttpOnly, Secure, SameSite=Strict) and then use the normal app; cross-site writes are refused.
- Clients sign in with **OAuth 2.1**: metadata discovery, dynamic client registration, authorization code with PKCE,
  1-hour access tokens and rotating 30-day refresh tokens. Only hashes of tokens are stored.
- The approval page asks you to sign in with your **Lumina account** (one username and password, created in
  Settings → Remote access; the password is stored as a salted scrypt hash). Eight wrong sign-ins in ten minutes lock
  sign-in for ten minutes. Changing the password, or Settings → *Disconnect all*, revokes every client, token and
  website sign-in.
- `search` and `fetch` tools in OpenAI's compatibility shape (ids like `chapter:<uuid>`) let ChatGPT connectors and
  deep research find and read your projects, books, chapters, storyboards and characters.
- Lumina must be open for the connector and website to work.

### One click: Host Lumina online

The HTTPS tunnel makes your locally running Lumina site and MCP endpoint reachable from ChatGPT or claude.ai; it
does not sign those services in for you. Create a Lumina account, connect the `/mcp` endpoint using OAuth, then
approve access on Lumina's consent page by signing into that Lumina account. The chat client itself remains signed
in separately in its own product.

Settings → Remote access → **Put Lumina online** starts a Cloudflare *quick tunnel* (`cloudflared tunnel --url …`, no
Cloudflare account needed) and turns remote access on at the address it gets. If `cloudflared` isn't installed, Lumina
asks, then downloads Cloudflare's official Linux build from GitHub into its data folder (`bin/cloudflared`).

1. Create your Lumina account (username and password) at the top of Remote access, then press **Put Lumina online**. The card shows the **website** and the **Claude connector URL** (`https://….trycloudflare.com/mcp`).
2. **Website:** open the address in any browser or phone and sign in with your account.
3. **claude.ai:** Settings → Connectors → *Add custom connector* → paste the connector URL. When the approval page opens,
   sign in with your account and press Approve.
   **ChatGPT:** Settings → Apps & Connectors → Advanced → developer mode, then Create a connector with the same URL
   (authentication: OAuth) and approve by signing in.

Quick-tunnel addresses are random and change every time Lumina goes online (Lumina reconnects automatically at
launch if it was online when closed), so re-add the connector after a restart. For a permanent address use your own
tunnel below.

### Your own tunnel (permanent address)

1. Start a tunnel to `http://127.0.0.1:8787` (a named Cloudflare tunnel, `tailscale funnel 8787`, `ngrok http 8787`…).
2. Settings → Remote access → *Use your own tunnel instead*: paste the address, press **Turn on remote access**.
3. Add the connector URL in claude.ai or ChatGPT as above.

### Verified

`tests/remote.test.js` runs the whole flow a cloud client performs against a real Lumina instance: the 401 challenge
with `resource_metadata`, discovery, registration, the consent page (a wrong code is rejected, the code works only
once), a PKCE token exchange (a wrong verifier is rejected), MCP tool calls over HTTP (including an inline image),
refresh-token rotation, and revocation.

The same file checks one-click hosting with a stand-in tunnel program: the tunnel address becomes the public URL,
the website redirects to `/login`, a wrong password is refused, the right one signs in, the app and its API work through
the proxy, cross-site writes are refused, changing the password needs the current one and signs the website out, and going offline stops everything.

On 2026-10-06 the real Cloudflare quick tunnel was run from a test instance: cloudflared was downloaded by the app,
the public address answered from the internet (login redirect, sign-in, the app, OAuth metadata), and an MCP client
completed registration, approval and PKCE over the public address, then listed 38 tools, made an image,
planned a storyboard, queued its clips and joined them.

On 2026-10-07 a real ChatGPT connector signed in (dynamic registration, token, refresh) but stopped with "action
discovery failed". In response Lumina added the `search` and `fetch` tools ChatGPT connectors require, lists tool
schemas without the `$schema` keyword, and advertises `offline_access`; ChatGPT's request sequence (resource set to the
site root, an immediate token refresh, initialize, tools/list) was replayed against Lumina and succeeds. ChatGPT itself
has not been re-tried since.

Version 0.9.1 release limitation: no actual signed-in ChatGPT connection or paid Seedance render was tested. The
OAuth and tunnel checks above used an MCP client and simulated ChatGPT's request sequence; they do not confirm the
ChatGPT product's signed-in end-to-end behavior. No paid cloud job was submitted. Those acceptance checks still
require the relevant account and provider setup. If a connection fails, the Lumina log shows the request.

## Creative director

The AI connected through MCP (Claude or ChatGPT) is Lumina's creative director. No paid writer or director
model is needed. Under a strict budget, the recommended workflow is:

1. Call `create_storyboard` with `plan: false`, then write and save the shot plan with `import_shot_plan`.
2. Read `get_director_brief({storyboardId, offset: 0, limit: 6})`. It returns the idea and screenplay, look and
   look bible, settings, all library characters and locations (names, descriptions, designTags, voices, reference
   asset ids and bake status), and a page of shots with camera, duration, timing/holds, dialogue, states, saved
   overrides and the exact composed frame/clip prompts. Follow `nextOffset` until it is null.
3. Write prompts with `direct_shot`, or use `direct_storyboard` to save many directions atomically. No model is
   called. All shot ids, storyboard membership, fields, locks and prompt lengths are validated before saving.
4. Check `preview_prompts({shotId})` or `preview_prompts({storyboardId, offset, limit})`, then use `generate_shot`
   when ready. Storyboard previews use the same pagination as the brief (default 6, maximum 60 shots).
   Prompt previews do not generate media or spend credits. Normal generation budget rules still apply.

For example:

```json
{
  "shotId": "<shot id>",
  "framePrompt": "Pip beneath an immense indigo sky, tiny against the reeds.",
  "clipPrompt": "One ripple spreads while Pip watches, ears lifting slowly.",
  "negativePrompt": "extra tails, extra people",
  "camera": "locked-off",
  "keepAutomatic": true
}
```

`direct_storyboard` accepts `{storyboardId, shots: [{shotId, framePrompt, clipPrompt, ...}]}` with 1–60 unique
shots, all belonging to that storyboard. A missing shot, locked shot or invalid entry leaves the entire batch
unchanged. The optional `motion` chooses a supported local still-shot camera move, such as `push-in`.

Directions are stored in shot details as `directorFramePrompt`, `directorClipPrompt`, `directorNegative` and
`directorKeepAutomatic`. Unspecified fields retain their values. Automatic composition is enabled by default:
Lumina replaces the shot's descriptive text with your direction and retains the look, look bible, identity
and consistency blocks, plus the applicable camera/style presets. Character designTags and reference/bake
handling still apply. Setting a prompt to `null` restores its normal automatic composition; setting
`negativePrompt` to `null` clears exclusions. Clearing both positive prompts restores both automatic prompts.
Directions follow the existing story-edit rules: frame approval clears, clip review becomes pending, and
locked shots must first be deliberately unlocked with `update_shot`. Existing media/takes are retained.

With `keepAutomatic: false`, each overridden positive prompt bypasses automatic text, camera/style presets,
character reference attachments and baked character LoRAs. The clip still uses its start/end frame. Prompts
without an override continue to compose automatically. Generation's existing outer-whitespace trimming still
applies. Because the job/provider interface has no separate negative-prompt channel, exclusions are rendered
as `Avoid: ...` in automatically composed prompts and are omitted for verbatim positive overrides; include
any desired exclusions in your verbatim text itself. Prompts plus automatic text must fit generation's
4,000-character input limit; identity and preset text appended by generation can make the final prompt longer.

The previews match generation's `finalPrompt` for the current storyboard settings and image model, including
camera/style fragments and character-reference wording. Overriding the model when calling `generate_shot`
can change that reference wording. Providers may further interpret or transform prompts internally.
For standalone `generate_image`, write the prompt directly and omit its optional `director` model parameter.

The corresponding local API routes are `GET /api/storyboards/:id/director-brief`,
`GET /api/storyboards/:id/prompts`, `GET /api/shots/:id/prompts`, `POST /api/shots/:id/direct`, and
`POST /api/storyboards/:id/direct`. The storyboard GET routes accept `offset` and `limit`.

## Local models

Five tools inspect the computer running Lumina, through its authenticated API. They never download weights,
install packages, launch inference or enumerate application processes (including Ollama). Licences below are
reported from the repository's model/setup metadata; check the upstream terms before distribution.

| Tool | Behaviour | API |
| --- | --- | --- |
| `local_status` | GPU name, used/total VRAM, temperature, draw/limit in watts and utilisation; free/total RAM and disk at `<dataRoot>/data`; running/queued Lumina GPU jobs; worker visibility. | `GET /api/local/status` |
| `list_local_models` | Installation checks, size in bytes, purpose, licence and the setup script or exact installation API request for every model. Reads existing files only. | `GET /api/local/models` |
| `free_gpu_memory` | Stop idle Lumina workers, then report device VRAM before/after. Immediately skip if GPU work is running **or queued**. | `POST /api/local/free-gpu-memory` |
| `gpu_queue` | Running/queued heavy Lumina jobs, enqueue/start timestamps, age since enqueue and age since start in milliseconds. | `GET /api/local/gpu-queue` |
| `preflight` | `{task, options?}` → `go`, `wait` or `no`, with resource thresholds, reasons and the measured status. | `POST /api/local/preflight` |

NVIDIA telemetry uses only `nvidia-smi --query-gpu=name,memory.used,memory.total,temperature.gpu,power.draw,power.limit,utilization.gpu
--format=csv,noheader,nounits`, with a **5 second timeout**. Unsupported values remain `null`; unavailable telemetry
is explicit. Warnings appear below **4 GiB free RAM**, below **20 GiB free disk**, or above **80 °C**. VRAM totals
include other applications, but their names, PIDs and allocations are never queried or changed. Memory units use
GiB (1,073,741,824 bytes); NVIDIA MiB values are converted to bytes.

The inventory covers Wan 2.2 TI2V 5B (Apache-2.0), Animagine XL 4.0 (OpenRAIL++), IP-Adapter Plus SDXL
(Apache-2.0), Kokoro (Apache-2.0), Chatterbox (MIT), the anime face detector (MIT), Real-ESRGAN (BSD-3-Clause),
RIFE (MIT), the face check (YuNet MIT + SFace Apache-2.0), and MuseTalk (MIT, with SD VAE CreativeML Open RAIL-M
and Whisper Apache-2.0 dependencies). MuseTalk is shown even when missing so its setup is discoverable.

HF lookup respects `HF_HUB_CACHE`, then `HF_HOME/hub`, then `$HOME/.cache/huggingface/hub`. Wan/Animagine use
existing provider installation checks, including Wan's shard indexes. Other models require their expected files;
voice models also require the configured voice Python executable to exist. This does not import Python dependencies
or validate model checksums. Sizes include partial downloads and metadata in each model's cache directory, count
symlinked/hard-linked blobs once per model, and exclude shared Python environments. `sizeAvailable:false` means
some files could not be read. Bundled finishing tools and face models are checked under `<dataRoot>/bin` (the
app's actual layout). A Real-ESRGAN executable installed separately on `PATH` can be usable despite the bundled
inventory reporting missing; inventory never executes it.

Run setup scripts manually from a source checkout. The Real-ESRGAN/RIFE and face-check install API requests shown
in the inventory are app-only operations: use the corresponding Lumina UI control. These five tools never call
those install routes. `setup-anime.sh` installs the newer landmark tracker, but the provider's lip-sync readiness
check still requires `lbpcascade_animeface.xml`; the inventory reports its state separately and supplies
`legacyCascadeSetup`. MuseTalk needs that cascade as well as its three HF repositories and voice environment.

Preflight's conservative baseline needs are **free** resources:

| Task | VRAM GiB | RAM GiB | Disk GiB | Maximum temperature |
| --- | ---: | ---: | ---: | ---: |
| `wan-clip` | 12 | 32 | 40 | 80 °C |
| `anime-frame` | 8 | 8 | 20 | 80 °C |
| `bake` | 12 | 24 | 30 | 80 °C |
| `upscale` | 4 | 8 | 20 | 80 °C |
| `interpolate` | 4 | 8 | 20 | 80 °C |

The baseline assumes 1280×704 Wan, 1344×768 anime/baking, and finishing at 1920×1080, 5 seconds, 30 fps.
Optional `width`/`height` (whole pixels, 1–16384) describe the largest working frame; `durationSeconds`
(0.01–86400) and `fps` (1–240) describe finishing output. Larger dimensions scale the VRAM threshold in proportion
to pixel area, never below baseline. Finishing disk needs are the larger of the table floor and
`ceil(width × height × 3 RGB bytes × durationSeconds × fps × 3 working copies / GiB) + 2 GiB`.
Duration/fps affect finishing disk estimates only. Options do not select a model, device or runtime mode.

`no` means insufficient physical GPU/RAM capacity, insufficient free disk, invalid input (HTTP 400), or unavailable
required VRAM/RAM/disk/temperature telemetry. `wait` means temporary VRAM/RAM pressure, heat above 80 °C, or queued/
running Lumina GPU work; a `no` reason takes precedence. `go` means all these resource checks passed. Preflight
uses the first NVIDIA device, never sums VRAM across devices, and does not resolve `CUDA_VISIBLE_DEVICES` mappings.
It is advisory: **it cannot prevent every out-of-memory error**, reserve resources, verify runtime dependencies,
or prove model readiness. Check `list_local_models` too. Driver overhead, task length and other applications can
change the outcome after the snapshot; offloaded Wan modes may run on hardware below these thresholds.

Worker shutdown reuses the provider's GPU lease, which reserves the shared FIFO and waits for its owned worker
processes to exit before subsequent jobs start. It rechecks idleness after loading that hook, so a newly queued
job is never interrupted. No process discovery or external signals are used. VRAM accounting may lag exit or
change because other applications allocate memory; a completed shutdown does not promise a particular reduction.

Two provider hooks would improve visibility but require a change outside this module: a read-only snapshot of
`wan`, `anime`, `voice`, `lipsync` and `train` worker loaded/pending/stopping states, and job metadata when submitting
to `gpuQueue.run`. Until those exist, worker `loaded` is explicitly `null` (`workers.available:false`), shutdown
cannot name which workers were unloaded, and existing anonymous GPU callbacks use the generic “Lumina GPU job”
label. Queue job IDs are transient and distinct from generation IDs. CPU-only or other work outside the shared
GPU queue is not represented. The existing ten-minute worker idle timers remain in effect.

## Media tools

Direct media tools work on library asset ids and save new copies. Local work is free; paid paths use the existing
`/api/generate` route, keeping budget approvals and app confirm-spend checks. A **402 means stop**: inspect
`budget_status`, obtain the user's approval, and retry only the refused request. Never repeat already queued batch
items. Box masks and outpaint canvases keep stable ids across approval retries.

| Tool | Inputs and behavior | Cost |
| --- | --- | --- |
| `upscale_image` | `assetId`, `scale` 2/4, `engine` `local-anime` (default), `local-photo`, or `fal`; returns a new asset id with its source as parent and an inline image when small enough | Installed local Real-ESRGAN is free GPU work; fal is paid |
| `upscale_video` | `assetId`, `height` 1080/1440/2160, `engine` `anime` (default)/`ai`/`fast`; existing enhancement job with status/wait URLs. `waitSeconds` 0–60 (default 1); `checkOnly:true` waits without starting again | Free; local GPU queue |
| `remove_background` | `assetId`; fal BiRefNet cutout | Paid; no local remover is integrated |
| `outpaint_image` | `assetId`, optional `prompt`, `direction` (default `all`), `aspect`, or `padding:{left,right,top,bottom}` in pixels. Padding takes priority; direction extends 25% of source dimensions per chosen side | Paid fal Fill; canvas and mask made locally |
| `inpaint_image` | `assetId`, `prompt`, `mask`: matching-size mask asset id or `{x,y,w,h}` fractions from 0–1. White repaints, black preserves; box is rasterized locally | Paid fal Fill |
| `reframe` | `assetId`, `aspect` `16:9`/`9:16`/`1:1`/`4:5`, `mode` `crop`/`pad`/`outpaint`, optional `focusX`/`focusY` from 0–1 (default centre), optional outpaint `prompt` | Crop/pad: free CPU ffmpeg for images/videos; outpaint: paid, images only |
| `import_media_url` | `projectId`, public HTTPS `url`, optional `label`; checks DNS/private addresses and each redirect, sniffs bytes, saves to library | Free download |
| `import_media_file` | `projectId`, `filePath`, optional `label`; requires a local connection supplying `client.upload`; remote calls are refused before reading files | Free |
| `generate_image_batch` | `projectId`, 1–8 `prompts`, shared `generate_image` options (provider/model, size, quality, seed, references, director, presets, characters); always queues without waiting | Existing generation pricing and budget rules |
| `generate_video_batch` | `projectId`, 1–8 `prompts`, shared video options (provider/model, input image, duration, aspect, seed, presets, characters); always queues without waiting | Existing generation pricing and budget rules |
| `analyze_video` | `assetId`; scene cuts (`scdet`), black and frozen stretches, EBU R128 integrated LUFS and true peak dBFS (null without audio), dimensions/fps/duration and four inline sample frames | Free, read-only CPU ffmpeg |

Imports accept PNG/JPEG/WebP (25 MB), MP3/WAV/OGG/FLAC (80 MB), and MP4 (300 MB). File extensions and declared
Content-Type are never trusted. URL imports allow at most five redirects and a two-minute download. Reframing and
working masks are capped at 32 million pixels and 16384 pixels per side; H.264 reframing uses even dimensions.
Video crop/pad preserves timing and transcodes audio to AAC. Prepared outpaint canvases/masks are working assets.

Real-ESRGAN must already be installed through Lumina; these tools never download models. Image upscaling and video
enhancement use the shared GPU queue. Photo 2× upscaling uses native x4plus 4× then Lanczos downscaling. Paid image
tools wait at most 60 seconds, then return the generation handle for `get_generation`/`watch_jobs`. Large images
follow the existing inline-size limit. Batch failures return `isError`, the HTTP status, the failed prompt index
(`stoppedAt`, zero-based), already queued `jobIds`, and approval details when present.

Analysis uses heuristic thresholds (scene score 10, freeze minimum 0.5 s, black minimum 0.3 s). Detections and four
samples support human review; they do not establish motion quality, audio sync, or absence of artifacts. No paid
provider or actual GPU execution is covered by the offline media tests; the upscale test uses a fake executable.

## Voice tools

All six tools are free and local:

| Tool | Inputs and result |
| --- | --- |
| `create_voice` | `name`, `audioAssetId`, `consent: true` → saved voice metadata with an id such as `custom:my-voice`. |
| `create_voice_from_confirmed_audio` | Alias of `create_voice`, with the same required consent. |
| `list_custom_voices` | Lists saved voice metadata, source asset ids and consent timestamps. |
| `delete_custom_voice` | `id` → removes the voice and its saved reference copy. |
| `voice_change` | `audioAssetId`, `targetVoice` → a new audio asset in the source project, plus inline audio. |
| `speak_line` | `projectId`, `text`, optional `voice`, `style`, `engine` → inline audio and `assetId`. Engines: `kokoro` (or `kokoro-82m`) and `chatterbox`. |

Use only your own voice or a voice you have permission to use. Creation refuses missing or false
consent. Supply a clean speech clip from the library, 5–30 seconds long. Preparation trims leading and
trailing silence, normalizes loudness to -20 LUFS, and saves mono 24 kHz PCM WAV. The trimmed reference
must also be 5–30 seconds. No training or downloads are needed. Duplicate slugged names are refused;
choose a different name. Speech quality, speaker count and permission cannot be verified automatically.

Voices persist under `<Lumina data root>/storage/custom-voices/<slug>/` as `reference.wav` and
`voice.json`, independently of the original asset. `list_voices` includes the ids in the local
Chatterbox catalog. To cast one explicitly, use `set_character_voice` with
`provider: "local", model: "chatterbox", voice: "custom:my-voice"`. Custom ids are also accepted by
local Kokoro selections so existing default speech tools preserve them; synthesis automatically uses
Chatterbox for those ids. Presets continue to use their selected engine. Custom voices do not apply to
cloud providers. Deleting a voice keeps existing recordings; saved character settings must be updated
before recording that voice again.

`voice_change` uses the installed package's `chatterbox.vc.ChatterboxVC` audio-to-audio API with
`from_local` and cached model weights. The source performance drives conversion without transcription.
Timing and acting preservation depend on the model; sample-exact timing and an identical performance
are not guaranteed. Targets can be custom ids or local preset names (the latter use a Kokoro reference).
If the installed package lacks a usable conversion API, or its environment/weights are missing, the
request reports unavailable with a reason (HTTP 501). It never substitutes transcription and TTS.
The checked voice environment includes this real conversion API; GPU inference quality was not tested.

Chatterbox speech and conversion use the shared GPU queue, one heavy job at a time, and preserve the
model's AI watermark. Kokoro presets run on CPU. Set `LUMINA_VOICE_PYTHON` to the voice environment's
Python, or use `~/.local/share/lumina-studio/voice-env/bin/python`. `NUMBA_CACHE_DIR` can override the
worker's writable Numba cache (defaults under the voice cache). `speak_line` waits up to four minutes;
if still queued/running, it returns the generation status so it can be followed with `get_generation`.

API counterparts: `GET/POST /api/voices`, `DELETE /api/voices/:id` (URL-encode the id), and
`POST /api/voice-change`. `speak_line` uses the existing speech generation and wait endpoints.
