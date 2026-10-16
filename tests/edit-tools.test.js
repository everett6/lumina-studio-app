import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startTestApp } from './helpers.js';
import { probe } from '../src/video.js';
import { createSequenceService } from '../src/sequences.js';
import { createAssetStore } from '../src/assets.js';

process.env.LUMINA_NO_NVENC = '1';
const serverPath = fileURLToPath(new URL('../mcp/server.js', import.meta.url));
const parse = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text);
async function fixture(t) {
  const app = await startTestApp();
  const client = new Client({ name: 'edit-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, LUMINA_DATA_DIR: app.dataRoot }, stderr: 'ignore' }));
  t.after(async () => { await client.close(); await app.close(); });
  const raw = (name, args) => client.callTool({ name, arguments: args });
  const call = async (name, args) => { const r = await raw(name, args); assert.ok(!r.isError, `${name}: ${r.content?.[0]?.text}`); return parse(r); };
  const project = await call('create_project', { name: 'Editing' });
  const board = await call('create_storyboard', { projectId: project.id, title: 'Edit', idea: 'Cuts', plan: false, imageProvider: 'mock', imageModel: 'mock-image' });
  await call('import_shot_plan', { storyboardId: board.id, shots: ['A', 'B', 'A'].map((scene, i) => ({ description: `Shot ${i + 1}`, duration: 2, details: { scene, method: 'still', motion: 'hold' } })) });
  app.app.assetStore = createAssetStore({ assetDir: path.join(app.dataRoot, 'storage', 'assets'), repo: app.app.repo });
  const service = createSequenceService({ repo: app.app.repo, assetStore: app.app.assetStore });
  const detail = () => service.detail(board.id);
  const file = (id) => app.app.assetStore.path(app.app.repo.assets.get(id));
  // A tiny CPU fixture stands in for generated media. No provider, GPU or network work.
  const clipPath = path.join(app.dataRoot, 'fixture.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=24:d=3', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', clipPath]);
  const { readFile } = await import('node:fs/promises');
  const clip = await app.app.assetStore.save({ projectId: project.id, kind: 'video', label: 'Fixture', bytes: await readFile(clipPath) });
  const pngPath = path.join(app.dataRoot, 'frame.png');
  execFileSync('ffmpeg', ['-v', 'error', '-i', clipPath, '-frames:v', '1', '-threads', '1', pngPath]);
  const frame = await app.app.assetStore.save({ projectId: project.id, kind: 'image', label: 'Frame', bytes: await readFile(pngPath) });
  for (const s of detail().shots) app.app.repo.shots.update(s.id, { imageAssetId: frame.id, videoAssetId: clip.id });
  service.update(board.id, { settings: { colorMatch: 'off', outputHeight: 720, finish: 'none' } });
  const stale = () => assert.equal(detail().sequence.joinStale, true);
  const join = async () => { const joined = await call('join_storyboard', { storyboardId: board.id }); assert.equal(joined.state, 'completed'); assert.equal(detail().sequence.joinStale, false); return file(joined.filmAssetId); };
  return { app, call, raw, board, detail, file, stale, join, clip, frame, project };
}

test('MCP editing: insert, duplicate, split, delete, scene order, approvals and stale film', async (t) => {
  const f = await fixture(t), { call, board, detail, raw } = f;
  assert.equal((await call('shot_timeline', { storyboardId: board.id })).shots.length, 3);
  await f.join();
  const original = detail().shots[0];
  const inserted = await call('insert_shot', { storyboardId: board.id, afterShotId: null, shot: { description: 'First', duration: 1, details: { scene: 'C', method: 'still' } } });
  f.stale(); assert.equal(inserted.shots[0].description, 'First');
  await f.join();
  await call('duplicate_shot', { shotId: original.id }); f.stale();
  let shots = detail().shots;
  assert.equal(shots[2].description, original.description); assert.equal(shots[2].videoAssetId, null);
  await f.join();
  const copied = await call('duplicate_shot', { shotId: original.id, withMedia: true }); f.stale();
  assert.equal(copied.shots[2].videoAssetId, original.videoAssetId);
  f.app.app.repo.shots.update(original.id, { review: { status: 'accepted', frameApproved: original.imageAssetId }, details: { ...original.details, dialogue: [{ text: 'One', speaker: 'narrator', start: 0.2 }, { text: 'Two', speaker: 'narrator', start: 1.2 }] } });
  await f.join();
  await call('split_shot', { shotId: original.id, atSeconds: 1 }); f.stale();
  shots = detail().shots;
  const i = shots.findIndex((s) => s.id === original.id);
  assert.equal(shots[i].duration, 1); assert.equal(shots[i + 1].duration, 1);
  assert.equal(shots[i].details.dialogue[0].text, 'One'); assert.ok(Math.abs(shots[i + 1].details.dialogue[0].start - 0.2) < 1e-9);
  assert.equal(shots[i].review.status, 'pending');
  assert.equal((await raw('delete_shot', { shotId: shots[0].id })).isError, true);
  await f.join();
  await call('delete_shot', { shotId: shots[0].id, confirm: true }); f.stale();
  assert.ok(f.app.app.repo.assets.get(f.clip.id), 'takes remain in library');
  await f.join();
  await call('reorder_scene', { storyboardId: board.id, scene: 'B', beforeScene: 'A' }); f.stale();
  assert.equal(detail().shots[0].details.scene, 'B');
  assert.deepEqual(detail().shots.map((s) => s.position), detail().shots.map((_, i) => i + 1));
  assert.equal((await raw('insert_shot', { storyboardId: board.id, afterShotId: 'missing', shot: { description: 'Bad', duration: 1 } })).isError, true);
  const appended = await call('insert_shot', { storyboardId: board.id, shot: { description: 'Last', duration: 1 } });
  assert.equal(appended.shots.at(-1).description, 'Last', 'leaving out afterShotId appends at the end');
});

test('MCP join: per-cut crossfade, speed, overlay pixels and animatic timing', async (t) => {
  const f = await fixture(t), { call, board, detail } = f;
  const [a, b, c] = detail().shots;
  for (const shot of [a, b]) f.app.app.repo.shots.update(shot.id, { review: { status: 'accepted', frameApproved: shot.imageAssetId } });
  await call('delete_shot', { shotId: c.id, confirm: true });
  const baseline = await f.join();
  await call('set_cut_transition', { shotId: a.id, transition: 'crossfade', seconds: 0.25 }); f.stale();
  assert.equal(detail().shots[0].review.frameApproved, a.imageAssetId);
  assert.equal(detail().shots[0].review.status, 'pending');
  await f.join();
  await call('set_shot_speed', { shotId: b.id, speed: 2, keepPitch: true }); f.stale();
  assert.equal(detail().shots[1].review.status, 'pending');
  assert.equal(detail().shots[1].review.frameApproved, null);
  const joined = await f.join();
  assert.ok(Math.abs((await probe(joined)).duration - 3) < 1 / 24);
  await call('add_text_overlay', { shotId: a.id, text: "A: 'quote' %{} , [safe] \\ test", position: 'center', start: 0.5, seconds: 0.5, style: 'title' }); f.stale();
  assert.equal(detail().shots[0].review.frameApproved, null);
  const overlay = await f.join();
  const pixels = (file, at) => execFileSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', file, '-vf', 'scale=160:90', '-frames:v', '1', '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const diff = (x, y) => x.reduce((sum, v, i) => sum + Math.abs(v - y[i]), 0) / x.length;
  assert.ok(diff(pixels(joined, 0.25), pixels(overlay, 0.25)) < 1, 'before overlay');
  assert.ok(diff(pixels(joined, 0.75), pixels(overlay, 0.75)) > 2, 'visible during overlay');
  assert.ok(diff(pixels(joined, 1.25), pixels(overlay, 1.25)) < 1, 'after overlay');
  const timeline = await call('shot_timeline', { storyboardId: board.id });
  assert.equal(timeline.totalSeconds, 3); assert.equal(timeline.totalFrames, 72);
  assert.equal(timeline.shots[1].speed, 2); assert.equal(timeline.shots[0].overlays.length, 1);
  f.app.app.repo.shots.update(b.id, { imageAssetId: null, details: { ...detail().shots[1].details, dialogue: [{ text: 'Too long', start: 0.2, seconds: 2, assetId: null }] } });
  const animatic = await call('make_animatic', { storyboardId: board.id, fps: 12, includeDialogue: true });
  assert.ok(Math.abs((await probe(f.file(animatic.asset.id))).duration - timeline.totalSeconds) <= 1 / 12);
  assert.deepEqual(animatic.shotsWithoutFrames, [b.id]); assert.ok(animatic.dialogueOverruns.length);
  assert.equal((await probe(f.file(animatic.asset.id))).width, 640);
  assert.ok(baseline);
});

const pcm = (file, start = 0.05, seconds = 0.3) => execFileSync('ffmpeg', ['-v', 'error', '-ss', String(start), '-i', file, '-t', String(seconds), '-vn', '-f', 'f32le', '-ac', '1', '-ar', '48000', '-']);
const samples = (bytes) => Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readFloatLE(i * 4));
const rms = (bytes) => Math.sqrt(samples(bytes).reduce((sum, x) => sum + x * x, 0) / (bytes.length / 4));
const hz = (bytes) => { const data = samples(bytes); return data.reduce((n, x, i) => n + (i && x >= 0 && data[i - 1] < 0 ? 1 : 0), 0) * 48000 / data.length; };

async function tone(f, video = false) {
  const file = path.join(f.app.dataRoot, video ? 'tone.mp4' : 'tone.wav');
  execFileSync('ffmpeg', ['-v', 'error', ...(video ? ['-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=24:d=3'] : []), '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3:sample_rate=48000', ...(video ? ['-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac'] : []), file]);
  const { readFile } = await import('node:fs/promises');
  return f.app.app.assetStore.save({ projectId: f.project.id, kind: video ? 'video' : 'audio', bytes: await readFile(file), label: 'Recorded tone' });
}

test('MCP clip split respects source trim and speed; invalid edits leave the plan untouched', async (t) => {
  const f = await fixture(t), { call, raw, detail, board } = f;
  const a = detail().shots[0];
  f.app.app.repo.shots.update(a.id, { details: { ...a.details, method: 'video', trimStart: 0.25, speed: 2 } });
  await f.join();
  await call('split_shot', { shotId: a.id, atSeconds: 0.5 }); f.stale();
  const [left, right] = detail().shots;
  assert.equal(left.duration, 1); assert.equal(right.duration, 1);
  assert.equal(right.details.trimStart, 1.25); assert.equal(right.videoAssetId, a.videoAssetId);
  assert.equal((await call('shot_timeline', { storyboardId: board.id })).totalSeconds, 5);
  const snapshot = detail().shots;
  for (const [name, args] of [
    ['split_shot', { shotId: left.id, atSeconds: 100 }],
    ['set_shot_speed', { shotId: left.id, speed: 0 }],
    ['add_text_overlay', { shotId: left.id, text: 'Late', position: 'bottom', start: 1, seconds: 1, style: 'caption' }],
  ]) assert.equal((await raw(name, args)).isError, true);
  assert.deepEqual(detail().shots, snapshot);
  const refused = await f.app.call('POST', `/api/shots/${left.id}/edit/delete`, {});
  assert.equal(refused.status, 400);
  f.app.app.repo.shots.update(left.id, { details: { ...left.details, locked: true } });
  assert.equal((await raw('split_shot', { shotId: left.id, atSeconds: 0.25 })).isError, true);
  assert.equal((await raw('delete_shot', { shotId: left.id, confirm: true })).isError, true);
});

test('MCP speed uses atempo across its full range and optionally changes clip pitch', async (t) => {
  const f = await fixture(t), { call, detail, board } = f;
  const [a, b, c] = detail().shots;
  await call('delete_shot', { shotId: b.id, confirm: true }); await call('delete_shot', { shotId: c.id, confirm: true });
  const asset = await tone(f, true);
  f.app.app.repo.shots.update(a.id, { videoAssetId: asset.id, details: { ...a.details, method: 'video' } });
  for (const [speed, keepPitch, pitch] of [[0.25, true, 440], [4, true, 440], [4, false, 1760]]) {
    await call('set_shot_speed', { shotId: a.id, speed, keepPitch });
    const film = await f.join();
    assert.ok(Math.abs((await probe(film)).duration - 2 / speed) < 1 / 24);
    assert.ok(Math.abs(hz(pcm(film)) - pitch) < 20, `speed ${speed}, keepPitch ${keepPitch}`);
    assert.equal((await call('shot_timeline', { storyboardId: board.id })).totalSeconds, 2 / speed);
  }
});

test('MCP animatic mixes recorded dialogue, reports measured overruns and can omit speech', async (t) => {
  const f = await fixture(t), { call, detail, board } = f;
  const [a, b, c] = detail().shots;
  await call('delete_shot', { shotId: b.id, confirm: true }); await call('delete_shot', { shotId: c.id, confirm: true });
  const asset = await tone(f);
  f.app.app.repo.shots.update(a.id, { imageAssetId: null, details: { ...a.details, dialogue: [{ speaker: 'narrator', text: 'Recorded line', start: 0.25, seconds: 0.1, assetId: asset.id }] } });
  const voiced = await call('make_animatic', { storyboardId: board.id, fps: 24 });
  assert.equal(voiced.totalSeconds, 2); assert.ok(voiced.dialogueOverruns[0].seconds > 1, 'file length overrides stale cached length');
  assert.ok(rms(pcm(f.file(voiced.asset.id), 0.5)) > 0.001);
  const silent = await call('make_animatic', { storyboardId: board.id, fps: 12, includeDialogue: false });
  assert.ok(rms(pcm(f.file(silent.asset.id), 0.5)) < 0.0001);
  assert.equal((await probe(f.file(silent.asset.id))).height, 360);
});

test('MCP 12 fps animatic rounds cumulative boundaries without timeline drift; fades preserve runtime', async (t) => {
  const f = await fixture(t), { call, detail, board } = f;
  for (const shot of detail().shots) f.app.app.repo.shots.update(shot.id, { duration: 13 / 24 });
  const [a, b] = detail().shots;
  await call('set_cut_transition', { shotId: a.id, transition: 'fade-black', seconds: 0.25 });
  await call('set_cut_transition', { shotId: b.id, transition: 'fade-white', seconds: 0.25 });
  const timeline = await call('shot_timeline', { storyboardId: board.id });
  const animatic = await call('make_animatic', { storyboardId: board.id, fps: 12 });
  assert.equal(timeline.totalFrames, 39);
  assert.ok(Math.abs((await probe(f.file(animatic.asset.id))).duration - timeline.totalSeconds) <= 1 / 12);
  const film = await f.join();
  assert.ok(Math.abs((await probe(film)).duration - timeline.totalSeconds) <= 1 / 24);
});

test('MCP plan-only duplication omits sound media; withMedia references existing recordings', async (t) => {
  const f = await fixture(t), { call, detail } = f;
  const shot = detail().shots[0], recording = await tone(f);
  const details = { ...shot.details, sfx: [{ assetId: recording.id, at: 0, volume: 0.2, label: 'Tone' }], dialogue: [{ speaker: 'narrator', text: 'Tone', start: 0, seconds: 3, assetId: recording.id }] };
  f.app.app.repo.shots.update(shot.id, { details });
  await call('duplicate_shot', { shotId: shot.id });
  const plan = detail().shots[1];
  assert.equal(plan.imageAssetId, null); assert.equal(plan.videoAssetId, null);
  assert.equal(plan.details.dialogue[0].assetId, null); assert.deepEqual(plan.details.sfx, []);
  await call('duplicate_shot', { shotId: shot.id, withMedia: true });
  const media = detail().shots[1];
  assert.equal(media.imageAssetId, shot.imageAssetId); assert.equal(media.videoAssetId, shot.videoAssetId);
  assert.equal(media.details.dialogue[0].assetId, recording.id); assert.equal(media.details.sfx[0].assetId, recording.id);
});
