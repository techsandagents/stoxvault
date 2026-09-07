/**
 * STOCKDROP — the rounds ledger.
 *
 * Every round the keeper ran, including the ones it skipped, because a skipped
 * round is evidence the keeper ran — not a failure to hide. Each row expands to
 * the full document: the snapshot hash, the per-stock swaps, and every transfer
 * with its Solscan link.
 *
 * Two rules hold this section honest:
 *   - a round with `simulated: true` carries a Simulated badge, everywhere
 *   - `tx === null` renders as "simulated" (dry run) or an em dash. It never
 *     renders as a link to a transaction that does not exist.
 */

import * as api from '../api.js';
import {
  fmtTokenAmount,
  fmtTokenAmountExact,
  fmtDateTimeUtc,
  fmtTimeUtc,
  fmtInt,
  lamportsToSolText,
  truncAddr,
  solscanTx,
  isoOf,
  DASH,
} from '../format.js';
import { toast } from './toast.js';

const PAGE_SIZE = 25;

const SKIP_REASON = {
  no_token: 'No token yet — nothing to snapshot.',
  low_pool: 'The pool was under the minimum, so the SOL carried over.',
  no_holders: 'No wallet met the eligibility threshold.',
};

/** Statuses the CSS colours. Anything else is shown as-is, uncoloured. */
const KNOWN_STATUS = new Set(['DONE', 'SKIPPED', 'FAILED', 'PENDING', 'SNAPSHOT', 'SWAPPING', 'DISTRIBUTING']);

function setStatus(el, status) {
  if (!el) return;
  const value = String(status || '').toUpperCase();
  el.textContent = value ? value.replace(/_/g, ' ').toLowerCase() : DASH;
  // SKIPPED_DUST is a transfer outcome, not a round status: colour it like a
  // skip, but keep the precise word in the text.
  el.dataset.status = KNOWN_STATUS.has(value) ? value : value.startsWith('SKIPPED') ? 'SKIPPED' : '';
}

/** A tx cell: a real link, or an honest non-link. */
function setTxCell(anchor, tx, simulated) {
  if (!anchor) return;
  if (typeof tx === 'string' && tx.length > 20) {
    anchor.href = solscanTx(tx);
    anchor.textContent = truncAddr(tx, 6, 6);
    anchor.title = tx;
    anchor.removeAttribute('aria-disabled');
    return;
  }
  anchor.removeAttribute('href');
  anchor.removeAttribute('title');
  anchor.setAttribute('aria-disabled', 'true');
  anchor.textContent = simulated ? 'simulated' : DASH;
}

