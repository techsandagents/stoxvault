/**
 * STOCKDROP — formatting.
 *
 * One place for every number, address and timestamp on the page, so the columns
 * line up and nothing is rendered two different ways in two different sections.
 * The rules are web/DOM.md section 16:
 *
 *   money      $1,234.56 under 10k, then $12.3K / $4.56M / $1.23B / $5.56T
 *   SOL        4 dp for balances, 3 dp for pools
 *   percent    always signed, 2 dp, with a direction for the colour hook
 *   addresses  first4…last4, full value in `title` and on the clipboard
 *   amounts    base-unit strings converted with BigInt — never parseFloat
 *   times      UTC, never silently localised
 *   unknown    an em dash, never 0, "N/A" or "undefined"
 */

export const DASH = '—'; // em dash: the only way "unknown" is ever rendered
const THIN = ' ';

const NBSP = ' ';

/** A finite number, or null. Everything in this file funnels through it. */
export function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Group digits with commas, keeping exactly `dp` decimals. */
export function fixed(value, dp = 2) {
  const n = num(value);
  if (n === null) return null;
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** Integer with thousands separators. `1,234` */
export function fmtInt(value) {
  const n = num(value);
  if (n === null) return DASH;
  return Math.round(n).toLocaleString('en-US');
}

/* ------------------------------------------------------------------ money -- */

/**
 * Money the brokerage way: exact under $10,000, compact above it.
 * `$1,234.56`, `$12.3K`, `$4.56M`, `$1.23B`, `$5.56T`.
 */
export function fmtUsd(value, { compactAbove = 10000, dp = 2 } = {}) {
  const n = num(value);
  if (n === null) return DASH;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs < compactAbove) return `${sign}$${fixed(abs, dp)}`;
  return `${sign}$${compactNumber(abs)}`;
}

/** Always compact, for market caps and liquidity. `$1.95T` */
export function fmtUsdCompact(value) {
  const n = num(value);
  if (n === null) return DASH;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs < 1000) return `${sign}$${fixed(abs, 2)}`;
  return `${sign}$${compactNumber(abs)}`;
}

/**
 * 12.3K / 4.56M / 1.23B / 5.56T — three significant figures, so the column
 * stays the same width whatever the magnitude.
 */
export function compactNumber(value) {
  const n = Math.abs(num(value) ?? 0);
  const units = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [scale, suffix] of units) {
    if (n >= scale) {
      const scaled = n / scale;
      const dp = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
      return `${scaled.toFixed(dp)}${suffix}`;
    }
  }
  return n.toFixed(2);
}

/* -------------------------------------------------------------------- SOL -- */

/** SOL balance, 4 dp by default (3 for pools). The unit is a separate span. */
export function fmtSol(value, dp = 4) {
  const n = num(value);
  if (n === null) return DASH;
  return fixed(n, dp);
}

/** SOL with the unit inline, for places without a `.stat__unit` span. */
export function fmtSolWithUnit(value, dp = 4) {
  const n = num(value);
  if (n === null) return DASH;
  return `${fixed(n, dp)}${NBSP}SOL`;
}

/** lamports (string | bigint | number) -> SOL text. Exact, via BigInt. */
export function lamportsToSolText(lamports, dp = 4) {
  const raw = toRawString(lamports);
  if (raw === null) return DASH;
  return fixed(baseUnitsToNumber(raw, 9), dp);
}

/* ---------------------------------------------------------------- percent -- */

