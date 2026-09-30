import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { joinAudio, splitForSpeech, toneWav } from '../src/audio.js';
import { scriptRuns } from '../src/fonts.js';
import { startTestApp } from './helpers.js';

const writer = 'mock:mock-director';
const mockImage = { provider: 'mock', model: 'mock-image' };
const has = (cmd) => { try { execFileSync('which', [cmd]); return true; } catch { return false; } };

async function until(check, tries = 300) {
  for (let i = 0; i < tries; i += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out');
}

async function download(t, url) {
  const response = await fetch(`${t.app.origin}${url}`, { headers: { authorization: `Bearer ${t.app.token}` } });
  return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
}

// List and read ZIP entries with python's zipfile (a trustworthy independent reader).
function zipEntries(bytes) {
  const dir = mkdtempSync(path.join(tmpdir(), 'lumina-zip-'));
  const file = path.join(dir, 'x.zip');
  writeFileSync(file, bytes);
  try {
    const out = execFileSync('python3', ['-c', 'import sys,zipfile,json;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(json.dumps([[i.filename,i.compress_type,z.read(i).decode("utf8","replace")] for i in z.infolist()]))', file], { encoding: 'utf8', maxBuffer: 50e6 });
    return JSON.parse(out).map(([name, method, text]) => ({ name, method, text }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('speech helpers: split long text at sentence boundaries and join WAV clips', () => {
  const text = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} ends here.`).join(' ');
  const chunks = splitForSpeech(text, 500);
  assert.ok(chunks.length > 5);
  assert.ok(chunks.every((c) => c.length <= 500 && /\.$/.test(c)));
  assert.equal(chunks.join(' '), text);
  const joined = joinAudio([toneWav(0.5), toneWav(0.25)], 'audio/wav');
  assert.equal(joined.readUInt32LE(40), 16000 * 2 * 0.75);
  assert.throws(() => joinAudio([toneWav(0.1, 440, 16000), toneWav(0.1, 440, 24000)], 'audio/wav'), /different audio formats/);
});

test('script runs split mixed text for per-script fonts', () => {
  assert.deepEqual(scriptRuns('Hi 世界!').map((r) => r.script), ['base', 'cjk']);
  assert.deepEqual(scriptRuns('مرحبا world').map((r) => r.script), ['arabic', 'base']);
});

test('novel: bible → outline → draft → revise → cover/art → narration → PDF, EPUB, DOCX, audiobook', async () => {
  const t = await startTestApp();
  try {
    const { project } = (await t.call('POST', '/api/projects', { name: 'Novel' })).body;
    const { book } = (await t.call('POST', `/api/projects/${project.id}/books`, {
      title: 'The Quiet Lake', kind: 'novel', writer, brief: { premise: 'A fox confronts the lake that took her father.', chapterCount: 3, wordsPerChapter: 400, author: 'A. Writer', narration: { provider: 'mock', model: 'mock-voice', voice: 'tone-low' } },
    })).body;
    assert.equal(book.kind, 'novel');
    assert.equal(book.brief.trimSize, '6x9', 'novel defaults');
    await t.call('POST', `/api/books/${book.id}/bible`, {});
    const outlined = (await t.call('POST', `/api/books/${book.id}/outline`, {})).body;
    assert.equal(outlined.chapters.length, 3);
    assert.equal(outlined.chapters[0].beats.length, 3);
    assert.equal((await t.call('POST', `/api/books/${book.id}/outline`, {})).status, 409);

    const [c1, c2] = outlined.chapters;
    const drafted = (await t.call('POST', `/api/chapters/${c1.id}/draft`, {})).body.chapter;
    assert.ok(drafted.text.split(/\s+/).length > 200);
    assert.equal((await t.call('POST', `/api/chapters/${c2.id}/revise`, { instruction: 'x' })).status, 400, 'cannot revise an empty chapter');
    await t.call('POST', `/api/chapters/${c2.id}/draft`, {});
    const revised = (await t.call('POST', `/api/chapters/${c2.id}/revise`, { instruction: 'more tension' })).body.chapter;
    assert.match(revised.text, /more tension/);
    await t.call('PATCH', `/api/chapters/${c1.id}`, { title: 'Chapter One: Arrival', beats: ['a', 'b'] });
    const history = (await t.call('GET', `/api/chapters/${c1.id}/revisions`)).body.revisions;
    assert.deepEqual(history.map((r) => r.source), ['edit', 'draft', 'outline']);
    await t.call('POST', `/api/chapters/${c2.id}/move`, { direction: 'up' });

    // Cover, chapter art and narration attach themselves when their jobs finish.
    await t.call('POST', `/api/books/${book.id}/cover`, mockImage);
    await t.call('POST', `/api/chapters/${c1.id}/illustrate`, mockImage);
    await t.call('POST', `/api/chapters/${c1.id}/narrate`, {});
    await t.call('POST', `/api/chapters/${c2.id}/narrate`, {});
    const ready = await until(async () => {
      const d = (await t.call('GET', `/api/books/${book.id}`)).body;
      const one = d.chapters.find((c) => c.id === c1.id);
      const two = d.chapters.find((c) => c.id === c2.id);
      return d.book.coverPath && one.assetPath && one.narrationPath && two.narrationPath ? d : null;
    });
    assert.equal(ready.chapters[0].id, c2.id, 'moved up');
    assert.match(ready.chapters.find((c) => c.id === c1.id).narrationPath, /\.wav$/);

    const pdf = await download(t, `/api/books/${book.id}/export.pdf`);
    assert.equal(pdf.status, 200);
    const pdfText = pdf.bytes.toString('latin1');
    const pdfPages = (pdfText.match(/\/Type \/Page\b/g) ?? []).length;
    assert.ok(pdfPages >= 1 + 1 + 3, `cover + title + at least one page per chapter (got ${pdfPages})`);

    const epub = await download(t, `/api/books/${book.id}/export.epub`);
    assert.equal(epub.headers.get('content-type'), 'application/epub+zip');
    if (has('python3')) {
      const entries = zipEntries(epub.bytes);
      assert.equal(entries[0].name, 'mimetype');
      assert.equal(entries[0].method, 0, 'mimetype stored uncompressed');
      assert.equal(entries[0].text, 'application/epub+zip');
      const opf = entries.find((e) => e.name === 'OEBPS/content.opf').text;
      assert.match(opf, /<dc:language>en<\/dc:language>/);
      assert.match(opf, /properties="cover-image"/);
      assert.match(opf, /properties="nav"/);
      const chapter = entries.find((e) => e.name === 'OEBPS/chapter-002.xhtml').text;
      assert.match(chapter, /Chapter One: Arrival/);
      assert.ok(entries.some((e) => e.name.startsWith('OEBPS/images/chapter-')));
      if (has('xmllint')) {
        for (const entry of entries.filter((e) => /\.(xhtml|opf|ncx|xml)$/.test(e.name))) {
          execFileSync('xmllint', ['--noout', '-'], { input: entry.text });
        }
      }
    }

    const docx = await download(t, `/api/books/${book.id}/export.docx`);
    assert.equal(docx.status, 200);
    if (has('python3')) {
      const documentXml = zipEntries(docx.bytes).find((e) => e.name === 'word/document.xml').text;
      assert.match(documentXml, /Chapter One: Arrival/);
      assert.match(documentXml, /more tension/);
    }

    const audio = await download(t, `/api/books/${book.id}/export.audio`);
    assert.equal(audio.headers.get('content-type'), 'audio/wav');
    assert.equal(audio.headers.get('x-lumina-missing-narration'), '1');
    assert.equal(audio.bytes.toString('latin1', 0, 4), 'RIFF');

    const md = await download(t, `/api/books/${book.id}/export.md`);
    assert.match(md.bytes.toString(), /## 1\. The Storm 2/);
  } finally {
    await t.close();
  }
});

test('nonfiction uses its own prompts and structure', async () => {
  const t = await startTestApp();
  try {
    const { project } = (await t.call('POST', '/api/projects', { name: 'NF' })).body;
    const { book } = (await t.call('POST', `/api/projects/${project.id}/books`, { title: 'Water Wise', kind: 'nonfiction', writer, brief: { chapterCount: 2 } })).body;
    assert.equal(book.brief.chapterCount, 2);
    assert.equal((await t.call('POST', `/api/books/${book.id}/plan`, {})).status, 400, 'no page plans for nonfiction');
    assert.equal((await t.call('POST', `/api/books/${book.id}/outline`, {})).body.chapters.length, 2);
  } finally {
    await t.close();
  }
});

test('picture book: bleed boxes, full-bleed layout, non-Latin fonts, narration and animated pages', async () => {
  const t = await startTestApp();
  try {
    const { project } = (await t.call('POST', '/api/projects', { name: 'Intl' })).body;
    const { book } = (await t.call('POST', `/api/projects/${project.id}/books`, {
      title: '湖のピップ', kind: 'picture_book', writer, brief: { pageCount: 2, trimSize: '8x8', bleed: true, layout: 'full-bleed', language: 'Japanese', narration: { provider: 'mock', model: 'mock-voice' } },
    })).body;
    const { pages } = (await t.call('POST', `/api/books/${book.id}/plan`, {})).body;
    await t.call('PATCH', `/api/pages/${pages[0].id}`, { text: 'ピップは湖を見つめた。 مرحبا بالعالم.' });
    await t.call('POST', `/api/pages/${pages[0].id}/illustrate`, mockImage);
    await until(async () => (await t.call('GET', `/api/books/${book.id}`)).body.pages[0].assetId);

    await t.call('POST', `/api/pages/${pages[0].id}/narrate`, {});
    const video = await t.call('POST', `/api/pages/${pages[0].id}/animate`, { provider: 'mock', model: 'mock-video', duration: 4 });
    assert.equal(video.status, 202);
    assert.equal(video.body.generation.operation, 'video');
    assert.equal((await t.call('POST', `/api/pages/${pages[1].id}/animate`, { provider: 'mock', model: 'mock-video' })).status, 400, 'needs art first');
    const page = await until(async () => {
      const p = (await t.call('GET', `/api/books/${book.id}`)).body.pages[0];
      return p.narrationPath && p.videoPath ? p : null;
    });
    const clip = await fetch(`${t.app.origin}${page.videoPath}`, { headers: { authorization: `Bearer ${t.app.token}`, range: 'bytes=0-7' } });
    assert.equal(clip.status, 206);
    assert.equal(clip.headers.get('content-type'), 'video/mp4');
    assert.equal((await clip.arrayBuffer()).byteLength, 8);

    const pdf = await download(t, `/api/books/${book.id}/export.pdf`);
    const text = pdf.bytes.toString('latin1');
    assert.match(text, /\/MediaBox \[0 0 594 594\]/, '8in + 2 × 0.125in bleed');
    assert.match(text, /\/TrimBox \[9 9 585 585\]/);
    assert.match(text, /\/BleedBox/);
    if (has('fc-match')) {
      assert.equal(pdf.headers.get('x-lumina-missing-scripts'), '');
      assert.match(text, /\/FontFile[23]?/, 'fonts embedded');
      if (has('pdftotext')) {
        const dir = mkdtempSync(path.join(tmpdir(), 'lumina-pdf-'));
        writeFileSync(path.join(dir, 'b.pdf'), pdf.bytes);
        const extracted = execFileSync('pdftotext', [path.join(dir, 'b.pdf'), '-'], { encoding: 'utf8' });
        rmSync(dir, { recursive: true, force: true });
        assert.match(extracted, /湖のピップ/);
        assert.match(extracted, /ピップは湖を見つめた/);
      }
    }
    const epub = await download(t, `/api/books/${book.id}/export.epub`);
    if (has('python3')) assert.match(zipEntries(epub.bytes).find((e) => e.name === 'OEBPS/content.opf').text, /<dc:language>ja<\/dc:language>/);
  } finally {
    await t.close();
  }
});

test('Create: speech and video jobs through /api/generate with validation', async () => {
  const t = await startTestApp();
  try {
    const { project } = (await t.call('POST', '/api/projects', { name: 'Media' })).body;
    const speech = (await t.call('POST', '/api/generate', { projectId: project.id, operation: 'speech', prompt: 'Hello there.', provider: 'mock', model: 'mock-voice', voice: 'tone-high' })).body.generation;
    assert.equal(speech.params.voice, 'tone-high');
    const done = (await t.call('POST', `/api/generations/${speech.id}/wait`, {})).body.generation;
    assert.equal(done.status, 'completed');
    assert.equal(done.mimeType, 'audio/wav');
    const clip = (await t.call('POST', '/api/generate', { projectId: project.id, operation: 'video', prompt: 'waves', provider: 'mock', model: 'mock-video', duration: 8 })).body.generation;
    assert.equal(clip.params.duration, 8);
    assert.equal((await t.call('POST', `/api/generations/${clip.id}/wait`, {})).body.generation.mimeType, 'video/mp4');
    const wrong = await t.call('POST', '/api/generate', { projectId: project.id, operation: 'video', prompt: 'x', provider: 'mock', model: 'mock-image' });
    assert.equal(wrong.status, 400);
    const assets = (await t.call('GET', `/api/projects/${project.id}`)).body.assets;
    assert.deepEqual(assets.map((a) => a.kind).sort(), ['audio', 'video']);
  } finally {
    await t.close();
  }
});
