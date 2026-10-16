import { createHash } from 'node:crypto';

// Spending limits for paid generations.
//
// Every paid request is estimated before it is queued and the estimate is reserved in the spend ledger; when it
// finishes, the reservation is settled with the provider's reported charge (OpenRouter returns usage.cost), kept
// as the estimate when the provider reports nothing, released when the provider refused the request, or kept as
// "unknown" when Lumina cannot tell whether it was billed. Unknown and reserved money still counts against limits.
//
// The check and the reservation happen synchronously in one database transaction, so requests arriving together
// (several MCP calls at once) cannot jointly overspend: Node runs them one after another.
// Paid execution without a bounded estimate is refused by the generation service.

export const defaultBudget = {
  enabled: true, // new installs start with the requested $12 protections
  strictPrices: true, // $12 anime profile rejects prices without a known unit cost
  totalUsd: 12, // hard cap since `since`
  dailyUsd: null,
  projectUsd: null,
  perRequestUsd: 2,
  approvalAboveUsd: 1, // single requests above this need an approval
  retryReserveUsd: 1, // the last part of the total is kept for retries of earlier requests
  confirmPaid: true, // the app asks before any click that would use paid credits
  mcpCanApprove: false, // let MCP clients (Claude, ChatGPT) approve requests themselves
  speechAssumedUsd: 0.05, // reserved per narration request for voices without a per-request price
  since: null,
};

const money = (n) => `$${Number(n).toFixed(2)}`;
const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

export class BudgetError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.status = 402;
    this.extra = extra;
  }
}

