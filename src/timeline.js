import { lineTimes } from './soundtrack.js';

const list = (value) => Array.isArray(value) ? value : [];
const seconds = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const frames = (value, fps) => Math.round(value * fps);
const invalidStatuses = new Set(['missing', 'failed', 'rejected', 'needs_regeneration', 'interrupted', 'queued', 'running']);

/** Build a frame ledger, retaining empty/failed slots. End frames are exclusive. */
export function buildTimeline(shots = [], { fps = 24, transition = 'cut', crossfadeSeconds = 0.5 } = {}) {
  if (!Number.isFinite(fps) || fps <= 0) throw new RangeError('fps must be finite and positive');
  if (!['cut', 'crossfade'].includes(transition)) throw new RangeError('transition must be cut or crossfade');
  if (seconds(crossfadeSeconds) == null) throw new RangeError('crossfadeSeconds must be finite and nonnegative');
  if (!Array.isArray(shots)) throw new TypeError('shots must be an array');
  const overlapFrames = transition === 'crossfade' ? frames(crossfadeSeconds, fps) : 0;
  if (!Number.isSafeInteger(overlapFrames)) throw new RangeError('Crossfade exceeds the safe frame range');
  const durations = shots.map((shot) => {
    const duration = seconds(shot?.duration);
    const count = duration == null ? 0 : frames(duration, fps);
    if (!Number.isSafeInteger(count)) throw new RangeError('Shot exceeds the safe frame range');
    return count;
  });
  if (overlapFrames && shots.length > 1) durations.forEach((duration, index) => {
    const incoming = index > 0 ? overlapFrames : 0;
    const outgoing = index < shots.length - 1 ? overlapFrames : 0;
    if (duration <= Math.max(incoming, outgoing) || incoming + outgoing > duration) {
      throw new RangeError('Crossfades must fit their neighboring slots without triple overlaps');
    }
  });
  let cursor = 0;
  let generatedMotionFrames = 0;
  let intentionalStillFrames = 0;
  const entries = shots.map((value, index) => {
    const shot = value ?? {};
    const details = shot.details ?? {};
    const method = details.method ?? 'video';
    const durationFrames = durations[index];
    const startFrame = cursor - (index > 0 ? overlapFrames : 0);
    const endFrame = startFrame + durationFrames;
    if (!Number.isSafeInteger(endFrame)) throw new RangeError('Timeline exceeds the safe frame range');
    cursor = endFrame;
    if (method === 'video') generatedMotionFrames += durationFrames;
    if (method === 'still') intentionalStillFrames += durationFrames;
    const clip = shot.clip ?? {};
    const assetId = shot.videoAssetId ?? clip.assetId ?? null;
    const imageAssetId = shot.imageAssetId ?? null;
    const statuses = [shot.status, shot.mediaStatus, clip.status, shot.review?.status].filter((v) => typeof v === 'string');
    const mediaAvailable = Boolean(method === 'still' ? (assetId || imageAssetId) : assetId) && !statuses.some((s) => invalidStatuses.has(s));
    const clipSeconds = seconds(shot.clipSeconds ?? clip.seconds);
    const trimStartSeconds = seconds(details.trimStart) ?? 0;
    const availableFrames = clipSeconds == null ? null : Math.floor(Math.max(0, clipSeconds - trimStartSeconds) * fps + 1e-9);
    const holds = list(details.holds).filter((hold) => seconds(hold?.start) != null && seconds(hold?.seconds) > 0)
      .map((hold) => ({ startFrame: frames(hold.start, fps), endFrame: frames(hold.start + hold.seconds, fps) }))
      .sort((a, b) => a.startFrame - b.startFrame);
    const lines = list(details.dialogue ?? shot.dialogue);
    const lengths = lines.map((line) => seconds(line?.seconds));
    const { times } = lineTimes(lines.map((line) => line ?? {}), durationFrames / fps, lengths);
    let uncertainCursor = false;
    const dialogue = lines.map((line, lineIndex) => {
      line ??= {};
      const timingKnown = Number.isFinite(line.start) || !uncertainCursor;
      const startSeconds = times[lineIndex];
      const length = lengths[lineIndex];
      const endSeconds = length == null ? null : startSeconds + length;
      uncertainCursor = !timingKnown || length == null;
      return {
        lineIndex, speaker: line.speaker ?? null, text: typeof line.text === 'string' ? line.text : '',
        assetId: line.assetId ?? null, recorded: Boolean(line.assetId) && !invalidStatuses.has(line.status),
        seconds: length, startSeconds, endSeconds, timingKnown,
        startFrame: startFrame + frames(startSeconds, fps),
        endFrame: endSeconds == null ? null : startFrame + Math.ceil(endSeconds * fps - 1e-9),
        fits: endSeconds == null || !timingKnown ? null : startSeconds >= 0 && endSeconds <= durationFrames / fps + 1e-9,
      };
    });
    return {
      shotId: shot.id ?? null, position: shot.position ?? index + 1,
      previousShotId: shots[index - 1]?.id ?? null,
      startFrame, endFrame, durationFrames, durationSeconds: durationFrames / fps,
      requestedSeconds: seconds(shot.duration), method,
      overlapInFrames: index > 0 ? overlapFrames : 0,
      overlapOutFrames: index < shots.length - 1 ? overlapFrames : 0,
      mediaAvailable, assetId, imageAssetId, statuses, clipSeconds, trimStartSeconds, availableFrames,
      holds, dialogue,
    };
  });
  return {
    fps, transition, crossfadeFrames: overlapFrames,
    shots: entries, totalFrames: cursor, totalSeconds: cursor / fps,
    generatedMotionFrames, generatedMotionSeconds: generatedMotionFrames / fps,
    intentionalStillFrames, intentionalStillSeconds: intentionalStillFrames / fps,
  };
}

