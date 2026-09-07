/**
 * STOCKDROP — boot and orchestration.
 *
 * Every section owns its own `[data-state]` container and its own try/catch, so
 * a slow universe, an unreachable RPC or a 500 on the ledger costs you that one
 * panel and nothing else. Nothing on this page is ever filled with a plausible
 * number when its endpoint failed — the section flips to its error pane and
 * offers the retry button that is already in the markup.
 */

import * as api from './api.js';
import * as wallet from './wallet.js';
import { createTape } from './ui/tape.js';
import { createStocks } from './ui/stocks.js';
import { createBasket } from './ui/basket.js';
import { createVault } from './ui/vault.js';
import { createRounds } from './ui/rounds.js';
import { createDemand } from './ui/demand.js';
import { toast, copyToClipboard } from './ui/toast.js';
import {
  fmtSol,
  fmtUsd,
  fmtInt,
  fmtTimeUtc,
  fmtRelative,
  fmtCountdown,
  countdownSentence,
  createCountdown,
  truncAddr,
  isoOf,
  DASH,
} from './format.js';

/* -------------------------------------------------------------- constants -- */

const THEME_KEY = 'stockdrop:theme';
const BRAND = 'STOCKDROP';
const BASE_TITLE = document.title;

const POLL = {
  prices: 30000, // the tape and the table
  stats: 60000, // hero numbers + community demand
  vault: 60000,
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
  vault: null,
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

const stocks = createStocks({
  onAdd: (mint) => {
    if (basket.addStock(mint)) {
      const stock = state.stockIndex.get(mint);
      toast({
        kind: 'success',
        title: 'Added to your basket',
        text: `${stock?.symbol || 'That stock'} is in your basket. Save it to make it count.`,
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
    stocks.refreshAddButtons();
    demand.setMine(basket.mints());
  },
  onConnect: () => openWalletModal(),
  onSaved: () => {
    loadStats().catch(() => {});
  },
  onRetry: () => loadMe({ toastOnError: true }),
  getStock: (mint) => state.stockIndex.get(mint) || null,
});

const vault = createVault();

const demand = createDemand({ onRetry: () => loadStats({ toastOnError: true }) });

const rounds = createRounds({
  onRetry: () => loadRounds({ toastOnError: true }),
  getStock: (mint) => state.stockIndex.get(mint) || null,
});

/* -------------------------------------------------------------- countdown -- */

const countdownValue = document.getElementById('countdown-value');
const countdownSr = document.getElementById('countdown-sr');
const nextRoundAtEl = document.getElementById('stat-next-round-at');

let lastSrMinute = null;

const countdown = createCountdown({
  onTick: ({ seconds, text, target }) => {
    if (countdownValue) countdownValue.textContent = seconds === null ? '--:--:--' : text;

    if (seconds !== null && target) {
      document.title = `${BRAND} — next round in ${fmtCountdown(seconds)}`;
      if (nextRoundAtEl) {
        nextRoundAtEl.textContent = `${fmtTimeUtc(target)} UTC · ${fmtRelative(target)}`;
        nextRoundAtEl.title = isoOf(target);
      }
      // The live region is coarse and updates at most once a minute.
      const minute = Math.floor(seconds / 60);
      if (countdownSr && minute !== lastSrMinute) {
        lastSrMinute = minute;
        countdownSr.textContent = countdownSentence(seconds);
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

/* -------------------------------------------------------------- hero stats -- */

function renderStats(stats) {
  const heroStats = document.getElementById('hero-stats');

  const vaultSol = document.getElementById('stat-vault-sol');
  const vaultUsd = document.getElementById('stat-vault-usd');
  if (vaultSol) vaultSol.textContent = stats?.vault?.balanceSol === null || stats?.vault?.balanceSol === undefined ? DASH : fmtSol(stats.vault.balanceSol, 3);
  if (vaultUsd) {
    vaultUsd.textContent =
      stats?.vault?.balanceUsd === null || stats?.vault?.balanceUsd === undefined ? DASH : `≈ ${fmtUsd(stats.vault.balanceUsd)}`;
  }

  const prefWallets = document.getElementById('stat-pref-wallets');
  if (prefWallets) prefWallets.textContent = fmtInt(stats?.prefHolders ?? 0);

  const eligible = document.getElementById('stat-eligible-wallets');
  if (eligible) {
    if (!stats?.launched) eligible.textContent = `${DASH} eligible holders (no token yet)`;
    else if (stats.eligibleHolders === null || stats.eligibleHolders === undefined) eligible.textContent = 'eligible holders unknown';
    else eligible.textContent = `${fmtInt(stats.eligibleHolders)} eligible holders`;
  }

  const distributed = document.getElementById('stat-distributed');
  if (distributed) {
    const total = stats?.rounds?.totalSolDistributed;
    distributed.textContent = total === null || total === undefined ? DASH : fmtSol(total, 3);
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

  if (heroStats) heroStats.dataset.state = 'ready';
}

function statsError() {
  const heroStats = document.getElementById('hero-stats');
  for (const id of ['stat-vault-sol', 'stat-vault-usd', 'stat-pref-wallets', 'stat-distributed']) {
    const el = document.getElementById(id);
    if (el) el.textContent = DASH;
  }
  const eligible = document.getElementById('stat-eligible-wallets');
  if (eligible) eligible.textContent = 'could not reach the API';
  const roundsCount = document.getElementById('stat-rounds-count');
  if (roundsCount) roundsCount.textContent = DASH;
  // The hero has no error pane; unmasking with em dashes is the honest state.
  if (heroStats) heroStats.dataset.state = 'ready';
}

/* ----------------------------------------------------------------- loaders -- */

async function loadConfig({ toastOnError = false } = {}) {
  try {
    const config = await api.getConfig();
    state.config = config;
    setMode(config.mode);
    renderToken(config);
    basket.renderConfig(config);
    vault.renderConfig(config);
    rounds.renderConfig(config);
    countdown.setTarget(config.nextRoundAt);
    countdown.start();
    markFetched();
    return config;
  } catch (err) {
    setMode('OFFLINE');
    if (countdownValue) countdownValue.textContent = '--:--:--';
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
    renderStats(stats);
    demand.render(stats, state.stockIndex);
    demand.setMine(basket.mints());
    if (stats.nextRoundAt) countdown.setTarget(stats.nextRoundAt);
    markFetched();
    return stats;
  } catch (err) {
    statsError();
    demand.setError(api.errorText(err, 'Demand could not be loaded.'));
    if (toastOnError) {
      toast({ kind: 'error', title: 'Stats unavailable', text: api.errorText(err), key: 'stats', onRetry: () => loadStats() });
    }
    throw err;
  }
}

async function loadVault({ toastOnError = false } = {}) {
  try {
    const doc = await api.getVault();
    state.vault = doc;
    vault.render(doc, state.stockIndex);
    basket.setPool(doc.poolSol);
    markFetched();
    return doc;
  } catch (err) {
    vault.setError();
    if (toastOnError) {
      toast({ kind: 'error', title: 'Vault unavailable', text: api.errorText(err), key: 'vault', onRetry: () => loadVault() });
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

  basket.renderMe(me, {
    tokenSymbol: state.config?.token?.symbol || null,
    tokenDecimals: state.config?.token?.decimals ?? null,
  });
  demand.setMine(basket.mints());
  stocks.refreshAddButtons();
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
  demand.setMine([]);
  stocks.refreshAddButtons();
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

/* ------------------------------------------------------------ nav current -- */

function watchSections() {
  const links = [...document.querySelectorAll('[data-nav-link]')];
  if (links.length === 0 || typeof IntersectionObserver === 'undefined') return;

  const sections = links
    .map((link) => ({ link, section: document.getElementById(link.dataset.navLink) }))
    .filter((entry) => entry.section);

  const visible = new Map();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) visible.set(entry.target.id, entry.isIntersecting ? entry.intersectionRatio : 0);
      let bestId = null;
      let bestRatio = 0;
      for (const [id, ratio] of visible) {
        if (ratio > bestRatio) {
          bestRatio = ratio;
          bestId = id;
        }
      }
      for (const { link } of sections) {
        if (bestId && link.dataset.navLink === bestId) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
      }
    },
    { rootMargin: '-96px 0px -55% 0px', threshold: [0, 0.15, 0.4, 0.75] },
  );

  for (const { section } of sections) observer.observe(section);
}

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
    'vault',
    setInterval(() => {
      loadVault().catch(() => {});
    }, POLL.vault),
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

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling();
    countdown.stop();
  } else {
    countdown.start();
    startPolling();
    // Coming back to a stale tab: refresh the cheap things immediately.
    loadStats().catch(() => {});
    loadUniverse().catch(() => {});
  }
});

/* ------------------------------------------------------------------- boot -- */

async function refreshAll({ toastOnError = false } = {}) {
  const results = await Promise.allSettled([
    loadConfig({ toastOnError }),
    loadUniverse({ toastOnError }),
    loadStats({ toastOnError }),
    loadVault({ toastOnError }),
    loadRounds({ toastOnError }),
  ]);
  if (api.session.get()) await loadMe();
  return results;
}

async function boot() {
  renderFooterApi();
  watchSections();
  wallet.discover();
  renderWalletOptions();

  tape.setLoading();
  stocks.setLoading();
  basket.setLoading();
  vault.setLoading();
  rounds.setLoading();
  demand.setLoading();

  // Config first — it settles the mode pill, the rules prose and the countdown
  // target — but it does not block the other five, which each own their state.
  const configPromise = loadConfig({ toastOnError: true }).catch(() => null);

  const results = await Promise.allSettled([
    configPromise,
    loadUniverse(),
    loadStats(),
    loadVault(),
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
    panels: { tape, stocks, basket, vault, rounds, demand },
  },
});
