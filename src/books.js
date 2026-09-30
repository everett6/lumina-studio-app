import PDFDocument from 'pdfkit';
import { RequestError } from './generation.js';

export const trimSizes = {
  '8x8': { label: '8 × 8 in (square picture book)', width: 576, height: 576, imageSize: '1024x1024' },
  '8.5x11': { label: '8.5 × 11 in (portrait)', width: 612, height: 792, imageSize: '1536x1024' },
  '10x8': { label: '10 × 8 in (landscape)', width: 720, height: 576, imageSize: '1536x1024' },
  '6x9': { label: '6 × 9 in (trade)', width: 432, height: 648, imageSize: '1536x1024' },
};

export const defaultBrief = {
  premise: '', audience: 'Children 4–7', language: 'English', genre: 'Picture book', tone: 'Warm and playful',
  pageCount: 12, trimSize: '8x8', illustrationStyle: 'Soft watercolor, warm palette', author: '',
};

const maxPages = 48;

export function cleanBrief(input = {}, base = defaultBrief) {
  const text = (value, fallback, max = 2000) => (typeof value === 'string' ? value.slice(0, max) : fallback);
  const pageCount = Math.round(Number(input.pageCount ?? base.pageCount));
  return {
    premise: text(input.premise, base.premise, 4000),
    audience: text(input.audience, base.audience, 200),
    language: text(input.language, base.language, 80),
    genre: text(input.genre, base.genre, 120),
    tone: text(input.tone, base.tone, 200),
    pageCount: Number.isFinite(pageCount) ? Math.min(maxPages, Math.max(1, pageCount)) : base.pageCount,
    trimSize: trimSizes[input.trimSize] ? input.trimSize : base.trimSize,
    illustrationStyle: text(input.illustrationStyle, base.illustrationStyle, 1000),
    author: text(input.author, base.author, 120),
  };
}

export function cleanBible(input = {}) {
  const text = (value, max = 2000) => (typeof value === 'string' ? value.slice(0, max) : '');
  const ids = (value) => (Array.isArray(value) ? value.filter((id) => typeof id === 'string').slice(0, 4) : []);
  return {
    characters: (Array.isArray(input.characters) ? input.characters : []).slice(0, 20).map((c, index) => ({
      id: typeof c?.id === 'string' && c.id ? c.id.slice(0, 40) : `c${index + 1}`,
      name: text(c?.name, 80), description: text(c?.description, 1000), visual: text(c?.visual, 1000),
      referenceAssetIds: ids(c?.referenceAssetIds),
    })).filter((c) => c.name),
    setting: text(input.setting, 3000),
    voice: text(input.voice, 2000),
    styleNotes: text(input.styleNotes, 2000),
    styleReferenceAssetIds: ids(input.styleReferenceAssetIds),
  };
}

// Models often wrap JSON in prose or code fences; take the outermost object.
export function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new RequestError(502, 'The writer did not return structured output. Try again or pick another model.');
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new RequestError(502, 'The writer returned malformed output. Try again or pick another model.');
  }
}

const briefLines = (book) => {
  const b = book.brief;
  return [`Title: ${book.title}`, `Premise: ${b.premise || '(none given)'}`, `Audience: ${b.audience}`, `Language: ${b.language}`,
    `Genre: ${b.genre}`, `Tone: ${b.tone}`, `Pages: ${b.pageCount}`, `Illustration style: ${b.illustrationStyle}`].join('\n');
};

const bibleLines = (bible) => [
  'Characters:', ...(bible.characters?.length ? bible.characters.map((c) => `- ${c.name}: ${c.description} Looks: ${c.visual}`) : ['- (none yet)']),
  `Setting: ${bible.setting || '(none yet)'}`, `Narrative voice: ${bible.voice || '(none yet)'}`, `Visual style: ${bible.styleNotes || '(none yet)'}`,
].join('\n');

const authorSystem = 'You are an award-winning picture book author and editor. You write in the requested language, respect the audience age, keep canon consistent with the story bible, and write text meant to be read aloud. Illustration briefs describe one clear scene for an illustrator and never ask for text or lettering in the image. Respond with JSON only, no markdown fences.';

