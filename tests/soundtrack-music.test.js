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
