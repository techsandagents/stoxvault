/**
 * STOCKDROP keeper / scheduler
 *
 * Rounds run at the UTC marks (00:00 / 06:00 / 12:00 / 18:00 for a 6h interval),
 * each one displaced by a jitter in [-J, +J] minutes so the snapshot instant is
 * not announced. The jitter is NOT random: it is derived from sha256 of the
 * round id, so
 *
 *   - nobody can predict it without knowing the round id in advance (they can,
 *     it is the timestamp — so this is a speed bump against bots, not a secret,
 *     and SPEC.md says as much),
 *   - and anyone can verify after the fact that the keeper did not choose a
 *     convenient moment: recompute sha256(roundId) and check the offset.
 *
 * The jitter is recorded on the round document.
 *
 * On boot the scheduler first resumes any unfinished round — a process that
 * died mid-distribution finishes paying before it starts thinking about the
 * next round.
 *
 * Nothing here runs in READ_ONLY: without a vault secret there is no keeper.
 */

import crypto from 'node:crypto';
import { runRound as defaultRunRound, roundIdFor } from './runner.js';

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** The next UTC mark strictly after `now`, aligned to midnight in `intervalHours` steps. */
export function nextMark(intervalHours, now = Date.now()) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  const d = new Date(t);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const step = Math.max(1, Number(intervalHours) || 6) * 3600_000;
  const nextDay = dayStart + 86_400_000;
  const mark = dayStart + (Math.floor((t - dayStart) / step) + 1) * step;
  return new Date(Math.min(mark, nextDay));
}

/**
 * Deterministic jitter for a round id.
 *
 * sha256(roundId) -> the first 6 bytes as an unsigned integer -> a whole number
 * of seconds in [-J*60, +J*60]. 6 bytes (2^48) against a range of at most 7201
 * values makes the modulo bias immeasurable.
 *
 * @param {string} roundId
 * @param {number} jitterMin maximum displacement in minutes (0 disables jitter)
 * @returns {{ms: number, seconds: number, minutes: number}}
 */
export function jitterFor(roundId, jitterMin) {
  const maxMinutes = Math.max(0, Number(jitterMin) || 0);
  if (maxMinutes === 0) return { ms: 0, seconds: 0, minutes: 0 };
  const digest = crypto.createHash('sha256').update(String(roundId)).digest();
  const value = digest.readUIntBE(0, 6);
  const span = maxMinutes * 60 * 2 + 1; // [-J*60 .. +J*60] inclusive, in seconds
  const seconds = (value % span) - maxMinutes * 60;
  return { ms: seconds * 1000, seconds, minutes: Math.round((seconds / 60) * 100) / 100 };
}

/**
 * The next scheduled run: which mark, which round id, what jitter, and the wall
 * clock instant it fires. A negative jitter that has already passed does not
 * push the round into the past — it fires immediately at the mark instead.
 */
export function planNext(cfg, now = Date.now()) {
  const at = now instanceof Date ? now.getTime() : Number(now);
  const mark = nextMark(cfg.intervalHours ?? 6, at);
  const id = roundIdFor(mark);
  const jitter = jitterFor(id, cfg.roundJitterMin ?? 0);
  const fireAt = new Date(Math.max(mark.getTime() + jitter.ms, at));
  return { mark, roundId: id, jitterMin: jitter.minutes, jitterSeconds: jitter.seconds, fireAt };
}

/**
 * start(deps) -> { stop, nextRoundAt, status, runNow }
 *
 * @param {{
 *   cfg: object, db: object, rpc: object, jup: object, dist?: object,
 *   holdersService?: object, universeService?: object, vault?: object|null,
 *   logger?: object, runRound?: Function, now?: () => number,
 *   setTimer?: Function, clearTimer?: Function, autoStart?: boolean
 * }} deps
 */
