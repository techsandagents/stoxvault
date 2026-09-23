/**
 * STOXVAULT — the basket configurator.
 *
 * The rules are the engine's, mirrored here so the page can answer instantly and
 * so the sentence the user reads is the same sentence whether the client or the
 * server caught the problem: 2–5 picks, each a whole 10–60, summing to exactly
 * 100, no duplicates, every mint in the current top 20.
 *
 * Saving is a signature, never a transaction. The message names the wallet and
 * the exact picks, so the stored preference is a public artifact anyone can
 * verify against the wallet that claims it.
 */

import * as api from '../api.js';
import * as wallet from '../wallet.js';
import { fmtInt, fmtTokenAmount, monogram, num, DASH } from '../format.js';
import { toast } from './toast.js';

const STEP = 5;

const RULE_TEXT = {
  count: (r) => `Pick between ${r.minPicks} and ${r.maxPicks} stocks.`,
  range: (r) => `Each stock takes a whole number from ${r.minPct}% to ${r.maxPct}%.`,
  sum: () => 'The allocations have to add up to exactly 100%.',
  not_in_universe: () => 'One of those stocks is not in the current top 20 any more.',
  duplicate: () => 'Each stock can only appear once.',
};

/** The rules, defaulted to the contract so the page works before /api/config lands. */
const DEFAULT_RULES = { minPicks: 2, maxPicks: 5, minPct: 10, maxPct: 60, universeSize: 20, defaultBasketSize: 5 };

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

/** Same picks, same order-insensitive contents? */
function samePicks(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const key = (list) =>
    list
      .map((p) => `${p.mint}:${p.pct}`)
      .sort()
      .join('|');
  return key(a) === key(b);
}

/**
 * Which pane `#basket-picks` is allowed to show.
 *
 * A failed `/api/universe` is neither an empty basket nor a ready one. Without a
 * universe the page cannot say whether a pick is still in the top 20, so the
 * error pane — and the retry button inside it — stays up instead of being
 * overwritten by a verdict that was checked against nothing.
 *
 * @param {{universeFailed: boolean, pickCount: number}} arg
 * @returns {'error'|'empty'|'ready'}
 */
export function picksPaneState({ universeFailed, pickCount }) {
  if (universeFailed) return 'error';
  return pickCount > 0 ? 'ready' : 'empty';
}

/**
 * The engine's rules, mirrored (see engine/validate.js). Pure, so the same
 * verdict can be asserted in a test without a DOM.
 *
 * `universeKnown` is the honest half: membership in the top 20 is only
 * knowable when a universe actually loaded. With a failed fetch every mint
 * would look delisted, which is a lie about the picks rather than a report
 * about the price feed — so the check is skipped and the reason is said out
 * loud instead.
 *
 * @returns {{ok: boolean, code: string|null, text: string, level: string, badMints: Set<string>, total: number}}
 */
export function validateBasket(list, { rules, index = null, universeKnown = true, universeFailed = false } = {}) {
  const badMints = new Set();
  const total = list.reduce((acc, p) => acc + (Number(p.pct) || 0), 0);
  const inUniverse = (mint) => Boolean(index && typeof index.has === 'function' && index.has(mint));

  if (list.length === 0) {
    return {
      ok: false,
      code: 'count',
      level: 'info',
      text: `Add ${rules.minPicks} to ${rules.maxPicks} stocks to build a basket.`,
      badMints,
      total,
    };
  }
  if (list.length < rules.minPicks || list.length > rules.maxPicks) {
    return { ok: false, code: 'count', level: 'error', text: RULE_TEXT.count(rules), badMints, total };
  }

  const seen = new Set();
  for (const pick of list) {
    if (seen.has(pick.mint)) {
      badMints.add(pick.mint);
      return { ok: false, code: 'duplicate', level: 'error', text: RULE_TEXT.duplicate(), badMints, total };
    }
    seen.add(pick.mint);
    if (universeKnown && !inUniverse(pick.mint)) {
      badMints.add(pick.mint);
      return { ok: false, code: 'not_in_universe', level: 'error', text: RULE_TEXT.not_in_universe(), badMints, total };
    }
    const pct = Number(pick.pct);
    if (!Number.isInteger(pct) || pct < rules.minPct || pct > rules.maxPct) {
      badMints.add(pick.mint);
      return { ok: false, code: 'range', level: 'error', text: RULE_TEXT.range(rules), badMints, total };
    }
  }

  if (total !== 100) {
    const delta = 100 - total;
    return {
      ok: false,
      code: 'sum',
      level: 'warn',
      text:
        delta > 0
          ? `${delta}% still to allocate. Auto-balance spreads it for you.`
          : `${Math.abs(delta)}% over. Auto-balance takes it back off.`,
      badMints,
      total,
    };
  }

  if (universeFailed) {
    return {
      ok: true,
      code: null,
      level: 'warn',
      text: 'The top 20 did not load, so these picks could not be checked against it.',
      badMints,
      total,
    };
  }

  return { ok: true, code: null, level: 'ok', text: `${list.length} stocks, 100% allocated.`, badMints, total };
}

