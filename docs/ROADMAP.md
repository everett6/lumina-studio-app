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
- Remote MCP endpoint for claude.ai and ChatGPT: OAuth, pairing codes, through your own tunnel.

## Done (v0.5)

- Preset gallery on Create: camera moves, effects and styles with animated preview tiles; Animate and Remix on results;
  presets in MCP (`list_presets`, `presets` on generate_image / generate_video).
- Fixed-layout EPUB 3 export for picture books; reflowable EPUB remains available.

## Next

1. **Verify with real accounts.** Adapters are tested against faked HTTP only. Run one low-cost call per provider
   (image, voice, video, writer) with real keys, connect claude.ai and ChatGPT through a real tunnel, and fix any drift.
2. **Books, continued.** Two-page spreads, EPUB media overlays (read-along narration), multi-voice dialogue
   narration, and a built-in tunnel option.
3. **Image tools.** Upscale, background removal, inpainting with a mask editor, outpainting.
4. **Reusable subjects.** Named character and product reference sets that can be attached to any generation.
5. **Your own presets.** Save style, prompt and model combinations; canvas templates saved from your own graphs;
   presets on canvas nodes.
6. **Hosted relay** for remote access without running a tunnel yourself (needs hosting).
7. **Cost visibility.** Provider-reported usage per generation, plus an estimate before running a canvas.
8. **Collaboration.** Shared projects, which depend on the hosted option.

## Known limits

- Provider model IDs and parameters change often. Adapters list a fixed catalog; there is no custom-model field yet.
- Canvas runs are not cancellable once started (jobs finish or fail on their own).
- The dev server keeps keys unencrypted (0600 file). Use the desktop app for keyring encryption.
- No undo in the canvas.
- Non-Latin PDF text needs a system font that covers the script (found through fontconfig), or a font file set in the
  brief. Right-to-left text is shaped and ordered correctly within a line, but mixed-direction punctuation can land on
  the wrong side. WebP images are skipped in PDF and Word exports.
- Video from the mock provider is a placeholder file, not playable. Real video depends on provider access.
- Book writing calls wait for the writer model (up to a few minutes for long plans), with no streaming progress.
