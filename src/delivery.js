import { constants } from 'node:fs';
import { copyFile, lstat, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveFonts } from './fonts.js';
import { probe, run, runCapture } from './video.js';

// File-only publishing helpers. CPU encoding deliberately avoids videoEncoder's GPU probe.
const encode = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-threads', '2', '-pix_fmt', 'yuv420p'];
const audio = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'];
const flags = ['-movflags', '+faststart'];
let filterCache;
async function filters() {
  filterCache ??= runCapture('ffmpeg', ['-hide_banner', '-filters'], 10_000).then(({ stdout, stderr }) =>
    new Set([...`${stdout}\n${stderr}`.matchAll(/^\s*[.A-Z|]{2,3}\s+(\w+)\s/gm)].map((m) => m[1])));
  return filterCache;
}

function absolute(file, label) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) throw new Error(`${label} must be an absolute path.`);
}
async function input(file, label = 'Input') {
  absolute(file, label);
  const data = await stat(file).catch(() => { throw new Error(`${label} file does not exist: ${file}`); });
  if (!data.isFile()) throw new Error(`${label} must be a regular file: ${file}`);
}
async function output(file, extension) {
  absolute(file, 'Output');
  if (path.extname(file).toLowerCase() !== extension) throw new Error(`Output must end in ${extension}.`);
  // Refusing every existing destination also protects symlink and hardlink aliases of inputs.
  try {
    await lstat(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = await stat(path.dirname(file)).catch(() => { throw new Error('Output directory does not exist.'); });
    if (!parent.isDirectory()) throw new Error('Output parent must be a directory.');
    return;
  }
  throw new Error(`Output already exists; refusing to overwrite an input or existing file: ${file}`);
}
function positive(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number.`);
}
function size(width, height) {
  if (![width, height].every((n) => Number.isSafeInteger(n) && n >= 2 && n % 2 === 0)) throw new Error('Width and height must be positive even integers (at least 2).');
}
function timing(seconds, fps) {
  positive(seconds, 'seconds');
  positive(fps, 'fps');
  const frames = Math.max(1, Math.round(seconds * fps));
  if (!Number.isSafeInteger(frames)) throw new Error('seconds × fps is too large.');
  return { frames, seconds: frames / fps };
}
function clean(text) {
  if (typeof text !== 'string') throw new Error('Text must be a string.');
  return text.normalize('NFC').replace(/<[^>]*>/g, '').replace(/\{[^}]*\}/g, '')
    .replace(/[\\{}]/g, '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/gu, ' ').trim();
}
function requiredTitle(title) {
  const text = clean(title);
  if (!text) throw new Error('title must contain visible text.');
  return text;
}
// Conservative em estimates keep text inside safe margins without another raster dependency.
const em = (ch) => ch === ' ' ? 0.4 : /[^\u0000-\u00ff]/u.test(ch) ? 1.1 : /[MW@%]/.test(ch) ? 1 : 0.75;
const units = (text) => [...text].reduce((sum, ch) => sum + em(ch), 0);
function wrap(text, limit, measure = (s) => [...s].length) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/u).filter(Boolean)) {
    if (line && measure(`${line} ${word}`) <= limit) { line += ` ${word}`; continue; }
    if (line) { lines.push(line); line = ''; }
    for (const ch of word) {
      if (line && measure(line + ch) > limit) { lines.push(line); line = ''; }
      line += ch;
    }
  }
  if (line) lines.push(line);
  return lines;
}
function fit(text, width, initial, maxLines = 2) {
  for (let fontSize = Math.max(1, Math.floor(initial)); fontSize >= 1; fontSize--) {
    const lines = wrap(text, width / fontSize, units);
    if (lines.length <= maxLines && lines.every((line) => units(line) * fontSize <= width)) return { lines, fontSize };
  }
  throw new Error('Text is too long to fit in the requested image size.');
}
const cover = (width, height) => `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height},setsar=1`;
async function staged(file, extension, render) {
  await output(file, extension);
  const dir = await mkdtemp(path.join(tmpdir(), 'lumina-delivery-'));
  try {
    const temp = path.join(dir, `output${extension}`);
    await render(temp, dir);
    await copyFile(temp, file, constants.COPYFILE_EXCL);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function ffmpeg(args) {
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-filter_threads', '1', '-filter_complex_threads', '1', ...args], 3_600_000);
}

async function fontFor(text, dir) {
  const resolved = resolveFonts(text, { serif: false });
  // resolveFonts handles non-Latin scripts; fontconfig supplies a bold Latin default.
  let file = resolved?.fonts?.[Object.keys(resolved?.fonts ?? {}).find((key) => key !== 'base')]?.file;
  try {
    file ??= (await run('fc-match', ['-f', '%{file}', 'sans-serif:style=Bold'], 5_000)).trim();
  } catch { file ??= resolved?.fonts?.base?.file; }
  if (!file) return null; // drawtext/libass may still use their own configured default.
  const target = path.join(dir, 'font.ttf');
  await copyFile(file, target);
  return target;
}
function assTime(seconds) {
  const cs = Math.ceil(seconds * 100);
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}
// Drawtext reads literal UTF-8 files, never user text in a filter expression. ASS is the fallback.
async function textFilter(dir, layers, width, height, { frames = 30, fps = 30 } = {}) {
  const available = await filters();
  if (!available.has('drawtext') && !available.has('subtitles')) throw new Error('Text rendering requires ffmpeg drawtext or subtitles/libass.');
  const font = await fontFor(layers.map((l) => l.text).join(' '), dir);
  // libass retains fractional positions during rolls; drawtext is the portable fallback.
  const rolling = layers.some((layer) => layer.travel != null);
  if (available.has('drawtext') && (!rolling || !available.has('subtitles'))) {
    const result = [];
    for (const [i, layer] of layers.entries()) {
      const file = path.join(dir, `text-${i}.txt`);
      await writeFile(file, layer.text);
      const y = layer.travel == null ? String(layer.y) : `${layer.y}-n*${layer.travel}/${Math.max(1, frames - 1)}`;
      result.push(`drawtext=${font ? `fontfile=${font}:` : "font='sans-serif:style=Bold':"}textfile=${file}:expansion=none:fontsize=${layer.fontSize}:fontcolor=white:borderw=${Math.max(1, Math.round(layer.fontSize / 18))}:bordercolor=black:shadowcolor=black@0.8:shadowx=1:shadowy=2:x=(w-text_w)/2:y='${y}'`);
    }
    return result.join(',');
  }
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,DejaVu Sans,24,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,8,0,0,0,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const duration = frames / fps;
  const events = layers.map((l) => {
    const pos = l.travel == null ? `\\pos(${width / 2},${l.y})` : `\\move(${width / 2},${l.y},${width / 2},${l.y - l.travel},0,${Math.round((frames - 1) / fps * 1000)})`;
    return `Dialogue: 0,0:00:00.00,${assTime(duration)},Default,,0,0,0,,{\\an8\\fs${l.fontSize}${pos}}${l.text}`;
  });
  const file = path.join(dir, 'text.ass');
  await writeFile(file, header + events.join('\n') + '\n');
  return `subtitles=filename=${file}:fontsdir=${dir}`;
}

function titleLayers(title, subtitle, width, height, thumbnail) {
  const main = fit(title, width * 0.86, height * (thumbnail ? 0.105 : 0.12));
  const sub = fit(subtitle, width * 0.84, height * 0.05);
  if (thumbnail) {
    const estimated = main.lines.length * Math.ceil(main.fontSize * 1.3) + sub.lines.length * Math.ceil(sub.fontSize * 1.4);
    const shrink = Math.min(1, height * 0.28 / estimated);
    main.fontSize = Math.max(1, Math.floor(main.fontSize * shrink));
    sub.fontSize = Math.max(1, Math.floor(sub.fontSize * shrink));
  }
  const step = Math.ceil(main.fontSize * 1.3);
  const subStep = Math.ceil(sub.fontSize * 1.4);
  const total = main.lines.length * step + sub.lines.length * subStep;
  const top = thumbnail ? height * 0.95 - total : (height - total) / 2;
  return [...main.lines.map((text, i) => ({ text, fontSize: main.fontSize, y: Math.round(top + i * step) })),
    ...sub.lines.map((text, i) => ({ text, fontSize: sub.fontSize, y: Math.round(top + main.lines.length * step + i * subStep) }))];
}

export async function makeThumbnail(framePath, outPng, { title, subtitle = '', width = 1280, height = 720 } = {}) {
  size(width, height);
  if (width * 9 !== height * 16) throw new Error('Thumbnail size must have a 16:9 aspect ratio.');
  title = requiredTitle(title); subtitle = clean(subtitle);
  await input(framePath, 'Frame');
  await staged(outPng, '.png', async (out, dir) => {
    const text = await textFilter(dir, titleLayers(title, subtitle, width, height, true), width, height);
    await ffmpeg(['-i', framePath, '-vf', `${cover(width, height)},${text}`, '-frames:v', '1', '-threads', '1', out]);
  });
  return { file: outPng, width, height };
}

export async function titleCard(outMp4, { title, subtitle = '', seconds = 3, width = 1920, height = 1080, fps = 30, backgroundImage } = {}) {
  size(width, height);
  const time = timing(seconds, fps);
  title = requiredTitle(title); subtitle = clean(subtitle);
  if (backgroundImage != null) await input(backgroundImage, 'Background image');
  await staged(outMp4, '.mp4', async (out, dir) => {
    const available = await filters();
    const source = backgroundImage ? ['-loop', '1', '-framerate', String(fps), '-i', backgroundImage] : ['-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}`];
    const blur = available.has('gblur') ? ',gblur=sigma=12' : available.has('boxblur') ? ',boxblur=2:1' : '';
    const background = backgroundImage ? `${cover(width, height)}${blur},lut=y=val*0.35,` : '';
    const text = await textFilter(dir, titleLayers(title, subtitle, width, height, false), width, height, { ...time, fps });
    const fade = Math.min(0.5, time.seconds / 3);
    const fades = available.has('fade') ? `,fade=t=in:d=${fade},fade=t=out:st=${Math.max(0, time.seconds - fade - 1 / fps)}:d=${fade}` : '';
    await ffmpeg([...source, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-map', '0:v:0', '-map', '1:a:0', '-vf', `${background}${text}${fades},fps=${fps},setsar=1`, ...encode, ...audio,
      '-frames:v', String(time.frames), '-t', String(time.seconds), '-fps_mode', 'cfr', ...flags, out]);
  });
  return { file: outMp4, seconds: time.seconds };
}

