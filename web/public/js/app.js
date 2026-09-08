/**
 * STOXVAULT — boot and orchestration.
 *
 * Every section owns its own `[data-state]` container and its own try/catch, so
 * a slow universe, an unreachable RPC or a 500 on the ledger costs you that one
 * panel and nothing else. Nothing on this page is ever filled with a plausible
 * number when its endpoint failed — the section flips to its error pane and
 * offers the retry button that is already in the markup.
 */

import * as api from './api.js';
import * as wallet from './wallet.js';
import { createTabs } from './tabs.js';
import { createTape } from './ui/tape.js';
import { createStocks } from './ui/stocks.js';
import { createBasket } from './ui/basket.js';
import { createRound } from './ui/round.js';
import { createHolders } from './ui/holders.js';
import { createRounds } from './ui/rounds.js';
import { createDemand } from './ui/demand.js';
import { toast, copyToClipboard } from './ui/toast.js';
import { coinButtonState, snapshotRuleCopy } from './rules.js';
import {
  num,
  fmtSol,
  fmtInt,
  fmtTimeUtc,
  fmtCountdown,
  countdownSentence,
  createCountdown,
  truncAddr,
  DASH,
} from './format.js';

/* -------------------------------------------------------------- constants -- */

// The storage key is an internal identifier and stays as it is, so a returning
// visitor keeps the theme they chose before the product was renamed.
const THEME_KEY = 'stockdrop:theme';
const BRAND = 'STOXVAULT';
const BASE_TITLE = document.title;

const POLL = {
  prices: 30000, // the tape and the table
  stats: 60000, // the round card, the holder card and community demand
  rounds: 300000,
};

const MODE_TEXT = {
  LIVE: 'LIVE',
  DRY_RUN: 'DRY RUN',
  READ_ONLY: 'READ ONLY',
  OFFLINE: 'OFFLINE',
};

const MODE_BANNER = {
  DRY_RUN: 'Simulated — dry run',
  READ_ONLY: 'Read-only — no vault key',
};

/* ------------------------------------------------------------------ state -- */

const state = {
  config: null,
  universe: null,
  stats: null,
  me: null,
  mode: 'OFFLINE',
  stockIndex: new Map(),
  lastOk: null,
};

const timers = new Map();

/* ------------------------------------------------------------------ theme -- */

function readTheme() {
  try {
    return window.localStorage.getItem(THEME_KEY);
  } catch (err) {
    return null;
  }
}

function writeTheme(value) {
  try {
    if (value) window.localStorage.setItem(THEME_KEY, value);
    else window.localStorage.removeItem(THEME_KEY);
  } catch (err) {
    /* private window: the choice simply will not survive the reload */
  }
}

function isDark() {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === 'dark') return true;
  if (explicit === 'light') return false;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme(value) {
  if (value === 'dark' || value === 'light') document.documentElement.dataset.theme = value;
  else delete document.documentElement.dataset.theme;

  const dark = isDark();
  const sun = document.getElementById('theme-icon-sun');
  const moon = document.getElementById('theme-icon-moon');
  if (sun) sun.hidden = dark;
  if (moon) moon.hidden = !dark;

  const toggle = document.getElementById('theme-toggle');
  if (toggle) {
    toggle.setAttribute('aria-pressed', dark ? 'true' : 'false');
    toggle.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  }

  // The shell ships two media-scoped <meta name="theme-color"> tags, which are
  // already correct for both schemes. Nothing to do here.
}

// First statement that touches the DOM: the stored theme, before anything paints.
applyTheme(readTheme());

/* ----------------------------------------------------------------- panels -- */

const tape = createTape({ onRetry: () => loadUniverse({ toastOnError: true }) });

function symbolOf(mint) {
  return state.stockIndex.get(mint)?.symbol || 'That stock';
}

