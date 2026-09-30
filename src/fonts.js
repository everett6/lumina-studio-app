import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Characters the built-in PDF fonts (WinAnsi) can show. Anything else needs an embedded font.
const winAnsiExtra = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.split(''));
export const needsEmbeddedFont = (text) => [...text].some((ch) => ch.codePointAt(0) > 0xff && !winAnsiExtra.has(ch));

// Script classes that usually need their own font file. Everything else uses the base font.
const scripts = [
  { id: 'cjk', test: /[ᄀ-ᇿ⺀-鿿ꥠ-꥿가-힯豈-﫿＀-￯]/u },
  { id: 'arabic', test: /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/u },
  { id: 'hebrew', test: /[֐-׿יִ-ﭏ]/u },
  { id: 'devanagari', test: /[ऀ-ॿ]/u },
  { id: 'bengali', test: /[ঀ-৿]/u },
  { id: 'tamil', test: /[஀-௿]/u },
  { id: 'thai', test: /[฀-๿]/u },
];
const scriptOf = (ch) => (/[\s\p{P}\p{N}]/u.test(ch) ? null : scripts.find((s) => s.test.test(ch))?.id ?? 'base');

// Split text into runs of the same script; spaces, digits and punctuation join the surrounding run.
export function scriptRuns(text) {
  const runs = [];
  for (const ch of text) {
    const script = scriptOf(ch);
    const last = runs.at(-1);
    if (last && (script === null || script === last.script)) last.text += ch;
    else if (!last && script === null) runs.push({ script: 'base', text: ch });
    else runs.push({ script: script ?? last.script, text: ch });
  }
  return runs;
}

function fcMatch(pattern) {
  try {
    const out = execFileSync('fc-match', ['-f', '%{file}\n%{postscriptname}', pattern], { encoding: 'utf8', timeout: 5000 });
    const [file, postscriptName] = out.split('\n');
    return file && existsSync(file) && /\.(ttf|otf|ttc)$/i.test(file) ? { file, postscriptName } : null;
  } catch {
    return null;
  }
}

// Finds installed fonts (via fontconfig) that cover each script present in `text`.
// Returns null when the built-in fonts are enough. `override` is a user-supplied font file for the base text.
export function resolveFonts(text, { override, serif = true } = {}) {
  const custom = override && existsSync(override) ? { file: override } : null;
  if (!custom && !needsEmbeddedFont(text)) return null;
  const family = serif ? 'serif' : 'sans-serif';
  const present = new Set(scriptRuns(text).map((r) => r.script));
  const fonts = { base: custom ?? fcMatch(`${family}:lang=en`) ?? fcMatch(family) };
  if (!fonts.base) return { missing: ['base'], fonts: {} };
  const missing = [];
  for (const script of present) {
    if (script === 'base') continue;
    const sample = [...text].find((ch) => scriptOf(ch) === script);
    const hex = sample.codePointAt(0).toString(16);
    // Prefer the requested style, then any font covering the character.
    const found = fcMatch(`${family}:charset=${hex}`) ?? fcMatch(`:charset=${hex}`);
    if (found) fonts[script] = found;
    else missing.push(script);
  }
  return { fonts, missing };
}
