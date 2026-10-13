import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { colourStats, curveFilter, matchCurve } from '../src/grade.js';
import { filmFps, probe, stitchClips } from '../src/video.js';

const has = (command) => spawnSync(command, ['-version'], { stdio: 'ignore' }).status === 0;
const media = has('ffmpeg') && has('ffprobe');
const gap = (a, b) => Math.max(...a.mean.map((m, c) => Math.abs(m - b.mean[c])));

test('colour matching: a shot with a colour cast is pulled onto its scene\'s reference', { skip: !media && 'needs ffmpeg' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lumina-grade-'));
  try {
    const clip = (name, extra) => {
      const file = path.join(dir, name);
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=1', '-vf', `format=yuv420p${extra}`, '-c:v', 'libx264', '-crf', '12', '-y', file]);
      return file;
    };
    const reference = clip('ref.mp4', '');
    const warm = clip('warm.mp4', ',colorbalance=rs=0.3:bs=-0.3:rm=0.3:bm=-0.3:rh=0.2:bh=-0.2,eq=brightness=0.06');
    const [refStats, warmStats] = [await colourStats(reference), await colourStats(warm)];
    assert.ok(gap(refStats, warmStats) > 15, `the cast is visible before matching (${gap(refStats, warmStats).toFixed(1)})`);
    assert.equal(matchCurve(refStats, refStats), null, 'a matching shot is left alone');

    const curve = matchCurve(warmStats, refStats, { strength: 1 });
    const fixed = path.join(dir, 'fixed.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-i', warm, '-vf', `${curveFilter(curve)},format=yuv420p`, '-c:v', 'libx264', '-crf', '12', '-y', fixed]);
    const after = gap(refStats, await colourStats(fixed));
    assert.ok(after < gap(refStats, warmStats) / 3, `the cast is mostly gone (${gap(refStats, warmStats).toFixed(1)} → ${after.toFixed(1)})`);

    // The same curve works as a per-clip filter inside a join, and muting a clip's own sound gives silence.
    const tone = path.join(dir, 'tone.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-i', warm, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-y', tone]);
    const joined = await stitchClips([{ file: reference, duration: 1 }, { file: tone, duration: 1, vf: curveFilter(curve), mute: true }], { deliver: false });
    const film = path.join(dir, 'film.mp4');
    (await import('node:fs')).writeFileSync(film, joined.bytes);
    assert.ok(Math.abs((await probe(film)).duration - 2) < 0.1);
    const level = spawnSync('ffmpeg', ['-v', 'info', '-ss', '1.1', '-t', '0.8', '-i', film, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    assert.match(level, /max_volume: -(9\d|\d{3})\.\d dB|max_volume: -inf dB/, 'the muted shot is silent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('film frame rate: the clips\' own rate, snapped to a standard one, so frames are not duplicated', () => {
  assert.equal(filmFps([24, 24, 23.976, 30]), 24);
  assert.equal(filmFps([30, 29.97, 24]), 30);
  assert.equal(filmFps([12]), 24, 'odd test rates snap to the nearest standard rate');
  assert.equal(filmFps([]), 24);
});

test('hard cuts: whole frames, no gap or click in the sound at the cut, sound and picture end together', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lumina-cut-'));
  const clip = (name, tone) => {
    const file = path.join(dir, name);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=1', '-f', 'lavfi', '-i', `sine=frequency=${tone}:sample_rate=48000:duration=1`,
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', file]);
    return file;
  };
  const joined = await stitchClips([{ file: clip('a.mp4', 440), duration: 1 }, { file: clip('b.mp4', 660), duration: 1 }], { deliver: false });
  const film = path.join(dir, 'film.mp4');
  (await import('node:fs')).writeFileSync(film, joined.bytes);
  const frames = Number(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', film]).toString().trim());
  assert.equal(frames, 48);
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', film, '-f', 'f32le', '-ac', '1', '-ar', '48000', '-'], { maxBuffer: 64 * 1024 * 1024 });
  const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
  assert.ok(Math.abs(samples.length / 48000 - 2) < 0.03, `sound lasts ${samples.length / 48000} s`);
  // Longest near-silent stretch between 0.5 s and 1.5 s: only the cut's micro-fade (a sine is never quiet for long).
  let longest = 0;
  let run = 0;
  for (let i = 24000; i < 72000; i += 1) {
    run = Math.abs(samples[i]) < 0.02 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  assert.ok(longest < 0.012 * 48000, `silent for ${(longest / 48).toFixed(1)} ms at the cut`);
  rmSync(dir, { recursive: true, force: true });
});
