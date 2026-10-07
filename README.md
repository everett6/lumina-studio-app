# Lumina Studio

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
| Characters | Save a person, creature or product once (name, look, up to 4 reference photos) and add it to any image, video or storyboard. The look is added to every prompt; the photos are sent to models that accept input images (GPT Image, Gemini, FLUX Kontext). Video uses the description only. |
| Image tools | Upscale 2× or 4× (Real-ESRGAN), remove background (BiRefNet), inpaint with a brush, and extend an image to a new shape (FLUX.1 Fill), all through fal.ai. Available on any result and in the library. |
| Storyboard | Idea → shot list (written by a text model, with a camera move and length per shot) → a still frame per shot → a clip per shot → clips joined into one MP4. Up to 60 shots and a target length up to 15 minutes, so a **5-minute film** (about 30–40 shots) works; shot lengths follow what the chosen video model can make (e.g. 3–15 s for Kling 3.0 on OpenRouter). Joining runs in the background with progress and needs `ffmpeg` installed. |
| Cost estimates | Create, Canvas and Storyboard show the provider's list price before you run, where the provider publishes one per image, megapixel or second (fal.ai, Gemini, Veo). OpenAI bills per token and Replicate prices were not confirmed, so those show a note instead of a number. |
| Video | Text-to-video and image-to-video: Google Veo 3.1 (standard, Fast, Lite), fal.ai Kling 3 Pro, and through OpenRouter Veo 3.1, Kling 3.0 Pro, Seedance 2.0, Wan 2.7 and Hailuo 3. Animate picture-book pages. (OpenAI's video API was shut down in September 2026.) |
| Voice | Text to speech for any text, and narration of book pages and chapters: OpenAI gpt-4o-mini-tts and Gemini 3.8 TTS. Audiobook export. |
| Providers | **OpenRouter — one key for images, video and writing** (Nano Banana, GPT Image 2, FLUX.2, Seedream; Veo 3.1, Kling 3.0, Seedance 2.0, Wan 2.7, Hailuo 3; Claude, GPT, Gemini, DeepSeek). Also direct keys for OpenAI, fal.ai, Google Gemini, Replicate (images) and OpenAI, Anthropic Claude, NVIDIA Nemotron (writing). Tested against faked provider responses; **not yet run against the live APIs** (see below). |
| Books | **Picture books** (page plan, consistent illustrations, full-bleed or art-above-text layouts), **novels** and **nonfiction** (outline → chapters → scenes or sections, drafted and revised with continuity context), or **import a manuscript** you already have (.txt, .md, .docx) and keep revising or continuing it. Story bible with character looks and reference images, cover art, chapter art, page/chapter history. |
| Book export | Print PDF (optional 0.125 in bleed with trim/bleed boxes; non-Latin scripts via installed system fonts or your own font file), reflowable EPUB 3 and fixed-layout EPUB for picture books, Word (.docx), Markdown, audiobook (MP3 or WAV). |
| Projects and library | SQLite storage, reusable references, audio and video in the library, rename, export to a folder, delete. |
| Canvas | Prompt, reference, director, generate, edit, video and output nodes. Drag to connect, pan and zoom, autosave, undo and redo, built-in templates and templates saved from your own canvases, run all or up to one node. |
| Desktop app | Electron `.deb` and AppImage. Keys encrypted with your system keyring. |
| Claude Code / Claude Desktop | Local stdio MCP server with 38 tools (images, video, voice, presets, characters, image tools, storyboards, canvas, books). See [docs/MCP.md](docs/MCP.md). |
| Host online / claude.ai / ChatGPT | **Settings → Host Lumina online**: one click opens a free Cloudflare quick tunnel and gives you a public `https://….trycloudflare.com` address. Open it in any browser (sign in with a pairing code) to use Lumina as a website, and add `…/mcp` to claude.ai or ChatGPT as a connector (OAuth + pairing code). Lumina downloads Cloudflare's `cloudflared` the first time if it isn't installed. Tested over a real tunnel with an MCP client and from the public internet; **not yet tried from claude.ai or ChatGPT themselves**. You can also bring your own tunnel for a permanent address. |

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
sudo apt install ./dist/lumina-studio_0.6.0_amd64.deb
```

Or run the AppImage directly:

```bash
chmod +x "dist/Lumina Studio-0.6.0.AppImage"
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

Generating images costs money on your provider accounts. Lumina shows which provider and model each request uses
but does not estimate prices yet.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, data model, jobs, providers, canvas, security.
- [docs/MCP.md](docs/MCP.md): connecting Claude, and the plan for claude.ai and ChatGPT.
- [docs/ROADMAP.md](docs/ROADMAP.md): what's next and known limits.
- [CONTRIBUTING.md](CONTRIBUTING.md)

## License

MIT. See [LICENSE](LICENSE).
