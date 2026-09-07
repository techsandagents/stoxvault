// File-backed Store. Used whenever DATABASE_URL is blank.
//
// Layout under cfg.dataDir:
//   prefs.json          { [wallet]: Prefs }
//   nonces.json         { [wallet]: { [nonce]: expiresAtMs } }
//   kv.json             { [key]: value }
//   index.json          { rounds: RoundSummary[] }     <- what listRounds() reads
//   rounds/<id>.json    the full Round document, one file each
//
// Crash safety: every file is written to a temp file, fsync'd, then renamed over the
// target, so a reader never sees a half-written file. Concurrency: every file has its
// own promise chain, so overlapping calls from this process are serialised (read,
// mutate, flush) instead of clobbering each other. Lock order is always
// round-file -> index, never the other way round, so it cannot deadlock.
//
// If index.json is missing it is rebuilt by scanning rounds/.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  StoreError,
  TERMINAL_STATUSES,
  clone,
  compareRoundsDesc,
  jsonSafe,
  mergeTransfer,
  normalizePrefs,
  normalizeRound,
  normalizeTransfer,
  pageArgs,
  summarizeRound,
  toMillis,
} from './index.js';

class Lock {
  constructor() {
    this.tail = Promise.resolve();
  }
  run(fn) {
    const result = this.tail.then(() => fn());
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function roundFileName(id) {
  if (typeof id !== 'string' || id.trim() === '') throw new StoreError('round id is required', 'bad_argument');
  const trimmed = id.trim();
  if (trimmed === '.' || trimmed === '..') throw new StoreError('invalid round id', 'bad_argument');
  return `${encodeURIComponent(trimmed)}.json`;
}

async function readJson(file, fallback) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    throw err;
  }
  if (text.trim() === '') return fallback;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new StoreError(`corrupt store file: ${file} (${err.message})`, 'corrupt_file');
  }
}

async function writeAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const text = `${JSON.stringify(value, null, 0)}\n`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * @param {{dataDir?: string}} cfg
 * @returns {Promise<object>} Store
 */
