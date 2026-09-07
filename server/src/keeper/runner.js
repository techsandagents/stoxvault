/**
 * STOCKDROP keeper / round runner
 *
 * The state machine of CONTRACT.md section 7:
 *
 *   PENDING -> SNAPSHOT -> SWAPPING -> DISTRIBUTING -> DONE
 *                  \-> SKIPPED(no_token | low_pool | no_holders)
 *
 * Two properties matter more than anything else here:
 *
 * 1. RESUMABLE. Every step writes its result to the store before the next step
 *    starts. A process that dies mid-round is restarted, reads the round back,
 *    and continues from exactly where it stopped: swaps already DONE are never
 *    re-quoted or re-sent, transfers already DONE are never re-sent.
 *
 * 2. HONEST. In DRY_RUN nothing is signed and nothing is sent. The quote
 *    endpoint is still called for real — a simulated round is a real routing
 *    decision with real prices, its `receivedRaw` is the quote's `outAmount`,
 *    every `tx` is null, and the round is flagged `simulated: true`. In LIVE the
 *    received amount is the measured on-chain balance delta, never the quote.
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
import { loadVault } from '../chain/vault.js';
import { createRpc } from '../chain/rpc.js';
import { createJupiter } from '../chain/jupiter.js';
import { createDistributor } from '../chain/distributor.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const TERMINAL = Object.freeze(['DONE', 'SKIPPED', 'FAILED']);

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
    logger.info?.(`round ${round.id}: reopening a ${round.status} round at ${back}`);
    round = await db.updateRound(round.id, { status: back, error: null, finishedAt: null });
  }

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

      const plan = buildRoundPlan({
        poolLamports: round.poolLamports,
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
        tx: null,
        // A stock whose share of a small pool floors to zero lamports is not a
        // failure and not a trade; it is recorded as skipped and its holders
        // simply get nothing of it this round.
        status: big(entry.solLamports) > 0n ? 'PENDING' : 'SKIPPED',
        error: null,
      }));

      const carryIn = normalizeCarry(await db.getKV('carry'));

      await save({
        status: 'SWAPPING',
        snapshot,
        universe: universe.stocks,
        universeSource: universe.source,
        universeUpdatedAt: universe.updatedAt,
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
        if (swap.status === 'DONE' || swap.status === 'SKIPPED') continue;
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
        });
        swaps[i] = { ...swap, ...result };
        // Persist after every swap: a crash here must never lose the knowledge
        // that SOL already left the vault.
        await save({ swaps });
      }

      const spent = swaps.reduce((acc, s) => acc + (s.status === 'DONE' ? big(s.solLamports, 0n) : 0n), 0n);
      const carryIn = Array.isArray(round.carryIn) && round.carryIn.length > 0 ? round.carryIn : normalizeCarry(await db.getKV('carry'));
      await save({
        status: 'DISTRIBUTING',
        carryIn,
        stats: { ...round.stats, solSpentLamports: spent.toString() },
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

      // The carry key is the *next* round's starting dust, so only the newest
      // round may write it. Retrying an old round must not hand a later round's
      // dust back to it.
      const latest = await db.latestRound();
      if (!latest || latest.id === round.id) {
        await db.setKV('carry', applied.carryOut);
      } else {
        logger.warn?.(`round ${round.id}: not the latest round (${latest.id}); leaving the carry-over key alone`);
      }

      await save({
        status: 'DONE',
        finishedAt: new Date(now()).toISOString(),
        carryOut: applied.carryOut,
        perStock: applied.perStock,
        simulated,
        stats: {
          ...round.stats,
          transfersDone,
          transfersFailed,
          transfersSkippedDust: skippedDust,
          swapsDone: (round.swaps ?? []).filter((s) => s.status === 'DONE').length,
          swapsFailed: (round.swaps ?? []).filter((s) => s.status === 'FAILED').length,
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
 * Quote (always real), then either simulate the fill or send it.
 * @returns {Promise<{quotedOut: string|null, receivedRaw: string|null, tx: string|null, status: string, error: string|null}>}
 */
async function swapOne({ cfg, rpc, jup, dist, vaultKeypair, live, logger, mint, symbol, lamports, decimals }) {
  const attempts = 3;
  let lastError = null;
  let quotedOut = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const quote = await jup.quote({
        inputMint: SOL_MINT,
        outputMint: mint,
        amount: lamports.toString(),
        slippageBps: cfg.slippageBps,
      });
      quotedOut = String(quote.outAmount);

      if (!live) {
        // DRY_RUN: the route and the price are real, the fill is not.
        return { quotedOut, receivedRaw: quotedOut, tx: null, status: 'DONE', error: null, simulated: true };
      }

      const beforeRaw = await dist.balanceOf(cfg.vaultAddress, mint);
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
      const signature = await rpc.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      const confirmation = await rpc.confirmSignature(signature, {
        lastValidBlockHeight: built.lastValidBlockHeight,
        timeoutMs: 90_000,
      });
      if (confirmation.status !== 'confirmed') {
        throw new RunnerError(`swap ${signature.slice(0, 8)}… ${confirmation.status}`, `swap_${confirmation.status}`);
      }

      // The fill is what the chain says it is.
      const measured = await dist.measureReceived(cfg.vaultAddress, mint, beforeRaw);
      return {
        quotedOut,
        receivedRaw: measured.receivedRaw.toString(),
        tx: signature,
        status: 'DONE',
        error:
          measured.receivedRaw === 0n
            ? 'transaction confirmed but the vault balance did not increase'
            : null,
      };
    } catch (err) {
      lastError = err;
      logger.warn?.(`swap ${symbol || mint} attempt ${attempt}/${attempts} failed: ${err.message}`);
    }
  }

  // Three strikes: the SOL simply stays in the vault and joins the next pool.
  return {
    quotedOut,
    receivedRaw: null,
    tx: null,
    status: 'FAILED',
    error: lastError ? String(lastError.message) : 'swap failed',
  };
}

/** kv 'carry' -> [{mint, amountRaw}] */
function normalizeCarry(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : Array.isArray(value.carry) ? value.carry : [];
  return list
    .filter((e) => e && typeof e.mint === 'string' && e.mint !== '')
    .map((e) => ({ mint: e.mint, amountRaw: String(e.amountRaw ?? e.amount ?? '0') }))
    .filter((e) => /^\d+$/.test(e.amountRaw) && e.amountRaw !== '0');
}

export default runRound;