const stocks = createStocks({
  // The drawer's button only ever adds.
  onAdd: (mint) => {
    if (basket.addStock(mint)) {
      toast({
        kind: 'success',
        title: 'Added to your basket',
        text: `${symbolOf(mint)} is in your basket. Save it to make it count.`,
        key: 'basket-add',
      });
    }
  },
  // The tick in the table is a checkbox: it goes both ways.
  onToggle: (mint) => {
    const result = basket.togglePick(mint);
    if (result === 'added') {
      toast({
        kind: 'success',
        title: 'Added to your basket',
        text: `${symbolOf(mint)} is in your basket. Save it to make it count.`,
        key: 'basket-add',
      });
    } else if (result === 'removed') {
      toast({
        kind: 'info',
        title: 'Removed from your basket',
        text: `${symbolOf(mint)} is out. The rest were re-balanced.`,
        key: 'basket-add',
      });
    }
  },
  isPicked: (mint) => basket.isPicked(mint),
  canAdd: (mint) => basket.canAdd(mint),
  onRetry: () => loadUniverse({ toastOnError: true }),
});

const basket = createBasket({
  onChange: () => {
    stocks.refreshTicks();
    demand.setMine(basket.mints());
  },
  onConnect: () => openWalletModal(),
  onSaved: () => {
    loadStats().catch(() => {});
  },
  onRetry: () => loadMe({ toastOnError: true }),
  getStock: (mint) => state.stockIndex.get(mint) || null,
});

const round = createRound({ onRetry: () => loadConfig({ toastOnError: true }).catch(() => {}) });

const holders = createHolders({ onRetry: () => loadStats({ toastOnError: true }).catch(() => {}) });

const demand = createDemand({ onRetry: () => loadStats({ toastOnError: true }) });

const rounds = createRounds({
  onRetry: () => loadRounds({ toastOnError: true }),
  getStock: (mint) => state.stockIndex.get(mint) || null,
});

/* -------------------------------------------------------------- countdown -- */

let lastSrMinute = null;

/**
 * One clock for the whole page.
 *
 * The document title is written here rather than in the round card, because the
 * title has to keep counting while the Overview panel is hidden — a tab in the
 * background is exactly when someone reads it. Everything that is *drawn* (the
 * digits, the ring, the schedule line) is handed to the round card, which
 * ignores it while its panel is offscreen and repaints once on the way back.
 */
const countdown = createCountdown({
  onTick: ({ seconds, text, target }) => {
    round.tick({ seconds, text, target });

    if (seconds !== null && target) {
      document.title = `${BRAND} — next round in ${fmtCountdown(seconds)}`;
      // The live region is coarse and updates at most once a minute.
      const minute = Math.floor(seconds / 60);
      if (minute !== lastSrMinute) {
        lastSrMinute = minute;
        round.say(countdownSentence(seconds));
      }
      // The mark has passed: the keeper runs within its jitter window, so pick
      // up the server's new target rather than counting into the negative.
      if (seconds === 0) scheduleSoon('config', 20000);
    } else {
      document.title = BASE_TITLE;
    }
  },
});

/* ------------------------------------------------------------- header UI -- */

function setMode(mode) {
  state.mode = mode || 'OFFLINE';
  const pill = document.getElementById('status-pill');
  const text = document.getElementById('status-pill-text');
  if (pill) pill.dataset.mode = state.mode;
  if (text) text.textContent = MODE_TEXT[state.mode] || state.mode;

  const banner = document.getElementById('mode-banner');
  const bannerText = document.getElementById('mode-banner-text');
  if (banner) {
    const copy = MODE_BANNER[state.mode];
    banner.hidden = !copy;
    if (copy && bannerText) bannerText.textContent = copy;
  }

  const footerMode = document.getElementById('footer-mode');
  if (footerMode) footerMode.textContent = `mode ${state.mode}`;

  basket.setMode(state.mode);
}