export async function openJsonStore(cfg = {}) {
  const dir = cfg.dataDir ? String(cfg.dataDir) : path.resolve('data/state');
  const roundsDir = path.join(dir, 'rounds');
  await fs.mkdir(roundsDir, { recursive: true });

  const files = {
    prefs: path.join(dir, 'prefs.json'),
    nonces: path.join(dir, 'nonces.json'),
    kv: path.join(dir, 'kv.json'),
    index: path.join(dir, 'index.json'),
  };

  // sweep temp files left behind by a crash
  for (const target of [dir, roundsDir]) {
    const entries = await fs.readdir(target).catch(() => []);
    await Promise.all(
      entries.filter((n) => n.endsWith('.tmp')).map((n) => fs.rm(path.join(target, n), { force: true }).catch(() => {})),
    );
  }

  const locks = new Map();
  const lockFor = (key) => {
    let lock = locks.get(key);
    if (!lock) {
      lock = new Lock();
      locks.set(key, lock);
    }
    return lock;
  };

  let closed = false;
  const assertOpen = () => {
    if (closed) throw new StoreError('store is closed', 'store_closed');
  };

  /** @type {Map<string, object>|null} */ let prefsCache = null;
  /** @type {Map<string, Map<string, number>>|null} */ let noncesCache = null;
  /** @type {Map<string, unknown>|null} */ let kvCache = null;
  /** @type {Map<string, object>|null} */ let indexCache = null;
  /** @type {Map<string, {doc: object, idx: Map<string, number>}>} */ const roundCache = new Map();

  async function loadPrefs() {
    if (!prefsCache) {
      const raw = await readJson(files.prefs, {});
      prefsCache = new Map(Object.entries(raw && typeof raw === 'object' ? raw : {}));
    }
    return prefsCache;
  }
  const flushPrefs = () => writeAtomic(files.prefs, Object.fromEntries(prefsCache));

  async function loadNonces() {
    if (!noncesCache) {
      const raw = await readJson(files.nonces, {});
      noncesCache = new Map();
      for (const [wallet, byNonce] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
        const inner = new Map();
        for (const [nonce, exp] of Object.entries(byNonce || {})) {
          const ms = toMillis(exp, null);
          if (ms !== null) inner.set(nonce, ms);
        }
        if (inner.size) noncesCache.set(wallet, inner);
      }
    }
    return noncesCache;
  }
  function pruneNonces(now = Date.now()) {
    for (const [wallet, inner] of noncesCache) {
      for (const [nonce, exp] of inner) if (exp <= now) inner.delete(nonce);
      if (inner.size === 0) noncesCache.delete(wallet);
    }
  }
  const flushNonces = () => {
    const out = {};
    for (const [wallet, inner] of noncesCache) out[wallet] = Object.fromEntries(inner);
    return writeAtomic(files.nonces, out);
  };

  async function loadKv() {
    if (!kvCache) {
      const raw = await readJson(files.kv, {});
      kvCache = new Map(Object.entries(raw && typeof raw === 'object' ? raw : {}));
    }
    return kvCache;
  }
  const flushKv = () => writeAtomic(files.kv, Object.fromEntries(kvCache));

  async function loadIndex() {
    if (indexCache) return indexCache;
    const raw = await readJson(files.index, null);
    indexCache = new Map();
    if (raw && Array.isArray(raw.rounds)) {
      for (const summary of raw.rounds) if (summary && summary.id) indexCache.set(summary.id, summary);
      return indexCache;
    }
    // rebuild from the round documents
    const entries = await fs.readdir(roundsDir).catch(() => []);
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const doc = await readJson(path.join(roundsDir, name), null);
      if (doc && doc.id) indexCache.set(doc.id, summarizeRound(doc));
    }
    if (indexCache.size) await writeAtomic(files.index, { rounds: [...indexCache.values()] });
    return indexCache;
  }
  const flushIndex = () =>
    writeAtomic(files.index, { rounds: [...indexCache.values()].sort(compareRoundsDesc) });

  async function loadRound(id) {
    const cached = roundCache.get(id);
    if (cached) return cached;
    const doc = await readJson(path.join(roundsDir, roundFileName(id)), null);
    if (!doc) return null;
    const entry = { doc, idx: new Map() };
    doc.transfers = Array.isArray(doc.transfers) ? doc.transfers : [];
    doc.transfers.forEach((t, i) => entry.idx.set(`${t.wallet} ${t.mint}`, i));
    roundCache.set(id, entry);
    return entry;
  }
  const flushRound = (entry) => writeAtomic(path.join(roundsDir, roundFileName(entry.doc.id)), entry.doc);

  /** Refresh the index entry for a round; only rewrites index.json when it changed. */
  async function syncIndex(doc) {
    await lockFor('index').run(async () => {
      const index = await loadIndex();
      const next = summarizeRound(doc);
      const prev = index.get(doc.id);
      if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
      index.set(doc.id, next);
      await flushIndex();
    });
  }

  const store = {
    kind: 'json',
    dataDir: dir,

    /* ------------------------------------------------------------- prefs */

    async getPrefs(wallet) {
      assertOpen();
      return lockFor('prefs').run(async () => {
        const prefs = await loadPrefs();
        const found = prefs.get(String(wallet));
        return found ? clone(found) : null;
      });
    },

    async setPrefs(input) {
      assertOpen();
      const record = normalizePrefs(input);
      return lockFor('prefs').run(async () => {
        const prefs = await loadPrefs();
        prefs.set(record.wallet, record);
        await flushPrefs();
        return clone(record);
      });
    },

    async deletePrefs(wallet) {
      assertOpen();
      return lockFor('prefs').run(async () => {
        const prefs = await loadPrefs();
        if (prefs.delete(String(wallet))) await flushPrefs();
      });
    },

    async listPrefs(opts = {}) {
      assertOpen();
      const { limit, offset } = pageArgs(opts, 100);
      return lockFor('prefs').run(async () => {
        const prefs = await loadPrefs();
        const all = [...prefs.values()].sort((a, b) => {
          const at = toMillis(a.updatedAt, 0) ?? 0;
          const bt = toMillis(b.updatedAt, 0) ?? 0;
          if (at !== bt) return bt - at;
          return a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0;
        });
        return { items: all.slice(offset, offset + limit).map(clone), total: all.length };
      });
    },

    async allPrefs() {
      assertOpen();
      return lockFor('prefs').run(async () => {
        const prefs = await loadPrefs();
        return [...prefs.values()].sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0)).map(clone);
      });
    },

    /* ------------------------------------------------------------ nonces */

    async putNonce(wallet, nonce, expiresAt) {
      assertOpen();
      const w = String(wallet);
      const n = String(nonce);
      const exp = toMillis(expiresAt, null);
      if (exp === null) throw new StoreError('putNonce: expiresAt is required', 'bad_argument');
      return lockFor('nonces').run(async () => {
        const nonces = await loadNonces();
        pruneNonces();
        if (!nonces.has(w)) nonces.set(w, new Map());
        nonces.get(w).set(n, exp);
        await flushNonces();
      });
    },

    async takeNonce(wallet, nonce) {
      assertOpen();
      const w = String(wallet);
      const n = String(nonce);
      return lockFor('nonces').run(async () => {
        const nonces = await loadNonces();
        const now = Date.now();
        const inner = nonces.get(w);
        const exp = inner ? inner.get(n) : undefined;
        const ok = exp !== undefined && exp > now;
        if (inner) {
          inner.delete(n);
          if (inner.size === 0) nonces.delete(w);
        }
        pruneNonces(now);
        await flushNonces();
        return ok;
      });
    },

    /* ------------------------------------------------------------ rounds */

    async createRound(round) {
      assertOpen();
      const doc = normalizeRound(round);
      return lockFor(`round:${doc.id}`).run(async () => {
        const existing = await loadRound(doc.id);
        if (existing) throw new StoreError(`round ${doc.id} already exists`, 'round_exists');
        const entry = { doc, idx: new Map() };
        doc.transfers.forEach((t, i) => entry.idx.set(`${t.wallet} ${t.mint}`, i));
        roundCache.set(doc.id, entry);
        await flushRound(entry);
        await syncIndex(doc);
        return clone(doc);
      });
    },

    async updateRound(id, patch = {}) {
      assertOpen();
      const roundId = String(id);
      return lockFor(`round:${roundId}`).run(async () => {
        const entry = await loadRound(roundId);
        if (!entry) throw new StoreError(`round ${roundId} not found`, 'round_not_found');
        const { transfers, ...rest } = jsonSafe(patch) || {};
        Object.assign(entry.doc, rest);
        entry.doc.id = roundId;
        if (Array.isArray(transfers)) {
          for (const raw of transfers) {
            const incoming = normalizeTransfer(raw);
            const key = `${incoming.wallet} ${incoming.mint}`;
            const at = entry.idx.get(key);
            if (at === undefined) {
              entry.idx.set(key, entry.doc.transfers.push(incoming) - 1);
            } else {
              entry.doc.transfers[at] = mergeTransfer(entry.doc.transfers[at], raw);
            }
          }
        }
        entry.doc.updatedAt = new Date().toISOString();
        await flushRound(entry);
        await syncIndex(entry.doc);
        return clone(entry.doc);
      });
    },

    async getRound(id) {
      assertOpen();
      const roundId = String(id);
      return lockFor(`round:${roundId}`).run(async () => {
        const entry = await loadRound(roundId);
        return entry ? clone(entry.doc) : null;
      });
    },

    async listRounds(opts = {}) {
      assertOpen();
      const { limit, offset } = pageArgs(opts, 50);
      return lockFor('index').run(async () => {
        const index = await loadIndex();
        const all = [...index.values()].sort(compareRoundsDesc);
        return { items: all.slice(offset, offset + limit).map(clone), total: all.length };
      });
    },

    async latestRound() {
      assertOpen();
      const id = await lockFor('index').run(async () => {
        const index = await loadIndex();
        const all = [...index.values()].sort(compareRoundsDesc);
        return all.length ? all[0].id : null;
      });
      return id ? store.getRound(id) : null;
    },

    async unfinishedRound() {
      assertOpen();
      const id = await lockFor('index').run(async () => {
        const index = await loadIndex();
        const open = [...index.values()]
          .filter((r) => !TERMINAL_STATUSES.includes(r.status))
          .sort((a, b) => -compareRoundsDesc(a, b));
        return open.length ? open[0].id : null;
      });
      return id ? store.getRound(id) : null;
    },

    async markTransfer(roundId, wallet, mint, patch = {}) {
      assertOpen();
      const id = String(roundId);
      const key = `${wallet} ${mint}`;
      return lockFor(`round:${id}`).run(async () => {
        const entry = await loadRound(id);
        if (!entry) throw new StoreError(`round ${id} not found`, 'round_not_found');
        const at = entry.idx.get(key);
        let created = false;
        let row;
        if (at === undefined) {
          row = normalizeTransfer({ ...(jsonSafe(patch) || {}), wallet, mint });
          entry.idx.set(key, entry.doc.transfers.push(row) - 1);
          created = true;
        } else {
          row = mergeTransfer(entry.doc.transfers[at], patch);
          entry.doc.transfers[at] = row;
        }
        entry.doc.updatedAt = new Date().toISOString();
        await flushRound(entry);
        if (created) await syncIndex(entry.doc); // only the transferCount can change
        return clone(row);
      });
    },

    /* ---------------------------------------------------------------- kv */

    async getKV(key) {
      assertOpen();
      return lockFor('kv').run(async () => {
        const kv = await loadKv();
        const k = String(key);
        return kv.has(k) ? clone(kv.get(k)) : null;
      });
    },

    async setKV(key, value) {
      assertOpen();
      const k = String(key);
      const safe = jsonSafe(value);
      return lockFor('kv').run(async () => {
        const kv = await loadKv();
        kv.set(k, safe === undefined ? null : safe);
        await flushKv();
      });
    },

    async close() {
      if (closed) return;
      closed = true;
      // every mutation flushes before it resolves; wait for any still in flight
      await Promise.allSettled([...locks.values()].map((l) => l.tail));
      prefsCache = null;
      noncesCache = null;
      kvCache = null;
      indexCache = null;
      roundCache.clear();
    },
  };

  return store;
}

export default openJsonStore;
