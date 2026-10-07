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
| `narrate` / `generate_speech` | Narrate a page or chapter with the book's voice, or turn any text into audio. **Spends money.** |
| `generate_video` | Text-to-video or animate an image. **Spends money; slow.** |
| `list_characters` / `create_character` | Reusable characters and products. Pass their ids as `characterIds` to `generate_image`, `generate_video` or `create_storyboard`. |
| `enhance_image` | Upscale (2× or 4×) or remove the background of one image. **Spends money.** Inpainting needs a painted mask, so it is app-only. |
| `import_manuscript` | Create a novel or nonfiction book from existing text, split into chapters at its headings. |
| `create_storyboard` / `get_storyboard` / `update_shot` | Plan shots from an idea with a writer model, read the storyboard, edit a shot. |
| `generate_shot` | Make one shot's still frame or video clip. **Spends money; clips are slow.** |
| `generate_storyboard_shots` | Queue frames or clips for every shot at once (they run in the background); follow with `get_storyboard`. |
| `join_storyboard` | Join the clips into one MP4 in the background and wait up to 8 minutes for it (needs ffmpeg on the computer running Lumina). |
| `export_book` | Save PDF, EPUB, Word, Markdown or an audiobook and return its path. `fixedLayout: true` makes a fixed-layout EPUB for a picture book. |

Example request in Claude Code: *"In Lumina, make a 12-page picture book about a fox who's afraid of water. Draft
the bible and pages, show me the text, then illustrate page 1."*

## Set up

Where Lumina keeps its data decides which app the tools talk to:

- Desktop app: `~/.config/Lumina Studio` (found automatically).
- `npm start` from the repository: the repository folder (found automatically when the desktop app has never run).
- Anything else: set `LUMINA_DATA_DIR` to the folder that contains `data/`.

### Claude Code

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

Add this to `claude_desktop_config.json`:

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

Node.js 22.13 or newer is required. Run `npm install` in the repository first so the MCP SDK is present.

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

Not verified: an actual claude.ai connection. Those products may expect details
(scopes, metadata fields) that the local test doesn't cover. If a connection fails, the Lumina log shows the request.
