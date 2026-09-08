/**
 * STOXVAULT — the API client.
 *
 * One typed wrapper per endpoint in CONTRACT.md section 5. Everything the rest
 * of the app knows about the server passes through here, which is what makes it
 * possible to say honestly, in one place, what happened when a call failed:
 *
 *   - a timeout, a DNS failure or a CORS rejection becomes ApiError('network')
 *   - a JSON error body `{ error, detail }` becomes ApiError(error, detail, status)
 *   - an HTML error page from a proxy becomes ApiError('bad_response')
 *
 * No call ever resolves with invented data. A section that cannot load shows its
 * error pane; it does not fall back to a plausible-looking number.
 */

const DEFAULT_TIMEOUT_MS = 12000;
const SESSION_KEY = 'stockdrop:session';

/* ------------------------------------------------------------------ error -- */

export class ApiError extends Error {
  /**
   * @param {string} code    machine-readable: the server's `error` field, or
   *                         'network' | 'timeout' | 'bad_response' | 'aborted'
   * @param {string|null} detail one human sentence, safe to show in the UI
   * @param {number|null} status HTTP status, or null when the request never landed
   */
  constructor(code, detail = null, status = null, cause = undefined) {
    super(detail || code);
    this.name = 'ApiError';
    this.code = code;
    this.detail = detail || null;
    this.status = status;
    if (cause !== undefined) this.cause = cause;
  }

  /** True when retrying later could plausibly succeed. */
  get retryable() {
    if (this.status === null) return true; // never reached the server
    return this.status >= 500 || this.status === 429;
  }

  /** True when the session is gone and the user has to sign in again. */
  get isAuth() {
    return this.status === 401 || this.code === 'unauthorized' || this.code === 'bad_token';
  }

  /** The sentence a toast or an error pane should show. */
  get message1() {
    if (this.detail) return this.detail;
    switch (this.code) {
      case 'network':
        return 'The API could not be reached.';
      case 'timeout':
        return 'The API did not answer in time.';
      case 'bad_response':
        return 'The API returned something that is not JSON.';
      case 'not_found':
        return 'That endpoint does not exist on this server.';
      case 'internal_error':
        return 'The server hit an internal error.';
      default:
        return `The API returned ${this.code}${this.status ? ` (${this.status})` : ''}.`;
    }
  }
}

/* ---------------------------------------------------------------- storage -- */

/** localStorage throws in private windows and when site data is blocked. */
function safeGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (err) {
    return null;
  }
}
function safeSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (err) {
    return false;
  }
}
function safeRemove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch (err) {
    /* nothing to do — the session simply will not survive the reload */
  }
}

/**
 * The bearer-token store. A session is `{ token, wallet, expiresAt, walletId }`.
 * An expired session is dropped on read, so a stale token is never sent.
 */
export const session = {
  get() {
    const raw = safeGet(SESSION_KEY);
    if (!raw) return null;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      safeRemove(SESSION_KEY);
      return null;
    }
    if (!parsed || typeof parsed.token !== 'string' || typeof parsed.wallet !== 'string') {
      safeRemove(SESSION_KEY);
      return null;
    }
    if (parsed.expiresAt) {
      const t = Date.parse(parsed.expiresAt);
      if (Number.isFinite(t) && t <= Date.now()) {
        safeRemove(SESSION_KEY);
        return null;
      }
    }
    return parsed;
  },

  set({ token, wallet, expiresAt = null, walletId = null }) {
    if (typeof token !== 'string' || typeof wallet !== 'string') return null;
    const value = { token, wallet, expiresAt, walletId };
    safeSet(SESSION_KEY, JSON.stringify(value));
    return value;
  },

  clear() {
    safeRemove(SESSION_KEY);
  },

  get token() {
    return this.get()?.token ?? null;
  },

  get wallet() {
    return this.get()?.wallet ?? null;
  },
};

/* --------------------------------------------------------------- plumbing -- */

