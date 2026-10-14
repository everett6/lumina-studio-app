import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { nextStep } from '../mcp/wizard.js';
import { startTestApp } from './helpers.js';

const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../mcp/server.js');
const parse = (result) => JSON.parse(result.content.find((c) => c.type === 'text').text);

// ---------- nextStep: pure decision logic ----------
const shot = (n, extra = {}) => ({
  id: `s${n}`, position: n, description: `Shot ${n}`, duration: 5, imageAssetId: null, videoAssetId: null, imagePath: null, videoPath: null,
  review: { status: 'pending', checks: [] }, frameJob: null, clipJob: null, details: { method: 'video', dialogue: [], themes: [] }, ...extra,
});
const withFrame = (n, extra = {}) => shot(n, { imageAssetId: `f${n}`, imagePath: `/assets/f${n}.png`, ...extra });
const withClip = (n, extra = {}) => withFrame(n, { videoAssetId: `v${n}`, videoPath: `/assets/v${n}.mp4`, ...extra });
const board = (shots, settings = {}, sequence = {}) => ({ sequence: { id: 'b1', projectId: 'p1', settings, themeCoverage: { where: {}, missing: [] }, outputAssetId: null, ...sequence }, shots });
const line = (extra = {}) => ({ speaker: 'narrator', text: 'Hello.', assetId: null, seconds: null, ...extra });

test('nextStep walks the stages in order', () => {
  const stage = (detail, estimate) => nextStep(detail, estimate).stage;
  assert.equal(stage(board([])), 'plan');
  assert.deepEqual(nextStep(board([])).choices.map((c) => c.tool), ['plan_storyboard', 'import_shot_plan']);

  const frames = nextStep(board([shot(1), withFrame(2)]), { totalUsd: 1.5 });
  assert.equal(frames.stage, 'frames');
  assert.equal(frames.choices[0].tool, 'generate_storyboard_shots');
  assert.deepEqual(frames.choices[0].arguments, { storyboardId: 'b1', kind: 'frames' });
  assert.match(frames.decide, /\$1\.50/);
  assert.equal(frames.progress.framesDone, 1);

  assert.equal(stage(board([withFrame(1, { frameJob: { status: 'running' } }), withFrame(2)])), 'working'); // a re-running frame job is waited for, not duplicated
  assert.equal(stage(board([shot(1, { frameJob: { status: 'running' } })])), 'working');

  const approve = nextStep(board([withFrame(1), withFrame(2, { review: { status: 'pending', checks: [], frameApproved: 'f2' } })], { requireApproval: true }));
  assert.equal(approve.stage, 'approve_frames');
  assert.deepEqual(approve.choices[0], { label: "Approve shot 1's frame", tool: 'review_shot', arguments: { shotId: 's1', approveFrame: true } });

  const stills = nextStep(board([withFrame(1, { details: { method: 'still', dialogue: [] } })]));
  assert.equal(stills.stage, 'animate');
  assert.equal(stills.choices[0].tool, 'render_still_shot');

  const animate = nextStep(board([withFrame(1), withFrame(2)]));
  assert.equal(animate.stage, 'animate');
  assert.equal(animate.choices[0].tool, 'generate_storyboard_shots');
  assert.equal(animate.choices[0].arguments.kind, 'clips');
  assert.equal(animate.preview.sheet, 'frames');

  assert.equal(stage(board([withFrame(1, { clipJob: { status: 'queued' } })])), 'working');

  const review = nextStep(board([withClip(1, { review: { status: 'pending', checks: [], frameApproved: 'f1' } }), withClip(2, { review: { status: 'accepted', checks: [], frameApproved: 'f2' } })], { requireApproval: true }));
  assert.equal(review.stage, 'review');
  assert.equal(review.choices[0].tool, 'review_shot');
  assert.deepEqual(review.preview, { sheet: null, shotIds: ['s1'] });
  // Without requireApproval a pending clip is fine, but a rejected one still needs a decision.
  assert.equal(stage(board([withClip(1)])), 'join');
  assert.equal(stage(board([withClip(1, { review: { status: 'rejected', checks: [] } })])), 'review');

  const accepted = { status: 'accepted', checks: [] };
  const voices = nextStep(board([withClip(1, { review: accepted, details: { method: 'video', dialogue: [line(), line({ assetId: 'a1', seconds: 1 })] } })]));
  assert.equal(voices.stage, 'voices');
  assert.deepEqual(voices.choices[0].arguments, { shotId: 's1' });
  assert.deepEqual([voices.progress.linesRecorded, voices.progress.linesTotal], [1, 2]);

  const overrun = nextStep(board([withClip(1, { duration: 3, review: accepted, details: { method: 'video', dialogue: [line({ assetId: 'a', seconds: 4.2 })] } })]));
  assert.equal(overrun.stage, 'fix');
  assert.equal(overrun.choices[0].tool, 'update_shot');
  assert.equal(overrun.choices[0].arguments.duration, 5);
  const themes = nextStep(board([withClip(1, { review: accepted })], {}, { themeCoverage: { where: {}, missing: ['Chaos'] } }));
  assert.equal(themes.stage, 'fix');
  assert.match(themes.summary, /Chaos/);

  const ready = nextStep(board([withClip(1, { review: accepted })]));
  assert.equal(ready.stage, 'join');
  assert.deepEqual(ready.choices[0], { label: 'Join the film', tool: 'join_storyboard', arguments: { storyboardId: 'b1' } });
  assert.equal(ready.progress.accepted, 1);

  const done = nextStep(board([withClip(1, { review: accepted })], {}, { outputAssetId: 'out' }));
  assert.equal(done.stage, 'done');
  assert.ok(done.choices.some((c) => c.tool === 'enhance_video'));
});

