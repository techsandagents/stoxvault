/**
 * STOXVAULT — wallet sign-in (EVM / Robinhood Wallet).
 *
 * The whole authentication story is still one signed message. A user proves they
 * hold the private key of a wallet by signing a fixed text; they never sign a
 * transaction, nothing leaves their wallet, and the server never sees a key.
 *
 * WHAT CHANGED, AND WHY. Robinhood Wallet connects to dapps on Ethereum,
 * Polygon, Arbitrum, Optimism, Base and Robinhood Chain — Solana is not on that
 * list, and there is no browser extension, only the in-app browser and
 * WalletConnect. So it can never produce the ed25519 Solana signature this file
 * used to verify. Sign-in is therefore EVM:
 *
 *   - a wallet is a 0x-prefixed 20-byte address, canonicalised to its EIP-55
 *     checksum form, so "0xabc…" and "0xABC…" are one account and never two
 *   - the message is EIP-4361 (Sign-In With Ethereum): domain binding, URI,
 *     chain id, nonce, issue time — a signature for another site cannot be
 *     replayed here, and one for another chain cannot either
 *   - verification is EIP-191 personal_sign: keccak256 of
 *     "\x19Ethereum Signed Message:\n" + byteLength(message) + message, then
 *     secp256k1 public-key recovery from r||s||v, then the last 20 bytes of the
 *     keccak of the uncompressed public key
 *   - EIP-2 low-s is enforced, so the same signature cannot be replayed in its
 *     malleable twin
 *
 * The curve and the hash come from @noble/curves / @noble/hashes — audited
 * implementations. No elliptic-curve arithmetic is hand-rolled on an auth path.
 *
 * Everything else is unchanged: single-use nonce with a 10 minute TTL, an HMAC
 * session token with the same 7-day expiry, the same requireAuth contract.
 *
 * Nothing here logs a signature, a token, or the session secret.
 */

import crypto from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

export const NONCE_TTL_MS = 10 * 60 * 1000;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const TOKEN_VERSION = 2;

/**
 * Robinhood Chain mainnet, verified live 2026-09-23:
 * chain id 4663 (0x1237), RPC https://rpc.mainnet.chain.robinhood.com.
 * These are only defaults — config.js supplies the running values.
 */
export const DEFAULT_CHAIN_ID = 4663;
export const DEFAULT_DOMAIN = 'stoxvault.vercel.app';
export const DEFAULT_URI = 'https://stoxvault.vercel.app';

/** secp256k1 group order, and the halfway point EIP-2 refuses to go past. */
const CURVE_N = secp256k1.CURVE.n;
const HALF_N = CURVE_N >> 1n;

/* --------------------------------------------------------------- base58 ---- */
/*
 * Kept because the Solana side of the product still needs it: services/holders.js
 * decodes token-account owners with these. They have nothing to do with sign-in
 * any more.
 */

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

/** True when `value` is a syntactically valid base58 Solana address. */
export function isSolanaAddress(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return false;
  const bytes = b58decode(value);
  return Boolean(bytes && bytes.length === 32);
}

/* ------------------------------------------------------------- addresses --- */

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const hex = (bytes) => Buffer.from(bytes).toString('hex');

