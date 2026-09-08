/**
 * STOCKDROP server — API + keeper in one process.
 *
 * `createApp({cfg, db, deps})` builds the express app and nothing else: no
 * config loading, no listening, no timers, no chain calls. That is what makes
 * it testable, and what lets `deps` inject fakes for Jupiter, the RPC and the
 * keeper.
 *
 * `main()` is the deployment path: load config, open the store, listen, start
 * the keeper unless this process is read-only, and shut down cleanly on a
 * signal. It runs only when this file is the entry point.
 */

import cors from 'cors';
import express from 'express';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApiRouter, createServices, fail } from './api/router.js';
import { log } from './util/log.js';

const logger = log.child('server');

/* -------------------------------------------------------------------- app -- */

/**
 * Turn one CORS_ORIGIN entry into a matcher.
 *
 * A `*` in the entry matches any run of characters that is not a dot or a slash,
 * so `https://stoxvault-*.vercel.app` covers every preview deployment of that
 * one project without opening the door to `https://evil.vercel.app`. Everything
 * else in the entry is matched literally.
 *
 * This exists because a hosting platform gives every deployment its own URL. An
 * exact-match list silently blocks each of those, and the site then reports the
 * API as unreachable even though it is perfectly healthy.
 */
export function originMatcher(entry) {
  if (!entry.includes('*')) return (origin) => origin === entry;
  const pattern = new RegExp(
    `^${entry.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^./]*')}$`,
  );
  return (origin) => pattern.test(origin);
}

export function corsOptions(cfg) {
  const raw = String(cfg.corsOrigin || '*').trim();
  // '*' alone emits the header for every request, even ones without an Origin.
  if (raw === '*') {
    return {
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Key'],
      exposedHeaders: ['X-Round-Id'],
      maxAge: 86400,
    };
  }

  const matchers = raw.split(',').map((s) => s.trim()).filter(Boolean).map(originMatcher);
  return {
    // A function, not an array: the cors package only does exact matching on an
    // array, and the entries may carry a wildcard. A request with no Origin at
    // all (curl, a server-to-server call, a health check) is allowed through —
    // CORS only ever governs browsers.
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      cb(null, matchers.some((match) => match(origin)));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Key'],
    exposedHeaders: ['X-Round-Id'],
    maxAge: 86400,
  };
}

/**
 * Build the HTTP app.
 * @param {{cfg: object, db: object, deps?: object, services?: object}} args
 * @returns {import('express').Express} with `app.locals.services` set
 */
export function createApp({ cfg, db, deps = {}, services } = {}) {
  if (!cfg) throw new TypeError('createApp: cfg is required');
  if (!db) throw new TypeError('createApp: db is required');

  const svc = services || createServices({ cfg, db, deps });
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.set('json spaces', 0);
  app.use(cors(corsOptions(cfg)));

  const { router } = createApiRouter({ cfg, db, deps, services: svc });

  app.get('/', (_req, res) => {
    res.json({
      name: 'stockdrop',
      version: cfg.version,
      mode: cfg.mode,
      launched: cfg.launched,
      token: cfg.tokenSymbol || null,
      vault: cfg.vaultAddress,
      nextRoundAt: cfg.nextRoundAtIso(),
      serverTime: new Date().toISOString(),
      api: {
        health: 'GET /api/health',
        config: 'GET /api/config',
        universe: 'GET /api/universe',
        history: 'GET /api/universe/:symbol/history?range=1mo|3mo|1y',
        stats: 'GET /api/stats',
        vault: 'GET /api/vault',
        prefs: 'GET /api/prefs/:wallet',
        holders: 'GET /api/holders?limit&offset',
        rounds: 'GET /api/rounds?limit&offset',
        round: 'GET /api/rounds/:id',
        preview: 'GET /api/rounds/preview',
        authNonce: 'POST /api/auth/nonce',
        authVerify: 'POST /api/auth/verify',
        me: 'GET /api/me',
        setPrefs: 'PUT /api/me/prefs',
        clearPrefs: 'DELETE /api/me/prefs',
        adminRun: 'POST /api/admin/round/run',
        adminRefresh: 'POST /api/admin/universe/refresh',
        adminStatus: 'GET /api/admin/status',
      },
    });
  });

  app.use('/api', router);

  app.use((req, res) => fail(res, 404, 'not_found', `nothing at ${req.method} ${req.path}`));

  // eslint-disable-next-line no-unused-vars -- express identifies error middleware by arity
  app.use((err, req, res, _next) => {
    logger.error(`${req.method} ${req.originalUrl} failed`, err);
    if (res.headersSent) return;
    fail(res, 500, 'internal_error');
  });

  app.locals.services = svc;
  app.locals.cfg = cfg;
  return app;
}

/* ----------------------------------------------------------------- keeper -- */

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
 * The chain clients from `src/chain/*`, if this build has them. Each one is
 * optional and independently guarded: the API serves fine without any of them
 * (it falls back to plain HTTP), and the keeper simply will not start.
 * @returns {Promise<{rpc: object|null, jup: object|null, dist: object|null, vault: object|null}>}
 */