/** The first boolean the server actually sent, or null if it sent none. */
function firstBool(obj, keys) {
  for (const key of keys) {
    if (typeof obj?.[key] === 'boolean') return obj[key];
  }
  return null;
}

/** The first non-empty string the server actually sent, or null. */
function firstText(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * What `/api/me.cycle` says, read defensively.
 *
 * The anti-cheat rule pays a wallet on the SMALLER of its two snapshot
 * balances, so a wallet that bought mid-cycle earns nothing this round and its
 * first drop is the round after. That is the most confusing state a real holder
 * can be in, so the server's own `note` is preferred whenever it sends one, and
 * a `me` document with no `cycle` object yields no verdict at all.
 *
 * @param {unknown} raw `me.cycle`
 * @returns {{known: boolean, held: boolean|null, note: string|null, showNote: boolean}}
 */
export function readCycle(raw) {
  const cycle = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!cycle) return { known: false, held: null, note: null, showNote: false };

  const held = firstBool(cycle, ['heldFullCycle', 'heldWholeCycle', 'heldFull', 'fullCycle', 'held']);
  const note = firstText(cycle, ['note', 'message', 'detail', 'text']);
  return { known: held !== null, held, note, showNote: Boolean(note) || held === false };
}

/**
 * What `/api/me.attribution` says: can this wallet be credited with a drop, and
 * if not, why not.
 *
 * Sign-in is a Robinhood Chain (EVM) address; holders, eligibility and payouts
 * still read a Solana token. So the answer is no, and this is the one place the
 * page says it. Three rules, and they are all refusals:
 *
 *   - a `me` document with no `attribution` object produces NO claim either way.
 *     An older server that does not send the field must not be read as "fine".
 *     It is read as "say nothing", and the rest of the panel already refuses to
 *     invent a balance.
 *   - `canReceive === true` is the only thing that hides the callout. Anything
 *     else — false, missing, a non-boolean — keeps it up.
 *   - the server's sentence is rendered verbatim. A paraphrase written here
 *     would drift from what the server actually knows.
 *
 * @param {unknown} raw `me.attribution`
 * @returns {{show: boolean, title: string, text: string}}
 */
export function readAttribution(raw) {
  const att = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  const hidden = { show: false, title: '', text: '' };
  if (!att) return hidden;
  if (att.canReceive === true) return hidden;

  const text = firstText(att, ['note', 'message', 'detail', 'text']);
  if (!text) return hidden; // a flag with no explanation is not worth a callout
  return {
    show: true,
    title: firstText(att, ['headline', 'title']) || 'This wallet cannot receive a drop yet',
    text,
  };
}

