/**
 * STOCKDROP — the round ledger, plus a preview of the next one.
 *
 * The ledger is the trust model: every round is published in full, so anyone
 * can re-run the engine against the stored document and get the same numbers.
 * These routes only read it.
 *
 * `/preview` answers "what would happen if a round ran right now" from live
 * data. It is always `simulated: true` — it moves nothing, and before launch it
 * says plainly that there is no token and no holders to pay.
 */

import express from 'express';
import { wrap, parsePaging, requireRoundId, notFound, HttpError } from './router.js';
import { buildRoundPlan, computeEligible } from '../engine/index.js';
import { percentagesFromWeights } from '../services/stats.js';

const LAMPORTS_PER_SOL = 1_000_000_000;

const lamportsToSol = (lamports) => Math.round((Number(lamports) / LAMPORTS_PER_SOL) * 1e9) / 1e9;

/**
 * A snapshot's metadata — what it is and when it was taken — with the
 * per-holder rows removed, so it is safe to repeat in a list response.
 * @returns {object|null} null when there is no such snapshot on the round
 */
export function snapshotSummary(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const { holders, balances, ...rest } = snapshot;
  const holderCount = Array.isArray(holders)
    ? holders.length
    : Number.isFinite(Number(snapshot.holderCount))
      ? Number(snapshot.holderCount)
      : balances && typeof balances === 'object' && !Array.isArray(balances)
        ? Object.keys(balances).length
        : null;
  return {
    ...rest,
    takenAt: typeof snapshot.takenAt === 'string' ? snapshot.takenAt : null,
    hash: typeof snapshot.hash === 'string' ? snapshot.hash : null,
    holderCount,
  };
}

/**
 * The two snapshots a round is judged on: the one taken when the cycle's window
 * opened, and the one taken at the round itself. Rounds written before the
 * anti-cheat rule existed carry only the second, and a round that skipped
 * before snapshotting carries neither — both read as null rather than throwing.
 */
export function snapshotsOf(round) {
  const open = round?.openSnapshot ?? round?.snapshots?.open ?? null;
  const close = round?.closeSnapshot ?? round?.snapshots?.close ?? round?.snapshot ?? null;
  return { open: snapshotSummary(open), close: snapshotSummary(close) };
}

/**
 * Add the ledger's snapshot view to a round document.
 *
 * `snapshotMode` is copied, never inferred: only the keeper knows which rule it
 * actually applied, so an older document that does not say gets null.
 *
 * In a list response the raw snapshot objects are replaced by their summaries,
 * because a per-holder row must never reach a list — that is what the earlier
 * heap fix was for, and a new snapshot field would walk straight back into it.
 */
export function withSnapshots(round, { list = false } = {}) {
  if (!round || typeof round !== 'object') return round;
  const out = { ...round };
  out.snapshots = snapshotsOf(round);
  out.snapshotMode = typeof round.snapshotMode === 'string' ? round.snapshotMode : null;
  if (list) {
    if ('openSnapshot' in out) out.openSnapshot = snapshotSummary(out.openSnapshot);
    if ('closeSnapshot' in out) out.closeSnapshot = snapshotSummary(out.closeSnapshot);
  }
  return out;
}

