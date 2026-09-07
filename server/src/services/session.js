/**
 * STOCKDROP — wallet sign-in.
 *
 * The whole authentication story is one signed message. A user proves they hold
 * the private key of a wallet by signing a fixed text; they never sign a
 * transaction, nothing leaves their wallet, and the server never sees a key.
 *
 * Pieces:
 *   - a single-use nonce with a 10 minute TTL, stored via the Store
 *   - the exact message text from CONTRACT.md section 5
 *   - ed25519 verification with node:crypto only: the raw 32-byte Solana public
 *     key is wrapped in the 12-byte SPKI DER prefix for id-Ed25519 by hand
 *   - a stateless session token `base64url(payload).base64url(hmac)` (7 days)
 *
 * Nothing here logs a signature, a token, or the session secret.
 */

import crypto from 'node:crypto';

export const NONCE_TTL_MS = 10 * 60 * 1000;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const TOKEN_VERSION = 1;

/* --------------------------------------------------------------- base58 ---- */

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_INDEX = new Map([...B58_ALPHABET].map((ch, i) => [ch, i]));

/**
 * Bytes -> base58 (Bitcoin/Solana alphabet). Leading zero bytes become '1's.
 * @param {Uint8Array|Buffer|number[]} bytes
 * @returns {string}
 */