export function createRounds({ onRetry, getStock } = {}) {
  const table = document.getElementById('rounds-table');
  const body = document.getElementById('rounds-body');
  const countEl = document.getElementById('rounds-count');
  const emptyTime = document.getElementById('rounds-empty-time');
  const errorText = document.getElementById('rounds-error-text');
  const retryBtn = document.getElementById('btn-rounds-retry');
  const moreBtn = document.getElementById('btn-rounds-more');
  const footNote = document.getElementById('rounds-foot-note');

  const rowTpl = document.getElementById('tpl-round-row');
  const detailTpl = document.getElementById('tpl-round-detail');
  const swapTpl = document.getElementById('tpl-swap-row');
  const transferTpl = document.getElementById('tpl-transfer-row');

  if (!table || !body || !rowTpl || !detailTpl) {
    return { render() {}, setLoading() {}, setError() {}, renderConfig() {}, loaded: () => 0 };
  }

  let items = [];
  let total = 0;
  let loading = false;
  const detailCache = new Map(); // round id -> full round document

  /* ----------------------------------------------------------- summary -- */

  function rowFor(round) {
    const node = rowTpl.content.firstElementChild.cloneNode(true);
    node.dataset.roundId = round.id;
    node.setAttribute('aria-expanded', 'false');
    node.setAttribute('aria-controls', `round-detail-${round.id}`);

    node.querySelector('[data-field="id"]').textContent = round.id || DASH;

    const sim = node.querySelector('[data-field="sim"]');
    if (sim) sim.hidden = !round.simulated;

    const when = node.querySelector('[data-field="scheduledAt"]');
    when.textContent = round.scheduledAt ? fmtDateTimeUtc(round.scheduledAt) : DASH;
    when.title = isoOf(round.scheduledAt);

    setStatus(node.querySelector('[data-field="status"]'), round.status);

    node.querySelector('[data-field="pool"]').textContent =
      round.poolLamports === undefined || round.poolLamports === null ? DASH : `${lamportsToSolText(round.poolLamports, 3)} SOL`;

    const stocks = Array.isArray(round.demand) ? round.demand.filter((d) => d && d.solLamports !== '0').length : null;
    node.querySelector('[data-field="stocks"]').textContent = stocks === null ? DASH : fmtInt(stocks);

    const holders = round.stats?.eligibleHolders;
    node.querySelector('[data-field="holders"]').textContent =
      holders === undefined || holders === null ? DASH : fmtInt(holders);

    const done = round.stats?.transfersDone;
    const failed = round.stats?.transfersFailed;
    const transfersCell = node.querySelector('[data-field="transfers"]');
    if (done === undefined || done === null) {
      transfersCell.textContent = DASH;
    } else {
      transfersCell.textContent = failed ? `${fmtInt(done)} / ${fmtInt(failed)} failed` : fmtInt(done);
    }

    return node;
  }

  function detailFor(round) {
    const node = detailTpl.content.firstElementChild.cloneNode(true);
    node.dataset.roundId = round.id;
    node.id = `round-detail-${round.id}`;
    node.hidden = true;
    return node;
  }

  /* ------------------------------------------------------------ detail -- */

  function fillDetail(container, round) {
    const inner = container.querySelector('.round-detail__inner');
    const content = container.querySelector('[data-role="detail-content"]');
    if (!inner || !content) return;

    const set = (field, text, title) => {
      const el = content.querySelector(`[data-field="${field}"]`);
      if (!el) return;
      el.textContent = text;
      if (title) el.title = title;
    };

    const hash = round.snapshot?.hash || null;
    set('hash', hash ? truncAddr(hash, 8, 8) : DASH, hash || '');
    set('takenAt', round.snapshot?.takenAt ? fmtDateTimeUtc(round.snapshot.takenAt) : DASH, isoOf(round.snapshot?.takenAt));
    set(
      'eligible',
      round.stats?.eligibleHolders === undefined || round.stats?.eligibleHolders === null
        ? DASH
        : fmtInt(round.stats.eligibleHolders),
    );
    set('pool', round.poolLamports ? `${lamportsToSolText(round.poolLamports, 4)} SOL` : DASH);
    set('skipReason', round.skipReason ? SKIP_REASON[round.skipReason] || round.skipReason : DASH);

    const swapsBody = content.querySelector('[data-role="swaps-body"]');
    const swaps = Array.isArray(round.swaps) ? round.swaps : [];
    if (swapsBody && swapTpl) {
      const frag = document.createDocumentFragment();
      for (const swap of swaps) {
        const row = swapTpl.content.firstElementChild.cloneNode(true);
        row.dataset.mint = swap.mint || '';
        row.querySelector('[data-field="symbol"]').textContent = swap.symbol || truncAddr(swap.mint);
        row.querySelector('[data-field="solIn"]').textContent = `${lamportsToSolText(swap.solLamports, 4)} SOL`;

        const received = swap.receivedRaw ?? swap.quotedOut ?? null;
        const decimals = decimalsFor(swap.mint);
        const receivedCell = row.querySelector('[data-field="received"]');
        receivedCell.textContent = received === null ? DASH : fmtTokenAmount(received, decimals);
        if (received !== null) receivedCell.title = fmtTokenAmountExact(received, decimals, swap.symbol || '');

        setStatus(row.querySelector('[data-field="status"]'), swap.status);
        setTxCell(row.querySelector('[data-field="tx"]'), swap.tx, round.simulated);
        frag.appendChild(row);
      }
      swapsBody.replaceChildren(frag);
    }

    const transfers = Array.isArray(round.transfers) ? round.transfers : [];
    renderTransfers(content, round, transfers);

    inner.dataset.state = swaps.length === 0 && transfers.length === 0 ? 'empty' : 'ready';
  }

  function decimalsFor(mint) {
    const stock = typeof getStock === 'function' ? getStock(mint) : null;
    return Number.isInteger(stock?.decimals) ? stock.decimals : 8;
  }

  /**
   * The transfer list can be long, so it gets a filter. The input reuses the
   * shipped `.picker__search` class rather than inventing a new one.
   */
  function renderTransfers(content, round, transfers) {
    const tbody = content.querySelector('[data-role="transfers-body"]');
    if (!tbody || !transferTpl) return;

    const heading = [...content.querySelectorAll('.eyebrow')].find((el) => el.textContent.trim() === 'Transfers');

    let input = content.querySelector('[data-role="transfer-filter"]');
    if (!input && heading && transfers.length > 8) {
      input = document.createElement('input');
      input.type = 'search';
      input.className = 'picker__search';
      input.style.marginBottom = '8px';
      input.dataset.role = 'transfer-filter';
      input.placeholder = 'Filter by wallet or ticker';
      input.setAttribute('aria-label', `Filter the ${round.id} transfer list`);
      heading.insertAdjacentElement('afterend', input);
      input.addEventListener('input', () => paintTransfers(tbody, round, transfers, input.value));
    }

    paintTransfers(tbody, round, transfers, input ? input.value : '');
  }

  function paintTransfers(tbody, round, transfers, needleRaw) {
    const needle = String(needleRaw || '').trim().toLowerCase();
    const rows = needle
      ? transfers.filter(
          (t) =>
            String(t.wallet || '').toLowerCase().includes(needle) ||
            String(t.symbol || '').toLowerCase().includes(needle) ||
            String(t.mint || '').toLowerCase().includes(needle),
        )
      : transfers;

    const frag = document.createDocumentFragment();
    for (const transfer of rows) {
      const row = transferTpl.content.firstElementChild.cloneNode(true);
      row.dataset.wallet = transfer.wallet || '';
      row.dataset.mint = transfer.mint || '';

      const walletCell = row.querySelector('[data-field="wallet"]');
      walletCell.textContent = truncAddr(transfer.wallet);
      walletCell.title = transfer.wallet || '';

      row.querySelector('[data-field="symbol"]').textContent = transfer.symbol || truncAddr(transfer.mint);

      const decimals = decimalsFor(transfer.mint);
      const amountCell = row.querySelector('[data-field="amount"]');
      amountCell.textContent = transfer.amountRaw ? fmtTokenAmount(transfer.amountRaw, decimals) : DASH;
      if (transfer.amountRaw) amountCell.title = fmtTokenAmountExact(transfer.amountRaw, decimals, transfer.symbol || '');

      setStatus(row.querySelector('[data-field="status"]'), transfer.status);
      setTxCell(row.querySelector('[data-field="tx"]'), transfer.tx, round.simulated);
      frag.appendChild(row);
    }

    if (rows.length === 0) {
      const empty = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 5;
      cell.textContent = transfers.length === 0 ? 'No transfers in this round.' : 'No transfer matches that filter.';
      empty.appendChild(cell);
      frag.appendChild(empty);
    }

    tbody.replaceChildren(frag);
  }

  async function expand(rowEl, detailEl) {
    const id = rowEl.dataset.roundId;
    const expanded = rowEl.getAttribute('aria-expanded') === 'true';
    const button = rowEl.querySelector('[data-action="toggle-round"]');

    rowEl.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    detailEl.hidden = expanded;
    if (button) button.setAttribute('aria-label', expanded ? 'Show round detail' : 'Hide round detail');
    if (expanded) return;

    const inner = detailEl.querySelector('.round-detail__inner');
    if (detailCache.has(id)) {
      fillDetail(detailEl, detailCache.get(id));
      return;
    }

    if (inner) inner.dataset.state = 'loading';
    try {
      const round = await api.getRound(id);
      detailCache.set(id, round);
      fillDetail(detailEl, round);
    } catch (err) {
      if (inner) inner.dataset.state = 'error';
      const note = detailEl.querySelector('.pane--error .hint');
      if (note) note.textContent = api.errorText(err, 'Round detail could not be loaded.');
    }
  }

  body.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-action="toggle-round"]');
    const row = event.target.closest('tr.round-row[data-round-id]');
    if (!row) return;
    if (!toggle && event.target.closest('a')) return; // let links be links
    const detail = body.querySelector(`tr.round-detail[data-round-id="${CSS.escape(row.dataset.roundId)}"]`);
    if (detail) expand(row, detail);
  });

  if (retryBtn && typeof onRetry === 'function') retryBtn.addEventListener('click', () => onRetry());

  async function loadMore() {
    if (loading) return;
    loading = true;
    if (moreBtn) {
      moreBtn.disabled = true;
      moreBtn.textContent = 'Loading…';
    }
    try {
      const page = await api.getRounds({ limit: PAGE_SIZE, offset: items.length });
      const more = Array.isArray(page?.items) ? page.items : [];
      items = items.concat(more);
      total = Number(page?.total ?? items.length);
      paint();
    } catch (err) {
      if (moreBtn) moreBtn.textContent = 'Load older rounds';
      toast({ kind: 'error', title: 'Could not load more', text: api.errorText(err), onRetry: () => loadMore() });
    } finally {
      loading = false;
      if (moreBtn) moreBtn.disabled = false;
    }
  }

  if (moreBtn) moreBtn.addEventListener('click', () => loadMore());

  function paint() {
    if (countEl) countEl.textContent = total === 0 ? 'no rounds yet' : `${fmtInt(total)} round${total === 1 ? '' : 's'}`;

    if (items.length === 0) {
      body.replaceChildren();
      table.dataset.state = 'empty';
      if (moreBtn) moreBtn.hidden = true;
      return;
    }

    const frag = document.createDocumentFragment();
    for (const round of items) {
      frag.appendChild(rowFor(round));
      frag.appendChild(detailFor(round));
    }
    body.replaceChildren(frag);
    table.dataset.state = 'ready';

    if (moreBtn) {
      moreBtn.hidden = items.length >= total;
      moreBtn.textContent = 'Load older rounds';
    }
  }

  return {
    /** @param {{items: object[], total: number}} page the first page */
    render(page) {
      items = Array.isArray(page?.items) ? page.items : [];
      total = Number(page?.total ?? items.length);
      detailCache.clear();
      paint();
    },

    /** The empty state must name the real next-round time, or stay generic. */
    renderConfig(config) {
      if (emptyTime && config?.nextRoundAt) {
        emptyTime.textContent = `${fmtTimeUtc(config.nextRoundAt)} UTC`;
        emptyTime.title = isoOf(config.nextRoundAt);
      }
      const jitter = config?.rules?.jitterMin;
      if (footNote && Number.isFinite(Number(jitter))) {
        footNote.textContent = `Times are UTC. The snapshot is taken at a random offset within ±${jitter} minutes of each mark.`;
      }
    },

    setLoading() {
      table.dataset.state = 'loading';
    },

    setError(message) {
      if (errorText && message) errorText.textContent = message;
      table.dataset.state = 'error';
      if (moreBtn) moreBtn.hidden = true;
    },

    loaded: () => items.length,
  };
}

export default createRounds;