export function createRoundsRouter({ cfg, db, services }) {
  const router = express.Router();
  const { universe, holders, stats } = services;

  router.get(
    '/',
    wrap(async (req, res) => {
      const { limit, offset } = parsePaging(req.query, { defaultLimit: 50, maxLimit: 200 });
      const page = await db.listRounds({ limit, offset });
      res.json({
        items: (Array.isArray(page.items) ? page.items : []).map((round) => withSnapshots(round, { list: true })),
        total: page.total,
        limit,
        offset,
      });
    }),
  );

  router.get(
    '/preview',
    wrap(async (_req, res) => {
      const [vault, stocks] = await Promise.all([stats.vaultState(), universe.stocks()]);
      const top5 = stocks.slice(0, cfg.defaultBasketSize).map((s) => s.mint);
      const poolLamports = vault.balanceLamports === null
        ? null
        : (() => {
            const balance = BigInt(vault.balanceLamports);
            const reserve = BigInt(cfg.feeReserveLamports);
            return balance > reserve ? balance - reserve : 0n;
          })();
      const poolSol = poolLamports === null ? null : lamportsToSol(poolLamports);

      const base = {
        simulated: true,
        poolSol,
        poolLamports: poolLamports === null ? null : poolLamports.toString(),
        reserveSol: cfg.feeReserveSol,
        minRoundPoolSol: cfg.minRoundPoolSol,
        top5,
        universeUpdatedAt: (await universe.get()).updatedAt,
        nextRoundAt: cfg.nextRoundAtIso(),
        updatedAt: new Date().toISOString(),
      };

      if (!cfg.launched) {
        const community = await stats.demand();
        return res.json({
          ...base,
          basis: 'no-token',
          demandBasis: community.basis,
          demand: community.demand.map((d) => ({ mint: d.mint, symbol: d.symbol, pct: d.pct })),
          demandContributors: community.contributors,
          eligibleHolders: null,
          wouldSkip: 'no_token',
          note:
            'The coin has not launched yet. This is the community\'s saved demand, not a round: with no token there are no holders to snapshot and no drop to make.',
        });
      }

      let snapshot;
      try {
        snapshot = await holders.snapshot();
      } catch (err) {
        throw new HttpError(503, 'preview_unavailable', `holder snapshot failed: ${err?.message || err}`);
      }

      const eligible = computeEligible(snapshot.holders, {
        supplyRaw: snapshot.supply ?? cfg.supplyRaw,
        eligibleBps: cfg.eligibleBps,
        excluded: cfg.excluded,
      });

      const prefsByWallet = new Map((await db.allPrefs()).map((p) => [p.wallet, p]));
      const plan = buildRoundPlan({
        poolLamports: poolLamports ?? 0n,
        reserveLamports: cfg.feeReserveLamports,
        holders: eligible,
        prefsByWallet,
        universe: stocks,
        rules: cfg.rules,
      });

      const pcts = percentagesFromWeights(
        plan.demand.map((d) => ({ mint: d.mint, symbol: d.symbol, weight: BigInt(d.weight) })),
      );
      const pctByMint = new Map(pcts.map((row) => [row.mint, row.pct]));

      let wouldSkip = null;
      if (poolLamports !== null && poolLamports < BigInt(cfg.minRoundPoolLamports)) wouldSkip = 'low_pool';
      if (eligible.length === 0) wouldSkip = 'no_holders';

      res.json({
        ...base,
        basis: 'live-snapshot',
        demandBasis: 'holding-weighted',
        demand: plan.demand.map((d) => ({
          mint: d.mint,
          symbol: d.symbol,
          pct: pctByMint.get(d.mint) ?? 0,
          shareBps: d.shareBps,
          solLamports: d.solLamports,
          solUi: lamportsToSol(d.solLamports),
        })),
        top5: plan.top5.length ? plan.top5 : top5,
        eligibleHolders: plan.stats.eligibleHolders,
        prefHolders: plan.stats.prefHolders,
        defaultHolders: plan.stats.defaultHolders,
        snapshotAt: snapshot.takenAt,
        snapshotSlot: snapshot.slot,
        wouldSkip,
        note:
          wouldSkip === 'low_pool'
            ? `The vault holds less than the ${cfg.minRoundPoolSol} SOL minimum, so the next round would be skipped and the SOL would carry over.`
            : wouldSkip === 'no_holders'
              ? 'No wallet currently clears the eligibility threshold, so the next round would be skipped.'
              : 'Simulated from a live holder snapshot and the vault balance right now. Nothing has moved.',
      });
    }),
  );

  router.get(
    '/:id',
    wrap(async (req, res) => {
      const id = requireRoundId(req.params.id);
      const round = await db.getRound(id);
      if (!round) throw notFound('unknown_round', `no round with id ${id}`);
      res.json(withSnapshots(round));
    }),
  );

  return router;
}

export default createRoundsRouter;
