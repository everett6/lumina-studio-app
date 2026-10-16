import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { startTestApp, quietLog } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { createRepo } from '../src/repo.js';
import { createSequenceService } from '../src/sequences.js';
import { createProviders } from '../src/providers/index.js';
import { createAssetStore } from '../src/assets.js';
import { createProductionController } from '../src/production.js';

process.env.LUMINA_NO_NVENC = '1';
async function fixture(t, { dialogue = false, policy = {}, brief = {}, imported = true } = {}) {
  const h = await startTestApp();
  const { repo, generations } = h.app;
  const sequences = createSequenceService({ repo, generations, providers: createProviders({ enableMock: true }),
    assetStore: createAssetStore({ repo, assetDir: path.join(h.dataRoot, 'storage', 'assets') }), log: quietLog });
  t.after(async () => { await h.app.jobs.idle(); await sequences.idle(); await h.close(); });
  const project = repo.projects.create('Production tests');
  const sequence = sequences.create({ projectId: project.id, title: 'Persistent film', settings: {
    imageProvider: 'mock', imageModel: 'mock-image', videoProvider: 'mock', videoModel: 'mock-video',
    requireApproval: true, colorMatch: 'off', outputHeight: 720,
    narratorVoice: { provider: 'mock', model: 'mock-voice', voice: 'tone-low' },
  } });
  const plan = [{ description: 'A red light', duration: 1, details: { dialogue: dialogue ? [{ speaker: 'narrator', text: 'Hi.' }] : [] } }];
  if (imported) sequences.importPlan(sequence.id, { shots: plan });
  let time = Date.now();
  const controller = (service = sequences, repository = repo) => createProductionController({ repo: repository, sequences: service, generations, log: quietLog, now: () => time });
  const c = controller();
  const film = c.open(sequence.id, { brief, policy: { autoApproveFrames: true, autoAcceptClips: true, ...policy } });
  c.acquire(film.id, 'one', 60_000);
  const step = (which = c, owner = 'one') => which.step(film.id, { owner, expectedRevision: which.status(film.id).filmRevision });
  const settle = async () => { await h.app.jobs.idle(); await sequences.idle(); };
  const reach = async (stage) => {
    for (let i = 0; i < 30 && c.status(film.id).stage !== stage; i++) { await step(); await settle(); }
    assert.equal(c.status(film.id).stage, stage, JSON.stringify(c.status(film.id)));
  };
  return { ...h, repo, sequences, generations, sequence, film, c, controller, step, settle, reach, plan, tick: (ms) => { time += ms; } };
}

test('restart at every stage preserves all generations, approvals and one delivery', async (t) => {
  const f = await fixture(t, { dialogue: true });
  for (const stage of ['plan', 'frames', 'approve-frames', 'clips', 'review', 'voices', 'join', 'deliver']) {
    await f.reach(stage);
    await f.settle();
    const ids = f.repo.generations.listByProject(f.sequence.projectId).map((g) => g.id).sort();
    const approvals = f.repo.filmEvents.list(f.film.id).filter((e) => e.kind === 'approval');
    const restarted = f.controller();
    await restarted.resume(f.film.id, 'one');
    assert.ok(ids.every((id) => f.repo.generations.get(id)), stage);
    assert.ok(approvals.every((event) => f.repo.filmEvents.list(f.film.id).some((e) => e.id === event.id)), stage);
    assert.equal(new Set(restarted.status(f.film.id).jobIds).size, restarted.status(f.film.id).jobIds.length);
  }
  for (let i = 0; i < 5 && f.c.status(f.film.id).state !== 'delivered'; i++) await f.step();
  assert.equal(f.c.status(f.film.id).state, 'delivered');
  await f.c.resume(f.film.id, 'one');
  const jobs = f.repo.generations.listByProject(f.sequence.projectId);
  assert.equal(jobs.length, 3);
  assert.equal(f.repo.filmEvents.list(f.film.id).filter((e) => e.kind === 'delivery').length, 1);
  assert.equal(f.repo.filmEvents.list(f.film.id).filter((e) => e.kind === 'approval' && e.data.approved).length, 2);
  for (const job of jobs) assert.ok(f.repo.filmEvents.list(f.film.id).some((e) => e.kind === 'job' && e.data.jobId === job.id));
});

