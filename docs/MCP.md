# Using Lumina from Claude (MCP)

Lumina ships a local [Model Context Protocol](https://modelcontextprotocol.io) server so Claude Code or Claude
Desktop can work with your projects: list them, generate and edit images with your own provider keys, add images to
a canvas, and run canvas workflows.

The MCP server is a small stdio process. It does not hold keys or data itself: it finds the **running** Lumina app
through `data/endpoint.json` and authenticates with `data/api-token` (both readable only by your user), then calls
the same local API the UI uses. Lumina must be open for the tools to work.

## Tools

| Tool | What it does |
| --- | --- |
| `list_projects` | Projects, most recently updated first. |
| `create_project` | Create a project. |
| `list_models` | Providers, whether each has a key, and each model's capabilities; creative directors. |
| `generate_image` | Generate, or edit when `inputAssetIds` is given. Waits and returns the image by default. **Spends money on your provider account.** |
| `get_generation` | Status of a generation, with the image when complete. |
| `list_assets` | Images and canvases in a project. |
| `add_to_canvas` | Add an image to a canvas as a reference node. |
| `run_canvas` | Run a canvas (or only what one node needs) and report each node's result. |

## Set up

Where Lumina keeps its data decides which app the tools talk to:

- Desktop app: `~/.config/Lumina Studio` (found automatically).
- `npm start` from the repository: the repository folder (found automatically when the desktop app has never run).
- Anything else: set `LUMINA_DATA_DIR` to the folder that contains `data/`.

### Claude Code

```bash
claude mcp add lumina-studio -- node /path/to/lumina-studio/mcp/server.js
```

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

Not verified here: a live Claude Code or Claude Desktop session calling these tools. The protocol path is the same,
but a real client session has not been exercised.

## Claude on the web and ChatGPT (not built yet)

claude.ai connectors and ChatGPT apps call MCP servers from their own cloud infrastructure over HTTPS. They cannot
reach a stdio process or a loopback port on your computer. Supporting them needs a remote gateway. The design:

- **Transport**: MCP Streamable HTTP on a public HTTPS endpoint, with the same tool set.
- **Auth**: OAuth 2.1 with the gateway as authorization server (dynamic client registration for Claude, as both
  clients expect). Tokens are scoped per user and revocable.
- **Where the work happens**, one of:
  1. *Relay*: the desktop app keeps an outbound WebSocket to the gateway. The gateway forwards tool calls to the app,
     so keys and images stay on your computer. Tools only work while the app is open.
  2. *Hosted*: an account service stores keys (encrypted, per user) and runs jobs server-side. Always available,
     but keys and images leave your machine and hosting costs money.
- **ChatGPT** apps need a production HTTPS endpoint and OpenAI's review. A development tunnel is fine for testing
  but does not qualify for a public listing.

Pick option 1 or 2 (and a domain and host) before this is built. Option 1 keeps Lumina's local-first promise and is
the recommended first step.
