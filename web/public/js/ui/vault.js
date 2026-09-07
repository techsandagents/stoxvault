/**
 * STOCKDROP — the vault panel.
 *
 * One wallet, one purpose: its balance minus the fee reserve is the pool for the
 * next round. The address in the markup is the real, shipped one — this module
 * verifies it against `/api/config` and complains loudly if the server ever
 * disagrees, rather than silently rewriting what the page promises.
 */

import { fmtSol, fmtUsd, fmtTokenAmount, fmtTokenAmountExact, truncAddr, fmtTimeUtc, isoOf, monogram, DASH } from '../format.js';
import { copyToClipboard, toast } from './toast.js';

export function createVault({ onRetry } = {}) {
  const addressEl = document.getElementById('vault-address');
  const footerAddressEl = document.getElementById('footer-vault-address');
  const explorerEl = document.getElementById('vault-explorer');
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

  const copyMain = document.getElementById('btn-copy-vault');
  const copyFooter = document.getElementById('btn-copy-vault-footer');

  /** The address the page shipped with. Nothing here ever overwrites it. */
  const shippedAddress = (addressEl?.textContent || '').trim();

  for (const [btn, label] of [
    [copyMain, 'Vault address copied.'],
    [copyFooter, 'Vault address copied.'],
  ]) {
    if (!btn) continue;
    btn.addEventListener('click', () => copyToClipboard(shippedAddress, btn, label));
  }

  if (addressEl && shippedAddress) addressEl.title = shippedAddress;
  if (footerAddressEl) footerAddressEl.title = shippedAddress;

  let verified = false;

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
    const amountCell = node.querySelector('[data-field="amount"]');
    amountCell.textContent = fmtTokenAmount(holding.amountRaw, decimals);
    amountCell.title = fmtTokenAmountExact(holding.amountRaw, decimals, symbol || '');

    const mintCell = node.querySelector('[data-field="mint"]');
    mintCell.textContent = truncAddr(holding.mint);
    mintCell.title = holding.mint || '';

    return node;
  }

  return {
    /**
     * Cross-check the shipped address against the server's, once, at boot.
     * A mismatch is a real problem — somebody is looking at the wrong vault —
     * so it is surfaced rather than papered over.
     */
    verifyAddress(configAddress) {
      if (verified || !configAddress || !shippedAddress) return;
      verified = true;
      if (configAddress !== shippedAddress) {
        toast({
          kind: 'error',
          title: 'Vault address mismatch',
          text: `The page shows ${truncAddr(shippedAddress)} but the API reports ${truncAddr(
            configAddress,
          )}. Do not send anything until this is resolved.`,
          key: 'vault-mismatch',
          timeout: 0,
        });
      }
      if (explorerEl && configAddress === shippedAddress) {
        explorerEl.href = `https://solscan.io/account/${encodeURIComponent(shippedAddress)}`;
      }
    },

    /** `/api/config` gives the minimum pool before the countdown even lands. */
    renderConfig(config) {
      const min = config?.rules?.minRoundPoolSol;
      if (minPoolEl && Number.isFinite(Number(min))) minPoolEl.textContent = `${fmtSol(min, 2)} SOL`;
      this.verifyAddress(config?.vault?.address);
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

      this.verifyAddress(vault.address);

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

    get address() {
      return shippedAddress;
    },
  };
}

export default createVault;
