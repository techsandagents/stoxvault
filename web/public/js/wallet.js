/**
 * STOXVAULT — wallet connection (Robinhood Wallet, EVM).
 *
 * One wallet, one operation. The only thing this module ever asks a wallet to do
 * is `personal_sign`. There is deliberately no code path here that can call
 * `eth_sendTransaction`, `eth_signTypedData_v4`, `eth_sign`, a token approval or
 * any RPC that moves value — connecting to STOXVAULT cannot cost you anything,
 * and that is a property of the code, not a promise in the footer. The only
 * other methods reachable from here are `eth_requestAccounts`, `eth_accounts`,
 * `eth_chainId`, and the two network-switch calls, which only ever run after the
 * user presses the switch button.
 *
 * Robinhood Wallet has no browser extension, so there are exactly two routes in:
 *
 *   injected   an EIP-1193 provider, discovered by EIP-6963 announcement with a
 *              `window.ethereum` fallback. This is what works inside Robinhood
 *              Wallet's own in-app browser on a phone.
 *   walletconnect  a QR the user scans with the app: the only desktop route.
 *              It needs a WalletConnect project id, which this site does not
 *              have yet, so the option renders DISABLED with the real reason
 *              rather than appearing and failing. See js/chain.js.
 */

import * as api from './api.js';
import {
  ROBINHOOD_CHAIN,
  addChainParams,
  chainIdHex,
  chainStatus,
  isHexAddress,
  sameAddress,
  walletConnectConfig,
} from './chain.js';

/** EIP-6963: the announcement event, and the request that asks for a replay. */
const ANNOUNCE = 'eip6963:announceProvider';
const REQUEST = 'eip6963:requestProvider';

/**
 * WalletConnect, pinned. There is no bundler and there must not be one, so the
 * library is a dynamic import from a CDN at the exact version — and it is only
 * ever fetched if a project id exists, which today it does not.
 */
const WALLETCONNECT_URL = 'https://cdn.jsdelivr.net/npm/@walletconnect/ethereum-provider@2.17.0/+esm';

/** The two options the modal shows, in order. */
export const WALLETS = [
  {
    id: 'robinhood',
    name: 'Robinhood Wallet',
    kind: 'injected',
    // EIP-6963 `info.rdns` first, then the display name.
    rdns: /robinhood/i,
    match: /robinhood/i,
    installUrl: 'https://robinhood.com/us/en/wallet/',
    hint: 'Open this page in the Robinhood Wallet app browser',
  },
  {
    id: 'walletconnect',
    name: 'Robinhood Wallet via QR',
    kind: 'walletconnect',
    installUrl: 'https://robinhood.com/us/en/wallet/',
    hint: 'Scan a code with the Robinhood Wallet app',
  },
];

const WALLET_IDS = new Set(WALLETS.map((w) => w.id));

export { ROBINHOOD_CHAIN };

/* ----------------------------------------------------------------- errors -- */

