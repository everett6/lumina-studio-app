// A shared FIFO for local model generation and Vulkan finishing. A rejected job cannot poison the queue.
export function createGpuQueue({ now = Date.now } = {}) {
  let tail = Promise.resolve();
  let queued = 0;
  let active = false;
  let counter = 0;
  const jobs = new Map();
  function run(task) {
    const id = `gpu-${++counter}`;
    const job = { id, label: task.name || 'Lumina GPU job', queuedAt: now(), startedAt: null };
    jobs.set(id, job);
    queued++;
    const next = tail.then(async () => {
      queued--; active = true; job.startedAt = now();
      try { return await task(); } finally { active = false; jobs.delete(id); }
    });
    tail = next.catch(() => {});
    return next;
  }
  function snapshot() {
    const time = now();
    const entries = [...jobs.values()].map((job) => ({ ...job, ageMs: Math.max(0, time - job.queuedAt),
      runningAgeMs: job.startedAt === null ? null : Math.max(0, time - job.startedAt) }));
    return { running: entries.filter((job) => job.startedAt !== null), queued: entries.filter((job) => job.startedAt === null) };
  }
  return { run, idle: () => tail, status: () => ({ queued, active }), snapshot };
}
export const gpuQueue = createGpuQueue();

// The provider owns the only process handles we are allowed to stop. Its lease synchronously reserves the FIFO,
// then awaits actual worker exits before releasing it. Recheck after importing: a job may have arrived meanwhile.
// No PID discovery, process-name matching or signals to any other app. Busy queues are skipped, never waited out.
export async function stopIdleLuminaWorkers({ queue = gpuQueue,
  loadLease = async () => (await import('./providers/local.js')).withGpuLease } = {}) {
  const busy = () => { const { active, queued } = queue.status(); return active || queued > 0; };
  const skipped = () => ({ released: false, reason: 'Lumina GPU work is running or queued; no workers were stopped.' });
  if (busy()) return skipped();
  const lease = await loadLease();
  if (busy()) return skipped();
  // No await between the last check and the lease reservation. New jobs queue behind worker shutdown.
  await lease(async function releaseIdleWorkers() {});
  return { released: true, reason: 'Idle Lumina worker shutdown completed; VRAM release is measured separately.',
    stoppedWorkers: null }; // private provider handles cannot tell us which were previously loaded
}
