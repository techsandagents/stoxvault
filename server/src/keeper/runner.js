/**
 * STOCKDROP keeper / round runner
 *
 * The state machine of CONTRACT.md section 7:
 *
 *   PENDING -> SNAPSHOT -> SWAPPING -> DISTRIBUTING -> DONE
 *                  \-> SKIPPED(no_token | no_vault | low_pool | no_holders | rent_unfunded)
 *
 * Three properties matter more than anything else here:
 *
 * 1. RESUMABLE. Every step writes its result to the store before the next step
 *    starts — a swap writes its intent (signature + pre-send balance) BEFORE the
 *    transaction goes to the cluster, not after it comes back. A process that
 *    dies mid-round is restarted, reads the round back, and continues from
 *    exactly where it stopped: swaps already DONE are never re-quoted or
 *    re-sent, a swap left in SENDING is reconciled against the chain rather than
 *    re-sent, and transfers already DONE are never re-sent.
 *
 * 2. HONEST. In DRY_RUN nothing is signed and nothing is sent. The quote
 *    endpoint is still called for real — a simulated round is a real routing
 *    decision with real prices, its `receivedRaw` is the quote's `outAmount`,
 *    every `tx` is null, and the round is flagged `simulated: true`. In LIVE the
 *    received amount is the measured on-chain balance delta, never the quote.
 *
 * 3. ONE MODE PER ROUND. A round records the mode it was opened in and only a
 *    process in that mode may finish it. A rehearsal is never settled with real
 *    transfers, real swaps are never marked done with tx:null, and the two modes
 *    keep their carry-over dust in different keys.
 *
 * Everything numeric comes from src/engine (pure, bigint). This file does IO and
 * ordering; it does not do arithmetic that could disagree with the published
 * round document.
 */

import { VersionedTransaction } from '@solana/web3.js';
import {
  applySwapResults,
  buildRoundPlan,
  computeEligible,
  rankUniverse,
  snapshotHash,
} from '../engine/index.js';
import { b58encode, loadVault } from '../chain/vault.js';
import { createRpc } from '../chain/rpc.js';
import { createJupiter } from '../chain/jupiter.js';
import { createDistributor } from '../chain/distributor.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const TERMINAL = Object.freeze(['DONE', 'SKIPPED', 'FAILED']);

/**
 * Size of a Token-2022 associated token account: the 165-byte base account plus
 * the ImmutableOwner extension the ATA program always adds (5 bytes).
 */
export const TOKEN_2022_ATA_BYTES = 170;

/**
 * Rent-exempt minimum for that account, used when the RPC cannot be asked.
 * (128 + 170) bytes x 3480 lamports/byte-year x 2 years = 2,074,080 lamports
 * (~0.00207 SOL), the same order as the ~0.00204 SOL SPEC.md section 4 budgets
 * for a 165-byte account. The vault is the payer for every recipient account it
 * has to create, so this is real money and the round has to reserve it.
 */
export const ATA_RENT_LAMPORTS = 2_074_080n;

/** Base signature fee of one transaction. */
export const BASE_TX_FEE_LAMPORTS = 5_000n;

/** Recipients per distribution transaction (mirrors the distributor's default). */
export const TRANSFER_BATCH_SIZE = 8;

/** Swap rows that must never be re-sent by the swap loop. */
const SWAP_UNTOUCHABLE = Object.freeze(['DONE', 'SKIPPED', 'UNRESOLVED']);

export class RunnerError extends Error {
  constructor(message, code = 'runner_error') {
    super(message);
    this.name = 'RunnerError';
    this.code = code;
  }
}

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

function big(value, fallback = 0n) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  return fallback;
}

const pad = (n) => String(n).padStart(2, '0');

/** Round id for a scheduled mark: r_2026-09-07T12 (UTC, hour resolution). */
export function roundIdFor(when) {
  const d = when instanceof Date ? when : new Date(when);
  return `r_${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}`;
}

/** The first free id at or after the base (a manual second run of the same mark gets -2). */
export async function nextRoundId(db, base) {
  if (!(await db.getRound(base))) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!(await db.getRound(candidate))) return candidate;
  }
  throw new RunnerError(`cannot allocate a round id for ${base}`, 'round_id_exhausted');
}

/* ----------------------------------------------------------------- mode */

/**
 * The mode a stored round was created in. A round carries `mode` from the
 * moment it is opened; the `simulated` flag is the fallback for a document
 * written before that field existed. `null` means "unknowable", and only a
 * round that has not started yet is allowed to adopt the current process mode.
 * @param {object} round
 * @returns {'LIVE'|'DRY_RUN'|null}
 */
export function storedRoundMode(round) {
  if (typeof round?.mode === 'string' && round.mode !== '') return round.mode;
  if (round?.simulated === true) return 'DRY_RUN';
  if (round?.simulated === false && typeof round?.status === 'string' && round.status !== 'PENDING') return 'LIVE';
  return null;
}

/**
 * Carry-over dust is per mode. A DRY_RUN round must never read or write the key
 * a LIVE round owns: folding real dust into a fictional allocation and then
 * overwriting the key with quote-derived numbers would make real tokens in the
 * vault invisible forever.
 */
export const carryKeyFor = (simulated) => (simulated ? 'carry:sim' : 'carry');

/* ------------------------------------------------------------------- costs */

/**
 * What this round costs the vault outside the pool itself.
 *
 * The vault is the rent payer for every recipient token account (SPEC.md
 * section 4: the project pays, it is never deducted from a holder's drop), so
 * the pool has to be sized after that money is set aside. The account count is
 * the round's own shape: one account per (holder, stock) pair that could
 * receive something. Accounts that already exist cost nothing, which makes this
 * an upper bound, and an upper bound is the only safe way to size a reserve.
 *
 * @param {{rpc?: object, cfg: object, plan: object, logger?: object}} args
 * @returns {Promise<{accounts: number, perAccountLamports: string, rentLamports: string,
 *   txCount: number, feeLamports: string, totalLamports: string, source: 'rpc'|'constant'}>}
 */
