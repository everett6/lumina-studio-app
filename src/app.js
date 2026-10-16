import { randomBytes } from 'node:crypto';
import { createMusicService } from './music.js';
import { createPublisher } from './publish.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiServer } from './api.js';
import { createAssetStore } from './assets.js';
import { createBookService } from './books.js';
import { createCanvasRunner } from './canvas.js';
import { openDatabase, transaction } from './db.js';
import { createBudget } from './budget.js';
import { createCreditMonitor } from './credits.js';
import { createModelCatalog } from './catalog.js';
import { createDirectors } from './directors/index.js';
import { createGenerationService } from './generation.js';
import { createJobRunner } from './jobs.js';
import { createKeyStore } from './keys.js';
import { createProviders } from './providers/index.js';
import { createRemoteGateway } from './remote.js';
import { createRepo } from './repo.js';
import { createSequenceService } from './sequences.js';
import { createEnhancer } from './enhance.js';
import { bakeCharacter, withGpuLease } from './providers/local.js';
import { createBakeService } from './bake.js';
import { encodePng } from './png.js';
import { createFaceChecker } from './faces.js';

export const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version;

// The token authenticates the UI (as a cookie) and local tools such as the MCP server (as a bearer header).
function loadToken(file) {
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const token = randomBytes(24).toString('base64url');
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

// Tests: a stand-in trainer that writes an empty LoRA file (and tiny pictures for the review phases) instead of using the GPU.
// It understands the same tasks as local/train_lora.py; "bake-train" leaves its request in <out>/train-request.json.
let fakePictures = 0;
async function fakeBake(request, onProgress) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { out, task = 'bake' } = request;
  await mkdir(path.join(out, 'pictures'), { recursive: true });
  const draw = async (indexes) => {
    const listing = path.join(out, 'pictures.json');
    const entries = existsSync(listing) ? JSON.parse(readFileSync(listing, 'utf8')) : [];
    for (const [n, index] of indexes.entries()) {
      const file = path.join(out, 'pictures', `${String(index).padStart(2, '0')}.png`);
      await writeFile(file, encodePng(4, 4, () => [(index * 15) % 256, 40, ++fakePictures % 256]));
      entries[index] = { file, framing: `framing ${index}` };
      onProgress?.(n + 1, indexes.length, 'drawing');
    }
    await writeFile(listing, JSON.stringify(entries));
    return entries;
  };
  if (task === 'bake-draw') return { pictures: await draw(Array.from({ length: 16 }, (_, i) => i)) };
  if (task === 'bake-redraw') return { pictures: await draw(request.indexes) };
  if (task === 'bake-train') await writeFile(path.join(out, 'train-request.json'), JSON.stringify({ pictures: request.pictures, steps: request.steps }));
  if (task === 'bake') await writeFile(path.join(out, 'train-request.json'), JSON.stringify({ auto: true, mirror: request.mirror, steps: request.steps }));
  onProgress?.(1, 1, 'training');
  const lora = path.join(out, 'character.safetensors');
  await writeFile(lora, '');
  return { lora };
}

// Starts Lumina's backend. `dataRoot` holds data/ (SQLite, keys, token) and storage/assets/.
export async function startLumina({ dataRoot = appRoot, port = 0, cipher = null, mode = 'server', enableMock, log = console } = {}) {
  const dataDir = path.join(dataRoot, 'data');
  const db = openDatabase(dataDir);
  const repo = createRepo(db);
  const assetStore = createAssetStore({ assetDir: path.join(dataRoot, 'storage', 'assets'), repo });
  const providers = createProviders({ enableMock });
  const budget = createBudget({ repo });
  const directors = createDirectors({ enableMock, budget });
  const keys = createKeyStore({ file: path.join(dataDir, 'keys.json'), cipher });
  const credits = createCreditMonitor({ keys });
  const modelCatalog = createModelCatalog({ repo, provider: providers.get('openrouter'), log });
  const jobs = createJobRunner({ repo, assetStore, providers, directors, keys, budget, credits, log });
  const generations = createGenerationService({ repo, providers, directors, keys, jobs, budget, db, transaction });
  const canvasRunner = createCanvasRunner({ repo, generations, jobs, directors, keys });
  const books = createBookService({ repo, directors, keys, generations, providers, assetStore });
  const enhancer = createEnhancer({ binDir: path.join(dataRoot, 'bin'), workDir: path.join(dataRoot, 'tmp'), log });
  const faces = createFaceChecker({ binDir: path.join(dataRoot, 'bin'), log });
  const sequences = createSequenceService({ repo, directors, keys, generations, assetStore, providers, enhancer, budget, faces, log, progressOf: (id) => jobs.progress(id) });
  const bake = createBakeService({ repo, assetStore, dir: path.join(dataRoot, 'loras'), trainer: enableMock && process.env.LUMINA_FAKE_BAKE ? fakeBake : bakeCharacter, log });
  jobs.events.on('update', books.onGenerationUpdate);
  jobs.events.on('update', sequences.onGenerationUpdate);
  const tokenFile = path.join(dataDir, 'api-token');
  const token = loadToken(tokenFile);

  const recovered = jobs.recover();
  repo.runs.markInterrupted();
  if (recovered.interrupted || recovered.resumed) log.info?.('Recovered jobs', recovered);

  let origin = null;
  const remote = createRemoteGateway({
    repo, localOrigin: () => origin, localToken: token, exportDir: path.join(dataRoot, 'exports'), binDir: path.join(dataRoot, 'bin'), tunnelCommand: process.env.LUMINA_TUNNEL_COMMAND || null, log,
  });
  const music = createMusicService({ repo, assetStore, log });
  const publisher = createPublisher({ sequences, assetStore, repo, exportDir: path.join(dataRoot, 'exports'), log });
  const server = createApiServer({
    music, publisher, repo, assetStore, providers, directors, keys, generations, canvasRunner, books, sequences, enhancer, faces, jobs, token, remote, budget, credits, modelCatalog, bake,
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
  remote.resume(); // reconnects the one-click public address in the background
  if (process.env.LUMINA_OFFLINE !== '1') modelCatalog.refreshIfStale();
  // Tools like the MCP server find the running app through this file.
  writeFileSync(path.join(dataDir, 'endpoint.json'), JSON.stringify({ url: origin, pid: process.pid, mode }), { mode: 0o600 });

  return {
    origin, port: address.port, token, tokenFile, launchUrl: `${origin}/?token=${token}`, repo, jobs, generations, canvasRunner, keys,
    remote,
    async close() {
      sequences.stopAllProductions();
      await remote.shutdown();
      await new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
      await jobs.idle();
      await sequences.idle();
      await jobs.idle();
      await enhancer.idle();
      await withGpuLease(async () => {});
      db.close();
    },
  };
}
