import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isIP } from 'node:net';
import { sniffMedia } from './assets.js';
import { RequestError } from './generation.js';
import { run } from './video.js';

// Background music from the internet, found and downloaded when a film needs it. The catalogue is Openverse
// (api.openverse.org, run by WordPress; no key needed), which indexes openly licensed music from Jamendo,
// Freesound, Wikimedia and others. Only licences that allow use in a film without changing the film's own
// licence are accepted: CC0 and public domain (no conditions) and CC BY (credit the artist). Share-alike and
// non-commercial tracks are left out. Every downloaded track keeps its credit line, under `music-credit:<assetId>`.
const api = 'https://api.openverse.org/v1/audio/';
const licences = 'cc0,pdm,by';
const maxBytes = 40 * 1024 * 1024;
export const creditKey = (assetId) => `music-credit:${assetId}`;

// Downloads go only to public https hosts: no plain http, no loopback, private, link-local or unique-local addresses.
export function privateAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || a >= 224;
  }
  const v6 = address.toLowerCase();
  if (v6.startsWith('::ffff:')) return privateAddress(v6.slice(7));
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff');
}

const track = (r) => ({
  id: r.id, title: r.title || 'Untitled', creator: r.creator || 'Unknown artist', source: r.source ?? r.provider ?? null,
  license: `${r.license === 'pdm' ? 'Public domain' : r.license === 'cc0' ? 'CC0' : `CC ${String(r.license).toUpperCase()}`}${r.license_version && !['cc0', 'pdm'].includes(r.license) ? ` ${r.license_version}` : ''}`,
  licenseUrl: r.license_url ?? null, seconds: r.duration ? Math.round(r.duration / 1000) : null, page: r.foreign_landing_url ?? null,
  needsCredit: !['cc0', 'pdm'].includes(r.license),
  credit: r.attribution ?? `"${r.title}" by ${r.creator} (${r.license})`,
});

export function createMusicService({ repo, assetStore, fetchImpl = globalThis.fetch, lookupImpl = (host) => lookup(host, { all: true }), userAgent = 'LuminaStudio (https://github.com/everett6/lumina-studio-app)', log = console }) {
  async function checkHost(url) {
    if (url.protocol !== 'https:') throw new RequestError(502, 'The music link is not https; pick another track.');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [{ address: host }] : await lookupImpl(host).catch(() => []);
    if (!addresses.length) throw new RequestError(502, `Could not find the music host ${host}. Check the internet connection.`);
    if (addresses.some(({ address }) => privateAddress(address))) throw new RequestError(502, 'The music link points to a private address; pick another track.');
  }
  // Follows up to 5 redirects by hand, checking every hop.
  async function get(link, timeoutMs) {
    let url = new URL(link);
    const signal = AbortSignal.timeout(timeoutMs);
    for (let hop = 0; ; hop += 1) {
      await checkHost(url);
      let response;
      try {
        response = await fetchImpl(url.href, { headers: { 'user-agent': userAgent, accept: 'application/json, audio/*' }, redirect: 'manual', signal });
      } catch (error) {
        throw new RequestError(502, `Could not reach the music library (${error.name === 'TimeoutError' ? 'timed out' : error.message}). Check the internet connection.`);
      }
      if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.get('location')) {
        if (hop >= 5) throw new RequestError(502, 'The music link redirects too many times.');
        url = new URL(response.headers.get('location'), url);
        continue;
      }
      if (response.status === 429) throw new RequestError(429, 'The music library is rate-limiting requests; try again in a few minutes.');
      if (!response.ok) throw new RequestError(502, `The music library answered HTTP ${response.status}.`);
      return response;
    }
  }
  // Reads a body, stopping as soon as it passes maxBytes.
  async function readCapped(response) {
    const declared = Number(response.headers.get('content-length'));
    if (declared > maxBytes) throw new RequestError(400, 'That track is too large (over 40 MB).');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > maxBytes) { await response.body.cancel?.().catch(() => {}); throw new RequestError(400, 'That track is too large (over 40 MB).'); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  // Tracks for a mood or style, e.g. "calm piano", "epic orchestral battle", "lofi". minSeconds drops short clips.
  // kind 'music' (beds and cues) or 'sound' (sound effects: short, any length up to maxSeconds).
  async function search(query, { minSeconds = 30, maxSeconds = null, limit = 10, kind = 'music' } = {}) {
    const q = String(query ?? '').trim().slice(0, 200);
    if (!q) throw new RequestError(400, 'Describe the music to look for, e.g. "calm piano" or "epic orchestral".');
    // The "music" category first; Openverse files most Freesound music under sound effects, so fall back to all audio.
    const page = async (extra) => (await (await get(`${api}?${new URLSearchParams({ q, license: licences, page_size: '20', ...extra })}`, 20_000)).json()).results ?? [];
    let results = await page({ category: kind === 'sound' ? 'sound_effect' : 'music' });
    if (!results.length) results = await page({});
    return results
      .filter((r) => r.url && (minSeconds > 0 ? r.duration >= minSeconds * 1000 : true) && (maxSeconds ? r.duration > 0 && r.duration <= maxSeconds * 1000 : true) && ['cc0', 'pdm', 'by'].includes(r.license))
      .slice(0, Math.min(20, Math.max(1, limit))).map(track);
  }

  // Downloads one track (by its id from search) into the project library. The record is fetched again from the
  // catalogue, so the file always comes from the catalogue's own link and its licence is re-checked.
  async function fetchTrack(trackId) {
    if (!/^[0-9a-f-]{36}$/i.test(String(trackId ?? ''))) throw new RequestError(400, 'Pass a track id from the music search.');
    const record = await (await get(`${api}${trackId}/`, 20_000)).json();
    if (!['cc0', 'pdm', 'by'].includes(record.license)) throw new RequestError(400, 'That track\'s licence does not allow use in a film without conditions Lumina cannot meet.');
    const bytes = await readCapped(await get(record.url, 120_000));
    if (!sniffMedia(bytes)?.startsWith('audio/')) throw new RequestError(502, 'The download was not an audio file Lumina can use; pick another track.');
    return { info: track(record), bytes };
  }

  // A short MP3 sample (default the first 20 s) to listen to before choosing; nothing is saved.
  async function preview(trackId, { seconds = 20, start = 0 } = {}) {
    const { info, bytes } = await fetchTrack(trackId);
    const dir = await mkdtemp(path.join(tmpdir(), 'lumina-preview-'));
    try {
      await writeFile(path.join(dir, 'in'), bytes);
      await run('ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, start)), '-t', String(Math.min(30, Math.max(3, seconds))), '-i', path.join(dir, 'in'),
        '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '96k', '-af', 'afade=t=out:st=' + (Math.min(30, Math.max(3, seconds)) - 1) + ':d=1', '-y', path.join(dir, 'out.mp3')], 60_000);
      return { track: info, bytes: await readFile(path.join(dir, 'out.mp3')) };
    } finally { await rm(dir, { recursive: true, force: true }); }
  }

  async function download(projectId, trackId, { kind = 'music' } = {}) {
    const { info, bytes } = await fetchTrack(trackId);
    const asset = await assetStore.save({ bytes, projectId, kind: 'audio', label: `${kind === 'sound' ? 'Sound' : 'Music'}: ${info.title} — ${info.creator}`.slice(0, 120) });
    repo.settings.set(creditKey(asset.id), info);
    log.info?.('Downloaded music', { title: info.title, source: info.source, license: info.license });
    return { asset, track: info };
  }

  const credit = (assetId) => (assetId ? repo.settings.get(creditKey(assetId), null) : null);
  return { search, download, preview, credit };
}