export async function estimateRoundCosts({ rpc, cfg, plan, logger = noopLogger }) {
  const contributors = plan?.contributorsByMint;
  let accounts = 0;
  let batches = 0;
  if (contributors instanceof Map) {
    for (const rows of contributors.values()) {
      const count = Array.isArray(rows) ? rows.length : 0;
      accounts += count;
      batches += Math.ceil(count / TRANSFER_BATCH_SIZE);
    }
  }
  const swapTxs = (Array.isArray(plan?.demand) ? plan.demand : []).filter((d) => big(d.solLamports, 0n) > 0n).length;

  let perAccount = ATA_RENT_LAMPORTS;
  let source = 'constant';
  if (rpc && typeof rpc.call === 'function') {
    try {
      const value = await rpc.call('getMinimumBalanceForRentExemption', [TOKEN_2022_ATA_BYTES]);
      const fromChain = big(value, 0n);
      if (fromChain > 0n) {
        perAccount = fromChain;
        source = 'rpc';
      }
    } catch (err) {
      logger.warn?.(`could not read the rent-exempt minimum from the RPC (${err.message}); using ${ATA_RENT_LAMPORTS} lamports per account`);
    }
  }

  const txCount = swapTxs + batches;
  const perTxFee = BASE_TX_FEE_LAMPORTS + big(cfg?.priorityFeeLamports, 0n);
  const rentLamports = perAccount * BigInt(accounts);
  const feeLamports = perTxFee * BigInt(txCount);

  return {
    accounts,
    perAccountLamports: perAccount.toString(),
    rentLamports: rentLamports.toString(),
    txCount,
    feeLamports: feeLamports.toString(),
    totalLamports: (rentLamports + feeLamports).toString(),
    source,
  };
}

/* ------------------------------------------------------------- service glue */

/** Call the first method a service actually implements. */
async function callFirst(service, names, args) {
  if (!service) return null;
  if (typeof service === 'function') return service(args);
  for (const name of names) {
    if (typeof service[name] === 'function') return service[name](args);
  }
  return null;
}

/**
 * Ask services/universe.js for the ranked universe, falling back to Jupiter
 * directly (which itself falls back to data/xstocks.seed.json).
 * @returns {Promise<{stocks: object[], source: string, updatedAt: string|null}>}
 */
export async function callUniverseService(universeService, { jup, cfg, refresh = true, logger = noopLogger } = {}) {
  let result = null;
  try {
    result = await callFirst(universeService, ['getUniverse', 'refresh', 'load', 'get', 'universe'], { refresh, force: refresh });
  } catch (err) {
    logger.warn?.(`universe service failed (${err.message}); falling back to Jupiter`);
    result = null;
  }

  let stocks = null;
  let source = null;
  let updatedAt = null;
  if (Array.isArray(result)) {
    stocks = result;
    source = 'universe-service';
  } else if (result && typeof result === 'object') {
    stocks = Array.isArray(result.stocks) ? result.stocks : Array.isArray(result.all) ? result.all : null;
    source = result.source || 'universe-service';
    updatedAt = result.updatedAt || null;
  }

  if (!stocks || stocks.length === 0) {
    if (!jup) throw new RunnerError('no universe available: neither a universe service nor a Jupiter client', 'no_universe');
    const found = await jup.searchXStocks({});
    stocks = found.stocks;
    source = found.source;
    updatedAt = found.fetchedAt;
  }

  const size = cfg?.universeSize ?? 20;
  const alreadyRanked = stocks.length <= size && stocks.every((s) => Number.isFinite(s?.rank));
  const ranked = alreadyRanked ? stocks : rankUniverse(stocks, { liqMinUsd: cfg?.liqMinUsd ?? 0, size });
  if (ranked.length === 0) throw new RunnerError('universe is empty after ranking (no liquid xStocks)', 'no_universe');
  return { stocks: ranked, source: source || 'unknown', updatedAt: updatedAt || new Date().toISOString() };
}

/**
 * Ask services/holders.js for the memecoin holder set.
 * @returns {Promise<{holders: {wallet: string, balance: string}[], slot: number|null, supplyRaw: string|null, takenAt: string|null, source: string}>}
 */
export async function callHoldersService(holdersService, { cfg, logger = noopLogger } = {}) {
  if (!holdersService) throw new RunnerError('holder snapshot unavailable: no holders service was provided', 'no_holders_service');
  const args = {
    mint: cfg.tokenMint,
    decimals: cfg.tokenDecimals,
    excluded: cfg.excluded,
    supplyRaw: cfg.supplyRaw,
    minBalanceRaw: cfg.eligibleThresholdRaw,
  };
  const result = await callFirst(holdersService, ['snapshot', 'getSnapshot', 'takeSnapshot', 'getHolders', 'holders', 'list'], args);
  if (!result) throw new RunnerError('holder snapshot unavailable: the holders service returned nothing', 'no_holders_service');

  const holders = Array.isArray(result) ? result : Array.isArray(result.holders) ? result.holders : null;
  if (!holders) throw new RunnerError('holder snapshot unavailable: unexpected response shape', 'bad_holders');

  const normalized = holders
    .map((h) => ({
      wallet: typeof h?.wallet === 'string' ? h.wallet : typeof h?.owner === 'string' ? h.owner : '',
      balance: String(h?.balance ?? h?.amountRaw ?? h?.amount ?? '0'),
    }))
    .filter((h) => h.wallet !== '' && /^\d+$/.test(h.balance));

  if (normalized.length !== holders.length) {
    logger.warn?.(`holders: dropped ${holders.length - normalized.length} unusable entries from the snapshot`);
  }

  return {
    holders: normalized,
    slot: Number.isFinite(result?.slot) ? Number(result.slot) : null,
    supplyRaw: result?.supply != null ? String(result.supply) : result?.supplyRaw != null ? String(result.supplyRaw) : null,
    takenAt: result?.takenAt ? String(result.takenAt) : null,
    source: result?.source ? String(result.source) : 'holders-service',
  };
}

/* ------------------------------------------------------------ reproducibility */

/**
 * Recompute the plan (and, crucially, the per-stock contributor weights) from a
 * stored round document. This is how a resumed round distributes exactly what
 * the published document says it should: the picks frozen at SNAPSHOT time are
 * stored in the round, so nothing that changed since can move a single unit.
 */
