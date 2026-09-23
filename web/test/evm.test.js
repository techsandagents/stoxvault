/**
 * Tests for the front-end decisions the Robinhood Wallet move introduced, all of
 * them pure: no DOM, no fetch, no wallet.
 *
 *   1. chain.js — Robinhood Chain's facts, address comparison that survives the
 *      case difference between a wallet and the server, chain-id parsing that
 *      answers "unknown" rather than guessing, and the WalletConnect gate that
 *      keeps the QR option disabled while there is no project id.
 *   2. basket.js — reading /api/me.attribution: the callout that says a
 *      connected wallet cannot be paid, and the cases where no claim is made.
 *
 * Run from the repo root:  node --test web/test/
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PAYOUT_CHAIN,
  ROBINHOOD_CHAIN,
  addChainParams,
  chainIdHex,
  chainStatus,
  isHexAddress,
  normalizeChainId,
  sameAddress,
  walletConnectConfig,
} from '../public/js/chain.js';

import { readAttribution } from '../public/js/ui/basket.js';

/* ------------------------------------------------------------------ chain */

test('Robinhood Chain is 4663 / 0x1237 and the payout chain is not it', () => {
  assert.equal(ROBINHOOD_CHAIN.id, 4663);
  assert.equal(ROBINHOOD_CHAIN.hexId, '0x1237');
  assert.equal(chainIdHex(ROBINHOOD_CHAIN.id), ROBINHOOD_CHAIN.hexId, 'the hex form is derivable, not a second source of truth');
  assert.equal(ROBINHOOD_CHAIN.name, 'Robinhood Chain');
  assert.equal(ROBINHOOD_CHAIN.rpcUrls[0], 'https://rpc.mainnet.chain.robinhood.com');
  assert.ok(ROBINHOOD_CHAIN.rpcUrls.length >= 2, 'a public fallback RPC is configured');
  assert.equal(PAYOUT_CHAIN.kind, 'solana', 'the drops are still on Solana, and the code says so');
});

test('addChainParams is a complete wallet_addEthereumChain payload', () => {
  const params = addChainParams();
  assert.equal(params.chainId, '0x1237');
  assert.equal(params.chainName, 'Robinhood Chain');
  assert.equal(params.nativeCurrency.decimals, 18);
  assert.ok(Array.isArray(params.rpcUrls) && params.rpcUrls.length > 0);
  assert.ok(Array.isArray(params.blockExplorerUrls));
  // A copy, not the frozen constant: a provider that mutates its argument must
  // not be able to corrupt the chain definition for the rest of the session.
  params.rpcUrls.push('https://evil.example');
  assert.equal(addChainParams().rpcUrls.includes('https://evil.example'), false);
});

test('addresses compare without case, and nothing else compares at all', () => {
  const lower = '0xfcad0b19bb29d4674531d6f115237e16afce377c';
  const checksum = '0xFCAd0B19bB29D4674531d6f115237E16AfCE377c';

  assert.equal(isHexAddress(lower), true);
  assert.equal(isHexAddress(checksum), true);
  assert.equal(isHexAddress('0x123'), false);
  assert.equal(isHexAddress('769fv6KK6SAQ5FBAXdUZLdrppdHn5CqqgJBpFCLyf9up'), false);
  assert.equal(isHexAddress(null), false);

  // This is the whole point: the wallet says one, the server says the other.
  assert.notEqual(lower, checksum);
  assert.equal(sameAddress(lower, checksum), true);
  assert.equal(sameAddress(` ${lower} `, checksum), true);
  assert.equal(sameAddress(lower, `0xfcad0b19bb29d4674531d6f115237e16afce377d`), false);
  assert.equal(sameAddress(lower, 'nope'), false);
  assert.equal(sameAddress(null, null), false, 'two non-addresses are not the same address');
  assert.equal(sameAddress('', ''), false);
});

test('a chain id is parsed from every shape a provider uses, or refused', () => {
  assert.equal(normalizeChainId('0x1237'), 4663);
  assert.equal(normalizeChainId('0X1237'), 4663);
  assert.equal(normalizeChainId(4663), 4663);
  assert.equal(normalizeChainId('4663'), 4663);
  assert.equal(normalizeChainId(4663n), 4663);

  assert.equal(normalizeChainId('0x'), null);
  assert.equal(normalizeChainId(''), null);
  assert.equal(normalizeChainId('mainnet'), null);
  assert.equal(normalizeChainId(0), null, 'zero is not a chain');
  assert.equal(normalizeChainId(-1), null);
  assert.equal(normalizeChainId(null), null);
  assert.equal(normalizeChainId(undefined), null);
  assert.equal(normalizeChainId({}), null);
  assert.equal(chainIdHex('nope'), null);
});

