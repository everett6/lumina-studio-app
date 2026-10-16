import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { run } from './video.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const slugOf = (id) => {
  const match = /^custom:([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(id);
  if (!match || match[1].length > 64) throw fail(400, 'Invalid custom voice id.');
  return match[1];
};
const audioInfo = async (file) => {
  const info = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], 30000));
  const stream = info.streams?.find((s) => s.codec_type === 'audio');
  return stream ? Number(stream.duration ?? info.format?.duration ?? 0) : 0;
};

// Each voice owns a directory: metadata is published only after its reference is ready.
// mkdir's exclusive reservation also prevents simultaneous creations from overwriting a voice.
export function createVoiceLibrary({ dir }) {
  const folder = (id) => path.join(dir, slugOf(id));
  function get(id) {
    const file = path.join(folder(id), 'voice.json');
    if (!existsSync(file)) throw fail(404, 'Custom voice not found.');
    return JSON.parse(readFileSync(file, 'utf8'));
  }
  return {
    list() {
      if (!existsSync(dir)) return [];
      return readdirSync(dir).filter((slug) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
        .filter((slug) => existsSync(path.join(dir, slug, 'voice.json')))
        .flatMap((slug) => {
          // One damaged voice.json (e.g. from a crash mid-write) must not hide every other voice.
          try { return [get(`custom:${slug}`)]; } catch { return []; }
        });
    },
    reference(id) {
      get(id);
      const file = path.join(folder(id), 'reference.wav');
      if (!existsSync(file)) throw fail(404, 'Custom voice reference clip is missing.');
      return file;
    },
    async create({ name, audio, audioAssetId = null, consent }) {
      if (consent !== true) throw fail(400, 'consent must be true: use only your own voice or a voice you have permission to use.');
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw fail(400, 'A voice name of 1–100 characters is required.');
      name = name.trim();
      const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64).replace(/-$/, '') || 'voice';
      const id = `custom:${slug}`;
      mkdirSync(dir, { recursive: true });
      const target = folder(id);
      try { mkdirSync(target); } catch (error) {
        if (error.code === 'EEXIST') throw fail(409, 'A custom voice with this name already exists. Choose a different name.');
        throw error;
      }
      try {
        const duration = await audioInfo(audio);
        if (!Number.isFinite(duration) || duration < 5 || duration > 30) throw fail(400, 'Choose a clean speech clip between 5 and 30 seconds.');
        const reference = path.join(target, 'reference.wav');
        // Trim leading/trailing silence only; keep pauses within the performance.
        const trim = 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05';
        await run('ffmpeg', ['-v', 'error', '-i', audio, '-vn', '-af', `aformat=channel_layouts=mono,loudnorm=I=-20:TP=-2:LRA=7,aresample=24000,${trim},areverse,${trim},areverse,atrim=duration=${duration},asetpts=N/SR/TB`, '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', reference], 60000);
        const seconds = await audioInfo(reference);
        if (!Number.isFinite(seconds) || seconds < 5 || seconds > 30) throw fail(400, 'The trimmed clip must contain 5–30 seconds of clean speech; it may be silent or too short.');
        const voice = { id, name, audioAssetId, consent: true, consentAt: new Date().toISOString(), seconds, sampleRate: 24000, channels: 1, engine: 'chatterbox' };
        writeFileSync(path.join(target, 'voice.json'), JSON.stringify(voice, null, 2), { flag: 'wx', mode: 0o600 });
        return voice;
      } catch (error) {
        rmSync(target, { recursive: true, force: true });
        if (error.status) throw error;
        throw fail(error.missing ? 501 : 400, `Could not prepare the voice reference: ${error.message}`);
      }
    },
    delete(id) {
      get(id);
      rmSync(folder(id), { recursive: true });
      return true;
    },
  };
}

// Local providers are process singletons; the API binds their voice library at startup.
let library = null;
export function configureVoiceLibrary(options) { library = createVoiceLibrary(options); return library; }
export const customVoiceLibrary = () => library;
