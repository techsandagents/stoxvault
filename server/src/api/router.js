/**
 * STOCKDROP — API assembly.
 *
 * Wires the services, mounts every router from CONTRACT.md section 5 under
 * /api, and defines the error vocabulary they all share:
 *
 *   { error: '<code>', detail?: '<one human sentence>' }
 *
 * A stack trace never reaches a client. An unexpected throw is logged on the
 * server and answered with a flat 500 `internal_error`.
 */

import express from 'express';
import { createUniverseService } from '../services/universe.js';
import { createHistoryService } from '../services/history.js';
import { createHoldersService } from '../services/holders.js';
import { createSessionService, normalizeWallet } from '../services/session.js';
import { createStatsService } from '../services/stats.js';
import { log } from '../util/log.js';
import { createPublicRouter } from './public.js';
import { createAuthRouter } from './auth.js';
import { createMeRouter } from './me.js';
import { createRoundsRouter } from './rounds.js';
import { createAdminRouter } from './admin.js';

const logger = log.child('api');

/* -------------------------------------------------------------- errors ---- */

/** An error whose status/code/detail are safe to show a client. */
export class HttpError extends Error {
  constructor(status, code, detail) {
    super(detail || code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.detail = detail || null;
  }
}

export const badRequest = (code, detail) => new HttpError(400, code, detail);
export const notFound = (code, detail) => new HttpError(404, code, detail);

/** Send the documented error shape. */
export function fail(res, status, code, detail) {
  const body = { error: code };
  if (detail) body.detail = String(detail);
  return res.status(status).json(body);
}

/** Wrap an async handler so a rejection reaches the error middleware. */
export const wrap = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/* ---------------------------------------------------------- validation ---- */

/**
 * An EVM address from a path parameter or body field, returned in its single
 * canonical EIP-55 spelling.
 *
 * Normalising HERE rather than at each call site is what stops `0xabc…` and
 * `0xABC…` becoming two accounts: prefs are keyed by whatever this returns, and
 * every route that takes a wallet goes through it.
 */
export function requireWallet(value, field = 'wallet') {
  const wallet = normalizeWallet(typeof value === 'string' ? value.trim() : '');
  if (!wallet) throw badRequest('bad_wallet', `${field} must be a 0x EVM address`);
  return wallet;
}

/** `?limit=&offset=` with sane bounds. */
export function parsePaging(query = {}, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const parse = (raw, fallback, name) => {
    if (raw === undefined || raw === '') return fallback;
    if (Array.isArray(raw)) throw badRequest('bad_query', `${name} must be given once`);
    if (!/^\d{1,9}$/.test(String(raw))) throw badRequest('bad_query', `${name} must be a non-negative integer`);
    return Number.parseInt(String(raw), 10);
  };
  const limit = parse(query.limit, defaultLimit, 'limit');
  const offset = parse(query.offset, 0, 'offset');
  if (limit < 1 || limit > maxLimit) throw badRequest('bad_query', `limit must be between 1 and ${maxLimit}`);
  return { limit, offset };
}

/** A ticker from a path parameter (`NVDAx`, `BRK.Bx`). */
export function requireSymbol(value) {
  const symbol = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9.\-_]{1,24}$/.test(symbol)) throw badRequest('bad_symbol', 'symbol must be 1-24 letters, digits, dot or dash');
  return symbol;
}

/** A round id (`r_2026-09-07T12`). */
export function requireRoundId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9_.:\-]{1,64}$/.test(id)) throw badRequest('bad_round_id', 'round id is not in the expected format');
  return id;
}

/* --------------------------------------------------------------- services -- */

/**
 * Build every service the API needs.
 * `deps` is the seam for tests and for the chain modules: pass
 * `{ jupiter, rpc, fetch, keeper }` to inject, omit to use the real ones.
 */
export function createServices({ cfg, db, deps = {} }) {
  if (!cfg) throw new TypeError('createServices: cfg is required');
  if (!db) throw new TypeError('createServices: db is required');

  const universe = deps.universe || createUniverseService({ cfg, db, deps });
  const holders = deps.holders || createHoldersService({ cfg, deps });
  const history = deps.history || createHistoryService({ cfg, deps });
  const session = deps.session || createSessionService({ cfg, db });
  const stats = deps.stats || createStatsService({ cfg, db, universe, holders });

  return { universe, holders, history, session, stats, keeper: deps.keeper || null };
}

/* ----------------------------------------------------------------- router -- */

/**
 * The /api router. Mount order matters: the concrete routes come first, then a
 * catch-all that answers JSON (never HTML) for anything unknown under /api.
 */
export function createApiRouter({ cfg, db, deps = {}, services }) {
  const svc = services || createServices({ cfg, db, deps });
  const router = express.Router();
  const ctx = { cfg, db, deps, services: svc };

  // Parsed here rather than app-wide so a malformed body lands on this
  // router's error handler and comes back as JSON, never as express' HTML page.
  router.use(express.json({ limit: '64kb', strict: true }));

  router.use(createPublicRouter(ctx));
  router.use('/auth', createAuthRouter(ctx));
  router.use('/me', createMeRouter(ctx));
  router.use('/rounds', createRoundsRouter(ctx));
  router.use('/admin', createAdminRouter(ctx));

  router.use((req, res) => fail(res, 404, 'not_found', `no API route for ${req.method} ${req.baseUrl}${req.path}`));

  // eslint-disable-next-line no-unused-vars -- express identifies error middleware by arity
  router.use((err, req, res, next) => {
    if (err instanceof HttpError) return fail(res, err.status, err.code, err.detail);
    if (err?.type === 'entity.parse.failed') return fail(res, 400, 'bad_json', 'request body is not valid JSON');
    if (err?.type === 'entity.too.large') return fail(res, 413, 'payload_too_large', 'request body is too large');
    if (err?.status === 400 && err?.expose) return fail(res, 400, 'bad_request', err.message);
    logger.error(`${req.method} ${req.originalUrl} failed`, err);
    return fail(res, 500, 'internal_error');
  });

  return { router, services: svc };
}

export default createApiRouter;
