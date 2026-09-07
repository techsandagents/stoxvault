/**
 * STOCKDROP — the numbers on the front page.
 *
 * Two jobs:
 *
 *   1. community demand — what the community, collectively, is asking the vault
 *      to buy. Before launch there are no balances to weigh with, so every
 *      wallet that has saved picks counts once (`equal-weight`). After launch
 *      each wallet counts in proportion to what it holds at the last snapshot
 *      (`holding-weighted`). Either way the percentages are integers produced by
 *      largest-remainder apportionment, so they sum to exactly 100 — never 99,
 *      never 101.
 *
 *   2. the /api/stats aggregate, assembled from parts that are each allowed to
 *      fail: an unreachable RPC costs you the vault balance, not the page.
 */

import { computeEligible } from '../engine/index.js';
import { log } from '../util/log.js';

const logger = log.child('stats');
const LAMPORTS_PER_SOL = 1_000_000_000;

/* ------------------------------------------------------- round totals ---- */

/** KV key holding the running round aggregate. */
export const ROUND_TOTALS_KEY = 'stats:round-totals';
/** Bump when the aggregate's shape or its counting rules change: old docs are rebuilt. */
export const ROUND_TOTALS_VERSION = 2;
/** How many summaries one page of the incremental scan pulls. */
export const ROUND_TOTALS_PAGE = 100;
/** Hard cap on pages per call, so a cold start on a huge ledger is still bounded. */
export const ROUND_TOTALS_MAX_PAGES = 50;
/** Non-terminal rounds we keep re-checking. In practice at most one is open at a time. */
export const ROUND_TOTALS_MAX_OPEN = 64;
/** Ids sharing the cursor's exact millisecond. Rounds are 6h apart; this is slack, not a budget. */
export const ROUND_TOTALS_MAX_CURSOR_IDS = 256;

const ZERO = '0';
const isDigits = (v) => typeof v === 'string' && /^\d+$/.test(v);

/** A fresh, empty aggregate. */
export function emptyRoundTotals() {
  return {
    version: ROUND_TOTALS_VERSION,
    cursorAt: null,
    cursorIds: [],
    distributedLamports: ZERO,
    distributedRounds: 0,
    simulatedLamports: ZERO,
    simulatedRounds: 0,
    failedRounds: 0,
    skippedRounds: 0,
    lastAt: null,
    lastDistributedAt: null,
    open: [],
  };
}

/** Accept a stored aggregate only if it is this version and structurally sound. */
export function normalizeRoundTotals(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== ROUND_TOTALS_VERSION) return null;
  const base = emptyRoundTotals();
  return {
    ...base,
    cursorAt: typeof raw.cursorAt === 'string' ? raw.cursorAt : null,
    cursorIds: Array.isArray(raw.cursorIds)
      ? raw.cursorIds.filter((id) => typeof id === 'string').slice(-ROUND_TOTALS_MAX_CURSOR_IDS)
      : [],
    distributedLamports: isDigits(raw.distributedLamports) ? raw.distributedLamports : ZERO,
    distributedRounds: Number.isFinite(raw.distributedRounds) ? Number(raw.distributedRounds) : 0,
    simulatedLamports: isDigits(raw.simulatedLamports) ? raw.simulatedLamports : ZERO,
    simulatedRounds: Number.isFinite(raw.simulatedRounds) ? Number(raw.simulatedRounds) : 0,
    failedRounds: Number.isFinite(raw.failedRounds) ? Number(raw.failedRounds) : 0,
    skippedRounds: Number.isFinite(raw.skippedRounds) ? Number(raw.skippedRounds) : 0,
    lastAt: typeof raw.lastAt === 'string' ? raw.lastAt : null,
    lastDistributedAt: typeof raw.lastDistributedAt === 'string' ? raw.lastDistributedAt : null,
    open: Array.isArray(raw.open)
      ? raw.open
          .filter((o) => o && typeof o.id === 'string')
          .slice(0, ROUND_TOTALS_MAX_OPEN)
          .map((o) => ({ id: o.id, at: typeof o.at === 'string' ? o.at : null }))
      : [],
  };
}

