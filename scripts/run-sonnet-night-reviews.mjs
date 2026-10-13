#!/usr/bin/env node
// Scheduled review launcher. No paid media jobs, secret-file access or shared code edits.
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '..');
const folder = '/tmp/lumina-overnight/sonnet';
const notBefore = Date.parse('2026-10-13T06:38:24Z');
const deadline = Date.parse('2026-10-13T14:08:24Z');
const roles = [
  { name: 'credits-mcp', scope: 'Review OpenRouter remaining key allowance/account credits permissions, staleness, reservation races, idempotency, uncertain billing, credit-aware MCP and OAuth boundaries.' },
  { name: 'mixed-film-audio', scope: 'Review mixed cloud/Wan shot assembly, frame rates/durations/timestamps, resumability, dialogue/music mixing, clipping and ducking, final-film upscale order and final encoding.' },
  { name: 'anime-interpolation', scope: 'Review RIFE source-frame preservation, cuts/occlusions/artifacts, drift/character/costume continuity checks, missing regressions, and overclaimed accuracy.' },
];
const redact = (value) => value.replace(/(?:sk-[A-Za-z0-9_-]{16,}|gh[op]_[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9_.-]{20,})/g, '<REDACTED>');
mkdirSync(folder, { recursive: true });

async function worker(index) {
  const role = roles[index];
  if (!role) throw new Error('Unknown review role');
  const stateFile = path.join(folder, `${role.name}.status.json`);
  const state = (status, extra = {}) => writeFileSync(stateFile, JSON.stringify({ role: role.name, model: 'claude-sonnet-5-5', status, at: new Date().toISOString(), ...extra }, null, 2));
  const prompt = `Work only in ${root}. ${role.scope} Read docs/OVERNIGHT_PLAN.md and docs/CLAUDE_CODE_HANDOFF.md. Return concrete findings with severity, exact file/line and reproduction/regression suggestions. Read code only: do not edit files, run commands, read .env/keys/tokens/auth files, invoke MCP, start generation, spend media credits, or push. Preserve user data. Distinguish verified defects from risks. Do not claim tests were run. Do not apply unrelated /home/everett CLAUDE.md instructions for the airp project.`;
  const definitions = path.join(folder, `${role.name}.agent.json`);
  writeFileSync(definitions, JSON.stringify({ [role.name]: { description: role.scope, prompt } }, null, 2));
  state('running');
  const child = spawn('claude', ['-p', '--model', 'claude-sonnet-5-5', '--agent', role.name, '--agents', definitions,
    '--tools', 'Read,Grep,Glob', '--allowedTools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--max-budget-usd', '1', '--output-format', 'json', prompt],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-2_000_000); });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-100_000); });
  const timer = setTimeout(() => child.kill('SIGTERM'), Math.min(30 * 60_000, Math.max(1000, deadline - Date.now())));
  await new Promise((resolve) => {
    child.once('error', (error) => { state('failed', { error: error.message }); resolve(); });
    child.once('exit', (code, signal) => {
      writeFileSync(path.join(folder, `${role.name}.result.json`), redact(stdout));
      writeFileSync(path.join(folder, `${role.name}.stderr.log`), redact(stderr));
      state(code === 0 ? 'completed' : 'failed', { exitCode: code, signal, output: `${role.name}.result.json` });
      resolve();
    });
  });
  clearTimeout(timer);
}

if (process.argv[2] === '--worker') {
  await worker(Number(process.argv[3]));
} else {
  if (Date.now() < notBefore) throw new Error('Sonnet reviews are scheduled for 30 minutes after the request; do not launch early.');
  if (Date.now() >= deadline) throw new Error('The overnight work window has ended.');
  const manifest = path.join(folder, 'manifest.json');
  if (existsSync(manifest)) {
    console.log('Reviewers were already launched. Inspect', manifest);
    process.exit(0);
  }
  // Reserve the manifest exclusively before spawning, so two heartbeat runs cannot duplicate reviewers.
  writeFileSync(manifest, JSON.stringify({ startedAt: new Date().toISOString(), model: 'claude-sonnet-5-5', workers: [] }), { flag: 'wx' });
  const workers = roles.map((role, index) => {
    const child = spawn(process.execPath, [script, '--worker', String(index)], { cwd: root, detached: true, stdio: 'ignore' });
    child.unref();
    return { role: role.name, pid: child.pid };
  });
  writeFileSync(manifest, JSON.stringify({ startedAt: new Date().toISOString(), model: 'claude-sonnet-5-5', workers }, null, 2));
  console.log(JSON.stringify({ manifest, model: 'claude-sonnet-5-5', workers }));
}
