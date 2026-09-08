/**
 * STOXVAULT — the call-to-action banner, decided in pure functions.
 *
 * The banner sits under the header on every tab and is the one element on the
 * page that actively asks somebody to do something, so what it says is derived
 * here — with no DOM and no fetch — from exactly two documents:
 *
 *   /api/config   token.launched, defaultBasket.picks, rules.eligibleBps
 *   /api/me       balance.eligible, balance.thresholdUi, prefs / picksSource
 *
 * Three rules govern every branch below, and they are why so much of this file
 * is refusals rather than copy:
 *
 *   1. A missing field is not a licence to guess. Eligibility that the server
 *      did not state produces NO banner, not an optimistic one. The same goes
 *      for "you have picked": `effectivePicks` is what a round would buy for
 *      you, which is the DEFAULT when you have chosen nothing, so it is never
 *      on its own evidence of a choice.
 *   2. Picking changes WHICH stocks a share buys, never HOW MUCH. Any sentence
 *      that could be read as "pick and get more" is a lie about the product.
 *   3. Under the full-cycle rule a basket saved now applies from the NEXT round
 *      onward, never to one already under way, so the copy says so.
 *
 * The five states, and what each one is for:
 *
 *   connect  nobody is connected — lead with what the product does
 *   choose   connected, eligible, nothing saved — the state that matters
 *   saved    connected, eligible, a basket saved — a receipt, not an advert
 *   below    connected, under the threshold — a fact, not a nudge to buy
 *   none     not launched, or the API did not say enough to be honest
 */

import { fmtInt, num } from './format.js';

/** Where a dismissal is remembered. Internal identifier; keeps the old prefix. */
export const DISMISS_KEY = 'stockdrop:cta-dismissed';

/** Every state the banner can be in. `none` renders nothing at all. */
export const CTA_STATES = ['none', 'connect', 'choose', 'saved', 'below'];

const NONE = Object.freeze({
  state: 'none',
  key: null,
  defaultText: null,
  picksText: null,
  thresholdText: null,
});

/* ------------------------------------------------------------- basket text -- */

/**
 * A list of `{symbol, pct}` picks in words: `100% SPCXx`, `NVDAx, TSLAx — 20%
 * each`, `NVDAx 60%, TSLAx 40%`.
 *
 * @returns {string|null} null when the list names nothing usable, so the caller
 *   can fall back to the generic phrase rather than print a half-basket.
 */
export function basketText(picks) {
  const list = Array.isArray(picks) ? picks.filter((p) => p && typeof p.symbol === 'string' && p.symbol.trim()) : [];
  if (list.length === 0) return null;

  if (list.length === 1) {
    const pct = num(list[0].pct);
    return pct === null ? list[0].symbol : `${pct}% ${list[0].symbol}`;
  }
  const first = num(list[0].pct);
  if (first !== null && list.every((p) => num(p.pct) === first)) {
    return `${list.map((p) => p.symbol).join(', ')} — ${first}% each`;
  }
  return list.map((p) => `${p.symbol} ${num(p.pct) === null ? '' : `${num(p.pct)}%`}`.trim()).join(', ');
}

/**
 * The wallet's own saved picks, named.
 *
 * Saved picks arrive as `{mint, pct}` — the symbol lives in the universe — so a
 * lookup is handed in. If a single pick cannot be named (its stock fell out of
 * the top 20, or the universe has not loaded) the whole sentence is dropped
 * rather than printed with a mint or a gap in it.
 *
 * @param {Array<{mint: string, pct: number}>} picks
 * @param {(mint: string) => string|null} [symbolOf]
 * @returns {string|null}
 */
export function savedPicksText(picks, symbolOf) {
  if (!Array.isArray(picks) || picks.length === 0) return null;
  const named = [];
  for (const pick of picks) {
    const symbol = typeof symbolOf === 'function' ? symbolOf(pick?.mint) : null;
    if (typeof symbol !== 'string' || !symbol.trim()) return null;
    named.push({ symbol: symbol.trim(), pct: pick?.pct });
  }
  return basketText(named);
}

/* ------------------------------------------------------------- saved picks -- */

/**
 * Has this wallet actually chosen a basket?
 *
 * `prefs.picks` is the direct answer. `picksSource` is the server's own label
 * for where the effective basket came from, and only `prefs` / `prefs-adjusted`
 * mean the holder chose it — `default` means they did not, so `effectivePicks`
 * on its own must never be read as a choice.
 *
 * @returns {Array<{mint: string, pct: number}>|null}
 */
export function savedPicks(me) {
  const stored = Array.isArray(me?.prefs?.picks) ? me.prefs.picks.filter((p) => p && p.mint) : [];
  if (stored.length > 0) return stored;

  const source = me?.picksSource;
  if (source === 'prefs' || source === 'prefs-adjusted') {
    const effective = Array.isArray(me?.effectivePicks) ? me.effectivePicks.filter((p) => p && p.mint) : [];
    if (effective.length > 0) return effective;
  }
  return null;
}

/* --------------------------------------------------------------- threshold -- */

/**
 * How much of the supply a wallet needs, stated as a fact.
 *
 * Both halves are optional and either one alone is enough to say something
 * true. With neither, the "not eligible" banner has nothing to report and the
 * caller shows nothing instead of a sentence with a hole in it.
 */
export function thresholdText(config, me) {
  const ui = num(me?.balance?.thresholdUi) ?? num(config?.rules?.eligibleThresholdUi);
  const bps = num(config?.rules?.eligibleBps);
  const rawSymbol = config?.token?.symbol;
  const symbol = typeof rawSymbol === 'string' && rawSymbol.trim() ? rawSymbol.trim().replace(/^\$/, '') : '';

  const amount = ui === null ? null : `${fmtInt(ui)}${symbol ? ` ${symbol}` : ''}`;
  const share = bps === null ? null : `${bps / 100}% of supply`;

  if (amount && share) return `${amount} — ${share}`;
  return amount || share || null;
}