/** `+1.24%` / `-0.60%` / `0.00%`. Always signed, always 2 dp. */
export function fmtPct(value, dp = 2) {
  const n = num(value);
  if (n === null) return DASH;
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}${fixed(Math.abs(n), dp)}%`;
}

/** Unsigned percentage, for allocation shares. `35%` / `4.20%` */
export function fmtShare(value, dp = 0) {
  const n = num(value);
  if (n === null) return DASH;
  return `${fixed(n, dp)}%`;
}

/** basis points -> percent text. 42 bps -> `0.42%` */
export function fmtBps(bps, dp = 2) {
  const n = num(bps);
  if (n === null) return DASH;
  return `${fixed(n / 100, dp)}%`;
}

/** The colour hook the CSS reads: data-dir="up|down|flat". */
export function dirOf(value) {
  const n = num(value);
  if (n === null || n === 0) return 'flat';
  return n > 0 ? 'up' : 'down';
}

/* --------------------------------------------------- base-unit arithmetic -- */

/**
 * Token amounts arrive as strings of base units. They can exceed 2^53, so every
 * conversion in here goes through BigInt. `parseFloat` on a token amount is a
 * bug, not a shortcut.
 */
export function toRawString(value) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null;
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  return /^-?\d+$/.test(raw) ? raw : null;
}

/**
 * Base units -> a decimal string, exactly, with no float anywhere.
 * `baseUnitsToString('123456789', 8)` -> `'1.23456789'`
 */
export function baseUnitsToString(raw, decimals = 0) {
  const s = toRawString(raw);
  if (s === null) return null;
  const d = Number.isInteger(decimals) && decimals >= 0 ? decimals : 0;
  const negative = s.startsWith('-');
  const digits = negative ? s.slice(1) : s;
  if (d === 0) return `${negative ? '-' : ''}${digits}`;
  const padded = digits.padStart(d + 1, '0');
  const whole = padded.slice(0, padded.length - d);
  const frac = padded.slice(padded.length - d);
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/**
 * Base units -> a Number, for chart maths and comparisons only. Never use the
 * result to render an amount; use `fmtTokenAmount`.
 */
export function baseUnitsToNumber(raw, decimals = 0) {
  const text = baseUnitsToString(raw, decimals);
  if (text === null) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * Render a token amount for a table cell: thousands separators on the whole
 * part, at most `maxDecimals` significant decimals, trailing zeros trimmed, and
 * a `0.00000001`-style floor so a dust amount never renders as a bare `0`.
 */
export function fmtTokenAmount(raw, decimals = 0, { maxDecimals = 6 } = {}) {
  const exact = baseUnitsToString(raw, decimals);
  if (exact === null) return DASH;
  const negative = exact.startsWith('-');
  const body = negative ? exact.slice(1) : exact;
  const [wholeRaw, fracRaw = ''] = body.split('.');
  const whole = BigInt(wholeRaw).toLocaleString('en-US');

  let frac = fracRaw.slice(0, Math.max(0, maxDecimals)).replace(/0+$/, '');
  if (!frac && fracRaw && /[1-9]/.test(fracRaw) && wholeRaw === '0') {
    // Smaller than the display precision but genuinely non-zero: say so rather
    // than printing 0 for a real balance.
    return `${negative ? '-' : ''}<${THIN}0.${'0'.repeat(Math.max(0, maxDecimals - 1))}1`;
  }
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** The full-precision amount, for the `title` attribute. */
export function fmtTokenAmountExact(raw, decimals = 0, symbol = '') {
  const exact = baseUnitsToString(raw, decimals);
  if (exact === null) return '';
  const s = toRawString(raw);
  return `${exact}${symbol ? ` ${symbol}` : ''} (${s} base units, ${decimals} decimals)`;
}

/* ---------------------------------------------------------------- address -- */

/** `769fv6KK…yf9up` -> `769f…f9up`. The full value belongs in `title`. */
export function truncAddr(address, head = 4, tail = 4) {
  if (typeof address !== 'string') return DASH;
  const a = address.trim();
  if (!a) return DASH;
  if (a.length <= head + tail + 1) return a;
  return `${a.slice(0, head)}…${a.slice(-tail)}`;
}

/** Solscan links. Never built by string concatenation at the call site. */
export function solscanTx(signature) {
  return `https://solscan.io/tx/${encodeURIComponent(signature)}`;
}
export function solscanAccount(address) {
  return `https://solscan.io/account/${encodeURIComponent(address)}`;
}
export function solscanToken(mint) {
  return `https://solscan.io/token/${encodeURIComponent(mint)}`;
}

/* ------------------------------------------------------------------ time -- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Parse anything the API might send into a Date, or null. */
export function toDate(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Seconds or milliseconds — candles come in seconds.
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  if (typeof value === 'string' && value.trim()) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? new Date(t) : null;
  }
  return null;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** `18:00` — UTC, always. */
