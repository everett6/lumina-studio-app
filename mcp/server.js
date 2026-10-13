#!/usr/bin/env node
// Lumina Studio MCP server (stdio). Lets Claude Code / Claude Desktop drive a running Lumina app.
// It talks to the app's local HTTP API using the endpoint and token files the app writes on start.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { callLumina, registerLuminaTools } from './tools.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configHome = process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
// Desktop app data first, then a dev server started from the repo.
const candidates = process.env.LUMINA_DATA_DIR ? [process.env.LUMINA_DATA_DIR] : [path.join(configHome, 'Lumina Studio'), repoRoot];

function connection() {
  for (const root of candidates) {
    const endpointFile = path.join(root, 'data', 'endpoint.json');
    const tokenFile = path.join(root, 'data', 'api-token');
    if (existsSync(endpointFile) && existsSync(tokenFile)) {
      return { root, url: JSON.parse(readFileSync(endpointFile, 'utf8')).url, token: readFileSync(tokenFile, 'utf8').trim() };
    }
  }
  throw new Error('Lumina Studio is not running. Open the app, then try again.');
}

// Installed locations of the desktop app, most specific first. LUMINA_APP_COMMAND overrides.
function appCommand() {
  const options = [
    process.env.LUMINA_APP_COMMAND,
    path.join(homedir(), 'Applications', 'Lumina-Studio.AppImage'),
    '/opt/Lumina Studio/lumina-studio',
    '/usr/bin/lumina-studio',
    path.join(repoRoot, 'dist', 'linux-unpacked', 'lumina-studio'),
  ];
  return options.find((option) => option && existsSync(option)) ?? null;
}

async function reachable(timeoutMs = 10000) {
  try {
    const { url, token } = connection();
    const response = await fetch(`${url}/api/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

// If Lumina is closed, open the desktop app and wait for it to come up (once per call).
async function ensureRunning() {
  if (await reachable()) return;
  const command = process.env.LUMINA_NO_AUTOLAUNCH === '1' ? null : appCommand();
  if (!command) throw new Error('Lumina Studio is not running. Open the app, then try again.');
  const child = spawn(command, [], { detached: true, stdio: 'ignore', env: process.env });
  child.on('error', () => {});
  child.unref();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, deadline - Date.now())));
    if (await reachable(Math.max(1, Math.min(10000, deadline - Date.now())))) return;
  }
  throw new Error(`Started Lumina Studio (${command}) but it did not respond within 30 seconds.`);
}

async function call(method, route, body, { approvalId } = {}) {
  await ensureRunning();
  const { url, token } = connection();
  try {
    return await callLumina({ origin: url, token, method, route, body, approvalId });
  } catch (error) {
    if (error.status) throw error;
    throw new Error('Lumina Studio is not running. Open the app, then try again.');
  }
}

const server = new McpServer({ name: 'lumina-studio', version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version });
registerLuminaTools(server, {
  call,
  async fetchRaw(route) {
    await ensureRunning();
    const { url, token } = connection();
    return fetch(`${url}${route}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(660_000) });
  },
  // Raw upload of a local file (local connections only: the MCP server and Lumina share this computer).
  async upload(route, bytes, label) {
    await ensureRunning();
    const { url, token } = connection();
    const response = await fetch(`${url}${route}`, { method: 'POST', body: bytes, signal: AbortSignal.timeout(660_000),
      headers: { authorization: `Bearer ${token}`, 'x-lumina-client': 'mcp', 'x-lumina-label': label } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || `Lumina returned HTTP ${response.status}`), { status: response.status });
    return data;
  },
  exportDir: () => path.join(connection().root, 'exports'),
  localFile: (assetPath) => path.join(connection().root, 'storage', 'assets', path.basename(assetPath)),
  allowOutputPath: true,
});
await server.connect(new StdioServerTransport());