/* ------------------------------------------------------------- the decision -- */

/**
 * Which banner state the API says this visitor is in.
 *
 * @param {object} input
 * @param {object|null} input.config    the `/api/config` document
 * @param {object|null} [input.me]      the `/api/me` document
 * @param {boolean} [input.connected]   is a wallet session live
 * @param {(mint: string) => string|null} [input.symbolOf]
 * @returns {{state: string, key: string|null, defaultText: string|null,
 *            picksText: string|null, thresholdText: string|null}}
 */
export function ctaState({ config, me = null, connected = false, symbolOf = null } = {}) {
  // No config, or a config that could not be read, is state E. So is a coin
  // that has not launched: there is nothing to hold, so nothing to ask for.
  if (!config || typeof config !== 'object') return NONE;
  if (config.token?.launched !== true) return NONE;

  const defaultText = basketText(config?.defaultBasket?.picks);

  if (!connected) return { ...NONE, state: 'connect', key: 'connect', defaultText };

  // Connected, but the server has not described this wallet yet. Saying
  // anything about it would be saying it without evidence.
  if (!me || typeof me !== 'object') return NONE;

  const eligible = typeof me.balance?.eligible === 'boolean' ? me.balance.eligible : null;
  if (eligible === null) return NONE; // never claim, or deny, eligibility the API did not state

  const picks = savedPicks(me);
  const picksText = savedPicksText(picks, symbolOf);

  if (eligible === false) {
    const threshold = thresholdText(config, me);
    // This state exists to state the threshold. Without one it has no content,
    // and "you are not eligible" on its own is a scold rather than information.
    if (!threshold) return NONE;
    return { state: 'below', key: 'below', defaultText, picksText, thresholdText: threshold };
  }

  if (picks) return { state: 'saved', key: 'saved', defaultText, picksText, thresholdText: null };
  return { state: 'choose', key: 'choose', defaultText, picksText: null, thresholdText: null };
}

/* ------------------------------------------------------------- dismissal --- */

/** The stored value → a set of dismissed state keys. Never throws. */
export function parseDismissed(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return new Set();
  return new Set(
    raw
      .split(',')
      .map((part) => part.trim())
      .filter((part) => CTA_STATES.includes(part)),
  );
}

/** A set of dismissed keys → the stored value. */
export function serialiseDismissed(set) {
  return [...(set || [])].filter((key) => CTA_STATES.includes(key)).join(',');
}

/**
 * Dismissal is per state, not per page.
 *
 * Someone who waved away the "connect a wallet" prompt has not been told that
 * they qualify and have not chosen — that is new information, so it is shown.
 */
export function shouldShow(view, dismissed) {
  if (!view || view.state === 'none' || !view.key) return false;
  const set = dismissed instanceof Set ? dismissed : parseDismissed(dismissed);
  return !set.has(view.key);
}

/* ------------------------------------------------------------------ copy --- */

/**
 * The words, per state.
 *
 * Nothing here may state or imply a return, a yield, a price, or that picking
 * pays more than the default — it does not; it changes which stocks arrive.
 *
 * @param {object} view the result of `ctaState`
 * @param {object} [options]
 * @param {string|null} [options.countdown] `4h 36m`, or null when unknown
 * @returns {{title: string, text: string, meta: string|null,
 *            primary: {label: string, action: string}|null,
 *            secondary: {label: string, action: string}|null}|null}
 */
export function ctaCopy(view, { countdown = null } = {}) {
  if (!view || view.state === 'none') return null;
  const standard = view.defaultText ? `the standard basket, currently ${view.defaultText}` : 'the standard basket';

  switch (view.state) {
    case 'connect':
      return {
        title: 'The stocks you receive are yours to choose',
        text:
          `Fees from the coin buy real tokenised stocks every few hours and send them straight to holders' ` +
          `wallets — nothing to claim. Save no picks and ${standard} is used. Choosing changes which stocks ` +
          `arrive, not how much is spent.`,
        meta: null,
        primary: { label: 'Connect wallet', action: 'connect' },
        secondary: { label: 'See the basket', action: 'basket' },
      };

    case 'choose':
      return {
        title: 'You qualify — and you have not picked any stocks',
        text:
          `Your next drop will use ${standard}. Choose two to five stocks and your share buys those instead: ` +
          `it changes which stocks arrive, not how much is spent. A basket saved now counts from the next ` +
          `round on, never one already under way.`,
        meta: countdown ? `Next round in ${countdown}.` : null,
        primary: { label: 'Choose your stocks', action: 'basket' },
        secondary: null,
      };

    case 'saved':
      return {
        title: 'Your basket is saved',
        text: view.picksText
          ? `${view.picksText} — used from the next round on.`
          : 'Your picks are stored, and are used from the next round on.',
        meta: null,
        primary: null,
        secondary: { label: 'Edit basket', action: 'basket' },
      };

    case 'below':
      return {
        title: 'This wallet is under the threshold',
        text:
          `A wallet needs ${view.thresholdText} to be counted in a round, and this one holds less than that. ` +
          (view.picksText
            ? `Your saved basket stays as it is and applies to whichever rounds this wallet does qualify for.`
            : `A basket saved now still applies to whichever rounds this wallet does qualify for.`),
        meta: null,
        primary: null,
        secondary: { label: view.picksText ? 'Edit basket' : 'Set your basket', action: 'basket' },
      };

    default:
      return null;
  }
}

export default { ctaState, ctaCopy, shouldShow, parseDismissed, serialiseDismissed, savedPicks, basketText };
