/**
 * STOCKDROP — public reads.
 *
 * Everything a browser can see without connecting a wallet: health, config, the
 * ranked universe, price history, aggregate stats, the vault, and the public
 * (deliberately public — it is what makes off-chain preferences auditable)
 * preference list.
 */

import express from 'express';
import { fail, wrap, requireWallet, requireSymbol, parsePaging, notFound, badRequest } from './router.js';
import { normalizeRange } from '../services/history.js';

const CARRY_KV_KEY = 'carry';

/** base units -> ui number, without floating point surprises for small dust. */
function toUi(amountRaw, decimals) {
  const raw = typeof amountRaw === 'string' ? amountRaw : String(amountRaw ?? '0');
  if (!/^\d+$/.test(raw)) return null;
  const d = Number.isInteger(decimals) && decimals >= 0 ? decimals : 8;
  const padded = raw.padStart(d + 1, '0');
  const whole = padded.slice(0, padded.length - d);
  const frac = d > 0 ? padded.slice(padded.length - d) : '';
  return Number(`${whole}${frac ? `.${frac}` : ''}`);
}

/** kv 'carry' can be [{mint, amountRaw}] or {mint: amountRaw}; accept both. */
function carryRows(carry) {
  if (Array.isArray(carry)) {
    return carry
      .filter((row) => row && typeof row.mint === 'string')
      .map((row) => ({ mint: row.mint, amountRaw: String(row.amountRaw ?? row.amount ?? '0') }));
  }
  if (carry && typeof carry === 'object') {
    return Object.entries(carry).map(([mint, value]) => ({
      mint,
      amountRaw: String(value && typeof value === 'object' ? value.amountRaw ?? value.amount ?? '0' : value ?? '0'),
    }));
  }
  return [];
}

export function createPublicRouter({ cfg, db, services }) {
  const router = express.Router();
  const { universe, history, stats } = services;

  router.get(
    '/health',
    wrap(async (_req, res) => {
      res.json({
        ok: true,
        mode: cfg.mode,
        vault: cfg.vaultAddress,
        tokenMint: cfg.tokenMint || null,
        nextRoundAt: cfg.nextRoundAtIso(),
        serverTime: new Date().toISOString(),
        version: cfg.version,
      });
    }),
  );

  router.get(
    '/config',
    wrap(async (_req, res) => {
      res.json({
        token: {
          name: cfg.tokenName || null,
          symbol: cfg.tokenSymbol || null,
          mint: cfg.tokenMint || null,
          supply: cfg.tokenSupplyUi,
          supplyRaw: cfg.supplyRaw,
          decimals: cfg.tokenDecimals,
          launched: cfg.launched,
        },
        vault: { address: cfg.vaultAddress },
        rules: {
          ...cfg.rules,
          eligibleThresholdRaw: cfg.eligibleThresholdRaw,
          eligibleThresholdUi: cfg.eligibleThresholdUi,
          minRoundPoolSol: cfg.minRoundPoolSol,
          feeReserveSol: cfg.feeReserveSol,
          slippageBps: cfg.slippageBps,
          liqMinUsd: cfg.liqMinUsd,
          jitterMin: cfg.roundJitterMin,
        },
        mode: cfg.mode,
        intervalHours: cfg.intervalHours,
        nextRoundAt: cfg.nextRoundAtIso(),
        excluded: cfg.excluded,
      });
    }),
  );

  router.get(
    '/universe',
    wrap(async (_req, res) => {
      const doc = await universe.get();
      res.json({
        updatedAt: doc.updatedAt,
        source: doc.source,
        stale: doc.stale,
        count: doc.stocks.length,
        liqMinUsd: doc.liqMinUsd,
        universeSize: cfg.universeSize,
        stocks: doc.stocks,
        all: doc.all,
      });
    }),
  );

  router.get(
    '/universe/:symbol/history',
    wrap(async (req, res) => {
      const symbol = requireSymbol(req.params.symbol);
      const rangeParam = Array.isArray(req.query.range) ? req.query.range[0] : req.query.range;
      const range = normalizeRange(rangeParam);
      if (!range) throw badRequest('bad_range', 'range must be one of 1mo, 3mo, 1y');

      const stock = await universe.find(symbol);
      if (!stock) throw notFound('unknown_symbol', `no xStock called ${symbol}`);

      try {
        const doc = await history.get(stock, range);
        res.json(doc);
      } catch (err) {
        if (err?.code === 'history_unavailable') {
          return fail(res, 502, 'history_unavailable', 'no price history source answered; try again shortly');
        }
        throw err;
      }
    }),
  );

  router.get(
    '/stats',
    wrap(async (_req, res) => {
      res.json(await stats.get());
    }),
  );

  router.get(
    '/vault',
    wrap(async (_req, res) => {
      const [state, carry, ranked] = await Promise.all([
        stats.vaultState(),
        db.getKV(CARRY_KV_KEY).catch(() => null),
        universe.get().catch(() => null),
      ]);

      const byMint = new Map();
      for (const stock of ranked?.all || []) byMint.set(stock.mint, stock);

      const holdings = carryRows(carry)
        .filter((row) => /^\d+$/.test(row.amountRaw) && row.amountRaw !== '0')
        .map((row) => {
          const stock = byMint.get(row.mint);
          const decimals = Number.isInteger(stock?.decimals) ? stock.decimals : 8;
          return {
            symbol: stock?.symbol ?? null,
            mint: row.mint,
            amountRaw: row.amountRaw,
            amountUi: toUi(row.amountRaw, decimals),
            decimals,
          };
        });

      res.json({
        address: state.address,
        balanceSol: state.balanceSol,
        balanceUsd: state.balanceUsd,
        balanceLamports: state.balanceLamports,
        reserveSol: state.reserveSol,
        poolSol: state.poolSol,
        minRoundPoolSol: cfg.minRoundPoolSol,
        solPriceUsd: state.solPriceUsd,
        holdings,
        updatedAt: new Date().toISOString(),
      });
    }),
  );

  router.get(
    '/prefs/:wallet',
    wrap(async (req, res) => {
      const wallet = requireWallet(req.params.wallet);
      const prefs = await db.getPrefs(wallet);
      if (!prefs) return res.json({ wallet, picks: null, default: true });
      return res.json(prefs);
    }),
  );

  router.get(
    '/holders',
    wrap(async (req, res) => {
      const { limit, offset } = parsePaging(req.query, { defaultLimit: 100, maxLimit: 500 });
      const page = await db.listPrefs({ limit, offset });
      res.json({
        items: page.items.map((p) => ({ wallet: p.wallet, picks: p.picks, updatedAt: p.updatedAt })),
        total: page.total,
        limit,
        offset,
      });
    }),
  );

  return router;
}

export default createPublicRouter;
