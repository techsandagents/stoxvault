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
 * Each cycle also gets an OPEN snapshot, scheduled here. The round at mark T
 * owns the cycle (T-I, T]; the open snapshot fires at an unpredictable moment
 * inside that cycle's first hour and the round's own snapshot closes it, so a
 * wallet is weighted on min(open, close) and cannot buy in front of the drop
 * and sell behind it. The open offset is derived the same auditable way as the
 * jitter — sha256, keyed on the round id, in its own domain.
 *
 * On boot the scheduler first resumes any unfinished round — a process that
 * died mid-distribution finishes paying before it starts thinking about the
 * next round.
 *
 * Nothing here runs in READ_ONLY: without a vault secret there is no keeper.
 */

import crypto from 'node:crypto';
import {
  antiCheatEnabled,
  openWindowMinFor,
  roundIdFor,
  runRound as defaultRunRound,
  takeOpenSnapshot as defaultTakeOpenSnapshot,
} from './runner.js';

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
 * Where inside the cycle's first hour the OPEN snapshot is taken.
 *
 * The round at mark T with interval I owns the cycle (T-I, T]. The open
 * snapshot fires at T-I plus this offset, which is
 *
 *   - unpredictable in practice: sha256('open:' + roundId), a different domain
 *     from the round jitter so knowing one tells you nothing about the other,
 *   - and auditable after the fact: recompute the hash and check the time.
 *
 * The window is `openSnapshotWindowMin` minutes, capped at I/4 so a short
 * interval can never push the open snapshot outside its own cycle (and never
 * past the close). The offset is in [0, window), so it always lands inside the
 * cycle's first hour.
 *
 * @param {string} roundId the round the snapshot belongs to
 * @param {number} windowMin size of the window in minutes
 * @param {number} intervalHours the round interval
 * @returns {{ms: number, seconds: number, minutes: number, windowMs: number}}
 */
export function openOffsetFor(roundId, windowMin, intervalHours) {
  const intervalMs = Math.max(1, Number(intervalHours) || 6) * 3600_000;
  const cap = Math.floor(intervalMs / 4);
  const wanted = Math.floor(Math.max(0, Number(windowMin) || 0) * 60_000);
  const windowMs = Math.min(wanted, cap);
  if (windowMs <= 0) return { ms: 0, seconds: 0, minutes: 0, windowMs: 0 };

  const digest = crypto.createHash('sha256').update(`open:${String(roundId)}`).digest();
  const value = digest.readUIntBE(0, 6);
  const span = Math.max(1, Math.floor(windowMs / 1000)); // whole seconds in [0, window)
  const seconds = value % span;
  return { ms: seconds * 1000, seconds, minutes: Math.round((seconds / 60) * 100) / 100, windowMs };
}

/**
 * The open snapshot for the round at `mark`: which cycle it opens, when it is
 * taken, and how wide the window was.
 *
 * @param {object} cfg
 * @param {Date|number} mark the round's scheduled mark (the END of the cycle)
 */
export function planOpenSnapshot(cfg, mark) {
  const intervalHours = cfg?.intervalHours ?? 6;
  const markMs = mark instanceof Date ? mark.getTime() : Number(mark);
  const cycleStartMs = markMs - intervalHours * 3600_000;
  const roundId = roundIdFor(new Date(markMs));
  const offset = openOffsetFor(roundId, openWindowMinFor(cfg), intervalHours);
  return {
    roundId,
    mark: new Date(markMs),
    cycleStart: new Date(cycleStartMs),
    at: new Date(cycleStartMs + offset.ms),
    offsetSeconds: offset.seconds,
    offsetMinutes: offset.minutes,
    windowMs: offset.windowMs,
    windowMin: offset.windowMs / 60_000,
  };
}

/**
 * The next scheduled run: which mark, which round id, what jitter, and the wall
 * clock instant it fires. A negative jitter that has already passed does not
 * push the round into the past — it fires immediately at the mark instead.
 *
 * `afterMark` is the last mark this keeper actually handled, and the plan is
 * always strictly after it. Without that, a negative jitter re-selects the mark
 * it just ran: the 12:00 round fires at 11:53, finishes at 11:55, and the clock
 * alone still says the next mark is 12:00 — so the keeper runs it again, and
 * again, until the mark passes.
 *
 * @param {object} cfg
 * @param {Date|number} [now]
 * @param {Date|number|null} [afterMark] the last mark handled, exclusive
 */