export function rebuildPlan(round, cfg) {
  const holders = round?.snapshot?.holders ?? [];
  const frozen = Array.isArray(round?.plan?.holders) ? round.plan.holders : [];
  const prefsByWallet = new Map();
  for (const holder of frozen) {
    if (holder && typeof holder.wallet === 'string' && Array.isArray(holder.picks)) prefsByWallet.set(holder.wallet, holder.picks);
  }
  const plan = buildRoundPlan({
    poolLamports: round.poolLamports ?? '0',
    reserveLamports: round.reserveLamports ?? '0',
    holders,
    prefsByWallet,
    universe: round.universe ?? [],
    rules: cfg.rules,
  });

  // The stored demand is the contract with the public. If a rebuild disagrees
  // with it, something outside this round changed; stop rather than pay out
  // numbers nobody can reproduce from the published document.
  const stored = Array.isArray(round.demand) ? round.demand : [];
  if (stored.length !== plan.demand.length) {
    throw new RunnerError(`round ${round.id}: rebuilt demand has ${plan.demand.length} stocks, stored has ${stored.length}`, 'plan_mismatch');
  }
  const byMint = new Map(plan.demand.map((d) => [d.mint, d]));
  for (const entry of stored) {
    const fresh = byMint.get(entry.mint);
    if (!fresh) throw new RunnerError(`round ${round.id}: rebuilt demand is missing ${entry.mint}`, 'plan_mismatch');
    if (fresh.solLamports !== String(entry.solLamports) || fresh.weight !== String(entry.weight)) {
      throw new RunnerError(`round ${round.id}: rebuilt demand for ${entry.symbol || entry.mint} does not match the stored round`, 'plan_mismatch');
    }
  }
  return plan;
}

/* ------------------------------------------------------------------- runner */

/**
 * Everything the runner needs, from whichever shape the caller has.
 *
 * Tests inject `rpc` / `jup` / `dist` / `holdersService` / `universeService`
 * directly. The API (`POST /api/admin/round/run`) passes `{cfg, db, services}`
 * with the services object from api/router.js; the scheduler passes both. The
 * chain clients are built here when they were not supplied, so no caller has to
 * know how to construct them.
 */
function resolveDeps(deps) {
  const cfg = deps.cfg;
  const logger = deps.logger || noopLogger;
  const services = deps.services ?? deps.deps?.services ?? null;
  const rpc = deps.rpc ?? services?.rpc ?? createRpc(cfg, { logger });
  const jup = deps.jup ?? services?.jupiter ?? services?.jup ?? createJupiter(cfg, { logger });
  const dist = deps.dist ?? deps.distributor ?? createDistributor({ cfg, rpc, logger });
  const holdersService = deps.holdersService ?? services?.holders ?? deps.deps?.holders ?? null;
  const universeService = deps.universeService ?? services?.universe ?? deps.deps?.universe ?? null;
  return { rpc, jup, dist, holdersService, universeService, logger };
}

/**
 * runRound(deps)
 *
 * @param {{
 *   cfg: object, db: object, rpc?: object, jup?: object,
 *   dist?: object, holdersService?: object, universeService?: object, services?: object,
 *   vault?: import('@solana/web3.js').Keypair|null, logger?: object,
 *   roundId?: string, scheduledAt?: Date|string|number, jitterMin?: number,
 *   resume?: boolean, retry?: boolean, now?: () => number
 * }} deps
 * @returns {Promise<object>} the final round document
 */