function markFetched() {
  state.lastOk = new Date();
  const el = document.getElementById('footer-updated');
  if (el) {
    el.textContent = `updated ${fmtTimeUtc(state.lastOk)} UTC`;
    el.title = state.lastOk.toISOString();
  }
}

function renderFooterApi() {
  const el = document.getElementById('footer-api');
  if (!el) return;
  const base = api.apiBase();
  try {
    el.textContent = `api ${new URL(base).host}`;
  } catch (err) {
    el.textContent = `api ${base || DASH}`;
  }
  el.title = base;
}

/* ------------------------------------------------------------ token panel -- */

/**
 * Fill every `[data-default-basket]` span with what a holder who never picks
 * actually receives, as the server resolved it.
 *
 * The markup ships with the top-five wording so the page reads correctly before
 * any request lands, but the operator can change the default basket by config,
 * and copy that says "the top five" while the keeper buys something else would
 * be a lie in the one place the reader has no way to check. So the page states
 * what the server reports, not what was true when the HTML was written.
 */
/**
 * Fill every `[data-interval-hours]` span with the round interval the server
 * reports. Separate from `#step-interval`, which `renderSnapshotRule` recreates
 * each time it rewrites step 2 — two elements cannot share that id.
 */
function renderIntervalHours(config) {
  const hours = num(config?.intervalHours) ?? num(config?.rules?.intervalHours);
  if (hours === null) return;
  for (const el of document.querySelectorAll('[data-interval-hours]')) el.textContent = String(hours);
}

function renderDefaultBasket(config) {
  const spans = document.querySelectorAll('[data-default-basket]');
  if (!spans.length) return;
  const info = config?.defaultBasket;
  const picks = Array.isArray(info?.picks) ? info.picks.filter((p) => p && p.symbol) : [];
  if (!picks.length) return; // leave the shipped wording rather than guess

  let text;
  if (picks.length === 1) {
    text = `100% ${picks[0].symbol}`;
  } else if (picks.every((p) => p.pct === picks[0].pct)) {
    text = `${picks.map((p) => p.symbol).join(', ')} — ${picks[0].pct}% each`;
  } else {
    text = picks.map((p) => `${p.symbol} ${p.pct}%`).join(', ');
  }
  for (const span of spans) span.textContent = text;
}

function renderToken(config) {
  const token = config?.token || null;
  const nameEl = document.getElementById('token-name');
  const symbolEl = document.getElementById('token-symbol');
  const mintEl = document.getElementById('token-mint');
  const copyBtn = document.getElementById('btn-copy-mint');

  // Not launched: the shell already says so, honestly. Leave it exactly as is.
  if (!token || !token.launched || !token.mint) return;

  if (nameEl) {
    nameEl.textContent = token.name || 'Token';
    nameEl.classList.remove('tba');
  }
  if (symbolEl) {
    symbolEl.textContent = token.symbol ? `$${token.symbol}` : DASH;
    symbolEl.classList.remove('tba');
  }
  if (mintEl) {
    mintEl.textContent = truncAddr(token.mint, 6, 6);
    mintEl.title = token.mint;
  }
  if (copyBtn) {
    copyBtn.disabled = false;
    if (!copyBtn.dataset.wired) {
      copyBtn.dataset.wired = '1';
      copyBtn.addEventListener('click', () =>
        copyToClipboard(state.config?.token?.mint || '', copyBtn, 'Contract address copied.'),
      );
    }
  }
}

/* ------------------------------------------------------- contract address -- */

const coinBtn = document.getElementById('btn-copy-ca');
const coinTicker = document.getElementById('coin-ticker');

/**
 * The `$STOXVAULT` button in the nav copies the coin's mint.
 *
 * Before launch there is no mint, so the button is disabled, says why, and
 * copies nothing — it never falls back to a placeholder that reads like an
 * address. The moment `/api/config` reports a mint it enables itself; no code
 * change is needed for launch day.
 */
