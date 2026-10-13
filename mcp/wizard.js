// The film wizard's decision logic: given a storyboard detail (GET /api/storyboards/:id), work out the single
// next stage and the exact MCP tool calls an orchestrator can offer the user. Pure: it never calls anything.

const busy = (job) => Boolean(job) && ['queued', 'running'].includes(job.status);
const lines = (shot) => shot.details?.dialogue ?? [];
const FIX_CHECK = 'dialogue-fit';

export function shotFacts(shot) {
  const d = shot.details ?? {};
  const spoken = lines(shot);
  const lineSeconds = spoken.reduce((sum, l) => sum + (l.seconds ?? 0), 0);
  const failedChecks = (shot.review?.checks ?? []).filter((c) => !c.ok);
  return {
    id: shot.id, position: shot.position, method: d.method ?? 'video', duration: shot.duration ?? 0,
    hasFrame: Boolean(shot.imageAssetId), hasClip: Boolean(shot.videoAssetId),
    frameBusy: busy(shot.frameJob), clipBusy: busy(shot.clipJob),
    frameApproved: Boolean(shot.imageAssetId) && shot.review?.frameApproved === shot.imageAssetId,
    review: shot.review?.status ?? 'pending',
    linesTotal: spoken.length, linesRecorded: spoken.filter((l) => l.assetId).length,
    overrun: failedChecks.some((c) => c.id === FIX_CHECK) || (lineSeconds > 0 && lineSeconds > (shot.duration ?? 0) + 0.05),
    neededSeconds: Math.ceil(lineSeconds + 0.5), failedChecks: failedChecks.map((c) => c.detail),
  };
}

const call = (label, tool, args = {}) => ({ label, tool, arguments: args });
const list = (facts) => facts.map((f) => f.position).join(', ');

