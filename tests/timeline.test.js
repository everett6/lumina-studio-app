import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTimeline, validateTimeline } from '../src/timeline.js';

const shot = (id, duration, extra = {}) => ({ id, duration, videoAssetId: `clip-${id}`, clipSeconds: duration, details: { method: 'video', dialogue: [] }, ...extra });
const blocks = (timeline, options) => validateTimeline(timeline, options).filter((f) => f.severity === 'blocking');

test('timeline uses integer frames and subtracts crossfade overlaps from runtime', () => {
  const timeline = buildTimeline([shot('a', 5), shot('b', 4), shot('c', 3)], { fps: 24, transition: 'crossfade', crossfadeSeconds: 0.5 });
  assert.deepEqual(timeline.shots.map((s) => [s.startFrame, s.endFrame, s.durationFrames]), [[0, 120, 120], [108, 204, 96], [192, 264, 72]]);
  assert.equal(timeline.totalFrames, 264);
  assert.equal(timeline.totalSeconds, 11);
});

test('timeline rounds each slot once and retains every planned shot', () => {
  const timeline = buildTimeline([shot('a', 0.11), shot('b', 0.11), shot('c', 0.11)], { fps: 24 });
  assert.deepEqual(timeline.shots.map((s) => [s.startFrame, s.endFrame]), [[0, 3], [3, 6], [6, 9]]);
  assert.equal(timeline.totalFrames, 9);
});

test('timeline separately accounts for video and intentional still slots', () => {
  const timeline = buildTimeline([shot('a', 5), shot('b', 3, { videoAssetId: null, imageAssetId: 'frame', details: { method: 'still' } })]);
  assert.equal(timeline.generatedMotionSeconds, 5);
  assert.equal(timeline.intentionalStillSeconds, 3);
  assert.equal(blocks(timeline).length, 0);
});

test('timeline traces runtime 112 seconds against 120 plus or minus 3', () => {
  const findings = validateTimeline(buildTimeline([shot('a', 112)]), { targetSeconds: 120, toleranceSeconds: 3 });
  const finding = findings.find((f) => f.rule === 'runtime');
  assert.equal(finding.severity, 'blocking');
  assert.equal(finding.kind, 'deterministic');
  assert.equal(finding.evidence.actualSeconds, 112);
  assert.equal(finding.evidence.minimumSeconds, 117);
  assert.equal(finding.shotId, null);
});

test('timeline does not omit missing, failed or rejected media', () => {
  const timeline = buildTimeline([shot('missing', 4, { videoAssetId: null }), shot('failed', 4, { status: 'failed' }), shot('rejected', 4, { review: { status: 'rejected' } })]);
  assert.equal(timeline.totalSeconds, 12);
  assert.deepEqual(blocks(timeline).filter((f) => f.rule === 'missing-media').map((f) => f.shotId), ['missing', 'failed', 'rejected']);
});

test('timeline matches lineTimes defaults and explicit line starts', () => {
  const timeline = buildTimeline([shot('speech', 8, { details: { method: 'video', dialogue: [
    { speaker: 'a', text: 'A', seconds: 1.5, assetId: 'a' },
    { speaker: 'b', text: 'B', seconds: 1, assetId: 'b' },
    { speaker: 'a', text: 'C', start: 5, seconds: 2, assetId: 'c' },
  ] } })], { fps: 24 });
  assert.deepEqual(timeline.shots[0].dialogue.map((l) => l.startSeconds), [0.4, 2.15, 5]);
  assert.equal(blocks(timeline).length, 0);
});

