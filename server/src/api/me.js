/**
 * STOXVAULT — the signed-in wallet's own view.
 *
 * `GET /api/me` answers the three questions a holder actually has: do I qualify,
 * what am I buying, and what is my share of the next drop. Every one of those
 * can be honestly unknown before launch, and says so instead of guessing.
 *
 * SINCE THE MOVE TO ROBINHOOD WALLET there is a fourth, larger honesty problem,
 * and `attribution` exists for it. Sign-in is now an EVM address; holder
 * balances, eligibility and every payout still read a SOLANA token, and the
 * keeper still pays out on Solana. An EVM address can never appear in a Solana
 * holder snapshot, so a connected wallet cannot be eligible and cannot be paid —
 * whatever else is true. This file therefore refuses to read a balance at all
 * while the two chains disagree, rather than reading one and finding nothing:
 * "we did not look, and here is why" is the truth, and "we looked and you hold
 * zero" is not.
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

/**
 * Where the keeper leaves the snapshot it takes when a cycle's window opens.
 * The first key is the one this project writes; the second is accepted so an
 * older or hand-written document still reads.
 */
const OPEN_SNAPSHOT_KV_KEYS = ['snapshot:open', 'open-snapshot'];

const isDigits = (v) => typeof v === 'string' && /^\d+$/.test(v);

/**
 * A wallet's balance inside a snapshot document.
 * `found` is the honest distinction between "held nothing" and "was not there".
 * @returns {{found: boolean, raw: string|null}}
 */
export function snapshotBalanceOf(snapshot, wallet) {
  if (!snapshot || typeof snapshot !== 'object') return { found: false, raw: null };
  const rows = Array.isArray(snapshot.holders) ? snapshot.holders : null;
  if (rows) {
    for (const row of rows) {
      if (row && row.wallet === wallet) {
        const raw = String(row.balance ?? row.raw ?? '');
        return { found: true, raw: isDigits(raw) ? raw : null };
      }
    }
    return { found: false, raw: null };
  }
  const map = snapshot.balances;
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    if (Object.prototype.hasOwnProperty.call(map, wallet)) {
      const raw = String(map[wallet] ?? '');
      return { found: true, raw: isDigits(raw) ? raw : null };
    }
    return { found: false, raw: null };
  }
  // A document with no holder rows at all cannot answer the question.
  return { found: false, raw: null };
}

/**
 * Is this opening snapshot the one for the cycle that is about to close?
 *
 * A snapshot from a previous cycle must never be presented as this cycle's, so
 * anything taken on or before the previous mark (less the scheduler's jitter) is
 * treated as absent rather than stale-but-usable.
 */
export function isCurrentCycleSnapshot(snapshot, cfg, nowMs) {
  const takenMs = Date.parse(snapshot?.takenAt ?? '');
  if (!Number.isFinite(takenMs)) return false;
  const markMs = cfg.nextRoundAt(nowMs).getTime();
  if (takenMs > nowMs + 60_000) return false; // dated in the future: not trustworthy
  const mark = new Date(markMs).toISOString();
  for (const field of ['mark', 'roundMark', 'scheduledAt', 'forRoundAt']) {
    const value = snapshot?.[field];
    if (typeof value === 'string' && value === mark) return true;
  }
  const cycleStartMs = markMs - cfg.intervalHours * 3600_000 - cfg.roundJitterMin * 60_000;
  return takenMs > cycleStartMs;
}

/** Read the opening snapshot for the current cycle, or null when there is none. */
async function currentOpenSnapshot({ cfg, db, nowMs }) {
  const candidates = [];
  if (typeof db.getKV === 'function') {
    for (const key of OPEN_SNAPSHOT_KV_KEYS) {
      try {
        const doc = await db.getKV(key);
        if (doc && typeof doc === 'object') candidates.push(doc);
      } catch {
        // A KV store that cannot answer means "unknown", not "no snapshot".
      }
    }
  }
  if (candidates.length === 0 && typeof db.latestRound === 'function') {
    try {
      const latest = await db.latestRound();
      const doc = latest?.openSnapshot ?? latest?.snapshots?.open ?? null;
      if (doc && typeof doc === 'object') candidates.push(doc);
    } catch {
      // same: absence of evidence only.
    }
  }
  for (const doc of candidates) {
    if (isCurrentCycleSnapshot(doc, cfg, nowMs)) return doc;
  }
  return null;
}

/** raw base units -> ui number for the memecoin's decimals. */
function toUi(raw, decimals) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const d = Number.isInteger(decimals) && decimals >= 0 ? decimals : 0;
  const padded = raw.padStart(d + 1, '0');
  const whole = padded.slice(0, padded.length - d);
  const frac = d > 0 ? padded.slice(padded.length - d) : '';
  return Number(`${whole}${frac ? `.${frac}` : ''}`);
}

/** Numbers inside a sentence, grouped, never dressed up with false precision. */
function fmtUi(value) {
  return Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 6 }) : String(value);
}

