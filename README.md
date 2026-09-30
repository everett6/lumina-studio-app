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
| Video | Text-to-video and image-to-video: Google Veo 3.1 (standard, Fast, Lite) and fal.ai Kling 3 Pro. Animate picture-book pages. (OpenAI's video API was shut down in September 2026.) |
| Voice | Text to speech for any text, and narration of book pages and chapters: OpenAI gpt-4o-mini-tts and Gemini 3.8 TTS. Audiobook export. |
| Providers | OpenAI, fal.ai, Google Gemini, Replicate (images); OpenAI, Anthropic Claude, NVIDIA Nemotron (writing). Tested against faked provider responses; **not yet run against the live APIs** (see below). |
| Books | **Picture books** (page plan, consistent illustrations, full-bleed or art-above-text layouts), **novels** and **nonfiction** (outline → chapters → scenes or sections, drafted and revised with continuity context). Story bible with character looks and reference images, cover art, chapter art, page/chapter history. |
| Book export | Print PDF (optional 0.125 in bleed with trim/bleed boxes; non-Latin scripts via installed system fonts or your own font file), EPUB 3, Word (.docx), Markdown, audiobook (MP3 or WAV). |
| Projects and library | SQLite storage, reusable references, audio and video in the library, rename, export to a folder, delete. |
| Canvas | Prompt, reference, director, generate, edit, video and output nodes. Drag to connect, pan and zoom, autosave, templates, run all or up to one node. |
| Desktop app | Electron `.deb` and AppImage. Keys encrypted with your system keyring. |
| Claude Code / Claude Desktop | Local stdio MCP server with 28 tools (images, video, voice, presets, canvas, books). See [docs/MCP.md](docs/MCP.md). |
| claude.ai / ChatGPT | Remote MCP endpoint with OAuth and pairing-code approval. You expose it through an HTTPS tunnel you run (Cloudflare Tunnel, Tailscale Funnel, ngrok…). Tested end to end with an MCP client over HTTP; **not yet tried from claude.ai or ChatGPT themselves**. |

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
sudo apt install ./dist/lumina-studio_0.4.0_amd64.deb
```

Or run the AppImage directly:

```bash
chmod +x "dist/Lumina Studio-0.4.0.AppImage"
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