export async function runRound(deps = {}) {
  const { cfg, db } = deps;
  if (!cfg) throw new RunnerError('runRound: cfg is required', 'bad_argument');
  if (!db) throw new RunnerError('runRound: db is required', 'bad_argument');

  const { rpc, jup, dist, holdersService, universeService, logger } = resolveDeps(deps);
  const now = deps.now || (() => Date.now());
  const live = cfg.mode === 'LIVE';
  const simulated = !live;
  const retry = Boolean(deps.retry);
  const resume = deps.resume !== false;

  const vaultKeypair = deps.vault !== undefined ? deps.vault : live ? loadVault(cfg) : null;
  if (live && !vaultKeypair) throw new RunnerError('LIVE mode needs a vault keypair', 'no_signer');
  if (live && !dist) throw new RunnerError('LIVE mode needs a distributor', 'no_distributor');

  /* ------------------------------------------------- pick up or open a round */

  let round = null;
  if (deps.roundId) {
    round = await db.getRound(String(deps.roundId));
    if (!round) throw new RunnerError(`round ${deps.roundId} not found`, 'round_not_found');
  } else if (resume) {
    round = await db.unfinishedRound();
    if (round) logger.info?.(`resuming round ${round.id} from ${round.status}`);
  }

  // A round carries the mode it was created in, and only a process in that same
  // mode may finish it. Otherwise a restart with LIVE=1 would settle a rehearsal
  // with real transfers sized from quotes nobody executed, and a restart with
  // LIVE=0 would mark real, paid-for swaps DONE with tx:null so the stocks are
  // never sent and --retry says there is nothing to retry.
  if (round) {
    const createdIn = storedRoundMode(round);
    if (createdIn && createdIn !== cfg.mode) {
      const message =
        `round ${round.id} was created in ${createdIn} mode and this process is running in ${cfg.mode} mode; ` +
        `refusing to execute it (a ${createdIn} round must never be finished with ${cfg.mode} sends)`;
      logger.error?.(message);
      const failed = await db.updateRound(round.id, {
        status: 'FAILED',
        resumeFrom: TERMINAL.includes(round.status) ? (round.resumeFrom ?? 'PENDING') : round.status,
        error: message,
        modeMismatch: { roundMode: createdIn, processMode: cfg.mode },
        finishedAt: new Date(now()).toISOString(),
      });
      // An operator who named this round gets the refusal back. Everything else
      // (boot resume, the scheduler) opens a fresh round in the current mode.
      if (retry) return failed;
      round = null;
    }
  }

  if (!round) {
    const scheduledAt = deps.scheduledAt ? new Date(deps.scheduledAt) : new Date(now());
    const id = await nextRoundId(db, roundIdFor(scheduledAt));
    round = await db.createRound({
      id,
      scheduledAt: scheduledAt.toISOString(),
      startedAt: new Date(now()).toISOString(),
      finishedAt: null,
      status: 'PENDING',
      mode: cfg.mode,
      simulated,
      jitterMin: Number.isFinite(deps.jitterMin) ? deps.jitterMin : null,
      skipReason: null,
      poolLamports: '0',
      reserveLamports: String(cfg.feeReserveLamports ?? '0'),
      balanceLamports: '0',
      universe: [],
      universeSource: null,
      top5: [],
      snapshot: null,
      plan: null,
      demand: [],
      swaps: [],
      transfers: [],
      carryIn: [],
      carryOut: [],
      stats: {
        eligibleHolders: 0,
        prefHolders: 0,
        defaultHolders: 0,
        transfersDone: 0,
        transfersFailed: 0,
        solSpentLamports: '0',
      },
      error: null,
    });
    logger.info?.(`round ${round.id} opened (${cfg.mode})`);
  }

  if (TERMINAL.includes(round.status) && !retry && !deps.roundId) return round;
  if ((round.status === 'DONE' || round.status === 'SKIPPED') && !retry) return round;

  // Reopening a finished round (`--retry <id>`).
  //
  // A FAILED round remembers which step it died in (`resumeFrom`), because its
  // status no longer says. A DONE round is reopened only when something in it
  // actually failed — a swap with no route, transfers that never confirmed —
  // and then only at the earliest step that has work left. Steps already
  // completed (SOL already spent, transfers already confirmed) are never redone:
  // the swap loop skips DONE swaps and the transfer loop skips DONE transfers.
  if ((round.status === 'FAILED' || round.status === 'DONE') && (retry || deps.roundId)) {
    let back = null;
    if (round.status === 'FAILED') {
      back = !round.resumeFrom || TERMINAL.includes(round.resumeFrom) ? 'PENDING' : round.resumeFrom;
    } else if (retry) {
      const failedSwap = (round.swaps ?? []).some((s) => s.status === 'FAILED');
      const failedTransfer = (round.transfers ?? []).some((t) => t.status === 'FAILED');
      if (failedSwap) back = 'SWAPPING';
      else if (failedTransfer) back = 'DISTRIBUTING';
      else logger.info?.(`round ${round.id}: nothing to retry`);
    }
    if (!back) return round;
    // Tokens this round bought but could not deliver were handed to the carry
    // key when it finished. If a later round has already taken that carry, the
    // same tokens would be sent twice; the operator has to settle that by hand.
    if (back === 'DISTRIBUTING' && Array.isArray(round.undelivered) && round.undelivered.length > 0) {
      const latest = await db.latestRound();
      if (latest && latest.id !== round.id) {
        logger.warn?.(
          `round ${round.id}: its undelivered tokens already carried over to a later round (${latest.id}); refusing to re-send them`,
        );
        return round;
      }
    }
    logger.info?.(`round ${round.id}: reopening a ${round.status} round at ${back}`);
    round = await db.updateRound(round.id, { status: back, error: null, finishedAt: null });
  }

  const carryKey = carryKeyFor(simulated);

  const save = async (patch) => {
    round = await db.updateRound(round.id, patch);
    return round;
  };

  const skip = async (reason, extra = {}) => {
    logger.info?.(`round ${round.id} skipped: ${reason}`);
    return save({
      ...extra,
      status: 'SKIPPED',
      skipReason: reason,
      simulated,
      finishedAt: new Date(now()).toISOString(),
    });
  };

  try {
    /* ------------------------------------------------------------- PENDING */

    if (round.status === 'PENDING') {
      const reserve = big(cfg.feeReserveLamports, 0n);
      let balance = 0n;
      let balanceError = null;
      if (cfg.vaultAddress) {
        try {
          balance = await rpc.getBalanceLamports(cfg.vaultAddress);
        } catch (err) {
          // A dead RPC must not turn "the coin is not launched" into a crash.
          balanceError = String(err.message);
          if (cfg.tokenMint) throw err;
        }
      }
      const pool = balance > reserve ? balance - reserve : 0n;
      const base = {
        balanceLamports: balance.toString(),
        reserveLamports: reserve.toString(),
        poolLamports: pool.toString(),
        balanceError,
        simulated,
        mode: cfg.mode,
      };

      if (!cfg.tokenMint) return await skip('no_token', base);
      if (!cfg.vaultAddress) return await skip('no_vault', base);
      if (pool < big(cfg.minRoundPoolLamports, 0n)) return await skip('low_pool', base);

      await save({ ...base, status: 'SNAPSHOT' });
    }

    /* ------------------------------------------------------------ SNAPSHOT */

    if (round.status === 'SNAPSHOT') {
      const universe = await callUniverseService(universeService, { jup, cfg, refresh: true, logger });
      const snap = await callHoldersService(holdersService, { cfg, logger });

      let supplyRaw = snap.supplyRaw;
      if (!supplyRaw) {
        try {
          supplyRaw = (await rpc.getTokenSupply(cfg.tokenMint)).amountRaw.toString();
        } catch (err) {
          logger.warn?.(`could not read token supply on chain (${err.message}); using the configured supply`);
          supplyRaw = String(cfg.supplyRaw);
        }
      }

      const eligible = computeEligible(snap.holders, {
        supplyRaw,
        eligibleBps: cfg.eligibleBps,
        excluded: cfg.excluded,
      });

      const snapshot = {
        takenAt: snap.takenAt || new Date(now()).toISOString(),
        slot: snap.slot,
        tokenMint: cfg.tokenMint,
        supply: String(supplyRaw),
        eligibleThreshold: ((big(supplyRaw) * BigInt(cfg.eligibleBps ?? 0)) / 10000n).toString(),
        holders: eligible,
        excluded: cfg.excluded ?? [],
        source: snap.source,
        totalHolders: snap.holders.length,
      };
      snapshot.hash = snapshotHash(snapshot);

      if (eligible.length === 0) {
        return await skip('no_holders', {
          snapshot,
          universe: universe.stocks,
          universeSource: universe.source,
        });
      }

      // Prefs are frozen here: anything a holder changes after this moment
      // applies to the next round, never to this one.
      const prefsList = await db.allPrefs();
      const prefsByWallet = new Map();
      for (const prefs of Array.isArray(prefsList) ? prefsList : []) {
        if (prefs && typeof prefs.wallet === 'string' && Array.isArray(prefs.picks)) prefsByWallet.set(prefs.wallet, prefs.picks);
      }

      // Two passes. The first learns the shape of the round — which holders want
      // which stocks — because that, and only that, says how many token accounts
      // the vault may have to open and pay rent for. The pool is then sized after
      // that money is set aside, and the split is redone against what is really
      // spendable. The contributor set does not depend on the pool, so the second
      // pass moves the lamports and nothing else.
      const shape = buildRoundPlan({
        poolLamports: round.poolLamports,
        reserveLamports: round.reserveLamports,
        holders: eligible,
        prefsByWallet,
        universe: universe.stocks,
        rules: cfg.rules,
      });

      const costs = await estimateRoundCosts({ rpc, cfg, plan: shape, logger });
      const grossPool = big(round.poolLamports, 0n);
      const roundCost = big(costs.totalLamports, 0n);
      const netPool = grossPool > roundCost ? grossPool - roundCost : 0n;
      const rentEstimate = {
        ...costs,
        grossPoolLamports: grossPool.toString(),
        netPoolLamports: netPool.toString(),
      };

      if (netPool < big(cfg.minRoundPoolLamports, 0n)) {
        // The pool cleared the minimum before rent and fees and does not clear it
        // after. Half-paying a round — buying stocks and then running out of SOL
        // partway through the transfers — is worse than not running it.
        return await skip('rent_unfunded', {
          snapshot,
          universe: universe.stocks,
          universeSource: universe.source,
          rentEstimate,
          poolLamports: netPool.toString(),
          reserveLamports: (big(cfg.feeReserveLamports, 0n) + roundCost).toString(),
        });
      }

      const plan =
        netPool === grossPool
          ? shape
          : buildRoundPlan({
              poolLamports: netPool.toString(),
              reserveLamports: round.reserveLamports,
              holders: eligible,
              prefsByWallet,
              universe: universe.stocks,
              rules: cfg.rules,
            });

      const swaps = plan.demand.map((entry) => ({
        mint: entry.mint,
        symbol: entry.symbol,
        solLamports: entry.solLamports,
        quotedOut: null,
        receivedRaw: null,
        beforeRaw: null,
        tx: null,
        // A stock whose share of a small pool floors to zero lamports is not a
        // failure and not a trade; it is recorded as skipped and its holders
        // simply get nothing of it this round.
        status: big(entry.solLamports) > 0n ? 'PENDING' : 'SKIPPED',
        error: null,
      }));

      const carryIn = normalizeCarry(await db.getKV(carryKey));

      await save({
        status: 'SWAPPING',
        snapshot,
        universe: universe.stocks,
        universeSource: universe.source,
        universeUpdatedAt: universe.updatedAt,
        poolLamports: netPool.toString(),
        reserveLamports: (big(cfg.feeReserveLamports, 0n) + roundCost).toString(),
        rentEstimate,
        top5: plan.top5,
        demand: plan.demand,
        plan: {
          totalWeight: plan.totalWeight,
          spentLamports: plan.spentLamports,
          remainderLamports: plan.remainderLamports,
          holders: plan.holders,
        },
        swaps,
        carryIn,
        stats: {
          ...round.stats,
          eligibleHolders: plan.stats.eligibleHolders,
          prefHolders: plan.stats.prefHolders,
          defaultHolders: plan.stats.defaultHolders,
          adjustedHolders: plan.stats.adjustedHolders,
          stocks: plan.stats.stocks,
        },
      });
      logger.info?.(
        `round ${round.id}: ${plan.stats.eligibleHolders} eligible holders, ${plan.demand.length} stocks, pool ${round.poolLamports} lamports`,
      );
    }

    /* ------------------------------------------------------------ SWAPPING */

    if (round.status === 'SWAPPING') {
      const decimalsByMint = new Map((round.universe ?? []).map((s) => [s.mint, Number(s.decimals ?? 8)]));
      const swaps = (round.swaps ?? []).map((s) => ({ ...s }));

      for (let i = 0; i < swaps.length; i++) {
        const swap = swaps[i];
        if (SWAP_UNTOUCHABLE.includes(swap.status)) {
          if (swap.status === 'UNRESOLVED') {
            logger.warn?.(
              `round ${round.id}: swap ${swap.symbol || swap.mint} is UNRESOLVED (${swap.tx ?? 'no signature'}); leaving it for an operator rather than risking a second send`,
            );
          }
          continue;
        }
        if (swap.status === 'FAILED' && !retry) continue;

        const lamports = big(swap.solLamports, 0n);
        if (lamports <= 0n) {
          swaps[i] = { ...swap, status: 'SKIPPED', error: null };
          await save({ swaps });
          continue;
        }

        const result = await swapOne({
          cfg,
          rpc,
          jup,
          dist,
          vaultKeypair,
          live,
          logger,
          mint: swap.mint,
          symbol: swap.symbol,
          lamports,
          decimals: decimalsByMint.get(swap.mint) ?? 8,
          // A row left in SENDING is a swap that was signed and handed to the
          // cluster and whose fate we never learned. It is reconciled, never
          // re-sent blind.
          prior:
            swap.status === 'SENDING'
              ? { signature: swap.tx ?? null, beforeRaw: swap.beforeRaw ?? null, quotedOut: swap.quotedOut ?? null }
              : null,
          // The intent record: the signature and the pre-send balance reach the
          // store BEFORE the transaction reaches the cluster, so a SIGKILL
          // between the two leaves evidence instead of a mystery.
          onIntent: async (patch) => {
            swaps[i] = { ...swaps[i], ...patch };
            await save({ swaps });
          },
        });
        swaps[i] = { ...swaps[i], ...result };
        // Persist after every swap: a crash here must never lose the knowledge
        // that SOL already left the vault.
        await save({ swaps });
      }

      const spent = swaps.reduce((acc, s) => acc + (s.status === 'DONE' ? big(s.solLamports, 0n) : 0n), 0n);
      const unresolved = swaps.reduce((acc, s) => acc + (s.status === 'UNRESOLVED' ? big(s.solLamports, 0n) : 0n), 0n);
      const carryIn =
        Array.isArray(round.carryIn) && round.carryIn.length > 0 ? round.carryIn : normalizeCarry(await db.getKV(carryKey));
      await save({
        status: 'DISTRIBUTING',
        carryIn,
        stats: {
          ...round.stats,
          solSpentLamports: spent.toString(),
          solUnresolvedLamports: unresolved.toString(),
        },
      });
    }

    /* -------------------------------------------------------- DISTRIBUTING */

    if (round.status === 'DISTRIBUTING') {
      const plan = rebuildPlan(round, cfg);
      const applied = applySwapResults(plan, round.swaps ?? [], round.carryIn ?? []);

      const existing = new Map((round.transfers ?? []).map((t) => [`${t.wallet} ${t.mint}`, t]));
      const patch = [];
      for (const transfer of applied.transfers) {
        const key = `${transfer.wallet} ${transfer.mint}`;
        const current = existing.get(key);
        if (!current) {
          patch.push(transfer);
          continue;
        }
        if (current.amountRaw !== transfer.amountRaw) {
          logger.warn?.(
            `round ${round.id}: recomputed amount for ${transfer.wallet} / ${transfer.symbol} differs from the stored row; keeping the stored one`,
          );
        }
        // Only an explicit --retry reopens a FAILED transfer.
        if (retry && current.status === 'FAILED') patch.push({ ...transfer, status: 'PENDING', error: null });
      }
      if (patch.length > 0) await save({ transfers: patch });

      const pending = (round.transfers ?? []).filter((t) => t.status === 'PENDING');
      if (pending.length > 0) {
        const decimalsByMint = new Map((round.universe ?? []).map((s) => [s.mint, Number(s.decimals ?? 8)]));
        const byMint = new Map();
        for (const transfer of pending) {
          if (!byMint.has(transfer.mint)) byMint.set(transfer.mint, []);
          byMint.get(transfer.mint).push(transfer);
        }

        for (const [mint, rows] of byMint) {
          if (!live) {
            // Simulated: the ledger records what would have been sent, with no
            // transaction, and the round stays flagged simulated.
            for (const row of rows) {
              await db.markTransfer(round.id, row.wallet, mint, { status: 'DONE', tx: null, error: null });
            }
            continue;
          }

          const results = await dist.ensureAndTransfer(
            vaultKeypair,
            mint,
            decimalsByMint.get(mint) ?? 8,
            rows.map((r) => ({ wallet: r.wallet, amountRaw: r.amountRaw })),
            {
              batchSize: 8,
              priorityFeeLamports: cfg.priorityFeeLamports,
              onBatch: async (batchResults) => {
                for (const result of batchResults) {
                  await db.markTransfer(round.id, result.wallet, mint, {
                    status: result.status,
                    tx: result.tx ?? null,
                    error: result.error ?? null,
                  });
                }
              },
            },
          );
          // onBatch already persisted each batch; this catches anything the
          // distributor decided outside a batch (bad address, dust, self-send).
          for (const result of results) {
            await db.markTransfer(round.id, result.wallet, mint, {
              status: result.status,
              tx: result.tx ?? null,
              error: result.error ?? null,
            });
          }
        }
        round = await db.getRound(round.id);
      }

      const transfers = round.transfers ?? [];
      const transfersDone = transfers.filter((t) => t.status === 'DONE').length;
      const transfersFailed = transfers.filter((t) => t.status === 'FAILED').length;
      const skippedDust = transfers.filter((t) => t.status === 'SKIPPED_DUST').length;

      // Stock that was bought but not delivered is still sitting in the vault.
      // It is not the holder's loss and it is not a rounding remainder: it goes
      // back into the carry so the next round hands it out, instead of being
      // stranded outside every number the ledger publishes.
      const undelivered = undeliveredByMint(transfers);
      const carryOut = mergeCarry(applied.carryOut, undelivered);

      // The carry key is the *next* round's starting dust, so only the newest
      // round may write it. Retrying an old round must not hand a later round's
      // dust back to it.
      const latest = await db.latestRound();
      if (!latest || latest.id === round.id) {
        await db.setKV(carryKey, carryOut);
      } else {
        logger.warn?.(`round ${round.id}: not the latest round (${latest.id}); leaving the ${carryKey} key alone`);
      }

      await save({
        status: 'DONE',
        finishedAt: new Date(now()).toISOString(),
        carryOut,
        undelivered,
        perStock: applied.perStock,
        simulated,
        mode: cfg.mode,
        stats: {
          ...round.stats,
          transfersDone,
          transfersFailed,
          transfersSkippedDust: skippedDust,
          swapsDone: (round.swaps ?? []).filter((s) => s.status === 'DONE').length,
          swapsFailed: (round.swaps ?? []).filter((s) => s.status === 'FAILED').length,
          swapsUnresolved: (round.swaps ?? []).filter((s) => s.status === 'UNRESOLVED').length,
        },
      });
      logger.info?.(
        `round ${round.id} done: ${transfersDone} transfers${transfersFailed ? `, ${transfersFailed} failed` : ''}${simulated ? ' (simulated)' : ''}`,
      );
    }

    return round;
  } catch (err) {
    logger.error?.(`round ${round.id} failed: ${err.message}`);
    try {
      return await save({
        status: 'FAILED',
        // Where to pick this round up again (`--retry <id>`): the step it died in.
        resumeFrom: TERMINAL.includes(round.status) ? (round.resumeFrom ?? 'PENDING') : round.status,
        error: String(err.message),
        finishedAt: new Date(now()).toISOString(),
      });
    } catch (saveErr) {
      logger.error?.(`round ${round.id}: could not record the failure: ${saveErr.message}`);
      throw err;
    }
  }
}

