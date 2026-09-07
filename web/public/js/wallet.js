/**
 * STOXVAULT — wallet connection.
 *
 * Three wallets, one operation. The only thing this module ever asks a wallet to
 * do is `signMessage`. There is deliberately no code path here that can call
 * `signTransaction`, `signAndSendTransaction`, `request({method:'...'})` or any
 * RPC that moves value — connecting to STOXVAULT cannot cost you anything, and
 * that is a property of the code, not a promise in the footer.
 *
 * Discovery follows the Wallet Standard:
 *   - listen for `wallet-standard:register-wallet` (wallets that loaded first)
 *   - dispatch `wallet-standard:app-ready` (wallets that load after us)
 *   - match `wallet.name` case-insensitively against phantom / jupiter / solflare
 * and falls back to the injected providers (`window.phantom.solana`,
 * `window.solflare`, `window.jupiter.solana`) when a wallet does not register.
 */

import * as api from './api.js';

const APP_READY = 'wallet-standard:app-ready';
const REGISTER = 'wallet-standard:register-wallet';

const F_CONNECT = 'standard:connect';
const F_DISCONNECT = 'standard:disconnect';
const F_EVENTS = 'standard:events';
const F_SIGN_MESSAGE = 'solana:signMessage';

/** The only wallets this app offers, in the order the modal shows them. */
export const WALLETS = [
  { id: 'phantom', name: 'Phantom', match: /phantom/i, installUrl: 'https://phantom.com' },
  { id: 'jupiter', name: 'Jupiter', match: /jupiter/i, installUrl: 'https://jup.ag' },
  { id: 'solflare', name: 'Solflare', match: /solflare/i, installUrl: 'https://solflare.com' },
];

const WALLET_IDS = new Set(WALLETS.map((w) => w.id));

/* ----------------------------------------------------------------- errors -- */

