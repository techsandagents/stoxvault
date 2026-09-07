/**
 * STOCKDROP engine / pick validation
 *
 * Pure. A holder's basket is 2..5 stocks from the current universe, each an
 * integer percentage in [10, 60], summing to exactly 100.
 *
 * Every rejection carries one of the five codes the API contract exposes:
 *   count | range | sum | not_in_universe | duplicate
 */

import { normalizeUniverse, topStocks, cmpStr } from './ranking.js';

export const DEFAULT_RULES = Object.freeze({
  minPicks: 2,
  maxPicks: 5,
  minPct: 10,
  maxPct: 60,
  defaultBasketSize: 5,
});

/** Error thrown by validatePicks. `code` is what the API returns to the browser. */
export class PickError extends Error {
  constructor(code, message, detail) {
    super(message || code);
    this.name = 'PickError';
    this.code = code;
    this.detail = detail === undefined ? message || code : detail;
  }
}

function resolveRules(rules) {
  const r = rules && typeof rules === 'object' ? rules : {};
  const pick = (key) => (Number.isFinite(r[key]) ? Math.trunc(r[key]) : DEFAULT_RULES[key]);
  return {
    minPicks: pick('minPicks'),
    maxPicks: pick('maxPicks'),
    minPct: pick('minPct'),
    maxPct: pick('maxPct'),
    defaultBasketSize: pick('defaultBasketSize'),
  };
}

/**
 * Integer percentage or null.
 * Accepts a JSON number (60) or a plain integer string ("60"); rejects 10.5,
 * "10.5", "0x10", NaN, Infinity, booleans and everything else.
 */
