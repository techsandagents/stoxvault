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

export function createRoundsRouter({ cfg, db, services }) {
  const router = express.Router();
  const { universe, holders, stats } = services;

  router.get(
    '/',
    wrap(async (req, res) => {
      const { limit, offset } = parsePaging(req.query, { defaultLimit: 50, maxLimit: 200 });
      const page = await db.listRounds({ limit, offset });
      res.json({ items: page.items, total: page.total, limit, offset });
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
      res.json(round);
    }),
  );

  return router;
}

export default createRoundsRouter;