test('open is idempotent and the event journal is append-only', async (t) => {
  const f = await fixture(t);
  assert.equal(f.c.open(f.sequence.id, { brief: { changed: true } }).id, f.film.id);
  assert.deepEqual(f.repo.films.get(f.film.id).brief, {});
  const db = openDatabase(path.join(f.dataRoot, 'data'));
  t.after(() => db.close());
  assert.throws(() => db.prepare('UPDATE film_events SET kind = ? WHERE film_id = ?').run('pause', f.film.id), /append.only/i);
  assert.ok(f.repo.filmEvents.list(f.film.id).length > 0);
});

test('deleting a storyboard removes its film and journal (events go only with their film)', async (t) => {
  const f = await fixture(t);
  await f.settle();
  const removed = await f.call('DELETE', `/api/storyboards/${f.sequence.id}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(f.repo.films.get(f.film.id) ?? null, null);
  assert.deepEqual(f.repo.filmEvents.list(f.film.id), []);
});

test('two database connections race for a conditional lease and expire safely', async (t) => {
  const f = await fixture(t);
  const db = openDatabase(path.join(f.dataRoot, 'data'));
  t.after(() => db.close());
  const other = f.controller(f.sequences, createRepo(db));
  f.c.release(f.film.id, 'one');
  const results = await Promise.all([Promise.resolve().then(() => f.c.acquire(f.film.id, 'one', 100)),
    Promise.resolve().then(() => other.acquire(f.film.id, 'two', 100))]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(other.release(f.film.id, 'two'), false);
  await assert.rejects(f.step(other, 'two'), (e) => e.status === 409);
  f.tick(101);
  assert.equal(other.acquire(f.film.id, 'two', 1000), true);
  await assert.rejects(f.step(f.c), (e) => e.status === 409);
});

test('an edit makes an old revision conflict before any work is submitted', async (t) => {
  const f = await fixture(t);
  const revision = f.c.status(f.film.id).filmRevision;
  f.repo.films.edit(f.film.id, { expectedRevision: revision, brief: { targetSeconds: 8 }, at: new Date().toISOString() });
  await assert.rejects(f.c.step(f.film.id, { owner: 'one', expectedRevision: revision }), (e) => e.status === 409);
  assert.equal(f.repo.generations.listByProject(f.sequence.projectId).length, 0);
});

test('resume adopts a queued job after a lost response, then reuses its completed frame', async (t) => {
  const f = await fixture(t);
  await f.reach('frames');
  const shot = f.sequences.detail(f.sequence.id).shots[0];
  const job = f.generations.submit({ projectId: f.sequence.projectId, provider: 'mock', model: 'mock-image', prompt: 'Existing job', bookTarget: `shot-image:${shot.id}` });
  const before = f.repo.generations.listByProject(f.sequence.projectId).length;
  await f.controller().resume(f.film.id, 'one');
  assert.ok(f.c.status(f.film.id).jobIds.includes(job.id));
  assert.equal(f.repo.generations.listByProject(f.sequence.projectId).length, before);
  await f.settle();
  await f.controller().resume(f.film.id, 'one');
  assert.equal(f.repo.shots.get(shot.id).imageAssetId, f.repo.generations.get(job.id).assetId);
  assert.equal(f.repo.generations.listByProject(f.sequence.projectId).length, before);
});

test('unknown billing pauses and cannot be bypassed by unpause', async (t) => {
  const f = await fixture(t);
  await f.reach('frames');
  const shot = f.sequences.detail(f.sequence.id).shots[0];
  const job = f.repo.generations.create({ projectId: f.sequence.projectId, provider: 'mock', model: 'mock-image', operation: 'generate', prompt: 'Uncertain bill', bookTarget: `shot-image:${shot.id}` });
  f.repo.generations.update(job.id, { status: 'interrupted', billingState: 'billing_unknown', billing: 'unknown', providerJob: { id: 'paid-remote-id' } });
  await f.c.resume(f.film.id, 'one');
  assert.equal(f.c.status(f.film.id).state, 'paused');
  assert.match(f.c.status(f.film.id).reason, /billing/i);
  f.c.unpause(f.film.id);
  await f.step();
  assert.equal(f.c.status(f.film.id).state, 'paused');
  assert.equal(f.repo.generations.listByProject(f.sequence.projectId).length, 1);
  assert.ok(f.repo.filmEvents.list(f.film.id).some((e) => e.kind === 'job' && e.data.providerJob?.id === 'paid-remote-id'));
});

test('submitted in-flight work is adopted and paused until its billing resolves', async (t) => {
  const f = await fixture(t);
  await f.reach('frames');
  const shot = f.sequences.detail(f.sequence.id).shots[0];
  const job = f.repo.generations.create({ projectId: f.sequence.projectId, provider: 'mock', model: 'mock-image', operation: 'generate', prompt: 'Remote work', bookTarget: `shot-image:${shot.id}` });
  f.repo.generations.update(job.id, { status: 'running', billingState: 'submitted', providerJob: { id: 'remote' } });
  await f.controller().resume(f.film.id, 'one');
  assert.deepEqual(f.c.status(f.film.id).jobIds, [job.id]);
  assert.equal(f.c.status(f.film.id).state, 'paused');
  assert.equal(f.repo.generations.listByProject(f.sequence.projectId).length, 1);
});

test('approval gates persist across restarts and external decisions are journaled', async (t) => {
  const f = await fixture(t, { policy: { autoApproveFrames: false } });
  await f.reach('approve-frames');
  await f.step();
  assert.equal(f.c.status(f.film.id).requiresUserAction, true);
  const shot = f.sequences.detail(f.sequence.id).shots[0];
  f.sequences.approveFrame(shot.id);
  f.c.unpause(f.film.id);
  await f.controller().resume(f.film.id, 'one');
  assert.equal(f.c.status(f.film.id).stage, 'clips');
  assert.equal(f.repo.shots.get(shot.id).review.frameApproved, shot.imageAssetId);
  assert.ok(f.repo.filmEvents.list(f.film.id).some((e) => e.kind === 'approval' && e.data.assetId === shot.imageAssetId));
});

test('blocking findings pause without repairing or discarding completed takes', async (t) => {
  const f = await fixture(t);
  await f.reach('review');
  const shot = f.sequences.detail(f.sequence.id).shots[0];
  f.repo.shots.update(shot.id, { review: { ...shot.review, checks: [{ id: 'broken', ok: false, severity: 'error', detail: 'Bad picture' }] } });
  await f.step();
  assert.equal(f.c.status(f.film.id).state, 'paused');
  assert.equal(f.c.status(f.film.id).blockingFindings.length, 1);
  assert.equal(f.repo.shots.get(shot.id).videoAssetId, shot.videoAssetId);
  assert.ok(f.repo.filmEvents.list(f.film.id).some((e) => e.kind === 'finding'));
});

test('missing plan pauses; a supplied plan is imported by the existing service', async (t) => {
  const f = await fixture(t, { imported: false });
  await f.step();
  assert.equal(f.c.status(f.film.id).state, 'paused');
  assert.match(f.c.status(f.film.id).reason, /plan/i);
  const film = f.repo.films.get(f.film.id);
  f.repo.films.edit(f.film.id, { expectedRevision: film.revision, brief: { shots: f.plan }, at: new Date().toISOString() });
  f.c.unpause(f.film.id);
  await f.step();
  assert.equal(f.sequences.detail(f.sequence.id).shots.length, 1);
});

test('an exception after submission recovers by target without duplicating work', async (t) => {
  const f = await fixture(t);
  await f.reach('frames');
  const crashing = f.controller({ ...f.sequences, generateFrame(...args) { f.sequences.generateFrame(...args); throw Error('Lost response'); } });
  await f.step(crashing);
  await f.settle();
  f.c.unpause(f.film.id);
  await f.controller().resume(f.film.id, 'one');
  assert.equal(f.repo.generations.listByProject(f.sequence.projectId).length, 1);
  assert.ok(f.c.status(f.film.id).jobIds.length === 1);
});

test('a lost dialogue response adopts recordings instead of re-recording finished lines', async (t) => {
  const f = await fixture(t, { dialogue: true });
  await f.reach('voices');
  const crashing = f.controller({ ...f.sequences, makeDialogue(id) { f.sequences.makeDialogue(id); throw Error('Dialogue response lost'); } });
  await f.step(crashing);
  await f.settle();
  f.c.unpause(f.film.id);
  await f.controller().resume(f.film.id, 'one');
  await f.settle();
  assert.equal(f.repo.generations.listByProject(f.sequence.projectId).filter((g) => g.operation === 'speech').length, 1);
  assert.ok(f.sequences.detail(f.sequence.id).shots[0].details.dialogue[0].assetId);
});

test('a lease that expires during join cannot trigger a competing join or commit stale results', async (t) => {
  const f = await fixture(t);
  await f.reach('join');
  let finish, joins = 0;
  const waiting = new Promise((resolve) => { finish = resolve; });
  const slowService = { ...f.sequences, async stitch() { joins++; await waiting; } };
  const slow = f.controller(slowService);
  const work = f.step(slow);
  f.tick(60_001);
  const other = f.controller(slowService);
  assert.equal(other.acquire(f.film.id, 'two', 60_000), true);
  await other.resume(f.film.id, 'two');
  assert.equal(other.status(f.film.id).state, 'paused');
  assert.match(other.status(f.film.id).reason, /uncertain_action/);
  assert.equal(joins, 1);
  finish();
  await assert.rejects(work, (e) => e.status === 409);
});

test('a completed generation with a missing output pauses instead of paying for a replacement', async (t) => {
  const f = await fixture(t);
  await f.reach('frames');
  const shot = f.sequences.detail(f.sequence.id).shots[0];
  const job = f.repo.generations.create({ projectId: f.sequence.projectId, provider: 'mock', model: 'mock-image', operation: 'generate', prompt: 'Lost image', bookTarget: `shot-image:${shot.id}` });
  f.repo.generations.update(job.id, { status: 'completed', outputAssetId: 'missing-asset', billingState: 'charged', billing: 'charged' });
  await f.c.resume(f.film.id, 'one');
  assert.equal(f.c.status(f.film.id).state, 'paused');
  assert.match(f.c.status(f.film.id).reason, /missing_resources/);
  assert.equal(f.repo.generations.listByProject(f.sequence.projectId).length, 1);
});

test('billing stored in provider metadata pauses even when the legacy scalar says not submitted', async (t) => {
  const f = await fixture(t);
  await f.reach('frames');
  const shot = f.sequences.detail(f.sequence.id).shots[0];
  const job = f.repo.generations.create({ projectId: f.sequence.projectId, provider: 'mock', model: 'mock-image', operation: 'generate', prompt: 'Remote output lost', bookTarget: `shot-image:${shot.id}` });
  f.repo.generations.update(job.id, { status: 'failed', providerJob: { id: 'paid', billingState: 'download_failed' } });
  await f.c.resume(f.film.id, 'one');
  assert.match(f.c.status(f.film.id).reason, /billing_pending/);
});

test('a missing model can be fixed without abandoning the durable film', async (t) => {
  const f = await fixture(t);
  await f.reach('frames');
  f.sequences.update(f.sequence.id, { settings: { imageModel: '' } });
  await f.step();
  assert.equal(f.c.status(f.film.id).state, 'paused');
  f.sequences.update(f.sequence.id, { settings: { imageModel: 'mock-image' } });
  f.c.unpause(f.film.id);
  await f.c.resume(f.film.id, 'one');
  await f.settle();
  assert.equal(f.repo.generations.listByProject(f.sequence.projectId).length, 1);
});

test('closing and reopening the app retains stage, approvals, leases and all takes', async (t) => {
  let h = await startTestApp();
  t.after(() => h.close());
  const service = () => createSequenceService({ repo: h.app.repo, generations: h.app.generations,
    providers: createProviders({ enableMock: true }), log: quietLog,
    assetStore: createAssetStore({ repo: h.app.repo, assetDir: path.join(h.dataRoot, 'storage', 'assets') }) });
  let sequences = service(), time = Date.now();
  const make = () => createProductionController({ repo: h.app.repo, sequences, generations: h.app.generations, log: quietLog, now: () => time });
  const project = h.app.repo.projects.create('Real restart');
  const sequence = sequences.create({ projectId: project.id, title: 'Restart', settings: {
    imageProvider: 'mock', imageModel: 'mock-image', videoProvider: 'mock', videoModel: 'mock-video', requireApproval: true, colorMatch: 'off',
  } });
  sequences.importPlan(sequence.id, { shots: [{ description: 'A blue light', duration: 1 }] });
  let c = make();
  const film = c.open(sequence.id, { brief: {}, policy: { autoApproveFrames: true, autoAcceptClips: true } });
  c.acquire(film.id, 'before-restart', 1000);
  const step = (owner) => c.step(film.id, { owner, expectedRevision: c.status(film.id).filmRevision });
  for (let i = 0; i < 5 && c.status(film.id).stage !== 'clips'; i++) {
    await step('before-restart'); await h.app.jobs.idle(); await sequences.idle();
  }
  assert.equal(c.status(film.id).stage, 'clips');
  const shot = sequences.detail(sequence.id).shots[0];
  const oldJobIds = c.status(film.id).jobIds;
  const dataRoot = h.dataRoot;
  await h.close({ keep: true });
  h = await startTestApp({ dataRoot });
  sequences = service(); c = make();
  assert.equal(c.status(film.id).stage, 'clips');
  assert.equal(c.acquire(film.id, 'after-restart', 1000), false);
  time += 1001;
  assert.equal(c.acquire(film.id, 'after-restart', 60_000), true);
  assert.equal(h.app.repo.shots.get(shot.id).review.frameApproved, shot.imageAssetId);
  assert.deepEqual(c.status(film.id).jobIds, oldJobIds);
  for (let i = 0; i < 15 && c.status(film.id).state !== 'delivered'; i++) {
    await c.resume(film.id, 'after-restart'); await h.app.jobs.idle(); await sequences.idle();
  }
  assert.equal(c.status(film.id).state, 'delivered');
  assert.equal(h.app.repo.generations.listByProject(project.id).length, 2);
});

test('a reported local join failure can be retried using the same completed takes', async (t) => {
  const f = await fixture(t);
  await f.reach('join');
  const ids = f.c.status(f.film.id).jobIds;
  const broken = f.controller({ ...f.sequences, async stitch() { throw Error('ffmpeg missing'); } });
  await f.step(broken);
  assert.equal(f.c.status(f.film.id).state, 'paused');
  f.c.unpause(f.film.id);
  await f.controller().resume(f.film.id, 'one');
  assert.equal(f.c.status(f.film.id).stage, 'deliver');
  assert.deepEqual(f.c.status(f.film.id).jobIds, ids);
});

test('a simultaneous edit during checks prevents automatic clip approval', async (t) => {
  const f = await fixture(t);
  await f.reach('review');
  const shot = f.sequences.detail(f.sequence.id).shots[0];
  f.repo.shots.update(shot.id, { review: { status: 'pending' } });
  let finish;
  const checks = new Promise((resolve) => { finish = resolve; });
  const c = f.controller({ ...f.sequences, async runChecks() { await checks; } });
  const work = f.step(c);
  const old = f.repo.films.get(f.film.id);
  f.repo.films.edit(old.id, { expectedRevision: old.revision, policy: { autoAcceptClips: false }, at: new Date().toISOString() });
  finish();
  await assert.rejects(work, (e) => e.status === 409);
  assert.notEqual(f.repo.shots.get(shot.id).review.status, 'accepted');
});

test('an abandoned local join from a dead app process resumes without regenerating any takes', async (t) => {
  const f = await fixture(t);
  await f.reach('join');
  const ids = f.c.status(f.film.id).jobIds;
  const film = f.repo.films.get(f.film.id);
  f.repo.films.commit(film.id, { expectedRevision: film.revision }, [{ kind: 'checkpoint', data: {
    stage: 'join', phase: 'intent', action: 'join', actionId: 'orphaned-join', executorPid: 2147483647,
  } }]);
  await f.controller().resume(f.film.id, 'one');
  assert.equal(f.c.status(f.film.id).stage, 'deliver');
  assert.deepEqual(f.c.status(film.id).jobIds, ids);
});

test('delivery records actual duration so a restart cannot replace runtime validation with planned duration', async (t) => {
  const f = await fixture(t);
  await f.reach('deliver');
  const joined = f.repo.filmEvents.list(f.film.id).find((e) => e.kind === 'checkpoint' && e.data.action === 'join' && e.data.phase === 'settled');
  assert.equal(typeof joined?.data.duration, 'number');
  assert.ok(joined.data.duration > 0);
  assert.equal(joined.data.assetId, f.sequences.detail(f.sequence.id).sequence.outputAssetId);
});

test('runtime mismatch uses recorded delivery duration after restart and journals the finding', async (t) => {
  const f = await fixture(t, { brief: { targetSeconds: 99 } });
  await f.reach('deliver');
  const restarted = f.controller({ ...f.sequences, detail(id) {
    const detail = f.sequences.detail(id);
    return { ...detail, runningSeconds: 99, sequence: { ...detail.sequence, join: null } };
  } });
  await f.step(restarted);
  assert.equal(restarted.status(f.film.id).state, 'paused');
  assert.match(restarted.status(f.film.id).reason, /runtime/);
  assert.ok(f.repo.filmEvents.list(f.film.id).some((e) => e.kind === 'finding' && e.data.id === 'runtime'));
});

test('a manual pause stays in force while a submitted job is reconciled', async (t) => {
  const f = await fixture(t);
  await f.reach('frames');
  const shot = f.sequences.detail(f.sequence.id).shots[0];
  const job = f.repo.generations.create({ projectId: f.sequence.projectId, provider: 'mock', model: 'mock-image', operation: 'generate', prompt: 'Still running', bookTarget: `shot-image:${shot.id}` });
  f.repo.generations.update(job.id, { status: 'running', billingState: 'submitted', providerJob: { id: 'remote' } });
  f.c.pause(f.film.id, 'Wait for my decision');
  await f.c.resume(f.film.id, 'one');
  assert.equal(f.c.status(f.film.id).reason, 'manual: Wait for my decision');
});

test('pause and resume after delivery cannot deliver the same film twice', async (t) => {
  const f = await fixture(t);
  await f.reach('deliver'); await f.step();
  f.c.pause(f.film.id, 'Already finished');
  f.c.unpause(f.film.id);
  await f.c.resume(f.film.id, 'one');
  assert.equal(f.c.status(f.film.id).state, 'delivered');
  assert.equal(f.repo.filmEvents.list(f.film.id).filter((e) => e.kind === 'delivery').length, 1);
});

test('an interrupted plan import rolls back partial shots before recovery', async (t) => {
  const plan = [{ description: 'One', duration: 1 }, { description: 'Two', duration: 1 }];
  const f = await fixture(t, { imported: false, brief: { shots: plan } });
  const broken = f.controller({ ...f.sequences, importPlan(id, body) { f.sequences.importPlan(id, body); throw Error('Import interrupted'); } });
  await f.step(broken);
  assert.equal(f.sequences.detail(f.sequence.id).shots.length, 0);
  f.c.unpause(f.film.id);
  await f.controller().resume(f.film.id, 'one');
  assert.equal(f.sequences.detail(f.sequence.id).shots.length, 2);
  assert.equal(f.c.status(f.film.id).stage, 'frames');
});

test('a restarted app reusing the same PID can recover an old executor token', async (t) => {
  const f = await fixture(t);
  await f.reach('join');
  const film = f.repo.films.get(f.film.id);
  f.repo.films.commit(film.id, { expectedRevision: film.revision }, [{ kind: 'checkpoint', data: {
    stage: 'join', phase: 'intent', action: 'join', actionId: 'old-executor', executorPid: process.pid, executorToken: 'previous-process',
  } }]);
  await f.controller().resume(f.film.id, 'one');
  assert.equal(f.c.status(film.id).stage, 'deliver');
});

test('recovery respects a deliberate acting-style edit to a completed dialogue line', async (t) => {
  const f = await fixture(t, { dialogue: true });
  await f.reach('join');
  const shot = f.sequences.detail(f.sequence.id).shots[0];
  const originalAsset = shot.details.dialogue[0].assetId;
  f.sequences.updateShot(shot.id, { details: { dialogue: [{ ...shot.details.dialogue[0], style: 'Whisper softly' }] } });
  const film = f.repo.films.get(f.film.id);
  f.repo.films.edit(film.id, { expectedRevision: film.revision, brief: film.brief });
  await f.controller().resume(film.id, 'one');
  assert.equal(f.repo.shots.get(shot.id).details.dialogue[0].assetId, null);
  await f.reach('voices'); await f.step(); await f.settle();
  assert.match(f.c.status(film.id).reason, /existing_take/);
  assert.equal(f.repo.generations.listByTarget(`shot-line:${shot.id}:0`).length, 1);
  assert.ok(f.repo.assets.get(originalAsset));
});

test('a completed unselected still take is retained instead of rendering a replacement', async (t) => {
  const f = await fixture(t);
  const shot = f.sequences.detail(f.sequence.id).shots[0];
  f.sequences.updateShot(shot.id, { details: { method: 'still' } });
  await f.reach('clips');
  await f.sequences.renderStillShot(shot.id);
  const completed = f.repo.shots.get(shot.id).videoAssetId;
  f.repo.shots.update(shot.id, { videoAssetId: null });
  await f.step();
  assert.match(f.c.status(f.film.id).reason, /existing_take/);
  const videos = f.repo.assets.listByProject(f.sequence.projectId).filter((a) => a.mimeType === 'video/mp4');
  assert.deepEqual(videos.map((a) => a.id), [completed]);
});
