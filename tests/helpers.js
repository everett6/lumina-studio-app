import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startLumina } from '../src/app.js';
import { encodePng } from '../src/png.js';

process.env.LUMINA_MOCK_DELAY_MS = '20';
process.env.LUMINA_OFFLINE = '1'; // tests never reach the network (no model-list refresh)
// Tests never use a real local GPU model, even when one is installed on this computer: point at an empty model cache.
process.env.HF_HUB_CACHE = mkdtempSync(path.join(tmpdir(), 'lumina-hf-empty-'));

export const tinyPng = () => encodePng(4, 4, () => [200, 40, 40]);
export const tinyPngDataUrl = () => `data:image/png;base64,${tinyPng().toString('base64')}`;
export const quietLog = { info() {}, error() {} };

export function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'lumina-test-'));
}

export async function startTestApp(options = {}) {
  const dataRoot = options.dataRoot ?? tempRoot();
  const app = await startLumina({ dataRoot, enableMock: true, log: quietLog, ...options });
  // General workflow fixtures simulate the earlier unrestricted mock profile. Budget-specific tests
  // explicitly enable limits; pass budgetSettings: {} to exercise safe shipping defaults.
  if (app.repo.settings.get('budget', null) === null) app.repo.settings.set('budget', options.budgetSettings ?? { enabled: false, strictPrices: false, confirmPaid: false });
  const call = async (method, url, body, { auth = true, headers = {} } = {}) => {
    const response = await fetch(`${app.origin}${url}`, {
      method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(auth ? { authorization: `Bearer ${app.token}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* binary or html */ }
    return { status: response.status, body: json, headers: response.headers, text };
  };
  return {
    app, call, dataRoot,
    async close({ keep = false } = {}) {
      await app.close();
      if (!keep) rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

// Replace global fetch with a scripted fake for provider adapter tests.
export function fakeFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const result = await handler(String(url), options, calls.length);
    const body = Buffer.isBuffer(result.body) ? result.body : JSON.stringify(result.body ?? {});
    return new Response(body, { status: result.status ?? 200 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
