import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { cosine, createFaceChecker, decodeFaces, samePersonThreshold, similarity } from '../src/faces.js';
import { startTestApp, tempRoot } from './helpers.js';

test('face check maths: alignment transform, YuNet decoding with overlap removal, cosine', () => {
  // A known similarity transform (scale 1.5, 30°, shift) is recovered from five points.
  const [s, t] = [1.5, Math.PI / 6];
  const from = [[10, 20], [50, 22], [30, 40], [15, 60], [45, 61]];
  const to = from.map(([x, y]) => [s * Math.cos(t) * x - s * Math.sin(t) * y + 7, s * Math.sin(t) * x + s * Math.cos(t) * y - 3]);
  const [a, b, tx, ty] = similarity(from, to);
  assert.ok(Math.abs(a - s * Math.cos(t)) < 1e-9 && Math.abs(b - s * Math.sin(t)) < 1e-9 && Math.abs(tx - 7) < 1e-9 && Math.abs(ty + 3) < 1e-9);

  // Two strong neighbouring anchors on the same face collapse to one; a weak anchor is ignored.
  const outputs = {};
  for (const stride of [8, 16, 32]) {
    const n = (640 / stride) ** 2;
    Object.assign(outputs, { [`cls_${stride}`]: new Float32Array(n), [`obj_${stride}`]: new Float32Array(n), [`bbox_${stride}`]: new Float32Array(n * 4), [`kps_${stride}`]: new Float32Array(n * 10) });
  }
  const put = (stride, row, col, score, size) => {
    const i = row * (640 / stride) + col;
    outputs[`cls_${stride}`][i] = score;
    outputs[`obj_${stride}`][i] = score;
    outputs[`bbox_${stride}`].set([0.5, 0.5, Math.log(size / stride), Math.log(size / stride)], i * 4);
  };
  put(16, 10, 10, 0.95, 96);
  put(16, 10, 11, 0.9, 96);
  put(32, 2, 15, 0.3, 64);
  // A face is kept only when the geometric mean of class confidence and objectness (as in OpenCV) reaches the threshold.
  put(8, 40, 40, 0.8, 24);
  outputs.obj_8[40 * (640 / 8) + 40] = 0.3;
  const faces = decodeFaces(outputs);
  assert.equal(faces.length, 1);
  assert.deepEqual(faces[0].box.map(Math.round), [120, 120, 96, 96]);
  assert.equal(cosine([1, 2, 3], [2, 4, 6]).toFixed(6), '1.000000');
  assert.ok(samePersonThreshold > 0.3 && samePersonThreshold < 0.4);
});

test('face check install: a download that does not match the pinned checksum is refused; the app-only route', async () => {
  const binDir = tempRoot();
  const checker = createFaceChecker({ binDir, log: { info() {} }, fetchImpl: async () => new Response(Buffer.from('not a model')) });
  await assert.rejects(checker.install(), /does not match its published checksum/);
  assert.equal(checker.status().installed, false);
  assert.equal(existsSync(path.join(binDir, 'faces', 'face_detection_yunet_2023mar.onnx')), false);

  const t = await startTestApp();
  try {
    const status = (await t.call('GET', '/api/faces')).body;
    assert.equal(status.installed, false);
    assert.equal(status.downloadMb, 39);
    assert.equal((await t.call('POST', '/api/faces/install', {}, { headers: { 'x-lumina-client': 'mcp' } })).status, 403);
  } finally {
    await t.close();
  }
});

// With the real models and two photos available locally (LUMINA_FACE_TEST_DIR with faces/<models>, a.jpg, b.jpg of
// one person and c.jpg of another), the same person scores above the threshold and a different person below it.
const fixtures = process.env.LUMINA_FACE_TEST_DIR;
test('face check on real photos', { skip: !fixtures && 'set LUMINA_FACE_TEST_DIR to run' }, async () => {
  const checker = createFaceChecker({ binDir: fixtures, log: { info() {} } });
  const same = await checker.compare(path.join(fixtures, 'a.jpg'), path.join(fixtures, 'b.jpg'));
  const other = await checker.compare(path.join(fixtures, 'a.jpg'), path.join(fixtures, 'c.jpg'));
  assert.ok(same >= samePersonThreshold, `same person ${same}`);
  assert.ok(other < samePersonThreshold, `different person ${other}`);
});

test('face check runs after each clip in a storyboard once installed', { skip: !fixtures && 'set LUMINA_FACE_TEST_DIR to run' }, async () => {
  const { cpSync, readFileSync } = await import('node:fs');
  const dataRoot = tempRoot();
  cpSync(path.join(fixtures, 'faces'), path.join(dataRoot, 'bin', 'faces'), { recursive: true });
  const t = await startTestApp({ dataRoot });
  try {
    assert.equal((await t.call('GET', '/api/faces')).body.installed, true);
    const project = (await t.call('POST', '/api/projects', { name: 'Faces' })).body.project;
    const photo = (await t.call('POST', '/api/assets', { projectId: project.id, dataUrl: `data:image/jpeg;base64,${readFileSync(path.join(fixtures, 'a.jpg')).toString('base64')}` })).body.asset;
    const lena = (await t.call('POST', '/api/characters', { name: 'Lena', description: 'woman in a feathered hat', referenceAssetIds: [photo.id] })).body.character;
    const id = (await t.call('POST', `/api/projects/${project.id}/storyboards`, {
      title: 'F', idea: 'x', settings: { characterIds: [lena.id], imageProvider: 'mock', imageModel: 'mock-image', videoProvider: 'mock', videoModel: 'mock-video' },
    })).body.sequence.id;
    const shot = (await t.call('POST', `/api/storyboards/${id}/shots`, { description: 'Lena looks out of the window.' })).body.shots[0];
    for (const kind of ['frame', 'animate']) {
      const started = await t.call('POST', `/api/shots/${shot.id}/${kind}`, {});
      await t.call('POST', `/api/generations/${started.body.generation.id}/wait`, { timeoutMs: 20_000 });
    }
    let checks;
    for (let i = 0; i < 100 && !checks?.some((c) => c.id === 'faces' || c.id.startsWith('face:')); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      checks = (await t.call('GET', `/api/storyboards/${id}`)).body.shots[0].review.checks;
    }
    // The mock clip is a colour pattern: no faces, reported as not checked rather than as a mismatch.
    assert.ok(checks.some((c) => c.id === 'faces' && c.ok && /No human faces/.test(c.detail)), JSON.stringify(checks));
  } finally {
    await t.close();
  }
});

test('upscaler status and install routes: status without downloading, install is app-only and checks the tool', async () => {
  const t = await startTestApp();
  try {
    const status = (await t.call('GET', '/api/enhancer')).body;
    assert.equal(typeof status.ai, 'boolean');
    assert.equal(status.rife, false);
    assert.deepEqual(status.downloadMb, { ai: 47, rife: 20 });
    assert.equal((await t.call('POST', '/api/enhancer/install', { tool: 'ai' }, { headers: { 'x-lumina-client': 'mcp' } })).status, 403);
    assert.equal((await t.call('POST', '/api/enhancer/install', { tool: 'other' })).status, 400);
  } finally {
    await t.close();
  }
});