/**
 * Where this wallet stands in the cycle that is about to close.
 *
 * "You get nothing this round" is the one thing anti-cheat introduces that a
 * holder cannot work out for themselves, so every branch here says which of the
 * two balances decided it, in words, and uses null wherever the chain or the
 * keeper has not actually told us something.
 *
 * @param {object} args
 * @param {object} args.cfg
 * @param {string} args.wallet
 * @param {{raw: string, ui: number}|null} args.balance current balance, or null when unreadable
 * @param {object|null} args.openSnapshot this cycle's opening snapshot, or null
 * @param {number} args.nowMs
 */
export function buildCycle({ cfg, wallet, balance, openSnapshot, nowMs }) {
  const antiCheat = Boolean(cfg.antiCheat);
  const windowMin = cfg.openSnapshotWindowMin;
  const markMs = cfg.nextRoundAt(nowMs).getTime();
  const symbol = cfg.tokenSymbol || 'tokens';
  const thresholdUi = cfg.eligibleThresholdUi;

  const cycle = {
    antiCheat,
    windowMin,
    opensAt: new Date(markMs - windowMin * 60_000).toISOString(),
    nextRoundAt: new Date(markMs).toISOString(),
    openSnapshotAt: null,
    openSnapshotHash: null,
    inOpenSnapshot: null,
    openBalanceRaw: null,
    openBalanceUi: null,
    currentBalanceRaw: null,
    currentBalanceUi: null,
    effectiveBalanceRaw: null,
    effectiveBalanceUi: null,
    thresholdRaw: cfg.eligibleThresholdRaw,
    thresholdUi,
    eligible: null,
    note: '',
  };

  if (!cfg.launched) {
    cycle.note = 'The coin has not launched yet, so there is no cycle to stand in and no drop to miss.';
    return cycle;
  }
  if (!balance || !isDigits(balance.raw)) {
    cycle.note = 'Your balance could not be read from the chain just now, so this cycle cannot be judged.';
    return cycle;
  }

  const current = BigInt(balance.raw);
  const threshold = BigInt(cfg.eligibleThresholdRaw);
  cycle.currentBalanceRaw = balance.raw;
  cycle.currentBalanceUi = toUi(balance.raw, cfg.tokenDecimals);

  const belowNote = `You hold ${fmtUi(cycle.currentBalanceUi)} ${symbol}, under the ${fmtUi(thresholdUi)} needed to qualify, so the next round pays you nothing.`;

  if (!antiCheat) {
    cycle.effectiveBalanceRaw = balance.raw;
    cycle.effectiveBalanceUi = cycle.currentBalanceUi;
    cycle.eligible = current >= threshold && current > 0n;
    cycle.note = cycle.eligible
      ? 'Anti-cheat is off: only your balance when the round snapshot is taken counts, and it clears the threshold right now.'
      : belowNote;
    return cycle;
  }

  if (openSnapshot) {
    cycle.openSnapshotAt = typeof openSnapshot.takenAt === 'string' ? openSnapshot.takenAt : null;
    cycle.openSnapshotHash = typeof openSnapshot.hash === 'string' ? openSnapshot.hash : null;
  }

  if (current < threshold) {
    // Whatever the opening snapshot said, the round pays on the smaller of the
    // two, and the smaller one is already under the bar.
    cycle.eligible = false;
    if (openSnapshot) {
      const seen = snapshotBalanceOf(openSnapshot, wallet);
      if (seen.found && seen.raw === null) {
        cycle.inOpenSnapshot = null;
      } else {
        cycle.inOpenSnapshot = seen.found;
        const open = seen.found ? BigInt(seen.raw) : 0n;
        cycle.openBalanceRaw = open.toString();
        cycle.openBalanceUi = toUi(cycle.openBalanceRaw, cfg.tokenDecimals);
        const effective = open < current ? open : current;
        cycle.effectiveBalanceRaw = effective.toString();
        cycle.effectiveBalanceUi = toUi(cycle.effectiveBalanceRaw, cfg.tokenDecimals);
      }
    }
    cycle.note = belowNote;
    return cycle;
  }

  if (!openSnapshot) {
    cycle.note =
      `No opening snapshot has been taken for this cycle yet. When one is, the round pays on the smaller of what you hold then and at the round itself, `
      + `so holding at least ${fmtUi(thresholdUi)} ${symbol} through the whole window is what qualifies you.`;
    return cycle;
  }

  const seen = snapshotBalanceOf(openSnapshot, wallet);
  cycle.inOpenSnapshot = seen.found;

  if (seen.found && seen.raw === null) {
    // The snapshot names the wallet but not a number we can trust. Say nothing
    // rather than guess a balance.
    cycle.inOpenSnapshot = null;
    cycle.note = 'This cycle’s opening snapshot does not record a readable balance for your wallet, so your standing cannot be judged yet.';
    return cycle;
  }

  const open = seen.found ? BigInt(seen.raw) : 0n;
  cycle.openBalanceRaw = open.toString();
  cycle.openBalanceUi = toUi(cycle.openBalanceRaw, cfg.tokenDecimals);

  const effective = open < current ? open : current;
  cycle.effectiveBalanceRaw = effective.toString();
  cycle.effectiveBalanceUi = toUi(cycle.effectiveBalanceRaw, cfg.tokenDecimals);
  cycle.eligible = effective >= threshold && effective > 0n;

  const openedAt = cycle.openSnapshotAt ? ` (taken ${cycle.openSnapshotAt})` : '';
  if (!seen.found) {
    cycle.note =
      `You were not in this cycle’s opening snapshot${openedAt}, so you bought during the cycle: this round pays you nothing and your first drop is the next one.`;
  } else if (effective < threshold) {
    cycle.note =
      `You held ${fmtUi(cycle.openBalanceUi)} ${symbol} when this cycle opened${openedAt}, under the ${fmtUi(thresholdUi)} needed, so this round pays nothing even though you hold more now.`;
  } else if (current < open) {
    cycle.note =
      `Your balance fell during this cycle, from ${fmtUi(cycle.openBalanceUi)} to ${fmtUi(cycle.currentBalanceUi)} ${symbol}, so the smaller figure is what this round counts.`;
  } else {
    cycle.note =
      `You have held at least ${fmtUi(cycle.openBalanceUi)} ${symbol} all cycle, so you are in for the round about to run.`;
  }
  return cycle;
}