/** The base the page was configured with, without a trailing slash. */
export function apiBase() {
  const base = window.STOCKDROP?.apiBase;
  return typeof base === 'string' && base ? base.replace(/\/+$/, '') : '';
}

/** `/api/universe` + `{limit: 25}` -> `https://host/api/universe?limit=25` */
function buildUrl(path, query) {
  const url = `${apiBase()}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/** Read a response body as JSON, tolerating an empty body and an HTML page. */
async function readBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    return { __nonJson: text.slice(0, 200) };
  }
}

function toApiError(body, status) {
  if (body && typeof body === 'object' && !body.__nonJson && typeof body.error === 'string') {
    // `{ error, detail }` and the picks variant `{ error, code, detail }`.
    const err = new ApiError(body.error, typeof body.detail === 'string' ? body.detail : null, status);
    if (typeof body.code === 'string') err.pickCode = body.code;
    return err;
  }
  if (body && body.__nonJson) {
    return new ApiError('bad_response', 'The API returned a non-JSON response.', status);
  }
  return new ApiError(`http_${status}`, null, status);
}

const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);

/**
 * One request, with a timeout and at most one retry on a genuine network
 * failure (never on an HTTP error — a 400 is an answer, not a hiccup).
 *
 * @param {string} path      `/api/...`
 * @param {object} [options]
 * @param {string} [options.method='GET']
 * @param {object} [options.query]
 * @param {object} [options.body]      serialised as JSON
 * @param {boolean} [options.auth]     attach the stored bearer token
 * @param {number} [options.timeout]
 * @param {boolean} [options.retry]    defaults to true for idempotent methods
 * @param {AbortSignal} [options.signal] caller-owned cancellation
 * @returns {Promise<any>} the parsed JSON body
 */
export async function request(path, options = {}) {
  const {
    method = 'GET',
    query = null,
    body = undefined,
    auth = false,
    timeout = DEFAULT_TIMEOUT_MS,
    signal = null,
  } = options;

  const retry = options.retry === undefined ? IDEMPOTENT.has(method.toUpperCase()) : Boolean(options.retry);
  const url = buildUrl(path, query);

  if (!apiBase()) {
    throw new ApiError('no_api_base', 'No API host is configured for this page.', null);
  }

  const attempt = async () => {
    // Build the headers first: a missing token must fail before any timer or
    // abort listener exists, so nothing is left dangling.
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) {
      const token = session.token;
      if (!token) throw new ApiError('unauthorized', 'Connect a wallet first.', 401);
      headers.Authorization = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeout);

    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        credentials: 'omit',
        mode: 'cors',
        cache: 'no-store',
      });
    } catch (err) {
      if (signal?.aborted) throw new ApiError('aborted', 'The request was cancelled.', null, err);
      if (controller.signal.aborted) throw new ApiError('timeout', 'The API did not answer in time.', null, err);
      throw new ApiError('network', 'The API could not be reached.', null, err);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    const parsed = await readBody(response);
    if (!response.ok) throw toApiError(parsed, response.status);
    if (parsed && parsed.__nonJson !== undefined) {
      throw new ApiError('bad_response', 'The API returned a non-JSON response.', response.status);
    }
    return parsed;
  };

  try {
    return await attempt();
  } catch (err) {
    const isNetwork = err instanceof ApiError && (err.code === 'network' || err.code === 'timeout');
    if (retry && isNetwork && !signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return attempt();
    }
    throw err;
  }
}

/* -------------------------------------------------------------- endpoints -- */

/** GET /api/health */
export const getHealth = (opts) => request('/api/health', opts);

/** GET /api/config */
export const getConfig = (opts) => request('/api/config', opts);

/** GET /api/universe */
export const getUniverse = (opts) => request('/api/universe', opts);

/**
 * GET /api/universe/:symbol/history?range=1mo|3mo|1y
 * Answers `{ symbol, yahooSymbol, range, candles: [{t,o,h,l,c,v}], source, kind }`.
 */
export const getHistory = (symbol, range = '1mo', opts) =>
  request(`/api/universe/${encodeURIComponent(symbol)}/history`, { ...opts, query: { range } });

/** GET /api/stats */
export const getStats = (opts) => request('/api/stats', opts);

// `/api/vault` still exists on the server and is unchanged. The site no longer
// calls it: the vault balance was taken off the page, and a helper here would
// be an invitation to put it back.

/** GET /api/prefs/:wallet — public, no token needed. */
export const getPrefs = (wallet, opts) => request(`/api/prefs/${encodeURIComponent(wallet)}`, opts);

/** GET /api/holders?limit&offset */
export const getHolders = ({ limit = 100, offset = 0 } = {}, opts) =>
  request('/api/holders', { ...opts, query: { limit, offset } });

/** GET /api/rounds?limit&offset */
export const getRounds = ({ limit = 25, offset = 0 } = {}, opts) =>
  request('/api/rounds', { ...opts, query: { limit, offset } });

/** GET /api/rounds/preview — what the next round would do right now. */
export const getRoundsPreview = (opts) => request('/api/rounds/preview', opts);

/** GET /api/rounds/:id — the full round document, transfers included. */
export const getRound = (id, opts) => request(`/api/rounds/${encodeURIComponent(id)}`, opts);

/* ------------------------------------------------------------------ auth -- */

/**
 * POST /api/auth/nonce -> `{ nonce, message, expiresAt }`.
 * The message is the exact text the wallet must sign; never rebuild it here.
 */
export const authNonce = (wallet, opts) =>
  request('/api/auth/nonce', { ...opts, method: 'POST', body: { wallet }, retry: true });

/**
 * POST /api/auth/verify -> `{ token, wallet, expiresAt, me }`.
 * Never retried: the nonce is single-use, so a retry would fail as replay.
 */
export const authVerify = ({ wallet, nonce, signature }, opts) =>
  request('/api/auth/verify', { ...opts, method: 'POST', body: { wallet, nonce, signature }, retry: false });

/* -------------------------------------------------------------------- me -- */

/** GET /api/me (bearer) */
export const getMe = (opts) => request('/api/me', { ...opts, auth: true });

/**
 * PUT /api/me/prefs (bearer).
 * A rejected basket throws ApiError('invalid_picks') carrying `pickCode`, one of
 * count | range | sum | not_in_universe | duplicate.
 */
export const putPrefs = ({ picks, signature = null, message = null }, opts) =>
  request('/api/me/prefs', { ...opts, method: 'PUT', auth: true, body: { picks, signature, message } });

/** DELETE /api/me/prefs (bearer) — back to the default basket. */
export const deletePrefs = (opts) => request('/api/me/prefs', { ...opts, method: 'DELETE', auth: true });

/* ----------------------------------------------------------------- utils -- */

/**
 * The sentence to show for a rejected basket, keyed by the server's `code` so
 * client-side validation and server-side validation never disagree.
 */
export const PICK_ERROR_TEXT = {
  count: 'Pick between 2 and 5 stocks.',
  range: 'Each stock takes a whole number from 10% to 60%.',
  sum: 'The allocations have to add up to exactly 100%.',
  not_in_universe: 'One of those stocks is not in the current top 20 any more.',
  duplicate: 'Each stock can only appear once.',
};

/** Map any thrown value to a sentence, without leaking a stack trace. */
export function errorText(err, fallback = 'Something went wrong.') {
  if (err instanceof ApiError) {
    if (err.code === 'invalid_picks') return PICK_ERROR_TEXT[err.pickCode] || err.message1;
    return err.message1;
  }
  if (err && typeof err.message === 'string' && err.message) return err.message;
  return fallback;
}

export default {
  ApiError,
  apiBase,
  session,
  request,
  getHealth,
  getConfig,
  getUniverse,
  getHistory,
  getStats,
  getPrefs,
  getHolders,
  getRounds,
  getRound,
  getRoundsPreview,
  authNonce,
  authVerify,
  getMe,
  putPrefs,
  deletePrefs,
  errorText,
  PICK_ERROR_TEXT,
};