export function createBasket({ onChange, onConnect, onSaved, onRetry, getStock } = {}) {
  const picksState = document.getElementById('basket-picks');
  const picksList = document.getElementById('basket-picks-list');
  const errorText = document.getElementById('basket-error-text');
  const retryBtn = document.getElementById('btn-basket-retry');
  const emptyDefaultBtn = document.getElementById('btn-empty-default');

  const sourceEl = document.getElementById('basket-source');
  const dirtyBadge = document.getElementById('basket-dirty');
  const totalEl = document.getElementById('basket-total');
  const meterEl = document.getElementById('basket-meter');
  const meterFill = document.getElementById('basket-meter-fill');
  const validationEl = document.getElementById('basket-validation');

  const autoBtn = document.getElementById('btn-autobalance');
  const resetBtn = document.getElementById('btn-reset-basket');
  const revertBtn = document.getElementById('btn-revert-basket');
  const saveBtn = document.getElementById('btn-save-basket');

  const picker = document.getElementById('basket-picker');
  const search = document.getElementById('basket-search');
  const addList = document.getElementById('basket-add-list');
  const addCount = document.getElementById('basket-add-count');

  const projection = document.getElementById('projection');
  const projBalance = document.getElementById('proj-balance');
  const projEligibility = document.getElementById('proj-eligibility');
  const projShare = document.getElementById('proj-share');
  const projNote = document.getElementById('proj-note');
  const projCycleRow = document.getElementById('proj-cycle-row');
  const projCycle = document.getElementById('proj-cycle');
  const projCycleNote = document.getElementById('proj-cycle-note');
  const projCycleNoteTitle = document.getElementById('proj-cycle-note-title');
  const projCycleNoteText = document.getElementById('proj-cycle-note-text');
  const projChainNote = document.getElementById('proj-chain-note');
  const projChainNoteTitle = document.getElementById('proj-chain-note-title');
  const projChainNoteText = document.getElementById('proj-chain-note-text');
  const projSim = document.getElementById('projection-sim');
  const projConnectBtn = document.getElementById('btn-projection-connect');

  const rowTpl = document.getElementById('tpl-pick-row');
  const chipTpl = document.getElementById('tpl-picker-chip');

  if (!picksState || !picksList || !rowTpl) {
    return {
      renderConfig() {},
      renderUniverse() {},
      renderMe() {},
      setMode() {},
      setMeError() {},
      setDisconnected() {},
      setLoading() {},
      setError() {},
      addStock() {},
      togglePick: () => null,
      isPicked: () => false,
      canAdd: () => false,
      picks: () => [],
      mints: () => [],
    };
  }

  let rules = { ...DEFAULT_RULES };
  let universe = []; // the current top 20
  let index = new Map(); // mint -> stock
  let working = []; // [{mint, pct}] — what the UI shows
  let savedPicks = null; // the wallet's stored basket, or null (default)
  // The editor's starting point. It is a VALID basket under the user rules
  // (2-5 stocks, 10-60% each), which the real default deliberately need not be:
  // an operator default of "100% SPCXx" is one stock at 100%, so preloading it
  // would drop the editor into a permanently unsaveable state. So this is a
  // starting suggestion, and `serverDefault` below is what you actually receive
  // if you save nothing. The labelling must not confuse the two.
  let defaultBasket = [];
  let serverDefault = null; // {picks:[{symbol,pct}]} from /api/config.defaultBasket
  let connected = false;
  let me = null;
  let mode = 'DRY_RUN';
  let filter = '';
  let saving = false;
  let loadedUniverse = false;
  let universeFailed = false; // /api/universe rejected: membership is unknowable

  /* ------------------------------------------------------------ validation */

  /** True only when a universe was genuinely fetched and can be trusted. */
  const universeKnown = () => loadedUniverse && !universeFailed;

  /** @returns {{ok: boolean, code: string|null, text: string, level: string, badMints: Set<string>}} */
  function validate(list = working) {
    return validateBasket(list, { rules, index, universeKnown: universeKnown(), universeFailed });
  }

  /* -------------------------------------------------------- basket edits -- */

  /**
   * Spread the difference between the current total and 100 across the picks,
   * respecting the min and max. Works in 5s while everything is a multiple of 5
   * (which is what the steppers produce), and falls back to 1s otherwise.
   */
  function autoBalance(list = working) {
    if (list.length === 0) return list;
    const unit =
      list.every((p) => Number(p.pct) % STEP === 0) && (100 - list.reduce((a, p) => a + p.pct, 0)) % STEP === 0 ? STEP : 1;

    let delta = 100 - list.reduce((acc, p) => acc + (Number(p.pct) || 0), 0);
    let guard = 0;
    while (delta !== 0 && guard < 500) {
      const before = delta;
      for (let i = 0; i < list.length && delta !== 0; i++) {
        const pick = list[i];
        if (delta > 0 && pick.pct + unit <= rules.maxPct) {
          pick.pct += unit;
          delta -= unit;
        } else if (delta < 0 && pick.pct - unit >= rules.minPct) {
          pick.pct -= unit;
          delta += unit;
        }
      }
      if (delta === before) break; // nothing has headroom — leave it invalid and say so
      guard++;
    }
    return list;
  }

  /** An even split that respects the 5% grid: 50/50, 35/35/30, 25×4, 20×5. */
  function evenSplit(mints) {
    const n = mints.length;
    if (n === 0) return [];
    const base = clamp(Math.floor(100 / n / STEP) * STEP, rules.minPct, rules.maxPct);
    const picks = mints.map((mint) => ({ mint, pct: base }));
    return autoBalance(picks);
  }

  /**
   * What a holder who saves nothing actually receives, in words, as the server
   * resolved it. Falls back to a generic phrase rather than naming a basket the
   * server never confirmed.
   */
  function serverDefaultText() {
    const picks = Array.isArray(serverDefault?.picks) ? serverDefault.picks.filter((p) => p && p.symbol) : [];
    if (picks.length === 0) return 'the default basket';
    if (picks.length === 1) return `100% ${picks[0].symbol}`;
    if (picks.every((p) => p.pct === picks[0].pct)) {
      return `${picks.map((p) => p.symbol).join(', ')} at ${picks[0].pct}% each`;
    }
    return picks.map((p) => `${p.symbol} ${p.pct}%`).join(', ');
  }

  function setWorking(next, { rebuild = true } = {}) {
    working = next;
    if (rebuild) render();
    else refreshSummary();
    if (typeof onChange === 'function') onChange(working.map((p) => ({ ...p })));
  }

  function addMint(mint) {
    if (!mint || !index.has(mint)) return false;
    if (working.some((p) => p.mint === mint)) return false;
    if (working.length >= rules.maxPicks) {
      toast({
        kind: 'warn',
        title: 'Basket is full',
        text: `A basket holds at most ${rules.maxPicks} stocks. Remove one first.`,
        key: 'basket-full',
      });
      return false;
    }
    const next = [...working.map((p) => ({ ...p })), { mint, pct: rules.minPct }];
    setWorking(autoBalance(next));
    return true;
  }

  function removeMint(mint) {
    const next = working.filter((p) => p.mint !== mint).map((p) => ({ ...p }));
    setWorking(next.length > 0 ? autoBalance(next) : next);
  }

  function setPct(mint, value, { rebuild = false } = {}) {
    const pick = working.find((p) => p.mint === mint);
    if (!pick) return;
    const n = Number(value);
    pick.pct = Number.isFinite(n) ? clamp(Math.round(n), rules.minPct, rules.maxPct) : rules.minPct;
    if (rebuild) render();
    else refreshSummary();
    if (typeof onChange === 'function') onChange(working.map((p) => ({ ...p })));
  }

  /**
   * The tick in the Top 20 table is a checkbox, so one call has to do both
   * directions. Adding takes the smallest legal percent and auto-balances;
   * removing re-spreads what is left.
   * @returns {'added'|'removed'|null}
   */
  function toggleMint(mint) {
    if (!mint) return null;
    if (working.some((p) => p.mint === mint)) {
      removeMint(mint);
      return 'removed';
    }
    return addMint(mint) ? 'added' : null;
  }

  /* ------------------------------------------------------------- rendering */

  function pickRow(pick, position, invalid) {
    const stock = index.get(pick.mint) || (typeof getStock === 'function' ? getStock(pick.mint) : null);
    const symbol = stock?.symbol || pick.symbol || 'unknown';
    const node = rowTpl.content.firstElementChild.cloneNode(true);

    node.dataset.mint = pick.mint;
    node.dataset.symbol = symbol;

    node.querySelector('[data-field="symbol"]').textContent = symbol;
    const delisted = universeKnown() && !index.has(pick.mint);
    node.querySelector('[data-field="name"]').textContent = stock?.name || (delisted ? 'not in the current top 20' : '');

    const pct = clamp(Number(pick.pct) || 0, 0, 100);
    node.querySelector('[data-field="pctText"]').textContent = `${pick.pct}%`;

    // The only custom property this app sets, and the only way the gold filled
    // half of the slider track is drawn. Required on every render.
    node.style.setProperty('--pct', String(pct));

    // A `range` input handles Arrow/Home/End/PageUp natively at step 5, so
    // there is deliberately no key handler fighting it.
    const input = node.querySelector('[data-field="pct"]');
    input.value = String(pick.pct);
    input.min = String(rules.minPct);
    input.max = String(rules.maxPct);
    input.step = String(STEP);
    input.setAttribute('aria-label', `${symbol} allocation percent`);

    const remove = node.querySelector('[data-action="remove"]');
    remove.setAttribute('aria-label', `Remove ${symbol} from basket`);

    if (invalid) node.classList.add('is-invalid');

    // A saved pick whose stock fell out of the top 20 still counts — the engine
    // re-spreads its share — so say that instead of silently dropping it. Only
    // ever said when a universe actually loaded: an unreachable price feed is
    // not evidence that anything was delisted.
    if (delisted) {
      node.classList.add('is-stale');
      const note = document.createElement('span');
      note.className = 'pick__note';
      note.textContent = 'No longer in the top 20 — its share is spread across your other picks';
      node.appendChild(note);
    }

    node.dataset.position = String(position);
    return node;
  }

  function renderPicks(state) {
    const pane = picksPaneState({ universeFailed, pickCount: working.length });
    if (pane === 'error') {
      // Leave the error pane and its retry button exactly where setError put
      // them. Nothing is rendered against a universe that never arrived.
      picksState.dataset.state = 'error';
      return;
    }
    if (pane === 'empty') {
      picksList.replaceChildren();
      picksState.dataset.state = 'empty';
      return;
    }
    const frag = document.createDocumentFragment();
    working.forEach((pick, i) => frag.appendChild(pickRow(pick, i, state.badMints.has(pick.mint))));
    picksList.replaceChildren(frag);
    picksState.dataset.state = 'ready';
  }

  function renderPicker() {
    if (!addList || !chipTpl || !picker) return;
    if (universeFailed) {
      if (addCount) addCount.textContent = DASH;
      picker.dataset.state = 'error';
      return;
    }
    const taken = new Set(working.map((p) => p.mint));
    const needle = filter.trim().toLowerCase();

    const available = universe.filter((s) => {
      if (!needle) return true;
      return (
        String(s.symbol || '').toLowerCase().includes(needle) || String(s.name || '').toLowerCase().includes(needle)
      );
    });

    if (addCount) {
      const free = universe.filter((s) => !taken.has(s.mint)).length;
      addCount.textContent = universe.length === 0 ? DASH : `${free} of ${universe.length} available`;
    }

    if (!loadedUniverse) {
      picker.dataset.state = 'loading';
      return;
    }
    if (available.length === 0) {
      addList.replaceChildren();
      picker.dataset.state = universe.length === 0 ? 'error' : 'empty';
      return;
    }

    const full = working.length >= rules.maxPicks;
    const frag = document.createDocumentFragment();
    for (const stock of available) {
      const chip = chipTpl.content.firstElementChild.cloneNode(true);
      chip.dataset.mint = stock.mint;
      chip.dataset.symbol = stock.symbol || '';
      chip.querySelector('[data-field="symbol"]').textContent = stock.symbol || DASH;

      const mono = chip.querySelector('[data-field="mono"]');
      const img = chip.querySelector('[data-field="logo"]');
      if (mono) mono.textContent = monogram(stock.symbol);
      if (img && stock.logo) {
        img.src = stock.logo;
        img.alt = '';
        img.hidden = false;
        img.addEventListener('error', () => {
          img.hidden = true;
        });
      }

      const picked = taken.has(stock.mint);
      if (picked) chip.classList.add('is-selected');
      chip.disabled = picked || full;
      chip.setAttribute(
        'aria-label',
        picked ? `${stock.symbol} is in your basket` : `Add ${stock.symbol} to your basket`,
      );
      frag.appendChild(chip);
    }
    addList.replaceChildren(frag);
    picker.dataset.state = 'ready';
  }

  function refreshSummary() {
    const state = validate();

    if (totalEl) {
      totalEl.textContent = `${state.total}%`;
      totalEl.dataset.ok = state.ok ? 'true' : 'false';
    }
    if (meterFill) meterFill.style.width = `${clamp(state.total, 0, 100)}%`;
    if (meterEl) {
      meterEl.dataset.ok = state.ok ? 'true' : 'false';
      meterEl.setAttribute('aria-label', `Allocation total ${state.total} percent of 100`);
    }
    if (validationEl) {
      validationEl.textContent = state.text;
      validationEl.dataset.level = state.level;
    }

    const dirty = savedPicks !== null ? !samePicks(working, savedPicks) : !samePicks(working, defaultBasket);
    // Saving the default basket verbatim is still a meaningful act — it pins
    // your picks so a re-rank cannot change them under you.
    const canSave = savedPicks === null ? true : !samePicks(working, savedPicks);
    if (dirtyBadge) dirtyBadge.hidden = !dirty;
    if (revertBtn) revertBtn.hidden = !(dirty && savedPicks !== null);

    if (sourceEl) {
      sourceEl.textContent = dirty
        ? 'Showing unsaved edits'
        : savedPicks !== null
          ? 'Showing your saved basket'
          : `Showing a starting suggestion — save nothing and you receive ${serverDefaultText()}`;
    }

    if (saveBtn && !saving) {
      if (!connected) {
        saveBtn.textContent = 'Connect to save';
        saveBtn.disabled = false; // it opens the wallet modal instead
      } else {
        saveBtn.textContent = 'Save basket';
        saveBtn.disabled = !state.ok || !canSave;
      }
    }

    if (autoBtn) autoBtn.disabled = working.length === 0 || state.total === 100;
    renderPicker();
    return state;
  }

  function render() {
    const state = validate();
    renderPicks(state);
    refreshSummary();
  }

  /* ------------------------------------------------------------ projection */

  function hideCycle() {
    if (projCycleRow) projCycleRow.hidden = true;
    if (projCycleNote) projCycleNote.hidden = true;
  }

  /**
   * `/api/me.attribution`, painted verbatim into its own callout.
   *
   * The server's sentence is the one rendered, unedited: it is the only place
   * the page says out loud that a connected wallet cannot be paid, and a
   * paraphrase written here would drift from what the server actually knows.
   */
  function renderChainNote(attribution) {
    if (!projChainNote) return;
    const state = readAttribution(attribution);
    projChainNote.hidden = !state.show;
    if (!state.show) return;
    if (projChainNoteTitle) projChainNoteTitle.textContent = state.title;
    if (projChainNoteText) projChainNoteText.textContent = state.text;
  }

  /**
   * The `cycle` object from `/api/me`, painted into the projection panel: did
   * this wallet hold across the whole six-hour cycle, and — the part a real
   * holder trips over — the "you bought this cycle, so your first drop is the
   * round after" case. The reading itself is `readCycle`, above.
   */
  function renderCycle(raw) {
    const { known, held, note, showNote } = readCycle(raw);

    if (projCycleRow) projCycleRow.hidden = !known;
    if (projCycle && held !== null) {
      projCycle.textContent = held
        ? 'Yes — counted at the smaller of the two snapshots'
        : 'No — not for the cycle running now';
    }

    if (projCycleNote) projCycleNote.hidden = !showNote;
    if (!showNote) return;

    if (projCycleNoteTitle) {
      projCycleNoteTitle.textContent = held === false ? 'Your first drop is the next round' : 'How this cycle is counted';
    }
    if (projCycleNoteText) {
      projCycleNoteText.textContent =
        note ||
        'A wallet is weighted by the smaller of its two snapshot balances, so a balance that was not held for the whole cycle earns nothing from this round. Hold it through the next drop and it counts from then on.';
    }
  }

  function renderProjection() {
    if (!projection) return;

    if (!connected || !me) {
      projection.dataset.state = 'empty';
      if (projSim) projSim.hidden = true;
      hideCycle();
      renderChainNote(null);
      return;
    }

    if (projSim) projSim.hidden = mode === 'LIVE';

    renderChainNote(me.attribution);

    const balance = me.balance;
    if (projBalance) {
      if (!balance) {
        projBalance.textContent = `${DASH} (token not launched)`;
      } else {
        const symbol = me.tokenSymbol || '';
        projBalance.textContent = `${fmtTokenAmount(balance.raw, balance.decimals ?? me.tokenDecimals ?? 6, {
          maxDecimals: 2,
        })}${symbol ? ` ${symbol}` : ''}`;
        projBalance.title = balance.raw ? `${balance.raw} base units` : '';
      }
    }

    if (projEligibility) {
      // `canReceive: false` is a verdict the server has actually reached, so it
      // outranks "unknown until launch" — which would read as "maybe, later
      // today" for a wallet that is on the wrong chain entirely.
      if (me.attribution && me.attribution.canReceive === false) {
        projEligibility.textContent = balance ? 'No — this wallet cannot be paid yet' : 'No — not on the payout chain';
      } else if (!balance) projEligibility.textContent = 'Unknown until launch';
      else if (balance.eligible) projEligibility.textContent = 'Yes';
      else projEligibility.textContent = `No — need ${fmtInt(balance.thresholdUi)}`;
    }

    if (projShare) {
      const bps = me.projected?.shareBps;
      projShare.textContent = bps === null || bps === undefined ? DASH : `${(bps / 100).toFixed(2)}% of the pool`;
    }

    // The pool figure used to sit here, straight from /api/vault. It was
    // removed with the vault card: printing it would republish the balance in
    // the one place it was not being looked for. The share percentage below
    // stays — it says how much of the pool is yours without saying how big the
    // pool is.

    renderCycle(me.cycle);

    if (projNote) {
      const parts = [];
      if (me.projected?.note) parts.push(me.projected.note);
      if (mode !== 'LIVE') {
        parts.push(
          mode === 'READ_ONLY'
            ? 'The server has no vault key, so no round can run: these figures are read-only.'
            : 'The server is in dry run, so any round it publishes is simulated — nothing is sent on chain.',
        );
      }
      projNote.textContent = parts.join(' ') || 'Amounts are estimates until the round runs.';
    }

    projection.dataset.state = 'ready';
  }

  /* ------------------------------------------------------------- saving -- */

  /**
   * The text the wallet signs. It names the wallet and the exact allocation, so
   * the stored preference stands on its own as a public record.
   */
  function prefsMessage(walletAddress, picks) {
    const body = picks
      .slice()
      .sort((a, b) => b.pct - a.pct || (index.get(a.mint)?.symbol || '').localeCompare(index.get(b.mint)?.symbol || ''))
      .map((p) => `${index.get(p.mint)?.symbol || p.mint} ${p.pct}%`)
      .join(', ');
    return [
      'STOXVAULT',
      'Set my basket.',
      'This is not a transaction. Nothing leaves your wallet.',
      `Wallet: ${walletAddress}`,
      `Basket: ${body}`,
      `Updated: ${new Date().toISOString()}`,
    ].join('\n');
  }

  async function save() {
    if (!connected) {
      if (typeof onConnect === 'function') onConnect();
      return;
    }
    const state = validate();
    if (!state.ok) {
      if (validationEl) validationEl.dataset.level = 'error';
      return;
    }

    saving = true;
    const address = api.session.wallet;
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Signing…';
    }

    // A signature is preferred (the section promises one) but a session restored
    // across a reload may have no live wallet to sign with. In that case the
    // basket still saves under the bearer token, and the user is told plainly.
    let signature = null;
    let message = null;
    let unsigned = false;
    try {
      const ready = wallet.canSign() || (await wallet.ensureSigner(address, { prompt: true }));
      if (ready) {
        message = prefsMessage(address, working);
        const signed = await wallet.signMessage(message);
        signature = signed.signature;
      } else {
        unsigned = true;
      }
    } catch (err) {
      if (err instanceof wallet.WalletError && err.code === 'rejected') {
        saving = false;
        if (saveBtn) saveBtn.textContent = 'Save basket';
        refreshSummary();
        toast({ kind: 'warn', title: 'Not saved', text: 'You cancelled the signature, so nothing was saved.' });
        return;
      }
      unsigned = true;
      signature = null;
      message = null;
    }

    try {
      const picks = working.map((p) => ({ mint: p.mint, pct: p.pct }));
      const saved = await api.putPrefs({ picks, signature, message });
      savedPicks = Array.isArray(saved?.picks) ? saved.picks.map((p) => ({ mint: p.mint, pct: p.pct })) : picks;
      working = savedPicks.map((p) => ({ ...p }));
      saving = false;
      if (saveBtn) {
        saveBtn.textContent = 'Saved';
        setTimeout(() => {
          if (!saving) refreshSummary();
        }, 1600);
      }
      render();
      toast({
        kind: unsigned ? 'warn' : 'success',
        title: unsigned ? 'Saved without a signature' : 'Basket saved',
        text: unsigned
          ? 'Your session saved it, but the wallet did not sign it. Reconnect to store a signed copy.'
          : 'It applies from the next snapshot onward.',
      });
      if (typeof onSaved === 'function') onSaved(savedPicks);
    } catch (err) {
      saving = false;
      const code = err instanceof api.ApiError ? err.pickCode : null;
      const text =
        code && RULE_TEXT[code]
          ? RULE_TEXT[code](rules)
          : api.errorText(err, 'The basket could not be saved.');
      if (validationEl) {
        validationEl.textContent = text;
        validationEl.dataset.level = 'error';
      }
      toast({ kind: 'error', title: 'Not saved', text, onRetry: () => save() });
      refreshSummary();
    }
  }

  async function resetToDefault() {
    const wasSaved = savedPicks !== null;
    working = defaultBasket.map((p) => ({ ...p }));

    if (connected && wasSaved) {
      try {
        await api.deletePrefs();
        savedPicks = null;
        toast({ kind: 'success', title: 'Back to the default basket', text: 'Your saved picks were removed.' });
        if (typeof onSaved === 'function') onSaved(null);
      } catch (err) {
        toast({ kind: 'error', title: 'Could not reset', text: api.errorText(err), onRetry: () => resetToDefault() });
      }
    }
    render();
    if (typeof onChange === 'function') onChange(working.map((p) => ({ ...p })));
  }

  /* ------------------------------------------------------------- events -- */

  picksList.addEventListener('click', (event) => {
    const row = event.target.closest('.pick[data-mint]');
    if (!row) return;
    if (event.target.closest('[data-action="remove"]')) removeMint(row.dataset.mint);
  });

  // Live drag. The row is NOT rebuilt here — that would tear the slider out
  // from under the pointer — so the three things the row shows are updated in
  // place: the value, the percent label and the gold filled track.
  picksList.addEventListener('input', (event) => {
    const input = event.target.closest('[data-field="pct"]');
    if (!input) return;
    const row = input.closest('.pick[data-mint]');
    if (!row) return;
    const raw = Number(input.value);
    if (!Number.isFinite(raw)) return;
    const pick = working.find((p) => p.mint === row.dataset.mint);
    if (!pick) return;

    pick.pct = clamp(Math.round(raw), rules.minPct, rules.maxPct);
    const label = row.querySelector('[data-field="pctText"]');
    if (label) label.textContent = `${pick.pct}%`;
    row.style.setProperty('--pct', String(pick.pct));
    refreshSummary();
    if (typeof onChange === 'function') onChange(working.map((p) => ({ ...p })));
  });

  // Drag finished: now a rebuild is safe, and it is what re-applies the
  // is-invalid class to whichever row is the reason the basket does not add up.
  picksList.addEventListener('change', (event) => {
    const input = event.target.closest('[data-field="pct"]');
    if (!input) return;
    const row = input.closest('.pick[data-mint]');
    if (row) setPct(row.dataset.mint, input.value, { rebuild: true });
  });

  if (addList) {
    addList.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-action="add-stock"]');
      if (chip && chip.dataset.mint) addMint(chip.dataset.mint);
    });
  }

  if (search) {
    search.addEventListener('input', () => {
      filter = search.value || '';
      renderPicker();
    });
  }

  if (autoBtn) autoBtn.addEventListener('click', () => setWorking(autoBalance(working.map((p) => ({ ...p })))));
  if (resetBtn) resetBtn.addEventListener('click', () => resetToDefault());
  if (emptyDefaultBtn) emptyDefaultBtn.addEventListener('click', () => setWorking(defaultBasket.map((p) => ({ ...p }))));
  if (revertBtn) {
    revertBtn.addEventListener('click', () => {
      if (savedPicks) setWorking(savedPicks.map((p) => ({ ...p })));
    });
  }
  if (saveBtn) saveBtn.addEventListener('click', () => save());
  if (projConnectBtn && typeof onConnect === 'function') projConnectBtn.addEventListener('click', () => onConnect());
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      if (typeof onRetry !== 'function') {
        render(); // nothing to refetch: the honest error pane stays up
        return;
      }
      picksState.dataset.state = 'loading';
      if (picker) picker.dataset.state = 'loading';
      // If the retry did not bring a universe back, return to the error pane
      // rather than leaving a skeleton spinning forever.
      Promise.resolve(onRetry()).then(
        () => {
          if (universeFailed) render();
        },
        () => {
          if (universeFailed) render();
        },
      );
    });
  }

  /* ---------------------------------------------------------------- API -- */

  return {
    /** Rules and mode come from `/api/config`; the rules prose is rewritten too. */
    renderConfig(config) {
      if (config?.rules) {
        rules = {
          minPicks: Number(config.rules.minPicks) || DEFAULT_RULES.minPicks,
          maxPicks: Number(config.rules.maxPicks) || DEFAULT_RULES.maxPicks,
          minPct: Number(config.rules.minPct) || DEFAULT_RULES.minPct,
          maxPct: Number(config.rules.maxPct) || DEFAULT_RULES.maxPct,
          universeSize: Number(config.rules.universeSize) || DEFAULT_RULES.universeSize,
          defaultBasketSize: Number(config.rules.defaultBasketSize) || DEFAULT_RULES.defaultBasketSize,
          // num(), not Number(): a missing eligibleBps must stay null, not
          // become 0 and claim every wallet on earth is eligible.
          eligibleBps: num(config.rules.eligibleBps),
        };
      }
      if (config?.mode) mode = config.mode;
      if (config?.defaultBasket) serverDefault = config.defaultBasket;

      const set = (id, text) => {
        const el = document.getElementById(id);
        if (el && text) el.textContent = text;
      };
      // The shell reads "Pick <span>2–5</span> stocks", so this is a range, not
      // the "between X and Y" clause the old prose wrapped it in.
      set('rule-picks-range', `${rules.minPicks}–${rules.maxPicks}`);
      set('rule-pct-range', `${rules.minPct}–${rules.maxPct}%`);
      set('rule-universe-size', String(rules.universeSize));
      // Number.isFinite does not coerce, so null (unknown) and undefined (never
      // sent) both fall through instead of printing "0%" or "NaN%".
      if (Number.isFinite(rules.eligibleBps)) {
        set('rule-eligible-pct', `${rules.eligibleBps / 100}%`);
        set('step-eligible-pct', `${rules.eligibleBps / 100}%`);
      }
      const intervalHours = num(config?.intervalHours);
      if (intervalHours !== null) set('step-interval', String(intervalHours));

      refreshSummary();
    },

    /** The universe drives the picker, the default basket, and stale detection. */
    renderUniverse(uni) {
      universe = Array.isArray(uni?.stocks) ? uni.stocks : [];
      index = new Map(universe.map((s) => [s.mint, s]));
      loadedUniverse = universe.length > 0;
      universeFailed = false;

      const topN = universe.slice(0, rules.defaultBasketSize).map((s) => s.mint);
      defaultBasket = evenSplit(topN);

      // Nobody has chosen anything yet: show the default so the donut is never
      // an empty ring on first paint.
      if (working.length === 0 && savedPicks === null) working = defaultBasket.map((p) => ({ ...p }));

      render();
    },

    /** `/api/me` — the saved basket, the balance and the projection. */
    renderMe(meDoc, { tokenSymbol = null, tokenDecimals = null } = {}) {
      me = meDoc ? { ...meDoc, tokenSymbol, tokenDecimals } : null;
      connected = Boolean(meDoc);

      if (meDoc) {
        const stored = Array.isArray(meDoc.prefs?.picks) ? meDoc.prefs.picks : null;
        savedPicks = stored ? stored.map((p) => ({ mint: p.mint, pct: Number(p.pct) })) : null;
        working = (savedPicks || defaultBasket).map((p) => ({ ...p }));
      }

      render();
      renderProjection();
      if (typeof onChange === 'function') onChange(working.map((p) => ({ ...p })));
    },

    setMode(nextMode) {
      mode = nextMode || mode;
      renderProjection();
    },

    setDisconnected() {
      connected = false;
      me = null;
      savedPicks = null;
      working = defaultBasket.map((p) => ({ ...p }));
      render();
      renderProjection();
      if (typeof onChange === 'function') onChange(working.map((p) => ({ ...p })));
    },

    /**
     * `/api/me` failed while a session exists. The basket itself is still
     * usable — it falls back to the default — but the projection cannot be
     * computed, so that panel, and only that panel, shows the failure.
     */
    setMeError(message) {
      const text = document.getElementById('projection-error-text');
      if (text && message) text.textContent = message;
      if (projection) projection.dataset.state = 'error';
    },

    setLoading() {
      universeFailed = false;
      picksState.dataset.state = 'loading';
      if (picker) picker.dataset.state = 'loading';
    },

    /** The universe fetch failed. Nothing may be validated against it until it lands. */
    setError(message) {
      universeFailed = true;
      if (errorText && message) errorText.textContent = message;
      picksState.dataset.state = 'error';
      if (picker) picker.dataset.state = 'error';
      refreshSummary();
    },

    addStock: addMint,
    togglePick: toggleMint,
    isPicked: (mint) => working.some((p) => p.mint === mint),
    canAdd: (mint) => working.length < rules.maxPicks && !working.some((p) => p.mint === mint),
    picks: () => working.map((p) => ({ ...p })),
    mints: () => working.map((p) => p.mint),
  };
}

export default createBasket;