export function planNext(cfg, now = Date.now(), afterMark = null) {
  const at = now instanceof Date ? now.getTime() : Number(now);
  const interval = cfg.intervalHours ?? 6;
  const after = afterMark === null || afterMark === undefined ? null : afterMark instanceof Date ? afterMark.getTime() : Number(afterMark);
  let mark = nextMark(interval, at);
  if (after !== null && Number.isFinite(after) && mark.getTime() <= after) mark = nextMark(interval, after);
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
  const takeOpenSnapshot = deps.takeOpenSnapshot || defaultTakeOpenSnapshot;

  const state = {
    enabled: cfg.mode === 'LIVE' || cfg.mode === 'DRY_RUN',
    running: false,
    stopped: false,
    timer: null,
    next: null,
    /** The open snapshot of the cycle that ends at the next mark. */
    openTimer: null,
    nextOpen: null,
    lastOpenRoundId: null,
    lastOpenAt: null,
    lastOpenHolderCount: null,
    lastOpenError: null,
    openSnapshotsTaken: 0,
    /** The last mark this keeper fired on. Every plan is strictly after it. */
    lastMark: null,
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

  /**
   * The OPEN snapshot of the cycle that ends at `plan.mark`.
   *
   * It is armed only while its moment is still ahead: a keeper that boots
   * mid-cycle has already missed that window, and inventing a late "open" would
   * be worse than falling back — the round says `close-only` or leans on the
   * previous close, and the ledger says which.
   */
  function scheduleOpen(plan) {
    if (state.openTimer !== null) {
      clearTimer(state.openTimer);
      state.openTimer = null;
    }
    if (state.stopped || !antiCheatEnabled(cfg)) {
      state.nextOpen = null;
      return;
    }
    const open = planOpenSnapshot(cfg, plan.mark);
    if (open.roundId === state.lastOpenRoundId) {
      state.nextOpen = { ...open, status: 'taken' };
      return;
    }
    const waitMs = open.at.getTime() - now();
    if (waitMs < 0) {
      // Its window is behind us. Say so rather than take a snapshot that is not
      // an open snapshot.
      state.nextOpen = { ...open, status: 'missed' };
      logger.warn?.(
        `keeper: the open-snapshot window for ${open.roundId} (${open.at.toISOString()}) has already passed; ` +
          'that round will fall back to the previous close snapshot',
      );
      return;
    }
    state.nextOpen = { ...open, status: 'armed' };
    state.openTimer = setTimer(onOpenTick, Math.min(waitMs, 2_147_483_000), 'open');
    if (typeof state.openTimer?.unref === 'function') state.openTimer.unref();
    logger.info?.(
      `keeper: open snapshot for ${open.roundId} at ${open.at.toISOString()} (+${open.offsetMinutes}m into the cycle that started ${open.cycleStart.toISOString()})`,
    );
  }

  async function onOpenTick() {
    state.openTimer = null;
    if (state.stopped) return;
    const open = state.nextOpen;
    if (!open) return;
    state.lastOpenRoundId = open.roundId;
    state.nextOpen = { ...open, status: 'taken' };
    try {
      const result = await takeOpenSnapshot({
        cfg,
        db,
        holdersService: deps.holdersService ?? deps.services?.holders ?? null,
        rpc: deps.rpc ?? deps.services?.rpc ?? null,
        logger,
        now,
        roundId: open.roundId,
        cycleStart: open.cycleStart,
        scheduledFor: open.at,
      });
      state.lastOpenError = null;
      if (result?.taken) {
        state.openSnapshotsTaken += 1;
        state.lastOpenAt = result.snapshot?.takenAt ?? new Date(now()).toISOString();
        state.lastOpenHolderCount = result.snapshot?.holderCount ?? null;
      } else {
        state.lastOpenAt = result?.snapshot?.takenAt ?? null;
        state.lastOpenHolderCount = result?.snapshot?.holderCount ?? null;
        if (result?.reason && result.reason !== 'already_taken') {
          logger.info?.(`keeper: open snapshot for ${open.roundId} not taken (${result.reason})`);
        }
      }
    } catch (err) {
      // A missed open snapshot degrades the round to the documented fallback;
      // it must never stop the round itself from running.
      state.lastOpenError = String(err.message);
      logger.error?.(`keeper: open snapshot for ${open.roundId} failed: ${err.message}`);
    }
  }

  function schedule() {
    if (state.stopped) return;
    const plan = planNext(cfg, now(), state.lastMark);
    state.next = plan;
    const waitMs = Math.max(0, plan.fireAt.getTime() - now());
    // setTimeout tops out at ~24.8 days; a 6h interval is never near it, but a
    // clamp keeps a mis-set interval from firing instantly forever.
    state.timer = setTimer(onTick, Math.min(waitMs, 2_147_483_000), 'round');
    if (typeof state.timer?.unref === 'function') state.timer.unref();
    logger.info?.(
      `keeper: next round ${plan.roundId} at ${plan.fireAt.toISOString()} (mark ${plan.mark.toISOString()}, jitter ${plan.jitterMin >= 0 ? '+' : ''}${plan.jitterMin}m)`,
    );
    scheduleOpen(plan);
  }

  async function onTick() {
    if (state.stopped) return;
    const plan = state.next;
    const mark = plan?.mark ?? new Date(now());
    // Record the mark BEFORE running it. A round that fires early (negative
    // jitter) and finishes before its own mark must not be selected again, and
    // a round that throws must not be retried in a tight loop either.
    state.lastMark = mark instanceof Date ? mark.getTime() : Number(mark);
    await execute({ scheduledAt: mark, jitterMin: plan?.jitterMin ?? null, resume: true });
    schedule();
  }

  /** Boot: finish an interrupted round before scheduling the next one. */
  const booted = (async () => {
    if (!state.enabled) {
      logger.warn?.(`keeper: disabled in ${cfg.mode} mode (no vault secret, no rounds)`);
      return;
    }
    try {
      // A restart must not re-run a mark this keeper already handled: after a
      // round that fired early, the clock alone would still point at it.
      const latest = await db.latestRound?.();
      const handled = latest?.scheduledAt ? Date.parse(latest.scheduledAt) : NaN;
      if (Number.isFinite(handled)) state.lastMark = handled;
    } catch (err) {
      logger.warn?.(`keeper: could not read the last round's mark: ${err.message}`);
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
      if (state.openTimer !== null) clearTimer(state.openTimer);
      state.timer = null;
      state.openTimer = null;
      logger.info?.('keeper: stopped');
    },
    /** ISO time of the next scheduled round, or null when the keeper is off. */
    nextRoundAt() {
      if (!state.enabled || state.stopped) return null;
      return state.next ? state.next.fireAt.toISOString() : planNext(cfg, now(), state.lastMark).fireAt.toISOString();
    },
    /** Run a round right now (admin route / CLI), outside the schedule. */
    runNow(extra = {}) {
      return execute({ resume: true, ...extra });
    },
    /**
     * Take the open snapshot for the current cycle right now. The scheduler
     * already does this on its own; this is for an operator who booted the
     * keeper late and wants the cycle judged on the full rule anyway.
     */
    async takeOpenSnapshotNow(extra = {}) {
      const plan = state.next ?? planNext(cfg, now(), state.lastMark);
      const open = planOpenSnapshot(cfg, plan.mark);
      const result = await takeOpenSnapshot({
        cfg,
        db,
        holdersService: deps.holdersService ?? deps.services?.holders ?? null,
        rpc: deps.rpc ?? deps.services?.rpc ?? null,
        logger,
        now,
        roundId: open.roundId,
        cycleStart: open.cycleStart,
        scheduledFor: open.at,
        ...extra,
      });
      if (result?.taken) {
        state.openSnapshotsTaken += 1;
        state.lastOpenRoundId = open.roundId;
        state.lastOpenAt = result.snapshot?.takenAt ?? null;
        state.lastOpenHolderCount = result.snapshot?.holderCount ?? null;
      }
      return result;
    },
    status() {
      // Between boot and the first schedule() there is no armed timer yet, but
      // the next round is still knowable — compute it rather than report null.
      const next = state.next ?? (state.enabled && !state.stopped ? planNext(cfg, now(), state.lastMark) : null);
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
        antiCheat: antiCheatEnabled(cfg),
        openSnapshotWindowMin: openWindowMinFor(cfg),
        openSnapshotArmed: state.openTimer !== null,
        nextOpenSnapshotRoundId: state.nextOpen && !state.stopped ? state.nextOpen.roundId : null,
        nextOpenSnapshotAt: state.nextOpen && !state.stopped ? state.nextOpen.at.toISOString() : null,
        nextOpenSnapshotStatus: state.nextOpen && !state.stopped ? state.nextOpen.status : null,
        openSnapshotsTaken: state.openSnapshotsTaken,
        lastOpenSnapshotRoundId: state.lastOpenRoundId,
        lastOpenSnapshotAt: state.lastOpenAt,
        lastOpenSnapshotHolders: state.lastOpenHolderCount,
        lastOpenSnapshotError: state.lastOpenError,
        lastMark: state.lastMark === null ? null : new Date(state.lastMark).toISOString(),
        lastRoundId: state.lastRoundId,
        lastStatus: state.lastStatus,
        lastFinishedAt: state.lastFinishedAt,
        lastError: state.lastError,
      };
    },
  };
}

export default start;
