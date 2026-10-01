import PDFDocument from 'pdfkit';
import { imageSize } from './assets.js';
import { joinAudio } from './audio.js';
import { resolveFonts, scriptRuns } from './fonts.js';
import { RequestError } from './generation.js';
import { parseManuscript } from './manuscript.js';
import { createZip } from './zip.js';

export const bookKinds = {
  picture_book: { label: 'Picture book', unit: 'page' },
  novel: { label: 'Novel', unit: 'chapter' },
  nonfiction: { label: 'Nonfiction', unit: 'chapter' },
};

export const trimSizes = {
  '8x8': { label: '8 × 8 in (square picture book)', width: 576, height: 576, imageSize: '1024x1024' },
  '8.5x11': { label: '8.5 × 11 in (portrait)', width: 612, height: 792, imageSize: '1536x1024' },
  '10x8': { label: '10 × 8 in (landscape)', width: 720, height: 576, imageSize: '1536x1024' },
  '6x9': { label: '6 × 9 in (trade)', width: 432, height: 648, imageSize: '1536x1024' },
  '5.5x8.5': { label: '5.5 × 8.5 in (digest)', width: 396, height: 612, imageSize: '1024x1536' },
};

export const defaultBrief = {
  premise: '', audience: 'Children 4–7', language: 'English', genre: 'Picture book', tone: 'Warm and playful',
  pageCount: 12, chapterCount: 12, wordsPerChapter: 2000, trimSize: '8x8', illustrationStyle: 'Soft watercolor, warm palette', author: '',
  layout: 'art-top', bleed: false, fontFile: '',
  narration: { provider: '', model: '', voice: '', style: '' },
};
const kindDefaults = {
  picture_book: {},
  novel: { audience: 'Adult', genre: 'Literary fiction', tone: 'Immersive, character-driven', trimSize: '6x9', illustrationStyle: 'Moody painterly cover art' },
  nonfiction: { audience: 'General readers', genre: 'Popular nonfiction', tone: 'Clear, engaging, authoritative', trimSize: '6x9', chapterCount: 10, illustrationStyle: 'Clean editorial illustration' },
};
export const briefFor = (kind) => ({ ...defaultBrief, ...(kindDefaults[kind] ?? {}) });

const maxPages = 48;
const maxChapters = 60;
const bleedPts = 9; // 0.125 in

