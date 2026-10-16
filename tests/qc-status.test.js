import assert from 'node:assert/strict';
import test from 'node:test';
import { animeChecks, identityNotVerified, suggestedStatus, withStatus } from '../src/qc.js';

test('every check reports passed, failed or unavailable; unavailable is never a pass', async () => {
  assert.equal(withStatus({ id: 'a', ok: true }).status, 'passed');
  assert.equal(withStatus({ id: 'b', ok: false }).status, 'failed');
  const broken = await animeChecks('/nonexistent/clip.mp4');
  const review = broken.find((c) => c.id === 'anime-review');
  assert.equal(review.status, 'unavailable');
  assert.equal(review.ok, false, 'a check that could not run does not count as passed');
});

test('anime identity is reported as not verified, not implied by the colour check', () => {
  const id = identityNotVerified('anime');
  assert.equal(id.status, 'unavailable');
  assert.equal(id.ok, false);
  assert.match(id.detail, /not verified/);
  assert.equal(suggestedStatus([id]), 'needs_review', 'an unverified identity asks for a human look, not a regeneration');
  assert.match(identityNotVerified('live-action').detail, /face checker/);
});