export async function endCredits(outMp4, { sections, seconds, width = 1920, height = 1080, fps = 30 } = {}) {
  size(width, height);
  if (!Array.isArray(sections) || !sections.length) throw new Error('sections must be a non-empty array of { heading, lines }.');
  const fontSize = Math.max(2, Math.round(height * 0.045));
  const rows = [];
  for (const section of sections) {
    if (!section || typeof section.heading !== 'string' || !Array.isArray(section.lines)) throw new Error('Each credits section requires a heading and a lines array.');
    for (const [i, text] of [section.heading, ...section.lines].entries()) {
      const fs = i === 0 ? Math.ceil(fontSize * 1.15) : fontSize;
      rows.push(...wrap(clean(text), width * 0.86 / fs, units).map((line) => ({ text: line, fontSize: fs })));
    }
    rows.push({ text: '', fontSize });
  }
  if (!rows.some((r) => r.text)) throw new Error('Credits sections must contain visible text.');
  const time = timing(seconds ?? (2 + (rows.length - 1) * 0.8), fps);
  const step = Math.ceil(fontSize * 1.8);
  const travel = height + rows.length * step;
  const layers = rows.map((row, i) => ({ ...row, y: height + i * step, travel })).filter((r) => r.text);
  await staged(outMp4, '.mp4', async (out, dir) => {
    const text = await textFilter(dir, layers, width, height, { ...time, fps });
    await ffmpeg(['-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}`, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-map', '0:v:0', '-map', '1:a:0', '-vf', `${text},fps=${fps},setsar=1`, ...encode, ...audio,
      '-frames:v', String(time.frames), '-t', String(time.seconds), '-fps_mode', 'cfr', ...flags, out]);
  });
  return { file: outMp4, seconds: time.seconds };
}

