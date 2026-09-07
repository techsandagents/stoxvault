/**
 * STOCKDROP — the basket configurator.
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
import { buildDonutArcs } from '../charts.js';
import { fmtShare, fmtSol, fmtInt, fmtTokenAmount, monogram, DASH } from '../format.js';
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

  const donutArcs = document.getElementById('donut-arcs');
  const donutPlaceholder = document.getElementById('donut-placeholder');
  const donutValue = document.getElementById('donut-center-value');
  const donutCaption = document.getElementById('donut-caption');
  const donutLegend = document.getElementById('donut-legend');
  const legendTpl = document.getElementById('tpl-legend-row');

  const projection = document.getElementById('projection');
  const projBalance = document.getElementById('proj-balance');
  const projEligibility = document.getElementById('proj-eligibility');
  const projShare = document.getElementById('proj-share');
  const projPool = document.getElementById('proj-pool');
  const projNote = document.getElementById('proj-note');
  const projSim = document.getElementById('projection-sim');
  const projConnectBtn = document.getElementById('btn-projection-connect');

  const rowTpl = document.getElementById('tpl-pick-row');
  const chipTpl = document.getElementById('tpl-picker-chip');

  if (!picksState || !picksList || !rowTpl) {
    return {
      renderConfig() {},
      renderUniverse() {},
      renderMe() {},
      setDisconnected() {},
      setLoading() {},
      setError() {},
      addStock() {},
      isPicked: () => false,
      canAdd: () => false,
      picks: () => [],
    };
  }

  let rules = { ...DEFAULT_RULES };
  let universe = []; // the current top 20
  let index = new Map(); // mint -> stock
  let working = []; // [{mint, pct}] — what the UI shows
  let savedPicks = null; // the wallet's stored basket, or null (default)
  let defaultBasket = []; // top-5 x 20
  let connected = false;
  let me = null;
  let mode = 'DRY_RUN';
  let poolSol = null;
  let filter = '';
  let saving = false;
  let loadedUniverse = false;

  /* ------------------------------------------------------------ validation */

  /** @returns {{ok: boolean, code: string|null, text: string, level: string, badMints: Set<string>}} */
  function validate(list = working) {
    const badMints = new Set();
    const total = list.reduce((acc, p) => acc + (Number(p.pct) || 0), 0);

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
      if (!index.has(pick.mint)) {
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

    return { ok: true, code: null, level: 'ok', text: `${list.length} stocks, 100% allocated.`, badMints, total };
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

  function stepPct(mint, direction) {
    const pick = working.find((p) => p.mint === mint);
    if (!pick) return;
    const next = clamp(Math.round(pick.pct / STEP) * STEP + direction * STEP, rules.minPct, rules.maxPct);
    setPct(mint, next, { rebuild: true });
  }

  /* ------------------------------------------------------------- rendering */

  function pickRow(pick, position, invalid) {
    const stock = index.get(pick.mint) || (typeof getStock === 'function' ? getStock(pick.mint) : null);
    const symbol = stock?.symbol || pick.symbol || 'unknown';
    const node = rowTpl.content.firstElementChild.cloneNode(true);

    node.dataset.mint = pick.mint;
    node.dataset.symbol = symbol;

    node.querySelector('[data-field="symbol"]').textContent = symbol;
    node.querySelector('[data-field="name"]').textContent = stock?.name || (index.has(pick.mint) ? '' : 'not in the current top 20');

    const mono = node.querySelector('[data-field="mono"]');
    const img = node.querySelector('[data-field="logo"]');
    if (mono) mono.textContent = monogram(symbol);
    if (img && stock?.logo) {
      img.src = stock.logo;
      img.alt = '';
      img.hidden = false;
      img.addEventListener('error', () => {
        img.hidden = true;
      });
    }

    const bar = node.querySelector('[data-field="bar"]');
    if (bar) bar.style.width = `${clamp(Number(pick.pct) || 0, 0, 100)}%`;

    const input = node.querySelector('[data-field="pct"]');
    input.value = String(pick.pct);
    input.min = String(rules.minPct);
    input.max = String(rules.maxPct);
    input.step = String(STEP);
    input.setAttribute('aria-label', `${symbol} allocation percent`);

    const dec = node.querySelector('[data-action="dec"]');
    const inc = node.querySelector('[data-action="inc"]');
    dec.setAttribute('aria-label', `Decrease ${symbol} allocation`);
    inc.setAttribute('aria-label', `Increase ${symbol} allocation`);
    dec.disabled = pick.pct <= rules.minPct;
    inc.disabled = pick.pct >= rules.maxPct;

    const remove = node.querySelector('[data-action="remove"]');
    remove.setAttribute('aria-label', `Remove ${symbol} from basket`);

    if (invalid) {
      node.classList.add('is-invalid');
      node.querySelector('.stepper')?.classList.add('is-invalid');
    }

    // A saved pick whose stock fell out of the top 20 still counts — the engine
    // re-spreads its share — so say that instead of silently dropping it.
    if (!index.has(pick.mint)) {
      node.classList.add('is-stale');
      const note = document.createElement('span');
      note.className = 'pick-row__note';
      note.textContent = 'No longer in the top 20 — its share is spread across your other picks';
      node.appendChild(note);
    }

    node.dataset.position = String(position);
    return node;
  }

  function renderPicks(state) {
    if (working.length === 0) {
      picksList.replaceChildren();
      picksState.dataset.state = 'empty';
      return;
    }
    const frag = document.createDocumentFragment();
    working.forEach((pick, i) => frag.appendChild(pickRow(pick, i, state.badMints.has(pick.mint))));
    picksList.replaceChildren(frag);
    picksState.dataset.state = 'ready';
  }

  function renderDonut(state) {
    if (!donutArcs) return;
    const slices = working.map((pick) => ({
      pct: clamp(Number(pick.pct) || 0, 0, 100),
      mint: pick.mint,
      symbol: index.get(pick.mint)?.symbol || '',
    }));

    donutArcs.replaceChildren(buildDonutArcs(slices));
    if (donutPlaceholder) donutPlaceholder.hidden = slices.length > 0;
    if (donutValue) donutValue.textContent = slices.length === 0 ? DASH : `${state.total}%`;
    if (donutCaption) {
      donutCaption.textContent =
        slices.length === 0
          ? 'Nothing allocated yet.'
          : `${slices.length} stock${slices.length === 1 ? '' : 's'} · ${state.total}% allocated`;
    }

    if (donutLegend && legendTpl) {
      const frag = document.createDocumentFragment();
      slices.forEach((slice, i) => {
        const row = legendTpl.content.firstElementChild.cloneNode(true);
        row.dataset.slice = String(i % 5);
        row.dataset.mint = slice.mint;
        row.querySelector('[data-field="symbol"]').textContent = slice.symbol || truncatedMint(slice.mint);
        row.querySelector('[data-field="pct"]').textContent = fmtShare(slice.pct);
        frag.appendChild(row);
      });
      donutLegend.replaceChildren(frag);
    }
  }

  function truncatedMint(mint) {
    return typeof mint === 'string' && mint.length > 9 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint || DASH;
  }

  function renderPicker() {
    if (!addList || !chipTpl || !picker) return;
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
          : 'Showing the default basket';
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
    renderDonut(state);
    renderPicker();
    return state;
  }

  function render() {
    const state = validate();
    renderPicks(state);
    refreshSummary();
  }

  /* ------------------------------------------------------------ projection */

  function renderProjection() {
    if (!projection) return;

    if (!connected || !me) {
      projection.dataset.state = 'empty';
      if (projSim) projSim.hidden = true;
      return;
    }

    if (projSim) projSim.hidden = mode === 'LIVE';

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
      if (!balance) projEligibility.textContent = 'Unknown until launch';
      else if (balance.eligible) projEligibility.textContent = 'Yes';
      else projEligibility.textContent = `No — need ${fmtInt(balance.thresholdUi)}`;
    }

    if (projShare) {
      const bps = me.projected?.shareBps;
      projShare.textContent = bps === null || bps === undefined ? DASH : `${(bps / 100).toFixed(2)}% of the pool`;
    }

    if (projPool) projPool.textContent = poolSol === null ? DASH : `${fmtSol(poolSol, 3)} SOL`;

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
      'STOCKDROP',
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
    const row = event.target.closest('.pick-row[data-mint]');
    if (!row) return;
    const mint = row.dataset.mint;
    if (event.target.closest('[data-action="inc"]')) stepPct(mint, +1);
    else if (event.target.closest('[data-action="dec"]')) stepPct(mint, -1);
    else if (event.target.closest('[data-action="remove"]')) removeMint(mint);
  });

  picksList.addEventListener('input', (event) => {
    const input = event.target.closest('[data-field="pct"]');
    if (!input) return;
    const row = input.closest('.pick-row[data-mint]');
    if (!row) return;
    const raw = Number(input.value);
    if (!Number.isFinite(raw)) return;
    // Validate live, but do not fight the user's cursor: no rebuild on input.
    const pick = working.find((p) => p.mint === row.dataset.mint);
    if (pick) {
      pick.pct = clamp(Math.round(raw), rules.minPct, rules.maxPct);
      const bar = row.querySelector('[data-field="bar"]');
      if (bar) bar.style.width = `${pick.pct}%`;
      row.querySelector('[data-action="dec"]').disabled = pick.pct <= rules.minPct;
      row.querySelector('[data-action="inc"]').disabled = pick.pct >= rules.maxPct;
      refreshSummary();
      if (typeof onChange === 'function') onChange(working.map((p) => ({ ...p })));
    }
  });

  picksList.addEventListener('change', (event) => {
    const input = event.target.closest('[data-field="pct"]');
    if (!input) return;
    const row = input.closest('.pick-row[data-mint]');
    if (row) setPct(row.dataset.mint, input.value, { rebuild: true });
  });

  picksList.addEventListener('keydown', (event) => {
    const input = event.target.closest('[data-field="pct"]');
    if (!input) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const row = input.closest('.pick-row[data-mint]');
    if (!row) return;
    stepPct(row.dataset.mint, event.key === 'ArrowUp' ? +1 : -1);
    const again = picksList.querySelector(`.pick-row[data-mint="${CSS.escape(row.dataset.mint)}"] [data-field="pct"]`);
    if (again) again.focus();
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
      picksState.dataset.state = 'loading';
      if (typeof onRetry === 'function') onRetry();
      else render();
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
          eligibleBps: Number(config.rules.eligibleBps),
        };
      }
      if (config?.mode) mode = config.mode;

      const set = (id, text) => {
        const el = document.getElementById(id);
        if (el && text) el.textContent = text;
      };
      set('rule-picks-range', `${rules.minPicks} and ${rules.maxPicks}`);
      set('rule-pct-range', `${rules.minPct}–${rules.maxPct}%`);
      set('rule-universe-size', String(rules.universeSize));
      if (Number.isFinite(rules.eligibleBps)) {
        set('rule-eligible-pct', `${rules.eligibleBps / 100}%`);
        set('step-eligible-pct', `${rules.eligibleBps / 100}%`);
      }
      if (Number.isFinite(Number(config?.intervalHours))) set('step-interval', String(config.intervalHours));

      refreshSummary();
    },

    /** The universe drives the picker, the default basket, and stale detection. */
    renderUniverse(uni) {
      universe = Array.isArray(uni?.stocks) ? uni.stocks : [];
      index = new Map(universe.map((s) => [s.mint, s]));
      loadedUniverse = universe.length > 0;

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

    /** The pool figure shown in the projection panel comes from /api/vault. */
    setPool(sol) {
      poolSol = Number.isFinite(Number(sol)) ? Number(sol) : null;
      if (connected) renderProjection();
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
      picksState.dataset.state = 'loading';
      if (picker) picker.dataset.state = 'loading';
    },

    setError(message) {
      if (errorText && message) errorText.textContent = message;
      picksState.dataset.state = 'error';
      if (picker) picker.dataset.state = 'error';
    },

    addStock: addMint,
    isPicked: (mint) => working.some((p) => p.mint === mint),
    canAdd: (mint) => working.length < rules.maxPicks && !working.some((p) => p.mint === mint),
    picks: () => working.map((p) => ({ ...p })),
    mints: () => working.map((p) => p.mint),
  };
}

export default createBasket;
