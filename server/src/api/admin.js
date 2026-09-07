/**
 * STOCKDROP — operator routes, behind `X-Admin-Key`.
 *
 * Three things an operator needs and nobody else may have: run a round now,
 * force a universe refresh, and see what the keeper is doing. With no ADMIN_KEY
 * configured these are not merely unauthenticated — they are switched off (503),
 * so a deploy that forgets the key cannot be poked by anyone.
 *
 * Nothing here ever returns a secret: the config summary comes from
 * `cfg.safeSummary()`, which has no key material in it by construction.
 */

import crypto from 'node:crypto';
import express from 'express';
import { wrap, fail, HttpError } from './router.js';
import { log } from '../util/log.js';

const logger = log.child('admin');

const RUN_FN_NAMES = ['runRound', 'runNow', 'runOnce', 'runRoundNow', 'run'];
const STATUS_FN_NAMES = ['status', 'getStatus', 'schedulerStatus', 'state'];

function fnOf(mod, names) {
  if (!mod) return null;
  for (const name of names) {
    if (typeof mod[name] === 'function') return mod[name].bind(mod);
    const d = mod.default;
    if (d && typeof d === 'object' && typeof d[name] === 'function') return d[name].bind(d);
  }
  return null;
}

/**
 * The keeper, if this build has one. `deps.keeper` wins (that is what index.js
 * passes once the scheduler is started, and what tests inject); otherwise the
 * keeper modules are imported lazily so the API runs fine without them.
 */
export async function resolveKeeper(deps = {}) {
  if (deps.keeper) return deps.keeper;
  const mods = [];
  for (const path of ['../keeper/runner.js', '../keeper/scheduler.js']) {
    try {
      // eslint-disable-next-line no-await-in-loop
      mods.push(await import(path));
    } catch {
      /* the keeper is optional here; the API is not the keeper */
    }
  }
  if (mods.length === 0) return null;
  const run = mods.map((m) => fnOf(m, RUN_FN_NAMES)).find(Boolean) || null;
  const status = mods.map((m) => fnOf(m, STATUS_FN_NAMES)).find(Boolean) || null;
  if (!run && !status) return null;
  return { runRound: run, status };
}

const looksLikeRound = (value) => Boolean(value) && typeof value === 'object' && typeof value.id === 'string' && typeof value.status === 'string';

export function createAdminRouter({ cfg, db, deps = {}, services }) {
  const router = express.Router();
  const { universe } = services;
  const startedAt = Date.now();

  router.use((req, res, next) => {
    if (!cfg.hasAdminKey) {
      return fail(res, 503, 'admin_disabled', 'ADMIN_KEY is not configured on this server');
    }
    const given = req.get('x-admin-key') || '';
    const expected = cfg.adminKey;
    const a = Buffer.from(String(given));
    const b = Buffer.from(String(expected));
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) return fail(res, 401, 'unauthorized', 'X-Admin-Key is missing or wrong');
    return next();
  });

  router.post(
    '/round/run',
    wrap(async (req, res) => {
      const keeper = await resolveKeeper(deps);
      if (!keeper?.runRound) {
        throw new HttpError(503, 'keeper_unavailable', 'no keeper is loaded in this process, so a round cannot be started here');
      }
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const roundId = body.roundId === undefined || body.roundId === null ? undefined : String(body.roundId);
      if (roundId !== undefined && !/^[A-Za-z0-9_.:\-]{1,64}$/.test(roundId)) {
        throw new HttpError(400, 'bad_round_id', 'roundId is not in the expected format');
      }
      const retry = body.retry === true;

      logger.info(`admin round run requested (mode=${cfg.mode}${roundId ? `, round ${roundId}` : ''}${retry ? ', retry' : ''})`);
      const round = await keeper.runRound({
        cfg,
        db,
        deps,
        services,
        reason: 'admin',
        roundId,
        retry,
        resume: body.resume !== false,
      });
      if (round === null || round === undefined) {
        throw new HttpError(409, 'keeper_busy', 'a round is already running; try again when it finishes');
      }
      if (!looksLikeRound(round)) {
        throw new HttpError(502, 'keeper_error', 'the keeper did not return a round document');
      }
      res.json(round);
    }),
  );

  router.post(
    '/universe/refresh',
    wrap(async (_req, res) => {
      const doc = await universe.refresh();
      res.json({
        updatedAt: doc.updatedAt,
        source: doc.source,
        stale: doc.stale,
        count: doc.stocks.length,
        error: doc.error ?? null,
        stocks: doc.stocks,
        all: doc.all,
      });
    }),
  );

  router.get(
    '/status',
    wrap(async (_req, res) => {
      const keeper = await resolveKeeper(deps);
      let keeperStatus = null;
      let keeperError = null;
      if (keeper?.status) {
        try {
          keeperStatus = await keeper.status({ cfg, db, services });
        } catch (err) {
          keeperError = String(err?.message || err);
        }
      }

      const [latest, unfinished] = await Promise.all([
        db.latestRound().catch(() => null),
        db.unfinishedRound().catch(() => null),
      ]);
      const peek = universe.peek();

      res.json({
        serverTime: new Date().toISOString(),
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        nextRoundAt: cfg.nextRoundAtIso(),
        config: cfg.safeSummary(),
        keeper: {
          loaded: Boolean(keeper),
          canRun: Boolean(keeper?.runRound),
          status: keeperStatus,
          error: keeperError,
        },
        universe: peek
          ? { updatedAt: peek.updatedAt, source: peek.source, stale: peek.stale, count: peek.stocks.length, error: peek.error ?? null }
          : null,
        rounds: {
          latest: latest ? { id: latest.id, status: latest.status, simulated: latest.simulated, finishedAt: latest.finishedAt, error: latest.error ?? null } : null,
          unfinished: unfinished ? { id: unfinished.id, status: unfinished.status } : null,
        },
      });
    }),
  );

  return router;
}

export default createAdminRouter;
