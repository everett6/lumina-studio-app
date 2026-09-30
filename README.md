# Lumina Studio

Lumina Studio is an open-source, Linux-first creative workspace for AI images. Bring your own API keys for OpenAI,
fal.ai, Google Gemini or Replicate. Generate and edit images, keep everything in local projects, build reusable
workflows on a node canvas, and let Claude drive it through MCP.

Everything runs on your computer. Keys go only to the provider they belong to; images and projects stay in a local
database and folder.

## What works

| Area | Status |
| --- | --- |
| Generate and edit images | Works. Text-to-image, edits with up to 4 input images, variations, retry on failure. |
| Providers | OpenAI GPT Image 2.5 (Flare, Sunburst), fal.ai FLUX schnell and Kontext pro, Gemini 3.x image models, Replicate FLUX (schnell, 1.1 pro, Kontext pro). Tested against faked provider responses; **not yet run against the live APIs** (see below). |
| Writers and creative director | OpenAI, Anthropic Claude or NVIDIA Nemotron write book pages and story bibles, and can optionally refine image prompts. |
| Projects and library | SQLite storage, uploaded references reusable across projects, rename, export to a folder, delete. |
| Canvas | Prompt, reference, director, generate, edit and output nodes. Drag to connect, pan and zoom, autosave, templates, run all or up to one node, duplicate to branch. |
| Book Studio (picture books) | Book brief → AI-drafted story bible (characters with fixed looks and reference images, setting, voice, style) → AI page plan → edit or AI-revise each page with version history → illustrate pages with consistent characters → export a print-layout PDF (title page, art above real text) or Markdown. Novels, EPUB and DOCX are not built yet. |
| Desktop app | Electron `.deb` and AppImage. Keys encrypted with your system keyring. |
| Claude (MCP) | Local stdio MCP server for Claude Code and Claude Desktop. See [docs/MCP.md](docs/MCP.md). |
| claude.ai / ChatGPT connectors | Not built. They need a remote HTTPS gateway; the design is in [docs/MCP.md](docs/MCP.md). |
| Video, upscaling, inpainting | Not built. See [docs/ROADMAP.md](docs/ROADMAP.md). |

Every flow in the table has been exercised with the built-in offline mock provider, both in the browser and in the
desktop app. Real providers have not been called because no API keys were available while this was built. Expect
to fix small request-format differences the first time each provider runs.

## Install the desktop app

Build the packages (needs Node.js 22.13+):

```bash
npm install
npm run dist
```

Then install the `.deb`:

```bash
sudo apt install ./dist/lumina-studio_0.3.0_amd64.deb
```

Or run the AppImage directly:

```bash
chmod +x "dist/Lumina Studio-0.3.0.AppImage"
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
| `npm test` | Test suite (API, jobs, canvas, provider adapters, MCP). |
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
