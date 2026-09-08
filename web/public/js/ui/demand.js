/**
 * STOXVAULT — community demand.
 *
 * Everybody's saved baskets added together: the split the next round would buy.
 * Bars are drawn to the *largest* share so the chart uses the full width, but
 * the number printed at the end of each row is always the true share.
 *
 * The basis label is a promise about the maths, so it is never guessed: before
 * the token exists every saved basket counts once (`equal-weight`); afterwards
 * each wallet counts for what it held at the snapshot (`holding-weighted`).
 */

import { fmtShare, DASH } from '../format.js';

const NOTE = {
  'equal-weight':
    'No token yet, so every saved basket counts once. Once the coin exists, each wallet counts for what it holds at the snapshot.',
  'holding-weighted':
    'Each wallet counts for what it held at the last snapshot, so a bigger holder moves the split further.',
};

export function createDemand({ onRetry } = {}) {
  const panel = document.getElementById('demand-panel');
  const bars = document.getElementById('demand-bars');
  const basisEl = document.getElementById('demand-basis');
  const noteEl = document.getElementById('demand-note');
  const errorText = document.getElementById('demand-error-text');
  const retryBtn = document.getElementById('btn-demand-retry');
  const tpl = document.getElementById('tpl-demand-row');

  if (!panel || !bars || !tpl) {
    return { render() {}, setError() {}, setLoading() {}, setMine() {}, setVisible() {} };
  }

  if (retryBtn && typeof onRetry === 'function') retryBtn.addEventListener('click', () => onRetry());

  let mine = new Set();
  let lastRows = [];
  // The bars are only ever built for a panel someone has opened, and only when
  // the data behind them actually changed — switching tab repaints nothing.
  let visible = false;
  let dirty = false;

  function row(entry, max) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.mint = entry.mint || '';
    node.dataset.symbol = entry.symbol || '';

    node.querySelector('[data-field="symbol"]').textContent = entry.symbol || DASH;

    const pct = Number(entry.pct) || 0;
    const bar = node.querySelector('[data-field="bar"]');
    // Drawn against the largest share so the chart uses the full width; the
    // number beside it is always the true share.
    if (bar) bar.style.width = `${max > 0 ? Math.max(1.5, (pct / max) * 100) : 0}%`;

    node.querySelector('[data-field="pct"]').textContent = fmtShare(pct);

    if (entry.mint && mine.has(entry.mint)) node.classList.add('is-mine');
    return node;
  }

  function paint() {
    if (!visible) {
      dirty = true;
      return;
    }
    dirty = false;

    if (lastRows.length === 0) {
      bars.replaceChildren();
      panel.dataset.state = 'empty';
      return;
    }
    const max = lastRows.reduce((acc, r) => Math.max(acc, Number(r.pct) || 0), 0);
    const frag = document.createDocumentFragment();
    for (const entry of lastRows) frag.appendChild(row(entry, max));
    bars.replaceChildren(frag);
    panel.dataset.state = 'ready';
  }

  return {
    /**
     * @param {{demand: {symbol, mint, pct}[], demandBasis: string, demandContributors?: number}} stats
     * @param {Map<string, object>} [stockIndex] mint -> stock, for the logos
     */
    render(stats) {
      const rows = Array.isArray(stats?.demand) ? stats.demand.filter((d) => Number(d?.pct) > 0) : [];
      lastRows = rows.slice().sort((a, b) => (Number(b.pct) || 0) - (Number(a.pct) || 0));

      const basis = stats?.demandBasis === 'holding-weighted' ? 'holding-weighted' : 'equal-weight';
      if (basisEl) {
        basisEl.textContent = basis;
        basisEl.classList.toggle('badge--live', basis === 'holding-weighted');
        basisEl.classList.toggle('badge--muted', basis !== 'holding-weighted');
      }
      if (noteEl) {
        const contributors = Number(stats?.demandContributors);
        const who =
          Number.isFinite(contributors) && contributors > 0
            ? ` Counted from ${contributors} wallet${contributors === 1 ? '' : 's'} with a saved basket.`
            : '';
        noteEl.textContent = `${NOTE[basis]}${who}`;
      }

      paint();
    },

    /** Highlight the connected wallet's own picks. */
    setMine(mints) {
      const next = new Set(Array.isArray(mints) ? mints.filter(Boolean) : []);
      const same = next.size === mine.size && [...next].every((m) => mine.has(m));
      mine = next;
      if (same) return; // the same basket: nothing on screen would change
      if (lastRows.length > 0) paint();
    },

    /** The Demand panel was opened (or left). Build on the way in, once. */
    setVisible(next) {
      const was = visible;
      visible = Boolean(next);
      if (visible && (!was || dirty)) paint();
    },

    setLoading() {
      panel.dataset.state = 'loading';
    },

    setError(message) {
      if (errorText && message) errorText.textContent = message;
      panel.dataset.state = 'error';
      dirty = false;
    },
  };
}

export default createDemand;
