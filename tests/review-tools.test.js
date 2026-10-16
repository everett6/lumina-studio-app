import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createAssetStore } from '../src/assets.js';
import { startTestApp, tinyPng } from './helpers.js';

const serverPath = fileURLToPath(new URL('../mcp/server.js', import.meta.url));
const parse = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text);
async function fixture() {
  const t = await startTestApp();
  const client = new Client({ name: 'review-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, LUMINA_DATA_DIR: t.dataRoot }, stderr: 'ignore' }));
  const assetStore = createAssetStore({ assetDir: path.join(t.dataRoot, 'storage', 'assets'), repo: t.app.repo });
  try {
    const raw = (name, args = {}) => client.callTool({ name, arguments: args });
    const call = async (name, args = {}) => { const r = await raw(name, args); assert.ok(!r.isError, r.content[0]?.text); return parse(r); };
    const project = await call('create_project', { name: 'Visual review' });
    const board = await call('create_storyboard', { projectId: project.id, title: 'Cuts', idea: 'A red room.', plan: false, imageProvider: 'mock', imageModel: 'mock-image', videoProvider: 'mock', videoModel: 'mock-video' });
    await call('import_shot_plan', { storyboardId: board.id, shots: Array.from({ length: 6 }, (_, i) => ({ description: `Room ${i}`, duration: 1, details: { method: 'video', dialogue: i === 0 ? [{ speaker: 'narrator', text: 'Hello.' }] : [] } })) });
    const shots = (await call('get_storyboard', { storyboardId: board.id })).shots;
    const frame = await assetStore.save({ projectId: project.id, bytes: tinyPng(), kind: 'reference' });
    const clips = [];
    for (const colour of ['red', 'blue']) {
      const file = path.join(t.dataRoot, `${colour}.mp4`);
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${colour}:s=96x64:r=12:d=1`, '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-y', file]);
      clips.push(await assetStore.save({ projectId: project.id, bytes: readFileSync(file), kind: 'video' }));
    }
    for (const s of shots) t.app.repo.shots.update(s.id, { imageAssetId: frame.id, videoAssetId: clips[0].id, details: { ...t.app.repo.shots.get(s.id).details, attachedClips: clips.map((a) => a.id) } });
    return { ...t, http: t.call, assetStore, client, raw, call, project, board, shots, frame, clips, close: async () => { await client.close(); await t.close(); } };
  } catch (error) { await client.close(); await t.close(); throw error; }
}
const finding = (shotId, result = 'failed', more = {}) => ({ shotId, area: 'identity', result, evidence: 'At 0.5s the reference has a red hat; the clip has a blue hat.', confidence: 0.9, reviewer: { name: 'human', model: 'eyes', version: '1' }, ...more });

test('review MCP tools register titles, schemas and cost notes; bundle is inline, timestamped and capped', async () => {
  const t = await fixture();
  try {
    const names = ['get_review_bundle', 'compare_takes', 'sample_frames', 'adjacent_shot_check', 'record_finding', 'review_summary', 'propose_repair', 'execute_repair', 'accept_repair', 'reject_take', 'repair_history'];
    const listed = (await t.client.listTools()).tools;
    for (const name of names) { const tool = listed.find((x) => x.name === name); assert.ok(tool, name); assert.ok(tool.title && tool.inputSchema); assert.match(tool.description, /Cost:/); }
    const hero = t.app.repo.characters.create({ name: 'Hero', referenceAssetIds: [t.frame.id] });
    t.app.repo.characters.update(hero.id, { locked: true });
    t.app.repo.sequences.update(t.board.id, { settings: { ...t.app.repo.sequences.get(t.board.id).settings, characterIds: [hero.id] } });
    const audioFile = path.join(t.dataRoot, 'hello.wav');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1', '-y', audioFile]);
    const audio = await t.assetStore.save({ projectId: t.project.id, bytes: readFileSync(audioFile), kind: 'audio' });
    const s = t.app.repo.shots.get(t.shots[0].id);
    t.app.repo.shots.update(s.id, { details: { ...s.details, dialogue: [{ ...s.details.dialogue[0], assetId: audio.id }] } });
    await t.call('set_scene_state', { shotId: s.id, start: { location: 'room' }, end: { location: 'room' } });
    await t.call('record_finding', finding(s.id));
    const result = await t.raw('get_review_bundle', { shotId: s.id });
    assert.ok(!result.isError, result.content[0].text);
    const bundle = parse(result);
    assert.equal(bundle.references[0].characterId, hero.id);
    assert.equal(bundle.sceneState.start.location, 'room');
    assert.equal(bundle.findings[0].result, 'failed');
    assert.deepEqual(bundle.frames.map((f) => f.label), ['opening', 'middle', 'ending']);
    assert.equal(bundle.frames[0].time, 0);
    assert.ok(bundle.frames[2].time > 0.8);
    assert.equal(bundle.neighbours[0].shotId, t.shots[1].id);
    assert.ok(result.content.some((x) => x.type === 'image'));
    assert.ok(result.content.some((x) => x.type === 'audio'));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2 * 1024 * 1024);
    // Oversize scene declarations cannot make the response unbounded.
    t.app.repo.settings.set(`scene-state:${s.id}`, { huge: 'x'.repeat(3 * 1024 * 1024) });
    const capped = await t.raw('get_review_bundle', { shotId: s.id });
    assert.ok(Buffer.byteLength(JSON.stringify(capped)) < 2 * 1024 * 1024);
    assert.ok(parse(capped).omitted.length);
    const samples = await t.raw('sample_frames', { assetId: t.clips[0].id, times: [0, 0.5] });
    assert.deepEqual(parse(samples).frames.map((f) => f.time), [0, 0.5]);
    assert.equal(samples.content.filter((x) => x.type === 'image').length, 2);
    assert.equal((await t.raw('sample_frames', { assetId: t.clips[0].id, times: [999] })).isError, true);
    assert.equal((await t.raw('sample_frames', { assetId: t.clips[0].id, times: [0], count: 2 })).isError, true);
    const cuts = await t.raw('adjacent_shot_check', { storyboardId: t.board.id });
    assert.equal(parse(cuts).cuts.length, 5);
    assert.equal(parse(cuts).cuts[0].colourJump, 0);
    assert.equal(parse(cuts).cuts[0].brightnessJump, 0);
  } finally { await t.close(); }
});

test('compare_takes pairs equal timestamps in one sheet and measures real pixel differences', async () => {
  const t = await fixture();
  try {
    for (const [takeB, identical] of [[t.clips[0].id, true], [t.clips[1].id, false]]) {
      const r = await t.raw('compare_takes', { shotId: t.shots[0].id, takeA: t.clips[0].id, takeB });
      assert.ok(!r.isError, r.content[0].text);
      assert.equal(r.content.filter((c) => c.type === 'image').length, 1);
      assert.equal(parse(r).moments.length, 3);
      assert.ok(parse(r).moments.every((m) => identical ? m.difference === 0 : m.difference > 50));
    }
  } finally { await t.close(); }
});

test('findings never promote failed or uncertain reviews to passed; unreviewed and new takes stay unreviewed', async () => {
  const t = await fixture();
  try {
    const shotId = t.shots[0].id;
    assert.equal((await t.call('review_summary', { storyboardId: t.board.id })).shots[0].areas.identity, 'not reviewed');
    const saved = await t.call('record_finding', finding(shotId));
    assert.equal(saved.finding.reviewer.version, '1');
    await t.call('record_finding', finding(shotId, 'passed', { reviewer: 'another person' }));
    assert.equal((await t.call('review_summary', { storyboardId: t.board.id })).shots[0].areas.identity, 'failed');
    await t.call('record_finding', finding(shotId, 'uncertain', { area: 'wardrobe' }));
    let report = await t.call('review_summary', { storyboardId: t.board.id });
    assert.equal(report.shots[0].areas.wardrobe, 'unavailable');
    assert.equal(report.shots[0].areas.deformation, 'not reviewed');
    const film = await t.call('start_film', { storyboardId: t.board.id });
    await t.call('record_finding', finding(shotId, 'failed', { area: 'text' }));
    assert.ok(t.app.repo.filmEvents.list(film.filmId).some((e) => e.kind === 'finding' && e.data.area === 'text'));
    report = await t.call('review_summary', { storyboardId: t.board.id });
    assert.equal(report.shots[0].areas.identity, 'failed', 'fallback findings survive opening a film');
    t.app.repo.shots.update(shotId, { videoAssetId: t.clips[1].id });
    assert.equal((await t.call('review_summary', { storyboardId: t.board.id })).shots[0].areas.identity, 'not reviewed');
  } finally { await t.close(); }
});

test('repairs keep originals and require review before acceptance; durable per-shot limit is two', async () => {
  const t = await fixture();
  try {
    const shotId = t.shots[0].id;
    const generated = (await t.http('POST', `/api/shots/${shotId}/frame`, {}));
    const frameJob = (await t.http('POST', `/api/generations/${generated.body.generation.id}/wait`, { timeoutMs: 10000 }));
    const originalFrame = frameJob.body.generation.assetId;
    const f = (await t.call('record_finding', finding(shotId))).finding;
    const proposal = await t.call('propose_repair', { shotId, findingId: f.id });
    assert.ok(proposal.plan.prompt.includes('red hat'));
    assert.ok(proposal.estimate && 'totalUsd' in proposal.estimate);
    const plan = { type: 'repair_frame', findingId: f.id, box: [0.1, 0.1, 0.5, 0.5], instruction: 'Restore the red hat.', provider: 'mock', model: 'mock-tools' };
    const first = await t.call('execute_repair', { shotId, plan });
    assert.equal(first.attempts.length, 1, 'success stops immediately');
    const takeId = first.attempts[0].takeId;
    assert.ok(takeId);
    assert.equal(t.app.repo.shots.get(shotId).imageAssetId, originalFrame);
    assert.equal(t.app.repo.shots.get(shotId).videoAssetId, t.clips[0].id);
    assert.equal((await t.raw('accept_repair', { shotId, takeId, reason: 'Looks good' })).isError, true);
    await t.call('record_finding', finding(shotId, 'uncertain', { takeId }));
    assert.equal((await t.raw('accept_repair', { shotId, takeId, reason: 'Looks good' })).isError, true);
    await t.call('reject_take', { shotId, takeId, reason: 'Still wrong.' });
    assert.equal(t.app.repo.shots.get(shotId).imageAssetId, originalFrame);
    const second = await t.call('execute_repair', { shotId, plan });
    const fixed = second.attempts[0].takeId;
    await t.call('record_finding', finding(shotId, 'passed', { takeId: fixed }));
    await t.call('accept_repair', { shotId, takeId: fixed, reason: 'Compared the repaired hat with the reference.' });
    assert.equal(t.app.repo.shots.get(shotId).imageAssetId, fixed);
    const stopped = await t.call('execute_repair', { shotId, plan });
    assert.equal(stopped.stopReason, 'shot_limit');
    assert.equal(stopped.attempts.length, 0);
    const takes = await t.call('list_shot_takes', { shotId });
    assert.ok(takes.frames.some((x) => x.assetId === originalFrame));
    const history = await t.call('repair_history', { shotId });
    assert.equal(history.attempts.length, 2);
    assert.ok(history.decisions.some((x) => x.reason === 'Still wrong.'));
  } finally { await t.close(); }
});

test('film limit stops at ten; budget refusal stops immediately without retry', async () => {
  const t = await fixture();
  try {
    await t.call('start_film', { storyboardId: t.board.id });
    const plan = { type: 'repair_frame', box: [0.1, 0.1, 0.5, 0.5], instruction: 'Restore hat.', provider: 'mock', model: 'mock-tools' };
    for (const s of t.shots.slice(0, 5)) {
      await t.call('execute_repair', { shotId: s.id, plan });
      await t.call('execute_repair', { shotId: s.id, plan });
    }
    const r = await t.call('execute_repair', { shotId: t.shots[5].id, plan });
    assert.equal(r.stopReason, 'film_limit');
    assert.equal((await t.call('repair_history', { storyboardId: t.board.id })).attempts.length, 10);
    // Use a second storyboard so the budget gate is reached before a repair limit.
    const board = await t.call('create_storyboard', { projectId: t.project.id, title: 'Budget', idea: 'x', plan: false });
    await t.call('import_shot_plan', { storyboardId: board.id, shots: [{ description: 'x', duration: 1 }] });
    const s = (await t.call('get_storyboard', { storyboardId: board.id })).shots[0];
    t.app.repo.shots.update(s.id, { imageAssetId: t.frame.id });
    t.app.repo.settings.set('budget', { enabled: true, strictPrices: true, confirmPaid: true, totalUsd: 0, perJobUsd: 0, retryReserveUsd: 0 });
    // Inject a refusal at the submission boundary; all actual providers remain offline mocks.
    const provider = t.app.generations;
    const original = provider.submit;
    provider.submit = () => { throw Object.assign(new Error('Budget refuses this repair'), { status: 402 }); };
    try {
      const refused = await t.call('execute_repair', { shotId: s.id, plan });
      assert.equal(refused.stopReason, 'budget_refused');
      assert.equal(refused.attempts.length, 1);
      assert.equal(refused.attempts[0].httpStatus, 402);
    } finally { provider.submit = original; }
  } finally { await t.close(); }
});

test('evaluateCheck reports labelled confusion rates and excludes unavailable predictions', async () => {
  const { evaluateCheck } = await import('../src/review.js');
  const r = evaluateCheck(['failed', 'failed', 'passed', 'passed', 'passed', 'failed'], ['failed', 'passed', 'failed', 'passed', 'unavailable', 'uncertain']);
  assert.equal(r.falsePositiveRate, 0.5);
  assert.equal(r.falseNegativeRate, 0.5);
  assert.equal(r.evaluated, 4);
  assert.equal(r.unavailable, 2);
  assert.equal(evaluateCheck([], []).falsePositiveRate, null);
  assert.equal(evaluateCheck(['failed'], ['failed']).falsePositiveRate, null);
  assert.throws(() => evaluateCheck(['failed'], []));
});

test('failed provider repairs retry at most twice and concurrent requests cannot duplicate an in-flight attempt', async () => {
  const t = await fixture();
  try {
    const shotId = t.shots[0].id;
    const plan = { type: 'repair_frame', box: [0.1, 0.1, 0.5, 0.5], instruction: '[fail] restore hat', provider: 'mock', model: 'mock-tools' };
    const result = await t.call('execute_repair', { shotId, plan });
    assert.equal(result.attempts.length, 2);
    assert.ok(result.attempts.every((a) => a.state === 'failed'));
    assert.equal((await t.call('execute_repair', { shotId, plan })).stopReason, 'shot_limit');
    const other = t.shots[1].id;
    const concurrent = await Promise.all([t.call('execute_repair', { shotId: other, plan: { ...plan, instruction: 'hat' } }), t.call('execute_repair', { shotId: other, plan: { ...plan, instruction: 'hat' } })]);
    assert.equal(concurrent.reduce((n, r) => n + r.attempts.length, 0), 1);
    assert.ok(concurrent.some((r) => r.stopReason === 'pending_attempt'));
    assert.equal(t.app.repo.shots.get(other).imageAssetId, t.frame.id);
  } finally { await t.close(); }
});

test('repair limits and findings survive an app and MCP restart and later creation of a film', async () => {
  const t = await fixture();
  let restarted;
  let client;
  try {
    const shotId = t.shots[0].id;
    const f = await t.call('record_finding', finding(shotId));
    const plan = { type: 'repair_frame', box: [0.1, 0.1, 0.5, 0.5], instruction: '[fail] restore hat', provider: 'mock', model: 'mock-tools' };
    await t.call('execute_repair', { shotId, plan });
    await t.client.close();
    await t.app.close();
    restarted = await startTestApp({ dataRoot: t.dataRoot });
    client = new Client({ name: 'review-restarted', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, LUMINA_DATA_DIR: t.dataRoot }, stderr: 'ignore' }));
    const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); assert.ok(!r.isError, r.content[0].text); return parse(r); };
    await call('start_film', { storyboardId: t.board.id });
    assert.equal((await call('execute_repair', { shotId, plan })).stopReason, 'shot_limit');
    assert.equal((await call('repair_history', { shotId })).attempts.length, 2);
    assert.equal((await call('review_summary', { storyboardId: t.board.id })).shots[0].areas.identity, 'failed');
    assert.ok((await call('get_review_bundle', { shotId })).findings.some((r) => r.id === f.finding.id));
  } finally {
    if (client) await client.close();
    if (restarted) await restarted.close();
    else await t.close();
  }
});

test('re-frame, approved-frame clip, trim and re-record candidates are staged until reviewed acceptance', async () => {
  const t = await fixture();
  try {
    const shotId = t.shots[0].id;
    const reframe = await t.call('execute_repair', { shotId, plan: { type: 're-frame', prompt: 'Restore the hat, keeping the approved face.', provider: 'mock', model: 'mock-image' } });
    assert.equal(reframe.attempts[0].state, 'completed');
    assert.equal(t.app.repo.shots.get(shotId).imageAssetId, t.frame.id);
    await t.http('POST', `/api/shots/${shotId}/approve-frame`, { approved: true });
    const clip = await t.call('execute_repair', { shotId, plan: { type: 'new_clip', frameId: t.frame.id, prompt: 'A slow turn of the head.' } });
    assert.ok(clip.attempts[0].takeId);
    assert.equal(t.app.repo.shots.get(shotId).videoAssetId, t.clips[0].id);
    await t.call('record_finding', finding(shotId, 'passed', { takeId: clip.attempts[0].takeId }));
    await t.call('accept_repair', { shotId, takeId: clip.attempts[0].takeId, reason: 'Compared all sampled moments.' });
    assert.equal(t.app.repo.shots.get(shotId).videoAssetId, clip.attempts[0].takeId);
    const audioShot = t.shots[1].id;
    const s = t.app.repo.shots.get(audioShot);
    const oldLine = { speaker: 'narrator', text: 'Speak clearly.', style: '', assetId: null };
    t.app.repo.shots.update(audioShot, { details: { ...s.details, dialogue: [oldLine] } });
    const seq = t.app.repo.sequences.get(t.board.id);
    t.app.repo.sequences.update(t.board.id, { settings: { ...seq.settings, narratorVoice: { provider: 'mock', model: 'mock-voice', voice: 'tone-low' } } });
    const recorded = await t.call('execute_repair', { shotId: audioShot, plan: { type: 're-record', lineIndex: 0, style: 'Clear and calm.' } });
    const audioTake = recorded.attempts[0].takeId;
    assert.ok(audioTake);
    assert.equal(t.app.repo.shots.get(audioShot).details.dialogue[0].assetId, null);
    await t.call('record_finding', finding(audioShot, 'passed', { takeId: audioTake, area: 'action' }));
    await t.call('accept_repair', { shotId: audioShot, takeId: audioTake, reason: 'Listened to the entire line.' });
    assert.equal(t.app.repo.shots.get(audioShot).details.dialogue[0].assetId, audioTake);
    const trimmed = await t.call('execute_repair', { shotId: audioShot, plan: { type: 'trim', trimStart: 0, duration: 1 } });
    const trimTake = trimmed.attempts[0].takeId;
    assert.ok(trimTake);
    await t.call('record_finding', finding(audioShot, 'passed', { takeId: trimTake, area: 'action' }));
    await t.call('accept_repair', { shotId: audioShot, takeId: trimTake, reason: 'Reviewed the requested cut.' });
    assert.equal(t.app.repo.shots.get(audioShot).duration, 1);
  } finally { await t.close(); }
});

test('cut evidence uses the edited shot interval rather than unused source-clip tails', async () => {
  const t = await fixture();
  try {
    const file = path.join(t.dataRoot, 'two-colours.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=96x64:r=12:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=96x64:r=12:d=1', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-y', file]);
    const clip = await t.assetStore.save({ projectId: t.project.id, bytes: readFileSync(file), kind: 'video' });
    t.app.repo.shots.update(t.shots[0].id, { videoAssetId: clip.id });
    const next = t.app.repo.shots.get(t.shots[1].id);
    t.app.repo.shots.update(next.id, { details: { ...next.details, trimStart: 0.25 } });
    const cuts = await t.call('adjacent_shot_check', { storyboardId: t.board.id });
    assert.ok(cuts.cuts[0].fromTime < 1, 'cut ends at the one-second planned boundary');
    assert.equal(cuts.cuts[0].toTime, 0.25);
    assert.equal(cuts.cuts[0].colourJump, 0, 'both actual cut frames are red');
    const bundle = await t.call('get_review_bundle', { shotId: t.shots[0].id });
    assert.ok(bundle.frames[2].time < 1);
    assert.equal(bundle.neighbours[0].time, 0.25);
  } finally { await t.close(); }
});
