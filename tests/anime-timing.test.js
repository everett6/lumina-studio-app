import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { cleanShotDetails, exposureFilter, skipsSmoothing } from '../src/sequences.js';
import { hasFfmpeg, stitchClips } from '../src/video.js';

const exec = promisify(execFile);

test('shot details: timing and holds are validated and kept across edits', () => {
  const fresh = cleanShotDetails({});
  assert.equal(fresh.timing, 'auto');
  assert.deepEqual(fresh.holds, []);
  assert.equal(cleanShotDetails({ timing: 'twos' }).timing, 'twos');
  assert.equal(cleanShotDetails({ timing: 'fours' }, { timing: 'threes' }).timing, 'threes', 'an unknown value keeps the old one');
  assert.equal(cleanShotDetails({ timing: 7 }).timing, 'auto');
  assert.equal(cleanShotDetails({ interpolate: true }, { timing: 'twos' }).timing, 'twos', 'other edits keep the timing');

  const holds = cleanShotDetails({ holds: [
    { start: 2, seconds: 0.5 }, { start: 0.5, seconds: 1 }, { start: 0.9, seconds: 1 }, // overlaps the one before it: dropped
    { start: -1, seconds: 1 }, { start: 1, seconds: 0 }, { start: 'x', seconds: 1 }, null, { start: 700, seconds: 99 },
  ] }).holds;
  assert.deepEqual(holds, [{ start: 0.5, seconds: 1 }, { start: 2, seconds: 0.5 }, { start: 600, seconds: 10 }]);
  assert.equal(cleanShotDetails({ holds: Array.from({ length: 20 }, (_, i) => ({ start: i * 2, seconds: 1 })) }).holds.length, 8);
  assert.deepEqual(cleanShotDetails({ interpolate: true }, { holds }).holds, holds, 'kept when not mentioned');
  assert.deepEqual(cleanShotDetails({ holds: [] }, { holds }).holds, []);
  assert.deepEqual(cleanShotDetails({ holds: null }, { holds }).holds, []);
  assert.deepEqual(cleanShotDetails({ holds: 'nope' }, { holds }).holds, holds, 'junk keeps the old holds');
});

test('exposure filter strings', () => {
  assert.equal(exposureFilter({ timing: 'auto' }, 24), '');
  assert.equal(exposureFilter({ timing: 'ones' }, 24), '');
  assert.equal(exposureFilter({ timing: 'twos' }, 24), 'fps=12.000000,fps=24');
  assert.equal(exposureFilter({ timing: 'threes' }, 24), 'fps=8.000000,fps=24');
  assert.equal(exposureFilter({ timing: 'twos' }, 30), 'fps=15.000000,fps=30');
  assert.equal(exposureFilter({ holds: [{ start: 0.5, seconds: 0.5 }] }, 24),
    "fps=24,select='not(between(n,13,23))',fps=24");
});

test('smoothing is skipped for twos/threes, holds, and anime shots on auto timing', () => {
  assert.equal(skipsSmoothing({ timing: 'twos' }, 'cinematic'), true);
  assert.equal(skipsSmoothing({ timing: 'threes' }, 'anime'), true);
  assert.equal(skipsSmoothing({ timing: 'auto', holds: [{ start: 0, seconds: 1 }] }, 'cinematic'), true);
  assert.equal(skipsSmoothing({ timing: 'auto', holds: [] }, 'cinematic'), false, 'live action keeps its smoothing');
  assert.equal(skipsSmoothing({ timing: 'auto' }, 'anime'), true, 'anime keeps its rhythm');
  assert.equal(skipsSmoothing({ timing: 'auto', interpolate: true }, 'anime'), false, 'a shot that asks for smoothing gets it');
  assert.equal(skipsSmoothing({ timing: 'ones' }, 'anime'), false, 'explicit ones may be smoothed');
});

const frameHashes = async (file, filter) => {
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', file, ...(filter ? ['-vf', filter] : []), '-f', 'framemd5', '-']);
  return stdout.split('\n').filter((line) => line && !line.startsWith('#')).map((line) => line.split(',').pop().trim());
};

test('ffmpeg: a 24 fps clip on twos/threes repeats each drawing; a hold freezes a span', { skip: !(await hasFfmpeg()) && 'ffmpeg is not installed' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lumina-timing-'));
  try {
    const clip = path.join(dir, 'in.mkv');
    // Every frame different: a moving test pattern, stored losslessly so the hashes are exact.
    await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=24:d=2', '-c:v', 'ffv1', '-y', clip]);
    const source = await frameHashes(clip);
    assert.equal(source.length, 48);
    assert.equal(new Set(source).size, 48);

    const twos = await frameHashes(clip, exposureFilter({ timing: 'twos' }, 24));
    assert.equal(twos.length, 48, 'same length');
    for (let i = 0; i < 48; i += 2) assert.equal(twos[i], twos[i + 1], `frames ${i} and ${i + 1} are one drawing`);
    assert.equal(new Set(twos).size, 24);
    assert.equal(twos[0], source[0]);

    const threes = await frameHashes(clip, exposureFilter({ timing: 'threes' }, 24));
    assert.equal(threes.length, 48);
    for (let i = 0; i < 48; i += 3) assert.ok(threes[i] === threes[i + 1] && threes[i] === threes[i + 2], `frames ${i}-${i + 2} are one drawing`);
    assert.equal(new Set(threes).size, 16);

    // Hold: from 0.5 s for 0.5 s (frames 12-23 show frame 12), everything else untouched, same length.
    const held = await frameHashes(clip, exposureFilter({ holds: [{ start: 0.5, seconds: 0.5 }] }, 24));
    assert.equal(held.length, 48);
    assert.deepEqual(held.slice(0, 13), source.slice(0, 13));
    for (let i = 13; i < 24; i++) assert.equal(held[i], source[12], `frame ${i} is frozen`);
    assert.deepEqual(held.slice(24), source.slice(24));

    // Through the real join: the filter is accepted in the piece's filter chain, and the length is exact.
    writeFileSync(path.join(dir, 'unused'), '');
    const joined = await stitchClips([{ file: clip, duration: 2, vf: exposureFilter({ timing: 'twos', holds: [{ start: 1, seconds: 0.5 }] }, 24) }], { size: { width: 64, height: 64 }, deliver: false, fps: 24 });
    assert.ok(Math.abs(joined.duration - 2) < 0.05, `joined ${joined.duration}s`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