export function nextStep(detail, estimate = null) {
  const { sequence, shots } = detail;
  const requireApproval = Boolean(sequence.settings?.requireApproval);
  const storyboardId = sequence.id;
  const facts = shots.map(shotFacts);
  const withClip = facts.filter((f) => f.hasClip);
  const progress = {
    shots: facts.length, framesDone: facts.filter((f) => f.hasFrame).length, clipsDone: withClip.length,
    accepted: facts.filter((f) => f.review === 'accepted').length,
    linesRecorded: facts.reduce((n, f) => n + f.linesRecorded, 0), linesTotal: facts.reduce((n, f) => n + f.linesTotal, 0),
  };
  const cost = estimate && typeof estimate.totalUsd === 'number' ? ` Estimated cost of everything still missing: $${estimate.totalUsd.toFixed(2)}.` : '';
  const result = (stage, summary, decide, choices, preview = null) => ({ stage, summary, progress, decide, choices, preview });
  const sheet = (kind, ids) => (ids.length > 1 ? { sheet: kind, shotIds: ids } : { sheet: null, shotIds: ids });
  const look = call('Look at the storyboard first', 'preview_storyboard', { storyboardId, kind: 'frames' });

  if (!facts.length) {
    return result('plan', 'The storyboard has no shots yet.',
      'How should the shots be planned: by the writer model (small cost, refused under a strict budget), or by you writing the shot list here for me to import?',
      [call('Have the writer model plan the shots', 'plan_storyboard', { storyboardId }),
        call('Import a shot list written in this chat (free)', 'import_shot_plan', { storyboardId, shots: [{ description: '<what we see>', duration: 5 }] })]);
  }

  const noFrame = facts.filter((f) => !f.hasFrame && !f.frameBusy);
  if (noFrame.length) {
    return result('frames', `${noFrame.length} of ${facts.length} shots have no frame yet (shots ${list(noFrame)}).`,
      `Make the still frames for shots ${list(noFrame)} now? Frames are images (the cheapest step) and let you check the look before any video is paid for.${cost}`,
      [call('Make all missing frames', 'generate_storyboard_shots', { storyboardId, kind: 'frames' }),
        call('Make just the first one to check the look', 'generate_shot', { shotId: noFrame[0].id, kind: 'frame' })]);
  }

  const framesBusy = facts.filter((f) => f.frameBusy);
  if (framesBusy.length) {
    return result('working', `${framesBusy.length} frame job(s) are still running (shots ${list(framesBusy)}).`,
      'Frames are being made. Wait and check progress?', [call('Watch progress', 'watch_jobs', { projectId: sequence.projectId, waitSeconds: 30 })]);
  }

  const toApprove = requireApproval ? facts.filter((f) => !f.frameApproved) : [];
  if (toApprove.length) {
    const first = toApprove[0];
    return result('approve_frames', `${toApprove.length} frame(s) await your approval (shots ${list(toApprove)}). Video is not paid for until they are approved.`,
      `Do the frames look right? Approve shot ${first.position}'s frame (repeat for the others), or ask for a redo.`,
      [call(`Approve shot ${first.position}'s frame`, 'review_shot', { shotId: first.id, approveFrame: true }),
        call(`Redo shot ${first.position}'s frame`, 'generate_shot', { shotId: first.id, kind: 'frame' }),
        ...toApprove.slice(1, 3).map((f) => call(`Approve shot ${f.position}'s frame`, 'review_shot', { shotId: f.id, approveFrame: true }))],
      sheet('frames', toApprove.map((f) => f.id)));
  }

  const stills = facts.filter((f) => f.method === 'still' && !f.hasClip);
  if (stills.length) {
    return result('animate', `${stills.length} still shot(s) have no clip (shots ${list(stills)}). Still shots are rendered locally for free.`,
      `Render the free still-shot moves for shots ${list(stills)}?`, stills.slice(0, 3).map((f) => call(`Render still shot ${f.position}`, 'render_still_shot', { shotId: f.id })),
      sheet('frames', stills.map((f) => f.id)));
  }

  const noClip = facts.filter((f) => f.method !== 'still' && !f.hasClip && !f.clipBusy);
  if (noClip.length) {
    return result('animate', `${noClip.length} video shot(s) have no clip yet (shots ${list(noClip)}).`,
      `Animate shots ${list(noClip)} now? Video clips are slow and are the expensive step.${cost}`,
      [call('Animate all missing clips', 'generate_storyboard_shots', { storyboardId, kind: 'clips' }),
        call('Animate just the first one to check', 'generate_shot', { shotId: noClip[0].id, kind: 'clip' }),
        call('See the price first', 'estimate_film_cost', { storyboardId })],
      sheet('frames', noClip.map((f) => f.id)));
  }

  const clipsBusy = facts.filter((f) => f.clipBusy);
  if (clipsBusy.length) {
    return result('working', `${clipsBusy.length} clip job(s) are still running (shots ${list(clipsBusy)}).`,
      'Clips are being made. Wait and check progress?', [call('Watch progress', 'watch_jobs', { projectId: sequence.projectId, waitSeconds: 30 })]);
  }

  const toReview = facts.filter((f) => f.hasClip && (f.review !== 'accepted' && (requireApproval || f.review !== 'pending')));
  if (toReview.length) {
    const first = toReview[0];
    const problems = first.failedChecks.length ? ` Automatic checks flagged: ${first.failedChecks.join('; ')}.` : '';
    return result('review', `${toReview.length} clip(s) need a decision (shots ${list(toReview)}).`,
      `Look at shot ${first.position}'s clip: keep it, or make another take?${problems}`,
      [call(`Accept shot ${first.position}`, 'review_shot', { shotId: first.id, status: 'accepted' }),
        call(`Make another take of shot ${first.position}`, 'generate_shot', { shotId: first.id, kind: 'clip' }),
        call('See the clip in detail', 'preview_shot', { shotId: first.id })],
      sheet('clips', toReview.map((f) => f.id)));
  }

  const unvoiced = facts.filter((f) => f.linesRecorded < f.linesTotal);
  if (unvoiced.length) {
    const first = unvoiced[0];
    return result('voices', `${progress.linesTotal - progress.linesRecorded} dialogue line(s) are not recorded yet (shots ${list(unvoiced)}).`,
      `Record the dialogue for shot ${first.position}? Speech costs a little per line. Characters without a saved voice use the narrator voice or are reported.`,
      [call(`Record shot ${first.position}'s dialogue`, 'voice_dialogue', { shotId: first.id }),
        ...unvoiced.slice(1, 3).map((f) => call(`Record shot ${f.position}'s dialogue`, 'voice_dialogue', { shotId: f.id }))],
      sheet('frames', unvoiced.map((f) => f.id)));
  }

  const overrun = facts.filter((f) => f.overrun);
  const missingThemes = sequence.themeCoverage?.missing ?? [];
  if (overrun.length || missingThemes.length) {
    const first = overrun[0];
    const parts = [overrun.length ? `dialogue runs past the end of shot(s) ${list(overrun)}` : '', missingThemes.length ? `themes with no shot: ${missingThemes.join(', ')}` : ''].filter(Boolean);
    return result('fix', `Fix before joining: ${parts.join('; ')}.`,
      first ? `Shot ${first.position}'s speech is longer than the shot. Make the shot longer, or shorten the line?` : `Theme(s) ${missingThemes.join(', ')} appear in no shot. Tag a shot with it or accept the gap?`,
      [...(first ? [call(`Lengthen shot ${first.position} to ${Math.min(30, Math.max(first.duration + 1, first.neededSeconds))} s`, 'update_shot', { shotId: first.id, duration: Math.min(30, Math.max(first.duration + 1, first.neededSeconds)) }),
        call(`Look at shot ${first.position}`, 'preview_shot', { shotId: first.id })] : []),
      call('Review the whole storyboard', 'get_storyboard', { storyboardId })],
      first ? { sheet: null, shotIds: [first.id] } : null);
  }

  if (sequence.outputAssetId) {
    return result('done', 'The film is joined and saved in the project library.',
      'The film is finished. Enhance it (sharper / larger), or look it over first?',
      [call('Enhance the film (fast upscale)', 'enhance_video', { assetId: sequence.outputAssetId, mode: 'fast' }),
        call('Look at the clips once more', 'preview_storyboard', { storyboardId, kind: 'clips' }),
        call('Look over the joined film', 'inspect_video', { assetId: sequence.outputAssetId })]);
  }

  return result('join', 'Every shot has its frame, clip and dialogue, and nothing is waiting on you.',
    'Join the clips into the finished film now? It runs locally and costs nothing.',
    [call('Join the film', 'join_storyboard', { storyboardId }), look]);
}
