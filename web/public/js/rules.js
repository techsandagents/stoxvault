/**
 * STOXVAULT — the drop rules, in words.
 *
 * Pure functions, no DOM and no fetch: every sentence the page says about how a
 * round decides who gets paid is derived here from `/api/config`, so the copy
 * cannot drift from the server that is actually running. A flag the server did
 * not send produces no claim at all — the caller keeps the shipped wording.
 */

import { num } from './format.js';

/** The ticker shown before the coin exists. Never a mint, never a placeholder. */
export const FALLBACK_TICKER = '$STOXVAULT';

/** `60` → `an hour`, `90` → `90 minutes`, `120` → `2 hours`. */
export function windowPhrase(minutes) {
  const m = num(minutes);
  if (m === null || !Number.isFinite(m) || m <= 0) return null;
  if (m % 60 !== 0) return `${m} minutes`;
  const hours = m / 60;
  return hours === 1 ? 'an hour' : `${hours} hours`;
}

/**
 * The same duration, but as a bare noun phrase that reads correctly after an
 * ordinal: "the first hour", not "the first an hour".
 */
export function windowNoun(minutes) {
  const m = num(minutes);
  if (m === null || !Number.isFinite(m) || m <= 0) return null;
  if (m % 60 !== 0) return `${m} minutes`;
  const hours = m / 60;
  return hours === 1 ? 'hour' : `${hours} hours`;
}

/**
 * Step 2 of "How it works".
 *
 * @param {object} config the `/api/config` document
 * @returns {{title: string, before: string, hours: string, after: string}|null}
 *   null when the server reported no `antiCheat` flag or no interval — the
 *   caller then leaves the shipped markup alone rather than inventing a rule.
 *   `before`/`hours`/`after` are split so the caller can keep the
 *   `#step-interval` span between them.
 */
export function snapshotRuleCopy(config) {
  const rules = config?.rules || {};
  const hours = num(config?.intervalHours) ?? num(rules.intervalHours);
  const antiCheat = rules.antiCheat;
  if (hours === null || typeof antiCheat !== 'boolean') return null;

  const jitter = num(rules.jitterMin);
  // Names the drop specifically: with two snapshots in play, "the exact moment"
  // alone would read as though this offset described the opening one too.
  const jitterSentence =
    jitter === null ? '' : ` The drop itself lands at a random offset within ±${jitter} minutes of the mark.`;

  if (!antiCheat) {
    return {
      title: 'A snapshot is taken',
      before: 'Every ',
      hours: String(hours),
      after: ` hours.${jitterSentence || ' The exact moment is not announced, so it cannot be gamed.'}`,
    };
  }

  // The opening snapshot lands inside the first `openSnapshotWindowMin` minutes
  // AFTER the cycle begins — five hours before the drop on a six-hour cycle, not
  // shortly before it. Saying "an hour before the mark" would describe a rule
  // that lets someone buy four hours in and still collect, which is the exact
  // behaviour this feature exists to stop.
  const opening = windowNoun(rules.openSnapshotWindowMin);
  const when = opening ? `in the first ${opening} of the cycle` : 'when the cycle opens';
  return {
    title: 'Two snapshots, one whole cycle',
    before: 'Every ',
    hours: String(hours),
    after:
      ` hours — and a wallet has to hold for the whole cycle to be paid for it. ` +
      `One snapshot is taken ${when}, at a moment that is not announced, and one at the drop. ` +
      `Your weight is the smaller of the two balances. ` +
      `Buy after the opening snapshot and you earn nothing that round: your first drop is the round after. ` +
      `Sell before the drop and you earn nothing either.${jitterSentence}`,
  };
}

/**
 * The one-line version under the rounds ledger.
 *
 * @returns {string|null} null when the server reported no jitter, so the shipped
 *   sentence stays.
 */
export function ledgerFootNote(config) {
  const rules = config?.rules || {};
  // num() and not Number(): Number(null) is 0, which would print "±0 minutes"
  // from a jitter the server never reported.
  const jitter = num(rules.jitterMin);
  if (jitter === null) return null;

  if (rules.antiCheat !== true) {
    return `Times are UTC. The snapshot is taken at a random offset within ±${jitter} minutes of each mark.`;
  }
  const openWindow = num(rules.openSnapshotWindowMin);
  const when = openWindow === null ? 'when its cycle opens' : `in the first ${openWindow} minutes of its cycle`;
  // The ±jitter belongs to the drop only. The opening snapshot's timing is random
  // across its whole window, so describing both with the same offset would be wrong.
  return (
    `Times are UTC. Each round takes two snapshots — one ${when}, at an unannounced moment, and one at the ` +
    `drop, itself at a random offset within ±${jitter} minutes of the mark — and pays every wallet on the ` +
    `smaller of the two balances.`
  );
}

/**
 * What the nav's contract-address button should say and whether it may copy.
 *
 * Before launch `config.token.mint` is null: the button is disabled, its label
 * still names the ticker, and its title says why. `mint` is the only thing the
 * click handler is ever allowed to put on the clipboard.
 *
 * @returns {{ticker: string, mint: string|null, disabled: boolean, label: string}}
 */
export function coinButtonState(config) {
  const token = config?.token || null;
  const symbol = typeof token?.symbol === 'string' ? token.symbol.trim().replace(/^\$/, '') : '';
  const ticker = symbol ? `$${symbol}` : FALLBACK_TICKER;
  const mint = typeof token?.mint === 'string' && token.mint.trim() ? token.mint.trim() : null;
  return {
    ticker,
    mint,
    disabled: mint === null,
    label: mint ? `Copy the ${ticker} contract address` : `The ${ticker} contract address is not available until launch`,
  };
}

export default { snapshotRuleCopy, ledgerFootNote, coinButtonState, windowPhrase, FALLBACK_TICKER };