/** Validate a buildTimeline result without probing assets or estimating recording lengths. */
export function validateTimeline(timeline, { targetSeconds, toleranceSeconds = 0 } = {}) {
  if (!timeline || !Array.isArray(timeline.shots) || !Number.isFinite(timeline.fps) || timeline.fps <= 0) {
    throw new TypeError('Expected a buildTimeline result');
  }
  if (seconds(toleranceSeconds) == null || (targetSeconds !== undefined && seconds(targetSeconds) == null)) {
    throw new RangeError('Runtime target and tolerance must be finite and nonnegative');
  }
  const findings = [];
  const add = (shot, rule, message, evidence, review = false) => findings.push({
    id: `timeline:${findings.length + 1}:${rule}`, severity: review ? 'warning' : 'blocking',
    kind: review ? 'needs-review' : 'deterministic', shotId: shot?.shotId ?? null,
    previousShotId: shot?.previousShotId ?? null, rule, message, evidence,
  });
  if (targetSeconds !== undefined && (timeline.totalSeconds < targetSeconds - toleranceSeconds - 1e-9 || timeline.totalSeconds > targetSeconds + toleranceSeconds + 1e-9)) {
    add(null, 'runtime', 'Timeline runtime is outside the target tolerance.', {
      actualSeconds: timeline.totalSeconds, targetSeconds, toleranceSeconds,
      minimumSeconds: targetSeconds - toleranceSeconds, maximumSeconds: targetSeconds + toleranceSeconds,
      totalFrames: timeline.totalFrames, fps: timeline.fps,
    });
  }
  for (const shot of timeline.shots) {
    if (shot.requestedSeconds == null || shot.durationFrames <= 0) add(shot, 'shot-duration', 'Shot needs a positive frame-representable duration.', { requestedSeconds: shot.requestedSeconds, durationFrames: shot.durationFrames });
    if (!['video', 'still'].includes(shot.method)) add(shot, 'shot-method', 'Unknown shot method.', { method: shot.method });
    if (!shot.mediaAvailable) add(shot, 'missing-media', 'Planned shot has no usable media; its slot is retained.', { assetId: shot.assetId, imageAssetId: shot.imageAssetId, statuses: [...shot.statuses], startFrame: shot.startFrame, endFrame: shot.endFrame });
    if (shot.method === 'video' && shot.mediaAvailable) {
      if (shot.availableFrames == null) add(shot, 'clip-duration', 'Supply the measured selected clip length to check frozen padding.', { clipSeconds: null }, true);
      else if (shot.durationFrames - shot.availableFrames > 1) {
        // Holds declare frozen slots, rather than extending the clip (exposureFilter semantics).
        let coveredUntil = shot.availableFrames;
        for (const hold of shot.holds) {
          if (hold.startFrame <= coveredUntil && hold.endFrame > coveredUntil) coveredUntil = hold.endFrame;
        }
        if (coveredUntil < shot.durationFrames) add(shot, 'frozen-padding', 'Video is shorter than its slot by more than a frame without holds covering its frozen tail.', {
          availableFrames: shot.availableFrames, durationFrames: shot.durationFrames,
          paddingFrames: shot.durationFrames - shot.availableFrames, uncoveredFromFrame: coveredUntil,
        });
      }
    }
    for (const line of shot.dialogue) {
      if (!line.text.trim()) continue;
      const evidence = { lineIndex: line.lineIndex, speaker: line.speaker, assetId: line.assetId, startSeconds: line.startSeconds, seconds: line.seconds, shotSeconds: shot.durationSeconds };
      if (!line.recorded) add(shot, 'dialogue-recording', 'Dialogue line has no usable recording.', evidence);
      if (line.seconds == null || !line.timingKnown) add(shot, 'dialogue-duration', 'Dialogue fit needs measured audio lengths and known preceding timings.', evidence, true);
      if (line.startSeconds < 0) add(shot, 'dialogue-start', 'Dialogue starts before its shot.', evidence);
      if (line.fits === false && line.startSeconds >= 0) add(shot, 'dialogue-overrun', 'Dialogue runs past its shot end.', { ...evidence, endSeconds: line.endSeconds, overrunSeconds: line.endSeconds - shot.durationSeconds });
    }
  }
  return findings;
}