export async function makeShort(filmPath, outMp4, { aspect = '9:16', maxSeconds = 60, start = 0, focusX = 0.5 } = {}) {
  if (aspect !== '9:16') throw new Error('aspect must be 9:16.');
  positive(maxSeconds, 'maxSeconds');
  if (!Number.isFinite(start) || start < 0) throw new Error('start must be a non-negative finite number.');
  if (!Number.isFinite(focusX) || focusX < 0 || focusX > 1) throw new Error('focusX must be between 0 and 1.');
  await input(filmPath, 'Film');
  const info = await probe(filmPath);
  size(info.width, info.height);
  const duration = info.frames ? info.frames / info.fps : info.duration;
  if (start >= duration) throw new Error('start must be before the end of the film.');
  const time = timing(Math.min(maxSeconds, duration - start), info.fps);
  // A sub-frame tail otherwise seeks past the last picture and produces an audio-only MP4.
  const frameStart = Math.floor(start * info.fps) / info.fps;
  // Crop about a point in source coordinates, clamping at the left/right edges.
  const cropWidth = Math.min(info.width, Math.max(2, Math.floor(info.height * 9 / 16 / 2) * 2));
  const cropHeight = Math.min(info.height, Math.max(2, Math.floor(cropWidth * 16 / 9 / 2) * 2));
  const x = Math.round(Math.max(0, Math.min(info.width - cropWidth, info.width * focusX - cropWidth / 2)) / 2) * 2;
  await staged(outMp4, '.mp4', async (out) => {
    await ffmpeg(['-ss', String(frameStart), '-i', filmPath, '-map', '0:v:0', '-map', '0:a?', '-vf', `crop=${cropWidth}:${cropHeight}:${x}:(ih-oh)/2,scale=1080:1920:flags=lanczos,setsar=1,fps=${info.fps}`, ...encode, ...(info.hasAudio ? audio : []),
      '-frames:v', String(time.frames), '-t', String(time.seconds), '-fps_mode', 'cfr', ...flags, out]);
  });
  return { file: outMp4, seconds: time.seconds, width: 1080, height: 1920 };
}

