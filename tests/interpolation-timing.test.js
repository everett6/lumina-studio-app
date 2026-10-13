import assert from 'node:assert/strict';
import test from 'node:test';
import { interpolationTimeline } from '../src/enhance.js';

test('RIFE timing preserves source timestamps rather than stretching motion to the audio end', () => {
  const t = interpolationTimeline(17, 24, 30);
  assert.equal(t.generatedFrames, 21); assert.equal(t.deliveryFrames, 22);
  assert.deepEqual(t.anchors.at(-1), { source: 17, target: 21 });
  for (const anchor of t.anchors) assert.ok(Math.abs((anchor.source - 1) / 24 - (anchor.target - 1) / 30) <= 0.5 / 30 + 1e-9);
  const twice = interpolationTimeline(12, 12, 24);
  assert.equal(twice.deliveryFrames, 24);
  assert.ok(twice.anchors.every((a) => a.target === (a.source - 1) * 2 + 1));
});

test('invalid interpolation timelines fail before using the GPU', () => {
  for (const args of [[1,24,30],[17,0,30],[17,24,24],[17,NaN,30],[17,24,Infinity]]) {
    assert.throws(() => interpolationTimeline(...args));
  }
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createEnhancer } from '../src/enhance.js';
const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

test('hard cuts refuse interpolation before downloading or invoking a GPU model', { skip: !ffmpeg }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lumina-cut-regression-'));
  try {
    const file = path.join(dir, 'cut.mp4');
    const result = spawnSync('ffmpeg', ['-v','error','-f','lavfi','-i','color=black:s=160x90:r=12:d=0.5',
      '-f','lavfi','-i','color=white:s=160x90:r=12:d=0.5','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map','[v]','-c:v','libx264','-pix_fmt','yuv420p','-y',file]);
    assert.equal(result.status, 0, result.stderr?.toString());
    const e = createEnhancer({ binDir: path.join(dir,'empty-bin'), workDir: dir });
    await assert.rejects(e.interpolate(file, { fps: 24 }), /contains a cut/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
