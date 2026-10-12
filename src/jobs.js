import { EventEmitter } from 'node:events';
import { providerPrompt, toolOperations } from './generation.js';
import { userMessage } from './providers/http.js';

// Errors that mean the provider turned the request away before doing any paid work.
const refusedCategories = new Set(['missing_key', 'auth', 'invalid_request', 'rate_limit', 'policy']);

// Durable job runner. Generation rows are the queue: 'queued' rows survive restarts and resume. Long provider
// jobs (video) save the provider's job id as soon as it is accepted, so after a restart Lumina keeps polling the
// same job instead of starting (and paying for) a new one. Rows left 'running' without such an id are marked
// 'interrupted', with billing 'unknown' when the request may already have reached a paid provider.
export function createJobRunner({ repo, assetStore, providers, directors, keys, budget, concurrency = 2, log = console }) {
  const queue = [];
  const events = new EventEmitter();
  events.setMaxListeners(0);
  let active = 0;

  function pump() {
    while (active < concurrency && queue.length) {
      const id = queue.shift();
      active += 1;
      execute(id).finally(() => {
        active -= 1;
        pump();
      });
    }
  }

  async function execute(id) {
    const job = repo.generations.get(id);
    if (!job || job.status !== 'queued') return;
    const started = Date.now();
    repo.generations.update(id, { status: 'running', startedAt: new Date().toISOString() });
    events.emit('update', repo.generations.get(id));
    try {
      const provider = providers.get(job.provider);
      if (!provider) throw Object.assign(new Error('Provider unavailable'), { category: 'invalid_request' });
      let prompt = providerPrompt(job);
      if (job.director && job.operation !== 'speech') {
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
      const { params } = job;
      let output;
      if (toolOperations.includes(job.operation)) {
        if (typeof provider.tool !== 'function') throw Object.assign(new Error('This provider has no image tools'), { category: 'invalid_request' });
        const maskAsset = params.maskAssetId ? repo.assets.get(params.maskAssetId) : null;
        if (params.maskAssetId && !maskAsset) throw Object.assign(new Error('The mask was deleted.'), { category: 'invalid_request' });
        output = await provider.tool({
          key, model: job.model, operation: job.operation, image: images[0], prompt, scale: params.scale,
          mask: maskAsset ? await assetStore.read(maskAsset) : null,
        });
      } else if (job.operation === 'speech') {
        output = await provider.speak({ key, model: job.model, text: prompt, voice: params.voice, style: params.style });
      } else if (job.operation === 'video') {
        output = await provider.video({
          key, model: job.model, prompt, image: images[0] ?? null, duration: params.duration, aspect: params.aspect, resolution: params.resolution,
          resumeJob: job.providerJob ?? null,
          onSubmitted: (info) => repo.generations.update(id, { providerJob: { ...info, submittedAt: new Date().toISOString() } }),
        });
      } else {
        output = await provider.run({ key, model: job.model, prompt, size: params.size, quality: params.quality, images });
      }
      const asset = await assetStore.save({
        bytes: output.bytes, projectId: job.projectId, kind: 'generation', generationId: id, parentAssetId: job.inputAssetIds[0] ?? null,
      });
      repo.generations.update(id, {
        status: 'completed', finalPrompt: prompt, outputAssetId: asset.id, usage: output.usage,
        completedAt: new Date().toISOString(), durationMs: Date.now() - started,
      });
      const ledger = budget?.settle(job, { outcome: 'completed', usage: output.usage });
      if (ledger) repo.generations.update(id, { billing: 'charged' });
    } catch (error) {
      const category = error.category || 'provider';
      log.error?.('Generation failed', { id, provider: job.provider, category, detail: error.detail ?? error.message });
      // A project deleted mid-job cascades the row away; nothing left to update.
      if (repo.generations.get(id)) {
        // Was this billed? A refusal before any provider job existed was not; anything after the provider
        // accepted the job, or a lost connection, may have been.
        const submitted = Boolean(repo.generations.get(id).providerJob);
        const outcome = !submitted && refusedCategories.has(category) && (error.status == null || error.status < 500) ? 'refused' : 'unknown';
        const ledger = budget?.settle(job, { outcome, usage: error.usage });
        repo.generations.update(id, {
          status: 'failed', errorCategory: category, userError: error.category ? userMessage(error) : error.message,
          completedAt: new Date().toISOString(), durationMs: Date.now() - started,
          billing: ledger ? (ledger.status === 'released' ? 'none' : ledger.status) : null,
        });
      }
    }
    const final = repo.generations.get(id);
    if (final) events.emit('update', final);
  }

  return {
    events,
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
    stats: () => ({ active, queued: queue.length }),
  };
}
