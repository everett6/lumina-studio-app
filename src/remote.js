import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { registerLuminaTools } from '../mcp/tools.js';
import { createTunnel } from './tunnel.js';

// Remote MCP endpoint for claude.ai connectors and ChatGPT apps.
//
// Lumina listens on 127.0.0.1:<port>; the user exposes that port through an HTTPS tunnel of their choice
// (Cloudflare Tunnel, Tailscale Funnel, ngrok…) and enters the public URL in Settings. Connecting clients
// register themselves (OAuth dynamic client registration), then the user approves the connection in a browser
// page by typing the pairing code shown in Lumina's Settings. Keys, files and jobs never leave this computer.
//
// "Host online" does the tunnel part in one click (Cloudflare quick tunnel, see tunnel.js). The same public
// address also serves the Lumina website itself: visitors sign in with a pairing code, then every request is
// passed to the local app with its token. Website sign-ins last 30 days and are revoked with everything else.

const accessTtlSeconds = 3600;
const refreshTtlSeconds = 30 * 24 * 3600;
const codeTtlMs = 5 * 60_000;
const pairingTtlMs = 15 * 60_000;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const defaultRemoteSettings = { enabled: false, publicUrl: '', port: 8787, hosted: false };
const webTtlMs = 30 * 24 * 3600 * 1000;
const webCookie = (req) => /(?:^|;\s*)lumina_web=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1];

