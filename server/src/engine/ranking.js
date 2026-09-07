/**
 * STOCKDROP engine / ranking
 *
 * Pure functions. No IO, no clock, no randomness, no network.
 * Given the full list of xStocks discovered from Jupiter, produce the ranked
 * universe the round is allowed to trade.
 *
 * Ranking rule (CONTRACT.md section 6, SPEC.md section 7):
 *   1. keep stocks whose on-chain liquidity is >= liqMinUsd
 *   2. sort by underlying company market cap, descending
 *      (falling back to the token's own mcap when the underlying one is absent)
 *   3. stable tiebreak: symbol ascending, then mint ascending
 *   4. take `size`, assign rank 1..size, isTop5 = rank <= 5
 *
 * Inputs are never mutated; every returned stock is a fresh object.
 */

/** Coerce to a finite number, or null. Never throws, never returns NaN. */
export function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Deterministic string compare (no locale, no case folding). */
export function cmpStr(a, b) {
  const x = a === undefined || a === null ? '' : String(a);
  const y = b === undefined || b === null ? '' : String(b);
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}

/**
 * The market cap a stock is ranked by.
 * `underlyingMcap` is the real company (e.g. NVIDIA). `tokenMcap` is the
 * on-chain wrapper's own cap and is only used when the underlying one is
 * missing or non-positive, so a feed hiccup degrades instead of zeroing a stock.
 */
export function mcapOf(stock) {
  const underlying = toFiniteNumber(stock?.underlyingMcap);
  if (underlying !== null && underlying > 0) return underlying;
  const token = toFiniteNumber(stock?.tokenMcap);
  if (token !== null && token > 0) return token;
  return 0;
}

/** On-chain liquidity in USD, 0 when unknown (an unknown-liquidity stock never ranks). */
export function liquidityOf(stock) {
  const liq = toFiniteNumber(stock?.liquidityUsd);
  return liq === null || liq < 0 ? 0 : liq;
}

/**
 * Accept a Universe document, a { stocks } / { all } wrapper, or a plain array,
 * and return a plain array of stock objects. Never mutates, never copies deeply.
 */
export function normalizeUniverse(universe) {
  if (Array.isArray(universe)) return universe;
  if (universe && typeof universe === 'object') {
    if (Array.isArray(universe.stocks)) return universe.stocks;
    if (Array.isArray(universe.all)) return universe.all;
  }
  throw new TypeError('universe must be an array of stocks or a { stocks: [...] } object');
}

/** True when a value looks like a usable stock entry. */
function isStock(stock) {
  return Boolean(stock) && typeof stock === 'object' && typeof stock.mint === 'string' && stock.mint.length > 0;
}

/**
 * The n highest-ranked stocks of a universe, in rank order.
 * Uses `rank` when the universe carries one (the normal case: it came from
 * rankUniverse), otherwise falls back to the order it was given in.
 */
export function topStocks(universe, n) {
  const list = normalizeUniverse(universe).filter(isStock);
  const size = Math.max(0, Math.trunc(toFiniteNumber(n) ?? 0));
  const ranked = list
    .map((stock, index) => ({ stock, index, rank: toFiniteNumber(stock.rank) }))
    .sort((a, b) => {
      const ar = a.rank === null ? Number.POSITIVE_INFINITY : a.rank;
      const br = b.rank === null ? Number.POSITIVE_INFINITY : b.rank;
      if (ar !== br) return ar < br ? -1 : 1;
      return a.index - b.index;
    });
  return ranked.slice(0, size).map((entry) => entry.stock);
}

/**
 * rankUniverse(all, { liqMinUsd, size }) -> Stock[size]
 *
 * @param {object[]|object} all       every xStock seen (or a Universe wrapper)
 * @param {object}  [opts]
 * @param {number}  [opts.liqMinUsd=0]  minimum on-chain liquidity in USD (inclusive)
 * @param {number}  [opts.size=20]      how many stocks the universe holds
 * @returns {object[]} fresh stock objects with `rank` (1-based) and `isTop5`
 */
export function rankUniverse(all, opts = {}) {
  const liqMinUsd = toFiniteNumber(opts.liqMinUsd) ?? 0;
  const size = Math.max(0, Math.trunc(toFiniteNumber(opts.size ?? 20) ?? 0));

  const liquid = normalizeUniverse(all).filter((stock) => isStock(stock) && liquidityOf(stock) >= liqMinUsd);

  const sorted = liquid.slice().sort((a, b) => {
    const am = mcapOf(a);
    const bm = mcapOf(b);
    if (am !== bm) return bm > am ? 1 : -1; // market cap, descending
    return cmpStr(a.symbol, b.symbol) || cmpStr(a.mint, b.mint);
  });

  // A feed can list the same mint twice; keep the first (best-ranked) copy.
  const seen = new Set();
  const unique = [];
  for (const stock of sorted) {
    if (seen.has(stock.mint)) continue;
    seen.add(stock.mint);
    unique.push(stock);
  }

  return unique.slice(0, size).map((stock, i) => ({ ...stock, rank: i + 1, isTop5: i < 5 }));
}
