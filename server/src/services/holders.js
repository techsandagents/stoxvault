/**
 * STOCKDROP — who holds the memecoin.
 *
 * A round is only as honest as its holder list, so this service reads the
 * chain directly and never smooths anything over:
 *
 *   - with HELIUS_API_KEY: the DAS method `getTokenAccounts`, paged 1000 at a
 *     time until the mint is exhausted
 *   - without it: `getProgramAccounts` on the SPL Token program with a
 *     dataSize(165) + mint memcmp filter, asking for only the 40 bytes that
 *     matter (owner + amount) so the response stays small, and falling back to
 *     256 owner-prefix partitions if the RPC still refuses the payload
 *
 * Balances are aggregated per owner and returned as base-unit strings — one
 * wallet with five token accounts is one holder with the sum, which is what
 * eligibility and weighting must see.
 *
 * TOKEN_MINT is blank until the coin launches. Every entry point returns an
 * empty result immediately in that state; nothing here ever invents a holder.
 */

import { b58decode, b58encode } from './session.js';
import { log } from '../util/log.js';

const logger = log.child('holders');

export const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const TOKEN_ACCOUNT_SIZE = 165;
export const HELIUS_PAGE_SIZE = 1000;
export const MAX_PAGES = 1000; // 1M token accounts is far past anything real; a runaway loop stops here
export const SNAPSHOT_CACHE_MS = 60 * 1000;

/* --------------------------------------------------------------- rpc client */

function fnOf(mod, names) {
  if (!mod) return null;
  for (const name of names) {
    if (typeof mod[name] === 'function') return mod[name].bind(mod);
    const d = mod.default;
    if (d && typeof d === 'object' && typeof d[name] === 'function') return d[name].bind(d);
  }
  return null;
}

/**
 * A minimal JSON-RPC client for the configured Solana endpoint.
 *
 * Prefers `src/chain/rpc.js` when it exposes a generic call function, falls
 * back to POSTing the documented JSON-RPC body itself. The URL can carry the
 * Helius API key, so it is never logged and never returned to a caller.
 */
export function createRpcClient(cfg, deps = {}) {
  if (deps.rpc && typeof deps.rpc.call === 'function') return deps.rpc;

  const fetchImpl = deps.fetch || globalThis.fetch;
  const url = String(cfg?.rpcUrl || '');
  let chainCall;
  let id = 0;

  async function viaHttp(method, params, timeoutMs) {
    if (!url) throw new Error('no RPC url configured');
    id += 1;
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: `stockdrop-${id}`, method, params }),
    };
    if (typeof AbortSignal?.timeout === 'function') init.signal = AbortSignal.timeout(timeoutMs);
    const res = await fetchImpl(url, init);
    if (!res || typeof res.status !== 'number') throw new Error(`${method}: no response`);
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    const body = await res.json();
    if (body?.error) throw new Error(`${method}: ${body.error.message || JSON.stringify(body.error)}`);
    return body?.result;
  }

  /**
   * `src/chain/rpc.js` exports `createRpc(cfg, opts)` -> { call, ... } with
   * retries and backoff. Use it when it is there; fall back to a module-level
   * call function, then to the plain JSON-RPC POST above.
   */
  async function resolveChainCall() {
    try {
      const mod = await import('../chain/rpc.js');
      const factory = typeof mod.createRpc === 'function' ? mod.createRpc : typeof mod.default === 'function' ? mod.default : null;
      if (factory) {
        const client = factory(cfg, { logger, fetchImpl: deps.fetch });
        if (client && typeof client.call === 'function') return client.call.bind(client);
      }
      return fnOf(mod, ['rpcCall', 'call', 'request']);
    } catch {
      return null;
    }
  }

  async function call(method, params = [], { timeoutMs = 30_000 } = {}) {
    if (chainCall === undefined) chainCall = await resolveChainCall();
    if (chainCall) {
      try {
        const out = await chainCall(method, params, { timeoutMs });
        if (out !== undefined) return out;
      } catch (err) {
        // A transport that is present but broken must not silently hide a real
        // RPC error: only fall back when the module itself is the problem.
        if (err?.name === 'TypeError') {
          logger.warn(`chain/rpc is unusable, falling back to direct JSON-RPC: ${err?.message || err}`);
          chainCall = null;
        } else {
          throw err;
        }
      }
    }
    return viaHttp(method, params, timeoutMs);
  }

  return { call };
}

