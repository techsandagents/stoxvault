/**
 * STOCKDROP engine / round assembly
 *
 * Pure. Turns (pool, holders, prefs, universe) into the exact numbers a round
 * document publishes, and turns swap results into the exact transfer list.
 *
 * The point of keeping this pure and integer-only: anyone can take a stored
 * round document, re-run these functions, and get byte-identical numbers.
 */

import { canonicalJson, sha256Hex } from '../util/canonical.js';
import { normalizeUniverse, topStocks, cmpStr } from './ranking.js';
import { DEFAULT_RULES } from './validate.js';
import {
  allocate,
  computeDemand,
  computeEligible,
  eligibleThreshold,
  splitPool,
  toNonNegativeBigInt,
} from './allocate.js';

const ZERO = 0n;
const BPS_TOTAL = 10000n;

/**
 * Canonical form of a snapshot: the fields that define it, with holders sorted
 * by wallet and every amount as a base-unit string. The snapshot's own `hash`
 * is excluded (it is the output, not an input).
 */
export function canonicalSnapshot(snapshot) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const holders = (Array.isArray(snap.holders) ? snap.holders : [])
    .filter((h) => h && typeof h.wallet === 'string' && h.wallet !== '')
    .map((h) => ({ wallet: h.wallet, balance: toNonNegativeBigInt(h.balance, `balance of ${h.wallet}`).toString() }))
    .sort((a, b) => cmpStr(a.wallet, b.wallet));

  const excluded = (Array.isArray(snap.excluded) ? snap.excluded : [])
    .filter((w) => typeof w === 'string' && w !== '')
    .slice()
    .sort(cmpStr);

  const slot = Number.isFinite(snap.slot) ? Math.trunc(snap.slot) : null;

  return {
    takenAt: snap.takenAt == null ? null : String(snap.takenAt),
    slot,
    tokenMint: snap.tokenMint == null || snap.tokenMint === '' ? null : String(snap.tokenMint),
    supply: snap.supply == null ? null : toNonNegativeBigInt(snap.supply, 'supply').toString(),
    eligibleThreshold:
      snap.eligibleThreshold == null ? null : toNonNegativeBigInt(snap.eligibleThreshold, 'eligibleThreshold').toString(),
    excluded,
    holders,
  };
}

/** snapshotHash(snapshot) -> hex sha256 of the canonical JSON of the snapshot. */
export function snapshotHash(snapshot) {
  return sha256Hex(canonicalJson(canonicalSnapshot(snapshot)));
}

/**
 * Basis-point shares that sum to exactly 10000, by largest remainder.
 * Display only — the money is split by splitPool, not by these.
 */
function shareBpsFor(entries, totalWeight) {
  if (entries.length === 0 || totalWeight === ZERO) return entries.map(() => 0);

  const rows = entries.map((entry, index) => {
    const numer = entry.weight * BPS_TOTAL;
    return { index, base: Number(numer / totalWeight), remainder: numer % totalWeight, entry };
  });

  let leftover = 10000 - rows.reduce((acc, r) => acc + r.base, 0);
  const order = rows.slice().sort((a, b) => {
    if (a.remainder !== b.remainder) return b.remainder > a.remainder ? 1 : -1;
    if (a.entry.weight !== b.entry.weight) return b.entry.weight > a.entry.weight ? 1 : -1;
    return cmpStr(a.entry.symbol, b.entry.symbol) || cmpStr(a.entry.mint, b.entry.mint);
  });
  for (const row of order) {
    if (leftover <= 0) break;
    row.base += 1;
    leftover -= 1;
  }

  const out = new Array(rows.length);
  for (const row of rows) out[row.index] = row.base;
  return out;
}

/**
 * buildRoundPlan({ poolLamports, reserveLamports, holders, prefsByWallet, universe, rules })
 *
 * `holders` are taken as already-eligible unless `supplyRaw` is supplied, in
 * which case the eligibility filter (threshold + exclusions) is applied here.
 *
 * @returns {{
 *   poolLamports: string, reserveLamports: string, totalWeight: string,
 *   spentLamports: string, remainderLamports: string,
 *   eligibleThreshold: string|null,
 *   top5: string[],
 *   eligible: {wallet: string, balance: string}[],
 *   holders: {wallet, balance, source, picks}[],
 *   demand: {mint, symbol, weight: string, shareBps: number, solLamports: string}[],
 *   contributorsByMint: Map<string, {wallet: string, weight: bigint}[]>,
 *   stats: {eligibleHolders, prefHolders, defaultHolders, adjustedHolders, stocks}
 * }}
 */
