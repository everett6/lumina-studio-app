// Run independent shot actions while avoiding repeated failures at shared boundaries.
export function isBatchBoundary(error) {
  const category = String(error?.data?.category ?? error?.data?.code ?? error?.category ?? '').toLowerCase();
  if ([401, 403, 402, 428, 429].includes(error?.status)) return true;
  if (/auth|policy|moderation|budget|credit|spend|approval/.test(category)) return true;
  return /policy|moderation|safety|budget|credit|unauthori[sz]ed|sign in|approval required/i.test(error?.message ?? '');
}

export async function runBatch(items, action, stopOnBoundary = isBatchBoundary) {
  const failures = [];
  let stopped = false;
  for (const item of items) {
    try { await action(item); }
    catch (error) {
      failures.push({ item, error });
      if (stopOnBoundary(error)) { stopped = true; break; }
    }
  }
  return { failures, stopped };
}

export function batchFailureSummary(label, result, name = (item) => item.position ?? item.id) {
  if (!result.failures.length) return '';
  const failed = result.failures.map(({ item }) => `#${name(item)}`).join(', ');
  const boundary = result.stopped ? ` Stopped to avoid repeating a shared limit: ${result.failures.at(-1).error.message}` : '';
  return `${label}: ${result.failures.length} shot(s) failed (${failed}).${boundary}`;
}