function renderCoinButton(config) {
  if (!coinBtn) return;
  const { ticker, disabled, label } = coinButtonState(config);
  if (coinTicker) coinTicker.textContent = ticker;
  coinBtn.disabled = disabled;
  coinBtn.title = label;
  coinBtn.setAttribute('aria-label', label);
}

if (coinBtn) {
  coinBtn.addEventListener('click', () => {
    // The button is disabled without a mint, and this guard is the second lock:
    // no mint, nothing copied, no toast claiming otherwise.
    const mint = state.config?.token?.mint;
    if (!mint) return;
    copyToClipboard(mint, coinBtn, 'Contract address copied.');
  });
}

/* --------------------------------------------------------- the drop rules -- */

/**
 * Step 2 of "How it works", written from `/api/config.rules`.
 *
 * The anti-cheat rule is an operator setting, so the page states whatever the
 * running server reports: two snapshots and the smaller balance when
 * `antiCheat` is on, the single-snapshot rule when it is off, and the shipped
 * wording untouched when the server says nothing about it at all.
 */
function renderSnapshotRule(config) {
  const titleEl = document.getElementById('step-snapshot-title');
  const textEl = document.getElementById('step-snapshot-text');
  if (!textEl) return;

  const copy = snapshotRuleCopy(config);
  if (!copy) return; // the server named no rule: say nothing new

  // The paragraph is rebuilt, so the `#step-interval` span is re-created with
  // it — basket.renderConfig writes the same number into it right after.
  const interval = document.createElement('span');
  interval.id = 'step-interval';
  interval.textContent = copy.hours;

  if (titleEl) titleEl.textContent = copy.title;
  textEl.replaceChildren(copy.before, interval, copy.after);
}

/* ------------------------------------------------------------ ledger head -- */

/**
 * The two figures above the round table. They describe the ledger, so they live
 * with it in the Rounds panel rather than in an Overview card.
 *
 * `totalSolDistributed` is the public total and the server keeps simulated
 * rounds out of it — the dry-run figure is reported separately under
 * `rounds.simulated` and is deliberately not added in here.
 */
function renderLedgerHead(stats) {
  const distributed = document.getElementById('stat-distributed');
  if (distributed) {
    const total = num(stats?.rounds?.totalSolDistributed);
    distributed.textContent = total === null ? DASH : fmtSol(total, 3);
  }

  const roundsCount = document.getElementById('stat-rounds-count');
  if (roundsCount) {
    const count = Number(stats?.rounds?.count ?? 0);
    if (count === 0) roundsCount.textContent = 'no rounds yet';
    else {
      const last = stats?.rounds?.lastAt ? ` · last ${fmtTimeUtc(stats.rounds.lastAt)} UTC` : '';
      roundsCount.textContent = `${fmtInt(count)} round${count === 1 ? '' : 's'}${last}`;
    }
  }
}

function ledgerHeadError() {
  // Em dashes, not zeros: "nothing was distributed" and "we could not ask" are
  // different claims and only one of them is true.
  for (const id of ['stat-distributed', 'stat-rounds-count']) {
    const el = document.getElementById(id);
    if (el) el.textContent = DASH;
  }
}

/* ----------------------------------------------------------------- loaders -- */

async function loadConfig({ toastOnError = false } = {}) {
  try {
    const config = await api.getConfig();
    state.config = config;
    setMode(config.mode);
    renderToken(config);
    renderCoinButton(config);
    renderDefaultBasket(config);
    renderIntervalHours(config);
    // Before basket.renderConfig: it writes the interval into the
    // `#step-interval` span this rewrite re-creates.
    renderSnapshotRule(config);
    basket.renderConfig(config);
    round.renderConfig(config);
    holders.renderConfig(config);
    rounds.renderConfig(config);
    countdown.setTarget(config.nextRoundAt);
    countdown.start();
    markFetched();
    return config;
  } catch (err) {
    setMode('OFFLINE');
    round.setError(api.errorText(err, 'The server did not answer.'));
    if (toastOnError) {
      toast({
        kind: 'error',
        title: 'API unreachable',
        text: api.errorText(err, 'The server did not answer.'),
        key: 'config',
        onRetry: () => boot(),
      });
    }
    throw err;
  }
}