export function buildRoundPlan(input = {}) {
  const {
    poolLamports = 0,
    reserveLamports = 0,
    holders = [],
    prefsByWallet = null,
    universe = [],
    rules = DEFAULT_RULES,
    supplyRaw = null,
    excluded = [],
  } = input;

  const pool = toNonNegativeBigInt(poolLamports, 'poolLamports');
  const reserve = toNonNegativeBigInt(reserveLamports ?? 0, 'reserveLamports');
  const stocks = normalizeUniverse(universe);
  const eligibleBps = input.eligibleBps ?? rules?.eligibleBps ?? null;

  let eligible;
  let threshold = null;
  if (supplyRaw === null || supplyRaw === undefined) {
    // Caller already applied the balance threshold (the keeper does it during
    // SNAPSHOT). Exclusions and duplicate wallets are still enforced here: a
    // wallet that slipped through would otherwise be paid twice.
    const excludedSet = new Set((Array.isArray(excluded) ? excluded : []).filter((w) => typeof w === 'string' && w !== ''));
    const seenWallets = new Set();
    eligible = [];
    for (const holder of Array.isArray(holders) ? holders : []) {
      if (!holder || typeof holder.wallet !== 'string' || holder.wallet === '') continue;
      if (excludedSet.has(holder.wallet) || seenWallets.has(holder.wallet)) continue;
      const balance = toNonNegativeBigInt(holder.balance, `balance of ${holder.wallet}`);
      if (balance === ZERO) continue;
      seenWallets.add(holder.wallet);
      eligible.push({ wallet: holder.wallet, balance: balance.toString() });
    }
  } else {
    threshold = eligibleThreshold(supplyRaw, eligibleBps ?? 0);
    eligible = computeEligible(holders, { supplyRaw, eligibleBps: eligibleBps ?? 0, excluded });
  }

  const { perStock, totalWeight, holders: holderResults } = computeDemand(eligible, prefsByWallet, stocks, rules);
  const entries = [...perStock.values()];
  const lamportsByMint = splitPool(pool, perStock);
  const bps = shareBpsFor(entries, totalWeight);

  let spent = ZERO;
  const demand = entries.map((entry, i) => {
    const solLamports = lamportsByMint.get(entry.mint) ?? ZERO;
    spent += solLamports;
    return {
      mint: entry.mint,
      symbol: entry.symbol,
      weight: entry.weight.toString(),
      shareBps: bps[i],
      solLamports: solLamports.toString(),
    };
  });

  const contributorsByMint = new Map();
  for (const entry of entries) {
    contributorsByMint.set(entry.mint, entry.contributors.map((c) => ({ wallet: c.wallet, weight: c.weight })));
  }

  const basketSize = Number.isFinite(rules?.defaultBasketSize) ? rules.defaultBasketSize : DEFAULT_RULES.defaultBasketSize;
  const top5 = topStocks(stocks, basketSize).map((s) => s.mint);

  const prefHolders = holderResults.filter((h) => h.source !== 'default').length;
  const adjustedHolders = holderResults.filter((h) => h.source === 'prefs-adjusted').length;

  return {
    poolLamports: pool.toString(),
    reserveLamports: reserve.toString(),
    totalWeight: totalWeight.toString(),
    spentLamports: spent.toString(),
    remainderLamports: (pool - spent).toString(),
    eligibleThreshold: threshold === null ? null : threshold.toString(),
    top5,
    eligible,
    holders: holderResults,
    demand,
    contributorsByMint,
    stats: {
      eligibleHolders: eligible.length,
      prefHolders,
      defaultHolders: holderResults.length - prefHolders,
      adjustedHolders,
      stocks: demand.length,
    },
  };
}

/** Contributors for a mint out of a plan (Map, plain object, or the demand array shape). */
function contributorsOf(plan, mint) {
  const source = plan?.contributorsByMint;
  if (source instanceof Map) return source.get(mint) ?? [];
  if (source && typeof source === 'object') return source[mint] ?? [];
  return [];
}

/** carryIn as [{mint, amountRaw}] | Map | object -> Map<mint, bigint> */
function carryInMap(carryIn) {
  const out = new Map();
  if (!carryIn) return out;
  const add = (mint, amount) => {
    if (typeof mint !== 'string' || mint === '') return;
    const value = toNonNegativeBigInt(amount ?? 0, `carryIn of ${mint}`);
    out.set(mint, (out.get(mint) ?? ZERO) + value);
  };
  if (Array.isArray(carryIn)) {
    for (const entry of carryIn) add(entry?.mint, entry?.amountRaw ?? entry?.amount ?? 0);
  } else if (carryIn instanceof Map) {
    for (const [mint, amount] of carryIn) add(mint, typeof amount === 'object' ? amount?.amountRaw : amount);
  } else if (typeof carryIn === 'object') {
    for (const [mint, amount] of Object.entries(carryIn)) add(mint, typeof amount === 'object' ? amount?.amountRaw : amount);
  }
  return out;
}

