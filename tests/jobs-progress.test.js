import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanGrade, gradeFilter } from '../src/sequences.js';
import { contactSheet } from '../src/video.js';
import { startTestApp } from './helpers.js';

const image = (projectId, prompt) => ({ projectId, operation: 'generate', prompt, provider: 'mock', model: 'mock-image', size: '1024x1024' });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('jobs: running jobs report progress, queued and running local jobs can be cancelled, active jobs are listed', async () => {
  const before = process.env.LUMINA_MOCK_DELAY_MS;
  process.env.LUMINA_MOCK_DELAY_MS = '1600'; // four 400 ms steps
  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Jobs' })).body.project;
    const ids = [];
    for (const prompt of ['one', 'two', 'three']) ids.push((await t.call('POST', '/api/generate', image(project.id, prompt))).body.generation.id);
    await pause(700);
    const running = (await t.call('GET', `/api/generations/${ids[0]}`)).body.generation;
    assert.equal(running.status, 'running');
    assert.equal(running.progress.total, 4);
    assert.ok(running.progress.done >= 1 && running.progress.fraction > 0);
    assert.ok(running.progress.etaSeconds === null || running.progress.etaSeconds >= 0);

    const active = (await t.call('GET', `/api/projects/${project.id}/active-jobs`)).body.jobs;
    assert.deepEqual(active.map((j) => j.status).sort(), ['queued', 'running', 'running']); // concurrency 2
    assert.equal(active.find((j) => j.status === 'queued').progress, null);

    const queued = await t.call('POST', `/api/generations/${ids[2]}/cancel`, {});
    assert.equal(queued.status, 200);
    assert.equal(queued.body.generation.status, 'failed');
    assert.equal(queued.body.generation.errorCategory, 'cancelled');

    assert.equal((await t.call('POST', `/api/generations/${ids[0]}/cancel`, {})).status, 200);
    const stopped = (await t.call('POST', `/api/generations/${ids[0]}/wait`, { timeoutMs: 5000 })).body.generation;
    assert.equal(stopped.status, 'failed');
    assert.equal(stopped.errorCategory, 'cancelled');
    assert.ok(!stopped.outputAssetId);

    const finished = (await t.call('POST', `/api/generations/${ids[1]}/wait`, { timeoutMs: 10_000 })).body.generation;
    assert.equal(finished.status, 'completed');
    assert.equal(finished.progress, undefined);
    assert.equal((await t.call('POST', `/api/generations/${ids[1]}/cancel`, {})).status, 409);
    assert.deepEqual((await t.call('GET', `/api/projects/${project.id}/active-jobs`)).body.jobs, []);
  } finally {
    process.env.LUMINA_MOCK_DELAY_MS = before;
    await t.close();
  }
});

test('contact sheets: storyboard frames and a shot clip come back as JPEG grids', async () => {
  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Sheets' })).body.project;
    const board = (await t.call('POST', `/api/projects/${project.id}/storyboards`, { title: 'Sheet', idea: 'A fox crosses a lake.', writer: 'mock:mock-director',
      settings: { shotCount: 2, imageProvider: 'mock', imageModel: 'mock-image', videoProvider: 'mock', videoModel: 'mock-video' } })).body;
    const id = board.sequence.id;
    const detail = board.shots?.length ? board : (await t.call('POST', `/api/storyboards/${id}/plan`, {})).body;
    assert.equal((await t.call('GET', `/api/storyboards/${id}/contact-sheet`)).status, 404, 'nothing to show yet');
    const frames = [];
    for (const shot of detail.shots) frames.push((await t.call('POST', `/api/shots/${shot.id}/frame`, {})).body.generation.id);
    for (const g of frames) await t.call('POST', `/api/generations/${g}/wait`, { timeoutMs: 20_000 });
    const fetchSheet = async (url) => {
      const response = await fetch(`${t.app.origin}${url}`, { headers: { authorization: `Bearer ${t.app.token}` } });
      return { status: response.status, type: response.headers.get('content-type'), bytes: Buffer.from(await response.arrayBuffer()) };
    };
    const sheet = await fetchSheet(`/api/storyboards/${id}/contact-sheet?kind=frames`);
    assert.equal(sheet.status, 200);
    assert.equal(sheet.type, 'image/jpeg');
    assert.equal(sheet.bytes.subarray(0, 2).toString('hex'), 'ffd8');

    const shotId = detail.shots[0].id;
    assert.equal((await fetchSheet(`/api/shots/${shotId}/contact-sheet`)).status, 404, 'no clip yet');
    const clip = (await t.call('POST', `/api/shots/${shotId}/animate`, {})).body.generation.id;
    await t.call('POST', `/api/generations/${clip}/wait`, { timeoutMs: 30_000 });
    const clipSheet = await fetchSheet(`/api/shots/${shotId}/contact-sheet`);
    assert.equal(clipSheet.status, 200);
    assert.equal(clipSheet.bytes.subarray(0, 2).toString('hex'), 'ffd8');
    assert.equal((await fetchSheet(`/api/storyboards/${id}/contact-sheet?kind=clips`)).status, 200);

    const shot = (await t.call('GET', `/api/shots/${shotId}`)).body;
    assert.equal(shot.sequenceId, id);
    assert.equal(shot.shot.id, shotId);
  } finally {
    await t.close();
  }
});

test('shot grade: clamped, neutral values dropped, turned into an ffmpeg filter', () => {
  assert.deepEqual(cleanGrade({ brightness: -0.9, contrast: 1, saturation: 0.8, warmth: 'x' }), { brightness: -0.3, saturation: 0.8 });
  assert.equal(cleanGrade({ contrast: 1, warmth: 0 }), null);
  assert.equal(gradeFilter(null), '');
  assert.equal(gradeFilter({ brightness: -0.1 }), 'eq=brightness=-0.1:contrast=1:saturation=1');
  assert.equal(gradeFilter({ warmth: 0.4 }), 'colorbalance=rs=0.060:rm=0.060:bs=-0.060:bm=-0.060');
});

test('contact sheet still renders when one tile cannot be read', async () => {
  const tiles = Array.from({ length: 6 }, (_, i) => ({ file: `/nonexistent/missing-${i}.mp4`, time: 1, label: `Shot ${i + 1}` }));
  const sheet = await contactSheet(tiles, { columns: 3, width: 160 });
  assert.equal(sheet.subarray(0, 2).toString('hex'), 'ffd8');
});