async function loadUniverse({ toastOnError = false } = {}) {
  try {
    const universe = await api.getUniverse();
    state.universe = universe;
    state.stockIndex = new Map((universe.all || universe.stocks || []).map((s) => [s.mint, s]));
    for (const stock of universe.stocks || []) state.stockIndex.set(stock.mint, stock);

    tape.render(universe);
    stocks.render(universe);
    basket.renderUniverse(universe);
    // The table paints before the basket knows what the default picks are, so
    // the ticks are settled here, once, after both have the same universe.
    // Without this the suggested basket is checked in the allocation panel and
    // unchecked in the table beside it.
    stocks.refreshTicks();
    demand.setMine(basket.mints());
    if (state.stats) demand.render(state.stats, state.stockIndex);
    markFetched();
    return universe;
  } catch (err) {
    const text = api.errorText(err, 'The universe could not be loaded.');
    tape.setError();
    stocks.setError(text);
    basket.setError(text);
    if (toastOnError) {
      toast({ kind: 'error', title: 'Could not load the top 20', text, key: 'universe', onRetry: () => loadUniverse() });
    }
    throw err;
  }
}

async function loadStats({ toastOnError = false } = {}) {
  try {
    const stats = await api.getStats();
    state.stats = stats;
    if (stats.mode && stats.mode !== state.mode) setMode(stats.mode);
    holders.render(stats);
    renderLedgerHead(stats);
    demand.render(stats, state.stockIndex);
    demand.setMine(basket.mints());
    if (stats.nextRoundAt) countdown.setTarget(stats.nextRoundAt);
    markFetched();
    return stats;
  } catch (err) {
    const text = api.errorText(err, 'The API did not respond.');
    holders.setError(text);
    ledgerHeadError();
    demand.setError(api.errorText(err, 'Demand could not be loaded.'));
    if (toastOnError) {
      toast({ kind: 'error', title: 'Stats unavailable', text: api.errorText(err), key: 'stats', onRetry: () => loadStats() });
    }
    throw err;
  }
}

async function loadRounds({ toastOnError = false } = {}) {
  try {
    const page = await api.getRounds({ limit: 25, offset: 0 });
    rounds.render(page);
    markFetched();
    return page;
  } catch (err) {
    rounds.setError(api.errorText(err, 'The ledger could not be loaded.'));
    if (toastOnError) {
      toast({ kind: 'error', title: 'Ledger unavailable', text: api.errorText(err), key: 'rounds', onRetry: () => loadRounds() });
    }
    throw err;
  }
}

async function loadMe({ toastOnError = false } = {}) {
  if (!api.session.get()) return null;
  try {
    const me = await api.getMe();
    state.me = me;
    applyConnected(me);
    return me;
  } catch (err) {
    if (err instanceof api.ApiError && err.isAuth) {
      // The token expired or the server restarted with a new session secret.
      api.session.clear();
      applyDisconnected();
      toast({ kind: 'info', title: 'Session ended', text: 'Connect again to edit your basket.', key: 'session' });
      return null;
    }
    // The universe already gave us a usable default basket, so only the
    // wallet-specific half of this section fails.
    basket.setMeError(api.errorText(err, 'Your wallet view could not be loaded.'));
    if (toastOnError) {
      toast({ kind: 'error', title: 'Could not load your basket', text: api.errorText(err), onRetry: () => loadMe() });
    }
    return null;
  }
}

/* --------------------------------------------------------------- session -- */

