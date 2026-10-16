import { lookup as dnsLookup } from 'node:dns';
import https from 'node:https';
import { isIP } from 'node:net';

// Downloads from the internet that only ever reach public https hosts. The address is checked inside the socket's
// own DNS lookup, so the connection goes to exactly the address that was checked (no DNS rebinding between a
// check and the connect). TLS still verifies the certificate for the host name. Redirects are not followed here:
// callers follow them hop by hop, and every hop goes through this check again.
export function privateAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || a >= 224;
  }
  const v6 = address.toLowerCase();
  if (v6.startsWith('::ffff:')) return privateAddress(v6.slice(7));
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff');
}

const checkedLookup = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: isIP(addresses) }];
    if (!list.length || list.some((a) => privateAddress(a.address))) {
      return callback(Object.assign(new Error(`${hostname} resolves to a private address`), { code: 'EPRIVATE' }));
    }
    return options.all ? callback(null, list) : callback(null, list[0].address, list[0].family);
  });
};

// fetch-like: resolves to { ok, status, headers: { get }, body (async iterable), arrayBuffer(), json() }.
export function safeFetch(url, { headers = {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'https:') return reject(new Error('only https links are allowed'));
    if (isIP(target.hostname.replace(/^\[|\]$/g, '')) && privateAddress(target.hostname.replace(/^\[|\]$/g, ''))) return reject(new Error('private address'));
    const request = https.get(target, { headers, lookup: checkedLookup, signal }, (res) => {
      const read = async () => { const chunks = []; for await (const c of res) chunks.push(c); return Buffer.concat(chunks); };
      resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode,
        headers: { get: (name) => { const v = res.headers[name.toLowerCase()]; return Array.isArray(v) ? v.join(', ') : v ?? null; } },
        body: Object.assign(res, { cancel: async () => res.destroy() }),
        arrayBuffer: async () => { const b = await read(); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
        json: async () => JSON.parse((await read()).toString('utf8')),
      });
    });
    request.on('error', reject);
  });
}