export function requestSignature(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

// Accounting metadata uses the existing JSON columns. Legacy scalar fields remain readable.
export function billingState(generation) {
  if (generation?.providerJob?.billingState) return generation.providerJob.billingState;
  if (generation?.providerJob?.phase === 'submitting') return 'billing_unknown';
  if (generation?.providerJob && ['id', 'name', 'statusUrl', 'pollUrl', 'downloadUrl'].some((k) => generation.providerJob[k])) return 'submitted';
  if (generation?.billing === 'none') return 'confirmed_unbilled';
  if (generation?.billing === 'charged') return 'charged';
  if (generation?.billing === 'unknown') return 'billing_unknown';
  return generation?.params?.accounting?.billingState ?? generation?.billingState ?? 'not_submitted';
}

export function submissionStarted(generation) {
  const marker = generation?.providerJob;
  return Boolean(marker && (marker.phase || marker.submittedAt || marker.requestIds?.length
    || ['id', 'name', 'statusUrl', 'pollUrl', 'downloadUrl'].some((key) => marker[key])))
    || ['submitted', 'completed_remote', 'download_failed', 'billing_unknown', 'charged'].includes(billingState(generation));
}

export function updateBilling(repo, id, state, fields = {}) {
  const current = repo.generations.get(id);
  if (!current) return null;
  return repo.generations.update(id, { ...fields,
    providerJob: { ...current.providerJob, ...fields.providerJob, billingState: state } });
}

export function createBudget({ repo }) {
  const settings = () => ({ ...defaultBudget, ...repo.settings.get('budget', {}) });

  function update(changes = {}) {
    const next = { ...settings() };
    const usd = (key, { nullable = true } = {}) => {
      if (changes[key] === undefined) return;
      if (changes[key] === null || changes[key] === '') {
        if (!nullable) throw Object.assign(new Error(`${key} is required.`), { status: 400 });
        next[key] = null;
        return;
      }
      const value = Number(changes[key]);
      if (!Number.isFinite(value) || value < 0 || value > 100_000) throw Object.assign(new Error(`${key} must be a dollar amount.`), { status: 400 });
      next[key] = Math.round(value * 100) / 100;
    };
    usd('totalUsd', { nullable: false });
    ['dailyUsd', 'projectUsd', 'perRequestUsd', 'approvalAboveUsd', 'retryReserveUsd'].forEach((key) => usd(key));
    usd('speechAssumedUsd', { nullable: false });
    for (const key of ['enabled', 'mcpCanApprove', 'strictPrices', 'confirmPaid']) if (typeof changes[key] === 'boolean') next[key] = changes[key];
    if (changes.resetSpending === true) next.since = new Date().toISOString();
    repo.settings.set('budget', next);
    return status();
  }

  function status() {
    const s = settings();
    const spent = repo.spend.total({ since: s.since });
    return {
      ...repo.spend.breakdown?.({ since: s.since }),
      settings: s, spentUsd: spent.usd, requests: spent.count, todayUsd: repo.spend.total({ since: s.since && s.since > startOfToday() ? s.since : startOfToday() }).usd,
      remainingUsd: Math.max(0, Math.round((s.totalUsd - spent.usd) * 100) / 100),
      byModel: repo.spend.byModel(), recent: repo.spend.list(30), approvals: repo.approvals.list('pending'),
    };
  }

  // Repository totals are rounded for display. Authorization must retain sub-cent precision.
  function countedUsd(options = {}) {
    const displayed = repo.spend.total(options).usd;
    const exact = repo.spend.list?.(Number.MAX_SAFE_INTEGER).filter((row) =>
      ['reserved', 'charged', 'unknown'].includes(row.status)
      && (!options.since || row.createdAt >= options.since)
      && (!options.projectId || row.projectId === options.projectId))
      .reduce((sum, row) => sum + (row.actualUsd ?? row.estimatedUsd ?? 0), 0) ?? displayed;
    return Math.max(displayed, exact);
  }

  // Throws BudgetError when the request may not start; otherwise returns the amount to reserve.
  // Called inside the transaction that creates the generation, so check + reserve are atomic.
  function authorize({ projectId, estimateUsd, isRetry = false, approvalId = null, source = 'app', signature, summary }) {
    const s = settings();
    if (!s.enabled) return { reserveUsd: estimateUsd, approval: null };
    let reserveUsd = estimateUsd;
    const unpriced = estimateUsd == null;
    if (unpriced && s.strictPrices) throw new BudgetError('Strict budget: this request has no known price. Use a priced cloud model or a local model.', { unpriced: true });
    if (unpriced) {
      if (s.perRequestUsd == null) throw new BudgetError('This model has no published price, and without a per-request limit Lumina cannot cap it. Set a per-request limit in Settings → Budget, or choose a priced model.', { unpriced: true });
      reserveUsd = s.perRequestUsd; // a hard ceiling stands in for the unknown price
    }
    if (s.perRequestUsd != null && estimateUsd != null && estimateUsd > s.perRequestUsd) {
      throw new BudgetError(`This request is estimated at ${money(estimateUsd)}, over the ${money(s.perRequestUsd)} per-request limit.`, { estimateUsd });
    }
    const spent = countedUsd({ since: s.since });
    const ceiling = s.totalUsd - (isRetry ? 0 : s.retryReserveUsd ?? 0);
    if (spent + reserveUsd > ceiling + 1e-9) {
      throw new BudgetError(`Budget: ${money(spent)} of ${money(s.totalUsd)} is spent or reserved; this request needs ${money(reserveUsd)}${!isRetry && s.retryReserveUsd ? ` and ${money(s.retryReserveUsd)} is kept back for retries` : ''}.`, { spentUsd: spent, estimateUsd: reserveUsd });
    }
    if (s.dailyUsd != null) {
      const today = countedUsd({ since: startOfToday() });
      if (today + reserveUsd > s.dailyUsd + 1e-9) throw new BudgetError(`Daily limit: ${money(today)} of ${money(s.dailyUsd)} used today.`, { todayUsd: today });
    }
    if (s.projectUsd != null) {
      const project = countedUsd({ since: s.since, projectId });
      if (project + reserveUsd > s.projectUsd + 1e-9) throw new BudgetError(`Project limit: ${money(project)} of ${money(s.projectUsd)} used in this project.`, { projectUsd: project });
    }
    const needsApproval = unpriced || (s.approvalAboveUsd != null && reserveUsd > s.approvalAboveUsd);
    if (!needsApproval) return { reserveUsd, approval: null };
    // Without an id, an approval already given in the app for this exact request is used (e.g. by film production).
    const approval = approvalId ? repo.approvals.get(approvalId) : repo.approvals.approvedFor(signature);
    if (approval?.status === 'approved' && approval.signature === signature) return { reserveUsd, approval };
    if (approval && approval.signature !== signature) throw new BudgetError('That approval was given for a different request.', { approvalMismatch: true });
    const pending = repo.approvals.pendingFor(signature) ?? repo.approvals.create({ signature, summary, estimatedUsd: estimateUsd, requestedBy: source });
    throw new BudgetError(unpriced
      ? `This model has no published price, so it needs approval (up to ${money(reserveUsd)} will be reserved). Approve it in Lumina → Settings → Budget, then send the request again with approvalId.`
      : `This request is estimated at ${money(reserveUsd)}, above the ${money(s.approvalAboveUsd)} approval threshold. Approve it in Lumina → Settings → Budget, then send it again with approvalId.`,
    { needsApproval: true, approvalId: pending.id, estimateUsd });
  }

  function decide(id, approve, source = 'app') {
    if (source === 'mcp' && !settings().mcpCanApprove) throw Object.assign(new Error('Approvals must be given in the Lumina app (Settings → Budget). MCP approval is turned off.'), { status: 403 });
    const approval = repo.approvals.get(id);
    if (!approval) throw Object.assign(new Error('Approval not found.'), { status: 404 });
    if (!repo.approvals.decide(id, approve ? 'approved' : 'denied')) throw Object.assign(new Error(`This approval is already ${approval.status}.`), { status: 409 });
    return repo.approvals.get(id);
  }

  // After a job ends: settle its reservation. `usage.cost` is the provider's own figure when it gives one.
  function settle(generation, { outcome, usage }) {
    const row = repo.spend.get(generation.id);
    if (!row) return null;
    // Explicit reconciliation is authoritative, including across late poll/download callbacks.
    if (row.status === 'released') return row;
    if (row.status === 'charged') return row;
    if (outcome === 'refused' && billingState(repo.generations.get(generation.id)) !== 'confirmed_unbilled'
      && submissionStarted(repo.generations.get(generation.id))) outcome = 'unknown';
    const rawCost = usage?.cost;
    const cost = rawCost == null || rawCost === '' ? NaN : Number(rawCost);
    if (outcome === 'completed' && Number.isFinite(cost) && cost >= 0) return repo.spend.settle(generation.id, { status: 'charged', actualUsd: cost, note: 'Provider-reported charge' });
    if (outcome === 'completed') return repo.spend.settle(generation.id, { status: 'charged', note: 'Provider gave no charge; counted at the estimate' });
    if (outcome === 'refused') return repo.spend.settle(generation.id, { status: 'released', actualUsd: 0, note: 'The provider refused the request before running it' });
    return repo.spend.settle(generation.id, { status: 'unknown', actualUsd: Math.max(row.estimatedUsd ?? 0, row.actualUsd ?? 0, Number.isFinite(cost) && cost >= 0 ? cost : 0), note: 'Lumina cannot tell whether this was billed; still counted. Check the provider\'s activity page, then mark it.' });
  }

  // The user checked the provider's records and says what the job really cost (0 = not billed).
  function resolve(generationId, actualUsd) {
    const row = repo.spend.get(generationId);
    if (!row) throw Object.assign(new Error('No spending record for that generation.'), { status: 404 });
    const usd = actualUsd == null || String(actualUsd).trim() === '' ? NaN : Number(actualUsd);
    if (!Number.isFinite(usd) || usd < 0) throw Object.assign(new Error('Enter what the provider charged (0 if nothing).'), { status: 400 });
    return repo.transaction(() => {
      updateBilling(repo, generationId, usd === 0 ? 'confirmed_unbilled' : 'charged', { billing: usd === 0 ? 'none' : 'charged' });
      return repo.spend.settle(generationId, usd === 0 ? { status: 'released', actualUsd: 0, note: 'Marked not billed' } : { status: 'charged', actualUsd: usd, note: 'Charge entered by you' });
    });
  }

  return { settings, update, status, authorize, decide, settle, resolve };
}
