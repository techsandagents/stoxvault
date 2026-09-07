/**
 * STOCKDROP — the tradeable universe.
 *
 * Every round, and every page of the site, is built on the same list: the
 * xStocks that Jupiter can actually route, ranked by the market cap of the
 * company behind them. This service owns that list.
 *
 *   live fetch (Jupiter search + price)  ->  engine.rankUniverse  ->  cache
 *
 * Caching is deliberately layered so the API is never down because a third
 * party is: memory (fast path) -> the store's KV (survives a restart) ->
 * `data/xstocks.seed.json` (survives everything). Anything that is not a fresh
 * live fetch is served with `stale: true` and an honest `source`, never as if
 * it were live.
 *
 * This module never throws on a network failure and never invents a stock.
 */

import fs from 'node:fs';
import path from 'node:path';
import { rankUniverse } from '../engine/index.js';
import { log } from '../util/log.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const UNIVERSE_KV_KEY = 'universe';
export const REFRESH_MS = 60 * 60 * 1000; // at most one live fetch an hour
export const SEED_FILE = 'data/xstocks.seed.json';

const logger = log.child('universe');

/* ------------------------------------------------------------- utilities -- */

const num = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === 'bigint') return Number(value);
  return null;
};

const str = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/**
 * Merge a Jupiter search row with its price row into the Stock shape from
 * CONTRACT.md section 3. Returns null for anything that is not a usable stock.
 *
 * Accepts both the raw Jupiter shapes (`id`, `icon`, `liquidity`, `mcap`,
 * `stockData: {price, mcap}`) and rows that are already in Stock shape (the
 * seed file, or a chain/jupiter.js that normalises for us), so the service
 * works whichever side of the fence the data comes from.
 */
export function normalizeStock(raw, price = null, yahooByMint = null, yahooBySymbol = null) {
  if (!raw || typeof raw !== 'object') return null;
  const mint = str(raw.mint) || str(raw.id) || str(raw.address);
  if (!mint) return null;
  const symbol = str(raw.symbol) || '';
  if (!symbol) return null;

  const p = price && typeof price === 'object' ? price : {};
  const stockData = p.stockData && typeof p.stockData === 'object' ? p.stockData : null;

  // Underlying (real company) market cap, in whole USD. Jupiter's
  // `stockData.mcap` is absolute (NVDA reads 5562502920000, verified live
  // against price/v3 on 2026-09-07), so it is used as-is.
  const underlyingMcap = (stockData ? num(stockData.mcap) : null) ?? num(raw.underlyingMcap);

  const underlyingPrice = (stockData ? num(stockData.price) : null) ?? num(raw.underlyingPrice);

  const yahooSymbol = str(raw.yahooSymbol)
    || (yahooByMint && yahooByMint.get(mint))
    || (yahooBySymbol && yahooBySymbol.get(symbol.toUpperCase()))
    || null;

  return {
    mint,
    symbol,
    name: str(raw.name) || symbol,
    logo: str(raw.logo) || str(raw.icon) || null,
    decimals: Number.isInteger(raw.decimals) ? raw.decimals : 8,
    tokenProgram: str(raw.tokenProgram) || null,
    yahooSymbol,
    priceUsd: num(p.usdPrice) ?? num(raw.priceUsd) ?? num(raw.usdPrice),
    change24h: num(p.priceChange24h) ?? num(raw.change24h) ?? num(raw.stats24h?.priceChange),
    underlyingMcap,
    underlyingPrice,
    liquidityUsd: num(p.liquidity) ?? num(raw.liquidityUsd) ?? num(raw.liquidity),
    tokenMcap: num(raw.tokenMcap) ?? num(raw.mcap),
    holderCount: Number.isFinite(raw.holderCount) ? raw.holderCount : null,
  };
}

/** True when a value looks like a list of stocks we can rank. */
function isStockList(value) {
  return Array.isArray(value) && value.length > 0 && value.some((s) => s && typeof s === 'object' && (str(s.mint) || str(s.id)));
}

/** True when a value looks like a Jupiter price map. */
function isPriceMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const entry of Object.values(value)) {
    if (entry && typeof entry === 'object' && (num(entry.usdPrice) !== null || entry.stockData)) return true;
  }
  return false;
}

/* --------------------------------------------------------- seed / fallback -- */

