/**
 * STOCKDROP engine / eligibility, demand, pool split, allocation
 *
 * Pure. Every amount is a BigInt of base units (lamports for SOL, token base
 * units for stocks). There is not a single float in the money path: all
 * division is BigInt division, which truncates, and every operand is
 * non-negative, so every division floors. Money never rounds up — the
 * remainder is always named (it stays in the vault, or it becomes carry-over).
 */

import { normalizeUniverse } from './ranking.js';
import { defaultPicks, DEFAULT_RULES, comparePicks } from './validate.js';

const ZERO = 0n;
const BPS_DENOM = 10000n;

/**
 * Strict BigInt coercion for base-unit amounts.
 * Accepts BigInt, a safe integer Number, or a decimal string of digits.
 * Rejects floats, NaN, hex strings, empty strings, null and undefined —
 * a silently-coerced amount is a silently-wrong payout.
 */
export function toBigInt(value, what = 'amount') {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new TypeError(`${what} must be an integer, got ${value}`);
    if (!Number.isSafeInteger(value)) throw new TypeError(`${what} exceeds safe integer range: ${value}`);
    return BigInt(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) throw new TypeError(`${what} must be a base-unit integer string, got ${JSON.stringify(value)}`);
    return BigInt(trimmed);
  }
  throw new TypeError(`${what} must be a bigint, integer or integer string, got ${typeof value}`);
}

/** Same as toBigInt but refuses negatives. */
export function toNonNegativeBigInt(value, what = 'amount') {
  const n = toBigInt(value, what);
  if (n < ZERO) throw new RangeError(`${what} must not be negative, got ${n.toString()}`);
  return n;
}

/** Read a pref bundle out of a Map, a plain object, or an already-unwrapped array of picks. */
function prefsFor(prefsByWallet, wallet) {
  if (!prefsByWallet) return null;
  let entry = null;
  if (typeof prefsByWallet.get === 'function') entry = prefsByWallet.get(wallet);
  else if (typeof prefsByWallet === 'object') entry = Object.prototype.hasOwnProperty.call(prefsByWallet, wallet) ? prefsByWallet[wallet] : null;
  if (!entry) return null;
  if (Array.isArray(entry)) return entry;
  if (Array.isArray(entry.picks)) return entry.picks;
  return null;
}

