import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createAssetStore } from '../src/assets.js';
import { startTestApp } from './helpers.js';
import { mixSoundtrack } from '../src/soundtrack.js';
import { run, runCapture } from '../src/video.js';

const serverPath = path.resolve('mcp/server.js');
const parse = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text);
const ff = (args) => run('ffmpeg', ['-v', 'error', ...args], 60000);
const names = ['validate_delivery', 'measure_loudness', 'normalize_loudness', 'waveform_image', 'detect_silence', 'set_mix', 'mix_preview', 'export_stems', 'trim_audio', 'audio_report'];

test('audio tools over MCP with local synthetic media', async (t) => {
  const app = await startTestApp();
  const assetStore = createAssetStore({ assetDir: path.join(app.dataRoot, 'storage/assets'), repo: app.app.repo });
  const sequences = { detail: (id) => ({ sequence: app.app.repo.sequences.get(id), shots: app.app.repo.shots.listBySequence(id) }), update: (id, body) => app.app.repo.sequences.update(id, { ...body, settings: { ...app.app.repo.sequences.get(id).settings, ...body.settings } }) };
  const client = new Client({ name: 'audio-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, LUMINA_DATA_DIR: app.dataRoot, LUMINA_NO_NVENC: '1' }, stderr: 'ignore' }));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, `${name}: ${result.content[0]?.text}`);
    return result;
  };
  try {
    await t.test('registers ten described free tools', async () => {
      const listed = (await client.listTools()).tools;
      for (const name of names) assert.ok(listed.some((tool) => tool.name === name && tool.title && tool.description && tool.inputSchema));
    });
    const project = parse(await call('create_project', { name: 'Audio' }));
    const file = (name) => path.join(app.dataRoot, name);
    await ff(['-f', 'lavfi', '-i', 'sine=f=440:d=4:r=48000', '-ac', '2', '-y', file('tone.wav')]);
    await ff(['-f', 'lavfi', '-i', 'sine=f=230:d=1:r=48000', '-af', 'apad=pad_dur=2', '-ac', '2', '-y', file('quiet.wav')]);
    await ff(['-f', 'lavfi', '-i', 'color=s=160x90:r=24:d=4', '-f', 'lavfi', '-i', 'sine=f=100:d=4:r=48000', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-y', file('clip.mp4')]);
    const save = async (name) => assetStore.save({ bytes: await readFile(file(name)), projectId: project.id, label: name });
    const tone = await save('tone.wav'), quiet = await save('quiet.wav'), clip = await save('clip.mp4');
    const board = parse(await call('create_storyboard', { projectId: project.id, title: 'Mix', idea: 'A test', plan: false, imageProvider: 'mock', imageModel: 'mock-image', videoProvider: 'mock', videoModel: 'mock-video' }));
    await call('import_shot_plan', { storyboardId: board.id, shots: [{ description: 'A speaker', duration: 4, details: { dialogue: [{ speaker: 'narrator', text: 'Hello.' }] } }] });
    const shot = sequences.detail(board.id).shots[0];
    app.app.repo.shots.update(shot.id, { videoAssetId: clip.id });
    const putLines = (lines) => { const current = app.app.repo.shots.get(shot.id); app.app.repo.shots.update(shot.id, { details: { ...current.details, dialogue: lines } }); };
    const line = { speaker: 'narrator', text: 'Hello.', assetId: quiet.id, seconds: 0.1, start: 0.4 };
    putLines([line]);

    await t.test('measures ebur128 and normalizes all targets with two passes, keeping the source', async () => {
      const measured = parse(await call('measure_loudness', { assetId: tone.id }));
      assert.ok(Number.isFinite(measured.integratedLufs) && Number.isFinite(measured.lraLu) && Number.isFinite(measured.truePeakDbtp));
      for (const targetLufs of [-14, -16, -23]) {
        const result = parse(await call('normalize_loudness', { assetId: tone.id, targetLufs }));
        assert.notEqual(result.asset.id, tone.id);
        assert.equal(result.asset.parentAssetId, tone.id);
        const after = parse(await call('measure_loudness', { assetId: result.asset.id }));
        assert.ok(Math.abs(after.integratedLufs - targetLufs) < 1, JSON.stringify(after));
        assert.ok(after.truePeakDbtp <= -0.9);
      }
      assert.ok(await readFile(assetStore.path(tone)));
    });
    await t.test('detects trailing silence and returns an inline waveform', async () => {
      const result = parse(await call('detect_silence', { assetId: quiet.id, minSeconds: 0.5, thresholdDb: -45 }));
      assert.ok(result.intervals.some((s) => s.start > 0.9 && s.end >= 2.99 && s.seconds > 1.9));
      const wave = await call('waveform_image', { assetId: tone.id });
      const image = wave.content.find((c) => c.type === 'image');
      assert.equal(image.mimeType, 'image/png');
      assert.equal(Buffer.from(image.data, 'base64').subarray(1, 4).toString(), 'PNG');
    });
    await t.test('blocks a deleted recording and a missing file', async () => {
      const doomed = await save('tone.wav');
      putLines([{ ...line, assetId: doomed.id }]);
      await unlink(assetStore.path(doomed));
      let result = parse(await call('validate_delivery', { storyboardId: board.id }));
      assert.equal(result.blocked, true);
      assert.ok(result.checks.some((c) => c.check === 'recording' && c.result === 'failed'));
      app.app.repo.assets.remove(doomed.id);
      result = parse(await call('validate_delivery', { storyboardId: board.id }));
      assert.equal(result.blocked, true);
      putLines([line]);
    });
    await t.test('remeasures lengths, blocks clipped dialogue and reports overlaps', async () => {
      putLines([{ ...line, assetId: tone.id }, { ...line, start: 1 }]);
      const result = parse(await call('validate_delivery', { storyboardId: board.id }));
      assert.equal(result.blocked, true);
      assert.ok(result.checks.some((c) => c.check === 'dialogue-fit' && c.result === 'failed'));
      assert.ok(result.checks.some((c) => c.check === 'overlap' && c.result === 'failed'));
      putLines([line]);
    });
    await t.test('checks recorded voice provenance against current assignment using mock speech', async () => {
      sequences.update(board.id, { settings: { narratorVoice: { provider: 'mock', model: 'mock-voice', voice: 'tone-low' } } });
      putLines([{ ...line, assetId: null }]);
      await call('voice_dialogue', { shotId: shot.id });
      await app.app.jobs.idle();
      const recorded = app.app.repo.shots.get(shot.id).details.dialogue;
      assert.ok(recorded[0].assetId);
      let result = parse(await call('validate_delivery', { storyboardId: board.id }));
      assert.ok(result.checks.some((c) => c.check === 'voice' && c.result === 'passed'), JSON.stringify(result));
      sequences.update(board.id, { settings: { narratorVoice: { provider: 'mock', model: 'mock-voice', voice: 'tone-high' } } });
      result = parse(await call('validate_delivery', { storyboardId: board.id }));
      assert.ok(result.checks.some((c) => c.check === 'voice' && c.result === 'failed'));
      putLines([line]);
    });
    await t.test('asset validation checks loudness, peak, channels, silence and frame sync', async () => {
      const result = parse(await call('validate_delivery', { assetId: clip.id }));
      for (const name of ['loudness', 'true-peak', 'channels', 'silence', 'av-duration']) assert.ok(result.checks.some((c) => c.check === name));
      assert.equal(result.checks.find((c) => c.check === 'av-duration').result, 'passed');
      assert.equal(result.checks.find((c) => c.check === 'dialogue').result, 'unavailable');
    });
    await t.test('flags silent channels and absent audio; normalization refuses silence', async () => {
      await ff(['-f', 'lavfi', '-i', 'color=s=160x90:r=24:d=1', '-f', 'lavfi', '-i', 'sine=f=440:d=1:r=48000', '-af', 'pan=stereo|c0=c0|c1=0*c0', '-c:v', 'libx264', '-c:a', 'aac', '-y', file('one-channel.mp4')]);
      const half = await save('one-channel.mp4');
      const checked = parse(await call('validate_delivery', { assetId: half.id }));
      assert.equal(checked.checks.find((c) => c.check === 'channels').result, 'failed');
      await ff(['-f', 'lavfi', '-i', 'color=s=160x90:r=24:d=1', '-c:v', 'libx264', '-y', file('no-audio.mp4')]);
      const silentVideo = await save('no-audio.mp4');
      const absent = parse(await call('validate_delivery', { assetId: silentVideo.id }));
      assert.equal(absent.checks.find((c) => c.check === 'channels').result, 'failed');
      await ff(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '1', '-y', file('silence.wav')]);
      const silence = await save('silence.wav');
      const bad = await client.callTool({ name: 'normalize_loudness', arguments: { assetId: silence.id, targetLufs: -16 } });
      assert.equal(bad.isError, true);
    });
    await t.test('stores gains, applies clipVolume to next join, previews inline without a picture join', async () => {
      const result = parse(await call('set_mix', { storyboardId: board.id, mix: { dialogueGainDb: -3, musicDuckDb: 6, sfxGainDb: -4, clipVolume: 0.2 } }));
      assert.deepEqual(result.appliedByJoin, ['clipVolume']);
      assert.equal(app.app.repo.settings.get(`mix:${board.id}`).dialogueGainDb, -3);
      assert.equal(sequences.detail(board.id).sequence.settings.clipVolume, 0.2);
      const preview = await call('mix_preview', { storyboardId: board.id, from: 0.5, seconds: 2 });
      assert.equal(preview.content.find((c) => c.type === 'audio').mimeType, 'audio/mpeg');
      assert.equal(sequences.detail(board.id).sequence.outputAssetId, null);
    });
    await t.test('exports aligned stems whose sum roughly matches the preview mix', async () => {
      await call('set_mix', { storyboardId: board.id, mix: { dialogueGainDb: -6, musicDuckDb: 6, sfxGainDb: -4, clipVolume: 0.2 } });
      sequences.update(board.id, { settings: { music: { assetId: tone.id, volume: 0.1 }, ambience: { assetId: tone.id, volume: 0.02 } } });
      const current = app.app.repo.shots.get(shot.id);
      app.app.repo.shots.update(shot.id, { details: { ...current.details, sfx: [{ assetId: quiet.id, at: 0.8, volume: 0.05 }] } });
      const stems = parse(await call('export_stems', { storyboardId: board.id }));
      assert.equal(stems.stems.length, 4);
      for (const stem of stems.stems) { assert.match(stem.file, /exports/); assert.ok((await readFile(stem.file)).length > 44); }
      await ff([...stems.stems.flatMap((s) => ['-i', s.file]), '-filter_complex', 'amix=inputs=4:normalize=0', '-c:a', 'pcm_f32le', '-y', file('sum.wav')]);
      const preview = parse(await call('mix_preview', { storyboardId: board.id, from: 0, seconds: 4 }));
      const a = parse(await call('measure_loudness', { assetId: preview.asset.id }));
      const { stderr } = await runCapture('ffmpeg', ['-hide_banner', '-i', file('sum.wav'), '-af', 'ebur128=peak=true', '-f', 'null', '-'], 60000);
      const b = Number([...stderr.matchAll(/I:\s*(-?[\d.]+) LUFS/g)].at(-1)[1]);
      assert.ok(Math.abs(a.integratedLufs - b) < 0.5, `${a.integratedLufs} vs ${b}`);
    });
    await t.test('saved dialogue/effects gain and zero duck change their stems', async () => {
      const before = parse(await call('export_stems', { storyboardId: board.id }));
      await call('set_mix', { storyboardId: board.id, mix: { dialogueGainDb: -12, musicDuckDb: 0, sfxGainDb: -10 } });
      const after = parse(await call('export_stems', { storyboardId: board.id }));
      const levels = async (result, bus) => {
        const { stderr } = await runCapture('ffmpeg', ['-hide_banner', '-i', result.stems.find((s) => s.bus === bus).file, '-af', 'volumedetect', '-f', 'null', '-'], 60000);
        return Number(/mean_volume: (-?[\d.]+)/.exec(stderr)[1]);
      };
      for (const bus of ['dialogue', 'effects']) assert.ok(Math.abs((await levels(before, bus) - await levels(after, bus)) - 6) < 0.2);
      assert.ok(await levels(after, 'music') > await levels(before, 'music'), 'disabling ducking increases the music stem');
    });
    await t.test('trims to a new WAV with audible middle and faded edges', async () => {
      const result = parse(await call('trim_audio', { assetId: tone.id, start: 1, end: 3, fadeIn: 0.5, fadeOut: 0.5 }));
      assert.notEqual(result.asset.id, tone.id);
      const wav = assetStore.path(result.asset);
      const { stdout } = await runCapture('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav], 60000);
      assert.ok(Math.abs(Number(stdout) - 2) < 0.01);
      const volume = async (at) => { const { stderr } = await runCapture('ffmpeg', ['-hide_banner', '-ss', String(at), '-i', wav, '-t', '0.05', '-af', 'atrim=0:0.05,volumedetect', '-f', 'null', '-'], 60000); return Number(/mean_volume: (-?[\d.]+)/.exec(stderr)[1]); };
      assert.ok(await volume(0) < await volume(1) - 15);
      assert.ok(await volume(1.95) < await volume(1) - 15);
      const bad = await client.callTool({ name: 'trim_audio', arguments: { assetId: tone.id, start: 3, end: 2 } });
      assert.equal(bad.isError, true);
    });
    await t.test('reports slots, measured lengths, effects, active cue and last joined loudness', async () => {
      app.app.repo.sequences.update(board.id, { outputAssetId: clip.id });
      const report = parse(await call('audio_report', { storyboardId: board.id }));
      assert.equal(report.shots[0].lines[0].seconds, 3);
      assert.equal(report.shots[0].lines[0].start, 0.4);
      assert.equal(report.shots[0].effects.length, 1);
      assert.equal(report.shots[0].music.assetId, tone.id);
      assert.ok(Number.isFinite(report.lastJoinedFilm.loudness.integratedLufs));
      assert.equal(report.lastJoinedFilm.stale, true);
      const gate = parse(await call('validate_delivery', { storyboardId: board.id }));
      assert.equal(gate.checks.find((c) => c.check === 'join-current').result, 'failed');
    });
  } finally { await client.close(); await app.close(); }
});

test('default soundtrack remains within 0.1 LU of the original mixer', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lumina-audio-default-'));
  const f = (s) => path.join(dir, s);
  try {
    await ff(['-f', 'lavfi', '-i', 'color=s=160x90:r=24:d=4', '-c:v', 'libx264', '-y', f('video.mp4')]);
    await ff(['-f', 'lavfi', '-i', 'sine=f=440:d=1:r=48000', '-y', f('line.wav')]);
    await ff(['-f', 'lavfi', '-i', 'sine=f=220:d=2:r=48000', '-y', f('music.wav')]);
    await mixSoundtrack(f('video.mp4'), f('mix.mp4'), { lines: [{ file: f('line.wav'), at: 0.4 }], music: { file: f('music.wav'), volume: 0.3 } });
    // Reference captured with the pre-extension mixer on these exact lavfi sources.
    const { stderr } = await runCapture('ffmpeg', ['-hide_banner', '-i', f('mix.mp4'), '-af', 'ebur128=peak=true', '-f', 'null', '-'], 60000);
    const lufs = Number([...stderr.matchAll(/I:\s*(-?[\d.]+) LUFS/g)].at(-1)[1]);
    assert.ok(Math.abs(lufs - (-16.4)) <= 0.1, `legacy reference vs ${lufs}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
