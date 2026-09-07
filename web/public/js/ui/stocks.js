/**
 * STOCKDROP — the Top 20 table and the stock drawer.
 *
 * The table is the reference list: rank, ticker, company, price, 24h, market
 * cap, on-chain liquidity, and a 7-day sparkline drawn from the same history
 * endpoint the drawer's candle chart uses. Sorting is client-side over the rows
 * the API returned; nothing is fetched again to sort.
 *
 * Sparklines are loaded after the table paints, four at a time, and a symbol
 * with no history keeps the shipped hairline — "no data" is a state, not a bug.
 */

import * as api from '../api.js';
import { buildSparkline, seriesDirection, createPriceChart } from '../charts.js';
import {
  fmtUsd,
  fmtUsdCompact,
  fmtPct,
  fmtInt,
  dirOf,
  monogram,
  fmtTimeUtc,
  isoOf,
  DASH,
} from '../format.js';
import { copyToClipboard } from './toast.js';

const SPARK_RANGE = '1mo';
const SPARK_POINTS = 7;
const SPARK_CONCURRENCY = 4;

const SORTABLE = new Set(['rank', 'price', 'change24h', 'underlyingMcap', 'liquidityUsd']);
const FIELD_OF = {
  rank: 'rank',
  price: 'priceUsd',
  change24h: 'change24h',
  underlyingMcap: 'underlyingMcap',
  liquidityUsd: 'liquidityUsd',
};

/** Sort with nulls last in both directions — an unknown price is not "cheapest". */
function compare(a, b, field, direction) {
  const av = a[field];
  const bv = b[field];
  const an = av === null || av === undefined || !Number.isFinite(Number(av));
  const bn = bv === null || bv === undefined || !Number.isFinite(Number(bv));
  if (an && bn) return (a.rank ?? 0) - (b.rank ?? 0);
  if (an) return 1;
  if (bn) return -1;
  const delta = Number(av) - Number(bv);
  if (delta === 0) return (a.rank ?? 0) - (b.rank ?? 0);
  return direction === 'ascending' ? delta : -delta;
}

function fillLogo(scope, stock) {
  const mono = scope.querySelector('[data-field="mono"]');
  const img = scope.querySelector('[data-field="logo"]');
  if (mono) mono.textContent = monogram(stock.symbol);
  if (img) {
    if (stock.logo) {
      img.src = stock.logo;
      img.alt = '';
      img.hidden = false;
      img.addEventListener('error', () => {
        img.hidden = true;
      });
    } else {
      img.hidden = true;
    }
  }
}