function applyConnected(me) {
  state.me = me;
  const address = me?.wallet || api.session.wallet;

  const badge = document.getElementById('wallet-badge');
  const short = document.getElementById('wallet-address-short');
  const connectLabel = document.getElementById('connect-label');
  const disconnectBtn = document.getElementById('btn-disconnect');
  const connectBtn = document.getElementById('btn-connect');

  if (badge) badge.hidden = false;
  if (short && address) {
    short.textContent = truncAddr(address);
    short.title = address;
  }
  if (connectLabel && address) connectLabel.textContent = truncAddr(address);
  if (connectBtn) connectBtn.setAttribute('aria-label', `Connected as ${address}`);
  if (disconnectBtn) disconnectBtn.hidden = false;

  const token = {
    tokenSymbol: state.config?.token?.symbol || null,
    tokenDecimals: state.config?.token?.decimals ?? null,
  };
  basket.renderMe(me, token);
  holders.renderMe(me);
  round.renderMe(me, token);
  demand.setMine(basket.mints());
  stocks.refreshTicks();
}

function applyDisconnected() {
  state.me = null;
  const badge = document.getElementById('wallet-badge');
  const connectLabel = document.getElementById('connect-label');
  const disconnectBtn = document.getElementById('btn-disconnect');
  const connectBtn = document.getElementById('btn-connect');

  if (badge) badge.hidden = true;
  if (connectLabel) connectLabel.textContent = 'Connect wallet';
  if (connectBtn) connectBtn.removeAttribute('aria-label');
  if (disconnectBtn) disconnectBtn.hidden = true;

  basket.setDisconnected();
  holders.setDisconnected();
  round.setDisconnected();
  demand.setMine([]);
  stocks.refreshTicks();
}

/* ---------------------------------------------------------- wallet modal -- */

const walletModal = document.getElementById('wallet-modal');
const walletError = document.getElementById('wallet-error');

function openWalletModal() {
  if (!walletModal) return;
  showWalletError('');
  renderWalletOptions();
  if (typeof walletModal.showModal === 'function' && !walletModal.open) walletModal.showModal();
}

function closeWalletModal() {
  if (walletModal && walletModal.open) walletModal.close();
}

function showWalletError(message) {
  if (!walletError) return;
  walletError.textContent = message || '';
  walletError.hidden = !message;
}

function renderWalletOptions() {
  for (const option of wallet.listWallets()) {
    const button = document.getElementById(`wallet-${option.id}`);
    const meta = document.getElementById(`wallet-${option.id}-meta`);
    const status = document.getElementById(`wallet-${option.id}-status`);
    if (!button || !meta || !status) continue;

    if (option.installed) {
      status.textContent = 'Detected';
      status.classList.add('badge--live');
      status.classList.remove('badge--muted');
      meta.textContent = 'Ready to connect';
      button.removeAttribute('aria-describedby');
    } else {
      status.textContent = 'Install';
      status.classList.remove('badge--live');
      status.classList.add('badge--muted');
      meta.textContent = 'Not installed';
    }
  }
}

async function connectWallet(id) {
  const option = wallet.listWallets().find((w) => w.id === id);
  if (!option) return;

  if (!option.installed) {
    window.open(option.installUrl, '_blank', 'noopener,noreferrer');
    return;
  }

  const connectLabel = document.getElementById('connect-label');
  const button = document.getElementById(`wallet-${id}`);
  showWalletError('');
  if (connectLabel) connectLabel.textContent = 'Connecting…';
  if (button) button.disabled = true;

  try {
    const result = await wallet.signIn(id);
    closeWalletModal();
    applyConnected(result.me || { wallet: result.wallet });
    if (!result.me) await loadMe();
    toast({ kind: 'success', title: 'Wallet connected', text: `Signed in as ${truncAddr(result.wallet)}.` });
  } catch (err) {
    if (connectLabel) connectLabel.textContent = 'Connect wallet';
    const message =
      err instanceof wallet.WalletError
        ? err.message
        : api.errorText(err, 'The wallet could not be verified.');
    showWalletError(message);
  } finally {
    if (button) button.disabled = false;
    if (!api.session.get()) {
      const label = document.getElementById('connect-label');
      if (label) label.textContent = 'Connect wallet';
    }
  }
}

