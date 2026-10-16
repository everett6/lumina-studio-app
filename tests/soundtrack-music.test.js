import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mixSoundtrack } from '../src/soundtrack.js';
import { run } from '../src/video.js';

const level = (file, at) => {
  const { stderr } = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(at), '-t', '0.5', '-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { encoding: 'utf8' });
  return Number(/mean_volume: (-?[\d.]+)/.exec(stderr)?.[1] ?? -99);
};

test('the music bed keeps playing after the last dialogue line (it is only ducked under speech)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lumina-mix-'));
  try {
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:d=6:r=30', '-c:v', 'libx264', '-y', path.join(dir, 'pic.mp4')]);
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-y', path.join(dir, 'line.wav')]);
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=220:d=2', '-y', path.join(dir, 'music.wav')]);
    const out = path.join(dir, 'out.mp4');
    await mixSoundtrack(path.join(dir, 'pic.mp4'), out, { lines: [{ file: path.join(dir, 'line.wav'), at: 0.5 }], music: { file: path.join(dir, 'music.wav'), volume: 0.3 } });
    assert.ok(level(out, 4.5) > -50, 'music is still audible well after the line ended (and after the music file looped)');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Dominant frequency check: which of two test tones is louder in a window.
const toneLevel = (file, at, freq) => {
  const { stderr } = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(at), '-t', '0.6', '-i', file, '-af', `bandpass=f=${freq}:width_type=q:w=8,volumedetect`, '-vn', '-f', 'null', '-'], { encoding: 'utf8' });
  return Number(/mean_volume: (-?[\d.]+)/.exec(stderr)?.[1] ?? -99);
};

test('music per scene switches tracks at the cue and sound effects land at their time', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lumina-cues-'));
  try {
    const f = (name) => path.join(dir, name);
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:d=8:r=30', '-c:v', 'libx264', '-y', f('pic.mp4')]);
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=300:d=2', '-y', f('calm.wav')]);
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=1200:d=2', '-y', f('tense.wav')]);
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=3000:d=0.4', '-y', f('clash.wav')]);
    const out = f('out.mp4');
    await mixSoundtrack(f('pic.mp4'), out, {
      music: [{ file: f('calm.wav'), volume: 0.4, start: 0, end: 4 }, { file: f('tense.wav'), volume: 0.4, start: 4, end: 8 }],
      effects: [{ file: f('clash.wav'), at: 6, volume: 1 }],
    });
    assert.ok(toneLevel(out, 1, 300) > toneLevel(out, 1, 1200) + 15, 'scene 1 plays the calm track');
    assert.ok(toneLevel(out, 6.8, 1200) > toneLevel(out, 6.8, 300) + 15, 'scene 2 plays the tense track');
    assert.ok(toneLevel(out, 6, 3000) > toneLevel(out, 2, 3000) + 20, 'the sound effect plays at 6 s and not before');
    const { stdout } = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' });
    assert.ok(Math.abs(Number(stdout) - 8) < 0.05, 'the film keeps its length');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
