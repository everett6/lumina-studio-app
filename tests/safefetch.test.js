import assert from 'node:assert/strict';
import test from 'node:test';
import { privateAddress, safeFetch } from '../src/safefetch.js';

test('private addresses include IPv4-mapped IPv6 in both dotted and hex form', async () => {
  for (const a of ['127.0.0.1', '10.0.0.4', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:4', 'fd00::1']) assert.equal(privateAddress(a), true, a);
  for (const a of ['93.184.216.34', '::ffff:5db8:d822', '2606:4700::1111']) assert.equal(privateAddress(a), false, a);
  // URL parsing turns [::ffff:127.0.0.1] into [::ffff:7f00:1]; it must still be refused before any connection.
  await assert.rejects(safeFetch('https://[::ffff:127.0.0.1]/x'), /private/);
  await assert.rejects(safeFetch('http://example.com/'), /https/);
});