test('timeline traces missing recordings and a line longer than its shot', () => {
  const timeline = buildTimeline([shot('short', 2, { details: { method: 'video', dialogue: [
    { speaker: 'hero', text: 'Too long', start: 0, seconds: 3, assetId: 'voice' },
    { speaker: 'hero', text: 'Unrecorded', start: 0 },
  ] } })]);
  const findings = blocks(timeline);
  assert.ok(findings.some((f) => f.rule === 'dialogue-overrun' && f.shotId === 'short' && f.evidence.lineIndex === 0));
  assert.ok(findings.some((f) => f.rule === 'dialogue-recording' && f.evidence.lineIndex === 1));
  assert.equal(timeline.shots[0].dialogue[0].fits, false);
});

test('timeline places dialogue relative to overlapping shot starts', () => {
  const timeline = buildTimeline([shot('a', 5), shot('b', 5, { details: { method: 'video', dialogue: [{ text: 'B', start: 1, seconds: 1, assetId: 'voice' }] } })], { fps: 24, transition: 'crossfade', crossfadeSeconds: 0.5 });
  assert.equal(timeline.shots[1].dialogue[0].startFrame, 132);
  assert.equal(timeline.shots[1].dialogue[0].endFrame, 156);
});

test('timeline detects frozen padding after trim and requires a hold covering the tail', () => {
  const bad = shot('padding', 5, { clipSeconds: 5, details: { method: 'video', trimStart: 1, holds: [{ start: 0, seconds: 1 }] } });
  assert.ok(blocks(buildTimeline([bad])).some((f) => f.rule === 'frozen-padding'));
  bad.details.holds = [{ start: 4, seconds: 1 }];
  assert.equal(blocks(buildTimeline([bad])).length, 0);
  assert.equal(blocks(buildTimeline([shot('one-frame', 5, { clipSeconds: 5 - 1 / 24 })])).length, 0);
});

test('timeline unknown clip and audio lengths require review', () => {
  const timeline = buildTimeline([shot('unknown', 5, { clipSeconds: null, details: { method: 'video', dialogue: [{ text: 'Hello', assetId: 'voice' }] } })]);
  const findings = validateTimeline(timeline);
  assert.ok(findings.some((f) => f.rule === 'clip-duration' && f.kind === 'needs-review'));
  assert.ok(findings.some((f) => f.rule === 'dialogue-duration' && f.kind === 'needs-review'));
});

test('timeline rejects invalid fps and impossible crossfades', () => {
  assert.throws(() => buildTimeline([], { fps: 0 }), RangeError);
  assert.throws(() => buildTimeline([shot('a', 1), shot('b', 1)], { transition: 'crossfade', crossfadeSeconds: 2 }), RangeError);
  assert.throws(() => buildTimeline([], { transition: 'magic' }), RangeError);
});

test('timeline clean plan is repeatable, pure, and within inclusive runtime tolerance', () => {
  const shots = [shot('a', 60), shot('b', 57)];
  const before = structuredClone(shots);
  const timeline = buildTimeline(shots);
  assert.equal(blocks(timeline, { targetSeconds: 120, toleranceSeconds: 3 }).length, 0);
  assert.deepEqual(timeline, buildTimeline(shots));
  assert.deepEqual(shots, before);
});

test('timeline catches fractional shortfalls greater than one frame', () => {
  assert.ok(blocks(buildTimeline([shot('shortfall', 5, { clipSeconds: 4.94 })], { fps: 24 })).some((f) => f.rule === 'frozen-padding'));
});

test('timeline unknown line length propagates until an explicit start resets timing', () => {
  const timeline = buildTimeline([shot('speech', 10, { details: { method: 'video', dialogue: [
    { text: 'Unknown', assetId: 'a' },
    { text: 'Follows unknown', assetId: 'b', seconds: 1 },
    { text: 'Reset', assetId: 'c', seconds: 1, start: 5 },
    { text: 'Follows known', assetId: 'd', seconds: 1 },
  ] } })]);
  assert.deepEqual(timeline.shots[0].dialogue.map((line) => line.fits), [null, null, true, true]);
  assert.deepEqual(timeline.shots[0].dialogue.map((line) => line.startSeconds), [0.4, 0.65, 5, 6.25]);
});
