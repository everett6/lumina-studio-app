// Lumina's MCP tools, shared by the local stdio server (mcp/server.js) and the remote HTTPS endpoint
// (src/remote.js). `client` supplies: call(method, route, body) → JSON, fetchRaw(route) → Response,
// exportDir() → folder for exported files, and optionally localFile(assetPath) → path on disk.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const maxInlineImageBytes = 3 * 1024 * 1024;

export function registerLuminaTools(server, client) {
  const text = (value) => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) });
  const ok = (...content) => ({ content });
  const fail = (error) => ({ content: [text(error.message)], isError: true });
  const safe = (handler) => async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      return fail(error);
    }
  };

  function summarizeGeneration(g) {
    return {
      id: g.id, status: g.status, operation: g.operation, provider: g.provider, model: g.model, prompt: g.prompt,
      presets: g.params?.presets, finalPrompt: g.finalPrompt, assetId: g.assetId, error: g.userError ?? undefined, createdAt: g.createdAt,
    };
  }

  async function imageContent(assetPath) {
      if (!assetPath) return [];
      const where = client.localFile ? ` ${client.localFile(assetPath)}` : '';
      const response = await client.fetchRaw(assetPath);
      if (!response.ok) return [text(`Image saved in Lumina.${where}`)];
      const bytes = Buffer.from(await response.arrayBuffer());
      const mimeType = response.headers.get('content-type') || 'image/png';
      if (bytes.length > maxInlineImageBytes) return [text(`Image saved in Lumina (too large to show inline).${where}`)];
      return [{ type: 'image', data: bytes.toString('base64'), mimeType }, ...(where ? [text(`Image file:${where}`)] : [])];
    }

    async function pickModel(operation, provider, model) {
    const { providers } = await client.call('GET', '/api/catalog');
    if (provider && model) return { provider, model };
    const options = providers.filter((p) => p.ready && (!provider || p.id === provider))
      .flatMap((p) => p.models.filter((m) => m.operations.includes(operation)).map((m) => ({ provider: p.id, model: m.id })));
    if (!options.length) throw new Error(`No ${operation}-capable model has an API key configured. Add a key in Lumina → Settings.`);
    return options[0];
  }

  server.registerTool('list_projects', {
    title: 'List projects',
    description: 'List Lumina Studio projects, most recently updated first.',
    inputSchema: {},
  }, safe(async () => ok(text((await client.call('GET', '/api/projects')).projects))));

  server.registerTool('create_project', {
    title: 'Create project',
    description: 'Create a new Lumina Studio project.',
    inputSchema: { name: z.string().min(1).max(80) },
  }, safe(async ({ name }) => ok(text((await client.call('POST', '/api/projects', { name })).project))));

  server.registerTool('list_models', {
    title: 'List image models',
    description: 'List image providers and models, whether each provider has a key configured, and what each model supports (generate, edit, sizes, max input images). Also lists creative directors.',
    inputSchema: {},
  }, safe(async () => {
    const { providers, directors } = await client.call('GET', '/api/catalog');
    return ok(text({
      providers: providers.map((p) => ({ id: p.id, label: p.label, ready: p.ready, models: p.models.map(({ id, label, operations, sizes, qualities, maxReferences }) => ({ id, label, operations, sizes, qualities, maxReferences })) })),
      directors: directors.map((d) => ({ id: d.id, ready: d.ready, options: d.models.map((m) => `${d.id}:${m}`) })),
    }));
  }));

  server.registerTool('list_presets', {
    title: 'List presets',
    description: 'List Lumina\'s creative presets: camera moves (video only), effects (time, weather, atmosphere) and styles. Pass preset ids as `presets` to generate_image or generate_video; at most one per group.',
    inputSchema: { mode: z.enum(['image', 'video']).optional().describe('Only presets that work for this mode') },
  }, safe(async ({ mode }) => {
    const { presets } = await client.call('GET', '/api/presets');
    return ok(text(presets.filter((p) => !mode || p.modes.includes(mode)).map(({ id, group, label, blurb, modes }) => ({ id, group, label, blurb, modes }))));
  }));

  const presetsArg = z.array(z.string()).max(3).optional().describe('Preset ids from list_presets, e.g. ["dolly-in", "cinematic"]; one per group');

  server.registerTool('generate_image', {
    title: 'Generate or edit an image',
    description: 'Generate an image in a Lumina project using the user\'s own provider keys. Pass inputAssetIds to edit or combine existing images. Waits for the result by default and returns the image. Costs money on the user\'s provider account.',
    inputSchema: {
      projectId: z.string().describe('Project id from list_projects'),
      prompt: z.string().min(1).max(4000),
      provider: z.string().optional().describe('Provider id from list_models; defaults to the first ready provider'),
      model: z.string().optional().describe('Model id from list_models'),
      size: z.enum(['1024x1024', '1536x1024', '1024x1536']).optional(),
      quality: z.enum(['low', 'medium', 'high']).optional(),
      inputAssetIds: z.array(z.string()).max(4).optional().describe('Asset ids to edit or use as references'),
      director: z.string().optional().describe('Optional creative director, e.g. "anthropic:claude-opus-5-5"'),
      presets: presetsArg,
      wait: z.boolean().optional().describe('Wait for completion (default true)'),
    },
  }, safe(async (args) => {
    const operation = args.inputAssetIds?.length ? 'edit' : 'generate';
    const choice = await pickModel(operation, args.provider, args.model);
    const { generation } = await client.call('POST', '/api/generate', { ...args, ...choice });
    if (args.wait === false) return ok(text({ ...summarizeGeneration(generation), note: 'Queued. Poll with get_generation.' }));
    const done = (await client.call('POST', `/api/generations/${generation.id}/wait`, { timeoutMs: 600_000 })).generation;
    if (done.status !== 'completed') return { content: [text(summarizeGeneration(done))], isError: done.status === 'failed' };
    return ok(text(summarizeGeneration(done)), ...(await imageContent(done.assetPath)));
  }));

  server.registerTool('get_generation', {
    title: 'Get generation',
    description: 'Get the status of a generation; returns the image when it is complete.',
    inputSchema: { generationId: z.string(), includeImage: z.boolean().optional() },
  }, safe(async ({ generationId, includeImage = true }) => {
    const { generation } = await client.call('GET', `/api/generations/${generationId}`);
    const image = includeImage && generation.status === 'completed' ? await imageContent(generation.assetPath) : [];
    return ok(text(summarizeGeneration(generation)), ...image);
  }));

  server.registerTool('list_assets', {
    title: 'List project images',
    description: 'List images (generated and uploaded references) in a project, plus its canvases.',
    inputSchema: { projectId: z.string() },
  }, safe(async ({ projectId }) => {
    const detail = await client.call('GET', `/api/projects/${projectId}`);
    const prompts = new Map(detail.generations.filter((g) => g.assetId).map((g) => [g.assetId, g.prompt]));
    return ok(text({
      assets: detail.assets.map((a) => ({ id: a.id, kind: a.kind, label: a.label ?? prompts.get(a.id) ?? null, createdAt: a.createdAt })),
      canvases: detail.canvases.map((c) => ({ id: c.id, name: c.name, nodeCount: c.nodeCount })),
    }));
  }));

  server.registerTool('add_to_canvas', {
    title: 'Add image to canvas',
    description: 'Add an image to a project canvas as a reference node. Uses the most recent canvas, or creates one, when canvasId is omitted.',
    inputSchema: { assetId: z.string(), canvasId: z.string().optional(), projectId: z.string().describe('Project that owns the canvas') },
  }, safe(async ({ assetId, canvasId, projectId }) => {
    let id = canvasId;
    if (!id) {
      const { canvases } = await client.call('GET', `/api/projects/${projectId}`);
      id = canvases[0]?.id ?? (await client.call('POST', `/api/projects/${projectId}/canvases`, { name: 'Canvas 1' })).canvas.id;
    }
    const { canvas } = await client.call('GET', `/api/canvases/${id}`);
    const maxY = canvas.graph.nodes.reduce((y, n) => Math.max(y, n.y + 260), 40);
    const node = { id: `r${Date.now().toString(36)}`, type: 'reference', x: 40, y: maxY, data: { assetId } };
    const saved = await client.call('PUT', `/api/canvases/${id}`, { graph: { ...canvas.graph, nodes: [...canvas.graph.nodes, node] }, version: canvas.version });
    return ok(text({ canvasId: id, canvasName: saved.canvas.name, nodeId: node.id }));
  }));

  server.registerTool('run_canvas', {
    title: 'Run canvas',
    description: 'Run a canvas workflow (or only what one node needs) and wait for it to finish. Generate/edit nodes spend money on the user\'s provider accounts.',
    inputSchema: { canvasId: z.string(), nodeId: z.string().optional(), timeoutSeconds: z.number().int().min(10).max(1800).optional() },
  }, safe(async ({ canvasId, nodeId, timeoutSeconds = 600 }) => {
    let { run } = await client.call('POST', `/api/canvases/${canvasId}/run`, { nodeId });
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (run.status === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      run = (await client.call('GET', `/api/canvas-runs/${run.id}`)).run;
    }
    const nodes = Object.fromEntries(Object.entries(run.nodeState).map(([id, s]) => [id, { status: s.status, assetId: s.assetId, error: s.error }]));
    return { content: [text({ runId: run.id, status: run.status, nodes })], isError: run.status === 'failed' };
  }));

  // ---------- Book Studio ----------

  const briefShape = {
    premise: z.string().max(4000).optional(), audience: z.string().max(200).optional(), language: z.string().max(80).optional(),
    genre: z.string().max(120).optional(), tone: z.string().max(200).optional(), pageCount: z.number().int().min(1).max(48).optional(),
    trimSize: z.enum(['8x8', '8.5x11', '10x8', '6x9', '5.5x8.5']).optional(), illustrationStyle: z.string().max(1000).optional(), author: z.string().max(120).optional(),
    chapterCount: z.number().int().min(1).max(60).optional(), wordsPerChapter: z.number().int().min(200).max(8000).optional(),
    layout: z.enum(['art-top', 'full-bleed']).optional(), bleed: z.boolean().optional(),
    narration: z.object({ provider: z.string(), model: z.string(), voice: z.string().optional(), style: z.string().optional() }).optional().describe('Default narration voice (speech model from list_models)'),
  };

  // Chapter text can be long; get_book returns an excerpt and read_chapter returns the full text.
  function bookSummary({ book, pages, chapters }) {
    return {
      id: book.id, kind: book.kind, title: book.title, projectId: book.projectId, writer: book.writer, brief: book.brief, bible: book.bible,
      hasCover: Boolean(book.coverAssetId),
      pages: book.kind === 'picture_book' ? pages.map((p) => ({ id: p.id, position: p.position, text: p.text, illustrationBrief: p.illustrationBrief, hasIllustration: Boolean(p.assetId), narrated: Boolean(p.narrationAssetId), animated: Boolean(p.videoAssetId) })) : undefined,
      chapters: book.kind !== 'picture_book' ? chapters.map((c) => ({ id: c.id, position: c.position, title: c.title, summary: c.summary, beats: c.beats, words: c.words, excerpt: c.text.slice(0, 400), narrated: Boolean(c.narrationAssetId), hasArt: Boolean(c.assetId) })) : undefined,
    };
  }

  async function waitAndShow(generation, extra = {}) {
    const done = (await client.call('POST', `/api/generations/${generation.id}/wait`, { timeoutMs: 600_000 })).generation;
    if (done.status !== 'completed') return { content: [text({ ...summarizeGeneration(done), ...extra })], isError: done.status === 'failed' };
    const media = done.operation === 'speech' || done.operation === 'video'
      ? [text(`${done.operation === 'speech' ? 'Audio' : 'Video'} saved in Lumina's library${client.localFile ? `: ${client.localFile(done.assetPath)}` : ''}.`)]
      : await imageContent(done.assetPath);
    return ok(text({ ...summarizeGeneration(done), ...extra }), ...media);
  }

  server.registerTool('create_book', {
    title: 'Create book',
    description: 'Create a book in a Lumina project from a brief. kind: picture_book (pages with illustrations), novel, or nonfiction (chapters). Next: draft_bible; then plan_pages (picture books) or outline_book + draft_chapter (novels/nonfiction); then illustrations/cover/narration and export_book.',
    inputSchema: {
      projectId: z.string(), title: z.string().min(1).max(80), kind: z.enum(['picture_book', 'novel', 'nonfiction']).optional(),
      writer: z.string().optional().describe('Writer model as "provider:model" (see list_models directors), e.g. "anthropic:claude-opus-5-5"'), ...briefShape,
    },
  }, safe(async ({ projectId, title, kind, writer, ...brief }) => {
    const { book } = await client.call('POST', `/api/projects/${projectId}/books`, { title, kind, writer, brief });
    return ok(text(bookSummary(await client.call('GET', `/api/books/${book.id}`))));
  }));

  server.registerTool('get_book', {
    title: 'Get book',
    description: 'Read a book: brief, story bible and every page\'s text, illustration brief and illustration status. Use list_books to find ids.',
    inputSchema: { bookId: z.string() },
  }, safe(async ({ bookId }) => ok(text(bookSummary(await client.call('GET', `/api/books/${bookId}`))))));

  server.registerTool('list_books', {
    title: 'List books',
    description: 'List books in a project.',
    inputSchema: { projectId: z.string() },
  }, safe(async ({ projectId }) => ok(text((await client.call('GET', `/api/projects/${projectId}/books`)).books.map(({ id, title, pageCount, updatedAt }) => ({ id, title, pageCount, updatedAt }))))));

  server.registerTool('update_book', {
    title: 'Update book brief or story bible',
    description: 'Edit a book\'s title, brief fields, writer, or story bible (characters with name/description/visual, setting, voice, styleNotes). Pass the whole bible object when changing it.',
    inputSchema: {
      bookId: z.string(), title: z.string().max(80).optional(), writer: z.string().optional(), brief: z.object(briefShape).optional(),
      bible: z.object({
        characters: z.array(z.object({ name: z.string(), description: z.string().optional(), visual: z.string().optional(), referenceAssetIds: z.array(z.string()).max(4).optional() })).optional(),
        setting: z.string().optional(), voice: z.string().optional(), styleNotes: z.string().optional(), styleReferenceAssetIds: z.array(z.string()).max(4).optional(),
      }).optional(),
    },
  }, safe(async ({ bookId, ...changes }) => {
    await client.call('PATCH', `/api/books/${bookId}`, changes);
    return ok(text(bookSummary(await client.call('GET', `/api/books/${bookId}`))));
  }));

  server.registerTool('draft_bible', {
    title: 'Draft story bible',
    description: 'Have the book\'s writer model draft the story bible (characters, setting, voice, visual style) from the brief. Replaces the current bible; uses the user\'s text-model credits.',
    inputSchema: { bookId: z.string(), writer: z.string().optional() },
  }, safe(async ({ bookId, writer }) => {
    await client.call('POST', `/api/books/${bookId}/bible`, { writer });
    return ok(text(bookSummary(await client.call('GET', `/api/books/${bookId}`))));
  }));

  server.registerTool('plan_pages', {
    title: 'Plan pages',
    description: 'Have the writer model write every page (text + illustration brief) from the brief and story bible. Set replace=true to overwrite existing pages — ask the user first.',
    inputSchema: { bookId: z.string(), writer: z.string().optional(), replace: z.boolean().optional() },
  }, safe(async ({ bookId, writer, replace }) => ok(text(bookSummary(await client.call('POST', `/api/books/${bookId}/plan`, { writer, replace }))))));

  server.registerTool('edit_page', {
    title: 'Edit page',
    description: 'Set a page\'s text and/or illustration brief directly (previous version kept in history).',
    inputSchema: { pageId: z.string(), text: z.string().max(4000).optional(), illustrationBrief: z.string().max(2000).optional() },
  }, safe(async ({ pageId, ...changes }) => ok(text((await client.call('PATCH', `/api/pages/${pageId}`, changes)).page))));

  server.registerTool('revise_page', {
    title: 'Revise page with the writer',
    description: 'Ask the writer model to revise one page following an instruction, keeping it consistent with the story bible and neighbouring pages.',
    inputSchema: { pageId: z.string(), instruction: z.string().min(1).max(2000), writer: z.string().optional() },
  }, safe(async (args) => ok(text((await client.call('POST', `/api/pages/${args.pageId}/revise`, args)).page))));

  server.registerTool('generate_illustration', {
    title: 'Illustrate page',
    description: 'Generate an illustration for one page using its brief plus the story bible\'s character looks and reference images. Waits and returns the image. Costs money on the user\'s image provider — confirm with the user before illustrating many pages.',
    inputSchema: { pageId: z.string(), provider: z.string().optional(), model: z.string().optional(), wait: z.boolean().optional() },
  }, safe(async ({ pageId, provider, model, wait = true }) => {
    const choice = await pickModel('generate', provider, model);
    const { generation, droppedReferences } = await client.call('POST', `/api/pages/${pageId}/illustrate`, choice);
    const note = droppedReferences ? `${droppedReferences} reference image(s) not sent: this model does not accept input images.` : undefined;
    if (!wait) return ok(text({ ...summarizeGeneration(generation), note }));
    const done = (await client.call('POST', `/api/generations/${generation.id}/wait`, { timeoutMs: 600_000 })).generation;
    if (done.status !== 'completed') return { content: [text(summarizeGeneration(done))], isError: true };
    return ok(text({ ...summarizeGeneration(done), note }), ...(await imageContent(done.assetPath)));
  }));

  server.registerTool('outline_book', {
    title: 'Outline novel or nonfiction',
    description: 'Have the writer model outline every chapter (title, summary, scenes or sections) from the brief and bible. replace=true overwrites existing chapters — ask the user first.',
    inputSchema: { bookId: z.string(), writer: z.string().optional(), replace: z.boolean().optional() },
  }, safe(async ({ bookId, writer, replace }) => ok(text(bookSummary(await client.call('POST', `/api/books/${bookId}/outline`, { writer, replace }))))));

  server.registerTool('draft_chapter', {
    title: 'Draft chapter',
    description: 'Have the writer model write a chapter in full from its outline, the bible and earlier chapters (keeps continuity). Replaces the chapter text; the previous version stays in history. Takes a minute or more.',
    inputSchema: { chapterId: z.string(), writer: z.string().optional(), instructions: z.string().max(2000).optional() },
  }, safe(async ({ chapterId, ...rest }) => {
    const { chapter } = await client.call('POST', `/api/chapters/${chapterId}/draft`, rest);
    return ok(text({ id: chapter.id, position: chapter.position, title: chapter.title, words: (chapter.text.match(/\S+/g) ?? []).length, excerpt: chapter.text.slice(0, 1200) }));
  }));

  server.registerTool('read_chapter', {
    title: 'Read chapter',
    description: 'Return a chapter\'s full text, outline and beats.',
    inputSchema: { bookId: z.string(), chapterId: z.string() },
  }, safe(async ({ bookId, chapterId }) => {
    const { chapters } = await client.call('GET', `/api/books/${bookId}`);
    const chapter = chapters.find((c) => c.id === chapterId);
    if (!chapter) throw new Error('Chapter not found in this book.');
    const { assetPath, narrationPath, artJobs, narrationJobs, ...rest } = chapter;
    return ok(text(rest));
  }));

  server.registerTool('revise_chapter', {
    title: 'Revise chapter with the writer',
    description: 'Ask the writer model to rewrite a drafted chapter following an instruction (e.g. "tighten the opening", "more dialogue"). Previous version kept in history.',
    inputSchema: { chapterId: z.string(), instruction: z.string().min(1).max(2000), writer: z.string().optional() },
  }, safe(async ({ chapterId, ...rest }) => {
    const { chapter } = await client.call('POST', `/api/chapters/${chapterId}/revise`, rest);
    return ok(text({ id: chapter.id, words: (chapter.text.match(/\S+/g) ?? []).length, excerpt: chapter.text.slice(0, 1200) }));
  }));

  server.registerTool('edit_chapter', {
    title: 'Edit chapter',
    description: 'Set a chapter\'s title, summary, beats (scenes/sections) and/or full text directly. Previous version kept in history.',
    inputSchema: { chapterId: z.string(), title: z.string().max(200).optional(), summary: z.string().max(3000).optional(), beats: z.array(z.string().max(1000)).max(30).optional(), text: z.string().max(400000).optional() },
  }, safe(async ({ chapterId, ...changes }) => {
    const { chapter } = await client.call('PATCH', `/api/chapters/${chapterId}`, changes);
    return ok(text({ id: chapter.id, title: chapter.title, words: (chapter.text.match(/\S+/g) ?? []).length }));
  }));

  server.registerTool('generate_cover', {
    title: 'Generate book cover',
    description: 'Generate cover art from the brief and bible (title is typeset separately in exports). Costs money on the image provider.',
    inputSchema: { bookId: z.string(), provider: z.string().optional(), model: z.string().optional() },
  }, safe(async ({ bookId, provider, model }) => {
    const { generation, droppedReferences } = await client.call('POST', `/api/books/${bookId}/cover`, await pickModel('generate', provider, model));
    return waitAndShow(generation, droppedReferences ? { note: `${droppedReferences} reference image(s) not sent (model does not accept input images).` } : {});
  }));

  server.registerTool('narrate', {
    title: 'Narrate page or chapter',
    description: 'Turn a picture-book page or a chapter into narration audio with the book\'s narration voice (set it with update_book brief.narration, or pass provider/model/voice). Costs money on the voice provider.',
    inputSchema: { pageId: z.string().optional(), chapterId: z.string().optional(), provider: z.string().optional(), model: z.string().optional(), voice: z.string().optional(), style: z.string().max(500).optional() },
  }, safe(async ({ pageId, chapterId, ...voice }) => {
    if (!pageId === !chapterId) throw new Error('Pass exactly one of pageId or chapterId.');
    const { generation } = await client.call('POST', pageId ? `/api/pages/${pageId}/narrate` : `/api/chapters/${chapterId}/narrate`, voice);
    return waitAndShow(generation);
  }));

  server.registerTool('generate_speech', {
    title: 'Generate speech',
    description: 'Turn any text into spoken audio (saved to the project library). Long text is split and joined automatically. Costs money on the voice provider.',
    inputSchema: { projectId: z.string(), text: z.string().min(1).max(200000), provider: z.string().optional(), model: z.string().optional(), voice: z.string().optional(), style: z.string().max(500).optional() },
  }, safe(async ({ projectId, text: words, provider, model, voice, style }) => {
    const choice = await pickModel('speech', provider, model);
    const { generation } = await client.call('POST', '/api/generate', { projectId, operation: 'speech', prompt: words, voice, style, ...choice });
    return waitAndShow(generation);
  }));

  server.registerTool('generate_video', {
    title: 'Generate video',
    description: 'Generate a short video clip from a prompt, optionally animating an image (inputAssetId). Slow (minutes) and more expensive than images — confirm with the user first.',
    inputSchema: { projectId: z.string(), prompt: z.string().min(1).max(4000), inputAssetId: z.string().optional(), provider: z.string().optional(), model: z.string().optional(), duration: z.number().int().optional(), aspect: z.string().optional(), presets: presetsArg },
  }, safe(async ({ projectId, prompt, inputAssetId, provider, model, duration, aspect, presets }) => {
    const choice = await pickModel('video', provider, model);
    const { generation } = await client.call('POST', '/api/generate', { projectId, operation: 'video', prompt, inputAssetIds: inputAssetId ? [inputAssetId] : [], duration, aspect, presets, ...choice });
    return waitAndShow(generation);
  }));

  server.registerTool('export_book', {
    title: 'Export book',
    description: 'Export a book as a print-layout PDF, EPUB e-book, Word document (docx), Markdown text, or audiobook (joined narration). Saves the file on the computer running Lumina and returns its path.',
    inputSchema: { bookId: z.string(), format: z.enum(['pdf', 'epub', 'docx', 'md', 'audio']).optional(), outputPath: z.string().optional().describe('Absolute file path (local connections only); defaults to the Lumina exports folder') },
  }, safe(async ({ bookId, format = 'pdf', outputPath }) => {
    const response = await client.fetchRaw(`/api/books/${bookId}/export.${format}`);
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Export failed (HTTP ${response.status})`);
    const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? `book.${format}`);
    const target = outputPath && client.allowOutputPath ? path.resolve(outputPath) : path.join(client.exportDir(), name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(await response.arrayBuffer()));
    const notes = [
      Number(response.headers.get('x-lumina-skipped-webp') ?? 0) ? 'WebP illustrations could not be embedded in the PDF.' : '',
      response.headers.get('x-lumina-missing-scripts') ? `No installed font covers: ${response.headers.get('x-lumina-missing-scripts')}.` : '',
      Number(response.headers.get('x-lumina-missing-narration') ?? 0) ? `${response.headers.get('x-lumina-missing-narration')} item(s) without narration were skipped.` : '',
    ].filter(Boolean);
    return ok(text({ savedOnUsersComputer: target, format, notes: notes.length ? notes : undefined }));
  }));
}