/** The SOL a round actually put through Jupiter, as recorded by the SWAPPING step. */
function spentLamportsOf(round) {
  const spent = round?.stats?.solSpentLamports;
  return isDigits(spent) ? BigInt(spent) : 0n;
}

/** The timestamp a round is reported by ("last round at"). */
function roundAt(round) {
  const at = round?.finishedAt || round?.startedAt || round?.createdAt || round?.scheduledAt || null;
  return typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : null;
}

/**
 * The timestamp the aggregate's cursor is keyed on. Must be a field a round
 * never rewrites, or a round that finishes between two calls would jump back in
 * front of the cursor and be counted a second time.
 */
function orderKeyOf(round) {
  const at = round?.createdAt || round?.scheduledAt || null;
  return typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : null;
}

/**
 * How one round counts toward the public numbers.
 *
 * The headline "SOL distributed" is a claim that this project bought real
 * stocks and sent them to real wallets, so only a round that actually did it
 * may contribute:
 *
 *   - `simulated` rounds (DRY_RUN, LIVE=0) never touched the chain. Every one
 *     of their swaps is marked DONE against a Jupiter *quote*, so their
 *     solSpentLamports is the whole pool — pure fiction as a spend figure.
 *     Counted separately, labelled, never merged.
 *   - FAILED and SKIPPED rounds distributed nothing.
 *   - a round still in flight is counted when it finishes, not before.
 *
 * @returns {{kind: 'distributed'|'simulated'|'failed'|'skipped'|'open', lamports: bigint}}
 */
export function classifyRound(round) {
  const status = String(round?.status || '');
  if (status === 'FAILED') return { kind: 'failed', lamports: 0n };
  if (status === 'SKIPPED') return { kind: 'skipped', lamports: 0n };
  if (status !== 'DONE') return { kind: 'open', lamports: 0n };
  const lamports = spentLamportsOf(round);
  return round?.simulated === true
    ? { kind: 'simulated', lamports }
    : { kind: 'distributed', lamports };
}

/** Fold one round into an aggregate, in place. */
function foldRound(agg, round) {
  const { kind, lamports } = classifyRound(round);
  const at = roundAt(round);
  if (at && (!agg.lastAt || Date.parse(at) > Date.parse(agg.lastAt))) agg.lastAt = at;

  if (kind === 'distributed') {
    agg.distributedLamports = (BigInt(agg.distributedLamports) + lamports).toString();
    agg.distributedRounds += 1;
    if (at && (!agg.lastDistributedAt || Date.parse(at) > Date.parse(agg.lastDistributedAt))) agg.lastDistributedAt = at;
  } else if (kind === 'simulated') {
    agg.simulatedLamports = (BigInt(agg.simulatedLamports) + lamports).toString();
    agg.simulatedRounds += 1;
  } else if (kind === 'failed') {
    agg.failedRounds += 1;
  } else if (kind === 'skipped') {
    agg.skippedRounds += 1;
  }
  return kind;
}

/**
 * Largest-remainder apportionment of 100 points across weighted entries.
 *
 * @param {{mint?: string, symbol?: string, weight: bigint}[]} entries
 * @returns {{...entry, pct: number}[]} same order in, `pct` fields summing to exactly 100
 */
export function percentagesFromWeights(entries) {
  const rows = (Array.isArray(entries) ? entries : []).map((e) => ({
    ...e,
    weight: typeof e.weight === 'bigint' ? e.weight : BigInt(e.weight ?? 0),
  }));
  const total = rows.reduce((acc, r) => acc + r.weight, 0n);
  if (rows.length === 0 || total === 0n) return rows.map((r) => ({ ...r, pct: 0 }));

  const parts = rows.map((row, index) => {
    const numer = row.weight * 100n;
    return { index, row, base: Number(numer / total), remainder: numer % total };
  });

  let leftover = 100 - parts.reduce((acc, p) => acc + p.base, 0);
  const order = parts.slice().sort((a, b) => {
    if (a.remainder !== b.remainder) return b.remainder > a.remainder ? 1 : -1;
    if (a.row.weight !== b.row.weight) return b.row.weight > a.row.weight ? 1 : -1;
    const as = String(a.row.symbol ?? '');
    const bs = String(b.row.symbol ?? '');
    if (as !== bs) return as < bs ? -1 : 1;
    return String(a.row.mint ?? '') < String(b.row.mint ?? '') ? -1 : 1;
  });
  for (const part of order) {
    if (leftover <= 0) break;
    part.base += 1;
    leftover -= 1;
  }

  const out = new Array(parts.length);
  for (const part of parts) out[part.index] = { ...part.row, pct: part.base };
  return out;
}

