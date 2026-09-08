/**
 * STOXVAULT — the next-round card (Overview, card 2).
 *
 * The countdown, the schedule line, the progress ring, and the snapshot state.
 *
 * A snapshot is a moment inside a round rather than a place, so it is a state of
 * this card and not a sixth tab. It is shown only when the API actually reported
 * an opening snapshot for the cycle running now — there is no demo state, and no
 * offset is ever synthesised from the clock.
 *
 * Nothing here paints while the Overview panel is hidden. The countdown keeps
 * ticking (the document title is driven from it) but the ring and the digits are
 * only written when someone can see them, and repainted once on the way back.
 */

import { fmtTokenAmount, fmtTimeUtc, fmtRelative, isoOf, num, DASH } from '../format.js';

// 2πr with r = 34, matching the <circle> in the shell.
const RING_CIRCUMFERENCE = 213.63;

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * A signed offset in words: `-4 min 12 sec`, `+58 sec`, `on the mark`.
 * @param {number} ms signed milliseconds from the mark
 */
export function offsetWords(ms) {
  const n = num(ms);
  if (n === null) return DASH;
  const seconds = Math.round(Math.abs(n) / 1000);
  if (seconds === 0) return 'on the mark';
  const sign = n < 0 ? '-' : '+';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${sign}${minutes} min ${pad2(rest)} sec` : `${sign}${seconds} sec`;
}

export function createRound({ onRetry } = {}) {
  const card = document.getElementById('card-round');
  const valueEl = document.getElementById('countdown-value');
  const srEl = document.getElementById('countdown-sr');
  const scheduleEl = document.getElementById('stat-next-round-at');
  const ring = document.getElementById('round-ring');
  const arc = document.getElementById('round-ring-arc');
  const pctEl = document.getElementById('round-progress-pct');
  const labelEl = document.getElementById('round-progress-label');
  const errorText = document.getElementById('round-error-text');
  const retryBtn = document.getElementById('btn-round-retry');

  const snapshot = document.getElementById('round-snapshot');
  const snapshotOffset = document.getElementById('snapshot-offset');
  const snapshotCheck = document.getElementById('snapshot-check');
  const snapshotBalance = document.getElementById('snapshot-balance');

  if (!card) {
    return {
      renderConfig() {},
      tick() {},
      renderMe() {},
      setDisconnected() {},
      setVisible() {},
      setLoading() {},
      setError() {},
    };
  }

  if (retryBtn && typeof onRetry === 'function') retryBtn.addEventListener('click', () => onRetry());

  let visible = true;
  let intervalHours = null;
  let jitterMin = null;
  let scheduleText = null;
  let last = { seconds: null, text: '--:--:--', target: null };
  let dirty = false;

  /** The start of the cycle running now: the previous mark. */
  function cycleStartMs(target) {
    if (!target || intervalHours === null) return null;
    return target.getTime() - intervalHours * 3600 * 1000;
  }

  function paintSchedule() {
    if (!scheduleEl) return;
    if (scheduleText) {
      scheduleEl.textContent = scheduleText;
      scheduleEl.removeAttribute('title');
      return;
    }
    // No interval reported: fall back to naming the target itself, or say
    // nothing at all rather than inventing a cadence.
    if (last.target) {
      scheduleEl.textContent = `${fmtTimeUtc(last.target)} UTC · ${fmtRelative(last.target)}`;
      scheduleEl.title = isoOf(last.target);
    } else {
      scheduleEl.textContent = DASH;
    }
  }

  function paint() {
    if (!visible) {
      dirty = true;
      return;
    }
    dirty = false;

    const { seconds, text, target } = last;
    if (valueEl) valueEl.textContent = seconds === null ? '--:--:--' : text;

    paintSchedule();

    // Round progress: how far through the current cycle we are. Derived from
    // the server's own interval and next-round time, never guessed.
    let pct = null;
    if (seconds !== null && intervalHours !== null && intervalHours > 0) {
      const total = intervalHours * 3600;
      pct = Math.max(0, Math.min(100, ((total - seconds) / total) * 100));
    }

    if (arc) {
      const drawn = pct === null ? 0 : (RING_CIRCUMFERENCE * pct) / 100;
      arc.setAttribute('stroke-dasharray', `${drawn.toFixed(2)} ${RING_CIRCUMFERENCE}`);
    }
    if (pctEl) pctEl.textContent = pct === null ? DASH : `${Math.round(pct)}%`;
    if (ring) {
      ring.setAttribute(
        'aria-label',
        pct === null ? 'Round progress is not known yet' : `Round progress ${Math.round(pct)} percent`,
      );
    }
    if (labelEl) {
      if (seconds === null) labelEl.textContent = DASH;
      else labelEl.textContent = snapshot && !snapshot.hidden ? 'Snapshot' : 'Filling';
    }
  }

  return {
    /**
     * `/api/config`: the cadence sentence and the interval the ring is drawn
     * against. The sentence states the mechanism, so it does not tick.
     */
    renderConfig(config) {
      const hours = num(config?.intervalHours) ?? num(config?.rules?.intervalHours);
      intervalHours = hours;
      jitterMin = num(config?.rules?.jitterMin);

      if (hours !== null) {
        scheduleText =
          jitterMin === null
            ? `Every ${hours} hours`
            : `Every ${hours} hours · snapshot ±${jitterMin} min random offset`;
      }
      card.dataset.state = 'ready';
      paint();
    },

    /** One second of the shared countdown. */
    tick({ seconds, text, target }) {
      last = { seconds, text, target: target || null };
      paint();
    },

    /** The screen-reader sentence, written by the caller at most once a minute. */
    say(sentence) {
      if (srEl && sentence) srEl.textContent = sentence;
    },

    /**
     * `/api/me.cycle` carries this cycle's opening snapshot when the server took
     * one. Nothing else on the page may reveal a snapshot: `stats.snapshotAt`
     * can describe an on-demand holder read rather than a scheduled snapshot,
     * and calling that "snapshot taken" would be a claim the server did not make.
     */
    renderMe(me, { tokenSymbol = null, tokenDecimals = null } = {}) {
      if (!snapshot) return;
      const cycle = me && typeof me.cycle === 'object' && me.cycle ? me.cycle : null;
      const takenAt = typeof cycle?.openSnapshotAt === 'string' ? Date.parse(cycle.openSnapshotAt) : NaN;
      const start = cycleStartMs(last.target);

      // Only for the cycle running now. When the next cycle starts, the old
      // snapshot stops being news and the block hides itself again.
      const current =
        Number.isFinite(takenAt) && (start === null || takenAt >= start) && takenAt <= Date.now() + 60000;

      if (!current) {
        snapshot.hidden = true;
        if (snapshotCheck) snapshotCheck.hidden = true;
        paint();
        return;
      }

      snapshot.hidden = false;
      if (snapshotOffset) {
        snapshotOffset.textContent = start === null ? DASH : offsetWords(takenAt - start);
        snapshotOffset.title = isoOf(cycle.openSnapshotAt);
      }

      const raw = typeof cycle.openBalanceRaw === 'string' ? cycle.openBalanceRaw : null;
      if (snapshotCheck) snapshotCheck.hidden = raw === null;
      if (raw !== null && snapshotBalance) {
        const decimals = Number.isInteger(tokenDecimals) ? tokenDecimals : 6;
        const amount = fmtTokenAmount(raw, decimals, { maxDecimals: 2 });
        snapshotBalance.textContent = tokenSymbol ? `${amount} ${tokenSymbol}` : amount;
        snapshotBalance.title = `${raw} base units, ${decimals} decimals`;
      }
      paint();
    },

    setDisconnected() {
      if (snapshot) snapshot.hidden = true;
      if (snapshotCheck) snapshotCheck.hidden = true;
      paint();
    },

    /** Offscreen panels do not animate: the ring and the digits stop being written. */
    setVisible(next) {
      const was = visible;
      visible = Boolean(next);
      if (visible && (!was || dirty)) paint();
    },

    setLoading() {
      card.dataset.state = 'loading';
    },

    setError(message) {
      if (errorText && message) errorText.textContent = message;
      if (valueEl) valueEl.textContent = '--:--:--';
      card.dataset.state = 'error';
    },
  };
}

export default createRound;
