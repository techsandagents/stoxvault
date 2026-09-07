/**
 * STOCKDROP — price history for one stock.
 *
 * Primary source is Yahoo Finance's chart endpoint, which returns real daily
 * OHLCV for the underlying equity (NVDA, AAPL, SPCX...). That is what a
 * brokerage-grade chart needs, and it is what the seed file's `yahooSymbol`
 * mapping exists for.
 *
 * Fallback is CoinGecko's market chart for the xStock mint itself. It is
 * close-only, so it renders as a line, not candles: the response says so in
 * `source` and `kind` instead of pretending the shape is the same. That path
 * also covers a stock with no Yahoo listing at all (a newly wrapped private
 * company, where `yahooSymbol` is null).
 *
 * Answers are cached for an hour per (mint, range). A stale cached answer is
 * preferred over an error, and is flagged `stale: true`.
 */

import { log } from '../util/log.js';

const logger = log.child('history');

export const RANGES = Object.freeze({
  '1mo': { yahoo: '1mo', days: 30 },
  '3mo': { yahoo: '3mo', days: 90 },
  '1y': { yahoo: '1y', days: 365 },
});

export const DEFAULT_RANGE = '1mo';
export const CACHE_MS = 60 * 60 * 1000;

// Yahoo serves the JSON endpoint to browsers only; without a browser UA it
// answers 403/429. This is the same request a chart on their own site makes.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export class HistoryError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'HistoryError';
    this.code = code;
  }
}

/** Normalise/validate a range parameter. Returns null when it is not one we serve. */
export function normalizeRange(range) {
  if (range === undefined || range === null || range === '') return DEFAULT_RANGE;
  const key = String(range).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(RANGES, key) ? key : null;
}

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Yahoo chart payload -> candles. Throws when the payload is not a chart. */
export function parseYahoo(body) {
  const result = body?.chart?.result?.[0];
  const err = body?.chart?.error;
  if (err) throw new HistoryError('upstream_error', String(err?.description || err?.code || 'yahoo error'));
  if (!result || !Array.isArray(result.timestamp)) throw new HistoryError('upstream_error', 'unexpected yahoo payload');

  const quote = result.indicators?.quote?.[0] || {};
  const { open = [], high = [], low = [], close = [], volume = [] } = quote;
  const candles = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const t = finite(result.timestamp[i]);
    const c = finite(close[i]);
    if (t === null || c === null) continue; // holidays and half-days come back null
    const o = finite(open[i]) ?? c;
    const h = finite(high[i]) ?? Math.max(o, c);
    const l = finite(low[i]) ?? Math.min(o, c);
    const v = finite(volume[i]) ?? 0;
    candles.push({ t, o, h, l, c, v });
  }
  if (candles.length === 0) throw new HistoryError('upstream_error', 'yahoo returned no candles');
  return candles;
}

/** CoinGecko market_chart payload -> close-only candles. */
export function parseCoingecko(body) {
  const prices = Array.isArray(body?.prices) ? body.prices : null;
  if (!prices) throw new HistoryError('upstream_error', 'unexpected coingecko payload');
  const volumes = Array.isArray(body?.total_volumes) ? body.total_volumes : [];
  const volumeAt = new Map(volumes.map((row) => [Math.floor(Number(row?.[0]) / 1000), finite(row?.[1]) ?? 0]));

  const candles = [];
  for (const row of prices) {
    const ms = finite(row?.[0]);
    const price = finite(row?.[1]);
    if (ms === null || price === null) continue;
    const t = Math.floor(ms / 1000);
    candles.push({ t, o: price, h: price, l: price, c: price, v: volumeAt.get(t) ?? 0 });
  }
  if (candles.length === 0) throw new HistoryError('upstream_error', 'coingecko returned no points');
  return candles;
}

/**
 * createHistoryService({ cfg, deps })
 * @param {object} args
 * @param {object} args.cfg
 * @param {{fetch?: Function}} [args.deps]
 */
export function createHistoryService({ cfg, deps = {}, now = Date.now, cacheMs = CACHE_MS } = {}) {
  if (!cfg) throw new TypeError('createHistoryService: cfg is required');
  const fetchImpl = deps.fetch || globalThis.fetch;
  const cache = new Map(); // `${mint}|${range}` -> { doc, at }

  async function getJson(url, headers) {
    const init = { headers: { accept: 'application/json', ...headers } };
    if (typeof AbortSignal?.timeout === 'function') init.signal = AbortSignal.timeout(12_000);
    const res = await fetchImpl(url, init);
    if (!res || typeof res.status !== 'number') throw new HistoryError('upstream_error', 'no response');
    if (!res.ok) throw new HistoryError('upstream_error', `HTTP ${res.status}`);
    return res.json();
  }

  async function fromYahoo(yahooSymbol, range) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${RANGES[range].yahoo}&interval=1d`;
    return parseYahoo(await getJson(url, { 'user-agent': BROWSER_UA }));
  }

  async function fromCoingecko(mint, range) {
    const url = `https://api.coingecko.com/api/v3/coins/solana/contract/${encodeURIComponent(mint)}/market_chart/?vs_currency=usd&days=${RANGES[range].days}`;
    return parseCoingecko(await getJson(url, {}));
  }

  /**
   * Candles for a stock.
   * @param {{mint: string, symbol: string, yahooSymbol?: string|null}} stock
   * @param {string} range one of RANGES
   * @returns {Promise<{symbol, yahooSymbol, mint, range, candles, source, kind, updatedAt, stale, note?}>}
   */
  async function get(stock, rangeInput = DEFAULT_RANGE) {
    const range = normalizeRange(rangeInput);
    if (!range) throw new HistoryError('bad_range', `range must be one of ${Object.keys(RANGES).join(', ')}`);
    if (!stock || typeof stock.mint !== 'string' || stock.mint === '') {
      throw new HistoryError('unknown_symbol', 'no such stock');
    }

    const key = `${stock.mint}|${range}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < cacheMs) return hit.doc;

    const base = {
      symbol: stock.symbol,
      mint: stock.mint,
      yahooSymbol: stock.yahooSymbol || null,
      range,
      updatedAt: new Date(now()).toISOString(),
      stale: false,
    };

    const problems = [];

    if (stock.yahooSymbol) {
      try {
        const candles = await fromYahoo(stock.yahooSymbol, range);
        const doc = { ...base, candles, source: 'yahoo', kind: 'candles' };
        cache.set(key, { doc, at: now() });
        return doc;
      } catch (err) {
        problems.push(`yahoo: ${err?.message || err}`);
        logger.warn(`yahoo history failed for ${stock.symbol} (${range}): ${err?.message || err}`);
      }
    }

    try {
      const candles = await fromCoingecko(stock.mint, range);
      const doc = {
        ...base,
        candles,
        source: 'coingecko',
        kind: 'line',
        note: stock.yahooSymbol
          ? 'Yahoo was unavailable, so this is the on-chain xStock price from CoinGecko (close only).'
          : 'This stock has no listed equity ticker, so this is the on-chain xStock price from CoinGecko (close only).',
      };
      cache.set(key, { doc, at: now() });
      return doc;
    } catch (err) {
      problems.push(`coingecko: ${err?.message || err}`);
      logger.warn(`coingecko history failed for ${stock.symbol} (${range}): ${err?.message || err}`);
    }

    if (hit) return { ...hit.doc, stale: true, updatedAt: hit.doc.updatedAt };
    throw new HistoryError('history_unavailable', problems.join('; '));
  }

  return { get, ranges: Object.keys(RANGES), normalizeRange };
}

export default createHistoryService;
