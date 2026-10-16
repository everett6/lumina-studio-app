import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createMusicService, creditKey, privateAddress } from '../src/music.js';

const wav = () => { const b = Buffer.alloc(64); b.write('RIFF', 0, 'latin1'); b.write('WAVE', 8, 'latin1'); return b; };
const id = (n) => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`;
const records = {
  [id(1)]: { id: id(1), title: 'Quiet Dawn', creator: 'Ana', license: 'by', license_version: '4.0', duration: 95000, url: 'https://files.example/dawn.wav', source: 'jamendo', attribution: '"Quiet Dawn" by Ana is licensed under CC BY 4.0.' },
  [id(2)]: { id: id(2), title: 'Short', creator: 'B', license: 'cc0', duration: 8000, url: 'https://files.example/short.wav' },
  [id(5)]: { id: id(5), title: 'No length', creator: 'E', license: 'cc0', url: 'https://files.example/unknown.wav' },
  [id(6)]: { id: id(6), title: 'Sneaky', creator: 'F', license: 'cc0', duration: 60000, url: 'https://files.example/redirect.wav' },
  [id(7)]: { id: id(7), title: 'Plain', creator: 'G', license: 'cc0', duration: 60000, url: 'http://files.example/plain.wav' },
  [id(8)]: { id: id(8), title: 'Huge', creator: 'H', license: 'cc0', duration: 60000, url: 'https://files.example/huge.wav' },
  [id(3)]: { id: id(3), title: 'Shared', creator: 'C', license: 'by-sa', duration: 120000, url: 'https://files.example/sa.wav' },
  [id(4)]: { id: id(4), title: 'Not audio', creator: 'D', license: 'cc0', duration: 60000, url: 'https://files.example/page.html' },
};
function fakeFetch(calls) {
  return async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.host === 'api.openverse.org' && u.pathname === '/v1/audio/') return Response.json({ results: u.searchParams.get('category') === 'music' ? [] : Object.values(records) });
    if (u.host === 'api.openverse.org') return Response.json(records[u.pathname.split('/')[3]]);
    if (u.pathname === '/redirect.wav') return new Response(null, { status: 302, headers: { location: 'https://internal.example/secret.wav' } });
    if (u.pathname === '/huge.wav') return new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); } }));
    if (u.pathname.endsWith('.wav')) return new Response(wav());
    return new Response('<html></html>');
  };
}
function service(calls = []) {
  const settings = new Map();
  const saved = [];
  const repo = { settings: { get: (k, d) => settings.get(k) ?? d, set: (k, v) => settings.set(k, v) } };
  const assetStore = { save: async (a) => { const asset = { id: id(9), ...a, path: '/x' }; saved.push(asset); return asset; } };
  return { music: createMusicService({ repo, assetStore, fetchImpl: fakeFetch(calls), lookupImpl: async (host) => [{ address: host === 'internal.example' ? '10.0.0.5' : '93.184.216.34' }], log: {} }), settings, saved, calls };
}

test('music search keeps only film-safe licences and long enough tracks', async () => {
  const { music, calls } = service();
  const tracks = await music.search('calm piano', { minSeconds: 30 });
  assert.deepEqual(tracks.map((t) => t.title).sort(), ['Huge', 'Not audio', 'Plain', 'Quiet Dawn', 'Sneaky'], 'share-alike, too-short and unknown-length tracks are dropped');
  assert.equal(tracks[0].license, 'CC BY 4.0');
  assert.equal(tracks[0].needsCredit, true);
  assert.equal(tracks.find((t) => t.title === 'Huge').needsCredit, false);
  assert.equal(new URL(calls[0]).searchParams.get('category'), 'music', 'the music category is tried first');
  const query = new URL(calls[1]).searchParams;
  assert.equal(query.get('category'), null, 'then all audio');
  assert.equal(query.get('license'), 'cc0,pdm,by');
  assert.equal(query.get('page_size'), '20', 'anonymous Openverse requests allow at most 20');
  assert.equal(query.get('q'), 'calm piano');
  await assert.rejects(music.search('  '), /Describe the music/);
});

test('music download re-reads the record, checks the file and keeps the credit', async () => {
  const { music, settings, saved, calls } = service();
  const { asset, track } = await music.download('p1', id(1));
  assert.equal(saved[0].kind, 'audio');
  assert.equal(saved[0].projectId, 'p1');
  assert.match(saved[0].label, /Quiet Dawn — Ana/);
  assert.equal(settings.get(creditKey(asset.id)).credit, '"Quiet Dawn" by Ana is licensed under CC BY 4.0.');
  assert.equal(music.credit(asset.id).title, 'Quiet Dawn');
  assert.equal(track.licenseUrl, null);
  assert.ok(calls.some((u) => u.endsWith(`/v1/audio/${id(1)}/`)), 'the file link comes from the catalogue, not the caller');
  await assert.rejects(music.download('p1', id(3)), /licence/);
  await assert.rejects(music.download('p1', id(4)), /not an audio file/);
  await assert.rejects(music.download('p1', 'https://evil.example/x.mp3'), /track id/);
  await assert.rejects(music.download('p1', id(6)), /private address/, 'redirects are checked hop by hop');
  await assert.rejects(music.download('p1', id(7)), /not https/);
  await assert.rejects(music.download('p1', id(8)), /too large/, 'the size cap stops the download early');
});

test('private and loopback addresses are refused', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '192.168.1.9', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.equal(privateAddress(a), true, a);
  for (const a of ['93.184.216.34', '2606:4700::1111']) assert.equal(privateAddress(a), false, a);
});

test('a preview is a short MP3 sample and nothing is saved', async () => {
  const real = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=40', '-f', 'wav', '-'], { maxBuffer: 1 << 26 }).stdout;
  const settings = new Map();
  const saved = [];
  const music = createMusicService({
    repo: { settings: { get: (k, d) => settings.get(k) ?? d, set: (k, v) => settings.set(k, v) } }, assetStore: { save: async (a) => { saved.push(a); return a; } },
    fetchImpl: async (url) => (url.includes('/v1/audio/') ? Response.json(records[id(1)]) : new Response(real)), lookupImpl: async () => [{ address: '93.184.216.34' }], log: {},
  });
  const { bytes, track } = await music.preview(id(1), { seconds: 5 });
  assert.equal(track.title, 'Quiet Dawn');
  assert.ok(bytes.length > 1000 && bytes.length < 200_000, `a small sample (${bytes.length} bytes)`);
  const seconds = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', '-'], { input: bytes, encoding: 'utf8' }).stdout);
  assert.ok(Math.abs(seconds - 5) < 0.2, `5 s long (${seconds})`);
  assert.equal(saved.length, 0);
});

test('sound effect search uses the sound_effect category and a maximum length', async () => {
  const calls = [];
  const { music } = service(calls);
  await music.search('sword', { kind: 'sound', minSeconds: 0, maxSeconds: 100 });
  assert.equal(new URL(calls[0]).searchParams.get('category'), 'sound_effect');
});

test('safe downloads refuse hosts that resolve to private addresses at connect time, and plain http', async () => {
  const { safeFetch } = await import('../src/safefetch.js');
  await assert.rejects(safeFetch('https://localhost:9/x.mp3'), /private address/);
  await assert.rejects(safeFetch('https://127.0.0.1:9/x.mp3'), /private address/);
  await assert.rejects(safeFetch('http://example.org/x.mp3'), /only https/);
});
