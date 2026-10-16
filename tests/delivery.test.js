import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { run } from '../src/video.js';

let api, dir, film, frame, filters;
before(async () => {
  api = await import('../src/delivery.js');
  filters = await run('ffmpeg', ['-hide_banner', '-filters']);
  dir = await mkdtemp(path.join(tmpdir(), 'lumina-delivery-test-'));
  film = path.join(dir, 'film.mp4');
  frame = path.join(dir, 'frame.png');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=24:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-t', '2', film]);
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=navy:s=160x90', '-frames:v', '1', frame]);
});
after(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
const has = (name) => new RegExp(`\\s${name}\\s`).test(filters);
const exec = promisify(execFile);
async function pixels(file, time, format = 'gray') {
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', '-pix_fmt', format, '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}
const average = (bytes) => bytes.reduce((sum, byte) => sum + byte, 0) / bytes.length;
function textAvailable(t) {
  if (has('drawtext') || has('subtitles')) return true;
  t.skip('ffmpeg lacks both drawtext and subtitles/libass');
  return false;
}
async function info(file) {
  return JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
}
async function check(file, width, height, fps, seconds, audio = true) {
  const data = await info(file);
  const video = data.streams.find((s) => s.codec_type === 'video');
  assert.equal(video.width, width);
  assert.equal(video.height, height);
  if (fps) {
    const rate = (s) => s.split('/').map(Number).reduce((a, b) => a / b);
    assert.ok(Math.abs(rate(video.avg_frame_rate) - fps) < 0.001);
    assert.ok(Math.abs(rate(video.r_frame_rate) - fps) < 0.001);
    assert.equal(video.pix_fmt, 'yuv420p');
    assert.ok(Math.abs(Number(data.format.duration) - seconds) <= 1 / fps + 0.002, data.format.duration);
    assert.ok(Math.abs(Number(video.duration) - seconds) <= 1 / fps + 0.002);
  }
  if (audio) assert.ok(data.streams.some((s) => s.codec_type === 'audio'));
  if (fps) {
    const bytes = await readFile(file);
    assert.ok(bytes.indexOf(Buffer.from('moov')) < bytes.indexOf(Buffer.from('mdat')), 'faststart');
  }
  return data;
}

test('SRT rounds milliseconds, wraps and sanitises markup and controls', async () => {
  const srt = await api.srtFromCues([{ from: 59.9996, to: 61.2344, text: '<b>Hello</b> {\\pos(1,2)} world\u0000\n\nnext' }]);
  assert.equal(srt, '1\n00:01:00,000 --> 00:01:01,234\nHello world next\n');
  const long = await api.srtFromCues([{ from: 0, to: 1, text: 'word '.repeat(30) }]);
  assert.ok(long.trim().split('\n').slice(2).every((line) => line.length <= 42));
  await assert.rejects(api.srtFromCues([{ from: 1, to: 0, text: 'bad' }]), /to|end|time/i);
  await assert.rejects(api.srtFromCues([{ from: 0, to: 0.0001, text: 'bad' }]), /millisecond|time/i);
});

test('thumbnail cover-crops and renders literal punctuation in two title lines', async (t) => {
  if (!textAvailable(t)) return;
  const out = path.join(dir, 'thumb.png');
  assert.deepEqual(await api.makeThumbnail(frame, out, { title: "A hero's 100% journey: [night], dawn", subtitle: 'An anime film', width: 320, height: 180 }), { file: out, width: 320, height: 180 });
  await check(out, 320, 180, null, null, false);
  const defaults = path.join(dir, 'thumb-default.png');
  await api.makeThumbnail(frame, defaults, { title: 'Dawn' });
  await check(defaults, 1280, 720, null, null, false);
});

test('title cards have exact CFR timing, fades, and silent 48 kHz stereo AAC', async (t) => {
  if (!textAvailable(t)) return;
  for (const backgroundImage of [undefined, frame]) {
    const out = path.join(dir, `card-${Boolean(backgroundImage)}.mp4`);
    await api.titleCard(out, { title: 'The rising moon', subtitle: 'A story', seconds: 0.73, width: 160, height: 90, fps: 30, backgroundImage });
    const data = await check(out, 160, 90, 30, 0.73);
    const a = data.streams.find((s) => s.codec_type === 'audio');
    assert.equal(a.codec_name, 'aac');
    assert.equal(a.sample_rate, '48000');
    assert.equal(a.channels, 2);
    const { stdout: samples } = await exec('ffmpeg', ['-v', 'error', '-i', out, '-map', '0:a', '-f', 's16le', '-'], { encoding: 'buffer' });
    assert.ok(samples.every((byte) => byte === 0), 'audio samples are silent');
    assert.ok(average(await pixels(out, 0.35)) > average(await pixels(out, 0)) + 0.2, 'fades in');
    assert.ok(average(await pixels(out, 0.35)) > average(await pixels(out, 0.7)) + 0.2, 'fades out');
  }
});

test('credits roll moves upward at constant CFR and returns automatic duration', async (t) => {
  if (!textAvailable(t)) return;
  const out = path.join(dir, 'credits.mp4');
  const result = await api.endCredits(out, { sections: [{ heading: 'CAST', lines: ['Aiko — Moon'] }], seconds: 2.5, width: 160, height: 90, fps: 24 });
  assert.equal(result.seconds, 2.5);
  await check(out, 160, 90, 24, 2.5);
  const timestamps = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', out])).frames.map((f) => Number(f.best_effort_timestamp_time));
  for (let i = 1; i < timestamps.length; i++) assert.ok(Math.abs(timestamps[i] - timestamps[i - 1] - 1 / 24) < 0.00001);
  const auto = await api.endCredits(path.join(dir, 'auto.mp4'), { sections: [{ heading: 'FIN', lines: [] }], width: 160, height: 90 });
  assert.ok(auto.seconds > 0 && auto.seconds <= 3);
  await check(auto.file, 160, 90, 30, auto.seconds);
  const centres = [];
  for (const time of [0.5, 1, 1.5]) {
    const image = await pixels(auto.file, time);
    let weight = 0, weightedY = 0;
    for (let i = 0; i < image.length; i++) if (image[i] > 100) { weight += image[i]; weightedY += Math.floor(i / 160) * image[i]; }
    assert.ok(weight > 0, 'credits are visible while rolling');
    centres.push(weightedY / weight);
  }
  assert.ok(centres[0] > centres[1] && centres[1] > centres[2], 'roll moves upward');
  assert.ok(Math.abs((centres[0] - centres[1]) - (centres[1] - centres[2])) < 1.5, 'constant speed');
});

test('Short is 1080×1920, trimmed from the requested start, with audio', async () => {
  const out = path.join(dir, 'short.mp4');
  const result = await api.makeShort(film, out, { start: 0.5, maxSeconds: 0.75, focusX: 1 });
  assert.deepEqual(result, { file: out, seconds: 0.75, width: 1080, height: 1920 });
  await check(out, 1080, 1920, 24, 0.75);
  const end = await api.makeShort(film, path.join(dir, 'short-end.mp4'), { start: 1.75, maxSeconds: 60, focusX: 0 });
  assert.equal(end.seconds, 0.25);
  await check(end.file, 1080, 1920, 24, 0.25);
  const tail = await api.makeShort(film, path.join(dir, 'short-tail.mp4'), { start: 1.99 });
  await check(tail.file, 1080, 1920, 24, 0.01);
});

test('Short focus clamps the portrait crop to the left and right edges', async (t) => {
  if (!has('drawbox')) { t.skip('ffmpeg lacks drawbox for the two-colour focus fixture'); return; }
  const source = path.join(dir, 'focus.mp4');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=24:d=0.25,drawbox=x=160:y=0:w=160:h=180:color=blue:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
  for (const focusX of [0, 1]) {
    const out = path.join(dir, `focus-${focusX}.mp4`);
    await api.makeShort(source, out, { focusX, maxSeconds: 0.125 });
    await check(out, 1080, 1920, 24, 0.125, false);
    const image = await pixels(out, 0, 'rgb24');
    assert.ok(focusX === 0 ? image[0] > image[2] + 100 : image[2] > image[0] + 100);
    const data = await info(out);
    assert.equal(data.streams.some((s) => s.codec_type === 'audio'), false);
  }
});

test('subtitles change cue pixels only, preserve CFR, duration and audio packets', async (t) => {
  const srt = path.join(dir, "captions':,[x].srt");
  await writeFile(srt, await api.srtFromCues([{ from: 0.5, to: 1.25, text: 'The moon rises' }]));
  const out = path.join(dir, 'subbed.mp4');
  if (!has('subtitles')) {
    await assert.rejects(api.burnSubtitles(film, srt, out), /subtitles.*libass|libass.*subtitles/i);
    t.skip('ffmpeg lacks subtitles/libass');
    return;
  }
  await api.burnSubtitles(film, srt, out, { style: 'anime', fontSize: 18 });
  await check(out, 320, 180, 24, 2);
  const frameHash = (file, seconds) => run('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-an', '-f', 'md5', '-']);
  for (const time of [0.25, 1.75]) assert.equal(await frameHash(out, time), await frameHash(film, time));
  assert.notEqual(await frameHash(out, 0.75), await frameHash(film, 0.75));
  const audioHash = (file) => run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a', '-c:a', 'copy', '-f', 'md5', '-']);
  assert.equal(await audioHash(out), await audioHash(film));
});

