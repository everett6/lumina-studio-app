#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import localProvider, { animeModelInstalled, modelInstalled, voiceInstalled } from '../src/providers/local.js';
import { createEnhancer } from '../src/enhance.js';

function dataDirectory(args) {
  const index = args.indexOf('--data-dir');
  if (index === -1) return path.join(os.homedir(), '.config', 'Lumina Studio');
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('--data-dir requires a directory path');
  return path.resolve(args[index + 1]);
}

function commandStatus(command) {
  try {
    const result = spawnSync(command, ['-version'], { encoding: 'utf8', timeout: 3000, maxBuffer: 64 * 1024 });
    return { available: result.status === 0, version: result.status === 0 ? (result.stdout.trim().split('\n')[0] || null) : null,
      reason: result.error?.code === 'ENOENT' ? 'not found on PATH' : result.error?.code === 'ETIMEDOUT' ? 'probe timed out' : result.status === 0 ? null : 'command probe failed' };
  } catch (error) {
    return { available: false, version: null, reason: error.message };
  }
}

export async function report(args = process.argv.slice(2)) {
  const dataDir = dataDirectory(args);
  let runtime;
  try { runtime = localProvider.runtimeStatus(); }
  catch (error) { runtime = { gpuAvailable: false, gpu: null, pythonAvailable: false, note: `Runtime probe failed: ${error.message}` }; }

  let enhancerTools;
  try {
    enhancerTools = await createEnhancer({ binDir: path.join(dataDir, 'bin') }).tools();
  } catch (error) {
    enhancerTools = { ai: false, rife: false, reason: `Enhancer probe failed: ${error.message}` };
  }

  const ffmpeg = commandStatus('ffmpeg');
  const ffprobe = commandStatus('ffprobe');
  return {
    movieCapability: { available: ffmpeg.available && ffprobe.available, ffmpeg, ffprobe },
    localModels: {
      wan: { installed: safeCheck(modelInstalled), runtimeReady: Boolean(runtime.gpuAvailable && runtime.pythonAvailable) },
      animagine: { installed: safeCheck(animeModelInstalled), runtimeReady: Boolean(runtime.gpuAvailable && runtime.pythonAvailable) },
      kokoro: { installed: safeCheck(() => voiceInstalled('kokoro')), runtime: 'CPU' },
      chatterbox: { installed: safeCheck(() => voiceInstalled('chatterbox')), runtimeReady: Boolean(runtime.gpuAvailable) },
    },
    runtime: { gpuAvailable: Boolean(runtime.gpuAvailable), gpu: runtime.gpu ?? null, pythonAvailable: Boolean(runtime.pythonAvailable), note: runtime.note ?? null },
    enhancerTools: { aiUpscaler: Boolean(enhancerTools.ai), rifeInterpolation: Boolean(enhancerTools.rife) },
  };
}

function safeCheck(check) {
  try { return Boolean(check()); } catch { return false; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await report();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.movieCapability.available ? 0 : 1;
  } catch (error) {
    process.stderr.write(`lumina doctor: ${error.message}\n`);
    process.exitCode = 1;
  }
}