export function start(deps = {}) {
  const { cfg, db } = deps;
  if (!cfg) throw new Error('scheduler.start: cfg is required');
  if (!db) throw new Error('scheduler.start: db is required');

  const logger = deps.logger || noopLogger;
  const now = deps.now || (() => Date.now());
  const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer || ((handle) => clearTimeout(handle));
  const runRound = deps.runRound || defaultRunRound;

  const state = {
    enabled: cfg.mode === 'LIVE' || cfg.mode === 'DRY_RUN',
    running: false,
    stopped: false,
    timer: null,
    next: null,
    lastRoundId: null,
    lastStatus: null,
    lastFinishedAt: null,
    lastError: null,
    roundsRun: 0,
    startedAt: new Date(now()).toISOString(),
  };

  // Whatever the caller gave us is forwarded as-is; the runner fills in the
  // chain clients it was not handed (index.js passes `{cfg, db, services, deps}`,
  // tests pass explicit fakes).
  const roundDeps = () => ({
    cfg,
    db,
    services: deps.services ?? null,
    deps: deps.deps ?? null,
    rpc: deps.rpc,
    jup: deps.jup,
    dist: deps.dist,
    holdersService: deps.holdersService ?? deps.services?.holders ?? null,
    universeService: deps.universeService ?? deps.services?.universe ?? null,
    vault: deps.vault,
    logger,
    now,
  });

  async function execute(extra) {
    if (state.stopped || state.running) return null;
    state.running = true;
    try {
      const round = await runRound({ ...roundDeps(), ...extra });
      if (round) {
        state.lastRoundId = round.id;
        state.lastStatus = round.status;
        state.lastFinishedAt = round.finishedAt ?? null;
        state.lastError = round.error ?? null;
        state.roundsRun += 1;
      }
      return round;
    } catch (err) {
      // runRound records its own failures on the round; reaching here means the
      // store itself is unavailable. Keep the scheduler alive and try the next mark.
      state.lastError = String(err.message);
      logger.error?.(`keeper: round failed outside the round document: ${err.message}`);
      return null;
    } finally {
      state.running = false;
    }
  }

  function schedule() {
    if (state.stopped) return;
    const plan = planNext(cfg, now());
    state.next = plan;
    const waitMs = Math.max(0, plan.fireAt.getTime() - now());
    // setTimeout tops out at ~24.8 days; a 6h interval is never near it, but a
    // clamp keeps a mis-set interval from firing instantly forever.
    state.timer = setTimer(onTick, Math.min(waitMs, 2_147_483_000));
    if (typeof state.timer?.unref === 'function') state.timer.unref();
    logger.info?.(
      `keeper: next round ${plan.roundId} at ${plan.fireAt.toISOString()} (mark ${plan.mark.toISOString()}, jitter ${plan.jitterMin >= 0 ? '+' : ''}${plan.jitterMin}m)`,
    );
  }

  async function onTick() {
    if (state.stopped) return;
    const plan = state.next;
    await execute({ scheduledAt: plan?.mark ?? new Date(now()), jitterMin: plan?.jitterMin ?? null, resume: true });
    schedule();
  }

  /** Boot: finish an interrupted round before scheduling the next one. */
  const booted = (async () => {
    if (!state.enabled) {
      logger.warn?.(`keeper: disabled in ${cfg.mode} mode (no vault secret, no rounds)`);
      return;
    }
    try {
      const unfinished = await db.unfinishedRound();
      if (unfinished) {
        logger.info?.(`keeper: resuming unfinished round ${unfinished.id} (${unfinished.status})`);
        await execute({ roundId: unfinished.id, resume: true });
      }
    } catch (err) {
      logger.error?.(`keeper: could not resume an unfinished round: ${err.message}`);
      state.lastError = String(err.message);
    }
    if (deps.autoStart === false) return;
    schedule();
  })();

  return {
    /** Resolves once the boot resume (and first schedule) is done — tests await this. */
    ready: () => booted,
    stop() {
      state.stopped = true;
      if (state.timer !== null) clearTimer(state.timer);
      state.timer = null;
      logger.info?.('keeper: stopped');
    },
    /** ISO time of the next scheduled round, or null when the keeper is off. */
    nextRoundAt() {
      if (!state.enabled || state.stopped) return null;
      return state.next ? state.next.fireAt.toISOString() : planNext(cfg, now()).fireAt.toISOString();
    },
    /** Run a round right now (admin route / CLI), outside the schedule. */
    runNow(extra = {}) {
      return execute({ resume: true, ...extra });
    },
    status() {
      // Between boot and the first schedule() there is no armed timer yet, but
      // the next round is still knowable — compute it rather than report null.
      const next = state.next ?? (state.enabled && !state.stopped ? planNext(cfg, now()) : null);
      return {
        enabled: state.enabled,
        mode: cfg.mode,
        running: state.running,
        stopped: state.stopped,
        armed: state.timer !== null,
        startedAt: state.startedAt,
        intervalHours: cfg.intervalHours,
        jitterMin: cfg.roundJitterMin,
        nextRoundAt: next && !state.stopped ? next.fireAt.toISOString() : null,
        nextRoundId: next && !state.stopped ? next.roundId : null,
        nextMark: next && !state.stopped ? next.mark.toISOString() : null,
        nextJitterMin: next && !state.stopped ? next.jitterMin : null,
        roundsRun: state.roundsRun,
        lastRoundId: state.lastRoundId,
        lastStatus: state.lastStatus,
        lastFinishedAt: state.lastFinishedAt,
        lastError: state.lastError,
      };
    },
  };
}

export default start;
