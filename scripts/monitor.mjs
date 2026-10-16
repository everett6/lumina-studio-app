#!/usr/bin/env node
// Production monitor: logs the computer and Lumina's jobs while a film is being made, into logs/ in this project.
// Read-only: it never stops, kills or changes anything. Run: npm run monitor (Ctrl+C stops it), or in the
// background: nohup node scripts/monitor.mjs >/dev/null 2>&1 &
//
// Every MONITOR_INTERVAL seconds (default 10): GPU temperature, power, VRAM and utilisation; free RAM, swap and
// disk; Lumina's running and queued jobs. Events (job started / finished / failed with its error, warnings,
// kernel GPU errors such as "GPU has fallen off the bus" or Xid, out-of-memory kills) go to a separate events log.
//   logs/monitor-YYYY-MM-DD.log    one line per sample
//   logs/monitor-YYYY-MM-DD.jsonl  the same samples as JSON
//   logs/events-YYYY-MM-DD.log     what happened, with warnings
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statfsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logDir = process.env.MONITOR_LOG_DIR || path.join(root, 'logs');
const dataRoot = process.env.LUMINA_DATA_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Lumina Studio');
const interval = Math.max(2, Number(process.env.MONITOR_INTERVAL) || 10) * 1000;
const limits = { tempC: 80, ramGb: 3, diskGb: 20, swapRiseGb: 1 };
mkdirSync(logDir, { recursive: true });

const day = () => new Date().toISOString().slice(0, 10);
const clock = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const files = { monitor: 'monitor-DAY.log', json: 'monitor-DAY.jsonl', events: 'events-DAY.log' };
const write = (kind, line) => appendFileSync(path.join(logDir, files[kind].replace('DAY', day())), `${line}\n`);
const event = (level, message) => { const line = `${clock()} ${level.padEnd(5)} ${message}`; write('events', line); if (level !== 'info') console.log(line); };
const run = (cmd, args, timeout = 5000) => new Promise((resolve) => execFile(cmd, args, { timeout }, (error, stdout) => resolve(error ? null : stdout)));

function memory() {
  const info = Object.fromEntries(readFileSync('/proc/meminfo', 'utf8').split('\n').filter(Boolean).map((l) => { const [k, v] = l.split(':'); return [k, Number.parseInt(v, 10) * 1024]; }));
  return { ramFreeGb: info.MemAvailable / 2 ** 30, ramTotalGb: info.MemTotal / 2 ** 30, swapUsedGb: (info.SwapTotal - info.SwapFree) / 2 ** 30 };
}
async function gpu() {
  const out = await run('nvidia-smi', ['--query-gpu=temperature.gpu,power.draw,power.limit,memory.used,memory.total,utilization.gpu,clocks.sm', '--format=csv,noheader,nounits']);
  if (!out) return null;
  const [tempC, powerW, limitW, vramUsedMb, vramTotalMb, utilPct, smMhz] = out.split('\n')[0].split(',').map((v) => Number(v.trim()));
  return { tempC, powerW, limitW, vramUsedMb, vramTotalMb, utilPct, smMhz };
}
function disk() {
  try { const s = statfsSync(existsSync(dataRoot) ? dataRoot : os.homedir()); return { diskFreeGb: (s.bavail * s.bsize) / 2 ** 30 }; } catch { return { diskFreeGb: null }; }
}