/** Integer pct out of stored prefs, or null when the entry is unusable. */
function storedPct(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  if (typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return null;
}

/**
 * Wallet -> balance for one snapshot, accepting either a holder array or a
 * whole Snapshot document.
 *
 * A wallet that appears twice keeps its FIRST row, exactly as computeEligible
 * does, so combining snapshots can never change a balance that the existing
 * eligibility filter would have used.
 */
function snapshotBalances(input, what) {
  const list = Array.isArray(input) ? input : Array.isArray(input?.holders) ? input.holders : [];
  const out = new Map();
  for (const holder of list) {
    if (!holder || typeof holder.wallet !== 'string' || holder.wallet === '') continue;
    if (out.has(holder.wallet)) continue;
    out.set(holder.wallet, toNonNegativeBigInt(holder.balance, `${what} balance of ${holder.wallet}`));
  }
  return out;
}

/**
 * combineSnapshots(openHolders, closeHolders) -> { holders, stats }
 *
 * The full-cycle rule. A wallet is paid for a cycle only on what it held for
 * the WHOLE of it, so its weight is
 *
 *     balance = min(openBalance, closeBalance)      (BigInt, exact)
 *
 * with a wallet that is absent from a snapshot counted as zero there. That one
 * line is the whole anti-cheat:
 *
 *   - bought after the open snapshot  -> open 0  -> min 0 -> no drop this round,
 *     and it is present in the next cycle's open snapshot, so it is paid then;
 *   - sold before the close snapshot  -> close 0 -> min 0 -> no drop;
 *   - topped up mid-cycle             -> weighted on the smaller (held-all-cycle) balance;
 *   - held steady                     -> unaffected.
 *
 * Eligibility is applied to this same minimum by computeEligible, so a wallet
 * has to clear the threshold for the whole cycle rather than at one instant.
 *
 * Every wallet seen in either snapshot is returned — including the ones whose
 * minimum is zero, which carry no weight (computeEligible drops a zero balance)
 * but are counted in `stats` and flagged, so the site can say *why* a wallet got
 * nothing instead of leaving someone to guess.
 *
 * @param {{wallet: string, balance: string|bigint|number}[]|{holders: object[]}} openHolders
 * @param {{wallet: string, balance: string|bigint|number}[]|{holders: object[]}} closeHolders
 * @returns {{
 *   holders: {wallet: string, balance: string, openBalance: string, closeBalance: string,
 *             joinedThisCycle: boolean, reduced: boolean}[],
 *   stats: {wallets: number, openHolders: number, closeHolders: number, held: number,
 *           joinedThisCycle: number, leftThisCycle: number, reduced: number, steady: number,
 *           zeroWeight: number, openWeight: string, closeWeight: string, weight: string}
 * }}
 */
export function combineSnapshots(openHolders, closeHolders) {
  const open = snapshotBalances(openHolders, 'open snapshot');
  const close = snapshotBalances(closeHolders, 'close snapshot');

  const wallets = new Set(open.keys());
  for (const wallet of close.keys()) wallets.add(wallet);

  const holders = [];
  const stats = {
    wallets: wallets.size,
    openHolders: 0,
    closeHolders: 0,
    held: 0,
    joinedThisCycle: 0,
    leftThisCycle: 0,
    reduced: 0,
    steady: 0,
    zeroWeight: 0,
    openWeight: '0',
    closeWeight: '0',
    weight: '0',
  };

  let openWeight = ZERO;
  let closeWeight = ZERO;
  let weight = ZERO;

  for (const wallet of wallets) {
    const openBalance = open.get(wallet) ?? ZERO;
    const closeBalance = close.get(wallet) ?? ZERO;
    const balance = openBalance < closeBalance ? openBalance : closeBalance;

    const joinedThisCycle = openBalance === ZERO && closeBalance > ZERO;
    const reduced = openBalance > ZERO && closeBalance > ZERO && openBalance !== closeBalance;

    if (openBalance > ZERO) stats.openHolders += 1;
    if (closeBalance > ZERO) stats.closeHolders += 1;
    if (balance > ZERO) stats.held += 1;
    else stats.zeroWeight += 1;
    if (joinedThisCycle) stats.joinedThisCycle += 1;
    if (openBalance > ZERO && closeBalance === ZERO) stats.leftThisCycle += 1;
    if (reduced) stats.reduced += 1;
    if (openBalance > ZERO && closeBalance > ZERO && openBalance === closeBalance) stats.steady += 1;

    openWeight += openBalance;
    closeWeight += closeBalance;
    weight += balance;

    holders.push({
      wallet,
      balance: balance.toString(),
      openBalance: openBalance.toString(),
      closeBalance: closeBalance.toString(),
      joinedThisCycle,
      reduced,
    });
  }

  holders.sort((a, b) => {
    const ab = BigInt(a.balance);
    const bb = BigInt(b.balance);
    if (ab !== bb) return bb > ab ? 1 : -1;
    return a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0;
  });

  stats.openWeight = openWeight.toString();
  stats.closeWeight = closeWeight.toString();
  stats.weight = weight.toString();

  return { holders, stats };
}

/**
 * eligibleThreshold(supplyRaw, eligibleBps) -> bigint
 * floor(supply * bps / 10000). 0.1% of a 1B/6dp supply = 1,000,000 tokens.
 */
export function eligibleThreshold(supplyRaw, eligibleBps) {
  const supply = toNonNegativeBigInt(supplyRaw, 'supplyRaw');
  const bps = toNonNegativeBigInt(eligibleBps ?? 0, 'eligibleBps');
  return (supply * bps) / BPS_DENOM;
}

/**
 * computeEligible(holders, { supplyRaw, eligibleBps, excluded }) -> Holder[]
 *
 * Keeps holders whose balance is at or above the threshold (inclusive) and
 * whose wallet is not excluded. A zero balance is never eligible, even when the
 * threshold itself computes to zero.
 * Returned holders are `{ wallet, balance }` with balance a base-unit string,
 * sorted by balance descending then wallet ascending (deterministic).
 *
 * Rows produced by combineSnapshots carry `openBalance` / `closeBalance` /
 * `reduced` alongside the balance; those are passed through unchanged so the
 * round ledger can show what a holder held at each end of the cycle. The
 * balance tested against the threshold is whatever the caller supplied — for a
 * combined snapshot that is min(open, close), so a wallet has to clear the
 * threshold for the whole cycle, not merely at the close.
 */
export function computeEligible(holders, opts = {}) {
  const threshold = eligibleThreshold(opts.supplyRaw ?? 0, opts.eligibleBps ?? 0);
  const excluded = new Set();
  const rawExcluded = opts.excluded;
  if (rawExcluded) {
    const list = typeof rawExcluded[Symbol.iterator] === 'function' && typeof rawExcluded !== 'string' ? rawExcluded : [rawExcluded];
    for (const wallet of list) {
      if (typeof wallet === 'string' && wallet.trim() !== '') excluded.add(wallet.trim());
    }
  }

  const list = Array.isArray(holders) ? holders : [];
  const out = [];
  const seen = new Set();

  for (const holder of list) {
    if (!holder || typeof holder.wallet !== 'string' || holder.wallet === '') continue;
    if (excluded.has(holder.wallet)) continue;
    if (seen.has(holder.wallet)) continue; // a wallet can own several token accounts; the caller sums them
    const balance = toNonNegativeBigInt(holder.balance, `balance of ${holder.wallet}`);
    if (balance === ZERO) continue;
    if (balance < threshold) continue;
    seen.add(holder.wallet);
    const row = { wallet: holder.wallet, balance: balance.toString() };
    if (holder.openBalance !== undefined && holder.openBalance !== null) {
      row.openBalance = toNonNegativeBigInt(holder.openBalance, `open balance of ${holder.wallet}`).toString();
    }
    if (holder.closeBalance !== undefined && holder.closeBalance !== null) {
      row.closeBalance = toNonNegativeBigInt(holder.closeBalance, `close balance of ${holder.wallet}`).toString();
    }
    if (holder.reduced === true) row.reduced = true;
    out.push(row);
  }

  out.sort((a, b) => {
    const ab = BigInt(a.balance);
    const bb = BigInt(b.balance);
    if (ab !== bb) return bb > ab ? 1 : -1;
    return a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0;
  });

  return out;
}

/**
 * Re-spread a holder's percentages across the picks that are still tradeable.
 * Largest-remainder apportionment, so the result is integers summing to exactly
 * 100 with no float anywhere. Ties break on pct desc, symbol asc, mint asc so
 * the outcome is reproducible from the stored round document.
 *
 * @param {{mint,symbol,pct}[]} picks picks that survive (pct > 0)
 * @returns {{mint,symbol,pct}[]}
 */
export function respreadPicks(picks) {
  const valid = picks.filter((p) => p && p.pct > 0);
  const n = valid.length;
  if (n === 0) return [];

  const total = valid.reduce((acc, p) => acc + p.pct, 0);
  if (total <= 0) return [];
  if (total === 100) return valid.map((p) => ({ mint: p.mint, symbol: p.symbol, pct: p.pct })).sort(comparePicks);

  const rows = valid.map((p) => {
    const numer = p.pct * 100;
    return {
      mint: p.mint,
      symbol: p.symbol,
      srcPct: p.pct,
      pct: Math.floor(numer / total),
      remainder: numer % total,
    };
  });

  let leftover = 100 - rows.reduce((acc, r) => acc + r.pct, 0);
  const order = rows.slice().sort((a, b) => {
    if (a.remainder !== b.remainder) return b.remainder - a.remainder;
    if (a.srcPct !== b.srcPct) return b.srcPct - a.srcPct;
    if (a.symbol !== b.symbol) return a.symbol < b.symbol ? -1 : 1;
    return a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0;
  });
  for (const row of order) {
    if (leftover <= 0) break;
    row.pct += 1;
    leftover -= 1;
  }

  return rows.map((r) => ({ mint: r.mint, symbol: r.symbol, pct: r.pct })).sort(comparePicks);
}

/**
 * The basket a holder actually gets this round.
 * @returns {{picks: Pick[], source: 'prefs'|'prefs-adjusted'|'default'}}
 */
export function effectiveBasket(storedPicks, universeIndex, fallback) {
  if (!Array.isArray(storedPicks) || storedPicks.length === 0) {
    return { picks: fallback.map((p) => ({ ...p })), source: 'default' };
  }

  const kept = [];
  const seen = new Set();
  let dropped = 0;

  for (const raw of storedPicks) {
    const mint = raw && typeof raw.mint === 'string' ? raw.mint : null;
    const pct = raw ? storedPct(raw.pct) : null;
    const stock = mint ? universeIndex.get(mint) : null;
    if (!stock || pct === null || pct <= 0 || seen.has(mint)) {
      dropped += 1;
      continue;
    }
    seen.add(mint);
    kept.push({ mint, symbol: stock.symbol ?? '', pct });
  }

  if (kept.length === 0) return { picks: fallback.slice(), source: 'default' };
  if (dropped === 0) {
    const total = kept.reduce((acc, p) => acc + p.pct, 0);
    if (total === 100) return { picks: kept.slice().sort(comparePicks), source: 'prefs' };
    // Stored prefs that no longer add to 100 (rules changed under them) are
    // re-normalized rather than silently mis-weighted.
    return { picks: respreadPicks(kept), source: 'prefs-adjusted' };
  }
  return { picks: respreadPicks(kept), source: 'prefs-adjusted' };
}

/**
 * computeDemand(eligible, prefsByWallet, universe, rules)
 *
 * weight(holder, stock) = balance * pct   (BigInt, exact)
 *
 * @returns {{
 *   perStock: Map<string, {mint,symbol,weight: bigint, contributors: {wallet: string, weight: bigint}[]}>,
 *   totalWeight: bigint,
 *   holders: {wallet, balance: string, source: 'prefs'|'prefs-adjusted'|'default', picks: Pick[]}[]
 * }}
 */
export function computeDemand(eligible, prefsByWallet, universe, rules = DEFAULT_RULES) {
  const stocks = normalizeUniverse(universe);
  const index = new Map();
  for (const stock of stocks) {
    if (stock && typeof stock.mint === 'string' && stock.mint.length > 0 && !index.has(stock.mint)) {
      index.set(stock.mint, stock);
    }
  }
  const fallback = defaultPicks(stocks, rules);

  const perStock = new Map();
  const holders = [];
  let totalWeight = ZERO;

  for (const holder of Array.isArray(eligible) ? eligible : []) {
    if (!holder || typeof holder.wallet !== 'string' || holder.wallet === '') continue;
    const balance = toNonNegativeBigInt(holder.balance, `balance of ${holder.wallet}`);
    const { picks, source } = effectiveBasket(prefsFor(prefsByWallet, holder.wallet), index, fallback);

    holders.push({ wallet: holder.wallet, balance: balance.toString(), source, picks });
    if (balance === ZERO || picks.length === 0) continue;

    for (const pick of picks) {
      const weight = balance * BigInt(pick.pct);
      if (weight <= ZERO) continue;
      let entry = perStock.get(pick.mint);
      if (!entry) {
        const stock = index.get(pick.mint);
        entry = { mint: pick.mint, symbol: stock?.symbol ?? pick.symbol ?? '', weight: ZERO, contributors: [] };
        perStock.set(pick.mint, entry);
      }
      entry.weight += weight;
      entry.contributors.push({ wallet: holder.wallet, weight });
      totalWeight += weight;
    }
  }

  // Deterministic ordering: stocks by demand desc then symbol asc; contributors
  // by weight desc then wallet asc. Nothing downstream depends on order (every
  // allocation is an independent floor) but a reproducible document does.
  for (const entry of perStock.values()) {
    entry.contributors.sort((a, b) => {
      if (a.weight !== b.weight) return b.weight > a.weight ? 1 : -1;
      return a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0;
    });
  }
  const ordered = [...perStock.values()].sort((a, b) => {
    if (a.weight !== b.weight) return b.weight > a.weight ? 1 : -1;
    if (a.symbol !== b.symbol) return a.symbol < b.symbol ? -1 : 1;
    return a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0;
  });

  const sortedPerStock = new Map();
  for (const entry of ordered) sortedPerStock.set(entry.mint, entry);

  return { perStock: sortedPerStock, totalWeight, holders };
}

/** Accept a demand Map, a Map of raw bigints, or an array of {mint, weight}. */
function demandEntries(perStock) {
  const out = [];
  const push = (mint, value) => {
    const weight = typeof value === 'bigint' || typeof value === 'string' || typeof value === 'number'
      ? toNonNegativeBigInt(value, `weight of ${mint}`)
      : toNonNegativeBigInt(value?.weight ?? 0, `weight of ${mint}`);
    out.push({ mint, weight });
  };
  if (perStock instanceof Map) {
    for (const [mint, value] of perStock) push(mint, value);
  } else if (Array.isArray(perStock)) {
    for (const entry of perStock) push(entry.mint, entry);
  } else if (perStock && typeof perStock === 'object') {
    for (const [mint, value] of Object.entries(perStock)) push(mint, value);
  }
  return out;
}

/**
 * splitPool(poolLamports, perStock) -> Map<mint, bigint>
 *
 * lamports(stock) = floor(pool * weight / totalWeight).
 * The remainder (strictly fewer lamports than there are stocks) is not assigned
 * to anyone: it stays in the vault and is part of the next round's pool.
 */
export function splitPool(poolLamports, perStock) {
  const pool = toNonNegativeBigInt(poolLamports, 'poolLamports');
  const entries = demandEntries(perStock);
  const total = entries.reduce((acc, e) => acc + e.weight, ZERO);

  const out = new Map();
  if (total === ZERO) {
    for (const entry of entries) out.set(entry.mint, ZERO);
    return out;
  }
  for (const entry of entries) out.set(entry.mint, (pool * entry.weight) / total);
  return out;
}

/**
 * allocate(receivedRaw, contributors, carryInRaw) -> { transfers, dustRaw, ... }
 *
 * amount(holder) = floor((received + carryIn) * weight / totalWeight)
 * Everything not handed out — the rounding remainder plus every amount that
 * floors to zero — is `dustRaw`, and carries into the next round for this stock.
 *
 * Contributors that allocate to zero are still returned (amountRaw 0n) so the
 * round ledger can record them as SKIPPED_DUST instead of pretending they were
 * never there.
 *
 * @param {bigint|string|number} receivedRaw   base units actually received from the swap
 * @param {{wallet: string, weight: bigint|string|number}[]} contributors
 * @param {bigint|string|number} [carryInRaw=0] dust carried in from earlier rounds
 */
export function allocate(receivedRaw, contributors, carryInRaw = ZERO) {
  const received = toNonNegativeBigInt(receivedRaw, 'receivedRaw');
  const carryIn = toNonNegativeBigInt(carryInRaw ?? 0, 'carryInRaw');
  const total = received + carryIn;

  const rows = [];
  let totalWeight = ZERO;
  for (const contributor of Array.isArray(contributors) ? contributors : []) {
    if (!contributor || typeof contributor.wallet !== 'string' || contributor.wallet === '') continue;
    const weight = toNonNegativeBigInt(contributor.weight, `weight of ${contributor.wallet}`);
    if (weight === ZERO) continue;
    rows.push({ wallet: contributor.wallet, weight });
    totalWeight += weight;
  }

  if (totalWeight === ZERO || total === ZERO) {
    return {
      transfers: rows.map((r) => ({ wallet: r.wallet, weight: r.weight, amountRaw: ZERO })),
      dustRaw: total,
      totalRaw: total,
      receivedRaw: received,
      carryInRaw: carryIn,
      totalWeight,
    };
  }

  // Sum first, then subtract: dust is defined by conservation, not recomputed.
  let handedOut = ZERO;
  const transfers = rows.map((row) => {
    const amountRaw = (total * row.weight) / totalWeight;
    handedOut += amountRaw;
    return { wallet: row.wallet, weight: row.weight, amountRaw };
  });

  transfers.sort((a, b) => {
    if (a.amountRaw !== b.amountRaw) return b.amountRaw > a.amountRaw ? 1 : -1;
    return a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0;
  });

  return {
    transfers,
    dustRaw: total - handedOut,
    totalRaw: total,
    receivedRaw: received,
    carryInRaw: carryIn,
    totalWeight,
  };
}
