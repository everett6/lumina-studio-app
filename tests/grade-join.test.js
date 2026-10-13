import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startTestApp } from './helpers.js';

const bytesOf = async (t, assetPath) => Buffer.from(await (await fetch(`${t.app.origin}${assetPath}`, { headers: { authorization: `Bearer ${t.app.token}` } })).arrayBuffer());

// Mean luma (0-255) of one frame from the middle of the file, read as raw 8-bit gray.
function middleLuma(file) {
  const seconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(seconds / 2), '-i', file, '-frames:v', '1', '-vf', 'scale=64:36', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 });
  assert.ok(raw.length > 0, 'a frame was extracted');
  return raw.reduce((sum, v) => sum + v, 0) / raw.length;
}

test('a shot grade really darkens the joined film, and clearing it restores the picture', async () => {
  process.env.LUMINA_NO_NVENC ??= '1';
  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Grade' })).body.project;
    const created = await t.call('POST', `/api/projects/${project.id}/storyboards`, { title: 'Grade', idea: 'A fox crosses a lake.', writer: 'mock:mock-director',
      settings: { shotCount: 1, imageProvider: 'mock', imageModel: 'mock-image', videoProvider: 'mock', videoModel: 'mock-video', colorMatch: 'off' } });
    const id = created.body.sequence.id;
    const planned = (await t.call('POST', `/api/storyboards/${id}/plan`, {})).body;
    const shot = planned.shots[0];
    const finish = async (response) => {
      assert.equal(response.status, 202, JSON.stringify(response.body));
      const g = (await t.call('POST', `/api/generations/${response.body.generation.id}/wait`, { timeoutMs: 20_000 })).body.generation;
      assert.equal(g.status, 'completed', JSON.stringify(g));
    };
    await finish(await t.call('POST', `/api/shots/${shot.id}/frame`, {}));
    await t.call('POST', `/api/shots/${shot.id}/approve-frame`, { approved: true });
    await finish(await t.call('POST', `/api/shots/${shot.id}/animate`, {}));

    const joinLuma = async (name) => {
      const film = await t.call('POST', `/api/storyboards/${id}/stitch`, { wait: true });
      assert.equal(film.status, 200, JSON.stringify(film.body));
      const file = path.join(t.dataRoot, `${name}.mp4`);
      writeFileSync(file, await bytesOf(t, film.body.sequence.outputPath));
      return middleLuma(file);
    };

    const plain = await joinLuma('plain');
    assert.ok(plain > 40, `mock picture is bright enough to measure a darkening (${plain})`);

    const dark = await t.call('PATCH', `/api/shots/${shot.id}`, { details: { grade: { brightness: -0.25 } } });
    assert.equal(dark.status, 200, JSON.stringify(dark.body));
    assert.deepEqual(dark.body.shots.find((s) => s.id === shot.id).details.grade, { brightness: -0.25 });
    const graded = await joinLuma('graded');
    assert.ok(graded < plain - 20, `graded film is clearly darker: ${graded.toFixed(1)} vs ${plain.toFixed(1)}`);

    const cleared = await t.call('PATCH', `/api/shots/${shot.id}`, { details: { grade: null } });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.ok(!cleared.body.shots.find((s) => s.id === shot.id).details.grade, 'grade cleared');
    const restored = await joinLuma('restored');
    assert.ok(Math.abs(restored - plain) < 5, `cleared grade restores the picture: ${restored.toFixed(1)} vs ${plain.toFixed(1)}`);
  } finally {
    await t.close();
  }
});