/**
 * Aggregate saved preferences into community demand.
 *
 * @param {object} args
 * @param {{wallet: string, picks: {mint: string, pct: number}[]}[]} args.prefs saved preferences
 * @param {{mint: string, symbol: string}[]} args.stocks the current ranked universe
 * @param {Map<string, bigint>|null} [args.balances] wallet -> balance; null = pre-launch
 * @returns {{basis: 'equal-weight'|'holding-weighted', demand: {mint, symbol, pct, weight: string}[], contributors: number, ignored: number}}
 */
export function communityDemand({ prefs = [], stocks = [], balances = null }) {
  const index = new Map();
  for (const stock of stocks) {
    if (stock && typeof stock.mint === 'string') index.set(stock.mint, stock);
  }

  const weights = new Map(); // mint -> bigint
  let contributors = 0;
  let ignored = 0;

  for (const entry of prefs) {
    const wallet = entry?.wallet;
    const picks = Array.isArray(entry?.picks) ? entry.picks : [];
    if (typeof wallet !== 'string' || picks.length === 0) continue;

    // Pre-launch every wallet weighs the same. Post-launch a wallet weighs what
    // it holds, and a wallet holding nothing does not move the average.
    let walletWeight = 1n;
    if (balances) {
      walletWeight = balances.get(wallet) ?? 0n;
      if (walletWeight <= 0n) {
        ignored += 1;
        continue;
      }
    }

    let counted = false;
    for (const pick of picks) {
      const mint = typeof pick?.mint === 'string' ? pick.mint : null;
      const pct = Number(pick?.pct);
      if (!mint || !index.has(mint) || !Number.isFinite(pct) || pct <= 0) continue;
      weights.set(mint, (weights.get(mint) ?? 0n) + walletWeight * BigInt(Math.trunc(pct)));
      counted = true;
    }
    if (counted) contributors += 1;
    else ignored += 1;
  }

  const entries = [...weights.entries()]
    .map(([mint, weight]) => ({ mint, symbol: index.get(mint)?.symbol ?? '', weight }))
    .sort((a, b) => {
      if (a.weight !== b.weight) return b.weight > a.weight ? 1 : -1;
      return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
    });

  const demand = percentagesFromWeights(entries).map((row) => ({
    mint: row.mint,
    symbol: row.symbol,
    pct: row.pct,
    weight: row.weight.toString(),
  }));

  return {
    basis: balances ? 'holding-weighted' : 'equal-weight',
    demand,
    contributors,
    ignored,
  };
}

/** Round SOL for display without ever pretending to more precision than lamports give. */
export function lamportsToSol(lamports) {
  const n = typeof lamports === 'bigint' ? Number(lamports) : Number(lamports);
  if (!Number.isFinite(n)) return null;
  return Math.round((n / LAMPORTS_PER_SOL) * 1e9) / 1e9;
}

/**
 * createStatsService({ cfg, db, universe, holders })
 */
