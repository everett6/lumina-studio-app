# Roadmap

## Done (v0.2)

- Reliable image flow: generate, edit with up to four input images, variations, persisted references, reload-safe.
- SQLite storage with migrations and import of v0.1 data; durable background jobs with retry.
- Bring-your-own-key providers: OpenAI (GPT Image 2.5), fal.ai (FLUX, Kontext), Google Gemini image models,
  Replicate (FLUX). Creative directors: OpenAI, Anthropic Claude, NVIDIA Nemotron.
- Node canvas: prompt, reference, director, generate, edit and output nodes; templates; run all or up to a node.
- Linux desktop app (.deb, AppImage) with keyring-encrypted keys.
- Local MCP server for Claude Code and Claude Desktop.

## Done (v0.3): Book Studio MVP

- Picture books: brief → story bible → page plan → per-page editing, AI revision and history → consistent
  illustrations (character canon in every prompt, reference images sent to edit-capable models) → PDF and Markdown
  export. Book tools in MCP.

## Done (v0.4)

- Novels and nonfiction: outline → chapters → scenes or sections, continuity-aware drafting, revisions, history.
- EPUB 3 and Word export; covers and chapter art.
- Print bleed with trim and bleed boxes, full-bleed picture-book layout, non-Latin scripts in PDF.
- Narration (OpenAI and Gemini TTS), audiobook export, text-to-speech in Create.
- Video (Veo 3.1, Kling 3 Pro): Create video mode, a canvas video node, animated picture-book pages.
- Remote MCP endpoint for claude.ai and ChatGPT: OAuth, pairing codes (replaced by an account in v0.7), through your own tunnel.

## Done (v0.5)

- Preset gallery on Create: camera moves, effects and styles with animated preview tiles; Animate and Remix on results;
  presets in MCP (`list_presets`, `presets` on generate_image / generate_video).
- Fixed-layout EPUB 3 export for picture books; reflowable EPUB remains available.

## Done (v0.6)

- Characters: reusable people and products with a look description and reference photos, usable in Create, Storyboard and MCP.
- Image tools through fal.ai: upscale, background removal, inpainting with a brush, extend to a new shape.
- Storyboard: idea → shots → frames → clips → one joined video (ffmpeg).
- Manuscript import (.txt, .md, .docx) for novels and nonfiction.
- Canvas undo/redo and templates saved from your own canvases.
- List-price cost estimates before running, where providers publish a per-unit price.

## Done (v0.7)

- OpenRouter as a universal key: images, video and writing through one account.
- Storyboards for longer films: up to 60 shots and a target length (5-minute films), model-aware shot lengths,
  background joining with progress.
- One-click hosting: Cloudflare quick tunnel, the Lumina website behind an account sign-in (username and password), and the claude.ai/ChatGPT
  connector on the same address.

## Next

1. **Verify with real accounts.** Adapters are tested against faked HTTP only. Run one low-cost call per provider
   (image, voice, video, writer) with real keys, connect claude.ai and ChatGPT through a real tunnel, and fix any drift.
2. **Books, continued.** Two-page spreads, EPUB media overlays (read-along narration), multi-voice dialogue
   narration, and a built-in tunnel option.
3. **More video tools.** Start and end frames, clip extension, lip sync, video upscaling, narration or music on a joined storyboard.
4. **More models.** Seedance, Wan, Runway and others, plus a field for typing any model ID.
5. **Your own presets.** Save style, prompt and model combinations; canvas templates saved from your own graphs;
   presets on canvas nodes.
6. **Hosted relay** for remote access without running a tunnel yourself (needs hosting).
7. **Actual cost per generation** from provider-reported usage (estimates before running are done), and prices for OpenAI and Replicate.
8. **Collaboration.** Shared projects, which depend on the hosted option.

## Known limits

- Provider model IDs and parameters change often. Adapters list a fixed catalog; there is no custom-model field yet.
- Canvas runs are not cancellable once started (jobs finish or fail on their own).
- The dev server keeps keys unencrypted (0600 file). Use the desktop app for keyring encryption.
- Non-Latin PDF text needs a system font that covers the script (found through fontconfig), or a font file set in the
  brief. Right-to-left text is shaped and ordered correctly within a line, but mixed-direction punctuation can land on
  the wrong side. WebP images are skipped in PDF and Word exports.
- The mock provider's video is a one-second flat-colour clip when ffmpeg is installed, and a placeholder file otherwise.
- Characters are only as consistent as the chosen model's handling of reference images; there is no trained identity model. Video
  gets a character's description, not its photos. Deleting the project that holds a character's photos removes those photos.
- Inpainting sends a mask that is white where the image should change. fal's FLUX.1 Fill page does not state its mask convention;
  white-means-repaint is assumed and untested against the live API.
- Joining storyboard clips needs ffmpeg and ffprobe on the computer. The joined video has no added narration or music.
- Each storyboard clip starts from its own frame; continuity between shots depends on the frames and the character
  references, not on the previous clip's last frame.
- One-click hosting uses Cloudflare quick tunnels: a new random address each time, no uptime guarantee. Anyone with your
  Lumina password gets full use of Lumina and your provider credits.
- Prices are list prices read on the date shown in the app. They can be out of date, and the provider's bill is what counts.
- Manuscript import splits at headings only ("# Title", "## Chapter", Word heading styles, or lines like "Chapter 3"). PDF, .doc and
  .odt files are not supported.
- Book writing calls wait for the writer model (up to a few minutes for long plans), with no streaming progress.
