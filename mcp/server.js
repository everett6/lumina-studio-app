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
import { registerLuminaTools } from './tools.js';

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

async function reachable() {
  try {
    const { url, token } = connection();
    const response = await fetch(`${url}/api/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
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
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await reachable()) return;
  }
  throw new Error(`Started Lumina Studio (${command}) but it did not respond within 30 seconds.`);
}

async function call(method, route, body) {
  await ensureRunning();
  const { url, token } = connection();
  let response;
  try {
    response = await fetch(`${url}${route}`, {
      method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(660_000),
    });
  } catch {
    throw new Error('Lumina Studio is not running. Open the app, then try again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Lumina returned HTTP ${response.status}`);
  return data;
}

const server = new McpServer({ name: 'lumina-studio', version: '0.4.0' });
registerLuminaTools(server, {
  call,
  async fetchRaw(route) {
    await ensureRunning();
    const { url, token } = connection();
    return fetch(`${url}${route}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(660_000) });
  },
  exportDir: () => path.join(connection().root, 'exports'),
  localFile: (assetPath) => path.join(connection().root, 'storage', 'assets', path.basename(assetPath)),
  allowOutputPath: true,
});
await server.connect(new StdioServerTransport());