/**
 * Why this wallet can or cannot be credited with a drop.
 *
 * Two independent reasons it cannot, today, and the document names both rather
 * than collapsing them: the token is not set, and the sign-in chain is not the
 * payout chain. `eligible` and `canReceive` are hard `false` here — there is no
 * code path that makes them true while `chainsMatch` is false.
 *
 * @param {object} cfg
 * @returns {{signInChain: string, signInChainId: number, signInChainName: string,
 *            payoutChain: string, chainsMatch: boolean, tokenSet: boolean,
 *            balanceRead: boolean, eligible: false, canReceive: false,
 *            headline: string, note: string}}
 */
export function buildAttribution(cfg) {
  const chainsMatch = Boolean(cfg.walletChainMatchesPayout);
  const tokenSet = Boolean(cfg.launched);
  const chainName = cfg.authChainName || 'Robinhood Chain';
  const chainId = Number.isInteger(cfg.authChainId) ? cfg.authChainId : 4663;

  const reasons = [];
  if (!chainsMatch) {
    reasons.push(
      `you signed in with a ${chainName} address (chain ${chainId}) and every drop is still bought and sent on Solana, `
      + 'so this address cannot appear in a holder snapshot',
    );
  }
  if (!tokenSet) reasons.push('the token is not set, so there is no balance to read and no round to be counted in');

  const note = chainsMatch && tokenSet
    ? 'This wallet is on the same chain as the payouts.'
    : `No drop can be attributed to this wallet yet: ${reasons.join(', and ')}. `
      + 'Your saved basket is kept and will count from the moment the payout side can reach this address. '
      + 'Nothing on this page should be read as saying you will receive anything today.';

  return {
    signInChain: cfg.walletChain || 'evm',
    signInChainId: chainId,
    signInChainName: chainName,
    payoutChain: cfg.payoutChain || 'solana',
    chainsMatch,
    tokenSet,
    balanceRead: chainsMatch && tokenSet,
    eligible: false,
    canReceive: false,
    headline: 'This wallet cannot receive a drop yet',
    note,
  };
}

/**
 * The `me` document, shared by GET /api/me and the response to a successful
 * POST /api/auth/verify (the contract says they are the same object).
 */
export async function buildMe({ cfg, db, services, wallet, now = Date.now }) {
  const { universe, holders, stats } = services;
  const nowMs = now();
  const attribution = buildAttribution(cfg);
  // The ONLY condition under which this server reads a balance for a signed-in
  // wallet. While it is false, nothing below invents one.
  const readable = attribution.balanceRead;

  const [prefs, stocks] = await Promise.all([db.getPrefs(wallet), universe.stocks()]);

  const index = new Map(stocks.map((s) => [s.mint, s]));
  const fallback = defaultPicks(stocks, cfg.rules);
  const basket = effectiveBasket(prefs?.picks ?? null, index, fallback);

  let balance = null;
  if (readable) {
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

  let projected = { shareBps: null, note: attribution.note };
  if (readable) {
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

  const openSnapshot = readable && cfg.antiCheat ? await currentOpenSnapshot({ cfg, db, nowMs }) : null;

  // The cycle verdict is only meaningful for a wallet the snapshots could
  // contain. While they cannot, every field stays null and the note is the
  // attribution note — one explanation, not two competing ones.
  const cycle = readable
    ? buildCycle({ cfg, wallet, balance, openSnapshot, nowMs })
    : { ...buildCycle({ cfg, wallet, balance: null, openSnapshot: null, nowMs }), eligible: null, note: attribution.note };

  return {
    wallet,
    balance,
    attribution,
    prefs: prefs ?? null,
    effectivePicks: basket.picks,
    picksSource: basket.source,
    projected,
    cycle,
    nextRoundAt: cfg.nextRoundAtIso(nowMs),
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
