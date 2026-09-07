// Postgres Store. Used whenever DATABASE_URL is set.
//
// Same interface and the same semantics as the JSON store (CONTRACT.md section 4).
// Tables are created on first open with CREATE TABLE IF NOT EXISTS. Every statement is
// parameterised; no value is ever interpolated into SQL. jsonb parameters are always
// passed as a JSON string with an explicit ::jsonb cast, because node-pg would otherwise
// turn a JS array into a Postgres array literal.
//
// Round documents are stored in `rounds.doc` WITHOUT their transfers; transfers live in
// their own table keyed (round_id, wallet, mint) and are re-attached by getRound().

import pg from 'pg';
import {
  StoreError,
  TERMINAL_STATUSES,
  clone,
  jsonSafe,
  mergeTransfer,
  normalizePrefs,
  normalizeRound,
  normalizeTransfer,
  pageArgs,
  summarizeRound,
  toIso,
  toMillis,
} from './index.js';

const { Pool } = pg;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS prefs (
     wallet     text PRIMARY KEY,
     picks      jsonb NOT NULL,
     signature  text,
     message    text,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS nonces (
     wallet     text NOT NULL,
     nonce      text NOT NULL,
     expires_at timestamptz NOT NULL,
     PRIMARY KEY (wallet, nonce)
   )`,
  `CREATE INDEX IF NOT EXISTS nonces_expires_at_idx ON nonces (expires_at)`,
  `CREATE TABLE IF NOT EXISTS rounds (
     id          text PRIMARY KEY,
     doc         jsonb NOT NULL,
     status      text NOT NULL,
     created_at  timestamptz NOT NULL DEFAULT now(),
     finished_at timestamptz
   )`,
  `CREATE INDEX IF NOT EXISTS rounds_created_at_idx ON rounds (created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS rounds_status_idx ON rounds (status)`,
  `CREATE TABLE IF NOT EXISTS transfers (
     round_id text NOT NULL,
     wallet   text NOT NULL,
     mint     text NOT NULL,
     doc      jsonb NOT NULL,
     status   text NOT NULL,
     PRIMARY KEY (round_id, wallet, mint)
   )`,
  `CREATE INDEX IF NOT EXISTS transfers_round_idx ON transfers (round_id)`,
  `CREATE TABLE IF NOT EXISTS kv (
     key   text PRIMARY KEY,
     value jsonb NOT NULL
   )`,
];

const json = (value) => JSON.stringify(value === undefined ? null : value);

function sslFor(url) {
  if (/[?&]sslmode=disable/i.test(url)) return false;
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(url)) return false;
  return { rejectUnauthorized: false };
}

function rowToPrefs(row) {
  if (!row) return null;
  return {
    wallet: row.wallet,
    picks: Array.isArray(row.picks) ? row.picks : [],
    signature: row.signature ?? null,
    message: row.message ?? null,
    updatedAt: toIso(row.updated_at, null),
  };
}

function docWithoutTransfers(doc) {
  const { transfers, ...rest } = doc;
  return rest;
}

/**
 * @param {{databaseUrl: string}} cfg
 * @returns {Promise<object>} Store
 */
export async function openPgStore(cfg = {}) {
  const connectionString = cfg.databaseUrl;
  if (!connectionString) throw new StoreError('openPgStore requires cfg.databaseUrl', 'bad_argument');

  const pool = new Pool({
    connectionString,
    ssl: sslFor(connectionString),
    max: Number(cfg.pgPoolMax) > 0 ? Number(cfg.pgPoolMax) : 8,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', () => {
    /* a broken idle client must not take the process down; the next query reconnects */
  });

  const client0 = await pool.connect();
  try {
    for (const statement of SCHEMA) await client0.query(statement);
  } finally {
    client0.release();
  }

  let closed = false;
  const assertOpen = () => {
    if (closed) throw new StoreError('store is closed', 'store_closed');
  };
  const q = (text, params) => pool.query(text, params);

  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function transfersFor(client, roundId) {
    const { rows } = await client.query(
      'SELECT doc FROM transfers WHERE round_id = $1 ORDER BY wallet ASC, mint ASC',
      [roundId],
    );
    return rows.map((r) => r.doc);
  }

  async function upsertTransfer(client, roundId, wallet, mint, patch) {
    const { rows } = await client.query(
      'SELECT doc FROM transfers WHERE round_id = $1 AND wallet = $2 AND mint = $3 FOR UPDATE',
      [roundId, wallet, mint],
    );
    let row;
    if (rows.length === 0) {
      row = normalizeTransfer({ ...(jsonSafe(patch) || {}), wallet, mint });
      await client.query(
        'INSERT INTO transfers (round_id, wallet, mint, doc, status) VALUES ($1,$2,$3,$4::jsonb,$5)',
        [roundId, wallet, mint, json(row), row.status],
      );
    } else {
      row = mergeTransfer(rows[0].doc, patch);
      await client.query(
        'UPDATE transfers SET doc = $4::jsonb, status = $5 WHERE round_id = $1 AND wallet = $2 AND mint = $3',
        [roundId, wallet, mint, json(row), row.status],
      );
    }
    return row;
  }

  async function readRound(client, roundId) {
    const { rows } = await client.query('SELECT doc FROM rounds WHERE id = $1', [roundId]);
    if (rows.length === 0) return null;
    return { ...rows[0].doc, transfers: await transfersFor(client, roundId) };
  }

  const store = {
    kind: 'pg',
    dataDir: null,

    /* ------------------------------------------------------------- prefs */

    async getPrefs(wallet) {
      assertOpen();
      const { rows } = await q('SELECT * FROM prefs WHERE wallet = $1', [String(wallet)]);
      return rowToPrefs(rows[0]);
    },

    async setPrefs(input) {
      assertOpen();
      const record = normalizePrefs(input);
      await q(
        `INSERT INTO prefs (wallet, picks, signature, message, updated_at)
         VALUES ($1, $2::jsonb, $3, $4, $5)
         ON CONFLICT (wallet) DO UPDATE
           SET picks = excluded.picks,
               signature = excluded.signature,
               message = excluded.message,
               updated_at = excluded.updated_at`,
        [record.wallet, json(record.picks), record.signature, record.message, new Date(toMillis(record.updatedAt, Date.now()))],
      );
      return clone(record);
    },

    async deletePrefs(wallet) {
      assertOpen();
      await q('DELETE FROM prefs WHERE wallet = $1', [String(wallet)]);
    },

    async listPrefs(opts = {}) {
      assertOpen();
      const { limit, offset } = pageArgs(opts, 100);
      const { rows } = await q(
        'SELECT * FROM prefs ORDER BY updated_at DESC, wallet ASC LIMIT $1 OFFSET $2',
        [limit, offset],
      );
      const { rows: countRows } = await q('SELECT count(*)::int AS n FROM prefs');
      return { items: rows.map(rowToPrefs), total: countRows[0].n };
    },

    async allPrefs() {
      assertOpen();
      const { rows } = await q('SELECT * FROM prefs ORDER BY wallet ASC');
      return rows.map(rowToPrefs);
    },

    /* ------------------------------------------------------------ nonces */

    async putNonce(wallet, nonce, expiresAt) {
      assertOpen();
      const ms = toMillis(expiresAt, null);
      if (ms === null) throw new StoreError('putNonce: expiresAt is required', 'bad_argument');
      await q(
        `INSERT INTO nonces (wallet, nonce, expires_at) VALUES ($1,$2,$3)
         ON CONFLICT (wallet, nonce) DO UPDATE SET expires_at = excluded.expires_at`,
        [String(wallet), String(nonce), new Date(ms)],
      );
      await q('DELETE FROM nonces WHERE expires_at <= now()');
    },

    async takeNonce(wallet, nonce) {
      assertOpen();
      const { rows } = await q(
        'DELETE FROM nonces WHERE wallet = $1 AND nonce = $2 RETURNING expires_at',
        [String(wallet), String(nonce)],
      );
      if (rows.length === 0) return false;
      const exp = toMillis(rows[0].expires_at, 0) ?? 0;
      return exp > Date.now();
    },

    /* ------------------------------------------------------------ rounds */

    async createRound(round) {
      assertOpen();
      const doc = normalizeRound(round);
      const transfers = doc.transfers;
      const body = docWithoutTransfers(doc);
      await tx(async (client) => {
        const { rowCount } = await client.query(
          `INSERT INTO rounds (id, doc, status, created_at, finished_at)
           VALUES ($1,$2::jsonb,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
          [
            doc.id,
            json(body),
            doc.status,
            new Date(toMillis(doc.createdAt, Date.now())),
            doc.finishedAt ? new Date(toMillis(doc.finishedAt, Date.now())) : null,
          ],
        );
        if (rowCount === 0) throw new StoreError(`round ${doc.id} already exists`, 'round_exists');
        for (const t of transfers) await upsertTransfer(client, doc.id, t.wallet, t.mint, t);
      });
      return clone(doc);
    },

    async updateRound(id, patch = {}) {
      assertOpen();
      const roundId = String(id);
      return tx(async (client) => {
        const { rows } = await client.query('SELECT doc FROM rounds WHERE id = $1 FOR UPDATE', [roundId]);
        if (rows.length === 0) throw new StoreError(`round ${roundId} not found`, 'round_not_found');
        const { transfers, ...rest } = jsonSafe(patch) || {};
        const body = { ...docWithoutTransfers(rows[0].doc), ...rest, id: roundId, updatedAt: new Date().toISOString() };
        await client.query(
          'UPDATE rounds SET doc = $2::jsonb, status = $3, finished_at = $4 WHERE id = $1',
          [
            roundId,
            json(body),
            typeof body.status === 'string' && body.status ? body.status : 'PENDING',
            body.finishedAt ? new Date(toMillis(body.finishedAt, Date.now())) : null,
          ],
        );
        if (Array.isArray(transfers)) {
          for (const raw of transfers) {
            const t = normalizeTransfer(raw);
            await upsertTransfer(client, roundId, t.wallet, t.mint, raw);
          }
        }
        return { ...body, transfers: await transfersFor(client, roundId) };
      });
    },

    async getRound(id) {
      assertOpen();
      const client = await pool.connect();
      try {
        return await readRound(client, String(id));
      } finally {
        client.release();
      }
    },

    async listRounds(opts = {}) {
      assertOpen();
      const { limit, offset } = pageArgs(opts, 50);
      const { rows } = await q(
        'SELECT doc FROM rounds ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2',
        [limit, offset],
      );
      const { rows: countRows } = await q('SELECT count(*)::int AS n FROM rounds');
      return { items: rows.map((r) => summarizeRound(r.doc)), total: countRows[0].n };
    },

    async latestRound() {
      assertOpen();
      const client = await pool.connect();
      try {
        const { rows } = await client.query('SELECT id FROM rounds ORDER BY created_at DESC, id DESC LIMIT 1');
        return rows.length ? readRound(client, rows[0].id) : null;
      } finally {
        client.release();
      }
    },

    async unfinishedRound() {
      assertOpen();
      const client = await pool.connect();
      try {
        const { rows } = await client.query(
          `SELECT id FROM rounds WHERE NOT (status = ANY($1::text[])) ORDER BY created_at ASC, id ASC LIMIT 1`,
          [TERMINAL_STATUSES],
        );
        return rows.length ? readRound(client, rows[0].id) : null;
      } finally {
        client.release();
      }
    },

    async markTransfer(roundId, wallet, mint, patch = {}) {
      assertOpen();
      const id = String(roundId);
      return tx(async (client) => {
        const { rows } = await client.query('SELECT 1 FROM rounds WHERE id = $1', [id]);
        if (rows.length === 0) throw new StoreError(`round ${id} not found`, 'round_not_found');
        return upsertTransfer(client, id, String(wallet), String(mint), patch);
      });
    },

    /* ---------------------------------------------------------------- kv */

    async getKV(key) {
      assertOpen();
      const { rows } = await q('SELECT value FROM kv WHERE key = $1', [String(key)]);
      return rows.length ? rows[0].value : null;
    },

    async setKV(key, value) {
      assertOpen();
      await q(
        `INSERT INTO kv (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        [String(key), json(jsonSafe(value))],
      );
    },

    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };

  return store;
}

export default openPgStore;