test('invalid paths, odd dimensions, bad timing, and input aliases fail safely', async () => {
  const out = path.join(dir, 'invalid.mp4');
  await assert.rejects(api.titleCard(out, { title: 'x', width: 161, height: 90 }), /even/i);
  await assert.rejects(api.titleCard(out, { title: 'x', width: 160, height: 90, seconds: 0 }), /seconds/i);
  await assert.rejects(api.makeThumbnail('relative.png', path.join(dir, 'x.png'), { title: 'x' }), /absolute/i);
  await assert.rejects(api.makeShort(path.join(dir, 'missing.mp4'), out), /exist|found/i);
  await assert.rejects(api.makeShort(film, film), /exist|input|overwrite/i);
  const alias = path.join(dir, 'alias.mp4');
  await link(film, alias);
  await assert.rejects(api.makeShort(film, alias), /exist|input|overwrite/i);
  const symbolic = path.join(dir, 'symlink.mp4');
  await symlink(film, symbolic);
  await assert.rejects(api.makeShort(film, symbolic), /exist|input|overwrite/i);
  await assert.rejects(api.makeShort(film, out, { focusX: 2 }), /focusX/i);
  await assert.rejects(api.makeShort(film, out, { start: 4 }), /start/i);
  await assert.rejects(api.makeShort(film, out, { aspect: '1:1' }), /aspect/i);
  await assert.rejects(api.endCredits(out, { sections: [], width: 160, height: 90 }), /sections/i);
});

