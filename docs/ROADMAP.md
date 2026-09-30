# Roadmap

## Done (v0.2)

- Reliable image flow: generate, edit with up to four input images, variations, persisted references, reload-safe.
- SQLite storage with migrations and import of v0.1 data; durable background jobs with retry.
- Bring-your-own-key providers: OpenAI (GPT Image 2.5), fal.ai (FLUX, Kontext), Google Gemini image models,
  Replicate (FLUX). Creative directors: OpenAI, Anthropic Claude, NVIDIA Nemotron.
- Node canvas: prompt, reference, director, generate, edit and output nodes; templates; run all or up to a node.
- Linux desktop app (.deb, AppImage) with keyring-encrypted keys.
- Local MCP server for Claude Code and Claude Desktop.

## Next

1. **Real-provider verification.** Each adapter is tested against faked HTTP only. Run one low-cost generation per
   provider with real keys and fix any schema drift.
2. **Video.** A video capability (`image-to-video`, `text-to-video`) in the provider contract, video nodes on the
   canvas, and a player in the library. Candidates: fal.ai (Kling, Veo, Seedance), Gemini Veo, Replicate.
3. **Image tools.** Upscale, background removal, inpainting with a mask editor, outpainting.
4. **Reusable subjects.** Named character and product reference sets that can be attached to any generation.
5. **Presets.** Saved style, prompt and model combinations; canvas templates saved from your own graphs.
6. **Remote MCP gateway** for claude.ai and ChatGPT. See `docs/MCP.md` for the relay-vs-hosted decision.
7. **Cost visibility.** Provider-reported usage per generation, plus an estimate before running a canvas.
8. **Collaboration.** Shared projects, which depend on the hosted option.

## Known limits

- Provider model IDs and parameters change often. Adapters list a fixed catalog; there is no custom-model field yet.
- Canvas runs are not cancellable once started (jobs finish or fail on their own).
- The dev server keeps keys unencrypted (0600 file). Use the desktop app for keyring encryption.
- No undo in the canvas.
