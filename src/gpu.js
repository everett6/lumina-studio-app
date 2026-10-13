// A shared FIFO for local model generation and Vulkan finishing. A rejected job cannot poison the queue.
export function createGpuQueue() {
  let tail = Promise.resolve();
  let queued = 0;
  let active = false;
  function run(task) {
    queued++;
    const next = tail.then(async () => {
      queued--; active = true;
      try { return await task(); } finally { active = false; }
    });
    tail = next.catch(() => {});
    return next;
  }
  return { run, idle: () => tail, status: () => ({ queued, active }) };
}
export const gpuQueue = createGpuQueue();