export async function burnSubtitles(filmPath, srtPath, outMp4, { fontSize, style = 'anime' } = {}) {
  if (style !== 'anime') throw new Error('Subtitle style must be anime.');
  if (fontSize != null) positive(fontSize, 'fontSize');
  await input(filmPath, 'Film');
  await input(srtPath, 'SRT');
  const info = await probe(filmPath);
  size(info.width, info.height);
  if (!(await filters()).has('subtitles')) throw new Error('ffmpeg subtitles/libass is unavailable; rebuild ffmpeg with libass to burn subtitles.');
  await staged(outMp4, '.mp4', async (out, dir) => {
    const captions = path.join(dir, 'captions.srt');
    await copyFile(srtPath, captions);
    // original_size and explicit PlayRes make fontSize a pixel size at the source resolution.
    const fs = fontSize ?? Math.max(8, Math.round(info.height * 0.045));
    const styling = `PlayResX=${info.width},PlayResY=${info.height},FontName=DejaVu Sans,FontSize=${fs},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=${Math.max(1, fs / 12)},Shadow=1,Bold=-1,Alignment=2,MarginL=${Math.ceil(info.width * 0.06)},MarginR=${Math.ceil(info.width * 0.06)},MarginV=${Math.ceil(info.height * 0.06)}`;
    await ffmpeg(['-i', filmPath, '-map', '0:v:0', '-map', '0:a?', '-vf', `subtitles=filename=${captions}:original_size=${info.width}x${info.height}:force_style='${styling}',fps=${info.fps},setsar=1`, ...encode, '-c:a', 'copy', '-fps_mode', 'cfr', ...flags, out]);
  });
  return { file: outMp4 };
}

export async function srtFromCues(cues) {
  if (!Array.isArray(cues)) throw new Error('cues must be an array.');
  const timestamp = (ms) => `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
  const result = [];
  for (const [i, cue] of cues.entries()) {
    if (!cue || !Number.isFinite(cue.from) || !Number.isFinite(cue.to) || cue.from < 0 || cue.to <= cue.from) throw new Error(`Cue ${i + 1}: from/to times must be finite, non-negative, with to after from.`);
    const from = Math.round(cue.from * 1000), to = Math.round(cue.to * 1000);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to <= from) throw new Error(`Cue ${i + 1}: times must span at least one millisecond after rounding.`);
    const text = clean(cue.text).replace(/-->/g, '→');
    if (!text) throw new Error(`Cue ${i + 1}: text must contain visible text.`);
    result.push(`${i + 1}\n${timestamp(from)} --> ${timestamp(to)}\n${wrap(text, 42).join('\n')}\n`);
  }
  return result.join('\n');
}