/**
 * applySwapResults(plan, swaps, carryIn) -> { transfers, carryOut, perStock, stats }
 *
 * For every DONE swap, the received tokens plus any dust carried in for that
 * mint are split across that stock's contributors by weight. Anything a swap
 * did not deliver (PENDING/FAILED) keeps its carry-in untouched: dust is never
 * lost and never double-spent.
 *
 * Transfers come back in Round.transfers shape (amounts as base-unit strings),
 * status PENDING for real sends, SKIPPED_DUST for amounts that floor to zero.
 */
export function applySwapResults(plan, swaps, carryIn = []) {
  const carry = carryInMap(carryIn);
  const swapList = Array.isArray(swaps) ? swaps : [];
  const symbolByMint = new Map();
  for (const entry of Array.isArray(plan?.demand) ? plan.demand : []) {
    if (entry && typeof entry.mint === 'string') symbolByMint.set(entry.mint, entry.symbol ?? '');
  }

  const transfers = [];
  const perStock = [];
  const carryOut = [];
  const settled = new Set();
  let skippedDust = 0;

  for (const swap of swapList) {
    if (!swap || typeof swap.mint !== 'string' || swap.mint === '') continue;
    const mint = swap.mint;
    if (settled.has(mint)) continue;
    settled.add(mint);

    const symbol = swap.symbol ?? symbolByMint.get(mint) ?? '';
    const carryInRaw = carry.get(mint) ?? ZERO;
    const done = swap.status === 'DONE';
    const received = done ? toNonNegativeBigInt(swap.receivedRaw ?? 0, `receivedRaw of ${mint}`) : ZERO;

    if (!done) {
      // The SOL stayed in the vault; whatever dust we were holding stays too.
      if (carryInRaw > ZERO) carryOut.push({ mint, amountRaw: carryInRaw.toString() });
      perStock.push({
        mint,
        symbol,
        status: swap.status ?? 'PENDING',
        receivedRaw: '0',
        carryInRaw: carryInRaw.toString(),
        totalRaw: carryInRaw.toString(),
        distributedRaw: '0',
        dustRaw: carryInRaw.toString(),
        transfers: 0,
        skippedDust: 0,
      });
      continue;
    }

    const contributors = contributorsOf(plan, mint);
    const result = allocate(received, contributors, carryInRaw);

    let distributed = ZERO;
    let skippedHere = 0;
    for (const transfer of result.transfers) {
      const zero = transfer.amountRaw === ZERO;
      if (zero) skippedHere += 1;
      else distributed += transfer.amountRaw;
      transfers.push({
        wallet: transfer.wallet,
        mint,
        symbol,
        amountRaw: transfer.amountRaw.toString(),
        tx: null,
        status: zero ? 'SKIPPED_DUST' : 'PENDING',
        error: null,
      });
    }
    skippedDust += skippedHere;

    if (result.dustRaw > ZERO) carryOut.push({ mint, amountRaw: result.dustRaw.toString() });
    perStock.push({
      mint,
      symbol,
      status: 'DONE',
      receivedRaw: received.toString(),
      carryInRaw: carryInRaw.toString(),
      totalRaw: result.totalRaw.toString(),
      distributedRaw: distributed.toString(),
      dustRaw: result.dustRaw.toString(),
      transfers: result.transfers.length - skippedHere,
      skippedDust: skippedHere,
    });
  }

  // Dust held for a stock that this round never touched still carries forward.
  for (const [mint, amount] of carry) {
    if (settled.has(mint) || amount === ZERO) continue;
    carryOut.push({ mint, amountRaw: amount.toString() });
    perStock.push({
      mint,
      symbol: symbolByMint.get(mint) ?? '',
      status: 'UNTOUCHED',
      receivedRaw: '0',
      carryInRaw: amount.toString(),
      totalRaw: amount.toString(),
      distributedRaw: '0',
      dustRaw: amount.toString(),
      transfers: 0,
      skippedDust: 0,
    });
  }

  carryOut.sort((a, b) => cmpStr(a.mint, b.mint));

  return {
    transfers,
    carryOut,
    perStock,
    stats: {
      transfersPending: transfers.length - skippedDust,
      transfersSkippedDust: skippedDust,
      stocksDistributed: perStock.filter((s) => s.status === 'DONE').length,
    },
  };
}