export function b58encode(bytes) {
  const buf = Uint8Array.from(bytes);
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros++;
  const digits = [];
  for (let i = zeros; i < buf.length; i++) {
    let carry = buf[i];
    for (let j = 0; j < digits.length; j++) {
      const x = (digits[j] << 8) + carry;
      digits[j] = x % 58;
      carry = (x / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
  return out;
}

/**
 * base58 -> bytes. Returns null for anything that is not valid base58
 * (callers treat null as "bad input", never as an empty value).
 * @param {string} str
 * @returns {Uint8Array|null}
 */
export function b58decode(str) {
  if (typeof str !== 'string' || str.length === 0) return null;
  const bytes = [];
  for (const ch of str) {
    const value = B58_INDEX.get(ch);
    if (value === undefined) return null;
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      const x = bytes[i] * 58 + carry;
      bytes[i] = x & 0xff;
      carry = x >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  for (const ch of str) {
    if (ch === '1') zeros++;
    else break;
  }
  const out = new Uint8Array(zeros + bytes.length);
  out.set(bytes.reverse(), zeros);
  return out;
}

/** The 32 raw bytes of a Solana address, or null if it is not one. */
export function walletBytes(wallet) {
  if (typeof wallet !== 'string' || wallet.length < 32 || wallet.length > 44) return null;
  const bytes = b58decode(wallet);
  return bytes && bytes.length === 32 ? bytes : null;
}

/** True when `wallet` is a syntactically valid Solana address. */
export function isWallet(wallet) {
  return walletBytes(wallet) !== null;
}

/* ---------------------------------------------------------------- ed25519 -- */

// SPKI DER for an Ed25519 public key:
//   SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING (0 unused bits) { 32 bytes } }
// which is a fixed 12-byte prefix followed by the raw key.
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Wrap 32 raw ed25519 public key bytes into a node:crypto KeyObject.
 * @param {Uint8Array} pubkey32
 * @returns {crypto.KeyObject}
 */
export function spkiKey(pubkey32) {
  const raw = Buffer.from(pubkey32);
  if (raw.length !== 32) throw new TypeError('ed25519 public key must be 32 bytes');
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * Decode a 64-byte signature given as base58 or base64 / base64url.
 * base58 is tried first (that is what every Solana wallet returns from
 * `signMessage` after the usual bs58 encode); base64 is accepted because some
 * wallet wrappers hand back `Buffer.toString('base64')`.
 * @param {string} signature
 * @returns {Buffer|null}
 */
export function decodeSignature(signature) {
  if (typeof signature !== 'string') return null;
  const s = signature.trim();
  if (s === '' || s.length > 200) return null;

  const b58 = b58decode(s);
  if (b58 && b58.length === 64) return Buffer.from(b58);

  if (/^[A-Za-z0-9+/_=-]+$/.test(s)) {
    try {
      const buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      if (buf.length === 64) return buf;
    } catch {
      /* fall through */
    }
  }
  return null;
}

/**
 * Verify an ed25519 signature over the UTF-8 bytes of `message`.
 * Never throws: any malformed input is simply "not verified".
 * @param {{wallet: string, message: string, signature: string}} args
 * @returns {boolean}
 */
export function verifySignature({ wallet, message, signature }) {
  try {
    const pubkey = walletBytes(wallet);
    if (!pubkey) return false;
    const sig = decodeSignature(signature);
    if (!sig) return false;
    if (typeof message !== 'string' || message.length === 0) return false;
    return crypto.verify(null, Buffer.from(message, 'utf8'), spkiKey(pubkey), sig);
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- message -- */

/**
 * The sign-in message, exactly as specified in CONTRACT.md section 5.
 * Six lines joined by "\n". Any change here invalidates every wallet's flow,
 * so it is asserted character for character in test/session.test.js.
 * @param {{wallet: string, nonce: string, issuedAt: string}} args
 */
export function buildSignInMessage({ wallet, nonce, issuedAt }) {
  return [
    'STOCKDROP',
    'Sign to verify you own this wallet.',
    'This is not a transaction. Nothing leaves your wallet.',
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    `Issued: ${issuedAt}`,
  ].join('\n');
}

/**
 * Nonces carry their own issue time so the server can rebuild the exact message
 * from `{wallet, nonce}` alone at verify time, without a second round trip and
 * without trusting anything the client sends.
 * Format: `<issuedAtMs base36>.<16 random hex>`
 */
export function mintNonce(now = Date.now()) {
  return `${Math.floor(now).toString(36)}.${crypto.randomBytes(8).toString('hex')}`;
}

/** Issue time encoded in a nonce, or null when the nonce is malformed. */
export function nonceIssuedAt(nonce) {
  if (typeof nonce !== 'string') return null;
  const m = /^([0-9a-z]{1,12})\.([0-9a-f]{16})$/.exec(nonce);
  if (!m) return null;
  const ms = Number.parseInt(m[1], 36);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms;
}

/* ------------------------------------------------------------------ tokens -- */

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest();
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ----------------------------------------------------------------- service -- */

/**
 * createSessionService({ cfg, db })
 *
 * @param {object} args
 * @param {object} args.cfg   CFG (uses cfg.sessionSecret only)
 * @param {object} args.db    Store (putNonce / takeNonce)
 * @param {() => number} [args.now]
 */
export function createSessionService({ cfg, db, now = Date.now } = {}) {
  if (!cfg) throw new TypeError('createSessionService: cfg is required');
  if (!db) throw new TypeError('createSessionService: db is required');

  // Read once: the secret is a non-enumerable property on CFG and must never be
  // copied into anything that gets serialised.
  const secret = String(cfg.sessionSecret || '');
  if (secret === '') throw new TypeError('createSessionService: cfg.sessionSecret is empty');

  /**
   * Issue a nonce + the exact message to sign, and remember the nonce.
   * @param {string} wallet
   * @returns {Promise<{nonce: string, message: string, issuedAt: string, expiresAt: string}>}
   */
  async function issueNonce(wallet) {
    const at = now();
    const nonce = mintNonce(at);
    const issuedAt = new Date(at).toISOString();
    const expiresAt = new Date(at + NONCE_TTL_MS).toISOString();
    await db.putNonce(wallet, nonce, expiresAt);
    return { nonce, message: buildSignInMessage({ wallet, nonce, issuedAt }), issuedAt, expiresAt };
  }

  /**
   * Consume a nonce and check the signature over the message it implies.
   *
   * The nonce is burned before the signature is checked: a nonce that has been
   * offered once is never usable again, whatever the outcome.
   *
   * @param {{wallet: string, nonce: string, signature: string, message?: string}} args
   * @returns {Promise<{ok: true, message: string} | {ok: false, error: string, detail: string}>}
   */
  async function verify({ wallet, nonce, signature, message }) {
    if (!isWallet(wallet)) return { ok: false, error: 'bad_wallet', detail: 'wallet is not a Solana address' };

    const issuedMs = nonceIssuedAt(nonce);
    if (issuedMs === null) return { ok: false, error: 'bad_nonce', detail: 'nonce is malformed' };

    const age = now() - issuedMs;
    if (age < -60_000 || age > NONCE_TTL_MS) {
      return { ok: false, error: 'nonce_expired', detail: 'ask for a new nonce and sign again' };
    }

    const expected = buildSignInMessage({ wallet, nonce, issuedAt: new Date(issuedMs).toISOString() });
    if (message !== undefined && message !== null && String(message) !== expected) {
      return { ok: false, error: 'message_mismatch', detail: 'the signed message is not the one this nonce was issued for' };
    }

    const consumed = await db.takeNonce(wallet, nonce);
    if (!consumed) return { ok: false, error: 'bad_nonce', detail: 'unknown, expired or already-used nonce' };

    if (!verifySignature({ wallet, message: expected, signature })) {
      return { ok: false, error: 'bad_signature', detail: 'signature does not match this wallet' };
    }
    return { ok: true, message: expected };
  }

  /**
   * Mint a session token. `base64url(payload).base64url(hmacSha256(secret, payload))`
   * @param {string} wallet
   * @returns {{token: string, expiresAt: string, issuedAt: string}}
   */
  function issueToken(wallet) {
    const at = now();
    const payload = {
      v: TOKEN_VERSION,
      w: wallet,
      iat: Math.floor(at / 1000),
      exp: Math.floor((at + SESSION_TTL_MS) / 1000),
    };
    const body = b64url(JSON.stringify(payload));
    const token = `${body}.${b64url(hmac(secret, body))}`;
    return {
      token,
      issuedAt: new Date(payload.iat * 1000).toISOString(),
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    };
  }

  /**
   * Validate a session token.
   * @param {string} token
   * @returns {{wallet: string, issuedAt: string, expiresAt: string} | null}
   */
  function readToken(token) {
    if (typeof token !== 'string' || token.length < 8 || token.length > 4096) return null;
    const dot = token.indexOf('.');
    if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(sig)) return null;

    let given;
    try {
      given = Buffer.from(sig, 'base64url');
    } catch {
      return null;
    }
    if (!safeEqual(given, hmac(secret, body))) return null;

    let payload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!payload || typeof payload !== 'object') return null;
    if (payload.v !== TOKEN_VERSION) return null;
    if (!isWallet(payload.w)) return null;
    if (!Number.isFinite(payload.exp) || !Number.isFinite(payload.iat)) return null;
    if (payload.exp * 1000 <= now()) return null;

    return {
      wallet: payload.w,
      issuedAt: new Date(payload.iat * 1000).toISOString(),
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    };
  }

  /** `Authorization: Bearer <token>` -> session, or null. */
  function sessionFromRequest(req) {
    const header = req?.headers?.authorization;
    if (typeof header !== 'string') return null;
    const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!m) return null;
    return readToken(m[1]);
  }

  /** Express middleware: 401 unless a valid Bearer token is present. Sets req.wallet. */
  function requireAuth(req, res, next) {
    const session = sessionFromRequest(req);
    if (!session) {
      res.status(401).json({ error: 'unauthorized', detail: 'connect your wallet and sign in again' });
      return;
    }
    req.wallet = session.wallet;
    req.session = session;
    next();
  }

  /** Express middleware: attaches req.wallet when a token is present, never rejects. */
  function optionalAuth(req, _res, next) {
    const session = sessionFromRequest(req);
    if (session) {
      req.wallet = session.wallet;
      req.session = session;
    }
    next();
  }

  return {
    issueNonce,
    verify,
    issueToken,
    readToken,
    sessionFromRequest,
    requireAuth,
    optionalAuth,
    buildSignInMessage,
    nonceTtlMs: NONCE_TTL_MS,
    sessionTtlMs: SESSION_TTL_MS,
  };
}

export default createSessionService;
