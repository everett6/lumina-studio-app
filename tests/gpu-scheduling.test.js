import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGpuQueue } from '../src/gpu.js';
import { createWorker, withGpuLease } from '../src/providers/local.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test('GPU work is FIFO, non-overlapping and continues after a failure', async () => {
  const queue = createGpuQueue();
  let active = 0, peak = 0;
  const order = [];
  const task = (id, fail = false) => queue.run(async () => {
    active++; peak = Math.max(peak, active); order.push(id);
    try { await delay(10); if (fail) throw Error('injected failure'); return id; }
    finally { active--; }
  });
  const results = await Promise.allSettled([task('Wan', true), task('RIFE'), task('upscale')]);
  assert.equal(peak, 1); assert.deepEqual(order, ['Wan','RIFE','upscale']);
  assert.equal(results[0].status, 'rejected'); assert.equal(results[2].value, 'upscale');
  await queue.idle(); assert.deepEqual(queue.status(), { active: false, queued: 0 });
});

test('finishing leases serialize across independent callers', async () => {
  let active = 0, peak = 0;
  await Promise.all([1,2,3].map(() => withGpuLease(async () => {
    active++; peak = Math.max(peak, active); await delay(5); active--;
  })));
  assert.equal(peak, 1);
});

test('worker replacement waits for actual process exit rather than only sending SIGTERM', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lumina-worker-test-'));
  const script = path.join(root, 'worker.cjs');
  writeFileSync(script, `const readline=require('node:readline');
    process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),150));
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const {id}=JSON.parse(line); console.log(JSON.stringify({id,done:true,pid:process.pid}));
    });`);
  const worker = createWorker(script, () => process.execPath);
  try {
    const first = await worker.request({});
    const started = Date.now();
    const stopping = worker.stop();
    const second = await worker.request({});
    await stopping;
    assert.notEqual(first.pid, second.pid);
    assert.ok(Date.now() - started >= 140, 'old process must finish its delayed release before replacement');
    await worker.stop();
  } finally { await worker.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('missing worker executable reports a provider error instead of an unhandled process crash', async () => {
  const worker = createWorker('/unused/test.py', () => '/nonexistent/lumina-python');
  await assert.rejects(worker.request({}), /could not start|input closed/);
  await worker.stop();
});
