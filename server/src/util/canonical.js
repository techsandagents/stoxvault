// Deterministic JSON + hashing.
//
// Round math has to be reproducible by anyone from the stored round document, so
// every hash in this project is taken over canonicalJson(): object keys sorted,
// bigints written as decimal strings, no incidental whitespace.

import crypto from 'node:crypto';

function isPlainish(v) {
  return typeof v === 'object' && v !== null;
}

function encode(value, seen) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'bigint') return JSON.stringify(value.toString());
  if (t === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (t === 'undefined' || t === 'function' || t === 'symbol') return undefined;

  if (value instanceof Date) return JSON.stringify(value.toISOString());

  if (isPlainish(value)) {
    if (seen.has(value)) throw new TypeError('canonicalJson: circular structure');
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const parts = value.map((v) => {
          const s = encode(v, seen);
          return s === undefined ? 'null' : s;
        });
        return `[${parts.join(',')}]`;
      }
      if (value instanceof Map) {
        const entries = [...value.entries()].map(([k, v]) => [String(k), v]);
        return encodeEntries(entries, seen);
      }
      if (value instanceof Set) {
        const parts = [...value].map((v) => {
          const s = encode(v, seen);
          return s === undefined ? 'null' : s;
        });
        return `[${parts.join(',')}]`;
      }
      if (ArrayBuffer.isView(value)) {
        return `[${Array.from(value, (n) => (typeof n === 'bigint' ? JSON.stringify(n.toString()) : JSON.stringify(n))).join(',')}]`;
      }
      if (typeof value.toJSON === 'function') return encode(value.toJSON(), seen);
      return encodeEntries(Object.keys(value).map((k) => [k, value[k]]), seen);
    } finally {
      seen.delete(value);
    }
  }
  return undefined;
}

function encodeEntries(entries, seen) {
  const sorted = entries.slice().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const parts = [];
  for (const [key, raw] of sorted) {
    const encoded = encode(raw, seen);
    if (encoded === undefined) continue; // same rule as JSON.stringify: undefined keys vanish
    parts.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * Deterministic JSON string: keys sorted at every level, bigints as strings,
 * Dates as ISO strings, undefined dropped from objects / null inside arrays.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  const out = encode(value, new Set());
  return out === undefined ? 'null' : out;
}

/**
 * @param {string|Buffer|Uint8Array} input
 * @returns {string} lowercase hex sha256
 */
export function sha256Hex(input) {
  const hash = crypto.createHash('sha256');
  hash.update(typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input));
  return hash.digest('hex');
}

/** sha256Hex(canonicalJson(value)) */
export function canonicalHash(value) {
  return sha256Hex(canonicalJson(value));
}

export default { canonicalJson, sha256Hex, canonicalHash };