export function cleanBrief(input = {}, base = defaultBrief) {
  const text = (value, fallback, max = 2000) => (typeof value === 'string' ? value.slice(0, max) : fallback);
  const int = (value, fallback, min, max) => {
    const n = Math.round(Number(value ?? fallback));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const narration = input.narration && typeof input.narration === 'object' ? input.narration : base.narration ?? {};
  return {
    premise: text(input.premise, base.premise, 4000),
    audience: text(input.audience, base.audience, 200),
    language: text(input.language, base.language, 80),
    genre: text(input.genre, base.genre, 120),
    tone: text(input.tone, base.tone, 200),
    pageCount: int(input.pageCount, base.pageCount, 1, maxPages),
    chapterCount: int(input.chapterCount, base.chapterCount ?? 12, 1, maxChapters),
    wordsPerChapter: int(input.wordsPerChapter, base.wordsPerChapter ?? 2000, 200, 8000),
    trimSize: trimSizes[input.trimSize] ? input.trimSize : base.trimSize,
    illustrationStyle: text(input.illustrationStyle, base.illustrationStyle, 1000),
    author: text(input.author, base.author, 120),
    layout: ['art-top', 'full-bleed'].includes(input.layout) ? input.layout : base.layout ?? 'art-top',
    bleed: typeof input.bleed === 'boolean' ? input.bleed : Boolean(base.bleed),
    fontFile: text(input.fontFile, base.fontFile ?? '', 500),
    narration: {
      provider: text(narration.provider, '', 40), model: text(narration.model, '', 120), voice: text(narration.voice, '', 60), style: text(narration.style, '', 500),
    },
  };
}

export function cleanBible(input = {}) {
  const text = (value, max = 2000) => (typeof value === 'string' ? value.slice(0, max) : '');
  const ids = (value) => (Array.isArray(value) ? value.filter((id) => typeof id === 'string').slice(0, 4) : []);
  return {
    characters: (Array.isArray(input.characters) ? input.characters : []).slice(0, 30).map((c, index) => ({
      id: typeof c?.id === 'string' && c.id ? c.id.slice(0, 40) : `c${index + 1}`,
      name: text(c?.name, 80), description: text(c?.description, 1500), visual: text(c?.visual, 1000),
      referenceAssetIds: ids(c?.referenceAssetIds),
    })).filter((c) => c.name),
    setting: text(input.setting, 4000),
    voice: text(input.voice, 2000),
    notes: text(input.notes, 6000),
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

const languageCodes = {
  english: 'en', spanish: 'es', french: 'fr', german: 'de', italian: 'it', portuguese: 'pt', dutch: 'nl', russian: 'ru', ukrainian: 'uk',
  polish: 'pl', turkish: 'tr', arabic: 'ar', hebrew: 'he', hindi: 'hi', bengali: 'bn', tamil: 'ta', thai: 'th', vietnamese: 'vi',
  indonesian: 'id', japanese: 'ja', korean: 'ko', chinese: 'zh', 'simplified chinese': 'zh-Hans', 'traditional chinese': 'zh-Hant',
  greek: 'el', swedish: 'sv', norwegian: 'no', danish: 'da', finnish: 'fi', czech: 'cs', persian: 'fa', urdu: 'ur', swahili: 'sw',
};
export function languageCode(language) {
  const value = String(language ?? '').trim();
  if (/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value)) return value;
  return languageCodes[value.toLowerCase()] ?? 'und';
}
const rtl = (code) => ['ar', 'he', 'fa', 'ur'].includes(code.split('-')[0]);

const escapeXml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const paragraphs = (text) => String(text ?? '').split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
const wordCount = (text) => (String(text ?? '').match(/\S+/g) ?? []).length;

// ---------- prompts ----------

const briefLines = (book) => {
  const b = book.brief;
  const size = book.kind === 'picture_book' ? `Pages: ${b.pageCount}` : `Chapters: ${b.chapterCount}, about ${b.wordsPerChapter} words each`;
  return [`Book type: ${bookKinds[book.kind]?.label ?? book.kind}`, `Title: ${book.title}`, `Premise: ${b.premise || '(none given)'}`, `Audience: ${b.audience}`,
    `Language: ${b.language} (write all book text in this language)`, `Genre: ${b.genre}`, `Tone: ${b.tone}`, size, `Illustration style: ${b.illustrationStyle}`].join('\n');
};

const bibleLines = (book) => {
  const bible = book.bible ?? {};
  const people = book.kind === 'nonfiction' ? 'Key people, entities and concepts' : 'Characters';
  return [
    `${people}:`, ...(bible.characters?.length ? bible.characters.map((c) => `- ${c.name}: ${c.description}${c.visual ? ` Looks: ${c.visual}` : ''}`) : ['- (none yet)']),
    `${book.kind === 'nonfiction' ? 'Scope' : 'Setting / world'}: ${bible.setting || '(none yet)'}`,
    `Narrative voice: ${bible.voice || '(none yet)'}`,
    `${book.kind === 'nonfiction' ? 'Thesis, key arguments and facts to respect' : 'Themes, rules and continuity notes'}: ${bible.notes || '(none yet)'}`,
    `Visual style: ${bible.styleNotes || '(none yet)'}`,
  ].join('\n');
};

const systems = {
  picture_book: 'You are an award-winning picture book author and editor. You write in the requested language, respect the audience age, keep canon consistent with the story bible, and write text meant to be read aloud. Illustration briefs describe one clear scene for an illustrator and never ask for text or lettering in the image.',
  novel: 'You are an accomplished novelist and developmental editor. You write vivid, specific prose in the requested language, keep characters, timeline and world rules consistent with the story bible and earlier chapters, show rather than tell, and vary rhythm. You never summarize when asked for scenes.',
  nonfiction: 'You are an expert nonfiction author and editor. You write clear, well-structured, accurate prose in the requested language for the stated audience. You explain with concrete examples, avoid filler and hype, keep terminology consistent with the book notes, and never invent statistics, quotes or citations; where a fact must be checked, mark it [CHECK: ...].',
};
const jsonOnly = ' Respond with JSON only, no markdown fences.';

const bibleShape = (kind) => kind === 'nonfiction'
  ? '{"characters":[{"name":"key person, organisation or concept","description":"why it matters in this book","visual":"how to depict it in illustrations (optional)"}],"setting":"scope: what the book covers and deliberately leaves out","voice":"authorial voice and reading level","notes":"thesis and the key arguments, in order","styleNotes":"illustration / cover style guide"}'
  : '{"characters":[{"name":"","description":"personality, goals, role, arc","visual":"fixed visual traits an illustrator must repeat: age, build, colors, clothing, distinctive features"}],"setting":"","voice":"narrative voice: POV, tense, sentence style","notes":"themes, world rules and continuity facts","styleNotes":"illustration style guide: medium, palette, lighting, line quality"}';

// ---------- service ----------

export function createBookService({ repo, directors, keys, generations, providers, assetStore }) {
  function need(book) {
    if (!book) throw new RequestError(404, 'Book not found.');
    return book;
  }
  const needChapter = (id) => repo.chapters.get(id) ?? (() => { throw new RequestError(404, 'Chapter not found.'); })();
  const needPage = (id) => repo.pages.get(id) ?? (() => { throw new RequestError(404, 'Page not found.'); })();

  function writerFor(book, override) {
    const spec = override || book.writer;
    if (!spec) throw new RequestError(400, 'Choose a writer model for this book.');
    const [id, model] = spec.split(':');
    const writer = directors.get(id);
    if (!writer || !writer.models.includes(model)) throw new RequestError(400, 'Unknown writer model.');
    const key = writer.keyless ? null : keys.get(writer.keyProvider);
    if (!writer.keyless && !key) throw new RequestError(400, `Add a ${writer.label} key in Settings to use this writer.`);
    const system = systems[book.kind] ?? systems.picture_book;
    return (task, prompt, { maxTokens = 16000, json = true, effort } = {}) => writer.complete({
      key, model, system: json ? system + jsonOnly : system, prompt, task, maxTokens, effort,
    }).catch((error) => {
      if (error instanceof RequestError) throw error;
      throw new RequestError(502, `Writer failed: ${error.detail || error.message}`);
    });
  }

  const pathOf = (assetId) => (assetId ? repo.assets.get(assetId)?.path ?? null : null);
  const jobsFor = (target) => repo.generations.listByTarget(target).map((g) => ({
    id: g.id, status: g.status, operation: g.operation, assetId: g.assetId, assetPath: g.assetPath, mimeType: g.mimeType, userError: g.userError, createdAt: g.createdAt,
  }));

  function detail(bookId) {
    const book = need(repo.books.get(bookId));
    const pages = repo.pages.listByBook(bookId).map((page) => ({
      ...page,
      narrationPath: pathOf(page.narrationAssetId), videoPath: pathOf(page.videoAssetId),
      illustrations: repo.generations.listByPage(page.id).map((g) => ({ id: g.id, status: g.status, assetId: g.assetId, assetPath: g.assetPath, userError: g.userError, createdAt: g.createdAt })),
      narrationJobs: jobsFor(`page-narration:${page.id}`), videoJobs: jobsFor(`page-video:${page.id}`),
    }));
    const chapters = repo.chapters.listByBook(bookId).map((c) => ({
      ...c, words: wordCount(c.text), assetPath: pathOf(c.assetId), narrationPath: pathOf(c.narrationAssetId),
      artJobs: jobsFor(`chapter-art:${c.id}`), narrationJobs: jobsFor(`chapter-narration:${c.id}`),
    }));
    return {
      book: { ...book, coverPath: pathOf(book.coverAssetId), coverJobs: jobsFor(`cover:${book.id}`) },
      pages, chapters, trimSizes, bookKinds, totalWords: chapters.reduce((n, c) => n + c.words, 0),
    };
  }

  function createBook({ projectId, title, kind = 'picture_book', brief, bible, writer }) {
    const safeKind = bookKinds[kind] ? kind : 'picture_book';
    return repo.books.create({ projectId, title, kind: safeKind, brief: cleanBrief(brief, briefFor(safeKind)), bible: cleanBible(bible), writer });
  }

  // Bring in an existing manuscript: one chapter per heading, ready to revise or continue.
  function importManuscript({ projectId, fileName, bytes, title, kind = 'novel', writer }) {
    let parsed;
    try {
      parsed = parseManuscript({ fileName, bytes });
    } catch (error) {
      throw new RequestError(400, error.message);
    }
    if (!parsed.chapters.length) throw new RequestError(400, 'No chapters were found in this file.');
    if (parsed.chapters.length > 300) throw new RequestError(400, 'This file splits into more than 300 chapters. Check its headings and try again.');
    const fallback = String(fileName ?? '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
    const book = createBook({ projectId, title: title || parsed.title || fallback || 'Imported manuscript', kind: kind === 'nonfiction' ? 'nonfiction' : 'novel', writer });
    parsed.chapters.forEach((chapter, index) => repo.chapters.insert(book.id, { position: index + 1, title: chapter.title, text: chapter.text }, 'import'));
    return detail(book.id);
  }

  async function draftBible(bookId, { writer } = {}) {
    const book = need(repo.books.get(bookId));
    const run = writerFor(book, writer);
    const prompt = `Create the ${book.kind === 'nonfiction' ? 'book plan notes' : 'story bible'} for this book.\n\n${briefLines(book)}\n\nReturn JSON: ${bibleShape(book.kind)}. ${book.kind === 'picture_book' ? '2 to 5 characters.' : '3 to 10 entries.'}`;
    const result = extractJson(await run('bible', prompt, { maxTokens: 8000 }));
    const previous = book.bible ?? {};
    // Keep reference images the user attached to characters with the same name.
    const refs = new Map((previous.characters ?? []).map((c) => [c.name.toLowerCase(), c.referenceAssetIds]));
    const bible = cleanBible({
      ...result, styleReferenceAssetIds: previous.styleReferenceAssetIds,
      characters: (result.characters ?? []).map((c) => ({ ...c, referenceAssetIds: refs.get(String(c.name).toLowerCase()) ?? [] })),
    });
    if (!bible.characters.length) throw new RequestError(502, 'The writer returned no entries. Try again.');
    return repo.books.update(bookId, { bible });
  }

  // ----- picture books -----

  async function planPages(bookId, { writer, replace = false } = {}) {
    const book = need(repo.books.get(bookId));
    if (book.kind !== 'picture_book') throw new RequestError(400, 'Use the chapter outline for novels and nonfiction.');
    if (repo.pages.listByBook(bookId).length && !replace) throw new RequestError(409, 'This book already has pages. Confirm to replace them.');
    const run = writerFor(book, writer);
    const count = book.brief.pageCount;
    const prompt = `Write the complete book as a page plan. PAGE_COUNT=${count}\n\n${briefLines(book)}\n\nStory bible:\n${bibleLines(book)}\n\nReturn JSON: {"pages":[{"text":"the words printed on this page","illustrationBrief":"what the illustration shows: characters present, action, setting, composition"}]} with exactly ${count} pages. Give the story a clear beginning, middle and satisfying end.`;
    const result = extractJson(await run('plan', prompt));
    const list = (Array.isArray(result.pages) ? result.pages : [])
      .map((p) => ({ text: String(p?.text ?? '').trim().slice(0, 4000), illustrationBrief: String(p?.illustrationBrief ?? '').trim().slice(0, 2000) }))
      .filter((p) => p.text);
    if (!list.length) throw new RequestError(502, 'The writer returned no pages. Try again.');
    repo.pages.replaceAll(bookId, list.slice(0, maxPages));
    return detail(bookId);
  }

  async function revisePage(pageId, { instruction, writer } = {}) {
    const page = needPage(pageId);
    const ask = String(instruction ?? '').trim().slice(0, 2000);
    if (!ask) throw new RequestError(400, 'Describe the change you want.');
    const book = repo.books.get(page.bookId);
    const run = writerFor(book, writer);
    const all = repo.pages.listByBook(book.id);
    const around = all.filter((p) => Math.abs(p.position - page.position) === 1).map((p) => `Page ${p.position}: ${p.text}`).join('\n');
    const prompt = `Revise page ${page.position} of ${all.length}.\n\n${briefLines(book)}\n\nStory bible:\n${bibleLines(book)}\n\nNeighbouring pages:\n${around || '(none)'}\n\nCurrent page text: ${page.text}\nCurrent illustration brief: ${page.illustrationBrief}\n\nINSTRUCTION: ${ask}\n\nReturn JSON: {"text":"","illustrationBrief":""}.`;
    const result = extractJson(await run('revise', prompt, { maxTokens: 4000 }));
    const text = String(result.text ?? '').trim();
    if (!text) throw new RequestError(502, 'The writer returned an empty page. Try again.');
    return repo.pages.update(pageId, { text: text.slice(0, 4000), illustrationBrief: String(result.illustrationBrief ?? page.illustrationBrief).trim().slice(0, 2000) }, 'revise');
  }

  // ----- novels and nonfiction -----

  async function outline(bookId, { writer, replace = false } = {}) {
    const book = need(repo.books.get(bookId));
    if (book.kind === 'picture_book') throw new RequestError(400, 'Picture books use a page plan.');
    if (repo.chapters.listByBook(bookId).length && !replace) throw new RequestError(409, 'This book already has chapters. Confirm to replace the outline.');
    const run = writerFor(book, writer);
    const count = book.brief.chapterCount;
    const unit = book.kind === 'nonfiction' ? 'sections (the points this chapter makes, in order)' : 'scenes (who, where, what happens, what changes)';
    const prompt = `Outline the whole book. CHAPTER_COUNT=${count}\n\n${briefLines(book)}\n\n${book.kind === 'nonfiction' ? 'Book notes' : 'Story bible'}:\n${bibleLines(book)}\n\nReturn JSON: {"chapters":[{"title":"","summary":"2-4 sentences: purpose of the chapter and how it moves the book forward","beats":["3 to 7 ${unit}"]}]} with exactly ${count} chapters. ${book.kind === 'nonfiction' ? 'Build the argument logically from foundations to conclusions.' : 'Give the book a complete arc with rising stakes, a climax and resolution.'}`;
    const result = extractJson(await run('outline', prompt));
    const list = (Array.isArray(result.chapters) ? result.chapters : []).map((c) => ({
      title: String(c?.title ?? '').trim().slice(0, 200), summary: String(c?.summary ?? '').trim().slice(0, 3000),
      beats: (Array.isArray(c?.beats) ? c.beats : []).map((b) => String(b).trim().slice(0, 1000)).filter(Boolean).slice(0, 20),
    })).filter((c) => c.title || c.summary);
    if (!list.length) throw new RequestError(502, 'The writer returned no chapters. Try again.');
    repo.chapters.replaceAll(bookId, list.slice(0, maxChapters));
    return detail(bookId);
  }

  function chapterContext(book, chapter) {
    const all = repo.chapters.listByBook(book.id);
    const earlier = all.filter((c) => c.position < chapter.position).map((c) => `Chapter ${c.position} "${c.title}": ${c.summary}`).join('\n');
    const later = all.filter((c) => c.position > chapter.position).slice(0, 2).map((c) => `Chapter ${c.position} "${c.title}": ${c.summary}`).join('\n');
    const previous = all.find((c) => c.position === chapter.position - 1);
    const tail = previous?.text ? previous.text.slice(-2500) : '';
    return { all, earlier, later, tail };
  }

  async function draftChapter(chapterId, { writer, instructions = '' } = {}) {
    const chapter = needChapter(chapterId);
    const book = repo.books.get(chapter.bookId);
    const run = writerFor(book, writer);
    const { all, earlier, later, tail } = chapterContext(book, chapter);
    const unit = book.kind === 'nonfiction' ? 'Sections to cover, in order' : 'Scenes to write, in order';
    const prompt = `Write chapter ${chapter.position} of ${all.length} in full. TARGET_WORDS=${book.brief.wordsPerChapter}\n\n${briefLines(book)}\n\n${book.kind === 'nonfiction' ? 'Book notes' : 'Story bible'}:\n${bibleLines(book)}\n\nEarlier chapters:\n${earlier || '(this is the first chapter)'}\n\n${tail ? `The previous chapter ended:\n"""${tail}"""\n\n` : ''}Coming next (do not write these):\n${later || '(this is the last chapter)'}\n\nTHIS CHAPTER: "${chapter.title}"\nSummary: ${chapter.summary}\n${unit}:\n${chapter.beats.map((b, i) => `${i + 1}. ${b}`).join('\n') || '(use the summary)'}\n${instructions ? `\nAuthor's instructions: ${String(instructions).slice(0, 2000)}\n` : ''}\nWrite about ${book.brief.wordsPerChapter} words of finished prose. Output only the chapter text, paragraphs separated by blank lines, no title, no notes.`;
    const text = (await run('draft', prompt, { json: false, maxTokens: Math.min(32000, Math.round(book.brief.wordsPerChapter * 2.2) + 1000), effort: 'medium' })).trim();
    if (wordCount(text) < 30) throw new RequestError(502, 'The writer returned too little text. Try again.');
    return repo.chapters.update(chapterId, { text }, 'draft');
  }

  async function reviseChapter(chapterId, { instruction, writer } = {}) {
    const chapter = needChapter(chapterId);
    const ask = String(instruction ?? '').trim().slice(0, 2000);
    if (!ask) throw new RequestError(400, 'Describe the change you want.');
    if (!chapter.text.trim()) throw new RequestError(400, 'Draft this chapter before revising it.');
    const book = repo.books.get(chapter.bookId);
    const run = writerFor(book, writer);
    const { earlier } = chapterContext(book, chapter);
    const prompt = `Revise chapter ${chapter.position} "${chapter.title}".\n\n${briefLines(book)}\n\n${book.kind === 'nonfiction' ? 'Book notes' : 'Story bible'}:\n${bibleLines(book)}\n\nEarlier chapters:\n${earlier || '(none)'}\n\nCURRENT CHAPTER TEXT:\n"""${chapter.text}"""\n\nINSTRUCTION: ${ask}\n\nReturn the complete revised chapter text only, paragraphs separated by blank lines, no commentary.`;
    const text = (await run('revise-chapter', prompt, { json: false, maxTokens: Math.min(32000, Math.round(wordCount(chapter.text) * 2.4) + 2000), effort: 'medium' })).trim();
    if (wordCount(text) < 30) throw new RequestError(502, 'The writer returned too little text. Try again.');
    return repo.chapters.update(chapterId, { text }, 'revise');
  }

  // ----- images, narration, video -----

  function visualCanon(book, haystack) {
    const bible = book.bible ?? {};
    const present = (bible.characters ?? []).filter((c) => c.visual && haystack.toLowerCase().includes(c.name.toLowerCase()));
    const style = [book.brief.illustrationStyle, bible.styleNotes].filter(Boolean).join('. ');
    const references = [...present.flatMap((c) => c.referenceAssetIds), ...(bible.styleReferenceAssetIds ?? [])]
      .filter((id, index, list) => list.indexOf(id) === index && repo.assets.get(id)?.mimeType.startsWith('image/'));
    return { present, style, references };
  }

  // Attach reference images only when the chosen model can take them.
  function withReferences(references, { provider, model }) {
    const capability = providers.model(provider, model);
    const usable = capability?.operations.includes('edit') && capability.maxReferences > 0;
    const inputAssetIds = usable ? references.slice(0, capability.maxReferences) : [];
    return { inputAssetIds, droppedReferences: references.length - inputAssetIds.length };
  }

  function illustrationRequest(page, book, choice) {
    const { present, style, references } = visualCanon(book, `${page.text} ${page.illustrationBrief}`);
    const prompt = [
      `Children's book illustration. Style: ${style || 'consistent painterly illustration'}.`,
      `Scene: ${page.illustrationBrief || page.text}`,
      book.bible?.setting ? `Setting: ${book.bible.setting}` : '',
      present.length ? `Characters (keep these designs identical on every page): ${present.map((c) => `${c.name} — ${c.visual}`).join('; ')}.` : '',
      book.brief.layout === 'full-bleed' ? 'Full-bleed composition: keep important details away from the edges and leave calm space in the lower third for text.' : '',
      'Do not include any text, letters, captions or speech bubbles in the image. Leave calm space where text could be placed.',
    ].filter(Boolean).join('\n').slice(0, 3900);
    return {
      projectId: book.projectId, prompt, provider: choice.provider, model: choice.model, size: trimSizes[book.brief.trimSize]?.imageSize ?? '1024x1024',
      quality: 'high', bookPageId: page.id, ...withReferences(references, choice),
    };
  }

  function submitWithNote(request) {
    const { droppedReferences, ...rest } = request;
    return { generation: generations.submit(rest), droppedReferences: droppedReferences ?? 0 };
  }

  function illustratePage(pageId, choice) {
    const page = needPage(pageId);
    return submitWithNote(illustrationRequest(page, repo.books.get(page.bookId), choice));
  }

  function illustrateChapter(chapterId, choice) {
    const chapter = needChapter(chapterId);
    const book = repo.books.get(chapter.bookId);
    const { present, style, references } = visualCanon(book, `${chapter.title} ${chapter.summary} ${chapter.beats.join(' ')}`);
    const prompt = [
      `Chapter-opening illustration for "${chapter.title}". Style: ${style || 'elegant book illustration'}.`,
      `Depict: ${chapter.summary}`,
      present.length ? `Characters: ${present.map((c) => `${c.name} — ${c.visual}`).join('; ')}.` : '',
      'No text, letters or captions in the image.',
    ].filter(Boolean).join('\n').slice(0, 3900);
    return submitWithNote({ projectId: book.projectId, prompt, provider: choice.provider, model: choice.model, size: '1536x1024', quality: 'high', bookTarget: `chapter-art:${chapter.id}`, ...withReferences(references, choice) });
  }

  function generateCover(bookId, choice) {
    const book = need(repo.books.get(bookId));
    const { present, style, references } = visualCanon(book, `${book.brief.premise} ${(book.bible?.characters ?? []).map((c) => c.name).join(' ')}`);
    const prompt = [
      `Front cover artwork for a ${bookKinds[book.kind]?.label.toLowerCase() ?? 'book'} (${book.brief.genre}) for ${book.brief.audience}. Style: ${style || 'striking, professional cover art'}.`,
      `The book is about: ${book.brief.premise || book.title}`,
      present.length ? `Feature: ${present.slice(0, 3).map((c) => `${c.name} — ${c.visual}`).join('; ')}.` : '',
      book.bible?.setting ? `Setting: ${book.bible.setting.slice(0, 600)}` : '',
      'Portrait composition with open space at the top for the title. Do not render any text, title or letters; the title is added separately.',
    ].filter(Boolean).join('\n').slice(0, 3900);
    return submitWithNote({ projectId: book.projectId, prompt, provider: choice.provider, model: choice.model, size: '1024x1536', quality: 'high', bookTarget: `cover:${book.id}`, ...withReferences(references, choice) });
  }

  function narrationChoice(book, override = {}) {
    const n = { ...book.brief.narration, ...Object.fromEntries(Object.entries(override).filter(([, v]) => v)) };
    if (!n.provider || !n.model) throw new RequestError(400, 'Choose a narration voice for this book first.');
    return n;
  }

  function narrate(target, override) {
    const [kind, id] = target;
    const item = kind === 'page' ? needPage(id) : needChapter(id);
    const book = repo.books.get(item.bookId);
    const text = kind === 'page' ? item.text : `${item.title}.\n\n${item.text}`;
    if (!String(item.text ?? '').trim()) throw new RequestError(400, 'There is no text to narrate yet.');
    const n = narrationChoice(book, override);
    return {
      generation: generations.submit({
        projectId: book.projectId, operation: 'speech', prompt: text, provider: n.provider, model: n.model, voice: n.voice,
        style: n.style || (book.kind === 'picture_book' ? 'Warm, gentle storyteller reading aloud to a child' : null), bookTarget: `${kind}-narration:${id}`,
      }),
    };
  }

  function animatePage(pageId, { provider, model, duration, aspect } = {}) {
    const page = needPage(pageId);
    if (!page.assetId) throw new RequestError(400, 'Illustrate this page before animating it.');
    const book = repo.books.get(page.bookId);
    const prompt = `Gently animate this storybook illustration: ${page.illustrationBrief || page.text}. Subtle, natural motion; keep the art style and characters unchanged; no text.`.slice(0, 3900);
    return {
      generation: generations.submit({
        projectId: book.projectId, operation: 'video', prompt, provider, model, duration, aspect, inputAssetIds: [page.assetId], bookTarget: `page-video:${page.id}`,
      }),
    };
  }

  // Finished jobs attach themselves to whatever book item requested them.
  function onGenerationUpdate(generation) {
    if (generation.status !== 'completed') return;
    if (generation.bookPageId && repo.pages.get(generation.bookPageId)) repo.pages.update(generation.bookPageId, { assetId: generation.assetId }, 'illustration');
    if (!generation.bookTarget) return;
    const [kind, id] = generation.bookTarget.split(':');
    if (kind === 'cover' && repo.books.get(id)) repo.books.update(id, { coverAssetId: generation.assetId });
    if (kind === 'chapter-art' && repo.chapters.get(id)) repo.chapters.update(id, { assetId: generation.assetId }, 'illustration');
    if (kind === 'chapter-narration' && repo.chapters.get(id)) repo.chapters.update(id, { narrationAssetId: generation.assetId }, 'narration');
    if (kind === 'page-narration' && repo.pages.get(id)) repo.pages.setMedia(id, { narrationAssetId: generation.assetId });
    if (kind === 'page-video' && repo.pages.get(id)) repo.pages.setMedia(id, { videoAssetId: generation.assetId });
  }

  // ---------- exports ----------

  function units(bookId) {
    const { book, pages, chapters } = detail(bookId);
    const isPicture = book.kind === 'picture_book';
    if (isPicture ? !pages.length : !chapters.length) throw new RequestError(400, isPicture ? 'Plan or add pages first.' : 'Outline or add chapters first.');
    return { book, pages, chapters, isPicture };
  }

  async function readImage(assetId) {
    const asset = assetId ? repo.assets.get(assetId) : null;
    if (!asset || !asset.mimeType.startsWith('image/')) return null;
    const { bytes } = await assetStore.read(asset);
    return { asset, bytes, size: imageSize(bytes) };
  }

  function exportMarkdown(bookId) {
    const { book, pages, chapters, isPicture } = units(bookId);
    const lines = [`# ${book.title}`, ''];
    if (book.brief.author) lines.push(`*by ${book.brief.author}*`, '');
    if (isPicture) {
      for (const page of pages) lines.push(`## Page ${page.position}`, '', page.text, '', `> Illustration: ${page.illustrationBrief}`, '');
    } else {
      for (const c of chapters) lines.push(`## ${c.position}. ${c.title}`, '', ...(c.text ? paragraphs(c.text).flatMap((p) => [p, '']) : [`*${c.summary}*`, '']));
    }
    return lines.join('\n');
  }

  // PDF text with per-script fonts: each run of the text switches to a font that covers it.
  function pdfWriter(doc, sample, brief) {
    const resolved = resolveFonts(sample, { override: brief.fontFile });
    const family = { regular: 'Times-Roman', bold: 'Times-Bold', italic: 'Times-Italic' };
    const registered = {};
    if (resolved?.fonts?.base) {
      for (const [script, font] of Object.entries(resolved.fonts)) {
        const name = `f-${script}`;
        doc.registerFont(name, font.file, /\.ttc$/i.test(font.file) ? font.postscriptName : undefined);
        registered[script] = name;
      }
    }
    const fontFor = (script, weight) => (registered.base ? registered[script] ?? registered.base : family[weight]);
    function write(text, x, y, options = {}, weight = 'regular') {
      const runs = registered.base ? scriptRuns(text) : [{ script: 'base', text }];
      runs.forEach((run, index) => {
        doc.font(fontFor(run.script, weight));
        const opts = { ...options, continued: index < runs.length - 1 };
        if (index === 0 && x !== undefined) doc.text(run.text, x, y, opts);
        else doc.text(run.text, opts);
      });
    }
    function height(text, options, weight = 'regular') {
      doc.font(fontFor('base', weight));
      return doc.heightOfString(text, options);
    }
    return { write, height, embedded: Boolean(registered.base), missing: resolved?.missing ?? [], setFont: (weight = 'regular') => doc.font(fontFor('base', weight)) };
  }

  async function exportPdf(bookId) {
    const { book, pages, chapters, isPicture } = units(bookId);
    const trim = trimSizes[book.brief.trimSize] ?? trimSizes['8x8'];
    const bleed = book.brief.bleed ? bleedPts : 0;
    const W = trim.width + bleed * 2;
    const H = trim.height + bleed * 2;
    const margin = (isPicture ? 36 : 54) + bleed;
    const sample = [book.title, book.brief.author, ...pages.map((p) => p.text), ...chapters.flatMap((c) => [c.title, c.text])].join('\n');
    const info = { Title: book.title, Creator: 'Lumina Studio', ...(book.brief.author ? { Author: book.brief.author } : {}) };
    const doc = new PDFDocument({ size: [W, H], margins: { top: margin, bottom: margin, left: margin, right: margin }, autoFirstPage: false, bufferPages: true, info, lang: languageCode(book.brief.language) });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    const finished = new Promise((resolve) => doc.on('end', resolve));
    // Printers read the trim and bleed boxes to know where to cut.
    doc.on('pageAdded', () => {
      if (!bleed) return;
      doc.page.dictionary.data.TrimBox = [bleed, bleed, W - bleed, H - bleed];
      doc.page.dictionary.data.BleedBox = [0, 0, W, H];
    });
    const text = pdfWriter(doc, sample, book.brief);
    const textWidth = W - margin * 2;
    // Right-to-left languages are right-aligned; glyph shaping comes from the embedded font.
    const isRtl = rtl(languageCode(book.brief.language));
    const direction = {};
    const numbered = [];
    let skipped = 0;

    const coverImage = await readImage(book.coverAssetId);
    if (coverImage && coverImage.asset.mimeType !== 'image/webp') {
      doc.addPage();
      doc.save().rect(0, 0, W, H).clip();
      doc.image(coverImage.bytes, 0, 0, { cover: [W, H], align: 'center', valign: 'center' });
      doc.restore();
      doc.save().rect(0, H * 0.06, W, H * 0.2).fillOpacity(0.55).fill('#000000').restore();
      doc.fillColor('#ffffff');
      text.write(book.title, margin, H * 0.09, { width: textWidth, align: 'center', ...direction }, 'bold');
      if (book.brief.author) text.write(book.brief.author, margin, H * 0.19, { width: textWidth, align: 'center', ...direction }, 'italic');
      doc.fillColor('#000000');
    }

    doc.addPage();
    doc.fontSize(Math.round(trim.width / (isPicture ? 16 : 18)));
    text.write(book.title, margin, H * 0.34, { width: textWidth, align: 'center', ...direction }, 'bold');
    if (book.brief.author) {
      doc.moveDown(0.8).fontSize(Math.round(trim.width / 30));
      text.write(`by ${book.brief.author}`, undefined, undefined, { width: textWidth, align: 'center', ...direction }, 'italic');
    }

    if (isPicture) {
      const fontSize = Math.round(trim.width / 30);
      for (const page of pages) {
        doc.addPage();
        numbered.push(doc.bufferedPageRange().count - 1);
        const art = await readImage(page.assetId);
        if (art && art.asset.mimeType === 'image/webp') skipped += 1;
        const hasArt = art && art.asset.mimeType !== 'image/webp';
        doc.fontSize(fontSize);
        if (hasArt && book.brief.layout === 'full-bleed') {
          // Art fills the page including bleed; text sits on a soft panel inside the trim-safe area.
          doc.save().rect(0, 0, W, H).clip();
          doc.image(art.bytes, 0, 0, { cover: [W, H], align: 'center', valign: 'center' });
          doc.restore();
          const boxHeight = text.height(page.text, { width: textWidth - 24, align: 'center', lineGap: 4 }) + 24;
          const boxTop = H - margin - boxHeight - 8;
          doc.save().roundedRect(margin, boxTop, textWidth, boxHeight, 10).fillOpacity(0.86).fill('#ffffff').restore();
          doc.fillColor('#111111');
          text.write(page.text, margin + 12, boxTop + 12, { width: textWidth - 24, align: 'center', lineGap: 4, ...direction });
        } else {
          let textTop = margin;
          if (hasArt) {
            const imageHeight = page.text ? H * 0.66 - margin : H - margin * 2;
            doc.image(art.bytes, margin, margin, { fit: [textWidth, imageHeight], align: 'center', valign: 'center' });
            textTop = margin + imageHeight + 14;
          }
          const height = text.height(page.text, { width: textWidth, align: 'center', lineGap: 4 });
          const y = hasArt ? textTop : Math.max(margin, (H - height) / 2);
          doc.fillColor('#000000');
          text.write(page.text, margin, y, { width: textWidth, align: 'center', lineGap: 4, ...direction });
        }
      }
    } else {
      const fontSize = trim.width <= 432 ? 11 : 12;
      for (const chapter of chapters) {
        doc.addPage();
        const start = doc.bufferedPageRange().count - 1;
        let y = margin + (H - margin * 2) * 0.12;
        doc.fillColor('#555555').fontSize(10);
        text.write(`CHAPTER ${chapter.position}`, margin, y, { width: textWidth, align: 'center', characterSpacing: 2 });
        doc.fillColor('#000000').fontSize(Math.round(fontSize * 1.8));
        text.write(chapter.title || `Chapter ${chapter.position}`, margin, y + 22, { width: textWidth, align: 'center', ...direction }, 'bold');
        y = doc.y + 18;
        const art = await readImage(chapter.assetId);
        if (art && art.asset.mimeType === 'image/webp') skipped += 1;
        if (art && art.asset.mimeType !== 'image/webp') {
          const artHeight = Math.min((H - margin * 2) * 0.35, textWidth * ((art.size?.height ?? 2) / (art.size?.width ?? 3)));
          doc.image(art.bytes, margin, y, { fit: [textWidth, artHeight], align: 'center' });
          y += artHeight + 18;
        }
        doc.fontSize(fontSize);
        const body = chapter.text ? paragraphs(chapter.text) : [chapter.summary];
        body.forEach((paragraph, index) => {
          text.write(paragraph, margin, index === 0 ? y : undefined, { width: textWidth, align: isRtl ? 'right' : 'justify', lineGap: 3, indent: index === 0 ? 0 : 18, paragraphGap: 4, ...direction });
        });
        const end = doc.bufferedPageRange().count - 1;
        for (let i = start; i <= end; i += 1) numbered.push(i);
      }
    }

    // Folios go on after layout so they never push text onto a new page.
    const { start: first } = doc.bufferedPageRange();
    numbered.forEach((index, n) => {
      doc.switchToPage(index - first);
      doc.page.margins.bottom = 0;
      doc.font(text.embedded ? 'f-base' : 'Times-Roman').fontSize(9).fillColor('#777777')
        .text(String(isPicture ? n + 1 : index - numbered[0] + 1), margin, H - margin + 16 - (isPicture ? 0 : 6), { width: textWidth, align: 'center', lineBreak: false });
    });
    doc.end();
    await finished;
    return { pdf: Buffer.concat(chunks), skippedWebp: skipped, missingScripts: text.missing, embeddedFonts: text.embedded };
  }

  async function exportEpub(bookId, { layout = 'reflowable' } = {}) {
    const { book, pages, chapters, isPicture } = units(bookId);
    const fixedLayout = layout === 'fixed' && isPicture;
    const lang = languageCode(book.brief.language);
    const dir = rtl(lang) ? 'rtl' : 'ltr';
    const files = [];
    const manifest = [];
    const spine = [];
    const toc = [];
    const addImage = async (assetId, name) => {
      const art = await readImage(assetId);
      if (!art) return null;
      const ext = art.asset.file.split('.').pop();
      const href = `images/${name}.${ext}`;
      files.push({ name: `OEBPS/${href}`, data: art.bytes, store: true });
      manifest.push({ id: `img-${name}`, href, type: art.asset.mimeType });
      return href;
    };
    // Fixed layout: one screen per page at the trim size (points → CSS px).
    const trim = trimSizes[book.brief.trimSize] ?? trimSizes['8x8'];
    const [width, height] = [Math.round(trim.width * 4 / 3), Math.round(trim.height * 4 / 3)];
    const viewport = fixedLayout ? `<meta name="viewport" content="width=${width}, height=${height}"/>` : '';
    const xhtml = (title, body) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}" dir="${dir}">\n<head><meta charset="UTF-8"/>${viewport}<title>${escapeXml(title)}</title><link rel="stylesheet" href="style.css" type="text/css"/></head>\n<body>${body}</body>\n</html>\n`;
    const addDoc = (id, title, body, { inToc = true, properties } = {}) => {
      files.push({ name: `OEBPS/${id}.xhtml`, data: xhtml(title, body) });
      manifest.push({ id, href: `${id}.xhtml`, type: 'application/xhtml+xml', properties });
      spine.push(id);
      if (inToc) toc.push({ id, title });
    };

    const coverHref = await addImage(book.coverAssetId, 'cover');
    if (coverHref) {
      manifest.at(-1).properties = 'cover-image';
      addDoc('cover', book.title, `<section epub:type="cover" class="cover"><img src="${coverHref}" alt="${escapeXml(book.title)}"/></section>`, { inToc: false });
    }
    addDoc('title', book.title, `<section epub:type="titlepage" class="titlepage"><h1>${escapeXml(book.title)}</h1>${book.brief.author ? `<p class="author">${escapeXml(book.brief.author)}</p>` : ''}</section>`, { inToc: false });

    if (isPicture) {
      for (const page of pages) {
        const href = await addImage(page.assetId, `page-${page.position}`);
        const pageBody = fixedLayout
          ? `<section class="page ${book.brief.layout === 'full-bleed' ? 'full-bleed' : 'art-top'}">${href ? `<img class="art" src="${href}" alt="${escapeXml(page.illustrationBrief)}"/>` : ''}${page.text.trim() ? `<div class="text-panel">${paragraphs(page.text).map((p) => `<p>${escapeXml(p)}</p>`).join('')}</div>` : ''}</section>`
          : `<section class="page">${href ? `<figure><img src="${href}" alt="${escapeXml(page.illustrationBrief)}"/></figure>` : ''}${paragraphs(page.text).map((p) => `<p>${escapeXml(p)}</p>`).join('')}</section>`;
        addDoc(`page-${String(page.position).padStart(3, '0')}`, `Page ${page.position}`, pageBody);
      }
    } else {
      for (const c of chapters) {
        const href = await addImage(c.assetId, `chapter-${c.position}`);
        const body = c.text ? paragraphs(c.text) : [c.summary];
        const title = c.title || `Chapter ${c.position}`;
        addDoc(`chapter-${String(c.position).padStart(3, '0')}`, title,
          `<section epub:type="chapter" class="chapter"><h2><span class="num">${c.position}</span> ${escapeXml(title)}</h2>${href ? `<figure><img src="${href}" alt=""/></figure>` : ''}${body.map((p) => `<p>${escapeXml(p)}</p>`).join('\n')}</section>`);
      }
    }

    const navList = toc.map((t) => `<li><a href="${t.id}.xhtml">${escapeXml(t.title)}</a></li>`).join('');
    files.push({ name: 'OEBPS/nav.xhtml', data: xhtml('Contents', `<nav epub:type="toc" id="toc"><h2>Contents</h2><ol>${navList}</ol></nav>`) });
    manifest.push({ id: 'nav', href: 'nav.xhtml', type: 'application/xhtml+xml', properties: 'nav' });
    const fixedCss = fixedLayout
      ? `html,body{width:${width}px;height:${height}px;margin:0;padding:0;overflow:hidden}.page{position:relative;width:${width}px;height:${height}px;overflow:hidden;line-height:1.2}.page .art{position:absolute;display:block;object-fit:cover;width:100%;height:100%;inset:0}.page.art-top .art{height:68%}.page .text-panel{position:absolute;left:0;right:0;bottom:0;max-height:34%;box-sizing:border-box;padding:3% 7%;overflow:hidden;background:#fff;color:#111;font-family:serif;font-size:${Math.round(height * 0.036)}px;text-align:center}.page.full-bleed .text-panel{left:6%;right:6%;bottom:5%;max-height:32%;border-radius:1em;background:rgba(255,255,255,.9)}.page p{margin:.25em 0;text-indent:0}.cover{width:${width}px;height:${height}px}.cover img{width:100%;height:100%;max-height:none;object-fit:contain}`
      : '';
    files.push({ name: 'OEBPS/style.css', data: `body{font-family:serif;line-height:1.5;margin:0 5%}h1,h2{text-align:center}h2 .num{display:block;font-size:.7em;letter-spacing:.15em;color:#666}p{text-indent:1.2em;margin:0}.chapter p:first-of-type,.page p{text-indent:0}.page p{text-align:center;margin:.6em 0;font-size:1.2em}figure{margin:1em 0;text-align:center}img{max-width:100%;height:auto}.cover{text-align:center}.cover img{max-height:100vh}.titlepage{margin-top:30%;text-align:center}.author{font-style:italic;text-indent:0}${fixedCss}` });
    manifest.push({ id: 'css', href: 'style.css', type: 'text/css' });
    const ncx = `<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:${book.id}"/></head><docTitle><text>${escapeXml(book.title)}</text></docTitle><navMap>${toc.map((t, i) => `<navPoint id="n${i + 1}" playOrder="${i + 1}"><navLabel><text>${escapeXml(t.title)}</text></navLabel><content src="${t.id}.xhtml"/></navPoint>`).join('')}</navMap></ncx>\n`;
    files.push({ name: 'OEBPS/toc.ncx', data: ncx });
    manifest.push({ id: 'ncx', href: 'toc.ncx', type: 'application/x-dtbncx+xml' });

    const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="${lang}" dir="${dir}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:${book.id}</dc:identifier>
    <dc:title>${escapeXml(book.title)}</dc:title>
    <dc:language>${lang}</dc:language>
    ${book.brief.author ? `<dc:creator>${escapeXml(book.brief.author)}</dc:creator>` : ''}
    <meta property="dcterms:modified">${modified}</meta>
    ${fixedLayout ? '<meta property="rendition:layout">pre-paginated</meta><meta property="rendition:orientation">auto</meta><meta property="rendition:spread">none</meta>' : ''}
    ${coverHref ? '<meta name="cover" content="img-cover"/>' : ''}
  </metadata>
  <manifest>
    ${manifest.map((m) => `<item id="${m.id}" href="${m.href}" media-type="${m.type}"${m.properties ? ` properties="${m.properties}"` : ''}/>`).join('\n    ')}
  </manifest>
  <spine toc="ncx"${dir === 'rtl' ? ' page-progression-direction="rtl"' : ''}>
    ${spine.map((id) => `<itemref idref="${id}"/>`).join('\n    ')}
  </spine>
</package>
`;
    const container = '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>\n';
    return createZip([
      { name: 'mimetype', data: 'application/epub+zip', store: true },
      { name: 'META-INF/container.xml', data: container },
      { name: 'OEBPS/content.opf', data: opf },
      ...files,
    ]);
  }

  async function exportDocx(bookId) {
    const { Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel, AlignmentType, PageBreak } = await import('docx');
    const { book, pages, chapters, isPicture } = units(bookId);
    const trim = trimSizes[book.brief.trimSize] ?? trimSizes['6x9'];
    const twips = (pt) => Math.round(pt * 20);
    const bidi = rtl(languageCode(book.brief.language));
    const maxWidthPx = Math.round((trim.width - 72) * 96 / 72);
    const image = async (assetId, maxHeightPx) => {
      const art = await readImage(assetId);
      if (!art || art.asset.mimeType === 'image/webp' || !art.size) return null;
      const scale = Math.min(maxWidthPx / art.size.width, maxHeightPx / art.size.height, 1);
      return new ImageRun({ type: art.asset.mimeType === 'image/png' ? 'png' : 'jpg', data: art.bytes, transformation: { width: Math.round(art.size.width * scale), height: Math.round(art.size.height * scale) } });
    };
    const children = [];
    const cover = await image(book.coverAssetId, Math.round((trim.height - 72) * 96 / 72));
    if (cover) children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [cover] }), new Paragraph({ children: [new PageBreak()] }));
    children.push(new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, bidirectional: bidi, children: [new TextRun(book.title)] }));
    if (book.brief.author) children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: book.brief.author, italics: true })] }));
    if (isPicture) {
      for (const page of pages) {
        children.push(new Paragraph({ children: [new PageBreak()] }));
        const art = await image(page.assetId, Math.round(trim.height * 0.6 * 96 / 72));
        if (art) children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [art] }));
        for (const p of paragraphs(page.text)) children.push(new Paragraph({ alignment: AlignmentType.CENTER, bidirectional: bidi, spacing: { before: 120 }, children: [new TextRun({ text: p, size: 28 })] }));
      }
    } else {
      for (const c of chapters) {
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, bidirectional: bidi, children: [new TextRun(`${c.position}. ${c.title || `Chapter ${c.position}`}`)] }));
        const art = await image(c.assetId, 300);
        if (art) children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [art] }));
        const body = c.text ? paragraphs(c.text) : [c.summary];
        body.forEach((p, index) => children.push(new Paragraph({ bidirectional: bidi, alignment: bidi ? AlignmentType.RIGHT : AlignmentType.JUSTIFIED, indent: index ? { firstLine: 360 } : undefined, spacing: { after: 80, line: 300 }, children: [new TextRun(p)] })));
      }
    }
    const doc = new Document({
      creator: book.brief.author || 'Lumina Studio', title: book.title,
      sections: [{ properties: { page: { size: { width: twips(trim.width), height: twips(trim.height) }, margin: { top: 720, bottom: 720, left: 720, right: 720 } } }, children }],
    });
    return Packer.toBuffer(doc);
  }

  // One continuous audiobook from the narrated pages or chapters, in reading order.
  async function exportAudiobook(bookId) {
    const { pages, chapters, isPicture } = units(bookId);
    const items = isPicture ? pages : chapters;
    const narrated = items.filter((item) => item.narrationAssetId && repo.assets.get(item.narrationAssetId));
    if (!narrated.length) throw new RequestError(400, 'Narrate at least one page or chapter first.');
    const clips = [];
    let mime = null;
    for (const item of narrated) {
      const asset = repo.assets.get(item.narrationAssetId);
      if (mime && asset.mimeType !== mime) throw new RequestError(400, 'Narration uses different voices/formats (MP3 and WAV). Re-narrate with one provider to export a single audiobook.');
      mime = asset.mimeType;
      clips.push((await assetStore.read(asset)).bytes);
    }
    try {
      return { audio: joinAudio(clips, mime), mime, missing: items.length - narrated.length };
    } catch (error) {
      throw new RequestError(400, error.message);
    }
  }

  return {
    detail, createBook, importManuscript, draftBible, planPages, revisePage, outline, draftChapter, reviseChapter, illustratePage, illustrateChapter, generateCover,
    narrate, animatePage, illustrationRequest, onGenerationUpdate, exportMarkdown, exportPdf, exportEpub, exportDocx, exportAudiobook, writerFor,
  };
}
