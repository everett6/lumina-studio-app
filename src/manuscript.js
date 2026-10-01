import { readZip } from './zip.js';

const unescapeXml = (text) => text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, code) => {
  const named = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[code.toLowerCase()];
  if (named) return named;
  const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
  return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
});

// Word files: paragraphs with their heading level (Title = 0.5 so it sorts above Heading 1).
function docxParagraphs(bytes) {
  const xml = readZip(bytes).get('word/document.xml')?.toString('utf8');
  if (!xml) throw new Error('This Word file has no document text.');
  return [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map(([p]) => {
    const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? '';
    const level = /^title$/i.test(style) ? 0.5 : Number(/^heading\s?(\d)$/i.exec(style)?.[1] ?? 0);
    const text = [...p.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>/g)]
      .map(([, run, special]) => (special ? (special === 'tab' ? '\t' : '\n') : unescapeXml(run))).join('');
    return { text: text.trim(), level };
  }).filter((p) => p.text);
}

const chapterWord = /^(chapter|part|book|prologue|epilogue|introduction|foreword|afterword|preface|interlude)\b/i;

// Plain text and Markdown: blank lines separate paragraphs; "# Heading" and short "Chapter 3" style lines are headings.
function textParagraphs(text) {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((block) => {
    const trimmed = block.trim();
    const markdown = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (markdown && !trimmed.includes('\n')) return { text: markdown[2].replace(/\s*#+\s*$/, '').trim(), level: markdown[1].length };
    if (!trimmed.includes('\n') && trimmed.length <= 80 && chapterWord.test(trimmed) && !/[.!?,;]$/.test(trimmed)) return { text: trimmed, level: 1 };
    return { text: trimmed.replace(/[ \t]*\n[ \t]*/g, ' '), level: 0 };
  }).filter((p) => p.text);
}

// Splits an existing manuscript (.txt, .md or .docx) into chapters at its headings.
export function parseManuscript({ fileName = '', bytes }) {
  const isDocx = /\.docx$/i.test(fileName) || (bytes.length > 4 && bytes.readUInt32LE(0) === 0x04034b50);
  if (/\.(doc|pdf|odt|rtf|epub)$/i.test(fileName)) throw new Error('Import a .txt, .md or .docx file.');
  const paragraphs = isDocx ? docxParagraphs(bytes) : textParagraphs(bytes.toString('utf8'));
  if (!paragraphs.length) throw new Error('The file has no text.');
  const levels = paragraphs.filter((p) => p.level > 0).map((p) => p.level);
  const counts = new Map();
  for (const level of levels) counts.set(level, (counts.get(level) ?? 0) + 1);
  const sorted = [...counts.keys()].sort((a, b) => a - b);
  // Chapters break at the shallowest heading level that repeats; a single shallower heading is the book title.
  const chapterLevel = sorted.find((level) => counts.get(level) >= 2) ?? sorted.at(-1) ?? null;
  let title = null;
  const chapters = [];
  let current = null;
  for (const p of paragraphs) {
    if (chapterLevel != null && p.level > 0 && p.level < chapterLevel) {
      title ??= p.text;
    } else if (p.level === chapterLevel && chapterLevel != null) {
      current = { title: p.text.slice(0, 200), parts: [] };
      chapters.push(current);
    } else {
      if (!current) {
        current = { title: chapterLevel == null ? 'Chapter 1' : 'Opening', parts: [] };
        chapters.push(current);
      }
      current.parts.push(p.text);
    }
  }
  return {
    title,
    chapters: chapters.map((c) => ({ title: c.title, text: c.parts.join('\n\n').slice(0, 400_000) })).filter((c) => c.text || c.title),
  };
}
