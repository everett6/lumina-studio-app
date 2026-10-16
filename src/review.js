import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { contactSheet, probe } from './video.js';
import { frameDifference } from './qc.js';
import { billingState } from './budget.js';

const exec = promisify(execFile);
export const areas = ['identity', 'wardrobe', 'location', 'props', 'action', 'flicker', 'deformation', 'text', 'cross-shot'];
export const limits = Object.freeze({ responseBytes: 2 * 1024 * 1024, mediaBytes: 1024 * 1024, imageBytes: 120 * 1024, audioBytes: 256 * 1024, frames: 12, shotAttempts: 2, filmAttempts: 10 });
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const bounded = (v, n = 2048) => String(v ?? '').slice(0, n);
const nonempty = (v, label, n = 2048) => typeof v === 'string' && v.trim() && v.length <= n ? v.trim() : fail(`${label} must be nonempty and at most ${n} characters.`);
const key = (id) => `visual-review:${id}`;
const active = (g) => g && ['queued', 'running'].includes(g.status);

// Positive means a defect (failed), negative means clean (passed). Abstentions are excluded,
// with their count reported; a rate with no eligible denominator is null, never a fabricated zero.
export function evaluateCheck(labels, results) {
  if (!Array.isArray(labels) || !Array.isArray(results) || labels.length !== results.length) throw new TypeError('Labels and results must be equal-length arrays.');
  const counts = { truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0, evaluated: 0, unavailable: 0 };
  for (let i = 0; i < labels.length; i += 1) {
    const label = typeof labels[i] === 'object' ? labels[i]?.result ?? labels[i]?.status : labels[i];
    const result = typeof results[i] === 'object' ? results[i]?.result ?? results[i]?.status : results[i];
    if (!['passed', 'failed'].includes(label)) throw new TypeError('Human labels must be passed or failed.');
    if (!['passed', 'failed', 'unavailable', 'uncertain', null, undefined].includes(result)) throw new TypeError('Unknown automatic result.');
    if (!['passed', 'failed'].includes(result)) { counts.unavailable += 1; continue; }
    counts.evaluated += 1;
    counts[label === 'failed' ? (result === 'failed' ? 'truePositive' : 'falseNegative') : (result === 'failed' ? 'falsePositive' : 'trueNegative')] += 1;
  }
  const negatives = counts.falsePositive + counts.trueNegative;
  const positives = counts.falseNegative + counts.truePositive;
  return { ...counts, falsePositiveRate: negatives ? counts.falsePositive / negatives : null, falseNegativeRate: positives ? counts.falseNegative / positives : null };
}

// Inline payloads share one cap; oversize/missing media are explicitly labelled, never replaced
// with a synthetic picture that could be mistaken for actual evidence.
function payload() {
  const out = { media: [], omitted: [], limits };
  let used = 0;
  out.add = (bytes, type, label, mimeType) => {
    const data = bytes.toString('base64');
    if (bytes.length > (type === 'audio' ? limits.audioBytes : limits.imageBytes) || used + data.length > limits.mediaBytes) {
      out.omitted.push(`${label}: inline size cap`); return false;
    }
    used += data.length;
    out.media.push({ type, label, mimeType, data });
    return true;
  };
  return out;
}
const finished = (out, data) => { const { add, ...rest } = out; return { ...data, ...rest }; };
const unavailable = (out, label, error) => out.omitted.push(`${label}: ${bounded(error.message, 160)}`);

