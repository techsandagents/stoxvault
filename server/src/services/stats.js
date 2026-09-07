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

  /** Totals over every published round. */
  async function roundTotals() {
    let count = 0;
    let totalLamports = 0n;
    let lastAt = null;
    let scanned = 0;
    try {
      const first = await db.listRounds({ limit: 200, offset: 0 });
      count = Number(first?.total ?? 0);
      const pages = [first.items];
      for (let offset = 200; offset < Math.min(count, 2000); offset += 200) {
        const page = await db.listRounds({ limit: 200, offset });
        pages.push(page.items);
      }
      for (const items of pages) {
        for (const round of items) {
          scanned += 1;
          const spent = round?.stats?.solSpentLamports;
          if (typeof spent === 'string' && /^\d+$/.test(spent)) totalLamports += BigInt(spent);
          else if (Array.isArray(round?.demand)) {
            for (const d of round.demand) {
              if (typeof d?.solLamports === 'string' && /^\d+$/.test(d.solLamports)) totalLamports += BigInt(d.solLamports);
            }
          }
          const at = round?.finishedAt || round?.startedAt || round?.createdAt || null;
          if (at && (!lastAt || Date.parse(at) > Date.parse(lastAt))) lastAt = at;
        }
      }
    } catch (err) {
      logger.warn(`round totals unavailable: ${err?.message || err}`);
    }
    return {
      count,
      totalSolDistributed: lamportsToSol(totalLamports),
      totalLamportsDistributed: totalLamports.toString(),
      lastAt,
      scanned,
    };
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
      : { count: 0, totalSolDistributed: 0, totalLamportsDistributed: '0', lastAt: null, scanned: 0 };

    for (const settled of [vaultResult, prefsResult, demandResult, roundsResult]) {
      if (settled.status === 'rejected') logger.warn(`stats part failed: ${settled.reason?.message || settled.reason}`);
    }

    return {
      mode: cfg.mode,
      launched: cfg.launched,
      vault: { address: vault.address, balanceSol: vault.balanceSol, balanceUsd: vault.balanceUsd },
      solPriceUsd: vault.solPriceUsd,
      prefHolders,
      eligibleHolders: cfg.launched ? dem.eligibleHolders : null,
      rounds: { count: rounds.count, totalSolDistributed: rounds.totalSolDistributed, lastAt: rounds.lastAt },
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
