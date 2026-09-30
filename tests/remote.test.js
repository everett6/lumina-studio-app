import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestApp } from './helpers.js';

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

const form = (fields) => new URLSearchParams(fields).toString();

test('remote MCP: discovery → registration → pairing-code consent → PKCE token → tools over HTTP → refresh → revoke', async () => {
  const t = await startTestApp();
  const port = await freePort();
  const base = `http://localhost:${port}`;
  try {
    const status = (await t.call('PUT', '/api/settings/remote', { enabled: true, publicUrl: `${base}/`, port })).body;
    assert.equal(status.running, true, status.error);
    assert.equal(status.url, `${base}/mcp`);

    // An unauthenticated MCP call is rejected and points at the protected-resource metadata (how clients discover auth).
    const anonymous = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get('www-authenticate'), /resource_metadata="http:\/\/localhost:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
    const resourceMeta = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(resourceMeta.resource, `${base}/mcp`);
    const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.equal(meta.code_challenge_methods_supported[0], 'S256');

    // Dynamic client registration, as claude.ai and ChatGPT do.
    const redirect = 'https://claude.example/api/mcp/auth_callback';
    const client = await (await fetch(meta.registration_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
    })).json();
    assert.ok(client.client_id);

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorizeUrl = new URL(meta.authorization_endpoint);
    Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'st8', resource: `${base}/mcp` })
      .forEach(([k, v]) => authorizeUrl.searchParams.set(k, v));
    const consent = await fetch(authorizeUrl, { redirect: 'manual' });
    assert.equal(consent.status, 200);
    const page = await consent.text();
    assert.match(page, /Connect Claude to Lumina Studio\?/);
    const hidden = Object.fromEntries([...page.matchAll(/name="([a-z_]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, '&')]));

    const approve = (fields) => fetch(`${base}/authorize/approve`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(fields) });
    const wrong = await approve({ ...hidden, decision: 'approve', pairing_code: '000000' });
    assert.equal(wrong.status, 400);
    assert.match(await wrong.text(), /wrong or expired/);

    const { pairing } = (await t.call('POST', '/api/settings/remote/pairing', {})).body;
    assert.match(pairing.code, /^\d{6}$/);
    const approved = await approve({ ...hidden, decision: 'approve', pairing_code: pairing.code });
    assert.equal(approved.status, 302);
    const back = new URL(approved.headers.get('location'));
    assert.equal(`${back.origin}${back.pathname}`, redirect);
    assert.equal(back.searchParams.get('state'), 'st8');
    const code = back.searchParams.get('code');
    assert.equal((await approve({ ...hidden, decision: 'approve', pairing_code: pairing.code })).status, 400, 'pairing code is single-use');

    const token = async (fields) => fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(fields) });
    const badVerifier = await token({ grant_type: 'authorization_code', code, code_verifier: 'nope-nope-nope-nope-nope-nope-nope-nope-nope', client_id: client.client_id, redirect_uri: redirect });
    assert.equal(badVerifier.status, 400, 'PKCE verifier is checked');
    const tokens = await (await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: redirect })).json();
    assert.ok(tokens.access_token && tokens.refresh_token, JSON.stringify(tokens));

    // Real MCP over Streamable HTTP with the bearer token.
    const connect = async (accessToken) => {
      const mcp = new Client({ name: 'remote-test', version: '1.0.0' });
      await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }));
      return mcp;
    };
    const mcp = await connect(tokens.access_token);
    const { tools } = await mcp.listTools();
    assert.ok(tools.some((tool) => tool.name === 'create_book'));
    const created = await mcp.callTool({ name: 'create_project', arguments: { name: 'From claude.ai' } });
    assert.equal(JSON.parse(created.content[0].text).name, 'From claude.ai');
    const image = await mcp.callTool({ name: 'generate_image', arguments: { projectId: JSON.parse(created.content[0].text).id, prompt: 'a lighthouse', provider: 'mock', model: 'mock-image' } });
    assert.ok(image.content.some((c) => c.type === 'image'), 'images come back inline over HTTP');
    await mcp.close();

    // Refresh rotates tokens; the old refresh token stops working.
    const refreshed = await (await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).json();
    assert.ok(refreshed.access_token);
    assert.equal((await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).status, 400);

    const stats = (await t.call('GET', '/api/settings/remote')).body;
    assert.equal(stats.clients, 1);
    assert.ok(stats.activeTokens >= 1);
    await t.call('POST', '/api/settings/remote/revoke', {});
    const revoked = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${refreshed.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(revoked.status, 401);

    const off = (await t.call('PUT', '/api/settings/remote', { enabled: false })).body;
    assert.equal(off.running, false);
  } finally {
    await t.close();
  }
});

test('remote settings validation: non-HTTPS public URLs are refused', async () => {
  const t = await startTestApp();
  try {
    const status = (await t.call('PUT', '/api/settings/remote', { enabled: true, publicUrl: 'http://example.com', port: await freePort() })).body;
    assert.equal(status.running, false);
    assert.match(status.error, /https/);
    assert.equal((await t.call('PUT', '/api/settings/remote', { port: 80 })).status, 400);
  } finally {
    await t.close();
  }
});