/* --------------------------------------------------------------- one swap */

/**
 * What happened to the swap signatures we have already put on the wire?
 *
 * Two independent sources, exactly as chain/distributor.js does it for
 * transfers: the cluster's own view of the signature (with
 * searchTransactionHistory, so a confirmed transaction is found even after the
 * blockhash window), and the vault's balance of the output mint compared with
 * the reading taken before the FIRST attempt.
 *
 * @returns {Promise<{state:'landed', signature: string, receivedRaw: bigint}
 *   | {state:'dead'} | {state:'unknown', reason: string}>}
 *   landed = tokens are in the vault; dead = nothing sent can ever land, so a
 *   fresh attempt is safe; unknown = we do not know, so nothing may be re-sent.
 */
async function reconcileSwap({ rpc, dist, cfg, mint, symbol, sent, beforeRaw, logger = noopLogger }) {
  let statusesRead = false;
  if (!sent.some((s) => s.verdict === 'landed') && typeof rpc?.getSignatureStatuses === 'function') {
    try {
      const statuses = await rpc.getSignatureStatuses(
        sent.map((s) => s.signature),
        { searchTransactionHistory: true },
      );
      statusesRead = true;
      for (let i = 0; i < sent.length; i++) {
        const status = Array.isArray(statuses) ? statuses[i] : null;
        if (!status) continue; // unknown to the cluster: keep whatever we already knew
        if (status.err) {
          // It landed and failed: no SOL was swapped, so this attempt is dead.
          sent[i].verdict = 'dead';
          continue;
        }
        const level = status.confirmationStatus || (status.confirmations === null ? 'finalized' : 'processed');
        sent[i].verdict = level === 'confirmed' || level === 'finalized' ? 'landed' : 'unknown';
      }
    } catch (err) {
      logger.warn?.(`swap ${symbol || mint}: could not read signature statuses (${err.message}); falling back to the vault balance`);
    }
  }

  // The vault's own balance is the check that does not depend on any signature.
  let measured = null;
  if (beforeRaw !== null && beforeRaw !== undefined && typeof dist?.measureReceived === 'function') {
    try {
      measured = await dist.measureReceived(cfg.vaultAddress, mint, beforeRaw);
    } catch (err) {
      logger.warn?.(`swap ${symbol || mint}: could not read the vault balance (${err.message})`);
      measured = null;
    }
  }

  const landed = sent.find((s) => s.verdict === 'landed');
  if (landed && measured) return { state: 'landed', signature: landed.signature, receivedRaw: measured.receivedRaw };
  if (measured && measured.receivedRaw > 0n) {
    // Tokens arrived. Whichever attempt delivered them, this swap is done and a
    // second one would spend the allocation twice.
    return { state: 'landed', signature: (landed ?? sent[sent.length - 1]).signature, receivedRaw: measured.receivedRaw };
  }
  if (landed) return { state: 'unknown', reason: `${landed.signature} confirmed but the fill could not be measured` };
  if (sent.every((s) => s.verdict === 'dead')) return { state: 'dead' };
  return {
    state: 'unknown',
    reason: `the fate of ${sent[sent.length - 1].signature} is unknown${statusesRead ? '' : ' (the cluster could not be asked)'}`,
  };
}