test('chainStatus separates "wrong chain" from "would not say"', () => {
  const right = chainStatus('0x1237');
  assert.equal(right.known, true);
  assert.equal(right.ok, true);
  assert.equal(right.chainId, 4663);

  const wrong = chainStatus('0x1'); // Ethereum mainnet
  assert.equal(wrong.known, true);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.chainId, 1);
  assert.ok(wrong.text.includes('chain 1'), wrong.text);
  assert.ok(wrong.text.includes('Robinhood Chain (chain 4663)'), wrong.text);

  // A provider that will not answer is NOT the same as one on the wrong chain:
  // offering a network switch on the strength of a failed read would be a guess.
  const unknown = chainStatus(undefined);
  assert.equal(unknown.known, false);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.chainId, null);
  assert.ok(unknown.text.includes('did not say'), unknown.text);
});

test('the WalletConnect QR option stays disabled until there is a real project id', () => {
  // Today's state: the <meta> tag ships empty, so the option renders disabled
  // with a reason rather than appearing and failing on click.
  for (const value of ['', '   ', 'REPLACE_ME', null, undefined, 42]) {
    const state = walletConnectConfig(value);
    assert.equal(state.enabled, false, JSON.stringify(value));
    assert.equal(state.projectId, null);
    assert.ok(state.reason && state.reason.length > 20, 'a disabled option explains itself');
  }
  assert.ok(walletConnectConfig('').reason.includes('Robinhood Wallet browser'), 'and names the route that does work');

  // A typo is refused too: a bad id reaches WalletConnect and fails in a modal
  // the user cannot read.
  assert.equal(walletConnectConfig('not-a-project-id').enabled, false);
  assert.equal(walletConnectConfig('abc123').enabled, false, 'too short');

  const good = walletConnectConfig('0123456789abcdef0123456789abcdef');
  assert.equal(good.enabled, true);
  assert.equal(good.projectId, '0123456789abcdef0123456789abcdef');
  assert.equal(good.reason, null);
  assert.equal(walletConnectConfig('  0123456789ABCDEF0123456789abcdef  ').enabled, true, 'trimmed, case-insensitive');
});

/* ------------------------------------------------------------ attribution */

test('readAttribution shows the server sentence, and invents nothing', () => {
  const real = {
    signInChain: 'evm',
    signInChainId: 4663,
    payoutChain: 'solana',
    chainsMatch: false,
    tokenSet: false,
    eligible: false,
    canReceive: false,
    headline: 'This wallet cannot receive a drop yet',
    note: 'No drop can be attributed to this wallet yet: you signed in with a Robinhood Chain address.',
  };
  const shown = readAttribution(real);
  assert.equal(shown.show, true);
  assert.equal(shown.title, 'This wallet cannot receive a drop yet');
  assert.equal(shown.text, real.note, 'verbatim — no paraphrase');

  // The only thing that hides it.
  assert.equal(readAttribution({ ...real, canReceive: true }).show, false);

  // Everything that does NOT hide it.
  assert.equal(readAttribution({ ...real, canReceive: undefined }).show, true);
  assert.equal(readAttribution({ ...real, canReceive: 'true' }).show, true, 'a string is not a boolean true');
  assert.equal(readAttribution({ ...real, canReceive: 1 }).show, true);

  // No object, or no sentence: no claim in either direction.
  assert.equal(readAttribution(null).show, false);
  assert.equal(readAttribution(undefined).show, false);
  assert.equal(readAttribution([]).show, false);
  assert.equal(readAttribution('nope').show, false);
  assert.equal(readAttribution({ canReceive: false }).show, false, 'a flag with no explanation is not a callout');
  assert.equal(readAttribution({ canReceive: false, note: '   ' }).show, false);

  // A server that sends the sentence under another name is still understood.
  assert.equal(readAttribution({ canReceive: false, message: 'because reasons' }).text, 'because reasons');
  assert.equal(
    readAttribution({ canReceive: false, note: 'x' }).title,
    'This wallet cannot receive a drop yet',
    'a missing headline falls back, it does not blank the callout',
  );
});