export function createStatsService({ cfg, db, universe, holders, now = Date.now } = {}) {
  if (!cfg) throw new TypeError('createStatsService: cfg is required');
  if (!db) throw new TypeError('createStatsService: db is required');

  /**
   * Balances for the wallets that matter, from the freshest snapshot we have:
   * the last round's snapshot if there is one, otherwise a live read.
   * Returns null before launch, or when the chain cannot be reached.
   */
  async function snapshotBalances() {
    if (!cfg.launched) return null;
    try {
      const latest = await db.latestRound();
      const rows = Array.isArray(latest?.snapshot?.holders) ? latest.snapshot.holders : null;
      if (rows && rows.length > 0) {
        return { map: new Map(rows.map((h) => [h.wallet, BigInt(h.balance)])), takenAt: latest.snapshot.takenAt, source: 'round' };
      }
    } catch (err) {
      logger.debug(`no round snapshot available: ${err?.message || err}`);
    }
    if (!holders) return null;
    try {
      const snap = await holders.snapshot();
      const eligible = computeEligible(snap.holders, {
        supplyRaw: snap.supply ?? cfg.supplyRaw,
        eligibleBps: cfg.eligibleBps,
        excluded: cfg.excluded,
      });
      return { map: new Map(eligible.map((h) => [h.wallet, BigInt(h.balance)])), takenAt: snap.takenAt, source: 'live', eligible };
    } catch (err) {
      logger.warn(`live snapshot failed: ${err?.message || err}`);
      return null;
    }
  }

  /** Community demand, in the shape /api/stats and /api/rounds/preview both use. */
  async function demand() {
    const [stocks, prefs, balances] = await Promise.all([
      universe ? universe.stocks() : [],
      db.allPrefs(),
      snapshotBalances(),
    ]);
    const result = communityDemand({ prefs, stocks, balances: balances?.map ?? null });
    return { ...result, snapshotAt: balances?.takenAt ?? null, eligibleHolders: balances?.map ? balances.map.size : null };
  }

  /* ------------------------------------------------------- round totals -- */
  //
  // Totals are kept as a running aggregate in the KV store rather than
  // recomputed from the whole ledger on every unauthenticated /api/stats call.
  // A request folds in only the rounds that appeared since the cursor, plus any
  // round that was still open last time, so the steady-state cost is one KV read
  // and one page of summaries no matter how long the ledger gets.

  /** In-process copy, so the totals survive a KV store that cannot persist. */
  let localTotals = null;
  /** Collapses a burst of concurrent /api/stats calls onto one scan. */
  let inFlight = null;

  async function loadTotals() {
    if (typeof db.getKV === 'function') {
      try {
        const stored = normalizeRoundTotals(await db.getKV(ROUND_TOTALS_KEY));
        if (stored) return stored;
      } catch (err) {
        logger.debug(`round totals cache unreadable: ${err?.message || err}`);
      }
    }
    return localTotals ? normalizeRoundTotals(localTotals) ?? emptyRoundTotals() : emptyRoundTotals();
  }

  async function saveTotals(agg) {
    localTotals = agg;
    if (typeof db.setKV !== 'function') return;
    try {
      await db.setKV(ROUND_TOTALS_KEY, agg);
    } catch (err) {
      logger.debug(`round totals cache not written: ${err?.message || err}`);
    }
  }

  /**
   * Re-check the rounds that were unfinished when we last looked, folding in
   * the ones that have since reached a terminal state. Everything listed here is
   * behind the cursor, so this is the only place those rounds are ever counted.
   *
   * @returns {Promise<{folded: number, handled: Set<string>}>}
   */
  async function foldOpenRounds(agg) {
    const handled = new Set(agg.open.map((o) => o.id));
    if (agg.open.length === 0 || typeof db.getRound !== 'function') return { folded: 0, handled };
    const stillOpen = [];
    let folded = 0;
    for (const entry of agg.open) {
      let round = null;
      try {
        round = await db.getRound(entry.id);
      } catch (err) {
        logger.debug(`could not re-read round ${entry.id}: ${err?.message || err}`);
        stillOpen.push(entry);
        continue;
      }
      if (!round) continue; // deleted: nothing to count
      const kind = foldRound(agg, round);
      if (kind === 'open') stillOpen.push({ id: entry.id, at: orderKeyOf(round) });
      else folded += 1;
    }
    agg.open = stillOpen.slice(0, ROUND_TOTALS_MAX_OPEN);
    return { folded, handled };
  }

  /**
   * Fold every round newer than the cursor. listRounds is newest-first, so the
   * walk stops at the first round the aggregate has already seen.
   *
   * The cursor is keyed on `createdAt`, which a round never changes — keying it
   * on finishedAt would let a round that was open at the last call reappear
   * ahead of the cursor and be counted twice.
   */
  async function foldNewRounds(agg, handled) {
    const cursorMs = agg.cursorAt ? Date.parse(agg.cursorAt) : null;
    const cursorIds = new Set(agg.cursorIds);
    const fresh = [];
    let total = 0;
    let offset = 0;
    let truncated = false;

    for (let page = 0; page < ROUND_TOTALS_MAX_PAGES; page++) {
      const result = await db.listRounds({ limit: ROUND_TOTALS_PAGE, offset });
      total = Number(result?.total ?? 0);
      const items = Array.isArray(result?.items) ? result.items : [];
      if (items.length === 0) break;

      let reachedCursor = false;
      for (const round of items) {
        const at = orderKeyOf(round);
        const ms = at ? Date.parse(at) : null;
        if (ms === null) {
          // Nothing to order it by, so it can never be de-duplicated: leave it out
          // rather than risk counting the same SOL twice.
          logger.debug(`round ${round?.id ?? '?'} has no createdAt; left out of the totals`);
          continue;
        }
        if (cursorMs !== null) {
          if (ms < cursorMs) {
            reachedCursor = true;
            break;
          }
          if (ms === cursorMs && cursorIds.has(round?.id)) continue; // already folded
        }
        if (handled.has(round?.id)) continue; // an open round, counted above
        fresh.push(round);
      }
      if (reachedCursor) break;

      offset += items.length;
      if (offset >= total) break;
      if (page === ROUND_TOTALS_MAX_PAGES - 1) truncated = true;
    }

    // Oldest first, so the cursor only ever moves forward.
    fresh.reverse();
    for (const round of fresh) {
      const kind = foldRound(agg, round);
      const at = orderKeyOf(round);
      if (kind === 'open') {
        agg.open = agg.open.filter((o) => o.id !== round.id);
        agg.open.push({ id: round.id, at });
        if (agg.open.length > ROUND_TOTALS_MAX_OPEN) agg.open = agg.open.slice(-ROUND_TOTALS_MAX_OPEN);
      }
      const ms = Date.parse(at);
      const cursor = agg.cursorAt ? Date.parse(agg.cursorAt) : null;
      if (cursor === null || ms > cursor) {
        agg.cursorAt = at;
        agg.cursorIds = [round.id];
      } else if (ms === cursor && !agg.cursorIds.includes(round.id)) {
        agg.cursorIds.push(round.id);
        if (agg.cursorIds.length > ROUND_TOTALS_MAX_CURSOR_IDS) agg.cursorIds = agg.cursorIds.slice(-ROUND_TOTALS_MAX_CURSOR_IDS);
      }
    }

    return { total, scanned: fresh.length, truncated };
  }

  /**
   * Totals over the published rounds.
   *
   * `totalSolDistributed` is the public headline and counts ONLY real,
   * non-simulated rounds that reached DONE. Simulated (DRY_RUN) activity is
   * reported beside it under `simulated`, clearly separated, and never added in.
   */
  async function roundTotals() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const agg = await loadTotals();
      let count = 0;
      let scanned = 0;
      let truncated = false;
      let ok = true;
      try {
        const reopened = await foldOpenRounds(agg);
        scanned += reopened.folded;
        const walked = await foldNewRounds(agg, reopened.handled);
        count = walked.total;
        scanned += walked.scanned;
        truncated = walked.truncated;
        if (truncated) logger.warn(`round totals stopped after ${ROUND_TOTALS_MAX_PAGES} pages; the aggregate will catch up next call`);
        await saveTotals(agg);
      } catch (err) {
        ok = false;
        logger.warn(`round totals unavailable: ${err?.message || err}`);
      }

      const distributed = BigInt(agg.distributedLamports);
      const simulated = BigInt(agg.simulatedLamports);
      return {
        count: ok ? count : agg.distributedRounds + agg.simulatedRounds + agg.failedRounds + agg.skippedRounds,
        totalSolDistributed: lamportsToSol(distributed),
        totalLamportsDistributed: distributed.toString(),
        distributedRounds: agg.distributedRounds,
        lastAt: agg.lastAt,
        lastDistributedAt: agg.lastDistributedAt,
        // Never merged into the headline: these lamports were never swapped and
        // never sent. They exist so the pre-launch dry runs stay visible.
        simulated: {
          rounds: agg.simulatedRounds,
          totalSol: lamportsToSol(simulated),
          totalLamports: simulated.toString(),
        },
        failedRounds: agg.failedRounds,
        skippedRounds: agg.skippedRounds,
        openRounds: agg.open.length,
        scanned,
        truncated,
      };
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  /** Vault SOL + USD, and the part of it that is actually spendable this round. */
  async function vaultState() {
    const reserveSol = cfg.feeReserveSol;
    const [lamports, solPriceUsd] = await Promise.all([
      holders ? holders.vaultLamports() : null,
      universe ? universe.solPriceUsd() : null,
    ]);
    const balanceSol = lamports === null ? null : lamportsToSol(lamports);
    const poolSol = balanceSol === null ? null : Math.max(0, Math.round((balanceSol - reserveSol) * 1e9) / 1e9);
    return {
      address: cfg.vaultAddress,
      balanceLamports: lamports === null ? null : String(lamports),
      balanceSol,
      balanceUsd: balanceSol !== null && solPriceUsd !== null ? Math.round(balanceSol * solPriceUsd * 100) / 100 : null,
      reserveSol,
      poolSol,
      solPriceUsd,
    };
  }

  /** The /api/stats document. */
  async function get() {
    const [vaultResult, prefsResult, demandResult, roundsResult] = await Promise.allSettled([
      vaultState(),
      db.listPrefs({ limit: 1, offset: 0 }),
      demand(),
      roundTotals(),
    ]);

    const vault = vaultResult.status === 'fulfilled'
      ? vaultResult.value
      : { address: cfg.vaultAddress, balanceLamports: null, balanceSol: null, balanceUsd: null, reserveSol: cfg.feeReserveSol, poolSol: null, solPriceUsd: null };
    const prefHolders = prefsResult.status === 'fulfilled' ? Number(prefsResult.value?.total ?? 0) : 0;
    const dem = demandResult.status === 'fulfilled'
      ? demandResult.value
      : { basis: cfg.launched ? 'holding-weighted' : 'equal-weight', demand: [], contributors: 0, ignored: 0, eligibleHolders: null, snapshotAt: null };
    const rounds = roundsResult.status === 'fulfilled'
      ? roundsResult.value
      : {
          count: 0,
          totalSolDistributed: 0,
          totalLamportsDistributed: '0',
          distributedRounds: 0,
          lastAt: null,
          lastDistributedAt: null,
          simulated: { rounds: 0, totalSol: 0, totalLamports: '0' },
          failedRounds: 0,
          skippedRounds: 0,
          openRounds: 0,
          scanned: 0,
        };

    for (const settled of [vaultResult, prefsResult, demandResult, roundsResult]) {
      if (settled.status === 'rejected') logger.warn(`stats part failed: ${settled.reason?.message || settled.reason}`);
    }

    return {
      mode: cfg.mode,
      launched: cfg.launched,
      // Whether a round pays on the smaller of the two balances it saw this
      // cycle. The front page states the rule from this, so turning it off in
      // the environment cannot leave the site claiming a protection it lost.
      antiCheat: Boolean(cfg.antiCheat),
      openSnapshotWindowMin: cfg.openSnapshotWindowMin ?? null,
      vault: { address: vault.address, balanceSol: vault.balanceSol, balanceUsd: vault.balanceUsd },
      solPriceUsd: vault.solPriceUsd,
      prefHolders,
      eligibleHolders: cfg.launched ? dem.eligibleHolders : null,
      // totalSolDistributed is the hero tile. It counts real, non-simulated
      // rounds that finished, and nothing else. DRY_RUN activity is reported
      // beside it, labelled, so a pre-launch dry run can never read as a payout.
      rounds: {
        count: rounds.count,
        totalSolDistributed: rounds.totalSolDistributed,
        distributedRounds: rounds.distributedRounds,
        lastAt: rounds.lastAt,
        lastDistributedAt: rounds.lastDistributedAt,
        simulated: rounds.simulated,
      },
      demand: dem.demand.map((d) => ({ symbol: d.symbol, mint: d.mint, pct: d.pct })),
      demandBasis: dem.basis,
      demandContributors: dem.contributors,
      snapshotAt: dem.snapshotAt,
      nextRoundAt: cfg.nextRoundAtIso(now()),
      serverTime: new Date(now()).toISOString(),
    };
  }

  return { get, demand, vaultState, roundTotals, snapshotBalances, communityDemand };
}

export default createStatsService;
