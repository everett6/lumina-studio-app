# Lumina Studio

**Version 0.9.10** adds voice tools for AI chats (list_voices, preview_voice; local Kokoro voices are free), honours "smooth to 30 fps" on anime storyboards, plus Bake character (a per-character LoRA trained on your GPU), a stronger MCP server, and character sheets that keep anime characters on-model and theatrical anime lip sync (five mouth shapes timed to the words). It also asks before spending paid credits (Confirm & spend) and makes Lumina easier to drive from an AI chat (MCP): live previews (frames, clip contact sheets, dialogue audio), a step-by-step film wizard, job progress and cancel, and edit-by-chat tools (shot look, order, trim, character voice). See [docs/MCP.md](docs/MCP.md). Anime production: [docs/SHIPPING_ANIME.md](docs/SHIPPING_ANIME.md).

Lumina Studio is an open-source, Linux-first creative workspace for AI images. Bring your own API keys for OpenAI,
fal.ai, Google Gemini or Replicate. Generate and edit images, keep everything in local projects, build reusable
workflows on a node canvas, and let Claude drive it through MCP.

Everything runs on your computer. Keys go only to the provider they belong to; images and projects stay in a local
database and folder.

## What works

| Area | Status |
| --- | --- |
| Generate and edit images | Text-to-image, edits with up to 4 input images, variations, retry on failure. |
| Presets | 45 original presets with animated preview tiles: 20 camera moves (dolly, orbit, crane, FPV, dolly zoom…), 9 effects (slow motion, time-lapse, rain, fog…) and 16 styles (cinematic, noir, anime, clay…). One click adds them to an image or video prompt. **Animate** and **Remix** buttons on every result. |
| Characters and locations | Save a person, creature, product or **location** once (name, what must never change, up to 6 reference photos, a **voice** for dialogue) and add it to any image, video or storyboard shot. The look is added to every prompt; the photos are sent to models that accept input images. **Lock** a look once it is right so nothing changes it by accident. |
| Image tools | Upscale 2× or 4× (Real-ESRGAN), remove background (BiRefNet), inpaint with a brush, and extend an image to a new shape (FLUX.1 Fill), all through fal.ai. Available on any result and in the library. |
| Storyboard and films | Idea or **screenplay** → shot list (scene, cast and location per shot, action, dialogue, start and end state, camera move, length) → an approved still frame per shot → a clip per shot (or a **free still shot** with a slow camera move) → one finished film. **Produce film** runs it all to the end. Up to 60 shots and 15 minutes. |
| Continuity (anti-drift) | Every frame and clip prompt carries the same **look** (live action or anime), **look bible**, **seed** and the shot's cast and location references; **start-and-end-frame** mode makes a clip run from its own approved frame to the next shot's frame; **continuous** mode chains clips. After every clip, free local checks compare it with its approved frames (drift), check colour stability, length, black or frozen picture and sound, and — with the optional **face identity check** (open OpenCV YuNet + SFace models, a one-time 39 MB download) — whether each person still matches their reference photos. Shots are **colour-matched** to their scene's first shot when the film is joined, and a **timeline** shows every shot, dialogue line (with overruns), music and ambience to scale. **Approval mode** stops for you to approve frames before any video is paid for, and clips before the film is joined. Locked shots keep their story. |
| Sound | Dialogue spoken in each character's voice (or a narrator's) placed at its time in the shot and levelled to match, an uploaded **music** bed that ducks under speech, an **ambience** bed, the clips' own sound, and a limiter. Remixable without touching the picture. |
| Picture quality | Working files are near-lossless (x264 CRF 10 / NVENC CQ 12); every clip is enlarged **once, from its original**, straight to the delivery size (720p to 4K) with Real-ESRGAN (**anime-video model** or x4plus for live action) or sharp Lanczos; optional RIFE smoothing to 30 fps; one final encode with a crossfade-safe exact timeline. Uses NVIDIA NVENC when available; needs `ffmpeg`. |
| Budget | Optional hard limits (total, per day, per project, per request), priced from OpenRouter's live model list before any paid job starts, reserved and settled with the provider's reported cost; approvals above a threshold; no double billing on retries or restarts. Claude and ChatGPT can never change the limits. |
| Enhance video | Enlarge any video to 2× or to 1080p/1440p/4K: **fast** GPU scaling with libplacebo, or **AI upscaling** with Real-ESRGAN on your GPU — the **anime-video** model for animation or x4plus for live action (downloaded from the official release on first use). DLSS itself only works inside games and RTX Video Super Resolution only during playback, so neither can improve a saved video file. |
| Cost estimates | Create, Canvas and Storyboard show the provider's list price before you run, where the provider publishes one per image, megapixel or second (fal.ai, Gemini, Veo). OpenAI bills per token and Replicate prices were not confirmed, so those show a note instead of a number. |
| Video | Text-to-video and image-to-video: Google Veo 3.1 (standard, Fast, Lite), fal.ai Kling 3 Pro, and through OpenRouter Veo 3.1, Kling 3.0 (Pro, Standard), Seedance 2.0 (and Mini), Grok Imagine (1.5, 1.5 Lite), HeyGen Video, Wan 2.7 and Hailuo 3. Animate picture-book pages. (OpenAI's video API was shut down in September 2026.) |
| Local GPU (no API) | **Wan 2.2 TI2V-5B** (open weights, Apache 2.0) runs on your own NVIDIA GPU through Hugging Face diffusers, with FP8 weights so it fits 12 GB: still frames and 720p, 24 fps image-to-video clips, free and private. Download the model once with `hf download Wan-AI/Wan2.2-TI2V-5B-Diffusers` (34 GB); it then appears as **Local GPU** in every model menu. Tested on an RTX 5070: a frame in about 40 s, a 5-second clip in about 21 minutes. If a job runs out of GPU memory, Lumina moves the model into main memory (streamed to the GPU layer by layer) and finishes the job, slower; set `LUMINA_WAN_LOW_VRAM=1` to start that way on 8 GB cards. |
| Voice | Text to speech for any text, and narration of book pages and chapters: OpenAI gpt-4o-mini-tts and Gemini 3.8 TTS. Audiobook export. |
| Providers | **OpenRouter — one key for images, video and writing** (Nano Banana, GPT Image 2, FLUX.2, Seedream; Veo 3.1, Kling 3.0, Seedance 2.0, Grok Imagine, HeyGen, Wan 2.7, Hailuo 3; Claude, GPT, Gemini, DeepSeek). Also direct keys for OpenAI, fal.ai, Google Gemini, Replicate (images) and OpenAI, Anthropic Claude, NVIDIA Nemotron (writing). Tested against faked provider responses; **not yet run against the live APIs** (see below). |
| Books | **Picture books** (page plan, consistent illustrations, full-bleed or art-above-text layouts), **novels** and **nonfiction** (outline → chapters → scenes or sections, drafted and revised with continuity context), or **import a manuscript** you already have (.txt, .md, .docx) and keep revising or continuing it. Story bible with character looks and reference images, cover art, chapter art, page/chapter history. |
| Book export | Print PDF (optional 0.125 in bleed with trim/bleed boxes; non-Latin scripts via installed system fonts or your own font file), reflowable EPUB 3 and fixed-layout EPUB for picture books, Word (.docx), Markdown, audiobook (MP3 or WAV). |
| Projects and library | SQLite storage, reusable references, audio and video in the library, rename, export to a folder, delete. |
| Canvas | Prompt, reference, director, generate, edit, video and output nodes. Drag to connect, pan and zoom, autosave, undo and redo, built-in templates and templates saved from your own canvases, run all or up to one node. |
| Desktop app | Electron `.deb` and AppImage. Keys encrypted with your system keyring. |
| Claude Code / Claude Desktop | Local stdio MCP server with tools (images, video, voice, presets, characters and locations, image tools, storyboards, film review, cost estimates, budget, canvas, books). See [docs/MCP.md](docs/MCP.md). |
| Host online / claude.ai / ChatGPT | **Settings → Host Lumina online**: one click opens a free Cloudflare quick tunnel and gives you a public `https://….trycloudflare.com` address. Create a **Lumina account** (username + password) in Settings first. Open the address in any browser and sign in to use Lumina as a website, and add `…/mcp` to claude.ai or ChatGPT as a connector (OAuth; you approve by signing in with the same account). Includes the `search` and `fetch` tools ChatGPT connectors require. Lumina downloads Cloudflare's `cloudflared` the first time if it isn't installed. Tested over a real tunnel with an MCP client and from the public internet; **not yet tried from claude.ai or ChatGPT themselves**. You can also bring your own tunnel for a permanent address. |

Every flow in the table has been exercised with the built-in offline mock providers (image, voice, video, writer), in
the browser and through the MCP tools. Real providers have not been called because no API keys were available while this was built. Expect
to fix small request-format differences the first time each provider runs.

## Install the desktop app

Build the packages (needs Node.js 22.13+):

```bash
npm install
npm run dist
```

Then install the `.deb`:

```bash
sudo apt install ./dist/lumina-studio_0.9.10_amd64.deb
```

Or run the AppImage directly:

```bash
chmod +x "dist/Lumina Studio-0.9.10.AppImage"
```

Open **Lumina Studio**, go to **Settings**, paste a key for at least one provider, and press **Test key**.

## Run from source

```bash
npm install
npm start
```

`npm start` prints a link like `http://127.0.0.1:4173/?token=…`. Open that exact link: the token logs your browser
in to this local server. Other commands:

| Command | Purpose |
| --- | --- |
| `npm run desktop` | Run the Electron app from source. |
| `npm run mock` | Dev server with the offline mock provider and mock director (no keys, no network). |
| `npm run desktop:mock` | Desktop app with the mock provider. |
| `npm test` | Test suite (API, jobs, canvas, providers, books and exports, MCP local and remote). |
| `npm run dist` | Build `.deb` and AppImage into `dist/`. |
| `npm run mcp` | Start the MCP server on stdio (normally launched by Claude). |

## Configuration

Keys are best entered in **Settings**. Environment variables (or a `.env` file for `npm start`) also work and show
as "From environment":

| Variable | Purpose |
| --- | --- |
| `OPENROUTER_API_KEY` | OpenRouter (images, video and writing with one key). |
| `OPENAI_API_KEY` | OpenAI images and the OpenAI director. |
| `FAL_KEY` | fal.ai. |
| `GEMINI_API_KEY` | Google Gemini image models. |
| `REPLICATE_API_TOKEN` | Replicate. |
| `ANTHROPIC_API_KEY` | Claude as creative director. |
| `NEMOTRON_API_KEY`, `NEMOTRON_BASE_URL`, `NEMOTRON_MODEL` | Nemotron director (hosted or self-hosted OpenAI-compatible endpoint). |
| `PORT` | Dev server port (default 4173). |
| `LUMINA_DATA_DIR` | Data folder (default: repository folder for `npm start`, `~/.config/Lumina Studio` for the desktop app). |
| `LUMINA_MOCK=1` | Enable the offline mock provider and director. |

## Data and privacy

- Desktop data lives in `~/.config/Lumina Studio`: `data/lumina.db` (SQLite), `data/keys.json` (keyring-encrypted
  keys), and `storage/assets/` (images). Back up that folder to keep your work.
- The dev server uses `data/` and `storage/assets/` in the repository. Keys there are stored in a private (0600)
  file, but not encrypted.
- Projects from Lumina 0.1 (`data/*.json`) are imported automatically the first time the dev server starts. The
  original files are kept as `*.json.imported`.
- **Project → Export** writes a plain folder with `project.json` and the image files.
- The local server listens on `127.0.0.1` only and requires a per-install token. See
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#security-model).

Paid generations can incur provider charges. Lumina estimates and reserves known prices before queuing jobs, but estimates and provider invoices can differ. For the strict $12 anime workflow, use a dedicated provider account with a provider-side prepaid credit cap or hard limit; Lumina cannot cap invoices charged by another service. See [docs/SHIPPING_ANIME.md](docs/SHIPPING_ANIME.md).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, data model, jobs, providers, canvas, security.
- [docs/MCP.md](docs/MCP.md): connecting local MCP clients and web clients through OAuth and a tunnel.
- [docs/SHIPPING_ANIME.md](docs/SHIPPING_ANIME.md): version 0.9.1 anime production workflow and verification limits.
- [docs/ROADMAP.md](docs/ROADMAP.md): what's next and known limits.
- [CONTRIBUTING.md](CONTRIBUTING.md)

## License

MIT. See [LICENSE](LICENSE).

### Production safeguards

MCP `openrouter_credit_status` reads the configured key's remaining allowance without changing its limit. New OpenRouter jobs require a fresh known allowance sufficient for unresolved reservations and the protected retry reserve. Account-wide credits remain unavailable without a management key. Already accepted video jobs are polled rather than resubmitted.

Finishing now interpolates per shot, assembles and mixes at native master size, then upscales the completed film. Upscaling does not blend frames across cuts; unchanged mixed masters reuse their cached upscale. RIFE restores source anchors before encoding and aligns them to the nearest delivery frame. These safeguards do not guarantee artifact-free motion or identity consistency; review the result before buying another take.

Local model generation and GPU finishing share a FIFO queue in each Lumina backend. Model changes wait for the previous worker to exit; quitting waits for queued generation and finishing writes before closing SQLite. Other applications or separate backend processes can still consume GPU memory.

### Connect the installed app to Claude Code

With version 0.9.2 or later, the desktop binary includes its own stdio MCP entry:

```bash
claude mcp add -s user lumina-studio -- "$HOME/Applications/Lumina-Studio.AppImage" --mcp
```

For the `.deb`, use `/opt/Lumina Studio/lumina-studio` as the command. The helper uses the same app, projects, keys and budget; it does not start a second backend. See [docs/MCP.md](docs/MCP.md) for Claude Desktop and web-client setup.

New installs enable the strict $12 budget by default. Explicit existing settings and spending history are preserved; check `budget_status` after upgrading if you previously disabled enforcement. The local remaining budget is not a provider credit balance. MCP `inspect_video` returns bounded timestamped thumbnails and technical metadata for clip review before accepting or purchasing another take.

Local voices (Kokoro and Chatterbox) install with `scripts/setup-voices.sh`, and the anime extras (Animagine, character sheets, Bake character, lip sync) with `scripts/setup-anime.sh`; see [docs/SHIPPING_ANIME.md](docs/SHIPPING_ANIME.md#local-voices).

Finishing measures recorded dialogue from the audio file and pauses if it exceeds its shot, retaining both audio and source clips. Revise the line or extend the shot before resuming; it does not silently cut speech.
