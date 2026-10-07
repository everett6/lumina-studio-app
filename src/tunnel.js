import { execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// One-click public address: runs a Cloudflare quick tunnel (`cloudflared tunnel --url …`), which needs no
// account and gives a random https://<words>.trycloudflare.com address that lasts until the tunnel stops.
// cloudflared is used from PATH when installed; otherwise Lumina can fetch Cloudflare's official release
// binary into its own data folder, but only when the user asks for it.

const releaseBase = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
const archNames = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' };
const urlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

// Tunnels never outlive Lumina's process.
const running = new Set();
process.once('exit', () => running.forEach((proc) => proc.kill('SIGTERM')));

const version = (file) => new Promise((resolve) => {
  execFile(file, ['--version'], { timeout: 15_000 }, (error, stdout) => resolve(error ? null : String(stdout).trim()));
});

export function createTunnel({ binDir, log = console, command = null }) {
  const localBinary = path.join(binDir, 'cloudflared');
  const pidFile = path.join(binDir, 'tunnel.pid');
  let child = null;

  // A tunnel left behind by a Lumina that was killed (not quit) would keep its address alive; end it.
  function clearStale() {
    try {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      if (pid && readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('cloudflared')) process.kill(pid, 'SIGTERM');
    } catch { /* nothing left over */ }
    rmSync(pidFile, { force: true });
  }

  let state = { state: 'off', url: null, error: null };

  // Which cloudflared to run: an explicit command (tests), then PATH, then Lumina's own copy.
  async function binary() {
    if (command) return command;
    if (await version('cloudflared')) return 'cloudflared';
    if (existsSync(localBinary) && await version(localBinary)) return localBinary;
    return null;
  }

  async function download() {
    if (process.platform !== 'linux') throw Object.assign(new Error('Automatic download is only set up for Linux. Install cloudflared from Cloudflare, then try again.'), { status: 501 });
    const arch = archNames[process.arch];
    if (!arch) throw Object.assign(new Error(`No cloudflared build for this processor (${process.arch}).`), { status: 501 });
    const response = await fetch(`${releaseBase}/cloudflared-linux-${arch}`, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw Object.assign(new Error(`Could not download cloudflared (HTTP ${response.status}).`), { status: 502 });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 1_000_000 || bytes.subarray(0, 4).toString('latin1') !== '\x7fELF') throw Object.assign(new Error('The cloudflared download was not a Linux program.'), { status: 502 });
    mkdirSync(binDir, { recursive: true });
    const temp = `${localBinary}.download`;
    writeFileSync(temp, bytes, { mode: 0o755 });
    chmodSync(temp, 0o755);
    renameSync(temp, localBinary);
    const installed = await version(localBinary);
    if (!installed) {
      rmSync(localBinary, { force: true });
      throw Object.assign(new Error('The downloaded cloudflared does not run on this computer.'), { status: 502 });
    }
    log.info?.('Downloaded cloudflared', { version: installed });
    return localBinary;
  }

  function stop() {
    if (child) {
      child.removeAllListeners('exit');
      child.kill('SIGTERM');
      child = null;
      rmSync(pidFile, { force: true });
    }
    state = { state: 'off', url: null, error: null };
  }

  // Starts a quick tunnel to the local port and resolves with its public URL.
  async function start(port, { allowDownload = false } = {}) {
    stop();
    clearStale();
    let file = await binary();
    if (!file && !allowDownload) throw Object.assign(new Error('Hosting online needs Cloudflare\'s free cloudflared program.'), { status: 428, needsDownload: true });
    if (!file) {
      state = { state: 'downloading', url: null, error: null };
      try {
        file = await download();
      } catch (error) {
        state = { state: 'off', url: null, error: error.message };
        throw error;
      }
    }
    state = { state: 'starting', url: null, error: null };
    const proc = spawn(file, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    child = proc;
    running.add(proc);
    proc.once('exit', () => running.delete(proc));
    try {
      mkdirSync(binDir, { recursive: true });
      writeFileSync(pidFile, String(proc.pid));
    } catch { /* best effort */ }
    return new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => fail('Cloudflare did not hand out an address within 60 seconds. Check the internet connection and try again.'), 60_000);
      const fail = (message) => {
        clearTimeout(timer);
        if (child === proc) stop();
        state = { state: 'off', url: null, error: message };
        reject(Object.assign(new Error(message), { status: 502 }));
      };
      const read = (chunk) => {
        output = (output + chunk).slice(-20_000);
        const found = urlPattern.exec(output);
        if (found && state.state === 'starting' && child === proc) {
          clearTimeout(timer);
          state = { state: 'online', url: found[0], error: null };
          log.info?.('Public tunnel online', { url: found[0] });
          resolve(found[0]);
        }
      };
      proc.stdout.on('data', read);
      proc.stderr.on('data', read);
      proc.on('error', (error) => fail(`Could not run cloudflared: ${error.message}`));
      proc.on('exit', (code) => {
        if (child !== proc) return;
        child = null;
        if (state.state === 'online') {
          state = { state: 'off', url: null, error: `The tunnel stopped (exit code ${code}).` };
          log.error?.('Public tunnel stopped', { code });
        } else {
          fail(`cloudflared stopped before going online: ${output.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`);
        }
      });
    });
  }

  return {
    start, stop,
    status: async () => ({ ...state, installed: Boolean(await binary()) }),
  };
}
