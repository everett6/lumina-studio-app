import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiServer } from './api.js';
import { createAssetStore } from './assets.js';
import { createBookService } from './books.js';
import { createCanvasRunner } from './canvas.js';
import { openDatabase } from './db.js';
import { createDirectors } from './directors/index.js';
import { createGenerationService } from './generation.js';
import { createJobRunner } from './jobs.js';
import { createKeyStore } from './keys.js';
import { createProviders } from './providers/index.js';
import { createRemoteGateway } from './remote.js';
import { createRepo } from './repo.js';
import { createSequenceService } from './sequences.js';

export const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version;

// The token authenticates the UI (as a cookie) and local tools such as the MCP server (as a bearer header).
function loadToken(file) {
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const token = randomBytes(24).toString('base64url');
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

// Starts Lumina's backend. `dataRoot` holds data/ (SQLite, keys, token) and storage/assets/.
export async function startLumina({ dataRoot = appRoot, port = 0, cipher = null, mode = 'server', enableMock, log = console } = {}) {
  const dataDir = path.join(dataRoot, 'data');
  const db = openDatabase(dataDir);
  const repo = createRepo(db);
  const assetStore = createAssetStore({ assetDir: path.join(dataRoot, 'storage', 'assets'), repo });
  const providers = createProviders({ enableMock });
  const directors = createDirectors({ enableMock });
  const keys = createKeyStore({ file: path.join(dataDir, 'keys.json'), cipher });
  const jobs = createJobRunner({ repo, assetStore, providers, directors, keys, log });
  const generations = createGenerationService({ repo, providers, directors, keys, jobs });
  const canvasRunner = createCanvasRunner({ repo, generations, jobs, directors, keys });
  const books = createBookService({ repo, directors, keys, generations, providers, assetStore });
  const sequences = createSequenceService({ repo, directors, keys, generations, assetStore });
  jobs.events.on('update', books.onGenerationUpdate);
  jobs.events.on('update', sequences.onGenerationUpdate);
  const tokenFile = path.join(dataDir, 'api-token');
  const token = loadToken(tokenFile);

  const recovered = jobs.recover();
  repo.runs.markInterrupted();
  if (recovered.interrupted || recovered.resumed) log.info?.('Recovered jobs', recovered);

  let origin = null;
  const remote = createRemoteGateway({ repo, localOrigin: () => origin, localToken: token, exportDir: path.join(dataRoot, 'exports'), log });
  const server = createApiServer({
    repo, assetStore, providers, directors, keys, generations, canvasRunner, books, sequences, jobs, token, remote,
    publicDir: path.join(appRoot, 'public'), exportDir: path.join(dataRoot, 'exports'), info: { version, mode },
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
  const remoteStatus = await remote.start();
  if (remoteStatus.error) log.error?.('Remote access not started', { detail: remoteStatus.error });
  // Tools like the MCP server find the running app through this file.
  writeFileSync(path.join(dataDir, 'endpoint.json'), JSON.stringify({ url: origin, pid: process.pid, mode }), { mode: 0o600 });

  return {
    origin, port: address.port, token, tokenFile, launchUrl: `${origin}/?token=${token}`, repo, jobs, generations, canvasRunner, keys,
    remote,
    async close() {
      await remote.stop();
      await new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
      db.close();
    },
  };
}