test('missing drawtext falls back to libass; missing libass gives a clear error', async (t) => {
  if (!has('subtitles')) { t.skip('ffmpeg lacks subtitles/libass for fallback rendering'); return; }
  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  const realFfmpeg = (await run('which', ['ffmpeg'])).trim();
  const wrapper = path.join(bin, 'ffmpeg');
  // A fresh process sees the reduced filter inventory; real rendering still runs ffmpeg.
  await writeFile(wrapper, `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';\nconst args = process.argv.slice(2);\nconst result = spawnSync(${JSON.stringify(realFfmpeg)}, args, { encoding: 'utf8', maxBuffer: 16000000 });\nconst hide = new RegExp('\\\\s(?:drawtext|gblur' + (process.env.HIDE_LIBASS ? '|subtitles' : '') + ')\\\\s');\nfor (const [stream, data] of [[process.stdout, result.stdout], [process.stderr, result.stderr]]) stream.write(args.includes('-filters') ? data.split('\\n').filter(line => !hide.test(line)).join('\\n') : data);\nprocess.exit(result.status ?? 1);\n`);
  await chmod(wrapper, 0o755);
  const moduleUrl = new URL('../src/delivery.js', import.meta.url).href;
  const out = path.join(dir, 'fallback.mp4');
  const thumb = path.join(dir, 'fallback.png');
  const script = `const d = await import(${JSON.stringify(moduleUrl)}); await d.titleCard(${JSON.stringify(out)}, {title:"Moon: 100%", subtitle:"A hero's journey", seconds:0.7, width:160, height:90, backgroundImage:${JSON.stringify(frame)}}); await d.makeThumbnail(${JSON.stringify(frame)}, ${JSON.stringify(thumb)}, {title:'Dawn', width:160, height:90});`;
  await exec(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  await check(out, 160, 90, 30, 0.7);
  assert.ok((await pixels(out, 0.3)).some((byte) => byte > 180), 'fallback card contains visible white text');
  await check(thumb, 160, 90, null, null, false);
  const noAss = `const d = await import(${JSON.stringify(moduleUrl)}); try { await d.burnSubtitles(${JSON.stringify(film)}, ${JSON.stringify(path.join(dir, "captions':,[x].srt"))}, ${JSON.stringify(path.join(dir, 'no-ass.mp4'))}); process.exitCode = 1; } catch (e) { if (!/subtitles.*libass/i.test(e.message)) throw e; }`;
  // This test owns its SRT so it also runs independently with --test-name-pattern.
  await writeFile(path.join(dir, "captions':,[x].srt"), '1\n00:00:00,500 --> 00:00:01,000\nMoon\n');
  await exec(process.execPath, ['--input-type=module', '-e', noAss], { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HIDE_LIBASS: '1' } });
});