export class WalletError extends Error {
  /**
   * @param {'not_installed'|'rejected'|'no_signer'|'no_account'|'unsupported'|'failed'} code
   */
  constructor(code, message, cause = undefined) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Wallets report a user cancel in half a dozen different ways. */
function isRejection(err) {
  if (!err) return false;
  const code = err.code ?? err?.error?.code;
  if (code === 4001 || code === -32603) return true;
  const text = String(err.message || err).toLowerCase();
  return (
    text.includes('reject') ||
    text.includes('denied') ||
    text.includes('cancel') ||
    text.includes('declined') ||
    text.includes('closed')
  );
}

function wrapWalletError(err, fallbackCode = 'failed', fallbackMessage = 'The wallet could not complete that.') {
  if (err instanceof WalletError) return err;
  if (isRejection(err)) return new WalletError('rejected', 'You cancelled the request in your wallet.', err);
  return new WalletError(fallbackCode, err?.message ? String(err.message) : fallbackMessage, err);
}

/* --------------------------------------------------------------- base58 --- */

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Encode bytes as base58 — the canonical form a Solana wallet returns and the
 * form the server tries first, so there is no ambiguity at verification time.
 */
export function base58Encode(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (input.length === 0) return '';

  const digits = [0];
  for (let i = 0; i < input.length; i++) {
    let carry = input[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = '';
  for (let k = 0; k < input.length && input[k] === 0; k++) out += '1';
  for (let q = digits.length - 1; q >= 0; q--) out += B58_ALPHABET[digits[q]];
  return out;
}

/** Anything a wallet might hand back as a public key -> a base58 address. */
function toAddress(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value.toBase58 === 'function') return value.toBase58();
  if (value instanceof Uint8Array) return base58Encode(value);
  if (Array.isArray(value)) return base58Encode(Uint8Array.from(value));
  if (typeof value.toString === 'function') {
    const s = value.toString();
    return s && s !== '[object Object]' ? s : null;
  }
  return null;
}

/** Anything a wallet might hand back as a signature -> 64 raw bytes. */
function toSignatureBytes(value) {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (value.signature) return toSignatureBytes(value.signature);
  if (value.buffer instanceof ArrayBuffer) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'object' && typeof value.length === 'number') return Uint8Array.from(value);
  return null;
}

/* --------------------------------------------------- wallet standard store -- */

/** name (lowercased) -> the registered Wallet Standard object. */
const standardWallets = new Map();
const listeners = new Set();

let discovered = false;

function notify() {
  for (const listener of listeners) {
    try {
      listener(listWallets());
    } catch (err) {
      /* a broken listener must not break wallet discovery */
    }
  }
}

/** A registered wallet is usable only if it can connect, sign, and speaks Solana. */
function isUsable(wallet) {
  if (!wallet || typeof wallet !== 'object') return false;
  const features = wallet.features || {};
  if (!features[F_CONNECT] || typeof features[F_CONNECT].connect !== 'function') return false;
  if (!features[F_SIGN_MESSAGE] || typeof features[F_SIGN_MESSAGE].signMessage !== 'function') return false;
  const chains = Array.isArray(wallet.chains) ? wallet.chains : [];
  return chains.length === 0 || chains.some((c) => String(c).startsWith('solana:'));
}

function registerWallet(wallet) {
  if (!isUsable(wallet)) return;
  const name = String(wallet.name || '').trim();
  if (!name) return;
  const spec = WALLETS.find((w) => w.match.test(name));
  if (!spec) return; // three wallets only — anything else is ignored on purpose
  const existing = standardWallets.get(spec.id);
  if (existing === wallet) return;
  standardWallets.set(spec.id, wallet);

  // Re-render the modal when the wallet changes accounts or disconnects.
  const events = wallet.features?.[F_EVENTS];
  if (events && typeof events.on === 'function') {
    try {
      events.on('change', () => {
        if (active && active.id === spec.id) {
          const next = pickAccount(wallet);
          activeAddress = next ? toAddress(next.address || next.publicKey) : activeAddress;
          if (!next) clearActive();
        }
        notify();
      });
    } catch (err) {
      /* events are a nicety, not a requirement */
    }
  }
  notify();
}

/**
 * Run discovery once. Safe to call repeatedly; the listener is installed a
 * single time and the app-ready event is re-dispatched cheaply.
 */
export function discover() {
  if (typeof window === 'undefined') return;
  const appApi = {
    register(...wallets) {
      for (const w of wallets.flat()) registerWallet(w);
      return () => {};
    },
  };

  if (!discovered) {
    discovered = true;
    window.addEventListener(REGISTER, (event) => {
      const callback = event?.detail;
      if (typeof callback === 'function') {
        try {
          callback(appApi);
        } catch (err) {
          /* a wallet that throws during registration is simply not offered */
        }
      }
    });
  }

  try {
    window.dispatchEvent(new CustomEvent(APP_READY, { detail: appApi }));
  } catch (err) {
    /* CustomEvent is universally available; nothing to do if it is not */
  }
}

/* ------------------------------------------------------ injected fallback -- */

/**
 * The pre-Wallet-Standard injected providers, used only when a wallet did not
 * register. Each exposes `connect`, `disconnect`, `signMessage` and `publicKey`.
 */
function injectedProvider(id) {
  if (typeof window === 'undefined') return null;
  try {
    if (id === 'phantom') {
      const p = window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null);
      return p && typeof p.signMessage === 'function' ? p : null;
    }
    if (id === 'solflare') {
      const p = window.solflare || (window.solana?.isSolflare ? window.solana : null);
      return p && typeof p.signMessage === 'function' ? p : null;
    }
    if (id === 'jupiter') {
      const p =
        window.jupiter?.solana ||
        window.jupiterWallet ||
        (window.solana?.isJupiter ? window.solana : null) ||
        (window.solana?.isJupiterWallet ? window.solana : null);
      return p && typeof p.signMessage === 'function' ? p : null;
    }
  } catch (err) {
    return null;
  }
  return null;
}

/* ---------------------------------------------------------------- current -- */

let active = null; // { id, kind: 'standard'|'injected', wallet|provider }
let activeAddress = null;

function clearActive() {
  active = null;
  activeAddress = null;
}

/** The first account a Wallet Standard wallet exposes that can sign messages. */
function pickAccount(wallet) {
  const accounts = Array.isArray(wallet.accounts) ? wallet.accounts : [];
  const signer = accounts.find((a) => Array.isArray(a?.features) && a.features.includes(F_SIGN_MESSAGE));
  return signer || accounts[0] || null;
}

/* ------------------------------------------------------------------- API -- */

