import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { crc32 } from './png.js';

// Minimal ZIP writer (enough for EPUB): entries are written in order, `store: true` skips compression
// (EPUB requires the first entry, "mimetype", to be stored uncompressed).
export function createZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const body = entry.store ? data : deflateRawSync(data, { level: 9 });
    const method = entry.store ? 0 : 8;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// Minimal ZIP reader (enough for .docx): returns a Map of entry name to bytes. Refuses archives that unpack too large.
export function readZip(bytes, { maxBytes = 64 * 1024 * 1024 } = {}) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66_000); i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('Not a ZIP file.');
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const entries = new Map();
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Damaged ZIP file.');
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    total += size;
    if (total > maxBytes) throw new Error('The file is too large to import.');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const body = bytes.subarray(start, start + compressed);
    if (method === 0) entries.set(name, body);
    else if (method === 8) entries.set(name, inflateRawSync(body, { maxOutputLength: maxBytes }));
  }
  return entries;
}

// Reads chosen files out of a ZIP on a web server with HTTP range requests, so a large release archive does not
// have to be downloaded whole (RIFE's is 431 MB; Lumina needs about 20 MB of it). `want(name)` picks entries.
export async function fetchZipEntries(url, want, { fetchImpl = (...a) => fetch(...a), timeoutMs = 300_000 } = {}) {
  const get = async (range) => {
    const response = await fetchImpl(url, { headers: { range }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 206) throw new Error(`The download server did not allow a partial download (HTTP ${response.status}).`);
    return { bytes: Buffer.from(await response.arrayBuffer()), total: Number(/\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1]) };
  };
  const head = await fetchImpl(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  const length = Number(head.headers.get('content-length'));
  if (!head.ok || !length) throw new Error(`Could not read the archive size (HTTP ${head.status}).`);
  const tail = await get(`bytes=${Math.max(0, length - 262144)}-${length - 1}`);
  const end = tail.bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || !tail.total) throw new Error('Not a ZIP archive.');
  const size = tail.bytes.readUInt32LE(end + 12);
  const offset = tail.bytes.readUInt32LE(end + 16);
  const base = tail.total - tail.bytes.length;
  if (offset < base) throw new Error('The archive index is larger than expected.');
  const directory = tail.bytes.subarray(offset - base, offset - base + size);
  const entries = new Map();
  for (let p = 0; p + 46 <= directory.length;) {
    if (directory.readUInt32LE(p) !== 0x02014b50) throw new Error('Damaged ZIP index.');
    const method = directory.readUInt16LE(p + 10);
    const compressed = directory.readUInt32LE(p + 20);
    const nameLength = directory.readUInt16LE(p + 28);
    const local = directory.readUInt32LE(p + 42);
    const name = directory.toString('utf8', p + 46, p + 46 + nameLength);
    p += 46 + nameLength + directory.readUInt16LE(p + 30) + directory.readUInt16LE(p + 32);
    if (!want(name) || name.endsWith('/')) continue;
    // Local header is 30 bytes plus a name and extra field whose lengths can differ from the index; 1 KB covers them.
    const { bytes } = await get(`bytes=${local}-${local + 30 + 1024 + compressed}`);
    if (bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('Damaged ZIP entry.');
    const start = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
    const body = bytes.subarray(start, start + compressed);
    entries.set(name, method === 8 ? inflateRawSync(body) : Buffer.from(body));
  }
  return entries;
}
