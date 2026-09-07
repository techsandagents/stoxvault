/**
 * STOXVAULT — the ticker tape.
 *
 * Twenty real prices, scrolling. The marquee is a CSS animation that translates
 * the track by -50%, so the item list has to be written twice — the second copy
 * `aria-hidden`, because a screen reader should hear each ticker once.
 *
 * The state lives on `#tape-viewport`, not `#tape`: the pane rules use a direct
 * child combinator, so the state owner has to be the panes' parent.
 */

import { fmtUsd, fmtPct, dirOf, DASH } from '../format.js';

export function createTape({ onRetry } = {}) {
  const root = document.getElementById('tape');
  const viewport = document.getElementById('tape-viewport');
  const track = document.getElementById('tape-track');
  const pauseBtn = document.getElementById('tape-pause');
  const retryBtn = document.getElementById('tape-retry');
  const tpl = document.getElementById('tpl-tape-item');

  if (!root || !viewport || !track || !tpl) {
    return { render() {}, setError() {}, setLoading() {}, destroy() {} };
  }

  let paused = false;

  function setPaused(next) {
    paused = Boolean(next);
    root.dataset.paused = paused ? 'true' : 'false';
    if (pauseBtn) {
      pauseBtn.setAttribute('aria-pressed', paused ? 'true' : 'false');
      pauseBtn.setAttribute('aria-label', paused ? 'Resume the price tape' : 'Pause the price tape');
    }
  }

  if (pauseBtn) pauseBtn.addEventListener('click', () => setPaused(!paused));
  if (retryBtn && typeof onRetry === 'function') retryBtn.addEventListener('click', () => onRetry());

  setPaused(false);

  function item(stock, ariaHidden) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.mint = stock.mint || '';
    node.querySelector('[data-field="symbol"]').textContent = stock.symbol || DASH;

    const price = node.querySelector('[data-field="price"]');
    price.textContent = stock.priceUsd === null || stock.priceUsd === undefined ? DASH : fmtUsd(stock.priceUsd);

    const change = node.querySelector('[data-field="change"]');
    if (stock.change24h === null || stock.change24h === undefined) {
      change.textContent = DASH;
      change.dataset.dir = 'flat';
    } else {
      change.textContent = fmtPct(stock.change24h);
      change.dataset.dir = dirOf(stock.change24h);
    }

    if (ariaHidden) node.setAttribute('aria-hidden', 'true');
    return node;
  }

  return {
    /** @param {{stocks: object[]}} universe */
    render(universe) {
      const stocks = Array.isArray(universe?.stocks) ? universe.stocks : [];
      if (stocks.length === 0) {
        track.replaceChildren();
        viewport.dataset.state = 'empty';
        return;
      }

      const frag = document.createDocumentFragment();
      // Two passes: the visible list, then a duplicate for the seamless loop.
      for (const pass of [false, true]) {
        for (const stock of stocks) frag.appendChild(item(stock, pass));
      }
      track.replaceChildren(frag);
      viewport.dataset.state = 'ready';
    },

    setLoading() {
      viewport.dataset.state = 'loading';
    },

    setError() {
      viewport.dataset.state = 'error';
    },

    setPaused,

    get paused() {
      return paused;
    },
  };
}

export default createTape;