test('nextStep: stale join, theme-only gaps and the 30 s cap', () => {
  const accepted = { status: 'accepted', checks: [], frameApproved: 'f1' };
  const stale = nextStep(board([withClip(1, { review: accepted })], {}, { outputAssetId: 'out', joinStale: true }));
  assert.equal(stale.stage, 'join');
  assert.match(stale.summary, /re-join to apply your edits/);
  assert.equal(stale.choices[0].tool, 'join_storyboard');
  assert.equal(nextStep(board([withClip(1, { review: accepted })], {}, { outputAssetId: 'out', joinStale: false })).stage, 'done');

  const themes = nextStep(board([withClip(1, { review: accepted })], {}, { themeCoverage: { where: {}, missing: ['Chaos'] } }));
  assert.deepEqual(themes.choices[0], { label: 'Join anyway', tool: 'join_storyboard', arguments: { storyboardId: 'b1' } });

  const capped = nextStep(board([withClip(1, { duration: 30, review: accepted, details: { method: 'video', dialogue: [line({ assetId: 'a', seconds: 33 })] } })]));
  assert.equal(capped.stage, 'fix');
  assert.ok(!capped.choices.some((c) => c.tool === 'update_shot' && c.arguments.duration));
  const shorten = capped.choices.find((c) => c.tool === 'update_shot');
  assert.ok(shorten.arguments.details.dialogue.length === 1 && shorten.arguments.details.dialogue[0].text);
  assert.match(capped.decide, /split/);
});

// ---------- end to end over MCP ----------
async function withApp(run) {
  const t = await startTestApp();
  const client = new Client({ name: 'lumina-interactive-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, LUMINA_DATA_DIR: t.dataRoot }, stderr: 'ignore' }));
  try {
    await run({ t, client, tool: (name, args = {}) => client.callTool({ name, arguments: args }) });
  } finally {
    await client.close();
    await t.close();
  }
}

async function makeFilm(tool, { requireApproval = false } = {}) {
  const project = parse(await tool('create_project', { name: 'Interactive' }));
  const created = parse(await tool('create_storyboard', {
    projectId: project.id, title: 'Wizard', idea: 'A fox crosses a lake.', shotCount: 3, writer: 'mock:mock-director',
    narratorVoice: { provider: 'mock', model: 'mock-voice', voice: 'tone-low' }, requireApproval,
  }));
  return { project, board: created };
}

test('MCP interactive tools are registered with read-only hints', async () => {
  await withApp(async ({ client }) => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((x) => [x.name, x]));
    for (const name of ['preview_shot', 'preview_storyboard', 'film_next_step', 'watch_jobs', 'cancel_job', 'film_checklist', 'adjust_shot_look', 'move_shot', 'trim_shot', 'set_character_voice', 'plan_storyboard']) {
      assert.ok(byName[name], `missing ${name}`);
    }
    for (const name of ['preview_shot', 'preview_storyboard', 'film_next_step', 'watch_jobs', 'film_checklist']) assert.equal(byName[name].annotations?.readOnlyHint, true, name);
    assert.notEqual(byName.cancel_job.annotations?.readOnlyHint, true);
  });
});

