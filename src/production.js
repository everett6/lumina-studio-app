import { randomUUID } from 'node:crypto';
import { billingState } from './budget.js';

const stages = ['plan', 'frames', 'approve-frames', 'clips', 'review', 'voices', 'join', 'deliver'];
const active = (g) => ['queued', 'running'].includes(g.status);
const conflict = (message) => Object.assign(new Error(message), { status: 409, code: 'conflict' });
const missing = (message) => Object.assign(new Error(message), { status: 404 });
const executorToken = randomUUID();
const liveActions = new Set();
const executorMayBeAlive = (intent) => {
  if (intent.executorPid === process.pid) return intent.executorToken === executorToken && liveActions.has(intent.actionId);
  if (!Number.isInteger(intent.executorPid) || intent.executorPid <= 0) return true;
  try { process.kill(intent.executorPid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
};

// Durable orchestration only. The sequence service owns prompts, takes, checks and rendering.
export function createProductionController({ repo, sequences, generations, log = console, now = Date.now }) {
  const at = () => new Date(now()).toISOString();
  const need = (id) => repo.films.get(id) ?? (() => { throw missing('Film not found.'); })();
  const events = (id) => repo.filmEvents.list(id);
  const stageOf = (film) => stages.includes(film.state) ? film.state
    : events(film.id).filter((e) => e.kind === 'checkpoint' && stages.includes(e.data.stage)).at(-1)?.data.stage ?? 'plan';
  const commit = (film, fields, entries, owner = null) => {
    const result = repo.films.commit(film.id, { expectedRevision: film.revision, owner, at: at(), ...fields }, entries);
    if (!result) throw conflict('Film revision or lease changed; reload before advancing.');
    return result;
  };
  const fenced = (film, owner, expectedRevision) => {
    if (film.revision !== expectedRevision) throw conflict('Stale film revision; an edit or transition happened elsewhere.');
    if (!owner || film.leaseOwner !== owner || film.leaseExpiresAt <= at()) throw conflict('Acquire the film lease before advancing.');
  };
  const stop = (film, reason, owner = null) => {
    if (film.state === 'delivered') return film;
    if (film.state === 'paused' && film.pauseReason?.startsWith('manual:') && !reason.startsWith('manual:')) return film;
    if (film.state === 'paused' && film.pauseReason === reason) return film;
    return commit(film, { state: 'paused', pauseReason: reason }, [
      { kind: 'checkpoint', data: { stage: stageOf(film), phase: 'paused' } },
      { kind: 'pause', data: { reason } },
    ], owner);
  };
  const targetsOf = (detail) => detail.shots.flatMap((s) => [
    `shot-image:${s.id}`, `shot-video:${s.id}`, ...(s.details.dialogue ?? []).map((_, i) => `shot-line:${s.id}:${i}`),
  ]);
  const pendingActions = (journal) => journal.filter((e) => e.kind === 'checkpoint' && e.data.phase === 'intent'
    && !journal.some((done) => done.kind === 'checkpoint' && done.data.actionId === e.data.actionId && done.data.phase === 'settled'));
  const liveFindings = (detail) => detail.shots.flatMap((s) => {
    const checks = (s.review.checks ?? []).filter((c) => !c.ok).map((c) => ({
      ...c, id: `${s.id}:${c.id}`, checkId: c.id, shotId: s.id, assetId: s.videoAssetId,
      source: 'sequence', blocking: c.severity === 'error' || c.blocking === true, resolved: false,
    }));
    if (['rejected', 'needs_repair', 'needs_regeneration'].includes(s.review.status) && !checks.some((c) => c.blocking)) {
      checks.push({ id: `${s.id}:review`, shotId: s.id, assetId: s.videoAssetId, source: 'sequence', blocking: true,
        resolved: false, detail: `Shot ${s.position}: ${s.review.status}` });
    }
    return checks;
  });
  const externalFindings = (journal) => {
    const latest = new Map();
    for (const e of journal.filter((e) => e.kind === 'finding' && e.data.source !== 'sequence')) latest.set(e.data.id, e.data);
    return [...latest.values()].filter((f) => f.blocking && !f.resolved);
  };
  function snapshotJobs(film, detail, journal) {
    const ids = new Set(journal.filter((e) => e.kind === 'job' && e.data.jobId).map((e) => e.data.jobId));
    // Discover even jobs whose response/event was lost. Targets are written in the generation transaction.
    for (const target of targetsOf(detail)) for (const g of repo.generations.listByTarget(target)) ids.add(g.id);
    return [...ids].map((id) => repo.generations.get(id) ?? { id, missing: true });
  }
  function observations(detail, jobs, journal) {
    const entries = [];
    for (const g of jobs) {
      if (g.missing) continue;
      const data = { jobId: g.id, target: g.bookTarget, provider: g.provider, model: g.model, status: g.status,
        billing: g.billing, billingState: billingState(g), providerJob: g.providerJob, idempotencyKey: g.idempotencyKey };
      const previous = journal.filter((e) => e.kind === 'job' && e.data.jobId === g.id).at(-1)?.data;
      if (JSON.stringify(data) !== JSON.stringify(previous)) entries.push({ kind: 'job', data });
    }
    for (const s of detail.shots) {
      for (const [scope, value] of [['frame', s.review.frameApproved ?? null], ['clip',
        s.review.status === 'accepted' ? s.videoAssetId : null]]) {
        const previous = journal.filter((e) => e.kind === 'approval' && e.data.scope === scope && e.data.shotId === s.id).at(-1)?.data;
        if ((value || previous) && (previous?.assetId !== value)) entries.push({ kind: 'approval', data: {
          scope, shotId: s.id, assetId: value, approved: Boolean(value), source: 'sequence',
        } });
      }
    }
    const findings = liveFindings(detail);
    const prior = new Map();
    for (const e of journal.filter((e) => e.kind === 'finding' && e.data.source === 'sequence')) prior.set(e.data.id, e.data);
    for (const finding of findings) {
      if (JSON.stringify(prior.get(finding.id)) !== JSON.stringify(finding)) entries.push({ kind: 'finding', data: finding });
      prior.delete(finding.id);
    }
    for (const old of prior.values()) if (!old.resolved) entries.push({ kind: 'finding', data: { ...old, resolved: true } });
    return entries;
  }
  // Replaying a completion callback onto an attached take would revoke its approval. Only hydrate missing slots.
  function hydrate(detail, jobs) {
    for (const s of detail.shots) {
      const attach = (target, present, matches = () => true) => {
        if (present) return;
        const g = jobs.filter((g) => g.bookTarget === target && g.status === 'completed' && g.assetId && matches(g))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (g && repo.assets.get(g.assetId)) sequences.onGenerationUpdate(g);
      };
      attach(`shot-image:${s.id}`, s.imageAssetId);
      attach(`shot-video:${s.id}`, s.videoAssetId);
      (s.details.dialogue ?? []).forEach((line, i) => {
        const voice = repo.characters.get(line.speaker)?.voice ?? detail.sequence.settings.narratorVoice;
        attach(`shot-line:${s.id}:${i}`, line.assetId, (g) => voice && g.prompt === line.text
          && g.provider === voice.provider && g.model === voice.model
          && (!voice.voice || g.params?.voice === voice.voice)
          && (g.params?.style ?? '') === (line.style ?? ''));
      });
    }
  }
  function reconcile(film, owner) {
    let detail;
    try { detail = sequences.detail(film.sequenceId); }
    catch (error) { return { film: stop(film, `missing_resources: ${error.message}`, owner), detail: null, jobs: [] }; }
    let journal = events(film.id);
    const jobs = snapshotJobs(film, detail, journal);
    if (detail.sequence.production?.state === 'running') {
      const entries = observations(detail, jobs, journal);
      if (entries.length) film = commit(film, {}, entries, owner);
      return { film: stop(film, 'external_production: Stop the legacy producer before using the controller.', owner), detail, jobs };
    }
    hydrate(detail, jobs);
    detail = sequences.detail(film.sequenceId);
    const entries = observations(detail, jobs, journal);
    // A recovered intent can be settled only by durable evidence of its result.
    let abandonedLocal = false;
    for (const intent of pendingActions(journal)) {
      const data = intent.data;
      const stopped = !executorMayBeAlive(data);
      const proven = data.action === 'import-plan' ? detail.shots.length > 0
        : data.action === 'join' ? Boolean(detail.sequence.outputAssetId && !detail.sequence.joinStale)
          : data.action === 'still' ? Boolean(detail.shots.find((s) => s.id === data.shotId)?.videoAssetId)
            : ['frames', 'clips', 'voices'].includes(data.action) && (stopped
              || data.targets?.every((target) => jobs.some((g) => g.bookTarget === target)));
      const abandoned = stopped && ['join', 'still', 'import-plan'].includes(data.action) && !proven;
      if (abandoned) abandonedLocal = true;
      if (proven || abandoned) entries.push({ kind: 'checkpoint', data: {
        stage: data.stage, phase: 'settled', action: data.action, actionId: data.actionId, recovered: true, abandoned,
      } });
    }
    if (entries.length) film = commit(film, {}, entries, owner);
    journal = events(film.id);
    const lost = jobs.find((g) => g.missing);
    const uncertain = jobs.find((g) => !g.missing && (g.billing === 'unknown' || billingState(g) === 'billing_unknown'));
    const submitted = jobs.find((g) => !g.missing && ['submitted', 'completed_remote', 'download_failed'].includes(billingState(g)) && g.status !== 'completed');
    const lostOutput = jobs.find((g) => g.status === 'completed' && (!g.assetId || !repo.assets.get(g.assetId)));
    let reason = lost ? `missing_resources: Generation ${lost.id} is missing.`
      : uncertain ? `billing_unknown: Resolve billing for generation ${uncertain.id} before spending again.`
        : submitted ? `billing_pending: Adopted submitted generation ${submitted.id}; wait for its result.`
          : lostOutput ? `missing_resources: Completed generation ${lostOutput.id} has no available output; restore its asset.` : null;
    if (!reason) {
      const unresolved = pendingActions(journal)[0];
      if (unresolved) reason = `uncertain_action: Reconcile ${unresolved.data.action} (${unresolved.data.actionId}) before trying again.`;
    }
    if (!reason) {
      const missingAssets = detail.shots.flatMap((s) => [s.imageAssetId, s.videoAssetId, ...(s.details.dialogue ?? []).map((l) => l.assetId)])
        .concat(detail.sequence.outputAssetId).filter((id) => id && !repo.assets.get(id));
      if (missingAssets.length) reason = `missing_resources: Asset ${missingAssets[0]} is missing; restore it or select an existing take.`;
    }
    if (!reason && [...liveFindings(detail), ...externalFindings(journal)].some((f) => f.blocking)) reason = 'blocking_findings: Resolve the blocking findings before continuing.';
    if (reason) film = stop(film, reason, owner);
    else if (film.state === 'paused' && (film.pauseReason?.startsWith('billing_pending:')
      || (abandonedLocal && film.pauseReason?.startsWith('uncertain_action:')))) {
      film = commit(film, { state: stageOf(film), pauseReason: null }, [{ kind: 'resume', data: { reconciled: true } }], owner);
    }
    return { film, detail, jobs };
  }
  function status(id) {
    const film = need(id), journal = events(id);
    let detail = null;
    try { detail = sequences.detail(film.sequenceId); } catch { /* status still works if resources disappeared */ }
    const blockingFindings = [...(detail ? liveFindings(detail).filter((f) => f.blocking) : []), ...externalFindings(journal)];
    const pendingBilling = film.pauseReason?.startsWith('billing_pending:');
    return { state: film.state, filmRevision: film.revision, stage: stageOf(film), reason: film.pauseReason ?? null,
      blockingFindings, allowedActions: film.state === 'delivered' ? [] : film.state === 'paused' ? ['resume', 'unpause'] : ['step', 'pause'],
      requiresUserAction: film.state === 'paused' && !pendingBilling,
      retryable: film.state !== 'delivered' && (film.state !== 'paused' || Boolean(pendingBilling)),
      jobIds: [...new Set(journal.filter((e) => e.kind === 'job' && e.data.jobId).map((e) => e.data.jobId))] };
  }
  const next = (film, owner) => {
    const stage = stages[stages.indexOf(stageOf(film)) + 1];
    return commit(film, { state: stage, pauseReason: null }, [{ kind: 'checkpoint', data: { stage, phase: 'ready' } }], owner);
  };
  async function action(film, owner, data, run) {
    const actionId = randomUUID();
    film = commit(film, {}, [{ kind: 'checkpoint', data: {
      ...data, stage: stageOf(film), actionId, phase: 'intent', executorPid: process.pid, executorToken,
    } }], owner);
    liveActions.add(actionId);
    try {
      // The intent is committed before entering a service that can submit paid work.
      const result = await run();
      const current = need(film.id);
      fenced(current, owner, film.revision);
      const detail = sequences.detail(film.sequenceId);
      const journal = events(film.id), jobs = snapshotJobs(film, detail, journal);
      return commit(current, {}, [...observations(detail, jobs, journal), {
        kind: 'checkpoint', data: { stage: stageOf(film), action: data.action, actionId, phase: 'settled',
          ...(data.action === 'join' ? { assetId: detail.sequence.outputAssetId, duration: result?.duration ?? null } : {}),
        },
      }], owner);
    } catch (error) {
      if (error.code === 'conflict') throw error;
      const current = need(film.id);
      fenced(current, owner, film.revision);
      log.error?.('Film stage paused', { filmId: film.id, action: data.action, error: error.message });
      // A returned rejection proves this invocation stopped. A crash leaves the intent open.
      film = commit(current, {}, [{ kind: 'checkpoint', data: {
        stage: stageOf(film), actionId, phase: 'settled', error: error.message,
      } }], owner);
      const result = reconcile(film, owner);
      if (result.film.state === 'paused') return result.film;
      return stop(result.film, `stage_failed: ${error.message}`, owner);
    } finally {
      liveActions.delete(actionId);
    }
  }
  async function step(id, { owner, expectedRevision } = {}) {
    let film = need(id);
    fenced(film, owner, expectedRevision);
    if (film.state === 'delivered') return status(id);
    // Claim this invocation synchronously, before any await, including another call by the same owner.
    film = commit(film, {}, [{ kind: 'checkpoint', data: { stage: stageOf(film), phase: 'step' } }], owner);
    let { film: reconciled, detail, jobs } = reconcile(film, owner);
    film = reconciled;
    if (!detail || ['paused', 'delivered'].includes(film.state)) return status(id);
    if (detail.sequence.production?.state === 'running') return status(stop(film, 'external_production: Stop the legacy producer before using the controller.', owner).id);
    if (jobs.some(active)) return status(id);
    const stage = stageOf(film), shots = detail.shots;
    try {
      if (stage === 'plan') {
        if (!shots.length) {
          if (!Array.isArray(film.brief.shots) || !film.brief.shots.length) stop(film, 'missing_plan: Import a shot plan or supply brief.shots; paid writer planning needs a durable hook.', owner);
          else {
            film = await action(film, owner, { action: 'import-plan' }, () => repo.transaction(
              () => sequences.importPlan(film.sequenceId, { shots: film.brief.shots }),
            ));
            if (film.state !== 'paused') next(film, owner);
          }
        } else next(film, owner);
      } else if (stage === 'frames' || stage === 'clips' || stage === 'voices') {
        const wanted = stage === 'frames' ? shots.find((s) => !s.imageAssetId && !s.videoAssetId)
          : stage === 'clips' ? shots.find((s) => !s.videoAssetId)
            : shots.find((s) => (s.details.dialogue ?? []).some((l) => !l.assetId));
        if (!wanted) next(film, owner);
        else {
          const targets = stage === 'frames' ? [`shot-image:${wanted.id}`] : stage === 'clips' ? [`shot-video:${wanted.id}`]
            : wanted.details.dialogue.flatMap((l, i) => l.assetId ? [] : [`shot-line:${wanted.id}:${i}`]);
          const previous = jobs.find((g) => targets.includes(g.bookTarget) && ['failed', 'interrupted', 'cancelled'].includes(g.status));
          if (previous) stop(film, `failed_job: Generation ${previous.id} needs an explicit retry decision; completed takes are preserved.`, owner);
          else if (stage === 'voices' && jobs.some((g) => targets.includes(g.bookTarget) && g.status === 'completed')) {
            stop(film, 'existing_take: A completed recording differs from the requested line or voice. Select a take or explicitly re-record through the sequence service.', owner);
          }
          else if (stage === 'voices' && wanted.details.dialogue.some((line) => !line.assetId
            && !(repo.characters.get(line.speaker)?.voice ?? detail.sequence.settings.narratorVoice))) {
            stop(film, 'missing_resources: Configure every missing dialogue voice before recording.', owner);
          } else if (stage === 'clips' && detail.sequence.settings.continuity === 'chain') {
            stop(film, 'missing_resources: Chain continuity needs a durable last-frame extraction hook.', owner);
          } else if (stage === 'clips' && wanted.details.method === 'still'
            && sequences.takes(wanted.id).clips.some((take) => take.source === 'still')) {
            stop(film, 'existing_take: Select the completed still take before rendering another one.', owner);
          } else {
            const key = `film:${film.id}:${stage}:${wanted.id}`;
            const still = stage === 'clips' && wanted.details.method === 'still';
            await action(film, owner, { action: still ? 'still' : stage, shotId: wanted.id, targets: still ? [] : targets, idempotencyKey: stage === 'voices' ? null : key }, () => {
              if (stage === 'frames') return sequences.generateFrame(wanted.id, { idempotencyKey: key });
              if (stage === 'clips') return still ? sequences.renderStillShot(wanted.id) : sequences.animate(wanted.id, { idempotencyKey: key });
              return sequences.makeDialogue(wanted.id);
            });
          }
        }
      } else if (stage === 'approve-frames') {
        const waiting = shots.filter((s) => !s.videoAssetId && s.review.frameApproved !== s.imageAssetId);
        if (waiting.length && film.policy.autoApproveFrames !== true) stop(film, 'approval_required: Approve the current frames.', owner);
        else {
          for (const shot of waiting) sequences.approveFrame(shot.id, true);
          const updated = sequences.detail(film.sequenceId);
          film = commit(film, {}, observations(updated, jobs, events(id)), owner);
          next(film, owner);
        }
      } else if (stage === 'review') {
        for (const shot of shots) if (shot.review.assetId !== shot.videoAssetId || !shot.review.checks) await sequences.runChecks(shot.id);
        fenced(need(id), owner, film.revision);
        ({ film, detail } = reconcile(need(id), owner));
        if (film.state !== 'paused') {
          const waiting = detail.shots.filter((s) => s.review.status !== 'accepted');
          if (waiting.length && film.policy.autoAcceptClips !== true) stop(film, 'approval_required: Review and accept the clips.', owner);
          else {
            for (const shot of waiting) sequences.review(shot.id, { status: 'accepted', notes: 'Accepted under the film policy.' });
            film = commit(film, {}, observations(sequences.detail(film.sequenceId), jobs, events(id)), owner);
            next(film, owner);
          }
        }
      } else if (stage === 'join') {
        if (!detail.sequence.outputAssetId || detail.sequence.joinStale) {
          film = await action(film, owner, { action: 'join' }, () => sequences.stitch(film.sequenceId, { wait: true }));
        }
        if (film.state !== 'paused') next(film, owner);
      } else if (stage === 'deliver') {
        const outputId = detail.sequence.outputAssetId;
        const measured = events(id).filter((e) => e.kind === 'checkpoint' && e.data.action === 'join'
          && e.data.phase === 'settled' && e.data.assetId === outputId && Number.isFinite(e.data.duration)).at(-1)?.data.duration;
        const duration = detail.sequence.join?.duration ?? measured ?? null;
        if (!detail.sequence.outputAssetId || detail.sequence.joinStale) stop(film, 'missing_resources: The joined film is missing or stale; edit the film to restart from its reusable takes.', owner);
        else if (film.brief.acceptanceCriteria?.length && film.policy.acceptanceCriteriaApproved !== true) stop(film, 'approval_required: Confirm the brief acceptance criteria with policy.acceptanceCriteriaApproved.', owner);
        else if (film.brief.targetSeconds && (duration === null || Math.abs(duration - film.brief.targetSeconds) > (film.policy.runtimeToleranceSeconds ?? 1))) {
          const reason = duration === null ? 'The finished runtime is unverified; obtain delivery metadata.' : 'The film does not meet the brief targetSeconds.';
          film = commit(film, {}, [{ kind: 'finding', data: { id: 'runtime', source: 'brief', blocking: true,
            resolved: false, assetId: outputId, targetSeconds: film.brief.targetSeconds, actualSeconds: duration, detail: reason,
          } }], owner);
          stop(film, `blocking_runtime: ${reason}`, owner);
        } else commit(film, { state: 'delivered', pauseReason: null }, [
          ...(film.brief.acceptanceCriteria?.length ? [{ kind: 'approval', data: { scope: 'brief',
            approved: true, acceptanceCriteria: film.brief.acceptanceCriteria, source: 'policy',
          } }] : []),
          { kind: 'delivery', data: {
            assetId: detail.sequence.outputAssetId, path: detail.sequence.outputPath, runningSeconds: duration,
            brief: film.brief,
          } }], owner);
      }
    } catch (error) {
      if (error.code === 'conflict') throw error;
      const current = need(id);
      fenced(current, owner, film.revision);
      stop(current, `stage_failed: ${error.message}`, owner);
    }
    return status(id);
  }
  function acquire(id, owner, ttlMs = 30_000) {
    need(id);
    if (typeof owner !== 'string' || !owner.trim()) throw new TypeError('A nonempty lease owner is required.');
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be a positive safe integer.');
    return repo.films.acquire(id, owner, ttlMs, at());
  }
  return {
    open(sequenceId, { brief = {}, policy = {} } = {}) {
      for (const [name, value] of Object.entries({ brief, policy })) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be a JSON object.`);
      }
      sequences.needSequence(sequenceId);
      return repo.films.open(sequenceId, { brief, policy, at: at() });
    },
    status, acquire, release: (id, owner) => repo.films.release(id, owner), step,
    async resume(id, owner) {
      if (!acquire(id, owner)) throw conflict('Another controller owns the film lease.');
      if (need(id).state === 'delivered') return status(id);
      const result = reconcile(need(id), owner);
      return step(id, { owner, expectedRevision: result.film.revision });
    },
    pause(id, reason = 'Paused by user.') { stop(need(id), `manual: ${reason}`); return status(id); },
    unpause(id) {
      const film = need(id);
      if (film.state === 'paused') commit(film, { state: stageOf(film), pauseReason: null }, [{ kind: 'resume', data: { explicit: true } }]);
      return status(id);
    },
  };
}