export function createStocks({ onAdd, isPicked, canAdd, onRetry } = {}) {
  const table = document.getElementById('stocks-table');
  const body = document.getElementById('stocks-body');
  const updatedEl = document.getElementById('stocks-updated');
  const errorText = document.getElementById('stocks-error-text');
  const retryBtn = document.getElementById('btn-stocks-retry');
  const rowTpl = document.getElementById('tpl-stock-row');

  const drawer = document.getElementById('stock-drawer');
  const drawerTicker = document.getElementById('drawer-ticker');
  const drawerName = document.getElementById('drawer-name');
  const drawerPrice = document.getElementById('drawer-price');
  const drawerChange = document.getElementById('drawer-change');
  const drawerMono = document.getElementById('drawer-logo-mono');
  const drawerImg = document.getElementById('drawer-logo-img');
  const drawerMcap = document.getElementById('drawer-mcap');
  const drawerLiquidity = document.getElementById('drawer-liquidity');
  const drawerHolders = document.getElementById('drawer-holders');
  const drawerUnderlying = document.getElementById('drawer-underlying');
  const drawerMint = document.getElementById('drawer-mint');
  const drawerAddBtn = document.getElementById('btn-drawer-add');
  const copyMintBtn = document.getElementById('btn-copy-stock-mint');
  const tabs = document.getElementById('chart-range-tabs');
  const chartPanel = document.getElementById('chart-panel');
  const chartMount = document.getElementById('chart-mount');
  const chartError = document.getElementById('chart-error-text');
  const chartRetry = document.getElementById('btn-chart-retry');

  if (!table || !body || !rowTpl) {
    return {
      render() {},
      setLoading() {},
      setError() {},
      refreshAddButtons() {},
      applyTheme() {},
      closeDrawer() {},
    };
  }

  let stocks = [];
  let sortKey = 'rank';
  let sortDir = 'ascending';
  let openStock = null;
  let openerEl = null;
  let range = '1mo';
  let chart = null;
  let historyToken = 0;

  const sparkCache = new Map(); // symbol -> number[] | null (null = asked, nothing there)

  /* -------------------------------------------------------------- rows -- */

  function buildRow(stock) {
    const node = rowTpl.content.firstElementChild.cloneNode(true);
    node.dataset.mint = stock.mint || '';
    node.dataset.symbol = stock.symbol || '';

    node.querySelector('[data-field="rank"]').textContent = stock.rank ?? DASH;
    fillLogo(node, stock);

    const ticker = node.querySelector('[data-action="open-stock"]');
    ticker.textContent = stock.symbol || DASH;
    ticker.setAttribute('aria-label', `${stock.symbol || 'stock'} — open price chart`);

    node.querySelector('[data-field="name"]').textContent = stock.name || DASH;
    node.querySelector('[data-field="price"]').textContent =
      stock.priceUsd === null || stock.priceUsd === undefined ? DASH : fmtUsd(stock.priceUsd);

    const change = node.querySelector('[data-field="change"]');
    if (stock.change24h === null || stock.change24h === undefined) {
      change.textContent = DASH;
      change.dataset.dir = 'flat';
    } else {
      change.textContent = fmtPct(stock.change24h);
      change.dataset.dir = dirOf(stock.change24h);
    }

    node.querySelector('[data-field="mcap"]').textContent =
      stock.underlyingMcap === null || stock.underlyingMcap === undefined ? DASH : fmtUsdCompact(stock.underlyingMcap);
    node.querySelector('[data-field="liquidity"]').textContent =
      stock.liquidityUsd === null || stock.liquidityUsd === undefined ? DASH : fmtUsdCompact(stock.liquidityUsd);

    const spark = node.querySelector('[data-field="spark"]');
    paintSpark(spark, sparkCache.get(stock.symbol));

    const addBtn = node.querySelector('[data-action="add-stock"]');
    setAddButton(addBtn, stock);

    if (openStock && openStock.mint === stock.mint) node.classList.add('is-active');
    return node;
  }

  function paintSpark(sparkEl, series) {
    if (!sparkEl) return;
    if (!Array.isArray(series) || series.length < 2) {
      sparkEl.dataset.dir = 'flat';
      return; // leave the shipped .spark__empty hairline in place
    }
    const svg = buildSparkline(series);
    if (!svg) return;
    sparkEl.replaceChildren(svg);
    sparkEl.dataset.dir = seriesDirection(series);
  }

  function setAddButton(btn, stock) {
    if (!btn) return;
    const picked = typeof isPicked === 'function' && isPicked(stock.mint);
    const room = typeof canAdd === 'function' ? canAdd(stock.mint) : true;
    btn.textContent = picked ? 'Added' : 'Add';
    btn.disabled = picked || !room;
    btn.setAttribute(
      'aria-label',
      picked ? `${stock.symbol} is already in your basket` : `Add ${stock.symbol} to your basket`,
    );
  }

  function paint() {
    if (stocks.length === 0) {
      body.replaceChildren();
      table.dataset.state = 'empty';
      return;
    }
    const field = FIELD_OF[sortKey] || 'rank';
    const rows = stocks.slice().sort((a, b) => compare(a, b, field, sortDir));
    const frag = document.createDocumentFragment();
    for (const stock of rows) frag.appendChild(buildRow(stock));
    body.replaceChildren(frag);
    table.dataset.state = 'ready';
  }

  /* ------------------------------------------------------------ sorting -- */

  const headButtons = [...table.querySelectorAll('[data-sort]')];
  for (const btn of headButtons) {
    btn.addEventListener('click', () => {
      const key = btn.dataset.sort;
      if (!SORTABLE.has(key)) return;
      if (sortKey === key) {
        sortDir = sortDir === 'ascending' ? 'descending' : 'ascending';
      } else {
        sortKey = key;
        // Rank reads best low-to-high; every other column reads best high-first.
        sortDir = key === 'rank' ? 'ascending' : 'descending';
      }
      syncSortHeaders();
      paint();
    });
  }

  function syncSortHeaders() {
    for (const btn of headButtons) {
      const th = btn.closest('th');
      if (!th) continue;
      th.setAttribute('aria-sort', btn.dataset.sort === sortKey ? sortDir : 'none');
    }
  }

  syncSortHeaders();

  /* ------------------------------------------------------- sparkline load -- */

  async function loadSparklines(list) {
    const queue = list.filter((s) => s.symbol && !sparkCache.has(s.symbol));
    if (queue.length === 0) return;

    let cursor = 0;
    const workers = new Array(Math.min(SPARK_CONCURRENCY, queue.length)).fill(null).map(async () => {
      while (cursor < queue.length) {
        const stock = queue[cursor++];
        try {
          const doc = await api.getHistory(stock.symbol, SPARK_RANGE, { timeout: 15000 });
          const closes = (Array.isArray(doc?.candles) ? doc.candles : [])
            .map((c) => Number(c.c))
            .filter((n) => Number.isFinite(n));
          sparkCache.set(stock.symbol, closes.length >= 2 ? closes.slice(-SPARK_POINTS) : null);
        } catch (err) {
          sparkCache.set(stock.symbol, null); // asked, nothing to draw. Do not retry in a loop.
        }
        const row = body.querySelector(`tr[data-symbol="${CSS.escape(stock.symbol)}"] [data-field="spark"]`);
        paintSpark(row, sparkCache.get(stock.symbol));
      }
    });
    await Promise.all(workers);
  }

  /* --------------------------------------------------------------- drawer -- */

  function ensureChart() {
    if (!chart && chartMount) chart = createPriceChart(chartMount);
    return chart;
  }

  function setChartState(state) {
    if (chartPanel) chartPanel.dataset.state = state;
  }

  async function loadHistory() {
    if (!openStock) return;
    const token = ++historyToken;
    setChartState('loading');
    try {
      const doc = await api.getHistory(openStock.symbol, range, { timeout: 20000 });
      if (token !== historyToken || !openStock) return;
      const candles = Array.isArray(doc?.candles) ? doc.candles : [];
      if (candles.length === 0) {
        setChartState('empty');
        return;
      }
      const drawn = ensureChart()?.setData(candles, doc.kind === 'line' ? 'line' : 'candles');
      setChartState(drawn ? 'ready' : 'empty');
      if (drawn) {
        // The candle series is the underlying listed company, so keep the
        // sparkline cache in step with what the drawer just fetched.
        const closes = candles.map((c) => Number(c.c)).filter((n) => Number.isFinite(n));
        if (closes.length >= 2 && range === SPARK_RANGE) sparkCache.set(openStock.symbol, closes.slice(-SPARK_POINTS));
      }
    } catch (err) {
      if (token !== historyToken) return;
      if (chartError) chartError.textContent = api.errorText(err, 'The history source did not respond.');
      setChartState('error');
    }
  }

  function selectTab(nextRange, { focus = false } = {}) {
    if (!tabs) return;
    const buttons = [...tabs.querySelectorAll('[role="tab"]')];
    let selected = null;
    for (const btn of buttons) {
      const on = btn.dataset.range === nextRange;
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;
      if (on) selected = btn;
    }
    if (!selected) return;
    if (focus) selected.focus();
    if (chartPanel) chartPanel.setAttribute('aria-labelledby', selected.id);
    if (range !== nextRange) {
      range = nextRange;
      loadHistory();
    }
  }

  if (tabs) {
    tabs.addEventListener('click', (event) => {
      const btn = event.target.closest('[role="tab"]');
      if (btn && btn.dataset.range) selectTab(btn.dataset.range);
    });
    tabs.addEventListener('keydown', (event) => {
      const buttons = [...tabs.querySelectorAll('[role="tab"]')];
      const index = buttons.findIndex((b) => b.getAttribute('aria-selected') === 'true');
      if (index < 0) return;
      let next = null;
      if (event.key === 'ArrowRight') next = buttons[(index + 1) % buttons.length];
      else if (event.key === 'ArrowLeft') next = buttons[(index - 1 + buttons.length) % buttons.length];
      else if (event.key === 'Home') next = buttons[0];
      else if (event.key === 'End') next = buttons[buttons.length - 1];
      if (!next) return;
      event.preventDefault();
      selectTab(next.dataset.range, { focus: true });
    });
  }

  if (chartRetry) chartRetry.addEventListener('click', () => loadHistory());

  function openDrawer(stock, opener) {
    if (!drawer || !stock) return;
    openStock = stock;
    openerEl = opener || null;

    for (const row of body.querySelectorAll('tr.is-active')) row.classList.remove('is-active');
    const row = body.querySelector(`tr[data-mint="${CSS.escape(stock.mint)}"]`);
    if (row) row.classList.add('is-active');

    if (drawerTicker) drawerTicker.textContent = stock.symbol || DASH;
    if (drawerName) drawerName.textContent = stock.name || DASH;
    if (drawerPrice) drawerPrice.textContent = stock.priceUsd === null || stock.priceUsd === undefined ? DASH : fmtUsd(stock.priceUsd);
    if (drawerChange) {
      if (stock.change24h === null || stock.change24h === undefined) {
        drawerChange.textContent = DASH;
        drawerChange.dataset.dir = 'flat';
      } else {
        drawerChange.textContent = fmtPct(stock.change24h);
        drawerChange.dataset.dir = dirOf(stock.change24h);
      }
    }
    if (drawerMono) drawerMono.textContent = monogram(stock.symbol);
    if (drawerImg) {
      if (stock.logo) {
        drawerImg.src = stock.logo;
        drawerImg.alt = '';
        drawerImg.hidden = false;
        drawerImg.onerror = () => {
          drawerImg.hidden = true;
        };
      } else {
        drawerImg.hidden = true;
      }
    }
    if (drawerMcap) drawerMcap.textContent = stock.underlyingMcap ? fmtUsdCompact(stock.underlyingMcap) : DASH;
    if (drawerLiquidity) drawerLiquidity.textContent = stock.liquidityUsd ? fmtUsdCompact(stock.liquidityUsd) : DASH;
    if (drawerHolders) drawerHolders.textContent = Number.isFinite(stock.holderCount) ? fmtInt(stock.holderCount) : DASH;
    if (drawerUnderlying) drawerUnderlying.textContent = stock.underlyingPrice ? fmtUsd(stock.underlyingPrice) : DASH;
    if (drawerMint) {
      drawerMint.textContent = stock.mint || DASH;
      drawerMint.title = stock.mint || '';
    }
    refreshDrawerAdd();

    if (typeof drawer.showModal === 'function' && !drawer.open) drawer.showModal();
    selectTab(range);
    loadHistory();
  }

  function refreshDrawerAdd() {
    if (!drawerAddBtn || !openStock) return;
    const picked = typeof isPicked === 'function' && isPicked(openStock.mint);
    const room = typeof canAdd === 'function' ? canAdd(openStock.mint) : true;
    drawerAddBtn.disabled = picked || !room;
    drawerAddBtn.textContent = picked ? 'Already in your basket' : room ? 'Add to basket' : 'Basket is full';
  }

  /**
   * Tear down after the drawer closes. Idempotent, and called from both the
   * explicit close path and the `close` event, because Escape and a backdrop
   * click do not go through `closeDrawer()`.
   */
  function onClosed() {
    if (!openStock && !chart) return;
    for (const row of body.querySelectorAll('tr.is-active')) row.classList.remove('is-active');
    if (chart) chart.destroy();
    chart = null;
    openStock = null;
    if (openerEl && document.contains(openerEl)) openerEl.focus();
    openerEl = null;
  }

  function closeDrawer() {
    historyToken++;
    if (drawer && drawer.open) drawer.close();
    onClosed();
  }

  if (drawer) {
    drawer.addEventListener('close', onClosed);
    drawer.addEventListener('cancel', () => {
      historyToken++;
      // `cancel` (Escape) is followed by `close`; queue the teardown so the
      // dialog is really shut by the time it runs.
      setTimeout(onClosed, 0);
    });
    drawer.addEventListener('click', (event) => {
      if (event.target === drawer) closeDrawer();
    });
  }

  for (const id of ['btn-drawer-close', 'btn-drawer-close-x']) {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', () => closeDrawer());
  }

  if (copyMintBtn) {
    copyMintBtn.addEventListener('click', () => {
      if (openStock?.mint) copyToClipboard(openStock.mint, copyMintBtn, `${openStock.symbol} mint copied.`);
    });
  }

  if (drawerAddBtn) {
    drawerAddBtn.addEventListener('click', () => {
      if (openStock && typeof onAdd === 'function') onAdd(openStock.mint);
      refreshDrawerAdd();
    });
  }

  /* -------------------------------------------------------- row delegation -- */

  body.addEventListener('click', (event) => {
    const addBtn = event.target.closest('[data-action="add-stock"]');
    if (addBtn) {
      const row = addBtn.closest('tr[data-mint]');
      if (row && typeof onAdd === 'function') onAdd(row.dataset.mint);
      return;
    }
    const row = event.target.closest('tr[data-clickable="true"]');
    if (!row) return;
    const stock = stocks.find((s) => s.mint === row.dataset.mint);
    if (!stock) return;
    const opener = event.target.closest('[data-action="open-stock"]') || row.querySelector('[data-action="open-stock"]');
    openDrawer(stock, opener);
  });

  if (retryBtn && typeof onRetry === 'function') retryBtn.addEventListener('click', () => onRetry());

  /* ------------------------------------------------------------------ API -- */

  return {
    /** @param {{stocks: object[], updatedAt: string, source: string, stale: boolean}} universe */
    render(universe) {
      stocks = Array.isArray(universe?.stocks) ? universe.stocks : [];
      paint();

      if (updatedEl) {
        if (universe?.updatedAt) {
          const source = universe.source ? ` · ${universe.source}` : '';
          const stale = universe.stale ? ' · stale' : '';
          updatedEl.textContent = `updated ${fmtTimeUtc(universe.updatedAt)} UTC${source}${stale}`;
          updatedEl.title = isoOf(universe.updatedAt);
        } else {
          updatedEl.textContent = DASH;
        }
      }

      if (openStock) {
        const fresh = stocks.find((s) => s.mint === openStock.mint);
        if (fresh) {
          openStock = fresh;
          if (drawerPrice) drawerPrice.textContent = fresh.priceUsd ? fmtUsd(fresh.priceUsd) : DASH;
          if (drawerChange && fresh.change24h !== null && fresh.change24h !== undefined) {
            drawerChange.textContent = fmtPct(fresh.change24h);
            drawerChange.dataset.dir = dirOf(fresh.change24h);
          }
          refreshDrawerAdd();
        }
      }

      loadSparklines(stocks);
    },

    /** Re-evaluate every Add button after the basket changed. */
    refreshAddButtons() {
      for (const row of body.querySelectorAll('tr[data-mint]')) {
        const stock = stocks.find((s) => s.mint === row.dataset.mint);
        if (stock) setAddButton(row.querySelector('[data-action="add-stock"]'), stock);
      }
      refreshDrawerAdd();
    },

    /** The candle chart holds colours it read at creation time. */
    applyTheme() {
      if (chart) chart.applyTheme();
    },

    setLoading() {
      table.dataset.state = 'loading';
    },

    setError(message) {
      if (errorText && message) errorText.textContent = message;
      table.dataset.state = 'error';
    },

    closeDrawer,

    /** Used by the "add" flow to name a mint in a toast. */
    find(mint) {
      return stocks.find((s) => s.mint === mint) || null;
    },

    get stocks() {
      return stocks;
    },
  };
}

export default createStocks;