/* ------------------------------------------------------------------ parsing */

/** Amount from a DAS / jsonParsed field that may be a string, number or bigint. */
function toRaw(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return BigInt(Math.trunc(value));
  return 0n;
}

/**
 * 40-byte account slice (owner || amount LE u64) -> {wallet, balance}.
 * Returns null when the slice is not the shape we asked for.
 */
export function parseAccountSlice(base64) {
  let buf;
  try {
    buf = Buffer.from(String(base64), 'base64');
  } catch {
    return null;
  }
  if (buf.length < 40) return null;
  const wallet = b58encode(buf.subarray(0, 32));
  const balance = buf.readBigUInt64LE(32);
  return { wallet, balance };
}

/** Sum a list of {wallet, balance: bigint} into one row per owner, sorted deterministically. */
export function aggregate(rows) {
  const totals = new Map();
  for (const row of rows) {
    if (!row || typeof row.wallet !== 'string' || row.wallet === '') continue;
    const balance = typeof row.balance === 'bigint' ? row.balance : toRaw(row.balance);
    if (balance <= 0n) continue;
    totals.set(row.wallet, (totals.get(row.wallet) ?? 0n) + balance);
  }
  return [...totals.entries()]
    .map(([wallet, balance]) => ({ wallet, balance: balance.toString() }))
    .sort((a, b) => {
      const ab = BigInt(a.balance);
      const bb = BigInt(b.balance);
      if (ab !== bb) return bb > ab ? 1 : -1;
      return a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0;
    });
}

const looksTooLarge = (message) =>
  /too large|too many|exceed|payload|response size|413|limit reached|timed? ?out/i.test(String(message || ''));

/**
 * Params for `getTokenAccountsByOwner`.
 *
 * The second parameter is an externally-tagged enum, not a bag of options: it
 * accepts EXACTLY ONE key, either `mint` or `programId`. Sending both is
 * rejected outright — verified live against api.mainnet-beta.solana.com:
 *
 *   {"jsonrpc":"2.0","error":{"code":-32602,
 *     "message":"Invalid parameter: invalid value: map, expected map with a single key"}}
 *
 * `mint` is the right key here: the node resolves which token program owns that
 * mint by itself, so one call covers classic SPL and Token-2022 alike (also
 * verified live: `{mint: <Token-2022 xStock>}` is accepted and answers `[]`,
 * while `{mint, programId}` on the same wallet returns the -32602 above).
 *
 * @param {string} wallet owner address
 * @param {string} mint the mint to filter by
 * @returns {[string, {mint: string}, object]} JSON-RPC params
 */
export function tokenAccountsByOwnerParams(wallet, mint) {
  return [String(wallet), { mint: String(mint) }, { encoding: 'jsonParsed', commitment: 'confirmed' }];
}

/* ------------------------------------------------------------------ service */

/**
 * createHoldersService({ cfg, deps })
 *
 * @returns {{
 *   list(opts?): Promise<{wallet: string, balance: string}[]>,
 *   snapshot(opts?): Promise<object>,
 *   balanceOf(wallet: string): Promise<{raw: string, accounts: number}|null>,
 *   supply(): Promise<string|null>,
 *   vaultLamports(): Promise<number|null>
 * }}
 */