/** keccak256 of some bytes, as a Uint8Array. */
export function keccak256(bytes) {
  return keccak_256(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
}

/** Raw shape check only: 0x + 40 hex digits, any case. */
export function isHexAddress(value) {
  return typeof value === 'string' && HEX_ADDRESS.test(value.trim());
}

/**
 * EIP-55 mixed-case checksum. The canonical form this server stores, compares
 * and displays: one address has exactly one spelling here, so two users can
 * never end up holding "different" accounts that are the same address.
 * @param {string} value
 * @returns {string|null}
 */
export function toChecksumAddress(value) {
  if (!isHexAddress(value)) return null;
  const lower = value.trim().slice(2).toLowerCase();
  const digest = hex(keccak256(Buffer.from(lower, 'ascii')));
  let out = '0x';
  for (let i = 0; i < lower.length; i++) {
    out += Number.parseInt(digest[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

/**
 * Anything a client sent -> the one canonical spelling, or null.
 * Mixed case in, checksum case out; nothing else is accepted.
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeWallet(value) {
  return typeof value === 'string' ? toChecksumAddress(value) : null;
}

/** The 20 raw bytes of an EVM address, or null if it is not one. */
export function walletBytes(wallet) {
  const normal = normalizeWallet(wallet);
  return normal ? Uint8Array.from(Buffer.from(normal.slice(2), 'hex')) : null;
}

/** True when `wallet` is a syntactically valid EVM address. */
export function isWallet(wallet) {
  return normalizeWallet(wallet) !== null;
}

/**
 * True when the address is already written in its canonical checksum form.
 * A wallet that sends `0xAbC…` in the wrong case is still accepted — it is
 * normalised — but a stored row that is not canonical is a bug worth seeing.
 */
export function isChecksumAddress(value) {
  return isHexAddress(value) && toChecksumAddress(value) === value.trim();
}

/* -------------------------------------------------------------- EIP-191 ---- */

const PERSONAL_PREFIX = '\u0019Ethereum Signed Message:\n';

/**
 * The 32-byte digest a wallet actually signs for `personal_sign`:
 *   keccak256("\x19Ethereum Signed Message:\n" + byteLength(message) + message)
 * The length is the UTF-8 BYTE length, not the character count — a message with
 * one non-ASCII character would otherwise hash differently on each side.
 * @param {string|Uint8Array} message
 * @returns {Uint8Array}
 */
export function hashPersonalMessage(message) {
  const body = typeof message === 'string' ? Buffer.from(message, 'utf8') : Buffer.from(message);
  const prefix = Buffer.from(`${PERSONAL_PREFIX}${body.length}`, 'utf8');
  return keccak256(Buffer.concat([prefix, body]));
}

/**
 * Decode a 65-byte `r || s || v` signature.
 *
 * Accepts 0x-prefixed hex, bare hex, and base64 / base64url (some wallet
 * wrappers hand back `Buffer.toString('base64')`). Returns null — never throws —
 * for anything that is not a well-formed, non-malleable signature:
 *
 *   - r and s must be in [1, n)
 *   - s must be in the LOWER half of the order (EIP-2). The upper-half twin
 *     (n - s, with v flipped) verifies to the same key on a naive
 *     implementation, which would let one signature be replayed in two forms.
 *   - v is 27/28 or 0/1. Nothing else: an EIP-155 transaction v is not a
 *     personal_sign v and is refused rather than quietly reduced.
 *
 * @param {string} signature
 * @returns {{r: bigint, s: bigint, recovery: 0|1, bytes: Buffer}|null}
 */
export function decodeSignature(signature) {
  if (typeof signature !== 'string') return null;
  const s = signature.trim();
  if (s === '' || s.length > 200) return null;

  let raw = null;
  const body = s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;
  if (/^[0-9a-fA-F]{130}$/.test(body)) {
    raw = Buffer.from(body, 'hex');
  } else if (!s.startsWith('0x') && !s.startsWith('0X') && /^[A-Za-z0-9+/_=-]+$/.test(s)) {
    try {
      const buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      if (buf.length === 65) raw = buf;
    } catch {
      return null;
    }
  }
  if (!raw || raw.length !== 65) return null;

  const r = BigInt(`0x${raw.subarray(0, 32).toString('hex')}`);
  const sv = BigInt(`0x${raw.subarray(32, 64).toString('hex')}`);
  const v = raw[64];

  if (r <= 0n || r >= CURVE_N) return null;
  if (sv <= 0n || sv >= CURVE_N) return null;
  if (sv > HALF_N) return null; // EIP-2: upper-half s is malleable, refuse it

  let recovery;
  if (v === 27 || v === 0) recovery = 0;
  else if (v === 28 || v === 1) recovery = 1;
  else return null;

  return { r, s: sv, recovery, bytes: raw };
}

/**
 * Recover the signer of an EIP-191 personal_sign signature.
 * @param {{message: string, signature: string}} args
 * @returns {string|null} the checksummed address, or null
 */
export function recoverAddress({ message, signature }) {
  try {
    if (typeof message !== 'string' || message.length === 0) return null;
    const decoded = decodeSignature(signature);
    if (!decoded) return null;

    const digest = hashPersonalMessage(message);
    const sig = new secp256k1.Signature(decoded.r, decoded.s, decoded.recovery);
    const point = sig.recoverPublicKey(digest);
    if (!point) return null;

    // Uncompressed key is 0x04 || X || Y; the address is the last 20 bytes of
    // the keccak of X || Y.
    const uncompressed = point.toBytes(false);
    const digest2 = keccak256(uncompressed.subarray(1));
    return toChecksumAddress(`0x${hex(digest2.subarray(12))}`);
  } catch {
    return null;
  }
}

/**
 * Verify an EIP-191 signature over `message` against a claimed wallet.
 * Never throws: any malformed input is simply "not verified".
 * @param {{wallet: string, message: string, signature: string}} args
 * @returns {boolean}
 */
export function verifySignature({ wallet, message, signature }) {
  const claimed = normalizeWallet(wallet);
  if (!claimed) return false;
  const recovered = recoverAddress({ message, signature });
  if (!recovered) return false;
  // Both sides are canonical, so this is a plain string compare on 42 chars.
  return crypto.timingSafeEqual(Buffer.from(recovered, 'ascii'), Buffer.from(claimed, 'ascii'));
}

/* ---------------------------------------------------------------- message -- */

/**
 * The one sentence that has to survive every redesign: this is not a
 * transaction, and nothing leaves the wallet. EIP-4361 puts the statement on a
 * single line, so the three sentences run together rather than wrapping.
 */
export const SIGN_IN_STATEMENT =
  'Sign to verify you own this wallet. This is not a transaction. Nothing leaves your wallet.';

/**
 * The sign-in message: EIP-4361 (Sign-In With Ethereum), field order as the
 * standard specifies it.
 *
 * The domain and URI bind the signature to this site, and `Chain ID` binds it to
 * Robinhood Chain: a signature collected by another site, or issued for another
 * chain, does not rebuild to this text and is refused. Any change here
 * invalidates every wallet's flow, so it is asserted line for line in
 * test/session.test.js.
 *
 * @param {{wallet: string, nonce: string, issuedAt: string, domain?: string, uri?: string, chainId?: number}} args
 */
export function buildSignInMessage({
  wallet,
  nonce,
  issuedAt,
  domain = DEFAULT_DOMAIN,
  uri = DEFAULT_URI,
  chainId = DEFAULT_CHAIN_ID,
}) {
  // The address line must be the EIP-55 form; a wallet that shows the message
  // will render it exactly as written.
  const address = normalizeWallet(wallet) || String(wallet);
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    SIGN_IN_STATEMENT,
    '',
    `URI: ${uri}`,
    'Version: 1',
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

/**
 * Nonces carry their own issue time so the server can rebuild the exact message
 * from `{wallet, nonce}` alone at verify time, without a second round trip and
 * without trusting anything the client sends.
 *
 * EIP-4361 requires the nonce to be alphanumeric and at least 8 characters, so
 * the format is 8 base36 digits of the issue time followed by 16 hex digits of
 * randomness — 24 characters, no separator.
 */
const NONCE_TIME_LEN = 8;
const NONCE_RE = /^[0-9a-z]{8}[0-9a-f]{16}$/;

export function mintNonce(now = Date.now()) {
  const stamp = Math.floor(now).toString(36);
  if (stamp.length > NONCE_TIME_LEN) throw new RangeError('nonce timestamp overflowed its field');
  return stamp.padStart(NONCE_TIME_LEN, '0') + crypto.randomBytes(8).toString('hex');
}

/** Issue time encoded in a nonce, or null when the nonce is malformed. */
export function nonceIssuedAt(nonce) {
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return null;
  const ms = Number.parseInt(nonce.slice(0, NONCE_TIME_LEN), 36);
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
 * @param {object} args.cfg   CFG (sessionSecret, authDomain, authUri, authChainId)
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

  const domain = String(cfg.authDomain || DEFAULT_DOMAIN);
  const uri = String(cfg.authUri || DEFAULT_URI);
  const chainId = Number.isInteger(cfg.authChainId) ? cfg.authChainId : DEFAULT_CHAIN_ID;

  const messageFor = (wallet, nonce, issuedAt) =>
    buildSignInMessage({ wallet, nonce, issuedAt, domain, uri, chainId });

  /**
   * Issue a nonce + the exact message to sign, and remember the nonce.
   * @param {string} wallet
   * @returns {Promise<{wallet: string, nonce: string, message: string, issuedAt: string, expiresAt: string, chainId: number, domain: string, uri: string}>}
   */
  async function issueNonce(wallet) {
    const address = normalizeWallet(wallet);
    if (!address) throw new TypeError('issueNonce: wallet is not an EVM address');
    const at = now();
    const nonce = mintNonce(at);
    const issuedAt = new Date(at).toISOString();
    const expiresAt = new Date(at + NONCE_TTL_MS).toISOString();
    await db.putNonce(address, nonce, expiresAt);
    return {
      wallet: address,
      nonce,
      message: messageFor(address, nonce, issuedAt),
      issuedAt,
      expiresAt,
      chainId,
      domain,
      uri,
    };
  }

  /**
   * Consume a nonce and check the signature over the message it implies.
   *
   * The nonce is burned before the signature is checked: a nonce that has been
   * offered once is never usable again, whatever the outcome.
   *
   * @param {{wallet: string, nonce: string, signature: string, message?: string}} args
   * @returns {Promise<{ok: true, wallet: string, message: string} | {ok: false, error: string, detail: string}>}
   */
  async function verify({ wallet, nonce, signature, message }) {
    const address = normalizeWallet(wallet);
    if (!address) return { ok: false, error: 'bad_wallet', detail: 'wallet is not a 0x EVM address' };

    const issuedMs = nonceIssuedAt(nonce);
    if (issuedMs === null) return { ok: false, error: 'bad_nonce', detail: 'nonce is malformed' };

    const age = now() - issuedMs;
    if (age < -60_000 || age > NONCE_TTL_MS) {
      return { ok: false, error: 'nonce_expired', detail: 'ask for a new nonce and sign again' };
    }

    const expected = messageFor(address, nonce, new Date(issuedMs).toISOString());
    if (message !== undefined && message !== null && String(message) !== expected) {
      return { ok: false, error: 'message_mismatch', detail: 'the signed message is not the one this nonce was issued for' };
    }

    const consumed = await db.takeNonce(address, nonce);
    if (!consumed) return { ok: false, error: 'bad_nonce', detail: 'unknown, expired or already-used nonce' };

    if (!verifySignature({ wallet: address, message: expected, signature })) {
      return { ok: false, error: 'bad_signature', detail: 'signature does not match this wallet' };
    }
    return { ok: true, wallet: address, message: expected };
  }

  /**
   * Mint a session token. `base64url(payload).base64url(hmacSha256(secret, payload))`
   * @param {string} wallet
   * @returns {{token: string, wallet: string, expiresAt: string, issuedAt: string}}
   */
  function issueToken(wallet) {
    const address = normalizeWallet(wallet);
    if (!address) throw new TypeError('issueToken: wallet is not an EVM address');
    const at = now();
    const payload = {
      v: TOKEN_VERSION,
      w: address,
      iat: Math.floor(at / 1000),
      exp: Math.floor((at + SESSION_TTL_MS) / 1000),
    };
    const body = b64url(JSON.stringify(payload));
    const token = `${body}.${b64url(hmac(secret, body))}`;
    return {
      token,
      wallet: address,
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
    const address = normalizeWallet(payload.w);
    if (!address) return null;
    if (!Number.isFinite(payload.exp) || !Number.isFinite(payload.iat)) return null;
    if (payload.exp * 1000 <= now()) return null;

    return {
      wallet: address,
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
    buildSignInMessage: (args) => messageFor(args.wallet, args.nonce, args.issuedAt),
    domain,
    uri,
    chainId,
    nonceTtlMs: NONCE_TTL_MS,
    sessionTtlMs: SESSION_TTL_MS,
  };
}

export default createSessionService;