/**
 * The three options the modal renders.
 * @returns {{id, name, icon: string|null, installed: boolean, installUrl: string, source: 'standard'|'injected'|null}[]}
 */
export function listWallets() {
  return WALLETS.map((spec) => {
    const standard = standardWallets.get(spec.id) || null;
    const injected = standard ? null : injectedProvider(spec.id);
    return {
      id: spec.id,
      name: standard?.name || spec.name,
      icon: standard?.icon || null,
      installed: Boolean(standard || injected),
      installUrl: spec.installUrl,
      source: standard ? 'standard' : injected ? 'injected' : null,
    };
  });
}

/** Subscribe to "the set of available wallets changed". Returns an unsubscribe. */
export function onWalletsChanged(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The connected address, or null. */
export function publicKey() {
  return activeAddress;
}

/** The id of the connected wallet (`phantom` | `jupiter` | `solflare`), or null. */
export function connectedWalletId() {
  return active?.id ?? null;
}

/**
 * Connect. `silent: true` asks for a previously-authorised session without
 * showing a prompt — used on boot to restore a wallet without nagging.
 *
 * @returns {Promise<string>} the base58 address
 */
export async function connect(id, { silent = false } = {}) {
  if (!WALLET_IDS.has(id)) throw new WalletError('unsupported', `${id} is not one of the three supported wallets.`);

  const standard = standardWallets.get(id);
  if (standard) {
    let accounts;
    try {
      const result = await standard.features[F_CONNECT].connect(silent ? { silent: true } : undefined);
      accounts = Array.isArray(result?.accounts) ? result.accounts : standard.accounts;
    } catch (err) {
      if (silent) throw new WalletError('no_account', 'No wallet session to restore.', err);
      throw wrapWalletError(err, 'failed', 'The wallet refused the connection.');
    }
    const account = accounts?.find((a) => Array.isArray(a?.features) && a.features.includes(F_SIGN_MESSAGE)) || accounts?.[0];
    const address = account ? toAddress(account.address || account.publicKey) : null;
    if (!address) throw new WalletError('no_account', 'The wallet did not return an account.');
    active = { id, kind: 'standard', wallet: standard, account };
    activeAddress = address;
    notify();
    return address;
  }

  const provider = injectedProvider(id);
  if (!provider) {
    const spec = WALLETS.find((w) => w.id === id);
    throw new WalletError('not_installed', `${spec ? spec.name : id} is not installed in this browser.`);
  }

  try {
    const result = await provider.connect(silent ? { onlyIfTrusted: true } : undefined);
    const address = toAddress(result?.publicKey || provider.publicKey);
    if (!address) throw new WalletError('no_account', 'The wallet did not return an account.');
    active = { id, kind: 'injected', provider };
    activeAddress = address;
    notify();
    return address;
  } catch (err) {
    if (silent) throw new WalletError('no_account', 'No wallet session to restore.', err);
    throw wrapWalletError(err, 'failed', 'The wallet refused the connection.');
  }
}

/** Disconnect the wallet if it supports it, and forget the session either way. */
export async function disconnect() {
  const current = active;
  clearActive();
  api.session.clear();
  try {
    if (current?.kind === 'standard') {
      const feature = current.wallet.features?.[F_DISCONNECT];
      if (feature && typeof feature.disconnect === 'function') await feature.disconnect();
    } else if (current?.kind === 'injected' && typeof current.provider.disconnect === 'function') {
      await current.provider.disconnect();
    }
  } catch (err) {
    /* the wallet keeping its own session open is not our problem to solve */
  }
  notify();
}

/**
 * Sign a UTF-8 message. The one and only wallet operation in this app.
 * @returns {Promise<{signature: string, address: string}>} signature is base58
 */
export async function signMessage(text) {
  if (!active) throw new WalletError('no_signer', 'No wallet is connected.');
  if (typeof text !== 'string' || !text) throw new WalletError('failed', 'Nothing to sign.');

  const bytes = new TextEncoder().encode(text);

  try {
    if (active.kind === 'standard') {
      const account = active.account || pickAccount(active.wallet);
      if (!account) throw new WalletError('no_account', 'The wallet has no account to sign with.');
      const results = await active.wallet.features[F_SIGN_MESSAGE].signMessage({ account, message: bytes });
      const sig = toSignatureBytes(Array.isArray(results) ? results[0]?.signature : results);
      if (!sig || sig.length !== 64) throw new WalletError('failed', 'The wallet returned an unexpected signature.');
      return { signature: base58Encode(sig), address: toAddress(account.address || account.publicKey) };
    }

    const result = await active.provider.signMessage(bytes, 'utf8');
    const sig = toSignatureBytes(result);
    if (!sig || sig.length !== 64) throw new WalletError('failed', 'The wallet returned an unexpected signature.');
    return { signature: base58Encode(sig), address: activeAddress };
  } catch (err) {
    throw wrapWalletError(err, 'failed', 'The wallet could not sign the message.');
  }
}

/** True when a signature can be requested right now. */
export function canSign() {
  return Boolean(active);
}

/* -------------------------------------------------------------- sign-in --- */

/**
 * The full connect flow, exactly as CONTRACT.md section 8 specifies:
 *
 *   connect() -> POST /api/auth/nonce -> signMessage(message)
 *             -> POST /api/auth/verify -> token in localStorage -> me
 *
 * The message text is the server's, byte for byte. It is never rebuilt here,
 * because a message the client invented is a message the server cannot verify.
 *
 * @returns {Promise<{wallet: string, token: string, expiresAt: string|null, me: object|null}>}
 */
export async function signIn(id) {
  const address = await connect(id);

  const challenge = await api.authNonce(address);
  if (!challenge || typeof challenge.message !== 'string' || typeof challenge.nonce !== 'string') {
    throw new WalletError('failed', 'The server did not issue a sign-in message.');
  }

  const { signature } = await signMessage(challenge.message);

  const verified = await api.authVerify({ wallet: address, nonce: challenge.nonce, signature });
  if (!verified || typeof verified.token !== 'string') {
    throw new WalletError('failed', 'The server did not accept the signature.');
  }

  api.session.set({
    token: verified.token,
    wallet: verified.wallet || address,
    expiresAt: verified.expiresAt || null,
    walletId: id,
  });

  return {
    wallet: verified.wallet || address,
    token: verified.token,
    expiresAt: verified.expiresAt || null,
    me: verified.me || null,
  };
}

/**
 * Restore a session across a reload.
 *
 * The stored bearer token is the source of truth for "signed in"; the wallet
 * extension is reconnected silently and only so that saving a basket can be
 * signed without a second modal. A wallet that refuses the silent reconnect
 * costs nothing here — the session still stands.
 *
 * @returns {Promise<{wallet: string, walletId: string|null, reconnected: boolean}|null>}
 */
export async function restore() {
  const stored = api.session.get();
  if (!stored) return null;

  let reconnected = false;
  if (stored.walletId && WALLET_IDS.has(stored.walletId)) {
    try {
      const address = await connect(stored.walletId, { silent: true });
      if (address && address !== stored.wallet) {
        // The wallet switched accounts while we were away: the stored token no
        // longer describes the connected wallet, so drop it rather than show
        // one wallet's balance under another wallet's name.
        api.session.clear();
        clearActive();
        return null;
      }
      reconnected = true;
    } catch (err) {
      reconnected = false;
    }
  }

  return { wallet: stored.wallet, walletId: stored.walletId || null, reconnected };
}

/**
 * Reconnect the wallet behind an existing session, prompting if necessary.
 * Used when the user asks for something that needs a fresh signature after a
 * reload. Returns true when a signature can now be requested.
 */
export async function ensureSigner(expectedWallet = null, { prompt = false } = {}) {
  if (canSign() && (!expectedWallet || activeAddress === expectedWallet)) return true;

  const stored = api.session.get();
  const id = connectedWalletId() || stored?.walletId || null;
  if (!id || !WALLET_IDS.has(id)) return false;

  for (const silent of prompt ? [true, false] : [true]) {
    try {
      const address = await connect(id, { silent });
      if (!expectedWallet || address === expectedWallet) return true;
      return false;
    } catch (err) {
      if (err instanceof WalletError && err.code === 'rejected') return false;
    }
  }
  return false;
}

export default {
  WALLETS,
  WalletError,
  discover,
  listWallets,
  onWalletsChanged,
  connect,
  disconnect,
  signMessage,
  signIn,
  restore,
  ensureSigner,
  canSign,
  publicKey,
  connectedWalletId,
  base58Encode,
};
