import { EventEmitter } from 'node:events';
import { providerPrompt, toolOperations } from './generation.js';
import { userMessage } from './providers/http.js';
import { requestContext } from './context.js';

// Errors that mean the provider turned the request away before doing any paid work.
const refusedCategories = new Set(['missing_key', 'auth', 'invalid_request', 'rate_limit', 'policy', 'credit_limit', 'budget_limit']);

// Durable job runner. Generation rows are the queue: 'queued' rows survive restarts and resume. Long provider
// jobs (video) save the provider's job id as soon as it is accepted, so after a restart Lumina keeps polling the
// same job instead of starting (and paying for) a new one. Rows left 'running' without such an id are marked
// 'interrupted', with billing 'unknown' when the request may already have reached a paid provider.
export function createJobRunner({ repo, assetStore, providers, directors, keys, budget, credits, concurrency = 2, log = console }) {
  const queue = [];
  const events = new EventEmitter();
  events.setMaxListeners(0);
  let active = 0;
  // Live progress of running jobs (in memory only): id → { done, total, startedAt }. Cancellers stop running work.
  const progress = new Map();
  const cancellers = new Map();

  function pump() {
    while (active < concurrency && queue.length) {
      const id = queue.shift();
      active += 1;
      // Jobs run outside the request that queued them: background work (production, canvas runs) must not inherit a
      // click's confirmation, or lack of one.
      requestContext.run({ source: 'background' }, () => execute(id)).finally(() => {
        active -= 1;
        pump();
        if (active === 0 && queue.length === 0) events.emit('idle');
      });
    }
  }

  async function execute(id) {
    const job = repo.generations.get(id);
    if (!job || job.status !== 'queued') return;
    const started = Date.now();
    const abort = new AbortController();
    // Jobs on this computer can be stopped from the start (also during preflight); paid jobs keep running once sent.
    const stoppable = Boolean(providers.get(job.provider)?.cancellable);
    if (stoppable) cancellers.set(id, () => abort.abort());
    progress.set(id, { done: 0, total: 0, startedAt: new Date(started).toISOString() });
    repo.generations.update(id, { status: 'running', startedAt: new Date().toISOString() });
    events.emit('update', repo.generations.get(id));
    try {
      const provider = providers.get(job.provider);
      if (!provider) throw Object.assign(new Error('Provider unavailable'), { category: 'invalid_request' });
      const allowanceKey = job.provider === 'openrouter' && !job.providerJob ? keys.get('openrouter') : null;
      if (job.provider === 'openrouter' && !job.providerJob) {
        if (!credits) throw Object.assign(new Error('OpenRouter credit monitor is unavailable.'), { category: 'credit_limit' });
        await credits.preflight({ repo, generationId: id,
          reserveUsd: budget?.settings().enabled ? budget.settings().retryReserveUsd ?? 0 : 0 });
      }
      let prompt = job.finalPrompt || providerPrompt(job);
      if (job.director && job.operation !== 'speech' && !job.providerJob && !job.finalPrompt) {
        const [directorId, model] = job.director.split(':');
        const director = directors.get(directorId);
        if (!director) throw Object.assign(new Error('Director unavailable'), { category: 'invalid_request' });
        prompt = await director.refine({ key: director.keyless ? null : keys.get(director.keyProvider), model, idea: prompt });
        repo.generations.update(id, { finalPrompt: prompt });
      }
      const images = [];
      for (const assetId of job.inputAssetIds) {
        const asset = repo.assets.get(assetId);
        if (!asset) throw Object.assign(new Error('An input image was deleted.'), { category: 'invalid_request' });
        images.push(await assetStore.read(asset));
      }
      const key = provider.keyless ? null : keys.get(provider.id);
      const onProgress = (done, total) => {
        if (Number.isFinite(done) && Number.isFinite(total) && total > 0) progress.set(id, { ...progress.get(id), done, total });
      };
      const signal = abort.signal;
      const cancelled = () => {
        if (signal.aborted) throw Object.assign(new Error('Cancelled.'), { category: 'cancelled' });
      };
      cancelled();
      if (allowanceKey !== null && key !== allowanceKey) throw Object.assign(new Error('The OpenRouter key changed during preflight. No paid request was submitted; check the new key allowance before retrying.'), { category: 'credit_limit' });
      const { params } = job;
      let output;
      if (toolOperations.includes(job.operation)) {
        if (typeof provider.tool !== 'function') throw Object.assign(new Error('This provider has no image tools'), { category: 'invalid_request' });
        const maskAsset = params.maskAssetId ? repo.assets.get(params.maskAssetId) : null;
        if (params.maskAssetId && !maskAsset) throw Object.assign(new Error('The mask was deleted.'), { category: 'invalid_request' });
        output = await provider.tool({
          key, model: job.model, operation: job.operation, image: images[0], prompt, scale: params.scale,
          mask: maskAsset ? await assetStore.read(maskAsset) : null, onProgress, signal,
        });
      } else if (job.operation === 'speech') {
        output = await provider.speak({ key, model: job.model, text: prompt, voice: params.voice, style: params.style, onProgress, signal });
      } else if (job.operation === 'video') {
        const endAsset = params.endFrameAssetId ? repo.assets.get(params.endFrameAssetId) : null;
        if (params.endFrameAssetId && !endAsset) throw Object.assign(new Error('The end frame was deleted.'), { category: 'invalid_request' });
        output = await provider.video({
          key, model: job.model, prompt, image: images[0] ?? null, endImage: endAsset ? await assetStore.read(endAsset) : null, seed: params.seed,
          duration: params.duration, aspect: params.aspect, resolution: params.resolution,
          resumeJob: job.providerJob ?? null, onProgress, signal,
          onSubmitted: (info) => repo.generations.update(id, { providerJob: { ...info, submittedAt: new Date().toISOString() } }),
        });
      } else {
        // Characters baked into a LoRA (src/bake.js) travel with the job; providers without LoRA support ignore them.
        // 0.6 keeps the character without overcooking it; bakes recorded with the old 0.8 default are read as 0.6.
        const loras = (params.characterIds ?? []).map((cid) => repo.settings.get(`bake:${cid}`, null)).filter(Boolean)
          .map((lora) => (lora.scale === 0.8 ? { ...lora, scale: 0.6 } : lora));
        output = await provider.run({ key, model: job.model, prompt, size: params.size, quality: params.quality, images, seed: params.seed, loras, onProgress, signal });
      }
      cancelled();
      cancellers.delete(id); // saving the result: too late to cancel
      const asset = await assetStore.save({
        bytes: output.bytes, projectId: job.projectId, kind: 'generation', generationId: id, parentAssetId: job.inputAssetIds[0] ?? null,
      });
      repo.generations.update(id, {
        status: 'completed', finalPrompt: prompt, outputAssetId: asset.id, usage: output.usage,
        completedAt: new Date().toISOString(), durationMs: Date.now() - started,
      });
      const ledger = budget?.settle(job, { outcome: 'completed', usage: output.usage });
      if (ledger) repo.generations.update(id, { billing: 'charged' });
    } catch (caught) {
      const error = abort.signal.aborted ? Object.assign(new Error('Cancelled.'), { category: 'cancelled' }) : caught;
      const category = error.category || 'provider';
      log.error?.('Generation failed', { id, provider: job.provider, category, detail: error.detail ?? error.message });
      // A project deleted mid-job cascades the row away; nothing left to update.
      if (repo.generations.get(id)) {
        // Was this billed? A refusal before any provider job existed was not; anything after the provider
        // accepted the job, or a lost connection, may have been.
        const submitted = Boolean(repo.generations.get(id).providerJob);
        const outcome = category === 'cancelled' && (!submitted || stoppable) ? 'refused' : !submitted && refusedCategories.has(category) && (error.status == null || error.status < 500) ? 'refused' : 'unknown';
        const ledger = budget?.settle(job, { outcome, usage: error.usage });
        repo.generations.update(id, {
          status: 'failed', errorCategory: category, userError: ['credit_limit', 'budget_limit', 'cancelled'].includes(category) ? error.message : error.category ? userMessage(error) : error.message,
          completedAt: new Date().toISOString(), durationMs: Date.now() - started,
          billing: ledger ? (ledger.status === 'released' ? 'none' : ledger.status) : null,
        });
      }
    }
    progress.delete(id);
    cancellers.delete(id);
    const final = repo.generations.get(id);
    if (final) events.emit('update', final);
  }

  // Percent done and a straight-line ETA from the steps finished so far.
  function progressOf(id) {
    const p = progress.get(id);
    if (!p) return null;
    const fraction = p.total ? Math.min(1, p.done / p.total) : 0;
    const elapsed = (Date.now() - Date.parse(p.startedAt)) / 1000;
    return { done: p.done, total: p.total, fraction: Math.round(fraction * 1000) / 1000, startedAt: p.startedAt,
      etaSeconds: fraction > 0 && fraction < 1 ? Math.round(elapsed * (1 - fraction) / fraction) : null };
  }

  return {
    events,
    progress: progressOf,
    // Stop a job: a queued one never starts (any provider); a running one only when it runs on this computer.
    cancel(id) {
      const job = repo.generations.get(id);
      if (!job) return { ok: false, status: 404, reason: 'Generation not found.' };
      if (job.status === 'queued') {
        const at = queue.indexOf(id);
        if (at >= 0) queue.splice(at, 1);
        const ledger = budget?.settle(job, { outcome: 'refused' });
        repo.generations.update(id, { status: 'failed', errorCategory: 'cancelled', userError: 'Cancelled before it started.', completedAt: new Date().toISOString(),
          billing: ledger ? (ledger.status === 'released' ? 'none' : ledger.status) : job.billing });
        const final = repo.generations.get(id);
        events.emit('update', final);
        if (active === 0 && queue.length === 0) events.emit('idle');
        return { ok: true, generation: final };
      }
      if (job.status !== 'running') return { ok: false, status: 409, reason: `This job already ${job.status === 'completed' ? 'finished' : 'stopped'}.` };
      const stop = cancellers.get(id);
      if (!stop) return { ok: false, status: 409, reason: job.providerJob ? 'This job was already sent to a paid provider and keeps running there; it cannot be cancelled (it may still be charged).' : 'This job cannot be stopped while it runs; only jobs on this computer can.' };
      stop();
      return { ok: true, generation: repo.generations.get(id) };
    },
    enqueue(id) {
      queue.push(id);
      pump();
    },
    recover() {
      const running = repo.generations.idsWithStatus('running').map((id) => repo.generations.get(id));
      // Provider jobs that were accepted before Lumina stopped: poll them again.
      const resumable = running.filter((g) => g.providerJob && providers.get(g.provider)?.resumable);
      for (const g of resumable) repo.generations.update(g.id, { status: 'queued' });
      const lost = running.filter((g) => !resumable.includes(g));
      const interrupted = repo.generations.markInterrupted(lost.map((g) => g.id));
      for (const g of lost) {
        const ledger = budget?.settle(g, { outcome: 'unknown' });
        if (ledger) repo.generations.update(g.id, { billing: ledger.status });
      }
      const queued = repo.generations.idsWithStatus('queued');
      queued.forEach((id) => queue.push(id));
      pump();
      return { interrupted, resumed: queued.length, reattached: resumable.length };
    },
    // Resolve when a job reaches a terminal state (used by canvas runs, MCP and tests).
    waitFor(id, timeoutMs = 600_000) {
      const terminal = (g) => g && ['completed', 'failed', 'interrupted'].includes(g.status);
      const current = repo.generations.get(id);
      if (!current || terminal(current)) return Promise.resolve(current);
      return new Promise((resolve) => {
        const timer = setTimeout(() => { events.off('update', onUpdate); resolve(repo.generations.get(id)); }, timeoutMs);
        function onUpdate(g) {
          if (g.id === id && terminal(g)) {
            clearTimeout(timer);
            events.off('update', onUpdate);
            resolve(g);
          }
        }
        events.on('update', onUpdate);
      });
    },
    idle: () => active === 0 && queue.length === 0 ? Promise.resolve() : new Promise((resolve) => events.once('idle', resolve)),
    stats: () => ({ active, queued: queue.length }),
  };
}