function toIntegerPct(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) return null;
    return Number(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/** Index a universe by mint and by upper-cased symbol. */
function indexUniverse(universe) {
  const stocks = normalizeUniverse(universe);
  const byMint = new Map();
  const bySymbol = new Map();
  for (const stock of stocks) {
    if (!stock || typeof stock.mint !== 'string' || stock.mint.length === 0) continue;
    if (!byMint.has(stock.mint)) byMint.set(stock.mint, stock);
    if (typeof stock.symbol === 'string' && stock.symbol.length > 0) {
      const key = stock.symbol.toUpperCase();
      if (!bySymbol.has(key)) bySymbol.set(key, stock);
    }
  }
  return { stocks, byMint, bySymbol };
}

/** Sort order used for every normalized pick list: pct desc, then symbol asc, then mint asc. */
export function comparePicks(a, b) {
  if (a.pct !== b.pct) return b.pct - a.pct;
  return cmpStr(a.symbol, b.symbol) || cmpStr(a.mint, b.mint);
}

/**
 * validatePicks(picks, universe, rules) -> Pick[] | throws PickError
 *
 * @returns {{mint: string, symbol: string, pct: number}[]} normalized, sorted by pct desc then symbol asc
 */
export function validatePicks(picks, universe, rules = DEFAULT_RULES) {
  const { minPicks, maxPicks, minPct, maxPct } = resolveRules(rules);
  const { byMint, bySymbol } = indexUniverse(universe);

  if (!Array.isArray(picks)) {
    throw new PickError('count', 'picks must be an array', 'picks must be an array');
  }
  if (picks.length < minPicks || picks.length > maxPicks) {
    throw new PickError(
      'count',
      `pick between ${minPicks} and ${maxPicks} stocks`,
      `got ${picks.length} picks, allowed ${minPicks}-${maxPicks}`,
    );
  }

  const seen = new Set();
  const normalized = [];
  let sum = 0;

  for (const raw of picks) {
    if (!raw || typeof raw !== 'object') {
      throw new PickError('not_in_universe', 'each pick must name a stock', `bad pick entry: ${JSON.stringify(raw ?? null)}`);
    }

    const pct = toIntegerPct(raw.pct);
    if (pct === null) {
      throw new PickError('range', 'each percentage must be a whole number', `pct must be an integer, got ${JSON.stringify(raw.pct ?? null)}`);
    }
    if (pct < minPct || pct > maxPct) {
      throw new PickError('range', `each stock takes ${minPct}%-${maxPct}%`, `pct ${pct} outside ${minPct}-${maxPct}`);
    }

    let stock = null;
    if (typeof raw.mint === 'string' && raw.mint.length > 0) {
      stock = byMint.get(raw.mint) || null;
      if (!stock) {
        throw new PickError('not_in_universe', 'that stock is not in the current top 20', `unknown mint ${raw.mint}`);
      }
    } else if (typeof raw.symbol === 'string' && raw.symbol.length > 0) {
      stock = bySymbol.get(raw.symbol.toUpperCase()) || null;
      if (!stock) {
        throw new PickError('not_in_universe', 'that stock is not in the current top 20', `unknown symbol ${raw.symbol}`);
      }
    } else {
      throw new PickError('not_in_universe', 'each pick must name a stock', 'pick has no mint or symbol');
    }

    if (seen.has(stock.mint)) {
      throw new PickError('duplicate', 'each stock can only be picked once', `duplicate mint ${stock.mint}`);
    }
    seen.add(stock.mint);

    sum += pct;
    normalized.push({ mint: stock.mint, symbol: stock.symbol ?? '', pct });
  }

  if (sum !== 100) {
    throw new PickError('sum', 'percentages must add up to 100', `sum is ${sum}, must be 100`);
  }

  return normalized.sort(comparePicks);
}

/**
 * Parse a configured default basket, e.g. `"SPCXx:100"` or `"NVDAx:60,TSLAx:40"`.
 *
 * Returns a list of `{symbol, pct}` or null when the string is absent or
 * unusable, in which case the caller falls back to the top-N basket. Parsing is
 * deliberately strict: a malformed setting must not silently become a different
 * allocation than the operator intended, because this basket decides where real
 * money goes for every holder who never picked.
 *
 * @param {string|string[]|null|undefined} spec
 * @returns {{symbol: string, pct: number}[]|null}
 */
export function parseDefaultBasket(spec) {
  if (spec === null || spec === undefined) return null;
  const parts = (Array.isArray(spec) ? spec : String(spec).split(','))
    .map((part) => String(part).trim())
    .filter((part) => part !== '');
  if (parts.length === 0) return null;

  const picks = [];
  const seen = new Set();
  for (const part of parts) {
    const match = /^([A-Za-z0-9.\-_]+)\s*:\s*(\d{1,3})$/.exec(part);
    if (!match) return null;
    const symbol = match[1];
    const pct = Number(match[2]);
    const key = symbol.toUpperCase();
    if (seen.has(key) || pct <= 0 || pct > 100) return null;
    seen.add(key);
    picks.push({ symbol, pct });
  }
  if (picks.reduce((sum, p) => sum + p.pct, 0) !== 100) return null;
  return picks;
}

/**
 * defaultPicks(universe, rules) -> Pick[]
 *
 * The basket every holder who never set preferences receives.
 *
 * Two shapes, in priority order:
 *
 *  1. `rules.defaultBasket` — an explicit allocation such as `"SPCXx:100"`.
 *     Named stocks are resolved against the CURRENT universe, so a name that
 *     has dropped out of the top N (delisted, or its liquidity fell below the
 *     floor) is not silently bought anyway. If some names resolve and others do
 *     not, the missing weight is spread across the survivors by largest
 *     remainder so the total stays exactly 100. If NONE resolve, it falls
 *     through to the top-N basket rather than paying nobody.
 *
 *  2. Otherwise the top `defaultBasketSize` stocks, split evenly, leftover
 *     points to the highest-ranked first, so the total is always exactly 100.
 *
 * Note the deliberate asymmetry: a holder's own picks are capped at 60% per
 * stock, but a configured default may concentrate further (100% in one name).
 * A default is an operator decision about people who expressed no preference,
 * not a basket a user built, so the per-pick cap does not apply to it.
 *
 * A universe with fewer stocks than the basket size spreads across what exists;
 * an empty universe yields an empty basket (never an invented stock).
 */
export function defaultPicks(universe, rules = DEFAULT_RULES) {
  const { defaultBasketSize } = resolveRules(rules);
  const configured = parseDefaultBasket(rules && rules.defaultBasket);

  if (configured) {
    const stocks = normalizeUniverse(universe).filter(isStockLike);
    const bySymbol = new Map();
    for (const stock of stocks) {
      const symbol = String(stock.symbol ?? '').toUpperCase();
      if (symbol && !bySymbol.has(symbol)) bySymbol.set(symbol, stock);
    }

    const resolved = [];
    for (const entry of configured) {
      const stock = bySymbol.get(entry.symbol.toUpperCase());
      if (stock) resolved.push({ mint: stock.mint, symbol: stock.symbol ?? entry.symbol, pct: entry.pct });
    }

    if (resolved.length > 0) {
      const total = resolved.reduce((sum, p) => sum + p.pct, 0);
      if (total !== 100) rebalanceToHundred(resolved, total);
      return resolved.sort(comparePicks);
    }
    // Nothing configured survives in the current universe: fall through to the
    // top-N basket rather than dropping these holders from the round entirely.
  }

  const stocks = topStocks(universe, defaultBasketSize);
  const n = stocks.length;
  if (n === 0) return [];

  const base = Math.floor(100 / n);
  let leftover = 100 - base * n;

  const picks = stocks.map((stock) => {
    const bonus = leftover > 0 ? 1 : 0;
    leftover -= bonus;
    return { mint: stock.mint, symbol: stock.symbol ?? '', pct: base + bonus };
  });

  return picks.sort(comparePicks);
}

/** Anything carrying a mint is usable here; ranking is not required. */
function isStockLike(stock) {
  return Boolean(stock && typeof stock === 'object' && typeof stock.mint === 'string' && stock.mint !== '');
}

/**
 * Scale `picks` in place so their percentages total exactly 100, distributing
 * the rounding remainder by largest fractional part (and, on a tie, to the
 * larger original weight) so no percentage point is created or lost.
 */
function rebalanceToHundred(picks, total) {
  if (picks.length === 0 || total <= 0) return;
  const exact = picks.map((p) => (p.pct * 100) / total);
  const floors = exact.map((v) => Math.floor(v));
  let remainder = 100 - floors.reduce((sum, v) => sum + v, 0);

  const order = picks
    .map((p, i) => ({ i, frac: exact[i] - floors[i], pct: p.pct }))
    .sort((a, b) => (b.frac !== a.frac ? b.frac - a.frac : b.pct - a.pct));

  for (let k = 0; k < order.length && remainder > 0; k += 1) {
    floors[order[k].i] += 1;
    remainder -= 1;
  }
  picks.forEach((p, i) => {
    p.pct = floors[i];
  });
}