export function createHoldersService(args = {}) {
  const { cfg, now = Date.now, cacheMs = SNAPSHOT_CACHE_MS } = args;
  if (!cfg) throw new TypeError('createHoldersService: cfg is required');

  // Same two calling conventions as the universe service: `{cfg, deps}` from
  // the API, `{cfg, rpc, jup, db, logger}` from the keeper and the CLI.
  const deps = { ...(args.deps || {}) };
  if (!deps.rpc && args.rpc && typeof args.rpc.call === 'function') deps.rpc = args.rpc;
  if (!deps.fetch && args.fetch) deps.fetch = args.fetch;

  const rpc = createRpcClient(cfg, deps);
  let cached = null; // { doc, at }

  /* ------------------------------------------------------------- Helius DAS */

  async function listViaHelius(mint) {
    const rows = [];
    let page = 1;
    for (; page <= MAX_PAGES; page++) {
      // `options` ONLY. Helius deserializes `displayOptions` into the same
      // `options` field, so sending both is rejected outright with
      // "duplicate field `options`" and the whole snapshot fails — which means
      // no holder list, which means no round can pay anybody. Verified against
      // the live endpoint on 2026-09-08: options alone works, displayOptions
      // alone works, both together error.
      const result = await rpc.call('getTokenAccounts', {
        mint,
        page,
        limit: HELIUS_PAGE_SIZE,
        options: { showZeroBalance: false },
      });
      const accounts = result?.token_accounts || result?.tokenAccounts || [];
      if (!Array.isArray(accounts)) throw new Error('unexpected getTokenAccounts payload');
      for (const account of accounts) {
        const wallet = typeof account?.owner === 'string' ? account.owner : null;
        if (!wallet) continue;
        rows.push({ wallet, balance: toRaw(account.amount) });
      }
      if (accounts.length < HELIUS_PAGE_SIZE) break;
    }
    if (page > MAX_PAGES) logger.warn(`getTokenAccounts hit the ${MAX_PAGES}-page guard; the snapshot may be partial`);
    return { rows, source: 'helius-das', pages: page };
  }

  /* -------------------------------------------------- getProgramAccounts -- */

  async function gpaSlice(programId, mint, extraFilters = []) {
    const result = await rpc.call('getProgramAccounts', [
      programId,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        dataSlice: { offset: 32, length: 40 }, // owner (32) + amount u64 LE (8)
        withContext: true,
        filters: [{ dataSize: TOKEN_ACCOUNT_SIZE }, { memcmp: { offset: 0, bytes: mint } }, ...extraFilters],
      },
    ]);
    const value = Array.isArray(result) ? result : result?.value;
    if (!Array.isArray(value)) throw new Error('unexpected getProgramAccounts payload');
    const slot = Number.isFinite(result?.context?.slot) ? result.context.slot : null;
    const rows = [];
    for (const item of value) {
      const data = Array.isArray(item?.account?.data) ? item.account.data[0] : item?.account?.data;
      const parsed = parseAccountSlice(data);
      if (parsed) rows.push(parsed);
    }
    return { rows, slot };
  }

  /**
   * Partition the same query 256 ways on the first byte of the owner field.
   * Used only when the endpoint refuses the single-shot response: 256 small
   * queries always beat one that the node will not answer.
   */
  async function gpaPartitioned(programId, mint) {
    const rows = [];
    let slot = null;
    for (let byte = 0; byte < 256; byte++) {
      const prefix = b58encode(Uint8Array.of(byte));
      const part = await gpaSlice(programId, mint, [{ memcmp: { offset: 32, bytes: prefix } }]);
      rows.push(...part.rows);
      if (part.slot !== null) slot = part.slot;
    }
    return { rows, slot };
  }

  async function listViaGpa(mint) {
    let out;
    try {
      out = await gpaSlice(SPL_TOKEN_PROGRAM, mint);
    } catch (err) {
      if (!looksTooLarge(err?.message)) throw err;
      logger.warn(`getProgramAccounts refused a single response (${err?.message || err}); partitioning by owner prefix`);
      out = await gpaPartitioned(SPL_TOKEN_PROGRAM, mint);
    }

    if (out.rows.length === 0) {
      // Nothing on the classic program: the mint may be Token-2022.
      try {
        const alt = await gpaSlice(TOKEN_2022_PROGRAM, mint);
        if (alt.rows.length > 0) return { rows: alt.rows, slot: alt.slot, source: 'rpc-getProgramAccounts-token2022' };
      } catch (err) {
        logger.debug(`token-2022 probe failed: ${err?.message || err}`);
      }
    }
    return { rows: out.rows, slot: out.slot, source: 'rpc-getProgramAccounts' };
  }

  /* ------------------------------------------------------------ public API */

  /**
   * Every holder of the memecoin, aggregated per owner.
   * @returns {Promise<{wallet: string, balance: string}[]>} [] when there is no token yet
   */
  async function list() {
    const mint = String(cfg.tokenMint || '');
    if (!mint) return [];
    const { rows } = cfg.hasHeliusKey ? await listViaHelius(mint) : await listViaGpa(mint);
    return aggregate(rows);
  }

  /** Total supply in base units, from the chain. null when unavailable. */
  async function supply() {
    const mint = String(cfg.tokenMint || '');
    if (!mint) return null;
    try {
      const result = await rpc.call('getTokenSupply', [mint]);
      const amount = result?.value?.amount;
      return typeof amount === 'string' && /^\d+$/.test(amount) ? amount : null;
    } catch (err) {
      logger.warn(`getTokenSupply failed: ${err?.message || err}`);
      return null;
    }
  }

  /**
   * A full holder snapshot: holders, chain supply and the slot it was read at.
   * Cached briefly so a burst of page loads is one chain read.
   *
   * With no token yet this returns an empty, clearly-labelled snapshot rather
   * than throwing — the site has to render honestly before launch.
   */
  async function snapshot({ force = false } = {}) {
    const mint = String(cfg.tokenMint || '');
    if (!mint) {
      return {
        takenAt: new Date(now()).toISOString(),
        slot: null,
        tokenMint: null,
        supply: null,
        eligibleThreshold: cfg.eligibleThresholdRaw ?? null,
        holders: [],
        source: 'no-token',
        launched: false,
      };
    }
    if (!force && cached && now() - cached.at < cacheMs) return cached.doc;

    const [chainSupply, listed] = await Promise.all([
      supply(),
      cfg.hasHeliusKey ? listViaHelius(mint) : listViaGpa(mint),
    ]);

    let slot = listed.slot ?? null;
    if (slot === null) {
      try {
        const s = await rpc.call('getSlot', [{ commitment: 'confirmed' }]);
        if (Number.isFinite(s)) slot = s;
      } catch {
        slot = null;
      }
    }

    const doc = {
      takenAt: new Date(now()).toISOString(),
      slot,
      tokenMint: mint,
      supply: chainSupply ?? cfg.supplyRaw ?? null,
      eligibleThreshold: cfg.eligibleThresholdRaw ?? null,
      holders: aggregate(listed.rows),
      source: listed.source,
      launched: true,
    };
    doc.accounts = listed.rows.length;
    cached = { doc, at: now() };
    return doc;
  }

  /**
   * One wallet's memecoin balance, summed over its token accounts.
   * null when there is no token yet or the read fails.
   */
  async function balanceOf(wallet) {
    const mint = String(cfg.tokenMint || '');
    if (!mint || typeof wallet !== 'string' || !b58decode(wallet)) return null;
    try {
      // One call, one filter key. Filtering by mint alone already covers both
      // token programs, so there is no second pass to make.
      const result = await rpc.call('getTokenAccountsByOwner', tokenAccountsByOwnerParams(wallet, mint));
      const value = Array.isArray(result?.value) ? result.value : [];
      let total = 0n;
      let accounts = 0;
      for (const item of value) {
        const amount = item?.account?.data?.parsed?.info?.tokenAmount?.amount;
        total += toRaw(amount);
        accounts += 1;
      }
      return { raw: total.toString(), accounts };
    } catch (err) {
      logger.warn(`balance lookup failed: ${err?.message || err}`);
      return null;
    }
  }

  /** The vault's SOL balance in lamports. null when it cannot be read. */
  async function vaultLamports() {
    const address = cfg.vaultAddress;
    if (!address) return null;
    try {
      const result = await rpc.call('getBalance', [address, { commitment: 'confirmed' }]);
      const lamports = typeof result === 'number' ? result : result?.value;
      return Number.isFinite(lamports) ? lamports : null;
    } catch (err) {
      logger.warn(`vault balance lookup failed: ${err?.message || err}`);
      return null;
    }
  }

  return { list, snapshot, balanceOf, supply, vaultLamports, rpc };
}

export default createHoldersService;
