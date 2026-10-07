import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export const envNames = {
  openrouter: 'OPENROUTER_API_KEY', openai: 'OPENAI_API_KEY', fal: 'FAL_KEY', gemini: 'GEMINI_API_KEY', replicate: 'REPLICATE_API_TOKEN',
  anthropic: 'ANTHROPIC_API_KEY', nemotron: 'NEMOTRON_API_KEY',
};

// Keys live in a 0600 JSON file. With a cipher (Electron safeStorage → libsecret/kwallet) values are
// encrypted at rest; without one (plain `npm start`) they are stored as-is and the UI says so.
// Environment variables are a read-only fallback. Keys are never returned to the browser.
export function createKeyStore({ file, cipher = null, env = process.env }) {
  const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
  const write = (data) => {
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(temp, file);
  };

  function stored(provider) {
    const entry = read()[provider];
    if (!entry) return null;
    if (entry.kind === 'encrypted') return cipher ? cipher.decrypt(entry.data) : null;
    return entry.value;
  }

  return {
    encrypted: Boolean(cipher),
    get: (provider) => stored(provider) || env[envNames[provider]] || null,
    set(provider, value) {
      if (!(provider in envNames)) throw new Error('Unknown provider');
      const key = String(value ?? '').trim();
      if (!key || key.length > 500 || /\s/.test(key)) throw Object.assign(new Error('That does not look like an API key.'), { status: 400 });
      const data = read();
      data[provider] = cipher ? { kind: 'encrypted', data: cipher.encrypt(key) } : { kind: 'plain', value: key };
      write(data);
    },
    remove(provider) {
      const data = read();
      delete data[provider];
      write(data);
    },
    status() {
      const data = read();
      return Object.fromEntries(Object.keys(envNames).map((provider) => {
        const entry = data[provider];
        const source = entry ? 'saved' : env[envNames[provider]] ? 'environment' : null;
        return [provider, { configured: Boolean(source), source, encrypted: entry?.kind === 'encrypted', unreadable: entry?.kind === 'encrypted' && !cipher }];
      }));
    },
  };
}
