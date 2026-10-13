// Read-only provider allowance, exposed to MCP without credentials or raw account metadata.
import { requestJson } from './providers/http.js';
const number = (value) => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
export function createCreditMonitor({ keys, get = requestJson, now = () => Date.now(), ttlMs = 30_000 }) {
  let cached = null;
  let pending = null;
  let keyAtFetch = null;
  let cachedKey = null;
  async function status({ refresh = false } = {}) {
    const key = keys.get('openrouter');
    if (!key) return { configured: false, status: 'missing_key', checkedAt: null, keyRemainingUsd: null, accountRemainingUsd: null };
    if (!refresh && cached && cachedKey === key && now() - cached.fetchedMs < ttlMs) return { ...cached.public, cached: true };
    if (pending && keyAtFetch === key) return pending;
    keyAtFetch = key;
    pending = (async () => {
      const checkedAt = new Date(now()).toISOString();
      try {
        const result = await get('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${key}` }, timeoutMs: 15_000 });
        const data = result.data ?? {};
        const remaining = number(data.limit_remaining);
        const value = {
          configured: true, status: 'available', checkedAt, cached: false,
          keyLimitUsd: number(data.limit), keyRemainingUsd: remaining === null ? null : Math.max(0, remaining),
          keyUsageUsd: number(data.usage), dailyUsageUsd: number(data.usage_daily), monthlyUsageUsd: number(data.usage_monthly),
          limitReset: typeof data.limit_reset === 'string' ? data.limit_reset : null,
          accountRemainingUsd: null, accountStatus: 'requires_management_key',
          note: remaining === null ? 'The key has no reported remaining limit; this is not proof of unlimited account credit.' : 'Read-only allowance for the configured API key. Account-wide credit balance is not available with a normal generation key.',
        };
        // Cache only the explicitly selected public fields. Never expose labels, hashes or credentials.
        if (keyAtFetch === key) { cached = { fetchedMs: now(), public: value }; cachedKey = key; }
        return value;
      } catch (error) {
        return { configured: true, status: 'unavailable', checkedAt, cached: false, keyRemainingUsd: null, accountRemainingUsd: null,
          reason: error.category === 'auth' ? 'Provider rejected the configured key.' : 'Provider allowance could not be checked. Do not infer a balance.' };
      }
    })();
    const mine = pending;
    try { return await mine; } finally { if (pending === mine) pending = null; }
  }
  async function preflight({ repo, generationId, reserveUsd = 0 }) {
    const row = repo.spend.get(generationId);
    const snapshot = await status({ refresh: true });
    const outstanding = repo.spend.outstanding('openrouter');
    if (snapshot.status !== 'available' || snapshot.keyRemainingUsd == null || !row || row.estimatedUsd == null || outstanding.unpriced > 0) {
      throw Object.assign(new Error('OpenRouter allowance or request cost is unavailable. Use a local model until a bounded allowance can be verified.'), { category: 'credit_limit' });
    }
    // Unknown outcomes may already be reflected in the provider balance. Count them again conservatively;
    // never subtract past settled charges twice or ignore queued/concurrent reservations.
    if (outstanding.usd + reserveUsd > snapshot.keyRemainingUsd + 1e-9) {
      throw Object.assign(new Error('OpenRouter key allowance is below outstanding reservations plus the protected retry reserve. No paid request was submitted.'), { category: 'credit_limit' });
    }
    return snapshot;
  }
  return { status, preflight };
}