// Lumina's API: the port and token the running app writes into its data folder.
function endpoint() {
  try {
    const info = JSON.parse(readFileSync(path.join(dataRoot, 'data', 'endpoint.json'), 'utf8'));
    const token = readFileSync(path.join(dataRoot, 'data', 'api-token'), 'utf8').trim();
    const origin = info.url ? new URL(info.url).origin : info.origin ?? (info.port ? `http://127.0.0.1:${info.port}` : null);
    return origin ? { origin, token } : null;
  } catch { return null; }
}
async function api(route) {
  const ep = endpoint();
  if (!ep) throw new Error('Lumina is not running (no endpoint file)');
  const response = await fetch(`${ep.origin}${route}`, { headers: { authorization: `Bearer ${ep.token}`, 'x-lumina-client': 'monitor' }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} on ${route}`);
  return response.json();
}

const started = new Map(); // job id -> start time (ms), for jobs seen queued or running
const reported = new Set(); // job ids whose end was logged
const startedAt = Date.now();
let appUp = null;
let swapStart = null;
let lastKernelCheck = Date.now() - 60_000;
let kernelReadable = true;
const lastWarn = new Map(); // warning kind -> time, so each warning repeats at most every 10 minutes
const warnOnce = (kind, message) => { if (Date.now() - (lastWarn.get(kind) ?? 0) < 600_000) return; lastWarn.set(kind, Date.now()); event('WARN', message); };

// Jobs come from each project's recent generations, so a job that starts and ends between two samples is still logged.
async function jobs() {
  try {
    const { projects } = await api('/api/projects');
    const all = [];
    for (const p of projects.slice(0, 10)) {
      const { generations = [] } = await api(`/api/projects/${p.id}`).catch(() => ({ generations: [] }));
      for (const g of generations.slice(0, 50)) all.push({ ...g, project: p.name });
    }
    const queue = await api('/api/local/gpu-queue').catch(() => null);
    if (appUp !== true) event('info', 'Lumina is reachable.');
    appUp = true;
    return { all, active: all.filter((g) => g.status === 'queued' || g.status === 'running'), queue };
  } catch (error) {
    if (appUp !== false) event(appUp === null ? 'info' : 'WARN', `Lumina not reachable: ${error.message}`);
    appUp = false;
    return null;
  }
}

const labelOf = (g) => `${g.operation ?? 'job'} ${g.provider ?? ''}/${g.model ?? ''} (${g.project}) "${String(g.prompt ?? '').replace(/\s+/g, ' ').slice(0, 50)}"`;
function followJobs(all) {
  for (const g of all) {
    const ended = ['completed', 'failed', 'interrupted', 'cancelled'].includes(g.status);
    if (!ended && !started.has(g.id)) { started.set(g.id, Date.now()); event('info', `${g.status.padEnd(9)} ${g.id.slice(0, 8)} ${labelOf(g)}`); }
    if (!ended || reported.has(g.id)) continue;
    const endedAt = Date.parse(g.completedAt ?? g.updatedAt ?? g.createdAt ?? 0);
    if (!started.has(g.id) && endedAt < startedAt) { reported.add(g.id); continue; } // finished before the monitor started
    reported.add(g.id);
    const from = Date.parse(g.startedAt ?? g.createdAt ?? 0) || started.get(g.id);
    const minutes = from && endedAt ? ((endedAt - from) / 60000).toFixed(1) : '?';
    if (g.status === 'failed') event('ERROR', `failed    ${g.id.slice(0, 8)} after ${minutes} min ${labelOf(g)}: ${g.userError ?? g.error ?? 'no reason given'}`);
    else event('info', `${g.status.padEnd(9)} ${g.id.slice(0, 8)} after ${minutes} min ${labelOf(g)}${g.billing && g.billing !== 'none' ? ` [billing: ${g.billing}]` : ''}`);
  }
}

// Kernel messages that matter for a GPU workstation: the driver losing the GPU, Xid errors, OOM kills.
async function kernel() {
  if (!kernelReadable || Date.now() - lastKernelCheck < 60_000) return;
  const since = new Date(lastKernelCheck).toISOString().replace('T', ' ').slice(0, 19);
  lastKernelCheck = Date.now();
  const out = await run('journalctl', ['-k', '--no-pager', '-o', 'short-iso', '--since', since], 10_000);
  if (out === null) { kernelReadable = false; event('info', 'Kernel log not readable without extra permissions; kernel GPU errors are not monitored.'); return; }
  for (const line of out.split('\n')) {
    if (/NVRM|Xid|fallen off the bus|GPU has fallen|Out of memory|oom-kill|Killed process/i.test(line)) event('ALERT', `kernel: ${line.trim().slice(0, 300)}`);
  }
}

async function sample() {
  const [g, m, d, app] = await Promise.all([gpu(), Promise.resolve(memory()), Promise.resolve(disk()), jobs()]);
  if (swapStart === null) swapStart = m.swapUsedGb;
  const running = app?.active.filter((j) => j.status === 'running').length ?? null;
  const queued = app?.active.filter((j) => j.status === 'queued').length ?? null;
  const record = { at: new Date().toISOString(), gpu: g, ...m, ...d, lumina: app ? { running, queued, gpuQueue: app.queue } : null };
  write('json', JSON.stringify(record));
  const f = (v, digits = 1) => (v == null || Number.isNaN(v) ? '-' : Number(v).toFixed(digits));
  write('monitor', `${clock()} gpu ${g ? `${f(g.tempC, 0)}C ${f(g.powerW, 0)}/${f(g.limitW, 0)}W vram ${f(g.vramUsedMb / 1024)}/${f(g.vramTotalMb / 1024)}GB util ${f(g.utilPct, 0)}%` : 'n/a'}`
    + ` | ram free ${f(m.ramFreeGb)}GB swap ${f(m.swapUsedGb, 2)}GB | disk free ${f(d.diskFreeGb, 0)}GB | load ${os.loadavg()[0].toFixed(2)}`
    + ` | lumina ${app ? `${running} running, ${queued} queued` : 'offline'}`);
  if (g && g.tempC >= limits.tempC) warnOnce('temp', `GPU at ${g.tempC} C (limit ${limits.tempC} C). Let it cool before the next heavy job.`);
  if (m.ramFreeGb < limits.ramGb) warnOnce('ram', `Only ${f(m.ramFreeGb)} GB RAM free. Close other programs; do not start another heavy job.`);
  if (m.swapUsedGb - swapStart > limits.swapRiseGb) { event('WARN', `Swap grew by ${f(m.swapUsedGb - swapStart, 2)} GB since the monitor started: memory pressure.`); swapStart = m.swapUsedGb; }
  if (d.diskFreeGb !== null && d.diskFreeGb < limits.diskGb) warnOnce('disk', `Only ${f(d.diskFreeGb, 0)} GB disk free in the Lumina data folder.`);
  if (app) followJobs(app.all);
  await kernel();
}

event('info', `Monitor started (every ${interval / 1000} s). Data folder: ${dataRoot}. Logs: ${logDir}`);
await sample();
const timer = setInterval(() => sample().catch((error) => event('WARN', `monitor sample failed: ${error.message}`)), interval);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { clearInterval(timer); event('info', 'Monitor stopped.'); process.exit(0); });
