/**
 * STOXVAULT — chain facts and the pure decisions that hang off them.
 *
 * Nothing here touches the DOM, the network or a wallet, so every function is
 * covered by `web/test/evm.test.js`.
 *
 * Robinhood Chain mainnet, verified against Robinhood's own documentation on
 * 2026-09-23: chain id 4663 (0x1237), RPC https://rpc.mainnet.chain.robinhood.com
 * with https://robinhood-rpc.publicnode.com as a public fallback. Testnet is
 * 46630. Robinhood Wallet connects to dapps on Ethereum, Polygon, Arbitrum,
 * Optimism, Base and Robinhood Chain — Solana is not on that list, which is the
 * whole reason this file exists.
 */

/** The chain this site signs in on. */
export const ROBINHOOD_CHAIN = Object.freeze({
  id: 4663,
  hexId: '0x1237',
  name: 'Robinhood Chain',
  shortName: 'Robinhood',
  nativeCurrency: Object.freeze({ name: 'Ether', symbol: 'ETH', decimals: 18 }),
  rpcUrls: Object.freeze(['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com']),
  blockExplorerUrls: Object.freeze(['https://explorer.chain.robinhood.com']),
});

/** The chain the payouts are still on. Named so the UI never has to guess. */
export const PAYOUT_CHAIN = Object.freeze({ name: 'Solana', kind: 'solana' });

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Shape check only: 0x + 40 hex digits, any case. */
export function isHexAddress(value) {
  return typeof value === 'string' && HEX_ADDRESS.test(value.trim());
}

/**
 * Are these two the same address?
 *
 * The browser must never decide this by `===`. A wallet returns the lower-case
 * form from `eth_accounts`, the server returns the EIP-55 checksum form, and a
 * strict compare between the two would silently log somebody out on every
 * reload. The checksum itself is the server's job — computing it here would mean
 * shipping a keccak implementation to do work that has already been done.
 */
export function sameAddress(a, b) {
  if (!isHexAddress(a) || !isHexAddress(b)) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Anything a provider might call a chain id -> a number, or null.
 * `eth_chainId` returns hex ('0x1237'); some wrappers return a decimal number or
 * string. A value that is not one of those is unknown, not zero.
 */
export function normalizeChainId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value === 'bigint') return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw === '') return null;
  const n = /^0[xX][0-9a-fA-F]+$/.test(raw) ? Number.parseInt(raw, 16) : /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** A chain id as the `0x…` string every EIP-1193 method wants. */
export function chainIdHex(value) {
  const id = normalizeChainId(value);
  return id === null ? null : `0x${id.toString(16)}`;
}

/**
 * Is the connected chain the one we sign on?
 *
 * `known: false` is its own answer: a provider that will not say which chain it
 * is on is not the same thing as a provider on the wrong chain, and the UI must
 * not offer a network switch on the strength of a failed read.
 *
 * @param {unknown} current whatever `eth_chainId` returned
 * @param {{id: number, name: string}} [chain]
 * @returns {{known: boolean, ok: boolean, chainId: number|null, expected: number, text: string}}
 */
export function chainStatus(current, chain = ROBINHOOD_CHAIN) {
  const chainId = normalizeChainId(current);
  if (chainId === null) {
    return {
      known: false,
      ok: false,
      chainId: null,
      expected: chain.id,
      text: `Your wallet did not say which network it is on. ${chain.name} is chain ${chain.id}.`,
    };
  }
  if (chainId === chain.id) {
    return { known: true, ok: true, chainId, expected: chain.id, text: `Connected to ${chain.name}.` };
  }
  return {
    known: true,
    ok: false,
    chainId,
    expected: chain.id,
    text: `Your wallet is on chain ${chainId}. This site signs on ${chain.name} (chain ${chain.id}).`,
  };
}

/** The `wallet_addEthereumChain` parameter object for a chain. */
export function addChainParams(chain = ROBINHOOD_CHAIN) {
  return {
    chainId: chainIdHex(chain.id),
    chainName: chain.name,
    nativeCurrency: { ...chain.nativeCurrency },
    rpcUrls: [...chain.rpcUrls],
    blockExplorerUrls: [...chain.blockExplorerUrls],
  };
}

/**
 * WalletConnect is the only desktop route into Robinhood Wallet, and it needs a
 * project id from WalletConnect Cloud. The founder does not have one yet.
 *
 * So the option is CONFIGURED, not hidden: with no id it renders disabled with
 * the real reason. An option that appears and then fails is worse than one that
 * says why it cannot work.
 *
 * @param {unknown} projectId the `<meta name="walletconnect-project-id">` value
 * @returns {{enabled: boolean, projectId: string|null, reason: string|null}}
 */
export function walletConnectConfig(projectId) {
  const id = typeof projectId === 'string' ? projectId.trim() : '';
  if (id === '' || id === 'REPLACE_ME') {
    return {
      enabled: false,
      projectId: null,
      reason: 'Needs a WalletConnect project id, which this site does not have yet. On a phone, open stoxvault in the Robinhood Wallet browser instead.',
    };
  }
  // A project id is a 32-character hex string. Anything else is a typo, and a
  // typo that reaches WalletConnect fails with a modal the user cannot read.
  if (!/^[0-9a-f]{32}$/i.test(id)) {
    return {
      enabled: false,
      projectId: null,
      reason: 'The WalletConnect project id in this page is not a valid id, so the QR option is switched off rather than shown broken.',
    };
  }
  return { enabled: true, projectId: id, reason: null };
}

export default {
  ROBINHOOD_CHAIN,
  PAYOUT_CHAIN,
  isHexAddress,
  sameAddress,
  normalizeChainId,
  chainIdHex,
  chainStatus,
  addChainParams,
  walletConnectConfig,
};
