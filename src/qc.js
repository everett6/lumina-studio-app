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
