/**
 * STOXVAULT — the call-to-action banner (`#cta`, under the header, above the
 * panels, so it is on screen whichever tab is open).
 *
 * Every decision this module makes about WHAT to say lives in `../cta.js` and is
 * pure. This file only paints it, remembers a dismissal, and moves focus.
 *
 * Three behaviours worth knowing:
 *
 *   - Dismissal is per state (see `cta.js`). Waving away the not-connected
 *     prompt does not hide the "you qualify and have not chosen" one, because
 *     that is new information about a different situation.
 *   - Saving or clearing a basket clears every dismissal, so the receipt is
 *     shown even to somebody who closed the prompt that led them there.
 *   - Every `localStorage` touch is wrapped: a private window throws on read
 *     as well as write, and a banner that cannot remember a dismissal is still
 *     a working banner.
 */

import { ctaState, ctaCopy, shouldShow, parseDismissed, serialiseDismissed, DISMISS_KEY } from '../cta.js';
import { coarseDuration } from '../format.js';

function readDismissed() {
  try {
    return parseDismissed(window.localStorage.getItem(DISMISS_KEY));
  } catch (err) {
    return new Set(); // private window, or storage blocked: nothing is remembered
  }
}

function writeDismissed(set) {
  try {
    const value = serialiseDismissed(set);
    if (value) window.localStorage.setItem(DISMISS_KEY, value);
    else window.localStorage.removeItem(DISMISS_KEY);
  } catch (err) {
    /* the dismissal simply will not survive the reload */
  }
}

/**
 * @param {object} handlers
 * @param {() => void} handlers.onConnect  open the wallet modal
 * @param {() => void} handlers.onBasket   switch to the Basket tab and focus it
 * @param {(mint: string) => string|null} [handlers.symbolOf]
 */
export function createCta({ onConnect, onBasket, symbolOf } = {}) {
  const root = document.getElementById('cta');
  const titleEl = document.getElementById('cta-title');
  const textEl = document.getElementById('cta-text');
  const metaEl = document.getElementById('cta-meta');
  const primaryBtn = document.getElementById('btn-cta-primary');
  const secondaryBtn = document.getElementById('btn-cta-secondary');
  const dismissBtn = document.getElementById('btn-cta-dismiss');

  if (!root || !titleEl || !textEl || !primaryBtn || !secondaryBtn) {
    return {
      renderConfig() {},
      renderMe() {},
      setDisconnected() {},
      notifySaved() {},
      tick() {},
      render() {},
      state: () => 'none',
    };
  }

  let config = null;
  let me = null;
  let connected = false;
  let seconds = null;
  let dismissed = readDismissed();
  let view = { state: 'none', key: null };

  function act(action) {
    if (action === 'connect' && typeof onConnect === 'function') onConnect();
    else if (action === 'basket' && typeof onBasket === 'function') onBasket();
  }

  function paintAction(button, spec) {
    if (!spec) {
      button.hidden = true;
      button.removeAttribute('data-cta-action');
      return;
    }
    button.hidden = false;
    button.textContent = spec.label;
    button.dataset.ctaAction = spec.action;
  }

  function render() {
    view = ctaState({ config, me, connected, symbolOf });

    if (!shouldShow(view, dismissed)) {
      root.hidden = true;
      root.dataset.state = view.state;
      return;
    }

    const copy = ctaCopy(view, { countdown: seconds === null ? null : coarseDuration(seconds) });
    if (!copy) {
      root.hidden = true;
      root.dataset.state = 'none';
      return;
    }

    root.dataset.state = view.state;
    titleEl.textContent = copy.title;
    textEl.textContent = copy.text;
    if (metaEl) {
      metaEl.textContent = copy.meta || '';
      metaEl.hidden = !copy.meta;
    }

    // The primary slot carries `.btn--primary`; the calm states leave it empty
    // and use the secondary slot only, so there is no gold bar on a receipt.
    paintAction(primaryBtn, copy.primary);
    paintAction(secondaryBtn, copy.secondary);
    root.hidden = false;
  }

  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-cta-action]');
    if (button && !button.hidden) act(button.dataset.ctaAction);
  });

  if (dismissBtn) {
    dismissBtn.addEventListener('click', () => {
      if (view.key) {
        dismissed.add(view.key);
        writeDismissed(dismissed);
      }
      root.hidden = true;
    });
  }

  return {
    /** `/api/config` — launch state and the server's real default basket. */
    renderConfig(next) {
      config = next || null;
      render();
    },

    /** `/api/me` — eligibility and whether a basket was actually saved. */
    renderMe(next) {
      me = next || null;
      connected = Boolean(next);
      render();
    },

    setDisconnected() {
      me = null;
      connected = false;
      render();
    },

    /**
     * A basket was saved, or cleared back to the default. Both are new
     * information, so every dismissal is dropped and the banner re-renders
     * without waiting for the next `/api/me`.
     *
     * @param {Array<{mint: string, pct: number}>|null} picks what the server
     *   confirmed it stored, or null when the saved basket was deleted
     */
    notifySaved(picks) {
      dismissed = new Set();
      writeDismissed(dismissed);
      if (me) {
        me = {
          ...me,
          prefs: Array.isArray(picks) && picks.length > 0 ? { ...(me.prefs || {}), picks } : null,
          picksSource: Array.isArray(picks) && picks.length > 0 ? 'prefs' : 'default',
        };
      }
      render();
    },

    /** The page's one clock. Only the "you have not picked" state prints it. */
    tick(nextSeconds) {
      const value = Number.isFinite(nextSeconds) ? nextSeconds : null;
      // Repaint at most once a minute: the banner shows `4h 36m`, not seconds.
      const before = seconds === null ? null : Math.floor(seconds / 60);
      const after = value === null ? null : Math.floor(value / 60);
      seconds = value;
      if (before !== after && view.state === 'choose' && !root.hidden) render();
    },

    render,
    state: () => view.state,
  };
}

export default createCta;
