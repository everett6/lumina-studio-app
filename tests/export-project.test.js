import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startTestApp } from './helpers.js';

const wait = async (t, response) => {
  assert.equal(response.status, 202, JSON.stringify(response.body));
  return (await t.call('POST', `/api/generations/${response.body.generation.id}/wait`, { timeoutMs: 20_000 })).body.generation;
};

test('export-project: originals, dialogue, music, timeline.json, EDL and SRT', async () => {
  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Edit' })).body.project;
    const song = await wait(t, await t.call('POST', '/api/generate', { projectId: project.id, operation: 'speech', prompt: 'la la la', provider: 'mock', model: 'mock-voice' }));
    const id = (await t.call('POST', `/api/projects/${project.id}/storyboards`, {
      title: 'Edit Me', idea: 'Two shots.', writer: 'mock:mock-director',
      settings: { shotCount: 2, imageProvider: 'mock', imageModel: 'mock-image', videoProvider: 'mock', videoModel: 'mock-video',
        narratorVoice: { provider: 'mock', model: 'mock-voice', voice: 'tone-low' }, music: { assetId: song.assetId, volume: 0.4 } },
    })).body.sequence.id;
    const [one, two] = (await t.call('POST', `/api/storyboards/${id}/plan`, {})).body.shots;
    await t.call('PATCH', `/api/shots/${one.id}`, { duration: 5, details: { trimStart: 0.5, dialogue: [{ speaker: 'narrator', text: 'The fox wakes.', start: 1 }, { speaker: 'narrator', text: 'Dawn is here.' }] } });
    await t.call('PATCH', `/api/shots/${two.id}`, { duration: 4 });
    await wait(t, await t.call('POST', `/api/shots/${one.id}/frame`, {}));
    await wait(t, await t.call('POST', `/api/shots/${one.id}/animate`, {}));
    await t.call('POST', `/api/shots/${one.id}/dialogue`, {});
    for (let i = 0; i < 100; i += 1) {
      const dialogue = (await t.call('GET', `/api/shots/${one.id}`)).body.shot.details.dialogue;
      if (dialogue.every((l) => l.assetId && l.seconds)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const res = await t.call('POST', `/api/storyboards/${id}/export-project`, {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { folder, files } = res.body;
    assert.ok(folder.startsWith(path.join(t.dataRoot, 'exports')));
    for (const f of files) assert.ok(existsSync(path.join(folder, f)), f);
    for (const expected of ['timeline.json', 'timeline.edl', 'subtitles.srt']) assert.ok(files.includes(expected), expected);
    assert.ok(files.some((f) => /^frames\/01\./.test(f)) && files.some((f) => /^clips\/01\./.test(f)));
    assert.equal(files.filter((f) => f.startsWith('dialogue/')).length, 2);
    assert.ok(files.some((f) => f.startsWith('music/')));
    assert.ok(!files.some((f) => /^clips\/02/.test(f)), 'shot 2 has no clip');

    const timeline = JSON.parse(readFileSync(path.join(folder, 'timeline.json'), 'utf8'));
    assert.equal(timeline.totalSeconds, 9);
    assert.deepEqual(timeline.shots.map((s) => [s.shot, s.start, s.duration]), [[1, 0, 5], [2, 5, 4]]);
    assert.equal(timeline.shots[0].trimStart, 0.5);
    assert.equal(timeline.shots[0].dialogue[0].start, 1);
    assert.equal(timeline.shots[0].dialogue[0].timingSet, true);
    assert.ok(timeline.shots[0].dialogue[1].start > timeline.shots[0].dialogue[0].start + timeline.shots[0].dialogue[0].seconds);
    assert.equal(timeline.audioBeds[0].role, 'music');

    const edl = readFileSync(path.join(folder, 'timeline.edl'), 'utf8');
    assert.match(edl, /^TITLE: Edit Me/);
    assert.match(edl, /001  AX       V     C        00:00:00:12 00:00:05:12 00:00:00:00 00:00:05:00/);
    assert.match(edl, /\* FROM CLIP NAME: 01\./);
    assert.ok(!/\n002 /.test(edl), 'only shots with a clip become events');

    const srt = readFileSync(path.join(folder, 'subtitles.srt'), 'utf8');
    assert.match(srt, /^1\n00:00:01,000 --> 00:00:0\d,\d{3}\nNarrator: The fox wakes\.|^1\n00:00:01,000 --> 00:00:0\d,\d{3}\nThe fox wakes\./);
    assert.match(srt, /\n2\n00:00:0\d,\d{3} --> [\d:,]+\nDawn is here\./);

    assert.equal((await t.call('POST', `/api/storyboards/${'00000000-0000-4000-8000-000000000000'}/export-project`, {})).status, 404);
  } finally { await t.close(); }
});