export class WalletError extends Error {
  /**
   * @param {'not_installed'|'rejected'|'no_signer'|'no_account'|'unsupported'|'unavailable'|'wrong_chain'|'failed'} code
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
  if (code === 4001) return true;
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

/* ------------------------------------------------------- provider discovery -- */

/** id -> { provider, info } for whatever announced itself. */
const announced = new Map();
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

/** An EIP-1193 provider is usable if it can be asked for anything at all. */
function isProvider(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.request === 'function';
}

/**
 * Which of our wallets does this announcement describe?
 * `rdns` is the reliable identifier; the display name is the fallback.
 */
function specFor(info) {
  const rdns = String(info?.rdns || '');
  const name = String(info?.name || '');
  return (
    WALLETS.find((w) => w.rdns && (w.rdns.test(rdns) || w.rdns.test(name))) || null
  );
}

function registerAnnouncement(detail) {
  const provider = detail?.provider;
  const info = detail?.info;
  if (!isProvider(provider)) return;
  const spec = specFor(info);
  if (!spec) return; // one wallet only — anything else is ignored on purpose
  const existing = announced.get(spec.id);
  if (existing && existing.provider === provider) return;
  announced.set(spec.id, { provider, info: info || null });
  notify();
}

/**
 * The `window.ethereum` fallback, for the in-app browser that injects a provider
 * without announcing it. It is only offered for the injected option, and only
 * when nothing announced itself.
 */
function injectedProvider() {
  if (typeof window === 'undefined') return null;
  try {
    const eth = window.ethereum;
    if (!isProvider(eth)) return null;
    // A page with several injected wallets exposes them on `providers`.
    const list = Array.isArray(eth.providers) ? eth.providers.filter(isProvider) : [];
    const robinhood = list.find((p) => p.isRobinhood || p.isRobinhoodWallet);
    return robinhood || (list.length ? list[0] : eth);
  } catch (err) {
    return null;
  }
}

/**
 * Run discovery once. Safe to call repeatedly; the listener is installed a
 * single time and the request event is re-dispatched cheaply.
 */
export function discover() {
  if (typeof window === 'undefined') return;

  if (!discovered) {
    discovered = true;
    window.addEventListener(ANNOUNCE, (event) => registerAnnouncement(event?.detail));
    // A provider injected after the page loads announces itself; one injected
    // before it replays on request. Both paths land in registerAnnouncement.
    if (typeof window.ethereum?.on === 'function') {
      try {
        window.ethereum.on('chainChanged', () => notify());
        window.ethereum.on('accountsChanged', (accounts) => {
          if (active?.id === 'robinhood') {
            const next = Array.isArray(accounts) ? accounts.find(isHexAddress) : null;
            if (next) activeAddress = next;
            else clearActive();
          }
          notify();
        });
      } catch (err) {
        /* provider events are a nicety, not a requirement */
      }
    }
  }

  try {
    window.dispatchEvent(new CustomEvent(REQUEST));
  } catch (err) {
    /* CustomEvent is universally available; nothing to do if it is not */
  }
}

/* -------------------------------------------------------- walletconnect ---- */

/** The `<meta name="walletconnect-project-id">` value, read the same way as the API base. */
export function walletConnectProjectId() {
  if (typeof document === 'undefined' || !document.querySelector) return '';
  const el = document.querySelector('meta[name="walletconnect-project-id"]');
  return el ? String(el.getAttribute('content') || '') : '';
}

/** `{enabled, projectId, reason}` for the QR option, as the modal renders it. */
export function walletConnectState() {
  return walletConnectConfig(walletConnectProjectId());
}

let wcProvider = null;

/**
 * Build the WalletConnect provider, once. Only reachable when a project id
 * exists; with none, `connect('walletconnect')` refuses before getting here.
 */
async function loadWalletConnect(projectId) {
  if (wcProvider) return wcProvider;
  let mod;
  try {
    mod = await import(/* @vite-ignore */ WALLETCONNECT_URL);
  } catch (err) {
    throw new WalletError('unavailable', 'The WalletConnect library could not be loaded.', err);
  }
  const EthereumProvider = mod?.EthereumProvider || mod?.default?.EthereumProvider || mod?.default;
  if (!EthereumProvider || typeof EthereumProvider.init !== 'function') {
    throw new WalletError('unavailable', 'The WalletConnect library did not load as expected.');
  }
  wcProvider = await EthereumProvider.init({
    projectId,
    chains: [ROBINHOOD_CHAIN.id],
    showQrModal: true,
    // Read-only methods plus the one signature. No transaction method is
    // requested, so the session cannot authorise one.
    methods: ['personal_sign'],
    events: ['chainChanged', 'accountsChanged'],
    metadata: {
      name: 'STOXVAULT',
      description: 'Memecoin fees buy tokenised stocks and drop them to holders.',
      url: typeof window !== 'undefined' ? window.location.origin : 'https://stoxvault.vercel.app',
      icons: [],
    },
  });
  return wcProvider;
}

/* ---------------------------------------------------------------- current -- */

let active = null; // { id, provider }
let activeAddress = null;

function clearActive() {
  active = null;
  activeAddress = null;
}

/** One place every provider call goes through, so the method list is auditable. */
const ALLOWED_METHODS = new Set([
  'eth_requestAccounts',
  'eth_accounts',
  'eth_chainId',
  'personal_sign',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
]);

async function rpc(provider, method, params) {
  if (!ALLOWED_METHODS.has(method)) {
    // Unreachable by construction; here so that adding a method is a deliberate
    // act rather than a typo.
    throw new WalletError('unsupported', `${method} is not something this site is allowed to ask a wallet for.`);
  }
  return provider.request(params === undefined ? { method } : { method, params });
}

/* ------------------------------------------------------------------- API -- */

/**
 * The options the modal renders.
 * @returns {{id, name, kind, icon: string|null, installed: boolean, available: boolean,
 *            disabled: boolean, reason: string|null, installUrl: string, hint: string,
 *            source: 'eip6963'|'injected'|'walletconnect'|null}[]}
 */
export function listWallets() {
  const wc = walletConnectState();
  return WALLETS.map((spec) => {
    if (spec.kind === 'walletconnect') {
      return {
        id: spec.id,
        name: spec.name,
        kind: spec.kind,
        icon: null,
        installed: wc.enabled,
        available: wc.enabled,
        disabled: !wc.enabled,
        reason: wc.reason,
        installUrl: spec.installUrl,
        hint: spec.hint,
        source: wc.enabled ? 'walletconnect' : null,
      };
    }
    const found = announced.get(spec.id) || null;
    const fallback = found ? null : injectedProvider();
    const available = Boolean(found || fallback);
    return {
      id: spec.id,
      name: found?.info?.name || spec.name,
      kind: spec.kind,
      icon: found?.info?.icon || null,
      installed: available,
      available,
      disabled: false, // not detected is still clickable: it opens the install page
      reason: available ? null : 'No wallet is injected in this browser.',
      installUrl: spec.installUrl,
      hint: spec.hint,
      source: found ? 'eip6963' : fallback ? 'injected' : null,
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

/** The id of the connected wallet (`robinhood` | `walletconnect`), or null. */
export function connectedWalletId() {
  return active?.id ?? null;
}

/** Resolve the provider for an option, or throw the reason it cannot be used. */
async function providerFor(id) {
  if (id === 'walletconnect') {
    const wc = walletConnectState();
    if (!wc.enabled) throw new WalletError('unavailable', wc.reason || 'The QR option is not configured.');
    return loadWalletConnect(wc.projectId);
  }
  const found = announced.get(id)?.provider || injectedProvider();
  if (!found) {
    throw new WalletError(
      'not_installed',
      'Robinhood Wallet is not injected in this browser. It has no extension — open this page in the Robinhood Wallet app browser, or use the QR option.',
    );
  }
  return found;
}

/**
 * Connect. `silent: true` asks for an already-authorised account without
 * showing a prompt — used on boot to restore a wallet without nagging.
 *
 * @returns {Promise<string>} the 0x address, as the wallet spells it
 */
export async function connect(id, { silent = false } = {}) {
  if (!WALLET_IDS.has(id)) throw new WalletError('unsupported', `${id} is not one of the supported connections.`);

  const provider = await providerFor(id);

  let accounts;
  try {
    if (silent) {
      // `eth_accounts` never prompts: it answers with what is already granted.
      accounts = await rpc(provider, 'eth_accounts');
      if (!Array.isArray(accounts) || accounts.length === 0) {
        if (id === 'walletconnect' && provider.session && Array.isArray(provider.accounts)) accounts = provider.accounts;
      }
    } else if (id === 'walletconnect' && typeof provider.connect === 'function' && !provider.session) {
      await provider.connect();
      accounts = provider.accounts;
    } else {
      accounts = await rpc(provider, 'eth_requestAccounts');
    }
  } catch (err) {
    if (silent) throw new WalletError('no_account', 'No wallet session to restore.', err);
    throw wrapWalletError(err, 'failed', 'The wallet refused the connection.');
  }

  const address = Array.isArray(accounts) ? accounts.find(isHexAddress) : null;
  if (!address) {
    if (silent) throw new WalletError('no_account', 'No wallet session to restore.');
    throw new WalletError('no_account', 'The wallet did not return an account.');
  }

  active = { id, provider };
  activeAddress = address;
  notify();
  return address;
}

/** Disconnect the wallet if it supports it, and forget the session either way. */
export async function disconnect() {
  const current = active;
  clearActive();
  api.session.clear();
  try {
    if (current?.id === 'walletconnect' && typeof current.provider.disconnect === 'function') {
      await current.provider.disconnect();
      wcProvider = null;
    }
    // An injected provider has no standard disconnect; forgetting the session on
    // our side is the whole of what we can and should do.
  } catch (err) {
    /* the wallet keeping its own session open is not our problem to solve */
  }
  notify();
}

/**
 * Which chain is the connected wallet on?
 * @returns {Promise<ReturnType<typeof chainStatus>>}
 */
export async function currentChain() {
  if (!active) return chainStatus(null);
  try {
    return chainStatus(await rpc(active.provider, 'eth_chainId'));
  } catch (err) {
    return chainStatus(null);
  }
}

/**
 * Ask the wallet to move to Robinhood Chain.
 *
 * Only ever called from the button the user presses after being told, in words,
 * which chain they are on and which one this site signs on. Nothing switches a
 * network silently.
 *
 * @returns {Promise<boolean>} true when the wallet reports the right chain after
 */
export async function switchToRobinhoodChain() {
  if (!active) throw new WalletError('no_signer', 'No wallet is connected.');
  const hexId = chainIdHex(ROBINHOOD_CHAIN.id);
  try {
    await rpc(active.provider, 'wallet_switchEthereumChain', [{ chainId: hexId }]);
  } catch (err) {
    // 4902: the wallet does not know this chain yet. Adding it is the documented
    // fallback, and it still needs the user's approval in the wallet.
    const code = err?.code ?? err?.data?.originalError?.code;
    if (code === 4902 || /unrecognized chain|add.*chain/i.test(String(err?.message || ''))) {
      try {
        await rpc(active.provider, 'wallet_addEthereumChain', [addChainParams(ROBINHOOD_CHAIN)]);
      } catch (addErr) {
        throw wrapWalletError(addErr, 'wrong_chain', 'The wallet would not add Robinhood Chain.');
      }
    } else {
      throw wrapWalletError(err, 'wrong_chain', 'The wallet would not switch network.');
    }
  }
  return (await currentChain()).ok;
}

/**
 * Sign a UTF-8 message with `personal_sign`. The one and only wallet operation
 * in this app that needs approval.
 *
 * @returns {Promise<{signature: string, address: string}>} signature is 0x hex
 */
export async function signMessage(text) {
  if (!active) throw new WalletError('no_signer', 'No wallet is connected.');
  if (typeof text !== 'string' || !text) throw new WalletError('failed', 'Nothing to sign.');

  // personal_sign takes the message as a hex string, then the address.
  const bytes = new TextEncoder().encode(text);
  let hex = '0x';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');

  try {
    const signature = await rpc(active.provider, 'personal_sign', [hex, activeAddress]);
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      throw new WalletError('failed', 'The wallet returned an unexpected signature.');
    }
    return { signature, address: activeAddress };
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
 * The full connect flow:
 *
 *   connect() -> check the chain -> POST /api/auth/nonce -> personal_sign
 *             -> POST /api/auth/verify -> token in localStorage -> me
 *
 * Exactly one signature, and it is the server's message byte for byte. The text
 * is never rebuilt here, because a message the client invented is a message the
 * server cannot verify.
 *
 * A wallet on the wrong chain does NOT get switched silently: the flow stops
 * with a `wrong_chain` error carrying the chain status, and the page offers the
 * switch as a button.
 *
 * @returns {Promise<{wallet: string, token: string, expiresAt: string|null, me: object|null}>}
 */
export async function signIn(id, { requireChain = true } = {}) {
  const address = await connect(id);

  if (requireChain) {
    const chain = await currentChain();
    if (!chain.ok) {
      const err = new WalletError('wrong_chain', chain.text);
      err.chain = chain;
      throw err;
    }
  }

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
 * The stored bearer token is the source of truth for "signed in"; the wallet is
 * reconnected silently and only so that saving a basket can be signed without a
 * second modal. A wallet that refuses the silent reconnect costs nothing here —
 * the session still stands.
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
      // Case-insensitive: the wallet says `0xab…`, the server stored `0xAb…`.
      if (address && !sameAddress(address, stored.wallet)) {
        // The wallet switched accounts while we were away: the stored token no
        // longer describes the connected wallet, so drop it rather than show
        // one wallet's view under another wallet's name.
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
  if (canSign() && (!expectedWallet || sameAddress(activeAddress, expectedWallet))) return true;

  const stored = api.session.get();
  const id = connectedWalletId() || stored?.walletId || null;
  if (!id || !WALLET_IDS.has(id)) return false;

  for (const silent of prompt ? [true, false] : [true]) {
    try {
      const address = await connect(id, { silent });
      if (!expectedWallet || sameAddress(address, expectedWallet)) return true;
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
  ROBINHOOD_CHAIN,
  discover,
  listWallets,
  onWalletsChanged,
  walletConnectState,
  connect,
  disconnect,
  currentChain,
  switchToRobinhoodChain,
  signMessage,
  signIn,
  restore,
  ensureSigner,
  canSign,
  publicKey,
  connectedWalletId,
};
