/**
 * STOXVAULT — the vault panel.
 *
 * One wallet, one purpose: its balance minus the fee reserve is the pool for the
 * next round. The panel reports what the vault holds and what the next round may
 * spend — the address itself is deliberately not rendered anywhere on the site,
 * so `/api/vault.address` is read past and never printed.
 */

import { fmtSol, fmtUsd, fmtTokenAmount, fmtTokenAmountExact, truncAddr, fmtTimeUtc, isoOf, monogram, DASH } from '../format.js';

export function createVault({ onRetry } = {}) {
  const figures = document.getElementById('vault-figures');
  const balanceSol = document.getElementById('vault-balance-sol');
  const balanceUsd = document.getElementById('vault-balance-usd');
  const reserveEl = document.getElementById('vault-reserve');
  const poolEl = document.getElementById('vault-pool');
  const minPoolEl = document.getElementById('vault-min-pool');
  const updatedEl = document.getElementById('vault-updated');
  const holdingsTable = document.getElementById('vault-holdings-table');
  const holdingsBody = document.getElementById('vault-holdings-body');
  const holdingsCount = document.getElementById('vault-holdings-count');
  const tpl = document.getElementById('tpl-holding-row');

  function holdingRow(holding, stockIndex) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.mint = holding.mint || '';

    const stock = stockIndex ? stockIndex.get(holding.mint) || null : null;
    const symbol = holding.symbol || stock?.symbol || null;

    node.querySelector('[data-field="symbol"]').textContent = symbol || 'unknown token';

    const mono = node.querySelector('[data-field="mono"]');
    const img = node.querySelector('[data-field="logo"]');
    if (mono) mono.textContent = symbol ? monogram(symbol) : '?';
    if (img && stock?.logo) {
      img.src = stock.logo;
      img.alt = '';
      img.hidden = false;
      img.addEventListener('error', () => {
        img.hidden = true;
      });
    }

    const decimals = Number.isInteger(holding.decimals) ? holding.decimals : Number.isInteger(stock?.decimals) ? stock.decimals : 8;
    // Token-2022 scaledUiAmount: a wallet shows rawAmount * multiplier, so the
    // carry-over figure here must scale too or it will read low against Solscan.
    const rawMultiplier = Number(holding.uiMultiplier ?? stock?.uiMultiplier);
    const uiMultiplier = Number.isFinite(rawMultiplier) && rawMultiplier > 0 ? rawMultiplier : 1;
    const amountCell = node.querySelector('[data-field="amount"]');
    amountCell.textContent = fmtTokenAmount(holding.amountRaw, decimals, { uiMultiplier });
    amountCell.title = fmtTokenAmountExact(holding.amountRaw, decimals, symbol || '', uiMultiplier);

    const mintCell = node.querySelector('[data-field="mint"]');
    mintCell.textContent = truncAddr(holding.mint);
    mintCell.title = holding.mint || '';

    return node;
  }

  return {
    /** `/api/config` gives the minimum pool before the countdown even lands. */
    renderConfig(config) {
      const min = config?.rules?.minRoundPoolSol;
      if (minPoolEl && Number.isFinite(Number(min))) minPoolEl.textContent = `${fmtSol(min, 2)} SOL`;
    },

    /** @param {object} vault the `/api/vault` document */
    render(vault, stockIndex = null) {
      if (!vault) return;

      if (balanceSol) balanceSol.textContent = vault.balanceSol === null ? DASH : `${fmtSol(vault.balanceSol, 4)} SOL`;
      if (balanceUsd) balanceUsd.textContent = vault.balanceUsd === null || vault.balanceUsd === undefined ? DASH : `≈ ${fmtUsd(vault.balanceUsd)}`;
      if (reserveEl) reserveEl.textContent = vault.reserveSol === null || vault.reserveSol === undefined ? DASH : `${fmtSol(vault.reserveSol, 2)} SOL`;
      if (poolEl) poolEl.textContent = vault.poolSol === null || vault.poolSol === undefined ? DASH : `${fmtSol(vault.poolSol, 3)} SOL`;
      if (minPoolEl && Number.isFinite(Number(vault.minRoundPoolSol))) {
        minPoolEl.textContent = `${fmtSol(vault.minRoundPoolSol, 2)} SOL`;
      }
      if (updatedEl && vault.updatedAt) {
        updatedEl.textContent = `updated ${fmtTimeUtc(vault.updatedAt)} UTC`;
        updatedEl.title = isoOf(vault.updatedAt);
      }
      if (figures) figures.dataset.state = 'ready';

      // `vault.address` is deliberately ignored: the site does not show it.

      const holdings = Array.isArray(vault.holdings) ? vault.holdings : [];
      if (holdingsCount) {
        holdingsCount.textContent = holdings.length === 0 ? 'none' : `${holdings.length} token${holdings.length === 1 ? '' : 's'}`;
      }
      if (holdingsBody && holdingsTable && tpl) {
        if (holdings.length === 0) {
          holdingsBody.replaceChildren();
          holdingsTable.dataset.state = 'empty';
        } else {
          const frag = document.createDocumentFragment();
          for (const holding of holdings) frag.appendChild(holdingRow(holding, stockIndex));
          holdingsBody.replaceChildren(frag);
          holdingsTable.dataset.state = 'ready';
        }
      }
    },

    setLoading() {
      if (figures) figures.dataset.state = 'loading';
      if (holdingsTable) holdingsTable.dataset.state = 'loading';
    },

    setError() {
      // The four figures have no error pane of their own — they are masked
      // values inside a kv list — so they fall back to the honest em dash and
      // the holdings table carries the error state.
      for (const el of [balanceSol, balanceUsd, reserveEl, poolEl]) {
        if (el) el.textContent = DASH;
      }
      if (updatedEl) updatedEl.textContent = 'could not reach the API';
      if (figures) figures.dataset.state = 'ready';
      if (holdingsTable) holdingsTable.dataset.state = 'error';
    },
  };
}

export default createVault;
