/**
 * STOXVAULT — the holders card (Overview, card 3).
 *
 * Three figures and one sentence. The big numeral takes a value and never a
 * sentence — it is set at 40px+ in the shell, so an explanation there wraps to
 * four lines. The explanation lives in `#holders-note` instead.
 *
 * Before launch there is no token, so there is nobody to count: the numeral is
 * an em dash and the note says why. That is an honest empty state, not an error,
 * and it never becomes a zero.
 */

import { fmtInt, num, DASH } from '../format.js';

export function createHolders({ onRetry } = {}) {
  const card = document.getElementById('card-holders');
  const eligibleEl = document.getElementById('stat-eligible-wallets');
  const thresholdEl = document.getElementById('holders-threshold');
  const prefEl = document.getElementById('stat-pref-wallets');
  const shareEl = document.getElementById('stat-your-share');
  const noteEl = document.getElementById('holders-note');
  const errorText = document.getElementById('holders-error-text');
  const retryBtn = document.getElementById('btn-holders-retry');

  if (!card) {
    return { renderConfig() {}, render() {}, renderMe() {}, setDisconnected() {}, setLoading() {}, setError() {} };
  }

  if (retryBtn && typeof onRetry === 'function') retryBtn.addEventListener('click', () => onRetry());

  let launched = false;
  let connected = false;

  function renderNote() {
    if (!noteEl) return;
    if (!launched) {
      noteEl.textContent = 'No token yet — there is nobody to count.';
      return;
    }
    noteEl.textContent = connected
      ? 'Your share is an estimate until the round runs.'
      : 'Connect a wallet to see your share.';
  }

  return {
    /** `/api/config` names the eligibility threshold; the words are static. */
    renderConfig(config) {
      // num(), not Number(): a missing eligibleBps must stay unknown rather
      // than become 0% and claim every wallet on earth qualifies.
      const bps = num(config?.rules?.eligibleBps);
      if (thresholdEl && bps !== null) thresholdEl.textContent = `≥ ${bps / 100}%`;
      if (typeof config?.token?.launched === 'boolean') launched = config.token.launched;
      renderNote();
    },

    /** @param {object} stats the `/api/stats` document */
    render(stats) {
      launched = Boolean(stats?.launched);

      if (eligibleEl) {
        const count = num(stats?.eligibleHolders);
        eligibleEl.textContent = count === null ? DASH : fmtInt(count);
      }
      if (prefEl) {
        const prefs = num(stats?.prefHolders);
        prefEl.textContent = prefs === null ? DASH : fmtInt(prefs);
      }

      renderNote();
      card.dataset.state = 'ready';
    },

    /** The connected wallet's share of the pool, mirrored from the projection. */
    renderMe(me) {
      connected = Boolean(me);
      if (shareEl) {
        const bps = num(me?.projected?.shareBps);
        shareEl.textContent = bps === null ? DASH : `${(bps / 100).toFixed(2)}%`;
      }
      renderNote();
    },

    setDisconnected() {
      connected = false;
      if (shareEl) shareEl.textContent = DASH;
      renderNote();
    },

    setLoading() {
      card.dataset.state = 'loading';
    },

    setError(message) {
      if (errorText && message) errorText.textContent = message;
      if (eligibleEl) eligibleEl.textContent = DASH;
      if (prefEl) prefEl.textContent = DASH;
      card.dataset.state = 'error';
    },
  };
}

export default createHolders;
