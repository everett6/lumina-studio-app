import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { run, runCapture } from '../src/video.js';
import { gpuQueue } from '../src/gpu.js';
import { startTestApp } from './helpers.js';
import { createVoiceLibrary } from '../src/voices.js';
import local, { withGpuLease } from '../src/providers/local.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerLuminaTools } from '../mcp/tools.js';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lumina-voice-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const wav = async (name, seconds) => {
    const file = path.join(dir, `${name}.wav`);
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=220:duration=${seconds}`, '-ac', '2', '-ar', '48000', file], 10000);
    return file;
  };
  return { dir, wav, library: createVoiceLibrary({ dir: path.join(dir, 'custom-voices') }) };
}

test('voice library requires explicit consent before reading the reference', async (t) => {
  const { library } = await fixture(t);
  for (const consent of [undefined, false, 'true', 1]) {
    await assert.rejects(library.create({ name: 'Mine', audio: '/missing', consent }), /consent.*true/i);
  }
  assert.deepEqual(library.list(), []);
});

test('voice library normalizes audio, persists metadata, slugs ids and deletes its own copy', async (t) => {
  const { dir, wav, library } = await fixture(t);
  const audio = await wav('reference', 5);
  const voice = await library.create({ name: '  Éverett / Studio!  ', audio, audioAssetId: 'a1', consent: true });
  assert.equal(voice.id, 'custom:everett-studio');
  assert.equal(voice.name, 'Éverett / Studio!');
  assert.equal(voice.consent, true);
  assert.equal(voice.audioAssetId, 'a1');
  const copy = library.reference(voice.id);
  assert.notEqual(copy, audio);
  const info = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', copy], 10000));
  assert.equal(info.streams[0].sample_rate, '24000');
  assert.equal(info.streams[0].channels, 1);
  const loudness = (await runCapture('ffmpeg', ['-hide_banner', '-i', copy, '-af', 'ebur128', '-f', 'null', '-'], 10000)).stderr;
  const integrated = Number([...loudness.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].at(-1)?.[1]);
  assert.ok(Math.abs(integrated + 20) < 1, loudness);
  assert.equal(createVoiceLibrary({ dir: path.join(dir, 'custom-voices') }).list()[0].id, voice.id);
  await assert.rejects(library.create({ name: 'Everett studio', audio, consent: true }), /already exists/i);
  assert.equal(library.delete(voice.id), true);
  assert.equal(existsSync(copy), false);
  assert.equal(existsSync(audio), true);
  assert.deepEqual(library.list(), []);
  assert.throws(() => library.reference(voice.id), /not found/i);
  assert.throws(() => library.delete('custom:../../escape'), /invalid/i);
});

test('voice library rejects clips outside 5–30 seconds without publishing a voice', async (t) => {
  const { wav, library } = await fixture(t);
  for (const seconds of [4.9, 30.1]) {
    await assert.rejects(library.create({ name: 'Invalid', audio: await wav(`s${seconds}`, seconds), consent: true }), /5.*30/);
  }
  const last = await library.create({ name: 'Thirty seconds', audio: await wav('thirty', 30), consent: true });
  assert.equal(last.id, 'custom:thirty-seconds');
  assert.equal(library.list().length, 1);
});

test('voice library refuses silence, empty names and concurrent duplicate creation', async (t) => {
  const { dir, wav, library } = await fixture(t);
  const audio = await wav('good', 6);
  await assert.rejects(library.create({ name: '   ', audio, consent: true }), /name/i);
  const silent = path.join(dir, 'silent.wav');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '6', silent], 10000);
  await assert.rejects(library.create({ name: 'Silence', audio: silent, consent: true }), /speech|silent/i);
  const results = await Promise.allSettled([1, 2].map(() => library.create({ name: 'Same', audio, consent: true })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(library.list().length, 1);
});

test('custom voices appear in catalog and character casting; speech and conversion use queued worker tasks', async (t) => {
  const { dir, wav } = await fixture(t);
  const audio = await wav('input', 6);
  const log = path.join(dir, 'requests.jsonl');
  const disabled = path.join(dir, 'disabled');
  const python = path.join(dir, 'fake-python');
  writeFileSync(python, `#!${process.execPath}\nimport readline from 'node:readline';\nimport fs from 'node:fs';\nfor await (const line of readline.createInterface({input:process.stdin})) {\n const r=JSON.parse(line); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(r)+'\\n');\n if(r.task==='voice-capabilities') console.log(JSON.stringify({id:r.id,done:true,available:!fs.existsSync(${JSON.stringify(disabled)}),reason:'ChatterboxVC is missing'}));\n else if(!r.reference || !fs.existsSync(r.reference)) console.log(JSON.stringify({id:r.id,error:'missing reference'}));\n else { fs.copyFileSync(${JSON.stringify(audio)},r.out); console.log(JSON.stringify({id:r.id,done:true,out:r.out})); }\n}\n`, { mode: 0o755 });
  const old = { python: process.env.LUMINA_VOICE_PYTHON, hub: process.env.HF_HUB_CACHE };
  process.env.LUMINA_VOICE_PYTHON = python;
  process.env.HF_HUB_CACHE = path.join(dir, 'hub');
  for (const [repo, files] of [
    ['ResembleAI/chatterbox', ['ve.safetensors', 't3_cfg.safetensors', 's3gen.safetensors', 'tokenizer.json', 'conds.pt']],
    ['onnx-community/Kokoro-82M-v1.0-ONNX', ['onnx/model.onnx', 'voices/af_heart.bin']],
  ]) for (const file of files) {
    const target = path.join(process.env.HF_HUB_CACHE, `models--${repo.replace('/', '--')}`, 'snapshots', 'test', file);
    mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, 'fake');
  }
  const app = await startTestApp();
  t.after(async () => {
    await withGpuLease(async () => {});
    if (old.python === undefined) delete process.env.LUMINA_VOICE_PYTHON; else process.env.LUMINA_VOICE_PYTHON = old.python;
    process.env.HF_HUB_CACHE = old.hub;
    await app.close();
  });
  const project = app.app.repo.projects.create('Voice project');
  const file = '11111111-1111-4111-8111-111111111111.wav';
  const assetDir = path.join(app.dataRoot, 'storage', 'assets');
  writeFileSync(path.join(assetDir, file), readFileSync(audio));
  const source = app.app.repo.assets.create({ projectId: project.id, kind: 'audio', mimeType: 'audio/wav', file, size: readFileSync(audio).length });
  const refused = await app.call('POST', '/api/voices', { name: 'My voice', audioAssetId: source.id });
  assert.equal(refused.status, 400);
  const made = await app.call('POST', '/api/voices', { name: 'My voice', audioAssetId: source.id, consent: true });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.voice.id;
  assert.equal(id, 'custom:my-voice');
  const catalog = (await app.call('GET', '/api/catalog')).body;
  assert.ok(catalog.providers.find((p) => p.id === 'local').models.find((m) => m.id === 'chatterbox').voices.includes(id));
  const character = app.app.repo.characters.create({ name: 'Actor', kind: 'character' });
  const cast = await app.call('PATCH', `/api/characters/${character.id}`, { voice: { provider: 'local', model: 'chatterbox', voice: id } });
  assert.equal(cast.status, 200, JSON.stringify(cast.body));
  assert.equal(app.app.repo.characters.get(character.id).voice.voice, id);
  let release;
  const held = withGpuLease(() => new Promise((resolve) => { release = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const pending = local.speak({ model: 'kokoro-82m', voice: id, text: 'A line.', style: 'calm' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(gpuQueue.status().queued, 1);
  assert.equal(existsSync(log), false, 'speech cannot enter the worker while another GPU lease is held');
  release(); await held;
  const speech = await pending;
  assert.ok(speech.bytes.length > 100);
  const changed = await app.call('POST', '/api/voice-change', { audioAssetId: source.id, targetVoice: id });
  assert.equal(changed.status, 201, JSON.stringify(changed.body));
  assert.notEqual(changed.body.assetId, source.id);
  const playable = await app.call('GET', changed.body.assetPath);
  assert.equal(playable.status, 200, 'conversion must return a playable asset URL');
  assert.equal(playable.headers.get('content-type'), 'audio/wav');
  assert.equal(app.app.repo.assets.get(changed.body.assetId).parentAssetId, source.id);
  const requests = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(requests[0].engine, 'chatterbox');
  assert.equal(requests[0].voice, id);
  assert.equal(requests[0].style, 'calm');
  assert.equal(requests[0].task, 'speech');
  assert.ok(requests.some((r) => r.task === 'voice-change' && r.audio === path.join(assetDir, file)));
  assert.equal(requests.at(-1).reference, requests[0].reference);
  const generation = await app.call('POST', '/api/generate', { projectId: project.id, operation: 'speech', prompt: 'Default engine, custom voice.', provider: 'local', model: 'kokoro-82m', voice: id });
  assert.equal(generation.status, 202, JSON.stringify(generation.body));
  assert.equal(generation.body.generation.params.voice, id);
  const done = await app.call('POST', `/api/generations/${generation.body.generation.id}/wait`, { timeoutMs: 10000 });
  assert.equal(done.body.generation.status, 'completed', JSON.stringify(done.body));
  writeFileSync(disabled, 'disabled');
  const unavailable = await app.call('POST', '/api/voice-change', { audioAssetId: source.id, targetVoice: id });
  assert.equal(unavailable.status, 501);
  assert.match(unavailable.body.error, /unavailable.*ChatterboxVC is missing/);
  assert.equal((await app.call('DELETE', `/api/voices/${encodeURIComponent(id)}`)).status, 200);
  assert.deepEqual((await app.call('GET', '/api/voices')).body.voices, []);
});

test('MCP voice tools enforce consent, route aliases and return inline audio for one-off speech', async () => {
  const calls = [];
  const server = new McpServer({ name: 'voice-test', version: '1' });
  registerLuminaTools(server, {
    call: async (method, route, body) => {
      calls.push({ method, route, body });
      if (route === '/api/generate') return { generation: { id: 'g1' } };
      if (route.endsWith('/wait')) return { generation: { id: 'g1', status: 'completed', assetId: 'a1', assetPath: '/api/assets/a1/file' } };
      if (route === '/api/voice-change') return { assetId: 'a2', assetPath: '/api/assets/a2/file' };
      return { voice: { id: 'custom:mine' }, voices: [] };
    },
    fetchRaw: async () => new Response(Buffer.from('RIFF-audio'), { headers: { 'content-type': 'audio/wav' } }),
  });
  const client = new Client({ name: 'voice-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const invoke = (name, args) => client.callTool({ name, arguments: args });
    assert.equal((await invoke('create_voice', { name: 'Mine', audioAssetId: 'a1', consent: false })).isError, true);
    assert.equal(calls.length, 0);
    for (const name of ['create_voice', 'create_voice_from_confirmed_audio']) {
      assert.notEqual((await invoke(name, { name: 'Mine', audioAssetId: 'a1', consent: true })).isError, true);
    }
    await invoke('list_custom_voices', {});
    await invoke('delete_custom_voice', { id: 'custom:mine' });
    const spoken = await invoke('speak_line', { projectId: 'p1', text: 'Hello', voice: 'custom:mine', style: 'calm' });
    assert.ok(spoken.content.some((c) => c.type === 'audio'));
    assert.equal(JSON.parse(spoken.content[0].text).assetId, 'a1');
    const generation = calls.find((c) => c.route === '/api/generate');
    assert.equal(generation.body.model, 'chatterbox');
    assert.equal(generation.body.provider, 'local');
    const changed = await invoke('voice_change', { audioAssetId: 'a1', targetVoice: 'custom:mine' });
    assert.ok(changed.content.some((c) => c.type === 'audio'));
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.route === '/api/voices/custom%3Amine'));
  } finally { await client.close(); await server.close(); }
});

test('Python worker dispatches speech and real conversion APIs without transcription; missing VC is explicit', async (t) => {
  const { dir } = await fixture(t);
  const reference = path.join(dir, 'reference.wav');
  writeFileSync(reference, 'fake-reference');
  const launcher = path.join(dir, 'worker-fixture.py');
  writeFileSync(launcher, String.raw`
import json, os, runpy, sys, types
sys.modules['numpy'] = types.ModuleType('numpy')
sf = types.ModuleType('soundfile')
def write(file, samples, rate):
    with open(file, 'w') as f: json.dump({'samples': samples, 'rate': rate}, f)
sf.write = write
sys.modules['soundfile'] = sf
class Tensor:
    def __init__(self, value): self.value = value
    def squeeze(self, dim): return self
    def cpu(self): return self
    def numpy(self): return self.value
class TTS:
    sr = 24000
    @classmethod
    def from_local(cls, root, device): return cls()
    def generate(self, text, audio_prompt_path=None, exaggeration=None, cfg_weight=None):
        return Tensor(['tts', text, audio_prompt_path, exaggeration])
class VC:
    sr = 24000
    @classmethod
    def from_local(cls, root, device): return cls()
    def generate(self, audio, target_voice_path=None):
        return Tensor(['vc', audio, target_voice_path])
package = types.ModuleType('chatterbox')
package.__path__ = []
sys.modules['chatterbox'] = package
tts = types.ModuleType('chatterbox.tts'); tts.ChatterboxTTS = TTS
sys.modules['chatterbox.tts'] = tts
if os.environ.get('FAKE_NO_VC') != '1':
    vc = types.ModuleType('chatterbox.vc'); vc.ChatterboxVC = VC
    sys.modules['chatterbox.vc'] = vc
torch = types.ModuleType('torch'); torch.cuda = types.SimpleNamespace(empty_cache=lambda: None)
sys.modules['torch'] = torch
runpy.run_path('local/voice_worker.py', run_name='__main__')
`);
  const { spawnSync } = await import('node:child_process');
  const hub = path.join(dir, 'hub');
  mkdirSync(path.join(hub, 'models--ResembleAI--chatterbox', 'snapshots', 'fake'), { recursive: true });
  const out = path.join(dir, 'out.json');
  const requests = [
    { id: 'cap', task: 'voice-capabilities' },
    { id: 's', task: 'speech', engine: 'chatterbox', voice: 'custom:mine', text: 'Hello', style: 'furious', reference, out: path.join(dir, 'speech.json') },
    { id: 'c', task: 'voice-change', audio: '/source.wav', reference, out },
    { id: 'missing', task: 'speech', engine: 'chatterbox', voice: 'custom:missing', text: 'Hello', out },
    { id: 'bad', task: 'unknown' },
  ];
  const result = spawnSync('python3', [launcher], { encoding: 'utf8', input: requests.map(JSON.stringify).join('\n') + '\n', env: { ...process.env, HF_HUB_CACHE: hub, CUDA_VISIBLE_DEVICES: '' }, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(messages.find((m) => m.id === 'cap').available, true);
  assert.equal(messages.find((m) => m.id === 's').done, true);
  assert.equal(messages.find((m) => m.id === 'c').done, true);
  assert.match(messages.find((m) => m.id === 'missing').error, /reference/);
  assert.match(messages.find((m) => m.id === 'bad').error, /Unknown voice task/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'speech.json'), 'utf8')), { samples: ['tts', 'Hello', reference, 0.9], rate: 24000 });
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), { samples: ['vc', '/source.wav', reference], rate: 24000 });
  const unavailable = spawnSync('python3', [launcher], { encoding: 'utf8', input: JSON.stringify(requests[0]) + '\n' + JSON.stringify(requests[2]) + '\n', env: { ...process.env, FAKE_NO_VC: '1', HF_HUB_CACHE: hub, CUDA_VISIBLE_DEVICES: '' }, timeout: 10000 });
  assert.equal(unavailable.status, 0, unavailable.stderr);
  const replies = unavailable.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(replies.find((m) => m.id === 'cap').available, false);
  assert.match(replies.find((m) => m.id === 'c').error, /Chatterbox voice conversion cannot be used/);
});