test('film_next_step advances as its choices are followed', async () => {
  await withApp(async ({ t, tool }) => {
    const { board: created } = await makeFilm(tool);
    const id = created.id;
    const checklist = parse(await tool('film_checklist', { storyboardId: id }));
    assert.equal(checklist.shotsTotal, 3);
    assert.equal(checklist.shotsFinished, 0);

    const stages = [];
    for (let i = 0; i < 6; i++) {
      const result = await tool('film_next_step', { storyboardId: id });
      assert.equal(result.isError, undefined, result.content[0].text);
      const step = parse(result);
      stages.push(step.stage);
      if (['join', 'done'].includes(step.stage)) break;
      const choice = step.choices[0];
      assert.ok(choice.tool && choice.arguments, 'choice is an exact tool call');
      if (step.stage === 'frames') {
        await tool(choice.tool, choice.arguments);
        // Frames run in the background; wait for them.
        for (let wait = 0; wait < 50; wait++) {
          const d = (await t.call('GET', `/api/storyboards/${id}`)).body;
          if (d.shots.every((s) => s.imageAssetId)) break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      } else if (step.stage === 'animate' && choice.tool === 'generate_storyboard_shots') {
        await tool(choice.tool, choice.arguments);
        for (let wait = 0; wait < 80; wait++) {
          const d = (await t.call('GET', `/api/storyboards/${id}`)).body;
          if (d.shots.every((s) => s.videoAssetId || s.details.method === 'still')) break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      } else {
        const result2 = await tool(choice.tool, choice.arguments);
        assert.equal(result2.isError, undefined, `${choice.tool}: ${result2.content[0].text}`);
      }
    }
    assert.equal(stages[0], 'frames');
    assert.ok(stages.length >= 2 && stages[1] !== 'frames', `stages advanced: ${stages.join(' > ')}`);
  });
});

test('preview_shot returns text, frame, contact sheet and dialogue audio', async () => {
  await withApp(async ({ t, tool }) => {
    const { board: created } = await makeFilm(tool);
    const [first] = created.shots;
    await tool('update_shot', { shotId: first.id, details: { method: 'video', dialogue: [{ speaker: 'narrator', text: 'The lake wakes.' }] } });
    parse(await tool('generate_shot', { shotId: first.id, kind: 'frame' }));
    await tool('generate_shot', { shotId: first.id, kind: 'clip' });
    const voiced = parse(await tool('voice_dialogue', { shotId: first.id }));
    assert.equal(voiced.queued, 1);
    for (let wait = 0; wait < 50; wait++) {
      const d = (await t.call('GET', `/api/storyboards/${created.id}`)).body;
      if (d.shots[0].details.dialogue[0].audioPath) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const result = await tool('preview_shot', { shotId: first.id });
    assert.equal(result.isError, undefined, result.content[0].text);
    const summary = parse(result);
    assert.equal(summary.dialogue[0].recorded, true);
    const images = result.content.filter((c) => c.type === 'image');
    const audio = result.content.filter((c) => c.type === 'audio');
    assert.ok(images.length >= 1, 'frame image');
    assert.equal(audio.length, 1);
    assert.match(audio[0].mimeType, /^audio\//);
    assert.ok(Buffer.from(audio[0].data, 'base64').length > 100);
    assert.equal(images.length, 2, 'frame + clip contact sheet');
    assert.equal(images[1].mimeType, 'image/jpeg');
  });
});

test('preview_storyboard and watch_jobs use the new routes', async () => {
  await withApp(async ({ t, tool }) => {
    const { project, board: created } = await makeFilm(tool);
    await tool('generate_shot', { shotId: created.shots[0].id, kind: 'frame' });
    const preview = await tool('preview_storyboard', { storyboardId: created.id, kind: 'frames' });
    assert.equal(preview.isError, undefined);
    assert.equal(parse(preview).shots.length, 3);
    assert.ok(preview.content.some((c) => c.type === 'image' && c.mimeType === 'image/jpeg'), 'storyboard contact sheet');
    const watched = await tool('watch_jobs', { projectId: project.id, waitSeconds: 0 });
    assert.equal(watched.isError, undefined, watched.content[0].text);
    assert.equal(typeof parse(watched).active, 'number');
    const started = Date.now();
    const waited = parse(await tool('watch_jobs', { projectId: project.id, waitSeconds: 2 }));
    assert.equal(waited.active, 0);
    assert.ok(Date.now() - started < 8000);
  });
});

test('cancel_job reports a finished job as not cancellable', async () => {
  await withApp(async ({ t, tool }) => {
    const { board: created } = await makeFilm(tool);
    const generated = parse(await tool('generate_shot', { shotId: created.shots[0].id, kind: 'frame' }));
    await t.call('POST', `/api/generations/${generated.id}/wait`, { timeoutMs: 20_000 });
    const result = await tool('cancel_job', { generationId: generated.id });
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.equal(parse(result).cancelled, false);
  });
});

test('edit-by-chat: adjust_shot_look merges, move_shot reorders, trim_shot trims', async () => {
  await withApp(async ({ t, tool }) => {
    const { board: created } = await makeFilm(tool);
    const [a, b, c] = created.shots;

    // Colour grade: merge, then reset (needs the details.grade support in the API).
    const first = await tool('adjust_shot_look', { shotId: a.id, brightness: -0.1 });
    assert.equal(first.isError, undefined, first.content[0].text);
    const stored = (await t.call('GET', `/api/storyboards/${created.id}`)).body.shots[0].details.grade;
    assert.deepEqual(stored, { brightness: -0.1 });
    const second = parse(await tool('adjust_shot_look', { shotId: a.id, saturation: 0.8, contrast: 1.1 }));
    assert.deepEqual(second.grade, { brightness: -0.1, contrast: 1.1, saturation: 0.8 }); // neutral values are dropped
    parse(await tool('adjust_shot_look', { shotId: a.id, reset: true }));
    assert.equal((await t.call('GET', `/api/storyboards/${created.id}`)).body.shots[0].details.grade, null);
    assert.ok((await tool('adjust_shot_look', { shotId: a.id })).isError, 'needs a value');

    const moved = parse(await tool('move_shot', { shotId: c.id, toPosition: 1 }));
    assert.equal(moved.movedTo, 1);
    assert.deepEqual(moved.order.map((s) => s.id), [c.id, a.id, b.id]);
    assert.deepEqual(parse(await tool('move_shot', { shotId: c.id, toPosition: 99 })).order.map((s) => s.id), [a.id, b.id, c.id]);

    const trimmed = parse(await tool('trim_shot', { shotId: b.id, trimStart: 1.5, duration: 7 }));
    assert.equal(trimmed.duration, 7);
    assert.equal(trimmed.trimStart, 1.5);
    assert.ok((await tool('trim_shot', { shotId: b.id })).isError);
  });
});

test('set_character_voice changes the voice and records unrecorded lines only with revoice', async () => {
  await withApp(async ({ t, tool }) => {
    const { project, board: created } = await makeFilm(tool);
    const pip = parse(await tool('create_character', { name: 'Pip', description: 'small red fox' }));
    const [first, second] = created.shots;
    await tool('update_shot', { shotId: first.id, details: { dialogue: [{ speaker: pip.id, text: 'Hello lake.' }] } });
    await tool('update_shot', { shotId: second.id, details: { dialogue: [{ speaker: pip.id, text: 'Goodbye lake.' }] } });

    const plain = parse(await tool('set_character_voice', { characterId: pip.id, provider: 'mock', model: 'mock-voice', voice: 'tone-low' }));
    assert.equal(plain.voice.voice, 'tone-low');
    assert.equal(plain.queued, 0);

    await tool('voice_dialogue', { shotId: first.id });
    for (let wait = 0; wait < 50; wait++) {
      const d = (await t.call('GET', `/api/storyboards/${created.id}`)).body;
      if (d.shots[0].details.dialogue[0].assetId) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const revoiced = parse(await tool('set_character_voice', { characterId: pip.id, provider: 'mock', model: 'mock-voice', voice: 'tone-high', revoice: true }));
    assert.equal(revoiced.voice.voice, 'tone-high');
    assert.equal(revoiced.queued, 1, 'only the unrecorded line is queued');
    assert.equal(revoiced.keptOldVoice.length, 1);
    assert.equal(revoiced.keptOldVoice[0].shotId, first.id);
    assert.match(revoiced.note, /voice_dialogue/);
    assert.ok(project.id);
  });
});


test('update_storyboard turns lip sync on after creation and keeps other settings', async () => {
  await withApp(async ({ t, tool }) => {
    const { board: created } = await makeFilm(tool);
    const before = (await tool('get_storyboard', { storyboardId: created.id }));
    assert.equal(before.isError, undefined);
    const updated = await tool('update_storyboard', { storyboardId: created.id, title: 'Renamed', settings: { lipSync: true, look: 'anime' } });
    assert.equal(updated.isError, undefined, updated.content[0].text);
    const summary = parse(updated);
    assert.equal(summary.title ?? summary.sequence?.title, 'Renamed');
    assert.equal(summary.shots.length, 3, 'shots kept');
    const stored = (await t.call('GET', `/api/storyboards/${created.id}`)).body.sequence.settings;
    assert.equal(stored.lipSync, true);
    assert.equal(stored.look, 'anime');
  });
});