export function createReviewService({ repo, assetStore, sequences, catalog }) {
  const needShot = (id) => sequences.needShot(id);
  const detail = (id) => sequences.detail(id);
  const events = (sequenceId) => {
    const film = repo.films.bySequence(sequenceId);
    return [...repo.settings.get(key(sequenceId), []), ...(film ? repo.filmEvents.list(film.id).filter((e) => e.data.source === 'visual-review') : [])];
  };
  const append = (sequenceId, kind, data) => {
    const event = { kind, at: new Date().toISOString(), data: { ...data, source: 'visual-review', version: 1 } };
    const film = repo.films.bySequence(sequenceId);
    if (film) {
      if (!repo.films.commit(film.id, { expectedRevision: film.revision }, [event])) fail('Film revision changed. Reload before recording review.', 409);
    } else repo.settings.set(key(sequenceId), [...repo.settings.get(key(sequenceId), []), event]);
    return event.data;
  };
  const findings = (shotId, takeId) => {
    const shot = needShot(shotId);
    return events(shot.sequenceId).filter((e) => e.kind === 'finding' && e.data.shotId === shotId && (takeId === undefined || e.data.takeId === takeId)).map((e) => e.data);
  };
  const history = ({ shotId, storyboardId }) => {
    if (Boolean(shotId) === Boolean(storyboardId)) fail('Pass exactly one of shotId or storyboardId.');
    const sequenceId = shotId ? needShot(shotId).sequenceId : storyboardId;
    detail(sequenceId);
    const all = events(sequenceId).filter((e) => e.kind === 'repair' && (!shotId || e.data.shotId === shotId));
    const attempts = new Map();
    for (const e of all.filter((e) => e.data.action === 'attempt')) attempts.set(e.data.id, { ...attempts.get(e.data.id), ...e.data });
    for (const a of attempts.values()) {
      if (!a.generationId) continue;
      const g = repo.generations.get(a.generationId);
      if (g) Object.assign(a, { state: g.status, takeId: g.assetId ?? null, error: g.userError ?? a.error });
    }
    return { storyboardId: sequenceId, ...(shotId ? { shotId } : {}), attempts: [...attempts.values()], decisions: all.filter((e) => e.data.action === 'accept' || e.data.action === 'reject').map((e) => e.data) };
  };
  const candidate = (shotId, takeId) => history({ shotId }).attempts.find((a) => a.takeId === takeId && a.state === 'completed');
  const knownTake = async (shotId, takeId, call) => {
    const takes = await call('GET', `/api/shots/${shotId}/takes`);
    if (takes.frames.some((t) => t.assetId === takeId)) return 'frame';
    if (takes.clips.some((t) => t.assetId === takeId)) return 'clip';
    const found = candidate(shotId, takeId);
    return found?.kind ?? fail('This is not a completed take of this shot.', 404);
  };
  const asset = (id) => repo.assets.get(id) ?? fail('Asset not found.', 404);
  const geometry = async (id) => {
    const a = asset(id);
    if (!a.mimeType.startsWith('image/') && !a.mimeType.startsWith('video/')) fail('Frames require an image or video asset.');
    const file = assetStore.path(a);
    if (a.mimeType.startsWith('image/')) return { file, last: 0, duration: 0, frameSeconds: 0, still: true };
    const info = await probe(file);
    if (!info.duration || !info.width) fail('No decodable picture.', 422);
    return { file, last: Math.max(0, info.duration - 1 / (info.fps || 24)), duration: info.duration, frameSeconds: 1 / (info.fps || 24), still: false };
  };
  const rawFrame = async (g, time) => (await exec('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', g.file, '-frames:v', '1', '-threads', '1', '-vf', 'scale=32:18:flags=area,format=rgb24', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1024 * 1024, timeout: 15000 })).stdout;
  const image = async (g, time) => {
    const { stdout } = await exec('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', g.file, '-frames:v', '1', '-threads', '1', '-vf', 'scale=384:216:force_original_aspect_ratio=decrease', '-q:v', '5', '-f', 'image2pipe', '-c:v', 'mjpeg', '-'], { encoding: 'buffer', maxBuffer: 1024 * 1024, timeout: 15000 });
    if (!stdout.length) fail('No frame at that time.', 422);
    return stdout;
  };
  const addFrame = async (out, id, time, label, knownGeometry = null) => {
    try { const g = knownGeometry ?? await geometry(id); const t = time === 'end' ? g.last : time === 'middle' ? g.last / 2 : time; out.add(await image(g, t), 'image', `${label} @ ${t.toFixed(3)}s`, 'image/jpeg'); return { assetId: id, time: t, label }; }
    catch (error) { unavailable(out, label, error); return { assetId: id ?? null, label, result: 'unavailable' }; }
  };
  // Shot duration is a source interval; playback speed changes its screen time, not its source cuts.
  const shotGeometry = async (shot) => {
    const g = await geometry(shot.videoAssetId ?? shot.imageAssetId);
    const start = g.still ? 0 : shot.details.trimStart ?? 0;
    if (start > g.last) fail('Shot starts beyond its decodable clip.', 422);
    return { ...g, start, end: g.still ? 0 : Math.max(start, Math.min(g.last, start + shot.duration - g.frameSeconds)) };
  };
  const addShotFrame = async (out, shot, moment, label) => {
    const id = shot.videoAssetId ?? shot.imageAssetId;
    try {
      const g = await shotGeometry(shot);
      const time = moment === 'end' ? g.end : moment === 'middle' ? (g.start + g.end) / 2 : g.start;
      return await addFrame(out, id, time, label, g);
    } catch (error) { unavailable(out, label, error); return { assetId: id ?? null, label, result: 'unavailable' }; }
  };
  const sample = async (id, { times, count } = {}) => {
    if (times !== undefined && count !== undefined) fail('Pass times or count, not both.');
    const g = await geometry(id);
    const n = count ?? 3;
    if (!Number.isInteger(n) || n < 1 || n > limits.frames) fail('count must be 1–12.');
    const moments = times ?? Array.from({ length: n }, (_, i) => n === 1 ? g.last / 2 : g.last * i / (n - 1));
    if (!Array.isArray(moments) || !moments.length || moments.length > limits.frames || moments.some((t) => !Number.isFinite(t) || t < 0 || t > g.last)) fail('Times must contain 1–12 timestamps within the decodable clip.');
    const out = payload();
    const frames = [];
    for (const t of moments) frames.push(await addFrame(out, id, t, 'sample', g));
    return finished(out, { assetId: id, frames });
  };
  const bundle = async (shotId) => {
    const shot = needShot(shotId), board = detail(shot.sequenceId);
    const out = payload();
    const own = [...(shot.details.characterIds ?? []), shot.details.locationId].filter(Boolean);
    const cast = [...new Set(own.length ? own : board.sequence.settings.characterIds ?? [])];
    const references = [];
    for (const id of cast) {
      const c = repo.characters.get(id);
      if (!c?.locked) { out.omitted.push(`Character ${id}: no approved (locked) references`); continue; }
      for (const ref of c.referenceAssetIds) {
        if (references.length >= 8) { out.omitted.push('Additional references: 8-reference cap'); break; }
        references.push({ characterId: c.id, name: bounded(c.name, 120), assetId: ref, approved: true });
        await addFrame(out, ref, 0, `Approved reference: ${bounded(c.name, 120)}`);
      }
    }
    const frames = [];
    const clip = shot.videoAssetId ?? shot.imageAssetId;
    for (const [label, time] of [['opening', 0], ['middle', 'middle'], ['ending', 'end']]) frames.push(await addShotFrame(out, shot, time, label));
    const at = board.shots.findIndex((s) => s.id === shotId);
    const neighbours = [];
    for (const [neighbour, side, time] of [[board.shots[at - 1], 'previous ending', 'end'], [board.shots[at + 1], 'next opening', 0]]) {
      if (neighbour) neighbours.push({ shotId: neighbour.id, ...await addShotFrame(out, neighbour, time, side) });
    }
    const dialogue = [];
    for (const [i, line] of (shot.details.dialogue ?? []).entries()) {
      dialogue.push({ lineIndex: i, speaker: bounded(line.speaker, 120), text: bounded(line.text), assetId: line.assetId ?? null });
      if (!line.assetId) { out.omitted.push(`Dialogue ${i}: unrecorded`); continue; }
      try {
        const a = asset(line.assetId);
        if (a.size > limits.audioBytes) { out.omitted.push(`Dialogue ${i}: inline size cap`); continue; }
        out.add((await assetStore.read(a)).bytes, 'audio', `Dialogue ${i}`, a.mimeType);
      } catch (error) { unavailable(out, `Dialogue ${i}`, error); }
    }
    let sceneState = repo.settings.get(`scene-state:${shotId}`, null);
    if (Buffer.byteLength(JSON.stringify(sceneState)) > 16384) { sceneState = null; out.omitted.push('Scene state: 16 KiB cap'); }
    const current = findings(shotId, clip);
    if (current.length > 50) out.omitted.push('Findings: latest 50 shown; review_summary includes all');
    return finished(out, { shotId, takeId: clip, references, frames, neighbours, dialogue, sceneState, findings: current.slice(-50) });
  };
  const compare = async (shotId, takeA, takeB, call) => {
    await knownTake(shotId, takeA, call); await knownTake(shotId, takeB, call);
    const a = await geometry(takeA), b = await geometry(takeB);
    const last = Math.min(a.last, b.last), tiles = [], moments = [];
    for (const time of [0, last / 2, last]) {
      const score = frameDifference(await rawFrame(a, time), await rawFrame(b, time));
      moments.push({ time, difference: score.difference });
      tiles.push({ file: a.file, time, label: `A ${time.toFixed(3)}s` }, { file: b.file, time, label: `B ${time.toFixed(3)}s` });
    }
    const out = payload();
    out.add(await contactSheet(tiles, { columns: 2, width: 256 }), 'image', 'A left / B right at matched times', 'image/jpeg');
    return finished(out, { shotId, takeA, takeB, moments, measures: 'Mean absolute RGB difference, 0–255; not an identity or quality score.' });
  };
  const adjacent = async (storyboardId) => {
    const shots = detail(storyboardId).shots, out = payload(), cuts = [];
    for (let i = 1; i < shots.length; i += 1) {
      const left = shots[i - 1], right = shots[i];
      const cut = { from: left.id, to: right.id, result: 'unavailable', colourJump: null, brightnessJump: null };
      try {
        const a = await shotGeometry(left), b = await shotGeometry(right);
        const score = frameDifference(await rawFrame(a, a.end), await rawFrame(b, b.start));
        Object.assign(cut, { result: 'measured', fromTime: a.end, toTime: b.start, colourJump: score.colourJump, brightnessJump: score.brightnessJump });
        out.add(await contactSheet([{ file: a.file, time: a.end, label: `Shot ${left.position} end ${a.end.toFixed(3)}s` }, { file: b.file, time: b.start, label: `Shot ${right.position} start ${b.start.toFixed(3)}s` }], { columns: 2, width: 256 }), 'image', `Cut ${left.position} / ${right.position}`, 'image/jpeg');
      } catch (error) { unavailable(out, `Cut ${left.position}/${right.position}`, error); }
      cuts.push(cut);
    }
    return finished(out, { storyboardId, cuts, measures: 'Colour: distance between mean RGB colours (0–255). Brightness: absolute mean Rec.709 luma jump (0–255). These measure cuts, not continuity correctness.' });
  };
  const record = async (shotId, input, call) => {
    const shot = needShot(shotId);
    if (!areas.includes(input.area) || !['passed', 'failed', 'uncertain'].includes(input.result)) fail('Invalid finding area or result.');
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) fail('confidence must be 0–1.');
    const takeId = input.takeId ?? shot.videoAssetId ?? shot.imageAssetId ?? null;
    if (takeId) await knownTake(shotId, takeId, call);
    const r = typeof input.reviewer === 'string' ? { name: input.reviewer, model: null, version: 'unspecified' } : input.reviewer;
    if (!r || typeof r !== 'object') fail('reviewer is required.');
    const reviewer = { name: nonempty(r.name, 'reviewer.name', 120), model: r.model ? nonempty(r.model, 'reviewer.model', 120) : null, version: r.version ? nonempty(r.version, 'reviewer.version', 120) : 'unspecified' };
    return { finding: append(shot.sequenceId, 'finding', { id: randomUUID(), shotId, takeId, area: input.area, result: input.result, evidence: nonempty(input.evidence, 'evidence'), confidence: input.confidence, reviewer, at: new Date().toISOString(), blocking: input.result !== 'passed', resolved: input.result === 'passed' }) };
  };
  const summary = (storyboardId) => ({ storyboardId, shots: detail(storyboardId).shots.map((s) => {
    const current = findings(s.id, s.videoAssetId ?? s.imageAssetId ?? null);
    return { shotId: s.id, takeId: s.videoAssetId ?? s.imageAssetId ?? null, areas: Object.fromEntries(areas.map((a) => {
      const rows = current.filter((f) => f.area === a);
      return [a, rows.some((f) => f.result === 'failed') ? 'failed' : rows.some((f) => f.result === 'uncertain') ? 'unavailable' : rows.length ? 'passed' : 'not reviewed'];
    })), checks: (s.review.checks ?? []).map((c) => ({ ...c, status: c.status ?? (c.ok ? 'passed' : 'failed') })) };
  }) });
  const getFinding = (shotId, findingId) => findings(shotId).find((f) => f.id === findingId) ?? fail('Finding does not belong to this shot.', 404);
  const validatePlan = async (shotId, input, call) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('plan must be an object.');
    const shot = needShot(shotId), board = detail(shot.sequenceId), settings = board.sequence.settings;
    const plan = { type: input.type, findingId: input.findingId ?? null };
    if (plan.findingId) getFinding(shotId, plan.findingId);
    const modelFor = (operation, provider, model) => {
      const options = catalog().providers.filter((p) => p.ready && (!provider || p.id === provider)).flatMap((p) => p.models.filter((m) => m.available !== false && m.operations.includes(operation) && (!model || m.id === model)).map((m) => ({ provider: p.id, model: m.id })));
      return options[0] ?? fail(`No ready ${operation} model matches the repair.`, 409);
    };
    if (input.type === 'repair_frame') {
      plan.instruction = nonempty(input.instruction, 'instruction', 3000);
      const b = input.box;
      if (!Array.isArray(b) || b.length !== 4 || b.some((v) => !Number.isFinite(v) || v < 0 || v > 1) || b[2] - b[0] < 0.01 || b[3] - b[1] < 0.01) fail('box must be nonempty [x1,y1,x2,y2] fractions of the frame.');
      if (!shot.imageAssetId) fail('No frame to repair.');
      Object.assign(plan, { box: b, ...modelFor('inpaint', input.provider, input.model), operation: 'inpaint', kind: 'frame' });
    } else if (input.type === 're-frame') {
      plan.prompt = nonempty(input.prompt, 'changed prompt', 4000);
      if (plan.prompt === shot.description) fail('A re-frame needs a changed prompt.');
      Object.assign(plan, modelFor('generate', input.provider ?? settings.imageProvider, input.model ?? settings.imageModel), { operation: 'generate', kind: 'frame' });
    } else if (input.type === 'new_clip') {
      const frameId = input.frameId ?? shot.imageAssetId;
      if (!frameId || shot.review.frameApproved !== frameId) fail('new_clip requires the shot’s approved frame.', 409);
      const [p, m] = shot.details.model?.split('|') ?? [];
      Object.assign(plan, modelFor('video', input.provider ?? p ?? settings.videoProvider, input.model ?? m ?? settings.videoModel), { frameId, prompt: nonempty(input.prompt ?? shot.description, 'prompt', 4000), operation: 'video', kind: 'clip', duration: shot.duration });
    } else if (input.type === 'trim') {
      const trimStart = input.trimStart ?? shot.details.trimStart ?? 0, duration = input.duration ?? shot.duration;
      if (!Number.isFinite(trimStart) || trimStart < 0 || trimStart > 10 || !Number.isInteger(duration) || duration < 1 || duration > 30) fail('Invalid trimStart (0–10) or duration (1–30).');
      const g = await geometry(shot.videoAssetId);
      if (trimStart + duration > g.duration + 1e-9) fail('Trim extends beyond the clip.');
      Object.assign(plan, { trimStart, duration, kind: 'trim' });
    } else if (input.type === 're-record') {
      const lineIndex = input.lineIndex;
      if (!Number.isInteger(lineIndex) || !shot.details.dialogue?.[lineIndex]) fail('A valid dialogue lineIndex is required.');
      const line = shot.details.dialogue[lineIndex];
      const voice = (line.speaker === 'narrator' ? null : repo.characters.get(line.speaker))?.voice ?? settings.narratorVoice;
      if (!voice) fail('Choose a voice before re-recording.', 409);
      Object.assign(plan, modelFor('speech', input.provider ?? voice.provider, input.model ?? voice.model), { voice: voice.voice, prompt: line.text, style: bounded(input.style ?? line.style, 500), lineIndex, operation: 'speech', kind: 'audio' });
    } else fail('type must be re-frame, repair_frame, new_clip, trim or re-record.');
    const estimate = await call('POST', '/api/budget/estimate', { items: plan.type === 'trim' ? [] : [{ operation: plan.operation, provider: plan.provider, model: plan.model, duration: plan.duration, image: plan.type === 'new_clip', size: '1536x1024' }] });
    return { plan, estimate };
  };
  const propose = async (shotId, findingId, call) => {
    const shot = needShot(shotId), f = getFinding(shotId, findingId);
    if (f.result === 'passed') fail('A passed finding needs no repair.');
    const { plan, estimate } = await validatePlan(shotId, { type: 're-frame', findingId, prompt: `${shot.description}\nRepair ${f.area}: ${f.evidence}\nKeep the approved character references and declared scene state.`.slice(0, 4000) }, call);
    return { shotId, findingId, plan, estimate, rationale: `Re-frame with a changed prompt addressing the ${f.area} evidence. Review the new frame before approving it or making a clip.`, alternatives: ['repair_frame with a reviewer-selected region', 'new_clip from an approved frame', 'trim', 're-record'] };
  };
  const execute = async (shotId, input, maxAttempts = 2, call) => {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 2) fail('maxAttempts must be 1 or 2.');
    const shot = needShot(shotId), sequenceId = shot.sequenceId;
    const previous = history({ storyboardId: sequenceId }).attempts;
    const pending = previous.find((a) => a.shotId === shotId && (a.state === 'reserved' || active({ status: a.state })));
    if (pending) return { shotId, attempts: [], stopReason: 'pending_attempt', pending };
    const attempts = [];
    let stopReason = 'max_attempts';
    // Check limits before estimates or provider submission, and again atomically before each attempt.
    const limitReason = () => {
      // Requests refused before submission (budget 402, confirmation 428) spent nothing and use no attempt.
      const all = history({ storyboardId: sequenceId }).attempts.filter((a) => a.state !== 'budget_refused' && a.state !== 'confirm_required');
      const policy = repo.films.bySequence(sequenceId)?.policy ?? {};
      if (all.filter((a) => a.shotId === shotId).length >= Math.min(2, policy.maxAttemptsPerShot ?? 2)) return 'shot_limit';
      if (all.length >= Math.min(10, policy.maxRepairsPerFilm ?? 10)) return 'film_limit';
      if (all.some((a) => a.shotId === shotId && (a.state === 'reserved' || active({ status: a.state })))) return 'pending_attempt';
      return null;
    };
    const initial = limitReason();
    if (initial) return { shotId, attempts, stopReason: initial };
    const { plan, estimate } = await validatePlan(shotId, input, call);
    for (let n = 0; n < maxAttempts; n += 1) {
      let attempt;
      // No await between the limit read and reservation: API requests cannot interleave here.
      // films.commit already owns its SQLite transaction (nesting transactions is unsupported).
      const refused = (() => {
        const reason = limitReason();
        if (reason) return reason;
        attempt = append(sequenceId, 'repair', { id: randomUUID(), action: 'attempt', shotId, state: 'reserved', plan, estimate, kind: plan.kind, original: { frame: shot.imageAssetId, clip: shot.videoAssetId, dialogue: plan.kind === 'audio' ? shot.details.dialogue[plan.lineIndex] : undefined, trimStart: shot.details.trimStart, duration: shot.duration }, at: new Date().toISOString() });
        return null;
      })();
      if (refused) { stopReason = refused; break; }
      try {
        if (plan.type === 'trim') {
          Object.assign(attempt, { state: 'completed', takeId: `trim:${attempt.id}` });
        } else {
          let result;
          if (plan.type === 'repair_frame') result = await call('POST', `/api/shots/${shotId}/repair-frame`, plan);
          else result = await call('POST', '/api/generate', { projectId: detail(sequenceId).sequence.projectId, operation: plan.operation, prompt: plan.prompt, provider: plan.provider, model: plan.model, duration: plan.duration, voice: plan.voice, style: plan.style, characterIds: detail(sequenceId).sequence.settings.characterIds, inputAssetIds: plan.frameId ? [plan.frameId] : [], bookTarget: plan.kind === 'frame' ? `shot-repair:${shotId}` : `review-${plan.kind}:${shotId}`, idempotencyKey: `review:${attempt.id}` });
          const g = result.generation;
          if (!g?.id) fail('Generation route returned no job.', 502);
          Object.assign(attempt, { generationId: g.id, state: g.status });
          append(sequenceId, 'repair', attempt); // persist the job before any wait
          const done = (await call('POST', `/api/generations/${g.id}/wait`, { timeoutMs: 1000 })).generation;
          Object.assign(attempt, { state: done.status, takeId: done.assetId ?? null, error: done.userError ?? null });
        }
        append(sequenceId, 'repair', attempt);
        attempts.push(attempt);
        if (attempt.state === 'completed') { stopReason = 'needs_review'; break; }
        if (active({ status: attempt.state })) { stopReason = 'pending_attempt'; break; }
        // A failed paid job may still have been charged: only a confirmed-unbilled failure is retried automatically.
        if (attempt.generationId && !['confirmed_unbilled', 'refused'].includes(billingState(repo.generations.get(attempt.generationId)))) { stopReason = 'billing_uncertain'; break; }
      } catch (error) {
        Object.assign(attempt, { state: error.status === 402 ? 'budget_refused' : error.status === 428 && !attempt.generationId ? 'confirm_required' : attempt.generationId ? 'uncertain' : 'failed', httpStatus: error.status ?? null, error: bounded(error.message, 1000), budget: error.status === 402 ? error.data ?? null : undefined });
        append(sequenceId, 'repair', attempt); attempts.push(attempt);
        stopReason = error.status === 402 ? 'budget_refused' : attempt.state === 'confirm_required' ? 'confirm_required' : 'error';
        break; // transport/unknown billing must never trigger an automatic retry
      }
    }
    return { shotId, attempts, stopReason, note: 'Candidates remain unselected. Review and record a finding for takeId before accept_repair.' };
  };
  const decide = async (shotId, takeId, reason, accept, call) => {
    reason = nonempty(reason, 'reason', 1000);
    const shot = needShot(shotId), kind = await knownTake(shotId, takeId, call), c = candidate(shotId, takeId);
    if (accept) {
      const reviews = findings(shotId, takeId);
      if (!reviews.length || reviews.some((f) => f.result !== 'passed')) fail('Review this take and resolve failed or uncertain findings before accepting.', 409);
      if (kind === 'frame') await call('POST', `/api/shots/${shotId}/takes/select`, { kind, assetId: takeId });
      else if (kind === 'clip') {
        const takes = await call('GET', `/api/shots/${shotId}/takes`);
        // Both selection routes already run the shot's checks.
        await call('POST', `/api/shots/${shotId}/${takes.clips.some((t) => t.assetId === takeId) ? 'takes/select' : 'attach-clip'}`, { kind, assetId: takeId });
        await call('POST', `/api/shots/${shotId}/review`, { status: 'accepted', notes: reason });
      } else if (kind === 'trim') {
        if (shot.videoAssetId !== c.original.clip) fail('Selected clip changed since this trim was proposed.', 409);
        await call('PATCH', `/api/shots/${shotId}`, { duration: c.plan.duration, details: { trimStart: c.plan.trimStart } });
        await call('POST', `/api/shots/${shotId}/checks`, {});
        await call('POST', `/api/shots/${shotId}/review`, { status: 'accepted', notes: reason });
      } else if (kind === 'audio') {
        const lines = [...shot.details.dialogue], index = c.plan.lineIndex;
        if (!lines[index] || lines[index].text !== c.plan.prompt) fail('Dialogue words changed since recording.', 409);
        // There is no existing route for adopting a recorded audio asset. Keep the old recording
        // in the attempt, and attach the already reviewed candidate without submitting it again.
        lines[index] = { ...lines[index], assetId: takeId, seconds: null };
        repo.shots.update(shotId, { details: { ...shot.details, dialogue: lines }, review: { ...shot.review, status: 'needs_review' } });
      }
    } else if (takeId === shot.videoAssetId) await call('POST', `/api/shots/${shotId}/review`, { status: 'rejected', notes: reason });
    return { decision: append(shot.sequenceId, 'repair', { id: randomUUID(), action: accept ? 'accept' : 'reject', shotId, takeId, kind, reason, at: new Date().toISOString() }), selected: accept };
  };
  return { sample, bundle, compare, adjacent, record, summary, propose, execute, decide, history };
}
