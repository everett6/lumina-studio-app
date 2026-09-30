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
| `list_models` | Providers, whether each has a key, and each model's capabilities; creative directors. |
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
| `export_book` | Save PDF, EPUB, Word, Markdown or an audiobook and return its path. |

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
- **You** make that port reachable over HTTPS with a tunnel you control, for example:
  `cloudflared tunnel --url http://127.0.0.1:8787`, `tailscale funnel 8787` or `ngrok http 8787`.
- Clients sign in with **OAuth 2.1**: metadata discovery, dynamic client registration, authorization code with PKCE,
  1-hour access tokens and rotating 30-day refresh tokens. Only hashes of tokens are stored.
- The approval page asks for the **6-digit pairing code** shown in Lumina → Settings → Remote access. Each code works
  once, expires after 15 minutes, and repeated wrong guesses are locked out. Settings → *Disconnect all* revokes every
  client and token.
- Lumina must be open (and the tunnel running) for the connector to work.

### Set up

1. Start your tunnel and copy its `https://` address.
2. Lumina → Settings → Remote access: paste the address, press **Turn on remote access**, then **Show a pairing code**.
3. **claude.ai:** Settings → Connectors → add a custom connector with the connector URL shown (`https://…/mcp`).
   **ChatGPT:** turn on developer mode and add a custom MCP connector with the same URL.
4. When the approval page opens, enter the pairing code.

### Verified

`tests/remote.test.js` runs the whole flow a cloud client performs against a real Lumina instance: the 401 challenge
with `resource_metadata`, discovery, registration, the consent page (a wrong code is rejected, the code works only
once), a PKCE token exchange (a wrong verifier is rejected), MCP tool calls over HTTP (including an inline image),
refresh-token rotation, and revocation.

Not verified: an actual claude.ai or ChatGPT connection through a public tunnel. Those products may expect details
(scopes, metadata fields) that the local test doesn't cover. If a connection fails, the Lumina log shows the request.
