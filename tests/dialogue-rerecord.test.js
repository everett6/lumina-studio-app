import assert from 'node:assert/strict';
import test from 'node:test';
import { startTestApp } from './helpers.js';

const voice = { provider: 'mock', model: 'mock-voice', voice: 'tone-low' };
async function until(read, ok = Boolean) {
  for (let i = 0; i < 100; i += 1) {
    const value = await read();
    if (ok(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out');
}
async function setup(t) {
  const project = (await t.call('POST', '/api/projects', { name: 'Lines' })).body.project;
  const id = (await t.call('POST', `/api/projects/${project.id}/storyboards`, {
    title: 'Lines', idea: 'Two lines.', writer: 'mock:mock-director', settings: { shotCount: 1, narratorVoice: voice },
  })).body.sequence.id;
  const [shot] = (await t.call('POST', `/api/storyboards/${id}/plan`, {})).body.shots;
  await t.call('PATCH', `/api/shots/${shot.id}`, { details: { dialogue: [{ speaker: 'narrator', text: 'First line here.', start: 1 }, { speaker: 'narrator', text: 'Second line follows.' }] } });
  return { id, shot };
}
const lines = async (t, shotId) => (await t.call('GET', `/api/shots/${shotId}`)).body.shot.details.dialogue;

test('rerecord one line: clears only that recording, keeps timing, queues one job, optional new style', async () => {
  const t = await startTestApp();
  try {
    const { shot } = await setup(t);
    const first = await t.call('POST', `/api/shots/${shot.id}/dialogue`, {});
    assert.equal(first.body.queued.length, 2);
    const recorded = await until(() => lines(t, shot.id), (ls) => ls.every((l) => l.assetId && l.seconds));
    assert.equal(recorded[0].start, 1);

    const res = await t.call('POST', `/api/shots/${shot.id}/dialogue/1/rerecord`, { style: 'whispering, tired' });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.queued.length, 1);
    assert.equal(res.body.queued[0].params.style, 'whispering, tired');
    const cleared = await lines(t, shot.id);
    assert.equal(cleared[0].assetId, recorded[0].assetId, 'line 0 untouched');
    assert.equal(cleared[1].assetId, null, 'line 1 cleared');
    assert.equal(cleared[1].style, 'whispering, tired');
    const again = await until(() => lines(t, shot.id), (ls) => ls[1].assetId && ls[1].seconds);
    assert.notEqual(again[1].assetId, recorded[1].assetId);
    assert.equal(again[0].assetId, recorded[0].assetId);

    assert.equal((await t.call('POST', `/api/shots/${shot.id}/dialogue/5/rerecord`, {})).status, 404);
  } finally { await t.close(); }
});

test('rerecord needs a voice and clears nothing without one', async () => {
  const t = await startTestApp();
  try {
    const { id, shot } = await setup(t);
    await t.call('POST', `/api/shots/${shot.id}/dialogue`, {});
    await until(() => lines(t, shot.id), (ls) => ls.every((l) => l.assetId));
    await t.call('PATCH', `/api/storyboards/${id}`, { settings: { narratorVoice: null } });
    const none = await t.call('POST', `/api/shots/${shot.id}/dialogue/0/rerecord`, {});
    assert.equal(none.status, 400);
    assert.match(none.body.error, /no voice/);
    assert.ok((await lines(t, shot.id))[0].assetId, 'nothing was cleared when it could not be re-recorded');
  } finally { await t.close(); }
});

test('line timing: changing only details.dialogue[i].start keeps recordings, works on locked shots and keeps the review', async () => {
  const t = await startTestApp();
  try {
    const { shot } = await setup(t);
    await t.call('POST', `/api/shots/${shot.id}/dialogue`, {});
    const recorded = await until(() => lines(t, shot.id), (ls) => ls.every((l) => l.assetId && l.seconds));
    await t.call('PATCH', `/api/shots/${shot.id}`, { details: { locked: true } });
    await t.call('POST', `/api/shots/${shot.id}/approve-frame`, {}).catch(() => {});
    const send = (start) => t.call('PATCH', `/api/shots/${shot.id}`, { details: { dialogue: recorded.map((l, i) => ({ speaker: l.speaker, text: l.text, style: l.style, start: i === 1 ? start : l.start })) } });
    const moved = await send(2.5);
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const after = await lines(t, shot.id);
    assert.equal(after[1].start, 2.5);
    assert.equal(after[1].assetId, recorded[1].assetId);
    assert.equal((await send(null)).status, 200);
    assert.equal((await lines(t, shot.id))[1].start, null);
    // Changing the words of a locked shot is still refused.
    const words = await t.call('PATCH', `/api/shots/${shot.id}`, { details: { dialogue: [{ speaker: 'narrator', text: 'Different words.' }] } });
    assert.equal(words.status, 409);
  } finally { await t.close(); }
});