export function createBookService({ repo, directors, keys, generations, providers }) {
  function need(book) {
    if (!book) throw new RequestError(404, 'Book not found.');
    return book;
  }

  function writerFor(book, override) {
    const spec = override || book.writer;
    if (!spec) throw new RequestError(400, 'Choose a writer model for this book.');
    const [id, model] = spec.split(':');
    const writer = directors.get(id);
    if (!writer || !writer.models.includes(model)) throw new RequestError(400, 'Unknown writer model.');
    const key = writer.keyless ? null : keys.get(writer.keyProvider);
    if (!writer.keyless && !key) throw new RequestError(400, `Add a ${writer.label} key in Settings to use this writer.`);
    return (task, prompt, maxTokens) => writer.complete({ key, model, system: authorSystem, prompt, task, maxTokens }).catch((error) => {
      if (error instanceof RequestError) throw error;
      throw new RequestError(502, `Writer failed: ${error.detail || error.message}`);
    });
  }

  function detail(bookId) {
    const book = need(repo.books.get(bookId));
    const pages = repo.pages.listByBook(bookId).map((page) => ({
      ...page,
      illustrations: repo.generations.listByPage(page.id).map((g) => ({ id: g.id, status: g.status, assetId: g.assetId, assetPath: g.assetPath, userError: g.userError, createdAt: g.createdAt })),
    }));
    return { book, pages, trimSizes };
  }

  async function draftBible(bookId, { writer } = {}) {
    const book = need(repo.books.get(bookId));
    const run = writerFor(book, writer);
    const prompt = `Create a story bible for this book.\n\n${briefLines(book)}\n\nReturn JSON: {"characters":[{"name":"","description":"personality and role","visual":"fixed visual traits an illustrator must repeat on every page: species/age, colors, clothing, distinctive features"}],"setting":"","voice":"narrative voice and sentence style","styleNotes":"illustration style guide: medium, palette, lighting, line quality"}. 2 to 5 characters.`;
    const result = extractJson(await run('bible', prompt, 4000));
    const previous = book.bible ?? {};
    // Keep reference images the user attached to characters with the same name.
    const refs = new Map((previous.characters ?? []).map((c) => [c.name.toLowerCase(), c.referenceAssetIds]));
    const bible = cleanBible({
      ...result, styleReferenceAssetIds: previous.styleReferenceAssetIds,
      characters: (result.characters ?? []).map((c) => ({ ...c, referenceAssetIds: refs.get(String(c.name).toLowerCase()) ?? [] })),
    });
    if (!bible.characters.length) throw new RequestError(502, 'The writer returned no characters. Try again.');
    return repo.books.update(bookId, { bible });
  }

  async function planPages(bookId, { writer, replace = false } = {}) {
    const book = need(repo.books.get(bookId));
    if (repo.pages.listByBook(bookId).length && !replace) throw new RequestError(409, 'This book already has pages. Confirm to replace them.');
    const run = writerFor(book, writer);
    const count = book.brief.pageCount;
    const prompt = `Write the complete book as a page plan. PAGE_COUNT=${count}\n\n${briefLines(book)}\n\nStory bible:\n${bibleLines(book.bible)}\n\nReturn JSON: {"pages":[{"text":"the words printed on this page","illustrationBrief":"what the illustration shows: characters present, action, setting, composition"}]} with exactly ${count} pages. Give the story a clear beginning, middle and satisfying end.`;
    const result = extractJson(await run('plan', prompt, 16000));
    const list = (Array.isArray(result.pages) ? result.pages : [])
      .map((p) => ({ text: String(p?.text ?? '').trim().slice(0, 4000), illustrationBrief: String(p?.illustrationBrief ?? '').trim().slice(0, 2000) }))
      .filter((p) => p.text);
    if (!list.length) throw new RequestError(502, 'The writer returned no pages. Try again.');
    repo.pages.replaceAll(bookId, list.slice(0, maxPages));
    return detail(bookId);
  }

  async function revisePage(pageId, { instruction, writer } = {}) {
    const page = repo.pages.get(pageId);
    if (!page) throw new RequestError(404, 'Page not found.');
    const ask = String(instruction ?? '').trim().slice(0, 2000);
    if (!ask) throw new RequestError(400, 'Describe the change you want.');
    const book = repo.books.get(page.bookId);
    const run = writerFor(book, writer);
    const all = repo.pages.listByBook(book.id);
    const around = all.filter((p) => Math.abs(p.position - page.position) === 1).map((p) => `Page ${p.position}: ${p.text}`).join('\n');
    const prompt = `Revise page ${page.position} of ${all.length}.\n\n${briefLines(book)}\n\nStory bible:\n${bibleLines(book.bible)}\n\nNeighbouring pages:\n${around || '(none)'}\n\nCurrent page text: ${page.text}\nCurrent illustration brief: ${page.illustrationBrief}\n\nINSTRUCTION: ${ask}\n\nReturn JSON: {"text":"","illustrationBrief":""}.`;
    const result = extractJson(await run('revise', prompt, 4000));
    const text = String(result.text ?? '').trim();
    if (!text) throw new RequestError(502, 'The writer returned an empty page. Try again.');
    return repo.pages.update(pageId, { text: text.slice(0, 4000), illustrationBrief: String(result.illustrationBrief ?? page.illustrationBrief).trim().slice(0, 2000) }, 'revise');
  }

  // Builds the image prompt from the page brief plus the canon for every character it mentions, and attaches
  // their reference images when the chosen model accepts input images.
  function illustrationRequest(page, book, { provider, model }) {
    const bible = book.bible ?? {};
    const haystack = `${page.text} ${page.illustrationBrief}`.toLowerCase();
    const present = (bible.characters ?? []).filter((c) => haystack.includes(c.name.toLowerCase()));
    const style = [book.brief.illustrationStyle, bible.styleNotes].filter(Boolean).join('. ');
    const prompt = [
      `Children's book illustration. Style: ${style || 'consistent painterly illustration'}.`,
      `Scene: ${page.illustrationBrief || page.text}`,
      bible.setting ? `Setting: ${bible.setting}` : '',
      present.length ? `Characters (keep these designs identical on every page): ${present.map((c) => `${c.name} — ${c.visual}`).join('; ')}.` : '',
      'Do not include any text, letters, captions or speech bubbles in the image. Leave calm space where text could be placed.',
    ].filter(Boolean).join('\n').slice(0, 3900);
    const capability = providers.model(provider, model);
    const references = [...present.flatMap((c) => c.referenceAssetIds), ...(bible.styleReferenceAssetIds ?? [])]
      .filter((id, index, list) => list.indexOf(id) === index && repo.assets.get(id));
    const canUseReferences = capability?.operations.includes('edit') && capability.maxReferences > 0;
    const inputAssetIds = canUseReferences ? references.slice(0, capability.maxReferences) : [];
    return {
      projectId: book.projectId, prompt, provider, model, size: trimSizes[book.brief.trimSize]?.imageSize ?? '1024x1024',
      quality: 'high', inputAssetIds, bookPageId: page.id, droppedReferences: references.length - inputAssetIds.length,
    };
  }

  function illustratePage(pageId, choice) {
    const page = repo.pages.get(pageId);
    if (!page) throw new RequestError(404, 'Page not found.');
    const book = repo.books.get(page.bookId);
    const { droppedReferences, ...request } = illustrationRequest(page, book, choice);
    return { generation: generations.submit(request), droppedReferences };
  }

  // Finished page illustrations become the page's chosen art (the user can pick an earlier one).
  function onGenerationUpdate(generation) {
    if (generation.status !== 'completed' || !generation.bookPageId) return;
    if (repo.pages.get(generation.bookPageId)) repo.pages.update(generation.bookPageId, { assetId: generation.assetId }, 'illustration');
  }

  function exportMarkdown(bookId) {
    const { book, pages } = detail(bookId);
    const lines = [`# ${book.title}`, ''];
    if (book.brief.author) lines.push(`*by ${book.brief.author}*`, '');
    for (const page of pages) lines.push(`## Page ${page.position}`, '', page.text, '', `> Illustration: ${page.illustrationBrief}`, '');
    return lines.join('\n');
  }

  // Fixed-layout PDF: title page, then one page per book page with the art above and the words set as real text.
  async function exportPdf(bookId, assetStore) {
    const { book, pages } = detail(bookId);
    const trim = trimSizes[book.brief.trimSize] ?? trimSizes['8x8'];
    const margin = 36;
    // pdfkit fails on undefined info values, so only include Author when there is one.
    const info = { Title: book.title, Creator: 'Lumina Studio', ...(book.brief.author ? { Author: book.brief.author } : {}) };
    const doc = new PDFDocument({ size: [trim.width, trim.height], margin, autoFirstPage: false, info });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    const finished = new Promise((resolve) => doc.on('end', resolve));
    const textWidth = trim.width - margin * 2;
    const fontSize = Math.round(trim.width / 30);
    let skipped = 0;

    doc.addPage();
    doc.font('Times-Bold').fontSize(Math.round(trim.width / 16)).text(book.title, margin, trim.height * 0.36, { width: textWidth, align: 'center' });
    if (book.brief.author) doc.moveDown(0.8).font('Times-Italic').fontSize(fontSize).text(`by ${book.brief.author}`, { width: textWidth, align: 'center' });

    for (const page of pages) {
      doc.addPage();
      let textTop = margin;
      const asset = page.assetId ? repo.assets.get(page.assetId) : null;
      if (asset && asset.mimeType !== 'image/webp') {
        const { bytes } = await assetStore.read(asset);
        const imageHeight = page.text ? trim.height * 0.66 - margin : trim.height - margin * 2;
        doc.image(bytes, margin, margin, { fit: [textWidth, imageHeight], align: 'center', valign: 'center' });
        textTop = margin + imageHeight + 14;
      } else if (asset) {
        skipped += 1;
      }
      const available = trim.height - textTop - margin - 14;
      doc.font('Times-Roman').fontSize(fontSize);
      const height = doc.heightOfString(page.text, { width: textWidth, align: 'center', lineGap: 4 });
      const y = asset ? textTop : Math.max(margin, (trim.height - height) / 2);
      doc.text(page.text, margin, y, { width: textWidth, height: Math.max(available, height), align: 'center', lineGap: 4 });
      // The folio sits inside the bottom margin; drop the margin so pdfkit doesn't start a new page for it.
      doc.page.margins.bottom = 0;
      doc.font('Times-Roman').fontSize(9).fillColor('#777777').text(String(page.position), margin, trim.height - margin + 8, { width: textWidth, align: 'center', lineBreak: false });
      doc.fillColor('#000000');
    }
    doc.end();
    await finished;
    return { pdf: Buffer.concat(chunks), pages: pages.length, skippedWebp: skipped };
  }

  return { detail, draftBible, planPages, revisePage, illustratePage, illustrationRequest, onGenerationUpdate, exportMarkdown, exportPdf, writerFor };
}