let seedCache = null;

/**
 * The offline snapshot shipped in the repo. Used as the last fallback and as
 * the source of the Yahoo ticker mapping (which Jupiter does not provide).
 * @param {object} cfg
 */
export function loadSeed(cfg) {
  if (seedCache) return seedCache;
  const file = path.join(cfg?.root || process.cwd(), SEED_FILE);
  let stocks = [];
  let fetchedAt = null;
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(doc?.stocks)) stocks = doc.stocks;
    else if (Array.isArray(doc)) stocks = doc;
    fetchedAt = str(doc?.fetchedAt);
  } catch (err) {
    logger.warn(`seed file unreadable (${file}): ${err?.message || err}`);
  }
  const byMint = new Map();
  const bySymbol = new Map();
  for (const s of stocks) {
    const mint = str(s?.mint);
    const yahoo = str(s?.yahooSymbol);
    if (mint && yahoo) byMint.set(mint, yahoo);
    if (s?.symbol && yahoo) bySymbol.set(String(s.symbol).toUpperCase(), yahoo);
  }
  seedCache = { stocks, fetchedAt, yahooByMint: byMint, yahooBySymbol: bySymbol };
  return seedCache;
}

/** Test hook: forget the parsed seed file. */
export function resetSeedCache() {
  seedCache = null;
}

/* ------------------------------------------------------------- jupiter IO -- */

function fnOf(mod, names) {
  if (!mod) return null;
  for (const name of names) {
    if (typeof mod[name] === 'function') return mod[name].bind(mod);
    const d = mod.default;
    if (d && typeof d === 'object' && typeof d[name] === 'function') return d[name].bind(d);
  }
  return null;
}

async function importChainJupiter() {
  try {
    return await import('../chain/jupiter.js');
  } catch {
    return null; // the chain module is optional; the HTTP calls below are the contract
  }
}

/**
 * `src/chain/jupiter.js` exports a factory (`createJupiter(cfg, opts)`) that
 * returns a client with retries, timeouts and its own seed fallback. Prefer it;
 * accept module-level functions too, in case that file changes shape.
 */
async function chainJupiterClient(cfg, fetchImpl) {
  const mod = await importChainJupiter();
  if (!mod) return null;
  const factory = typeof mod.createJupiter === 'function'
    ? mod.createJupiter
    : typeof mod.default === 'function' ? mod.default : null;
  if (factory) {
    try {
      const client = factory(cfg, { logger, fetchImpl });
      if (client && typeof client.searchXStocks === 'function' && typeof client.prices === 'function') return client;
    } catch (err) {
      logger.debug(`chain/jupiter factory unusable: ${err?.message || err}`);
    }
  }
  const search = fnOf(mod, ['searchXStocks', 'searchXstocks', 'searchStocks', 'search']);
  const prices = fnOf(mod, ['prices', 'getPrices', 'fetchPrices', 'price']);
  return search && prices ? { searchXStocks: search, prices } : null;
}

