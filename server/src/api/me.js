/**
 * STOCKDROP — the signed-in wallet's own view.
 *
 * `GET /api/me` answers the three questions a holder actually has: do I qualify,
 * what am I buying, and what is my share of the next drop. Every one of those
 * can be honestly unknown before launch, and says so instead of guessing.
 *
 * `PUT /api/me/prefs` is the only write in the whole product, and it is
 * validated by the same engine function the keeper uses, so a basket that saves
 * is a basket that will be honoured.
 */

import express from 'express';
import { wrap, badRequest, HttpError } from './router.js';
import { PickError, validatePicks, defaultPicks, effectiveBasket } from '../engine/index.js';

const MAX_SIGNATURE_CHARS = 200;
const MAX_MESSAGE_CHARS = 2000;

/** raw base units -> ui number for the memecoin's decimals. */
function toUi(raw, decimals) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const d = Number.isInteger(decimals) && decimals >= 0 ? decimals : 0;
  const padded = raw.padStart(d + 1, '0');
  const whole = padded.slice(0, padded.length - d);
  const frac = d > 0 ? padded.slice(padded.length - d) : '';
  return Number(`${whole}${frac ? `.${frac}` : ''}`);
}

/**
 * The `me` document, shared by GET /api/me and the response to a successful
 * POST /api/auth/verify (the contract says they are the same object).
 */
export async function buildMe({ cfg, db, services, wallet }) {
  const { universe, holders, stats } = services;

  const [prefs, stocks] = await Promise.all([db.getPrefs(wallet), universe.stocks()]);

  const index = new Map(stocks.map((s) => [s.mint, s]));
  const fallback = defaultPicks(stocks, cfg.rules);
  const basket = effectiveBasket(prefs?.picks ?? null, index, fallback);

  let balance = null;
  if (cfg.launched) {
    const read = await holders.balanceOf(wallet);
    if (read) {
      const raw = read.raw;
      const held = BigInt(raw);
      const threshold = BigInt(cfg.eligibleThresholdRaw);
      const supply = BigInt(cfg.supplyRaw);
      // pct of supply to 4 decimal places, computed in bigint then scaled down.
      const pctOfSupply = supply > 0n ? Number((held * 1000000n) / supply) / 10000 : null;
      balance = {
        raw,
        ui: toUi(raw, cfg.tokenDecimals),
        eligible: held >= threshold && held > 0n,
        thresholdRaw: cfg.eligibleThresholdRaw,
        thresholdUi: cfg.eligibleThresholdUi,
        pctOfSupply,
        accounts: read.accounts,
      };
    }
  }

  let projected = { shareBps: null, note: 'The coin has not launched yet, so there is nothing to project.' };
  if (cfg.launched) {
    if (!balance) {
      projected = { shareBps: null, note: 'Your balance could not be read from the chain just now.' };
    } else if (!balance.eligible) {
      projected = {
        shareBps: 0,
        note: `Holding at least ${cfg.eligibleThresholdUi} ${cfg.tokenSymbol || 'tokens'} (${cfg.eligibleBps / 100}% of supply) qualifies for a drop.`,
      };
    } else {
      const snap = await stats.snapshotBalances();
      if (!snap?.map) {
        projected = { shareBps: null, note: 'No holder snapshot has been taken yet, so a share cannot be estimated.' };
      } else {
        const mine = BigInt(balance.raw);
        let total = 0n;
        for (const [w, value] of snap.map) total += w === wallet ? 0n : value;
        total += mine;
        projected = {
          shareBps: total > 0n ? Number((mine * 10000n) / total) : 0,
          note:
            snap.source === 'round'
              ? 'Estimated from the last round snapshot and your balance right now.'
              : 'Estimated from a live holder snapshot and your balance right now.',
          basis: snap.source,
          snapshotAt: snap.takenAt ?? null,
        };
      }
    }
  }

  return {
    wallet,
    balance,
    prefs: prefs ?? null,
    effectivePicks: basket.picks,
    picksSource: basket.source,
    projected,
    nextRoundAt: cfg.nextRoundAtIso(),
  };
}

export function createMeRouter({ cfg, db, services }) {
  const router = express.Router();
  const { session, universe } = services;

  router.use(session.requireAuth);

  router.get(
    '/',
    wrap(async (req, res) => {
      res.json(await buildMe({ cfg, db, services, wallet: req.wallet }));
    }),
  );

  router.put(
    '/prefs',
    wrap(async (req, res) => {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw badRequest('bad_request', 'body must be a JSON object');
      }
      if (!Array.isArray(body.picks)) {
        return res.status(400).json({ error: 'invalid_picks', code: 'count', detail: 'picks must be an array of {mint, pct}' });
      }
      if (body.picks.length > 32) {
        return res.status(400).json({ error: 'invalid_picks', code: 'count', detail: 'far too many picks' });
      }

      const signature = body.signature === undefined || body.signature === null ? null : String(body.signature);
      const message = body.message === undefined || body.message === null ? null : String(body.message);
      if (signature !== null && signature.length > MAX_SIGNATURE_CHARS) {
        throw badRequest('bad_request', 'signature is too long');
      }
      if (message !== null && message.length > MAX_MESSAGE_CHARS) {
        throw badRequest('bad_request', 'message is too long');
      }

      const stocks = await universe.stocks();
      if (stocks.length === 0) {
        throw new HttpError(503, 'universe_unavailable', 'the stock list could not be loaded, so picks cannot be validated');
      }

      let picks;
      try {
        picks = validatePicks(body.picks, stocks, cfg.rules);
      } catch (err) {
        if (err instanceof PickError) {
          return res.status(400).json({ error: 'invalid_picks', code: err.code, detail: err.detail });
        }
        throw err;
      }

      const saved = await db.setPrefs({
        wallet: req.wallet,
        picks,
        signature,
        message,
        updatedAt: new Date().toISOString(),
      });
      res.json(saved);
    }),
  );

  router.delete(
    '/prefs',
    wrap(async (req, res) => {
      await db.deletePrefs(req.wallet);
      res.json({ ok: true });
    }),
  );

  return router;
}

export default createMeRouter;
