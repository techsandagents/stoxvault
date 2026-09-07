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
 * defaultPicks(universe, rules) -> Pick[]
 *
 * The default basket: the top `defaultBasketSize` stocks, split evenly.
 * If the size does not divide 100 the leftover points go to the highest-ranked
 * stocks first, so the total is always exactly 100.
 * A universe with fewer stocks than the basket size spreads across what exists;
 * an empty universe yields an empty basket (never an invented stock).
 */
export function defaultPicks(universe, rules = DEFAULT_RULES) {
  const { defaultBasketSize } = resolveRules(rules);
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