test('voice references trim silence at the ends while preserving an internal pause', async (t) => {
  const { dir, library } = await fixture(t);
  const file = path.join(dir, 'pauses.wav');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', "aevalsrc=exprs='if(between(t,1,3)+between(t,4,7),0.1*sin(2*PI*220*t),0)':s=48000:d=8", file], 10000);
  const voice = await library.create({ name: 'Pauses', audio: file, consent: true });
  assert.ok(voice.seconds > 5.9 && voice.seconds < 6.2, `trimmed duration: ${voice.seconds}`);
  const analysis = (await runCapture('ffmpeg', ['-hide_banner', '-i', library.reference(voice.id), '-af', 'silencedetect=n=-45dB:d=0.5', '-f', 'null', '-'], 10000)).stderr;
  const pauses = [...analysis.matchAll(/silence_duration:\s+([\d.]+)/g)].map((m) => Number(m[1]));
  assert.ok(pauses.some((duration) => duration > 0.9 && duration < 1.1), analysis);
});

test('installed voice worker can inspect conversion capability on CPU without loading weights', async (t) => {
  const python = process.env.LUMINA_VOICE_PYTHON || path.join(os.homedir(), '.local/share/lumina-studio/voice-env/bin/python');
  if (!existsSync(python)) return t.skip('local voice environment is missing');
  const { dir } = await fixture(t);
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(python, ['local/voice_worker.py'], {
    encoding: 'utf8', timeout: 30000,
    input: JSON.stringify({ id: 'cap', task: 'voice-capabilities' }) + '\n',
    env: { ...process.env, CUDA_VISIBLE_DEVICES: '', HF_HUB_OFFLINE: '1', HF_HUB_CACHE: path.join(dir, 'empty-hub'), PYTHONDONTWRITEBYTECODE: '1', NUMBA_CACHE_DIR: path.join(dir, 'numba'), LUMINA_VOICE_CACHE: path.join(dir, 'voice-cache') },
  });
  assert.equal(result.status, 0, result.stderr);
  const capability = result.stdout.trim().split('\n').map(JSON.parse).find((m) => m.id === 'cap');
  assert.equal(capability.done, true);
  assert.equal(typeof capability.available, 'boolean');
  if (!capability.available) assert.match(capability.reason, /Chatterbox.*cannot be used/);
});