async function getJson(fetchImpl, url, { timeoutMs = 12_000, headers = {} } = {}) {
  const init = { headers: { accept: 'application/json', ...headers } };
  if (typeof AbortSignal?.timeout === 'function') init.signal = AbortSignal.timeout(timeoutMs);
  const res = await fetchImpl(url, init);
  if (!res || typeof res.status !== 'number') throw new Error('no response');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * The two Jupiter reads this project needs, resolved once per service:
 * the project's own `src/chain/jupiter.js` when it exposes them, otherwise the
 * documented HTTP endpoints (CONTRACT.md section 7) called directly.
 *
 * A chain-module call that throws or returns an unexpected shape falls back to
 * HTTP rather than poisoning the universe with something unusable.
 */
export function createJupiterClient(cfg, deps = {}) {
  if (deps.jupiter && typeof deps.jupiter.searchXStocks === 'function' && typeof deps.jupiter.prices === 'function') {
    return deps.jupiter;
  }
  const fetchImpl = deps.fetch || globalThis.fetch;
  const base = String(cfg?.jupBase || 'https://lite-api.jup.ag').replace(/\/+$/, '');
  let chainClient;

  async function chain() {
    if (chainClient === undefined) chainClient = await chainJupiterClient(cfg, deps.fetch);
    return chainClient;
  }

  async function searchXStocks() {
    const client = await chain();
    if (client) {
      try {
        const out = await client.searchXStocks({});
        const list = Array.isArray(out) ? out : out?.stocks || out?.tokens || out?.data;
        if (isStockList(list)) return out;
      } catch (err) {
        logger.debug(`chain/jupiter search unusable, using HTTP: ${err?.message || err}`);
      }
    }
    const url = `${base}/tokens/v2/search?query=${encodeURIComponent('xStock')}&limit=100`;
    const body = await getJson(fetchImpl, url);
    const list = Array.isArray(body) ? body : body?.tokens || body?.data || [];
    if (!Array.isArray(list)) throw new Error('unexpected search payload');
    return list;
  }

  async function prices(mints) {
    const ids = [...new Set((Array.isArray(mints) ? mints : []).filter((m) => typeof m === 'string' && m))];
    if (ids.length === 0) return {};

    const client = await chain();
    if (client) {
      try {
        const out = await client.prices(ids);
        if (isPriceMap(out)) return out;
      } catch (err) {
        logger.debug(`chain/jupiter prices unusable, using HTTP: ${err?.message || err}`);
      }
    }

    const out = {};
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const url = `${base}/price/v3?ids=${chunk.join(',')}`;
      const body = await getJson(fetchImpl, url);
      const map = body && typeof body === 'object' ? (body.data && typeof body.data === 'object' ? body.data : body) : {};
      for (const [mint, entry] of Object.entries(map)) out[mint] = entry;
    }
    return out;
  }

  return { searchXStocks, prices };
}

/* ----------------------------------------------------------------- service -- */

/**
 * createUniverseService({ cfg, db, deps })
 *
 * @returns {{
 *   get(opts?: {force?: boolean}): Promise<object>,
 *   refresh(): Promise<object>,
 *   stocks(): Promise<object[]>,
 *   find(key: string): Promise<object|null>,
 *   solPriceUsd(): Promise<number|null>,
 *   peek(): object|null
 * }}
 */