if (walletModal) {
  const options = document.getElementById('wallet-options');
  if (options) {
    options.addEventListener('click', (event) => {
      const button = event.target.closest('[data-wallet]');
      if (button) connectWallet(button.dataset.wallet);
    });
  }
  const closeBtn = document.getElementById('btn-wallet-close');
  if (closeBtn) closeBtn.addEventListener('click', () => closeWalletModal());
  walletModal.addEventListener('click', (event) => {
    if (event.target === walletModal) closeWalletModal();
  });
}

const connectBtn = document.getElementById('btn-connect');
if (connectBtn) {
  connectBtn.addEventListener('click', () => {
    if (api.session.get()) return; // already connected: the badge shows who
    openWalletModal();
  });
}

const disconnectBtn = document.getElementById('btn-disconnect');
if (disconnectBtn) {
  disconnectBtn.addEventListener('click', async () => {
    await wallet.disconnect();
    applyDisconnected();
    toast({ kind: 'info', title: 'Disconnected', text: 'Your saved basket stays on the server until you change it.' });
  });
}

wallet.onWalletsChanged(() => {
  if (walletModal && walletModal.open) renderWalletOptions();
});

/* -------------------------------------------------------------- chrome UI -- */

const themeToggle = document.getElementById('theme-toggle');
if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    writeTheme(next);
    applyTheme(next);
    stocks.applyTheme();
  });
}

if (window.matchMedia) {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onSystemTheme = () => {
    if (!document.documentElement.dataset.theme) {
      applyTheme(null);
      stocks.applyTheme();
    }
  };
  if (typeof media.addEventListener === 'function') media.addEventListener('change', onSystemTheme);
}

const refreshBtn = document.getElementById('btn-refresh');
if (refreshBtn) {
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.classList.add('is-busy');
    refreshBtn.disabled = true;
    await refreshAll({ toastOnError: true });
    refreshBtn.classList.remove('is-busy');
    refreshBtn.disabled = false;
  });
}

/* ------------------------------------------------------------------ tabs -- */

/**
 * Switching a tab fetches nothing.
 *
 * Every panel's data is loaded on boot and kept fresh by the pollers, whether or
 * not it is on screen, so opening a tab never shows a spinner for something that
 * already arrived. What tabs DO control is work: a CSS marquee, an SVG ring and
 * a set of bars all cost frames in a `hidden` panel, so each module is told
 * whether it is visible and stops painting when it is not. None of them rebuild
 * from scratch on the way back — they repaint only if the data moved while they
 * were away.
 */
function applyVisibility() {
  const tab = tabs.current();
  const awake = !document.hidden;
  tape.setVisible(awake && tab === 'overview');
  round.setVisible(awake && tab === 'overview');
  demand.setVisible(awake && tab === 'demand');
}

const tabs = createTabs({
  onSelect: (name, previous) => {
    applyVisibility();
    // The candle chart holds a lightweight-charts instance and an animation
    // frame. Leaving the Basket panel with the drawer open would keep both
    // alive behind a hidden panel, so close it on the way out.
    if (previous === 'basket' && name !== 'basket') stocks.closeDrawer();
  },
});

/* ---------------------------------------------------------------- polling -- */

function stopPolling() {
  for (const timer of timers.values()) clearInterval(timer);
  timers.clear();
}

function startPolling() {
  stopPolling();
  timers.set(
    'prices',
    setInterval(() => {
      loadUniverse().catch(() => {});
    }, POLL.prices),
  );
  timers.set(
    'stats',
    setInterval(() => {
      loadStats().catch(() => {});
      if (api.session.get()) loadMe().catch(() => {});
    }, POLL.stats),
  );
  timers.set(
    'rounds',
    setInterval(() => {
      loadRounds().catch(() => {});
    }, POLL.rounds),
  );
}

