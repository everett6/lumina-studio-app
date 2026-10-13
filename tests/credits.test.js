import assert from 'node:assert/strict';
import test from 'node:test';
import { createCreditMonitor } from '../src/credits.js';

test('key allowance is read-only, cached, and exposes no raw metadata or secrets', async () => {
  let calls = 0, clock = 0;
  const monitor = createCreditMonitor({ keys: { get: () => 'private-key' }, now: () => clock, get: async (url, options) => {
    calls++; assert.equal(url, 'https://openrouter.ai/api/v1/key'); assert.equal(options.headers.authorization, 'Bearer private-key');
    return { data: { limit: 12, limit_remaining: 8.5, usage: 3.5, usage_daily: 1.5, label: 'personal-label', hash: 'secret-hash', limit_reset: 'monthly' } };
  } });
  const result = await monitor.status();
  assert.equal(result.keyRemainingUsd,8.5);
  assert.equal(result.accountRemainingUsd,null);
  assert.equal(result.accountStatus,'requires_management_key');
  assert.ok(!/private-key|secret-hash|personal-label/.test(JSON.stringify(result)));
  assert.equal((await monitor.status()).cached,true); assert.equal(calls,1);
  clock = 31000; await monitor.status(); assert.equal(calls,2);
});

test('unknown, missing and failed allowance checks never invent available credit', async () => {
  const missing = createCreditMonitor({ keys: { get: () => null }, get: () => { throw Error('must not fetch'); } });
  assert.equal((await missing.status()).status,'missing_key');
  const unknown = createCreditMonitor({ keys: { get: () => 'k' }, get: async () => ({data:{limit:null,limit_remaining:null}}) });
  assert.equal((await unknown.status()).keyRemainingUsd,null);
  const failed = createCreditMonitor({ keys: { get: () => 'k' }, get: async () => { throw Object.assign(Error('secret provider response'),{category:'auth'}); } });
  const result = await failed.status(); assert.equal(result.status,'unavailable'); assert.equal(result.keyRemainingUsd,null);
  assert.ok(!JSON.stringify(result).includes('secret provider response'));
});

test('key rotation never serves the previous key balance while a refresh is pending', async () => {
  let key = 'a', complete;
  const monitor = createCreditMonitor({ keys: { get: () => key }, get: async () => key === 'a'
    ? { data: { limit_remaining: 10 } } : new Promise((resolve) => { complete = resolve; }) });
  await monitor.status();
  key = 'b';
  const first = monitor.status();
  const second = monitor.status();
  complete({ data: { limit_remaining: 1 } });
  assert.equal((await first).keyRemainingUsd, 1);
  assert.equal((await second).keyRemainingUsd, 1);
});

test('preflight counts all unresolved reservations, protects reserve and fails closed', async () => {
  let remaining = 3;
  const monitor = createCreditMonitor({ keys: { get: () => 'test' }, get: async () => ({ data: { limit_remaining: remaining } }) });
  let outstanding = { usd: 2, unpriced: 0 };
  const repo = { spend: { get: () => ({ estimatedUsd: 1 }), outstanding: () => outstanding } };
  await monitor.preflight({ repo, generationId: 'g', reserveUsd: 1 });
  remaining = 2.9;
  await assert.rejects(monitor.preflight({ repo, generationId: 'g', reserveUsd: 1 }), { category: 'credit_limit' });
  remaining = null;
  await assert.rejects(monitor.preflight({ repo, generationId: 'g' }), { category: 'credit_limit' });
  remaining = 100; outstanding = { usd: 1, unpriced: 1 };
  await assert.rejects(monitor.preflight({ repo, generationId: 'g' }), { category: 'credit_limit' });
});