export function createUniverseService(args = {}) {
  const { cfg, db = null, now = Date.now } = args;
  if (!cfg) throw new TypeError('createUniverseService: cfg is required');

  // The keeper and scripts/run-round.mjs wire their own chain clients and pass
  // them at the top level (`{cfg, rpc, jup, db, logger}`); the API passes them
  // under `deps`. Accept both so there is one Jupiter client per process.
  const deps = { ...(args.deps || {}) };
  if (!deps.jupiter && (args.jup || args.jupiter)) deps.jupiter = args.jup || args.jupiter;
  if (!deps.rpc && args.rpc) deps.rpc = args.rpc;
  if (!deps.fetch && args.fetch) deps.fetch = args.fetch;

  const jupiter = createJupiterClient(cfg, deps);
  const seed = loadSeed(cfg);

  let current = null; // the last universe we served
  let fetchedAt = 0; // when the last LIVE fetch succeeded
  let inflight = null;
  let kvLoaded = false;
  let solPrice = { value: null, at: 0 };

  function build(all, source, updatedAt, stale) {
    const stocks = rankUniverse(all, { liqMinUsd: cfg.liqMinUsd, size: cfg.universeSize });
    return {
      updatedAt: updatedAt || new Date(now()).toISOString(),
      source,
      stale: Boolean(stale),
      count: stocks.length,
      totalKnown: all.length,
      liqMinUsd: cfg.liqMinUsd,
      stocks,
      all,
    };
  }

  function fromSeed() {
    const all = seed.stocks
      .map((s) => normalizeStock(s, null, seed.yahooByMint, seed.yahooBySymbol))
      .filter(Boolean);
    return build(all, 'seed', seed.fetchedAt || null, true);
  }

  async function loadFromKv() {
    if (kvLoaded || !db) return null;
    kvLoaded = true;
    try {
      const doc = await db.getKV(UNIVERSE_KV_KEY);
      if (doc && Array.isArray(doc.all) && doc.all.length > 0) {
        const writtenAt = Date.parse(doc.updatedAt || '');
        const age = Number.isFinite(writtenAt) ? now() - writtenAt : Number.POSITIVE_INFINITY;
        current = build(doc.all, 'cache', doc.updatedAt, true);
        // A cache written less than an hour ago counts as a live fetch: a
        // restart should not stampede Jupiter.
        if (age >= 0 && age < REFRESH_MS) {
          fetchedAt = now() - age;
          current = { ...current, source: doc.source === 'jupiter' ? 'jupiter' : 'cache', stale: false };
        }
        return current;
      }
    } catch (err) {
      logger.warn(`KV universe unreadable: ${err?.message || err}`);
    }
    return null;
  }

  async function fetchLive() {
    const raw = await jupiter.searchXStocks();
    const rows = Array.isArray(raw)
      ? raw
      : (Array.isArray(raw?.stocks) && raw.stocks) || (Array.isArray(raw?.tokens) && raw.tokens) || (Array.isArray(raw?.data) && raw.data) || [];
    if (rows.length === 0) throw new Error('jupiter returned no xStocks');

    // A client that already fell back to the seed file says so; that must not
    // be relabelled as live data.
    const source = !Array.isArray(raw) && typeof raw?.source === 'string' && raw.source ? raw.source : 'jupiter';
    const updatedAt = !Array.isArray(raw) && typeof raw?.fetchedAt === 'string' ? raw.fetchedAt : new Date(now()).toISOString();

    let priceMap = {};
    const needsPrices = rows.some((row) => row && row.priceUsd === undefined && row.usdPrice === undefined);
    if (needsPrices) {
      const mints = rows.map((r) => str(r?.mint) || str(r?.id)).filter(Boolean);
      try {
        priceMap = (await jupiter.prices(mints)) || {};
      } catch (err) {
        // Prices are how we rank; without them the search rows still carry
        // liquidity and the token mcap, so degrade instead of failing.
        logger.warn(`price fetch failed, ranking on search data alone: ${err?.message || err}`);
      }
    }

    const all = rows
      .map((row) => normalizeStock(row, priceMap[str(row?.mint) || str(row?.id)], seed.yahooByMint, seed.yahooBySymbol))
      .filter(Boolean);
    if (all.length === 0) throw new Error('jupiter returned nothing usable');
    return build(all, source, updatedAt, source.startsWith('seed'));
  }

  async function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const universe = await fetchLive();
        current = universe;
        fetchedAt = now();
        if (db) {
          try {
            await db.setKV(UNIVERSE_KV_KEY, { updatedAt: universe.updatedAt, source: universe.source, all: universe.all });
          } catch (err) {
            logger.warn(`could not cache the universe: ${err?.message || err}`);
          }
        }
        return universe;
      } catch (err) {
        logger.warn(`universe refresh failed: ${err?.message || err}`);
        const cached = current || (await loadFromKv());
        const fallback = cached ? { ...cached, stale: true } : fromSeed();
        fallback.error = String(err?.message || err);
        current = fallback;
        return fallback;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  /** The current universe, refreshing at most hourly. Never throws. */
  async function get(opts = {}) {
    if (opts.force) return refresh();
    if (!current) await loadFromKv();
    if (current && now() - fetchedAt < REFRESH_MS) return current;
    return refresh();
  }

  /** The ranked top-N stocks (what a user may pick from). */
  async function stocks() {
    const universe = await get();
    return universe.stocks;
  }

  /** Look a stock up by mint or (case-insensitive) symbol, inside the ranked set first. */
  async function find(key) {
    if (typeof key !== 'string' || key.trim() === '') return null;
    const needle = key.trim();
    const upper = needle.toUpperCase();
    const universe = await get();
    for (const list of [universe.stocks, universe.all]) {
      for (const stock of list) {
        if (stock.mint === needle || String(stock.symbol).toUpperCase() === upper) return stock;
      }
    }
    return null;
  }

  /** SOL price in USD, cached for a minute. null when it cannot be fetched. */
  async function solPriceUsd() {
    if (solPrice.value !== null && now() - solPrice.at < 60_000) return solPrice.value;
    try {
      const map = await jupiter.prices([SOL_MINT]);
      const entry = map?.[SOL_MINT];
      const price = num(entry?.usdPrice) ?? num(entry?.price);
      if (price !== null) solPrice = { value: price, at: now() };
      return solPrice.value;
    } catch (err) {
      logger.debug(`SOL price unavailable: ${err?.message || err}`);
      return solPrice.value;
    }
  }

  return { get, refresh, stocks, find, solPriceUsd, peek: () => current, jupiter };
}

export default createUniverseService;