/** A one-shot re-read, used when the countdown crosses the mark. */
function scheduleSoon(what, delay) {
  const key = `soon:${what}`;
  if (timers.has(key)) return;
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      if (what === 'config') {
        loadConfig().catch(() => {});
        loadRounds().catch(() => {});
      }
    }, delay),
  );
}

// The catch-up refresh below is throttled, and it has to be.
//
// `visibilitychange` is not always a person switching tabs. Embedded webviews,
// some mobile browsers and preview panes flap the visibility state on their own
// — measured here at six flips in six seconds — and an unthrottled refresh turns
// each flip into an /api/universe and an /api/stats call. That is a request every
// couple of seconds from a single idle tab, against endpoints that reach Jupiter
// and the RPC, so it burns the project's RPC quota for no new information.
//
// A catch-up is only worth making when the data is actually stale, so skip it
// when the last successful refresh is newer than this.
const VISIBILITY_REFRESH_MIN_MS = 15000;
let lastVisibilityRefresh = 0;

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling();
    countdown.stop();
    applyVisibility(); // a background tab animates nothing
    return;
  }
  countdown.start();
  startPolling();
  applyVisibility();

  // Coming back to a stale tab: refresh the cheap things immediately, but only
  // if enough time has passed that they could have changed.
  const now = Date.now();
  if (now - lastVisibilityRefresh < VISIBILITY_REFRESH_MIN_MS) return;
  lastVisibilityRefresh = now;
  loadStats().catch(() => {});
  loadUniverse().catch(() => {});
});

/* ------------------------------------------------------------------- boot -- */

async function refreshAll({ toastOnError = false } = {}) {
  const results = await Promise.allSettled([
    loadConfig({ toastOnError }),
    loadUniverse({ toastOnError }),
    loadStats({ toastOnError }),
    loadRounds({ toastOnError }),
  ]);
  if (api.session.get()) await loadMe();
  return results;
}

async function boot() {
  renderFooterApi();
  wallet.discover();
  renderWalletOptions();

  tape.setLoading();
  stocks.setLoading();
  basket.setLoading();
  round.setLoading();
  holders.setLoading();
  rounds.setLoading();
  demand.setLoading();

  // The tab bar is wired before the first request, so a deep link like
  // `#basket` opens on the right panel rather than flipping to it once the data
  // lands. Every panel is loaded either way — see `applyVisibility`.
  tabs.start();
  applyVisibility();

  // Config first — it settles the mode pill, the rules prose and the countdown
  // target — but it does not block the other three, which each own their state.
  const configPromise = loadConfig({ toastOnError: true }).catch(() => null);

  const results = await Promise.allSettled([
    configPromise,
    loadUniverse(),
    loadStats(),
    loadRounds(),
  ]);

  const failures = results.filter((r) => r.status === 'rejected').length;
  if (failures > 0 && failures < results.length) {
    toast({
      kind: 'warn',
      title: 'Some sections did not load',
      text: 'The panels that failed show a retry button. Everything else is live.',
      key: 'partial',
    });
  }

  // Restore a session last, so the basket lands on a universe that already
  // exists and the projection has a pool figure to quote.
  try {
    const restored = await wallet.restore();
    if (restored) await loadMe();
  } catch (err) {
    /* a session that will not restore is simply a disconnected page */
  }

  if (!document.hidden) startPolling();
}

// The shell loads this module with `type="module"`, so the DOM is already
// parsed by the time it runs.
boot();

// Exposed for a console sanity check against a running server; nothing in the
// page reads it.
window.STOCKDROP = Object.assign(window.STOCKDROP || {}, {
  debug: {
    state,
    reload: refreshAll,
    api,
    tabs,
    panels: { tape, stocks, basket, round, holders, rounds, demand },
  },
});
