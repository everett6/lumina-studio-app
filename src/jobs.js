import { EventEmitter } from 'node:events';
import { composePrompt } from './presets.js';
import { userMessage } from './providers/http.js';

// Durable image job runner. Generation rows are the queue: 'queued' rows survive restarts and resume;
// rows left 'running' by a crash are marked 'interrupted' on startup.
export function createJobRunner({ repo, assetStore, providers, directors, keys, concurrency = 2, log = console }) {
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
      let prompt = composePrompt(job.prompt, job.params?.presets);
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
      if (job.operation === 'speech') {
        output = await provider.speak({ key, model: job.model, text: prompt, voice: params.voice, style: params.style });
      } else if (job.operation === 'video') {
        output = await provider.video({ key, model: job.model, prompt, image: images[0] ?? null, duration: params.duration, aspect: params.aspect });
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
    } catch (error) {
      const category = error.category || 'provider';
      log.error?.('Generation failed', { id, provider: job.provider, category, detail: error.detail ?? error.message });
      // A project deleted mid-job cascades the row away; nothing left to update.
      if (repo.generations.get(id)) {
        repo.generations.update(id, {
          status: 'failed', errorCategory: category, userError: error.category ? userMessage(error) : error.message,
          completedAt: new Date().toISOString(), durationMs: Date.now() - started,
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
      const interrupted = repo.generations.markInterrupted();
      const queued = repo.generations.idsWithStatus('queued');
      queued.forEach((id) => queue.push(id));
      pump();
      return { interrupted, resumed: queued.length };
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
