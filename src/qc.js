import { probe, runCapture } from './video.js';

// Free technical checks on a shot's clip, all done with ffmpeg on this computer (no paid vision models):
// length against the plan, a picture at all, long black stretches, frozen picture, and missing sound when the
// shot is meant to have it. They catch broken renders, not bad acting or a wrong face: a person (or the
// orchestrator) still accepts each shot. Each check: { id, ok, severity: 'error' | 'warning', detail }.
export async function checkClip(file, { expectedSeconds = null, expectAudio = false, still = false } = {}) {
  const checks = [];
  let info;
  try {
    info = await probe(file);
  } catch (error) {
    return [{ id: 'readable', ok: false, severity: 'error', detail: `The clip can't be read: ${error.message}` }];
  }
  checks.push({ id: 'readable', ok: true, severity: 'error', detail: `${info.width}×${info.height}, ${info.duration.toFixed(1)} s, ${Math.round(info.fps)} fps` });
  if (expectedSeconds) {
    const short = info.duration < expectedSeconds - 0.5;
    checks.push({
      id: 'length', ok: !short, severity: 'warning',
      detail: short ? `${info.duration.toFixed(1)} s, ${(expectedSeconds - info.duration).toFixed(1)} s shorter than planned; the last frame will be held to fill the shot.`
        : `${info.duration.toFixed(1)} s for a ${expectedSeconds} s shot`,
    });
  }
  let log = '';
  try {
    log = (await runCapture('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vf', 'blackdetect=d=0.5:pix_th=0.10,freezedetect=n=-60dB:d=2', '-an', '-f', 'null', '-'], 300_000)).stderr;
  } catch (error) {
    checks.push({ id: 'decode', ok: false, severity: 'error', detail: `The picture could not be decoded all the way through: ${error.message}` });
  }
  const blackTotal = [...log.matchAll(/black_duration:([\d.]+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
  const blackShare = info.duration ? blackTotal / info.duration : 0;
  checks.push({
    id: 'black', ok: blackShare < 0.3, severity: blackShare > 0.8 ? 'error' : 'warning',
    detail: blackTotal ? `${blackTotal.toFixed(1)} s of black picture` : 'No long black stretches',
  });
  if (!still) {
    const frozen = [...log.matchAll(/freeze_duration: ([\d.]+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    const share = info.duration ? frozen / info.duration : 0;
    checks.push({ id: 'motion', ok: share < 0.5, severity: 'warning', detail: frozen ? `Picture frozen for ${frozen.toFixed(1)} s` : 'Picture moves' });
  }
  if (expectAudio) checks.push({ id: 'sound', ok: info.hasAudio, severity: 'warning', detail: info.hasAudio ? 'Has sound' : 'No sound track (the model made a silent clip)' });
  return checks;
}

// The review status the checks suggest. Only a person (or the orchestrator) can mark a shot accepted.
export function suggestedStatus(checks) {
  if (checks.some((c) => !c.ok && c.severity === 'error')) return 'needs_regeneration';
  return 'needs_review';
}

// Drift checks, also free: does the clip really start on its approved frame (and end on the next shot's frame in
// keyframe mode)? Both pictures are shrunk to a 32×18 colour thumbnail and compared pixel by pixel (mean absolute
// difference, 0–255). A clip that honours its start frame is nearly identical to it there; a model that ignored
// or wandered off its reference differs a lot. A large colour shift between a clip's first and last frame is
// flagged too. These warn rather than fail: the person looking at the shot decides.
const thumbnail = async (file, { atEnd = false } = {}) => {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-v', 'error', ...(atEnd ? ['-sseof', '-0.2'] : []), '-i', file, '-frames:v', '1', '-vf', 'scale=32:18:flags=area,format=rgb24', '-f', 'rawvideo', '-'],
      { encoding: 'buffer', maxBuffer: 1 << 20, timeout: 120_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
};
async function similarity(clip, image, { atEnd = false } = {}) {
  const [a, b] = [await thumbnail(clip, { atEnd }), await thumbnail(image)];
  if (!a.length || a.length !== b.length) return null;
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

async function averageColour(clip, { atEnd = false } = {}) {
  const pick = atEnd ? ['-sseof', '-0.2'] : [];
  const { stderr } = await runCapture('ffmpeg', ['-hide_banner', '-nostats', ...pick, '-i', clip, '-vf', 'scale=128:72,signalstats,metadata=print', '-frames:v', '1', '-f', 'null', '-'], 120_000);
  const read = (key) => Number(new RegExp(`signalstats\\.${key}=([\\d.]+)`).exec(stderr)?.[1]);
  return { y: read('YAVG'), u: read('UAVG'), v: read('VAVG') };
}

export async function driftChecks(clip, { startFrame = null, endFrame = null } = {}) {
  const checks = [];
  try {
    if (startFrame) {
      const score = await similarity(clip, startFrame);
      if (score != null) {
        checks.push({ id: 'start-frame', ok: score <= 30, severity: 'warning', score,
          detail: score <= 30 ? `Starts on the approved frame (difference ${score.toFixed(0)}/255)` : `Does not start on the approved frame (difference ${score.toFixed(0)}/255): the model may have drifted from the reference` });
      }
    }
    if (endFrame) {
      const score = await similarity(clip, endFrame, { atEnd: true });
      if (score != null) {
        checks.push({ id: 'end-frame', ok: score <= 30, severity: 'warning', score,
          detail: score <= 30 ? `Ends on the next shot's frame (difference ${score.toFixed(0)}/255)` : `Does not end on the next shot's frame (difference ${score.toFixed(0)}/255)` });
      }
    }
    const [first, last] = [await averageColour(clip), await averageColour(clip, { atEnd: true })];
    if ([first.u, first.v, last.u, last.v].every(Number.isFinite)) {
      const shift = Math.hypot(first.u - last.u, first.v - last.v);
      checks.push({ id: 'colour', ok: shift < 12, severity: 'warning', score: shift,
        detail: shift < 12 ? 'Colours stay steady through the clip' : `Colours shift noticeably during the clip (by ${shift.toFixed(0)}): lighting or wardrobe may have drifted` });
    }
  } catch (error) {
    checks.push({ id: 'drift', ok: true, severity: 'warning', detail: `Drift checks could not run: ${error.message}` });
  }
  return checks;
}