export async function loadChain(cfg, logger_ = logger) {
  const out = { rpc: null, jup: null, dist: null, vault: null };
  try {
    const { createRpc } = await import('./chain/rpc.js');
    out.rpc = createRpc(cfg, { logger: logger_ });
  } catch (err) {
    logger_.warn(`chain/rpc unavailable: ${err?.message || err}`);
  }
  try {
    const { createJupiter } = await import('./chain/jupiter.js');
    out.jup = createJupiter(cfg, { logger: logger_ });
  } catch (err) {
    logger_.warn(`chain/jupiter unavailable: ${err?.message || err}`);
  }
  if (out.rpc) {
    try {
      const { createDistributor } = await import('./chain/distributor.js');
      out.dist = createDistributor({ cfg, rpc: out.rpc, logger: logger_ });
    } catch (err) {
      logger_.warn(`chain/distributor unavailable: ${err?.message || err}`);
    }
  }
  try {
    const { loadVault } = await import('./chain/vault.js');
    out.vault = loadVault(cfg); // holds the keypair; never leaves this process
  } catch (err) {
    logger_.warn(`chain/vault unavailable: ${err?.message || err}`);
  }
  return out;
}

/**
 * Start the 6-hourly keeper, unless this process has no vault key (READ_ONLY)
 * or START_KEEPER=0. A missing keeper module is a warning, not a crash: the API
 * is useful on its own and must not fail to boot because of it.
 * @returns {Promise<{stop?: Function}|null>}
 */
export async function startKeeper({ cfg, db, services, deps = {}, chain = null, env = process.env }) {
  if (cfg.mode === 'READ_ONLY') {
    logger.warn('keeper not started: no VAULT_SECRET_KEY, this process is READ_ONLY');
    return null;
  }
  if (String(env.START_KEEPER ?? '') === '0') {
    logger.info('keeper not started: START_KEEPER=0');
    return null;
  }

  let mod = null;
  try {
    mod = await import('./keeper/scheduler.js');
  } catch (err) {
    logger.warn(`keeper scheduler unavailable, running API only: ${err?.message || err}`);
    return null;
  }

  const create = fnOf(mod, ['start', 'createScheduler', 'startScheduler', 'createKeeper', 'scheduler']);
  if (!create) {
    logger.warn('keeper scheduler exports no start function, running API only');
    return null;
  }

  try {
    const parts = chain || (await loadChain(cfg));
    const handle = await create({
      cfg,
      db,
      rpc: parts.rpc,
      jup: parts.jup,
      dist: parts.dist,
      vault: parts.vault,
      holdersService: services?.holders ?? null,
      universeService: services?.universe ?? null,
      logger: log.child('keeper'),
      services,
      deps,
    });
    // Some shapes start themselves (the scheduler does); others hand back a
    // handle to start. Only call start() when it exists.
    if (handle && typeof handle.start === 'function') await handle.start();
    logger.info(`keeper started: rounds every ${cfg.intervalHours}h (+/-${cfg.roundJitterMin}m), mode=${cfg.mode}`);
    return handle && typeof handle === 'object' ? handle : {};
  } catch (err) {
    logger.error('keeper failed to start; the API keeps serving', err);
    return null;
  }
}

/* ------------------------------------------------------------------- main -- */

/** Boot the server. Resolves once it is listening. */
export async function main() {
  // Imported here (not at module scope) so that importing this file for tests
  // never reads .env, never touches process.env and never logs.
  const { CFG } = await import('./config.js');
  const { openDb } = await import('./db/index.js');

  const cfg = CFG;
  const db = await openDb(cfg);

  // One RPC client and one Jupiter client for the whole process: the API reads
  // through the same retrying transport the keeper trades through.
  const chain = await loadChain(cfg);
  const deps = {};
  if (chain.rpc) deps.rpc = chain.rpc;
  if (chain.jup) deps.jupiter = chain.jup;

  const services = createServices({ cfg, db, deps });
  const app = createApp({ cfg, db, deps, services });

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(cfg.port, () => resolve(s));
    s.on('error', reject);
  });

  const keeper = await startKeeper({ cfg, db, services, deps, chain });
  if (keeper) {
    app.locals.keeper = keeper;
    // POST /api/admin/round/run goes through the running scheduler, so an
    // operator's round and a scheduled one can never overlap.
    if (typeof keeper.runNow === 'function' || typeof keeper.status === 'function') {
      deps.keeper = {
        runRound: typeof keeper.runNow === 'function' ? (extra) => keeper.runNow(extra) : null,
        status: typeof keeper.status === 'function' ? () => keeper.status() : null,
      };
    }
  }

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : cfg.port;
  // config.js has already logged the full boot summary; this line adds what is
  // only known once the socket is open.
  logger.info(`listening on :${port} mode=${cfg.mode} store=${cfg.storeKind} cors=${cfg.corsOrigin} keeper=${keeper ? 'on' : 'off'}`);
  if (!cfg.launched) {
    logger.info('no TOKEN_MINT yet: /api/* serves honest "not launched" states and rounds would skip with reason no_token');
  }

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    logger.info(`${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref?.();
    try {
      if (keeper && typeof keeper.stop === 'function') await keeper.stop();
    } catch (err) {
      logger.warn(`keeper stop failed: ${err?.message || err}`);
    }
    await new Promise((resolve) => server.close(resolve));
    try {
      await db.close();
    } catch (err) {
      logger.warn(`store close failed: ${err?.message || err}`);
    }
    clearTimeout(force);
    logger.info('bye');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error('unhandled rejection', reason));

  return { app, server, db, services, keeper, port };
}

const isEntryPoint = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(entry).href);
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  main().catch((err) => {
    logger.error('failed to start', err);
    process.exit(1);
  });
}

export default createApp;