export function createRemoteGateway({ repo, localOrigin, localToken, exportDir, binDir, tunnelCommand, log = console }) {
  const tunnel = createTunnel({ binDir: binDir ?? exportDir, log, command: tunnelCommand });
  const codes = new Map();
  let pairing = null;
  let failedAttempts = [];
  let server = null;
  let status = { running: false, error: null, url: null };

  const settings = () => ({ ...defaultRemoteSettings, ...repo.settings.get('remote', {}) });

  function newPairingCode() {
    pairing = { code: String(randomInt(0, 1_000_000)).padStart(6, '0'), expiresAt: Date.now() + pairingTtlMs };
    return pairing;
  }
  const pairingInfo = () => (pairing && pairing.expiresAt > Date.now() ? { code: pairing.code, expiresAt: pairing.expiresAt } : null);

  function checkPairing(given) {
    const now = Date.now();
    failedAttempts = failedAttempts.filter((t) => now - t < 10 * 60_000);
    if (failedAttempts.length >= 8) return 'Too many wrong codes. Wait ten minutes, then try again with a new code.';
    const current = pairingInfo();
    const ok = current && typeof given === 'string' && given.length === current.code.length && timingSafeEqual(Buffer.from(given), Buffer.from(current.code));
    if (!ok) {
      failedAttempts.push(now);
      return 'That code is wrong or expired. Check Lumina → Settings → Remote access.';
    }
    pairing = null; // single use
    return null;
  }

  function issueTokens(clientId, scopes, resource) {
    const access = newToken();
    const refresh = newToken();
    const now = Date.now();
    repo.oauth.saveToken({ tokenHash: hash(access), kind: 'access', clientId, scopes, resource, expiresAt: now + accessTtlSeconds * 1000 });
    repo.oauth.saveToken({ tokenHash: hash(refresh), kind: 'refresh', clientId, scopes, resource, expiresAt: now + refreshTtlSeconds * 1000 });
    return { access_token: access, token_type: 'bearer', expires_in: accessTtlSeconds, refresh_token: refresh, scope: scopes.join(' ') };
  }

  const provider = {
    clientsStore: {
      getClient: (clientId) => repo.oauth.getClient(clientId),
      registerClient(client) {
        repo.oauth.saveClient(client);
        return client;
      },
    },
    // The consent page: the person connecting must type the pairing code shown inside Lumina.
    async authorize(client, params, res) {
      const fields = {
        client_id: client.client_id, redirect_uri: params.redirectUri, code_challenge: params.codeChallenge,
        state: params.state ?? '', scope: (params.scopes ?? []).join(' '), resource: params.resource?.href ?? '',
      };
      res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
      res.setHeader('x-frame-options', 'DENY');
      res.type('html').send(consentPage({ clientName: client.client_name || 'An MCP client', redirect: params.redirectUri, fields }));
    },
    async challengeForAuthorizationCode(client, code) {
      const entry = codes.get(code);
      if (!entry || entry.clientId !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
      return entry.challenge;
    },
    async exchangeAuthorizationCode(client, code, verifier, redirectUri) {
      const entry = codes.get(code);
      codes.delete(code);
      if (!entry || entry.clientId !== client.client_id || entry.expiresAt < Date.now()) throw new InvalidGrantError('Invalid or expired authorization code');
      if (redirectUri && redirectUri !== entry.redirectUri) throw new InvalidGrantError('redirect_uri mismatch');
      return issueTokens(client.client_id, entry.scopes, entry.resource);
    },
    async exchangeRefreshToken(client, refreshToken) {
      const stored = repo.oauth.getToken(hash(refreshToken));
      if (!stored || stored.kind !== 'refresh' || stored.clientId !== client.client_id || stored.expiresAt < Date.now()) throw new InvalidGrantError('Invalid refresh token');
      repo.oauth.deleteToken(hash(refreshToken)); // rotate
      return issueTokens(client.client_id, stored.scopes, stored.resource);
    },
    async verifyAccessToken(token) {
      const stored = repo.oauth.getToken(hash(token));
      if (!stored || stored.kind !== 'access' || stored.expiresAt < Date.now()) throw new InvalidTokenError('Invalid or expired token');
      return { token, clientId: stored.clientId, scopes: stored.scopes, expiresAt: Math.floor(stored.expiresAt / 1000), resource: stored.resource ? new URL(stored.resource) : undefined };
    },
    async revokeToken(client, { token }) {
      const stored = repo.oauth.getToken(hash(token));
      if (stored?.clientId === client.client_id) repo.oauth.deleteToken(hash(token));
    },
  };

  // The tools run inside this process and reach Lumina through its own loopback API.
  const toolClient = {
    async call(method, route, body) {
      const response = await fetch(`${localOrigin()}${route}`, {
        method, headers: { authorization: `Bearer ${localToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(660_000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Lumina returned HTTP ${response.status}`);
      return data;
    },
    fetchRaw: (route) => fetch(`${localOrigin()}${route}`, { headers: { authorization: `Bearer ${localToken}` }, signal: AbortSignal.timeout(660_000) }),
    exportDir: () => exportDir,
    allowOutputPath: false,
  };

  function buildApp(publicUrl) {
    const base = new URL(publicUrl);
    const mcpUrl = new URL('/mcp', base);
    const app = express();
    app.disable('x-powered-by');
    // Tunnels forward from localhost; trust one proxy hop so rate limits see the real client address.
    app.set('trust proxy', 1);
    app.use(mcpAuthRouter({
      provider, issuerUrl: base, baseUrl: base, resourceServerUrl: mcpUrl, scopesSupported: ['lumina'], resourceName: 'Lumina Studio',
    }));
    app.post('/authorize/approve', express.urlencoded({ extended: false, limit: '16kb' }), async (req, res) => {
      const body = req.body ?? {};
      const client = await provider.clientsStore.getClient(String(body.client_id ?? ''));
      const redirect = String(body.redirect_uri ?? '');
      if (!client || !client.redirect_uris?.includes(redirect)) return res.status(400).type('text').send('Unknown client or redirect URI.');
      const fields = { client_id: client.client_id, redirect_uri: redirect, code_challenge: String(body.code_challenge ?? ''), state: String(body.state ?? ''), scope: String(body.scope ?? ''), resource: String(body.resource ?? '') };
      res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
      if (body.decision !== 'approve') {
        const url = new URL(redirect);
        url.searchParams.set('error', 'access_denied');
        if (fields.state) url.searchParams.set('state', fields.state);
        return res.redirect(302, url.href);
      }
      const problem = checkPairing(String(body.pairing_code ?? '').trim());
      if (problem) return res.status(400).type('html').send(consentPage({ clientName: client.client_name || 'An MCP client', redirect, fields, error: problem }));
      const code = newToken();
      codes.set(code, {
        clientId: client.client_id, challenge: fields.code_challenge, redirectUri: redirect, expiresAt: Date.now() + codeTtlMs,
        scopes: fields.scope ? fields.scope.split(' ') : ['lumina'], resource: fields.resource || mcpUrl.href,
      });
      const url = new URL(redirect);
      url.searchParams.set('code', code);
      if (fields.state) url.searchParams.set('state', fields.state);
      log.info?.('Remote MCP client approved', { client: client.client_name ?? client.client_id });
      return res.redirect(302, url.href);
    });

    const auth = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });
    // Stateless Streamable HTTP: a fresh server + transport per request, no session affinity needed through a tunnel.
    app.post('/mcp', auth, express.json({ limit: '4mb' }), async (req, res) => {
      const mcp = new McpServer({ name: 'lumina-studio', version: '0.4.0' });
      registerLuminaTools(mcp, toolClient);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        transport.close();
        mcp.close();
      });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        log.error?.('Remote MCP request failed', { detail: error.message });
        if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      }
    });
    const notAllowed = (req, res) => res.status(405).set('allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
    app.get('/mcp', auth, notAllowed);
    app.delete('/mcp', auth, notAllowed);
    // The website: sign in with a pairing code, then everything else is the normal Lumina app.
    const secure = base.protocol === 'https:' ? '; Secure' : '';
    const pageHeaders = (res) => {
      res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
      res.setHeader('x-frame-options', 'DENY');
      res.setHeader('cache-control', 'no-store');
    };
    app.get('/login', (req, res) => {
      pageHeaders(res);
      res.type('html').send(loginPage({}));
    });
    app.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
      pageHeaders(res);
      const problem = checkPairing(String(req.body?.pairing_code ?? '').trim());
      if (problem) return res.status(400).type('html').send(loginPage({ error: problem }));
      const session = newToken();
      repo.oauth.saveToken({ tokenHash: hash(session), kind: 'web', clientId: 'website', scopes: ['web'], resource: null, expiresAt: Date.now() + webTtlMs });
      log.info?.('Website sign-in approved');
      res.setHeader('set-cookie', `lumina_web=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${webTtlMs / 1000}${secure}`);
      return res.redirect(303, '/');
    });
    app.post('/logout', (req, res) => {
      const session = webCookie(req);
      if (session) repo.oauth.deleteToken(hash(session));
      res.setHeader('set-cookie', `lumina_web=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
      res.redirect(303, '/login');
    });
    app.use((req, res) => {
      const session = webCookie(req);
      const stored = session ? repo.oauth.getToken(hash(session)) : null;
      if (!stored || stored.kind !== 'web' || stored.expiresAt < Date.now()) {
        if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/assets/')) return res.redirect(302, '/login');
        return res.status(401).json({ error: 'Sign in again at /login.' });
      }
      // Same-origin writes only, as the local app enforces for itself.
      if (req.headers.origin && req.headers.origin !== base.origin) return res.status(403).json({ error: 'Forbidden origin' });
      const target = new URL(localOrigin());
      const headers = { ...req.headers, host: target.host, authorization: `Bearer ${localToken}` };
      for (const name of ['cookie', 'origin', 'referer', 'connection', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'cf-connecting-ip']) delete headers[name];
      const upstream = http.request({ hostname: target.hostname, port: target.port, method: req.method, path: req.originalUrl, headers }, (answer) => {
        const out = { ...answer.headers };
        delete out['set-cookie'];
        res.writeHead(answer.statusCode ?? 502, out);
        answer.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.status(502).json({ error: 'Lumina is not answering.' }); else res.end(); });
      req.pipe(upstream);
    });
    return app;
  }

  async function stop() {
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    server = null;
    status = { running: false, error: null, url: null };
  }

  async function start() {
    await stop();
    const current = settings();
    if (!current.enabled) return status;
    let base;
    try {
      base = new URL(current.publicUrl);
      if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('The public URL must start with https://');
    } catch (error) {
      status = { running: false, error: error.message.includes('https') ? error.message : 'Enter the public HTTPS URL of your tunnel.', url: null };
      return status;
    }
    const app = buildApp(base.origin);
    await new Promise((resolve) => {
      server = app.listen(current.port, '127.0.0.1', resolve);
      server.on('error', (error) => {
        status = { running: false, error: error.code === 'EADDRINUSE' ? `Port ${current.port} is already in use.` : error.message, url: null };
        server = null;
        resolve();
      });
    });
    if (server) status = { running: true, error: null, url: new URL('/mcp', base).href, localPort: server.address().port };
    return status;
  }

  // One click: start a quick tunnel to the gateway port, then turn remote access on at the address it gives.
  async function goOnline({ allowDownload = false } = {}) {
    await stop();
    const port = await usablePort(settings().port);
    const url = await tunnel.start(port, { allowDownload });
    repo.settings.set('remote', { ...settings(), port, enabled: true, publicUrl: url, hosted: true });
    await start();
    if (!status.running) {
      const problem = status.error;
      tunnel.stop();
      repo.settings.set('remote', { ...settings(), enabled: false, hosted: false });
      throw Object.assign(new Error(`Could not start remote access: ${problem}`), { status: 502 });
    }
    if (!pairingInfo()) newPairingCode();
    return api.status();
  }

  async function goOffline() {
    tunnel.stop();
    repo.settings.set('remote', { ...settings(), enabled: false, hosted: false });
    await stop();
    return api.status();
  }

  const api = {
    start, stop, settings, goOnline, goOffline,
    // At launch: bring the public address back if it was on when Lumina last closed (it will be a new address).
    async resume() {
      if (!settings().hosted) return null;
      try {
        return await goOnline();
      } catch (error) {
        log.error?.('Could not go back online', { detail: error.message });
        return null;
      }
    },
    async shutdown() {
      tunnel.stop();
      await stop();
    },
    status: async () => {
      const current = settings();
      const site = status.running ? new URL('/', current.publicUrl).href : null;
      return { ...status, site, settings: current, pairing: pairingInfo(), tunnel: await tunnel.status(), ...repo.oauth.stats() };
    },
    async update(changes) {
      const next = { ...settings() };
      if (typeof changes.enabled === 'boolean') next.enabled = changes.enabled;
      if (typeof changes.publicUrl === 'string') next.publicUrl = changes.publicUrl.trim().replace(/\/+$/, '').replace(/\/mcp$/, '');
      if (changes.port !== undefined) {
        const port = Number(changes.port);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Object.assign(new Error('Choose a port between 1024 and 65535.'), { status: 400 });
        next.port = port;
      }
      // Typing an address by hand means the user runs their own tunnel.
      if (typeof changes.publicUrl === 'string' && changes.publicUrl.trim() && next.hosted) {
        tunnel.stop();
        next.hosted = false;
      }
      repo.settings.set('remote', next);
      await start();
      return api.status();
    },
    newPairingCode: () => ({ ...newPairingCode() }),
    revokeAll() {
      repo.oauth.revokeAll();
      codes.clear();
    },
  };
  return api;
}

// The configured port when it is free, otherwise any free one (one-click hosting should not fail on a busy port).
function usablePort(preferred) {
  const tryPort = (port) => new Promise((resolve) => {
    const probe = net.createServer().once('error', () => resolve(null)).listen(port, '127.0.0.1', () => {
      const { port: got } = probe.address();
      probe.close(() => resolve(got));
    });
  });
  return tryPort(preferred).then((port) => port ?? tryPort(0));
}

function loginPage({ error }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in · Lumina Studio</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#11110f;color:#eeede8;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{max-width:400px;width:100%;background:#181816;border:1px solid #2b2b27;border-radius:12px;padding:24px;box-sizing:border-box}h1{font-size:20px;margin:0 0 8px}
p{color:#b8b8ae}input{font:24px ui-monospace,monospace;letter-spacing:.3em;width:100%;padding:10px;box-sizing:border-box;background:#11110f;color:#eeede8;border:1px solid #3a3a34;border-radius:8px;text-align:center}
button{width:100%;margin-top:16px;padding:10px;border-radius:8px;border:0;font-weight:600;cursor:pointer;background:#d4f579;color:#171812}.error{color:#ff8f7a}</style></head>
<body><main><h1>Open Lumina Studio</h1>
<p>Enter the 6-digit pairing code from <b>Lumina → Settings → Remote access</b> on the computer running Lumina.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/login"><input name="pairing_code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus aria-label="Pairing code">
<button>Sign in</button></form></main></body></html>`;
}

function consentPage({ clientName, redirect, fields, error }) {
  const host = (() => { try { return new URL(redirect).host; } catch { return redirect; } })();
  const hidden = Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect to Lumina Studio</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#11110f;color:#eeede8;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{max-width:440px;background:#181816;border:1px solid #2b2b27;border-radius:12px;padding:24px}h1{font-size:20px;margin:0 0 8px}
p{color:#b8b8ae}code{background:#24241f;padding:1px 6px;border-radius:4px}input[name=pairing_code]{font:24px ui-monospace,monospace;letter-spacing:.3em;width:100%;padding:10px;box-sizing:border-box;background:#11110f;color:#eeede8;border:1px solid #3a3a34;border-radius:8px;text-align:center}
.row{display:flex;gap:10px;margin-top:16px}button{flex:1;padding:10px;border-radius:8px;border:0;font-weight:600;cursor:pointer}
.approve{background:#d4f579;color:#171812}.deny{background:#2a2a25;color:#eeede8}.error{color:#ff8f7a}</style></head>
<body><main><h1>Connect ${escapeHtml(clientName)} to Lumina Studio?</h1>
<p>It will be able to use your Lumina projects and <b>spend credits on your AI provider keys</b> (images, video, narration, writing). It will return to <code>${escapeHtml(host)}</code>.</p>
<p>Enter the 6-digit pairing code from <b>Lumina → Settings → Remote access</b>:</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/authorize/approve">${hidden}
<input name="pairing_code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" autofocus aria-label="Pairing code">
<div class="row"><button class="deny" name="decision" value="deny" formnovalidate>Deny</button><button class="approve" name="decision" value="approve">Approve</button></div>
</form></main></body></html>`;
}

