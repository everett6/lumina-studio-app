import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { lineTimes } from '../src/soundtrack.js';
import { startTestApp, tinyPngDataUrl } from './helpers.js';

const has = (command) => spawnSync(command, ['-version'], { stdio: 'ignore' }).status === 0;
const media = has('ffmpeg') && has('ffprobe');
const wait = async (t, response) => {
  assert.equal(response.status, 202, JSON.stringify(response.body));
  return (await t.call('POST', `/api/generations/${response.body.generation.id}/wait`, { timeoutMs: 20_000 })).body.generation;
};
const bytesOf = async (t, assetPath) => Buffer.from(await (await fetch(`${t.app.origin}${assetPath}`, { headers: { authorization: `Bearer ${t.app.token}` } })).arrayBuffer());
const waitFor = async (t, id, ok, timeoutMs = 120_000) => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const detail = (await t.call('GET', `/api/storyboards/${id}`)).body;
    if (ok(detail)) return detail;
    if (Date.now() > until) throw new Error(`timed out: ${JSON.stringify(detail.sequence.production)} ${JSON.stringify(detail.sequence.join)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

async function filmSetup(t, settings = {}) {
  const project = (await t.call('POST', '/api/projects', { name: 'Continuity' })).body.project;
  const photo = (await t.call('POST', '/api/assets', { projectId: project.id, dataUrl: tinyPngDataUrl(), label: 'pip.png' })).body.asset;
  const pip = (await t.call('POST', '/api/characters', { name: 'Pip', description: 'small red fox, green scarf', referenceAssetIds: [photo.id] })).body.character;
  const lake = (await t.call('POST', '/api/characters', { name: 'Lake', kind: 'location', description: 'misty lake, wooden jetty on the left, pines behind' })).body.character;
  const created = await t.call('POST', `/api/projects/${project.id}/storyboards`, {
    title: 'Dawn', idea: 'Pip visits the lake.', writer: 'mock:mock-director',
    settings: {
      shotCount: 3, characterIds: [pip.id, lake.id], imageProvider: 'mock', imageModel: 'mock-image', videoProvider: 'mock', videoModel: 'mock-video',
      look: 'anime', lookBible: 'Muted dawn palette, soft rim light, 35mm lens.', ...settings,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { project, pip, lake, id: created.body.sequence.id, sequence: created.body.sequence };
}

test('continuity: the plan names cast and sets per shot; every frame and clip carries the look, look bible, seed and references', async () => {
  const t = await startTestApp();
  try {
    const { pip, lake, id, sequence } = await filmSetup(t, { continuity: 'keyframes' });
    assert.ok(Number.isInteger(sequence.settings.seed) && sequence.settings.seed > 0, 'a new storyboard gets a fixed seed');
    const planned = (await t.call('POST', `/api/storyboards/${id}/plan`, {})).body;
    const [one, two, three] = planned.shots;
    assert.deepEqual(one.details.characterIds, [pip.id]);
    assert.equal(one.details.locationId, lake.id);
    assert.equal(one.details.dialogue[0].speaker, pip.id);
    assert.equal(one.details.dialogue[0].text, 'The water is so still today.');
    assert.equal(one.details.scene, '1 – The lake');

    const frameOne = await wait(t, await t.call('POST', `/api/shots/${one.id}/frame`, {}));
    assert.equal(frameOne.params.seed, sequence.settings.seed);
    assert.match(frameOne.finalPrompt, /anime feature film/);
    assert.match(frameOne.finalPrompt, /Muted dawn palette/);
    assert.match(frameOne.finalPrompt, /At this moment: at the reeds/);
    assert.match(frameOne.finalPrompt, /Pip — small red fox/);
    assert.match(frameOne.finalPrompt, /misty lake, wooden jetty/);
    assert.equal(frameOne.inputAssetIds.length, 1, 'the character reference photo goes with the frame');
    const frameTwo = await wait(t, await t.call('POST', `/api/shots/${two.id}/frame`, {}));
    const frameThree = await wait(t, await t.call('POST', `/api/shots/${three.id}/frame`, {}));

    // Keyframes: shot 1 runs from its frame to shot 2's frame (same scene); shot 2 does not end on shot 3 (new scene).
    const clipOne = await wait(t, await t.call('POST', `/api/shots/${one.id}/animate`, {}));
    assert.equal(clipOne.inputAssetIds[0], frameOne.assetId);
    assert.equal(clipOne.params.endFrameAssetId, frameTwo.assetId);
    assert.equal(clipOne.params.seed, sequence.settings.seed);
    assert.match(clipOne.finalPrompt, /By the end of the shot: at the water/);
    assert.match(clipOne.finalPrompt, /Keep every person exactly as in the start frame/);
    const clipTwo = await wait(t, await t.call('POST', `/api/shots/${two.id}/animate`, {}));
    assert.equal(clipTwo.params.endFrameAssetId, undefined);
    assert.ok(frameThree.assetId);

    // A job already running for a shot is returned instead of a second (paid) one.
    const first = await t.call('POST', `/api/shots/${three.id}/animate`, {});
    const again = await t.call('POST', `/api/shots/${three.id}/animate`, {});
    assert.equal(again.body.alreadyRunning, true);
    assert.equal(again.body.generation.id, first.body.generation.id);
  } finally {
    await t.close();
  }
});

test('continuity: locked shots keep their story; re-planning is refused while any shot is locked', async () => {
  const t = await startTestApp();
  try {
    const { id } = await filmSetup(t);
    const [one] = (await t.call('POST', `/api/storyboards/${id}/plan`, {})).body.shots;
    const locked = await t.call('PATCH', `/api/shots/${one.id}`, { details: { locked: true, forbidden: 'the green scarf' } });
    assert.equal(locked.status, 200, JSON.stringify(locked.body));
    assert.equal(locked.body.shots[0].details.forbidden, 'the green scarf');
    assert.equal((await t.call('PATCH', `/api/shots/${one.id}`, { description: 'Something else.' })).status, 409);
    assert.equal((await t.call('PATCH', `/api/shots/${one.id}`, { details: { dialogue: [{ speaker: 'narrator', text: 'New words.' }] } })).status, 409);
    assert.equal((await t.call('PATCH', `/api/shots/${one.id}`, { details: { characterIds: [] } })).status, 409, 'a lock also protects cast continuity');
    assert.equal((await t.call('PATCH', `/api/shots/${one.id}`, { camera: 'orbit-left' })).status, 200, 'camera is not story');
    assert.equal((await t.call('POST', `/api/storyboards/${id}/plan`, { replace: true })).status, 409);
    const unlocked = await t.call('PATCH', `/api/shots/${one.id}`, { description: 'Revised.', details: { locked: false } });
    assert.equal(unlocked.status, 200);
    assert.equal(unlocked.body.shots[0].description, 'Revised.');
    assert.equal((await t.call('PATCH', `/api/shots/${one.id}`, { details: { characterIds: ['00000000-0000-4000-8000-000000000000'] } })).status, 404);
  } finally {
    await t.close();
  }
});

test('continuity: chained production waits for frame approval before starting a paid clip', { skip: !media && 'needs ffmpeg', timeout: 120_000 }, async () => {
  const t = await startTestApp();
  try {
    const { project, id } = await filmSetup(t, { shotCount: 1, continuity: 'chain', requireApproval: true });
    const [shot] = (await t.call('POST', `/api/storyboards/${id}/plan`, {})).body.shots;
    assert.equal((await t.call('POST', `/api/storyboards/${id}/produce`, {})).status, 202);
    const waiting = await waitFor(t, id, (d) => d.sequence.production?.state === 'review' && d.shots[0].imageAssetId);
    assert.equal(waiting.shots[0].videoAssetId, null);
    assert.equal((await t.call('GET', `/api/projects/${project.id}`)).body.generations.some((g) => g.bookTarget === `shot-video:${shot.id}`), false);

    assert.equal((await t.call('POST', `/api/shots/${shot.id}/approve-frame`, { approved: true })).status, 200);
    assert.equal((await t.call('POST', `/api/storyboards/${id}/produce`, {})).status, 202);
    await waitFor(t, id, (d) => d.shots[0].videoAssetId || d.sequence.production?.state === 'paused');
    assert.equal((await t.call('GET', `/api/projects/${project.id}`)).body.generations.some((g) => g.bookTarget === `shot-video:${shot.id}`), true);
    await t.call('POST', `/api/storyboards/${id}/stop`, {});
  } finally {
    await t.close();
  }
});

test('continuity: still shots render free, clips are checked for drift, approval gates the film', { skip: !media && 'needs ffmpeg' }, async () => {
  const t = await startTestApp();
  try {
    const { id } = await filmSetup(t, { requireApproval: true, videoSecondsBudget: 10, outputHeight: 720 });
    const shots = (await t.call('POST', `/api/storyboards/${id}/plan`, {})).body.shots;
    assert.deepEqual(shots.map((s) => s.details.method), ['video', 'video', 'still'], 'the budgeted plan uses a still shot');
    for (const shot of shots) await wait(t, await t.call('POST', `/api/shots/${shot.id}/frame`, {}));
    assert.equal((await t.call('POST', `/api/shots/${shots[2].id}/animate`, {})).status, 400, 'still shots are not sent to a video model');

    const still = await t.call('POST', `/api/shots/${shots[2].id}/still`, {});
    assert.equal(still.status, 200, JSON.stringify(still.body));
    const stillShot = still.body.shots[2];
    assert.ok(stillShot.videoPath);
    assert.equal(stillShot.review.status, 'needs_review');
    assert.ok(stillShot.review.checks.some((c) => c.id === 'length' && c.ok));
    const stillFile = path.join(t.dataRoot, 'still.mp4');
    writeFileSync(stillFile, await bytesOf(t, stillShot.videoPath));
    const [w, h, d] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'csv=p=0:s=,', stillFile]).toString().trim().split(/[\n,]/).filter(Boolean).map(Number);
    assert.deepEqual([w, h], [1280, 720], 'still shots render at the film size');
    assert.ok(Math.abs(d - stillShot.duration) < 0.1);

    for (const shot of shots.slice(0, 2)) await wait(t, await t.call('POST', `/api/shots/${shot.id}/animate`, {}));
    const checked = await waitFor(t, id, (d) => d.shots.slice(0, 2).every((s) => s.review.checks));
    const checks = checked.shots[0].review.checks;
    assert.ok(checks.some((c) => c.id === 'start-frame'), JSON.stringify(checks));
    assert.ok(checks.some((c) => c.id === 'readable' && c.ok));

    const blocked = await t.call('POST', `/api/storyboards/${id}/stitch`, { wait: true });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /Approval required/);
    assert.equal((await t.call('POST', `/api/shots/${shots[0].id}/review`, { status: 'great' })).status, 400);
    for (const shot of shots) {
      const reviewed = await t.call('POST', `/api/shots/${shot.id}/review`, { status: 'accepted', notes: 'on model' });
      assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
    }
    const film = await t.call('POST', `/api/storyboards/${id}/stitch`, { wait: true });
    assert.equal(film.status, 200, JSON.stringify(film.body));
    const file = path.join(t.dataRoot, 'film.mp4');
    writeFileSync(file, await bytesOf(t, film.body.sequence.outputPath));
    const seconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());
    const planned = shots.reduce((sum, s) => sum + s.duration, 0);
    assert.ok(Math.abs(seconds - planned) < 0.1, `film ${seconds} s for ${planned} s planned`);
  } finally {
    await t.close();
  }
});

test('continuity: dialogue is voiced per character and mixed in; upscaled clips are made once and reused', { skip: !media && 'needs ffmpeg', timeout: 300_000 }, async () => {
  const t = await startTestApp();
  try {
    const { pip, id } = await filmSetup(t, { shotCount: 2, upscale: 'fast', outputHeight: 720 });
    await t.call('PATCH', `/api/characters/${pip.id}`, { voice: { provider: 'mock', model: 'mock-voice', voice: 'tone-high' } });
    const shots = (await t.call('POST', `/api/storyboards/${id}/plan`, {})).body.shots;
    const dialogue = await t.call('POST', `/api/shots/${shots[0].id}/dialogue`, {});
    assert.equal(dialogue.status, 202);
    assert.equal(dialogue.body.queued.length, 1);
    assert.deepEqual(dialogue.body.missingVoices, []);
    const line = await waitFor(t, id, (d) => d.shots[0].details.dialogue[0].seconds);
    assert.ok(line.shots[0].details.dialogue[0].audioPath);

    for (const shot of shots) {
      await wait(t, await t.call('POST', `/api/shots/${shot.id}/frame`, {}));
      await wait(t, await t.call('POST', `/api/shots/${shot.id}/animate`, {}));
    }
    const first = await t.call('POST', `/api/storyboards/${id}/stitch`, { wait: true });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const after = (await t.call('GET', `/api/storyboards/${id}`)).body;
    const cached = after.shots.map((s) => Object.keys(s.details.post).find((k) => k.startsWith('upscaled|')));
    assert.ok(cached.every(Boolean), 'each shot was upscaled once and kept');
    const file = path.join(t.dataRoot, 'film.mp4');
    writeFileSync(file, await bytesOf(t, first.body.sequence.outputPath));
    const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString());
    const video = info.streams.find((s) => s.codec_type === 'video');
    assert.deepEqual([video.width, video.height], [1280, 720]);
    assert.ok(info.streams.some((s) => s.codec_type === 'audio'));
    // The line is audible where it was placed (0.4 s into shot 1).
    const level = spawnSync('ffmpeg', ['-v', 'info', '-ss', '0.5', '-t', '0.3', '-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const mean = Number(/mean_volume: (-?[\d.]+) dB/.exec(level)?.[1]);
    assert.ok(mean > -40, `dialogue level ${mean} dB`);

    const again = await t.call('POST', `/api/storyboards/${id}/stitch`, { wait: true });
    assert.equal(again.status, 200);
    const reused = (await t.call('GET', `/api/storyboards/${id}`)).body.shots.map((s) => s.details.post);
    assert.deepEqual(reused, after.shots.map((s) => s.details.post), 'no second upscale');
  } finally {
    await t.close();
  }
});

test('soundtrack: dialogue lines are placed one after another and overruns are reported', () => {
  const { times, overrun } = lineTimes([{ text: 'a' }, { text: 'b' }, { text: 'c', start: 5 }], 6, [1.5, 1, 2]);
  assert.deepEqual(times, [0.4, 2.15, 5]);
  assert.equal(overrun, 1);
});

test('soundtrack: an uploaded music bed plays under the film', { skip: !media && 'needs ffmpeg' }, async () => {
  const t = await startTestApp();
  try {
    const { project, id } = await filmSetup(t, { shotCount: 1, outputHeight: 720 });
    const wav = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', '-f', 'wav', '-']);
    const upload = async (bytes) => fetch(`${t.app.origin}/api/projects/${project.id}/audio`, { method: 'POST', body: bytes, headers: { authorization: `Bearer ${t.app.token}`, 'x-lumina-label': 'theme.wav' } });
    assert.equal((await upload(Buffer.from('not audio at all'))).status, 400);
    const response = await upload(wav);
    assert.equal(response.status, 201);
    const music = (await response.json()).asset;
    assert.equal(music.kind, 'audio');
    await t.call('PATCH', `/api/storyboards/${id}`, { settings: { music: { assetId: music.id, volume: 0.8 }, clipVolume: 0 } });
    const [shot] = (await t.call('POST', `/api/storyboards/${id}/plan`, {})).body.shots;
    await wait(t, await t.call('POST', `/api/shots/${shot.id}/frame`, {}));
    await wait(t, await t.call('POST', `/api/shots/${shot.id}/animate`, {}));
    const film = await t.call('POST', `/api/storyboards/${id}/stitch`, { wait: true });
    assert.equal(film.status, 200, JSON.stringify(film.body));
    const file = path.join(t.dataRoot, 'film.mp4');
    writeFileSync(file, await bytesOf(t, film.body.sequence.outputPath));
    // The 2 s bed loops for the whole shot: still audible near the end.
    const level = spawnSync('ffmpeg', ['-v', 'info', '-sseof', '-1.2', '-t', '0.5', '-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const mean = Number(/mean_volume: (-?[\d.]+) dB/.exec(level)?.[1]);
    assert.ok(mean > -40, `music level ${mean} dB`);
  } finally {
    await t.close();
  }
});

test('themes: the writer is told to show each theme on screen, shots are tagged, prompts carry the theme, gaps are reported', async () => {
  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Themes' })).body.project;
    const themes = ['Chaos agent: a grinning trickster who breaks every plan with fire', 'Transcendentalist doctrine: a monk alone in wild nature at dawn'];
    const id = (await t.call('POST', `/api/projects/${project.id}/storyboards`, {
      title: 'T', idea: 'A trickster and a monk', writer: 'mock:mock-director',
      settings: { shotCount: 4, themes, imageProvider: 'mock', imageModel: 'mock-image', videoProvider: 'mock', videoModel: 'mock-video' },
    })).body.sequence.id;
    const planned = (await t.call('POST', `/api/storyboards/${id}/plan`, {})).body;
    assert.deepEqual(planned.sequence.settings.themes, themes);
    assert.deepEqual(planned.shots.map((s) => s.details.themes), [['Chaos agent'], [], ['Chaos agent'], []]);
    assert.deepEqual(planned.sequence.themeCoverage, { where: { 'Chaos agent': [1, 3], 'Transcendentalist doctrine': [] }, missing: ['Transcendentalist doctrine'] });
    const frame = await t.call('POST', `/api/shots/${planned.shots[0].id}/frame`, {});
    assert.match(frame.body.generation.prompt, /Theme on screen: Chaos agent \(a grinning trickster who breaks every plan with fire\)/);
    await t.call('POST', `/api/generations/${frame.body.generation.id}/wait`, { timeoutMs: 20_000 });
    // Tagging a shot by hand closes the gap.
    const tagged = (await t.call('PATCH', `/api/shots/${planned.shots[1].id}`, { details: { themes: ['Transcendentalist doctrine'] } })).body;
    assert.deepEqual(tagged.sequence.themeCoverage.missing, []);
  } finally {
    await t.close();
  }
});