/**
 * Quote (always real), then either simulate the fill or send it.
 *
 * The LIVE path never sends twice for one allocation. Before every attempt
 * after the first, and before touching a row a crash left in SENDING, it
 * establishes what the previous signature did: adopt it if it landed, retry
 * only when the previous attempt provably cannot land, and otherwise stop with
 * UNRESOLVED so a person settles it. `receivedRaw` is always measured against
 * the balance taken before attempt ONE, so a fill from any attempt is counted
 * rather than stranded.
 *
 * @returns {Promise<{quotedOut: string|null, receivedRaw: string|null, beforeRaw: string|null,
 *   tx: string|null, status: 'DONE'|'FAILED'|'UNRESOLVED', error: string|null}>}
 */
async function swapOne({ cfg, rpc, jup, dist, vaultKeypair, live, logger = noopLogger, mint, symbol, lamports, decimals, prior = null, onIntent = null }) {
  const attempts = 3;
  const label = symbol || mint;
  let lastError = null;
  // A resumed row keeps the quote it was sent with: adopting a landed swap must
  // not blank the number the ledger already published.
  let quotedOut = typeof prior?.quotedOut === 'string' ? prior.quotedOut : null;

  const askQuote = () =>
    jup.quote({
      inputMint: SOL_MINT,
      outputMint: mint,
      amount: lamports.toString(),
      slippageBps: cfg.slippageBps,
    });

  if (!live) {
    // DRY_RUN: the route and the price are real, the fill is not, and nothing
    // is signed, sent or reconciled.
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const quote = await askQuote();
        quotedOut = String(quote.outAmount);
        return { quotedOut, receivedRaw: quotedOut, beforeRaw: null, tx: null, status: 'DONE', error: null, simulated: true };
      } catch (err) {
        lastError = err;
        logger.warn?.(`swap ${label} attempt ${attempt}/${attempts} failed: ${err.message}`);
      }
    }
    return {
      quotedOut,
      receivedRaw: null,
      beforeRaw: null,
      tx: null,
      status: 'FAILED',
      error: lastError ? String(lastError.message) : 'swap failed',
    };
  }

  /** Every signature this allocation has ever put on the wire. */
  const sent = [];
  /** The vault's balance of `mint` before attempt ONE. */
  let beforeRaw = null;

  if (prior && typeof prior.beforeRaw === 'string' && /^\d+$/.test(prior.beforeRaw)) beforeRaw = BigInt(prior.beforeRaw);
  if (prior && typeof prior.signature === 'string' && prior.signature !== '') sent.push({ signature: prior.signature, verdict: 'unknown' });

  const finish = (patch) => ({ quotedOut, beforeRaw: beforeRaw === null ? null : beforeRaw.toString(), ...patch });

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (sent.length > 0) {
      const verdict = await reconcileSwap({ rpc, dist, cfg, mint, symbol, sent, beforeRaw, logger });
      if (verdict.state === 'landed') {
        logger.info?.(`swap ${label}: adopting ${verdict.signature} (it landed); not sending again`);
        return finish({
          receivedRaw: verdict.receivedRaw.toString(),
          tx: verdict.signature,
          status: 'DONE',
          error: verdict.receivedRaw === 0n ? 'transaction confirmed but the vault balance did not increase' : null,
        });
      }
      if (verdict.state === 'unknown') {
        logger.error?.(`swap ${label}: ${verdict.reason}; recording it UNRESOLVED instead of risking a double spend`);
        return finish({
          receivedRaw: null,
          tx: sent[sent.length - 1].signature,
          status: 'UNRESOLVED',
          error: `${verdict.reason}. An operator must settle this swap before the SOL is spent again.`,
        });
      }
    }

    let record = null;
    try {
      const quote = await askQuote();
      quotedOut = String(quote.outAmount);

      // Read once, before the first send. Every later measurement is against
      // this number, so tokens from an attempt we lost sight of still count.
      if (beforeRaw === null) beforeRaw = await dist.balanceOf(cfg.vaultAddress, mint);

      const built = await jup.buildSwapTx({
        quoteResponse: quote,
        userPublicKey: cfg.vaultAddress,
        prioritizationFeeLamports: cfg.priorityFeeLamports,
      });
      if (built.simulationError) {
        throw new RunnerError(`swap simulation failed: ${JSON.stringify(built.simulationError)}`, 'swap_simulation_failed');
      }

      const tx = VersionedTransaction.deserialize(Buffer.from(built.swapTransaction, 'base64'));
      tx.sign([vaultKeypair]);

      // The signature exists the moment the vault signs, so the intent can be
      // written down before the transaction is handed over. A crash between the
      // two now leaves a SENDING row that says exactly what to reconcile.
      record = { signature: b58encode(tx.signatures[0]), verdict: 'unknown' };
      sent.push(record);
      if (onIntent) {
        await onIntent({
          status: 'SENDING',
          tx: record.signature,
          beforeRaw: beforeRaw.toString(),
          quotedOut,
          attempt,
          error: null,
        });
      }

      const returned = await rpc.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      if (typeof returned === 'string' && returned !== '' && returned !== record.signature) {
        record.signature = returned;
        if (onIntent) await onIntent({ tx: returned });
      }

      const confirmation = await rpc.confirmSignature(record.signature, {
        lastValidBlockHeight: built.lastValidBlockHeight,
        timeoutMs: 90_000,
      });
      if (confirmation.status !== 'confirmed') {
        // failed = it landed and errored, expired = its blockhash is past: both
        // mean this transaction can never move SOL, so another attempt is safe.
        // A timeout means nothing of the sort.
        record.verdict = confirmation.status === 'failed' || confirmation.status === 'expired' ? 'dead' : 'unknown';
        throw new RunnerError(`swap ${record.signature.slice(0, 8)}… ${confirmation.status}`, `swap_${confirmation.status}`);
      }
      record.verdict = 'landed';

      // The fill is what the chain says it is, measured from before attempt one.
      const measured = await dist.measureReceived(cfg.vaultAddress, mint, beforeRaw);
      return finish({
        receivedRaw: measured.receivedRaw.toString(),
        tx: record.signature,
        status: 'DONE',
        error: measured.receivedRaw === 0n ? 'transaction confirmed but the vault balance did not increase' : null,
      });
    } catch (err) {
      lastError = err;
      logger.warn?.(`swap ${label} attempt ${attempt}/${attempts} failed: ${err.message}`);
    }
  }

  // Out of attempts. If anything was ever sent, settle it before calling this a
  // no-op: SOL may already have left the vault.
  if (sent.length > 0) {
    const verdict = await reconcileSwap({ rpc, dist, cfg, mint, symbol, sent, beforeRaw, logger });
    if (verdict.state === 'landed') {
      return finish({
        receivedRaw: verdict.receivedRaw.toString(),
        tx: verdict.signature,
        status: 'DONE',
        error: verdict.receivedRaw === 0n ? 'transaction confirmed but the vault balance did not increase' : null,
      });
    }
    if (verdict.state === 'unknown') {
      return finish({
        receivedRaw: null,
        tx: sent[sent.length - 1].signature,
        status: 'UNRESOLVED',
        error: `${verdict.reason}. An operator must settle this swap before the SOL is spent again.`,
      });
    }
  }

  // Three strikes and nothing landed: the SOL simply stays in the vault and
  // joins the next pool.
  return finish({
    receivedRaw: null,
    tx: null,
    status: 'FAILED',
    error: lastError ? String(lastError.message) : 'swap failed',
  });
}