export function fmtTimeUtc(value) {
  const d = toDate(value);
  if (!d) return DASH;
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** `2026-09-07 18:00` — UTC, always. */
export function fmtDateTimeUtc(value) {
  const d = toDate(value);
  if (!d) return DASH;
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(
    d.getUTCMinutes(),
  )}`;
}

/** `7 Sep 18:00 UTC` — for a single timestamp that stands alone. */
export function fmtStampUtc(value) {
  const d = toDate(value);
  if (!d) return DASH;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

/** The full ISO string, for `title` attributes. */
export function isoOf(value) {
  const d = toDate(value);
  return d ? d.toISOString() : '';
}

/**
 * `in 2h 14m` / `3h 02m ago` / `just now`. Coarse on purpose — the only ticking
 * number on the page is the countdown.
 */
export function fmtRelative(value, from = Date.now()) {
  const d = toDate(value);
  if (!d) return DASH;
  const deltaMs = d.getTime() - from;
  const ahead = deltaMs >= 0;
  const seconds = Math.floor(Math.abs(deltaMs) / 1000);
  if (seconds < 45) return 'just now';
  const body = coarseDuration(seconds);
  return ahead ? `in ${body}` : `${body} ago`;
}

/** `2h 14m`, `14m`, `9d 4h` — no seconds, no "0h". */
export function coarseDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(num(totalSeconds) ?? 0));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${pad2(minutes)}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${s}s`;
}

/** `02:14:07` for the one ticking element. Clamps at zero, never goes negative. */
export function fmtCountdown(totalSeconds) {
  const s = Math.max(0, Math.floor(num(totalSeconds) ?? 0));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

/** A screen-reader sentence, deliberately vague so it can be repeated rarely. */
export function countdownSentence(totalSeconds) {
  const s = Math.max(0, Math.floor(num(totalSeconds) ?? 0));
  if (s <= 0) return 'The next round is due now.';
  if (s < 60) return 'Next round in under a minute.';
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `Next round in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
  const hours = Math.floor(s / 3600);
  const rest = Math.round((s % 3600) / 60);
  if (rest === 0) return `Next round in about ${hours} hour${hours === 1 ? '' : 's'}.`;
  return `Next round in about ${hours} hour${hours === 1 ? '' : 's'} ${rest} minutes.`;
}

/**
 * A one-second ticker driven by a target time.
 *
 *   const c = createCountdown({ onTick: ({ text }) => { el.textContent = text; } });
 *   c.setTarget(iso); c.start();
 *
 * It reads the wall clock every tick rather than counting its own ticks, so a
 * backgrounded tab that misses a hundred intervals still shows the right time
 * when it comes back.
 */
export function createCountdown({ onTick, intervalMs = 1000 } = {}) {
  let target = null;
  let timer = null;
  let lastWhole = null;

  function remaining(now = Date.now()) {
    if (!target) return null;
    return Math.max(0, Math.round((target.getTime() - now) / 1000));
  }

  function tick() {
    const secs = remaining();
    if (secs === null) {
      if (typeof onTick === 'function') onTick({ seconds: null, text: '--:--:--', target: null, elapsed: false });
      return;
    }
    const changed = lastWhole !== secs;
    lastWhole = secs;
    if (typeof onTick === 'function') {
      onTick({ seconds: secs, text: fmtCountdown(secs), target, elapsed: secs <= 0, changed });
    }
  }

  return {
    setTarget(value) {
      const d = toDate(value);
      target = d;
      lastWhole = null;
      tick();
      return d;
    },
    getTarget() {
      return target;
    },
    remaining,
    start() {
      if (timer !== null) return;
      tick();
      timer = setInterval(tick, intervalMs);
    },
    stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
    tick,
  };
}

/* ----------------------------------------------------------------- misc -- */

/** Render `value` with `fn`, or an em dash when it is null/undefined. */
export function orDash(value, fn = String) {
  if (value === null || value === undefined || value === '') return DASH;
  const out = fn(value);
  return out === null || out === undefined || out === '' ? DASH : out;
}

/** `1 stock` / `3 stocks` — the plural rule used in half a dozen places. */
export function plural(count, one, many = `${one}s`) {
  const n = num(count) ?? 0;
  return `${fmtInt(n)} ${Math.abs(n) === 1 ? one : many}`;
}

/** Two-letter monogram behind a logo that fails to load. */
export function monogram(symbol) {
  if (typeof symbol !== 'string' || !symbol.trim()) return '?';
  return symbol.trim().slice(0, 2).toUpperCase();
}
