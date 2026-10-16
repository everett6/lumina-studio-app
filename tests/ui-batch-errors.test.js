import test from 'node:test';
import assert from 'node:assert/strict';
import { batchFailureSummary, isBatchBoundary, runBatch } from '../public/batch-actions.js';

test('bulk shot actions keep going after independent failures and summarize them', async () => {
  const shots = [{ position: 1 }, { position: 2 }, { position: 3 }];
  const attempted = [];
  const result = await runBatch(shots, async (shot) => {
    attempted.push(shot.position);
    if (shot.position !== 2) throw Object.assign(new Error('Temporary provider error'), { status: 503 });
  });
  assert.deepEqual(attempted, [1, 2, 3]);
  assert.match(batchFailureSummary('Animation', result), /2 shot\(s\) failed \(#1, #3\)/);
  assert.equal(result.stopped, false);
});

test('bulk shot actions stop after a shared spending, policy, or auth boundary', async () => {
  for (const error of [
    Object.assign(new Error('Budget exceeded'), { status: 402 }),
    Object.assign(new Error('Safety policy refusal'), { status: 400 }),
    Object.assign(new Error('Sign in again'), { status: 401 }),
  ]) {
    const attempted = [];
    const result = await runBatch([1, 2, 3], async (shot) => {
      attempted.push(shot);
      if (shot === 2) throw error;
    });
    assert.deepEqual(attempted, [1, 2]);
    assert.equal(result.stopped, true);
    assert.match(batchFailureSummary('Frames', result), /Stopped to avoid repeating a shared limit/);
  }
  assert.equal(isBatchBoundary(Object.assign(new Error('Provider unavailable'), { status: 503 })), false);
});