/** kv carry key -> [{mint, amountRaw}] */
function normalizeCarry(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : Array.isArray(value.carry) ? value.carry : [];
  return list
    .filter((e) => e && typeof e.mint === 'string' && e.mint !== '')
    .map((e) => ({ mint: e.mint, amountRaw: String(e.amountRaw ?? e.amount ?? '0') }))
    .filter((e) => /^\d+$/.test(e.amountRaw) && e.amountRaw !== '0');
}

/**
 * Tokens this round bought and did not manage to deliver, per mint. A transfer
 * that is not DONE and not dust is stock still sitting in the vault.
 * @param {{mint: string, amountRaw: string, status: string}[]} transfers
 * @returns {{mint: string, amountRaw: string}[]}
 */
export function undeliveredByMint(transfers) {
  const byMint = new Map();
  for (const transfer of Array.isArray(transfers) ? transfers : []) {
    if (!transfer || typeof transfer.mint !== 'string' || transfer.mint === '') continue;
    if (transfer.status === 'DONE' || transfer.status === 'SKIPPED_DUST') continue;
    const amount = big(transfer.amountRaw, 0n);
    if (amount <= 0n) continue;
    byMint.set(transfer.mint, (byMint.get(transfer.mint) ?? 0n) + amount);
  }
  return [...byMint.entries()]
    .map(([mint, amountRaw]) => ({ mint, amountRaw: amountRaw.toString() }))
    .sort((a, b) => (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
}

/** Sum carry lists per mint (dust + undelivered), sorted by mint. */
export function mergeCarry(...lists) {
  const byMint = new Map();
  for (const list of lists) {
    for (const entry of normalizeCarry(list)) {
      byMint.set(entry.mint, (byMint.get(entry.mint) ?? 0n) + BigInt(entry.amountRaw));
    }
  }
  return [...byMint.entries()]
    .filter(([, amount]) => amount > 0n)
    .map(([mint, amount]) => ({ mint, amountRaw: amount.toString() }))
    .sort((a, b) => (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
}

export default runRound;
