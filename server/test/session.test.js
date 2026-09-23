// Sign-in: EVM addresses, the EIP-4361 message, EIP-191 verification,
// single-use nonces and session tokens.
//
// These tests generate a real secp256k1 key with @noble/curves and sign with it,
// so what is exercised here is the same code path a Robinhood Wallet signature
// takes. One hard-coded vector is pinned as well: a refactor that quietly
// changed the hashing scheme would still pass every generated-key test, because
// both sides would move together. The pinned triple cannot move.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

import {
  DEFAULT_CHAIN_ID,
  DEFAULT_DOMAIN,
  DEFAULT_URI,
  NONCE_TTL_MS,
  SESSION_TTL_MS,
  SIGN_IN_STATEMENT,
  b58decode,
  b58encode,
  buildSignInMessage,
  createSessionService,
  decodeSignature,
  hashPersonalMessage,
  isChecksumAddress,
  isHexAddress,
  isSolanaAddress,
  isWallet,
  mintNonce,
  nonceIssuedAt,
  normalizeWallet,
  recoverAddress,
  toChecksumAddress,
  verifySignature,
  walletBytes,
} from '../src/services/session.js';

const CURVE_N = secp256k1.CURVE.n;

/* ------------------------------------------------------------------ helpers */

const hex = (bytes) => Buffer.from(bytes).toString('hex');

/** address = last 20 bytes of keccak256(uncompressed pubkey without its 0x04 tag) */
function addressOf(privKey) {
  const pub = secp256k1.getPublicKey(privKey, false);
  return toChecksumAddress(`0x${hex(keccak_256(pub.subarray(1)).subarray(12))}`);
}

/**
 * Sign a message the way `personal_sign` does: hash with the EIP-191 prefix,
 * then r || s || v with v in {27, 28}.
 */
function personalSign(privKey, message, { v = 'legacy' } = {}) {
  const digest = hashPersonalMessage(message);
  const sig = secp256k1.sign(digest, privKey, { prehash: false });
  const recovery = sig.recovery;
  const vByte = v === 'legacy' ? 27 + recovery : recovery;
  return `0x${sig.r.toString(16).padStart(64, '0')}${sig.s.toString(16).padStart(64, '0')}${vByte
    .toString(16)
    .padStart(2, '0')}`;
}

/** The malleable twin of a signature: s -> n - s, v flipped. Must be refused. */
function malleate(signature) {
  const raw = Buffer.from(signature.slice(2), 'hex');
  const r = raw.subarray(0, 32);
  const s = BigInt(`0x${raw.subarray(32, 64).toString('hex')}`);
  const v = raw[64];
  const flipped = CURVE_N - s;
  const newV = v === 27 ? 28 : v === 28 ? 27 : v === 0 ? 1 : 0;
  return `0x${r.toString('hex')}${flipped.toString(16).padStart(64, '0')}${newV.toString(16).padStart(2, '0')}`;
}

/** A throwaway wallet backed by a real secp256k1 key. */
function newWallet() {
  const privateKey = secp256k1.utils.randomSecretKey
    ? secp256k1.utils.randomSecretKey()
    : secp256k1.utils.randomPrivateKey();
  return {
    privateKey,
    address: addressOf(privateKey),
    sign: (message, opts) => personalSign(privateKey, message, opts),
  };
}

/** Minimal in-memory nonce store with the two methods the service uses. */
function nonceStore() {
  const rows = new Map();
  return {
    rows,
    async putNonce(wallet, nonce, expiresAt) {
      rows.set(`${wallet}|${nonce}`, Date.parse(expiresAt));
    },
    async takeNonce(wallet, nonce) {
      const key = `${wallet}|${nonce}`;
      const exp = rows.get(key);
      rows.delete(key);
      return exp !== undefined && exp > Date.now();
    },
  };
}

const cfgWith = (secret = 'unit-test-secret') => ({ sessionSecret: secret });

/* ------------------------------------------------------------- the pin ---- */

// A hard-coded address / message / signature triple, produced by this scheme and
// checked in so it can never drift. The private key is
// 0x0123...cdef, the message is the six-field EIP-4361 text below, and the
// signature is EIP-191 personal_sign with v = 28.
const PIN = {
  privateKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  address: '0xFCAd0B19bB29D4674531d6f115237E16AfCE377c',
  message: [
    'stoxvault.vercel.app wants you to sign in with your Ethereum account:',
    '0xFCAd0B19bB29D4674531d6f115237E16AfCE377c',
    '',
    SIGN_IN_STATEMENT,
    '',
    'URI: https://stoxvault.vercel.app',
    'Version: 1',
    'Chain ID: 4663',
    'Nonce: mudyigub0011223344556677',
    'Issued At: 2026-09-23T12:00:00.000Z',
  ].join('\n'),
};

test('the pinned vector: a known key, message and signature still verify', () => {
  const priv = Buffer.from(PIN.privateKey, 'hex');
  assert.equal(addressOf(priv), PIN.address, 'the address derivation has not moved');

  // The signature is regenerated from the pinned key, but everything it is
  // checked against is hard-coded, so a change to the hashing scheme, the
  // message text or the address derivation breaks this test.
  const signature = personalSign(priv, PIN.message);
  assert.equal(recoverAddress({ message: PIN.message, signature }), PIN.address);
  assert.equal(verifySignature({ wallet: PIN.address, message: PIN.message, signature }), true);

  // And the digest itself is pinned: this is keccak256 of
  // "\x19Ethereum Signed Message:\n<len>" + the message.
  const digest = hashPersonalMessage(PIN.message);
  assert.equal(digest.length, 32);
  assert.equal(
    hex(digest),
    hex(
      keccak_256(
        Buffer.concat([
          Buffer.from(`\u0019Ethereum Signed Message:\n${Buffer.byteLength(PIN.message, 'utf8')}`, 'utf8'),
          Buffer.from(PIN.message, 'utf8'),
        ]),
      ),
    ),
  );

  // A wallet built by the real builder produces exactly the pinned text.
  assert.equal(
    buildSignInMessage({
      wallet: PIN.address.toLowerCase(),
      nonce: 'mudyigub0011223344556677',
      issuedAt: '2026-09-23T12:00:00.000Z',
    }),
    PIN.message,
  );
});

/* ---------------------------------------------------------------- addresses */

test('EIP-55 checksums are the one canonical spelling', () => {
  // The four vectors from EIP-55 itself.
  for (const address of [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ]) {
    assert.equal(toChecksumAddress(address), address, address);
    assert.equal(toChecksumAddress(address.toLowerCase()), address, 'lower case in, checksum out');
    assert.equal(toChecksumAddress(address.toUpperCase().replace('0X', '0x')), address, 'upper case in, checksum out');
    assert.equal(isChecksumAddress(address), true);
    assert.equal(isChecksumAddress(address.toLowerCase()), false, 'lower case is valid input, not canonical storage');
  }

  assert.equal(toChecksumAddress('0x123'), null);
  assert.equal(toChecksumAddress(''), null);
  assert.equal(toChecksumAddress(null), null);
  assert.equal(toChecksumAddress(`0x${'0'.repeat(41)}`), null, '41 hex digits is not an address');
  assert.equal(toChecksumAddress(`0x${'g'.repeat(40)}`), null, 'g is not hex');
});

test('mixed-case addresses resolve to exactly one account', () => {
  const wallet = newWallet();
  const forms = [
    wallet.address,
    wallet.address.toLowerCase(),
    wallet.address.toUpperCase().replace('0X', '0x'),
    `  ${wallet.address.toLowerCase()}  `,
  ];
  const resolved = new Set(forms.map((f) => normalizeWallet(f)));
  assert.equal(resolved.size, 1, 'every spelling of one address is one account');
  assert.equal([...resolved][0], wallet.address);
  for (const form of forms) assert.equal(isWallet(form), true, form);
});

test('isWallet accepts EVM addresses and nothing else', () => {
  assert.equal(isWallet(newWallet().address), true);
  assert.equal(isWallet('0x0000000000000000000000000000000000000000'), true);
  assert.equal(isWallet('not-a-wallet'), false);
  assert.equal(isWallet(''), false);
  assert.equal(isWallet(null), false);
  assert.equal(isWallet('769fv6KK6SAQ5FBAXdUZLdrppdHn5CqqgJBpFCLyf9up'), false, 'a Solana address is not a wallet here');
  assert.equal(isWallet(`${newWallet().address}00`), false, 'too long');
  assert.equal(isHexAddress('0xABCDEFabcdef0123456789012345678901234567'), true);

  const bytes = walletBytes(newWallet().address);
  assert.equal(bytes.length, 20);
  assert.equal(walletBytes('nope'), null);
});

test('base58 is still exported for the Solana holder code, and is not a wallet check', () => {
  // services/holders.js decodes token-account owners with these; sign-in does not.
  for (let i = 0; i < 20; i++) {
    const bytes = crypto.randomBytes(32);
    assert.deepEqual(Buffer.from(b58decode(b58encode(bytes))), bytes);
  }
  assert.equal(b58decode('0OIl'), null);
  assert.equal(isSolanaAddress('769fv6KK6SAQ5FBAXdUZLdrppdHn5CqqgJBpFCLyf9up'), true);
  assert.equal(isSolanaAddress(newWallet().address), false);
});

/* ----------------------------------------------------------------- message */

test('the sign-in message is EIP-4361, and still says it is not a transaction', () => {
  const wallet = '0xFCAd0B19bB29D4674531d6f115237E16AfCE377c';
  const message = buildSignInMessage({
    wallet,
    nonce: 'mudyigub0011223344556677',
    issuedAt: '2026-09-23T12:00:00.000Z',
  });

  assert.equal(
    message,
    'stoxvault.vercel.app wants you to sign in with your Ethereum account:\n'
      + `${wallet}\n`
      + '\n'
      + 'Sign to verify you own this wallet. This is not a transaction. Nothing leaves your wallet.\n'
      + '\n'
      + 'URI: https://stoxvault.vercel.app\n'
      + 'Version: 1\n'
      + 'Chain ID: 4663\n'
      + 'Nonce: mudyigub0011223344556677\n'
      + 'Issued At: 2026-09-23T12:00:00.000Z',
  );
  assert.equal(message.split('\n').length, 10);

  // The promise in the message, word for word.
  assert.ok(message.includes('This is not a transaction.'), message);
  assert.ok(message.includes('Nothing leaves your wallet.'), message);

  // Domain and chain binding: another site's message does not rebuild to ours.
  const elsewhere = buildSignInMessage({
    wallet,
    nonce: 'mudyigub0011223344556677',
    issuedAt: '2026-09-23T12:00:00.000Z',
    domain: 'evil.example',
    uri: 'https://evil.example',
  });
  assert.notEqual(elsewhere, message);
  assert.equal(DEFAULT_DOMAIN, 'stoxvault.vercel.app');
  assert.equal(DEFAULT_URI, 'https://stoxvault.vercel.app');
  assert.equal(DEFAULT_CHAIN_ID, 4663, 'Robinhood Chain mainnet');

  // The address line is always the checksum form, whatever came in.
  assert.ok(
    buildSignInMessage({ wallet: wallet.toLowerCase(), nonce: 'n'.repeat(24), issuedAt: 'x' }).includes(wallet),
    'a lower-case address is displayed checksummed',
  );
});

test('a nonce carries its own issue time and is EIP-4361 alphanumeric', () => {
  const at = 1_789_000_000_000;
  const nonce = mintNonce(at);
  assert.equal(nonceIssuedAt(nonce), at);
  assert.equal(nonce.length, 24);
  assert.match(nonce, /^[0-9a-z]{24}$/, 'alphanumeric, no separator: SIWE forbids one');
  assert.equal(nonceIssuedAt('garbage'), null);
  assert.equal(nonceIssuedAt('abc.def'), null);
  assert.equal(nonceIssuedAt(''), null);
  assert.equal(nonceIssuedAt(null), null);
  assert.notEqual(mintNonce(at), mintNonce(at), 'nonces are random, not just timestamps');
});

/* --------------------------------------------------------------- signature */

test('a known-good triple verifies, and everything adjacent to it does not', () => {
  const wallet = newWallet();
  const message = buildSignInMessage({ wallet: wallet.address, nonce: mintNonce(), issuedAt: new Date().toISOString() });
  const signature = wallet.sign(message);

  assert.equal(verifySignature({ wallet: wallet.address, message, signature }), true);
  assert.equal(recoverAddress({ message, signature }), wallet.address);

  // a signature from a different key
  const other = newWallet();
  assert.equal(
    verifySignature({ wallet: wallet.address, message, signature: other.sign(message) }),
    false,
    'another key signing the same text is not this wallet',
  );
  // the right signature, claimed for the wrong wallet
  assert.equal(verifySignature({ wallet: other.address, message, signature }), false);
  // a tampered message
  assert.equal(verifySignature({ wallet: wallet.address, message: `${message} `, signature }), false, 'trailing space');
  assert.equal(
    verifySignature({ wallet: wallet.address, message: message.replace('Chain ID: 4663', 'Chain ID: 1'), signature }),
    false,
    'a different chain id is a different message',
  );
  // garbage
  assert.equal(verifySignature({ wallet: wallet.address, message, signature: 'not-a-signature' }), false);
  assert.equal(verifySignature({ wallet: wallet.address, message, signature: `0x${'11'.repeat(65)}` }), false);
  assert.equal(verifySignature({ wallet: 'nope', message, signature }), false);
  assert.equal(verifySignature({ wallet: wallet.address, message: '', signature }), false);

  // a mixed-case claim of the same address still verifies: one account.
  assert.equal(verifySignature({ wallet: wallet.address.toLowerCase(), message, signature }), true);
});

test('both v encodings work and an upper-s signature is refused', () => {
  const wallet = newWallet();
  const message = buildSignInMessage({ wallet: wallet.address, nonce: mintNonce(), issuedAt: new Date().toISOString() });

  const legacy = wallet.sign(message); // v = 27 / 28
  const modern = wallet.sign(message, { v: 'raw' }); // v = 0 / 1
  assert.equal(verifySignature({ wallet: wallet.address, message, signature: legacy }), true, 'v = 27/28');
  assert.equal(verifySignature({ wallet: wallet.address, message, signature: modern }), true, 'v = 0/1');
  assert.equal(legacy.slice(0, -2), modern.slice(0, -2), 'same r and s, only v differs');
  assert.notEqual(legacy, modern);

  // EIP-2: the upper-half twin recovers the same key on a naive implementation,
  // which would let ONE signature be replayed in TWO forms. Refuse it outright.
  const malleable = malleate(legacy);
  assert.notEqual(malleable, legacy);
  assert.equal(decodeSignature(malleable), null, 'upper-s is rejected at decode time');
  assert.equal(verifySignature({ wallet: wallet.address, message, signature: malleable }), false);
  assert.equal(recoverAddress({ message, signature: malleable }), null);

  // A v that is neither encoding is refused rather than quietly reduced.
  const badV = `${legacy.slice(0, -2)}25`;
  assert.equal(decodeSignature(badV), null, 'an EIP-155 transaction v is not a personal_sign v');
});

test('decodeSignature takes hex and base64 and refuses the rest', () => {
  const wallet = newWallet();
  const message = 'anything';
  const signature = wallet.sign(message);
  const raw = Buffer.from(signature.slice(2), 'hex');

  const fromHex = decodeSignature(signature);
  assert.equal(fromHex.bytes.length, 65);
  assert.deepEqual(decodeSignature(signature.slice(2)).bytes, fromHex.bytes, 'bare hex');
  assert.deepEqual(decodeSignature(raw.toString('base64')).bytes, fromHex.bytes, 'base64');
  assert.deepEqual(decodeSignature(raw.toString('base64url')).bytes, fromHex.bytes, 'base64url');

  assert.equal(decodeSignature(`0x${'00'.repeat(65)}`), null, 'r = 0 is not a signature');
  assert.equal(decodeSignature(`0x${'ab'.repeat(64)}`), null, '64 bytes is not 65');
  assert.equal(decodeSignature('!!!'), null);
  assert.equal(decodeSignature('a'.repeat(500)), null, 'absurd lengths are refused outright');
  assert.equal(decodeSignature(''), null);
  assert.equal(decodeSignature(null), null);
  assert.equal(decodeSignature(42), null);
});

test('the EIP-191 digest counts BYTES, not characters', () => {
  // A single emoji is four UTF-8 bytes and one JS surrogate pair: a length taken
  // from `message.length` would hash a different prefix on each side.
  const message = 'hi 🚀';
  const expected = keccak_256(
    Buffer.concat([
      Buffer.from(`\u0019Ethereum Signed Message:\n${Buffer.byteLength(message, 'utf8')}`, 'utf8'),
      Buffer.from(message, 'utf8'),
    ]),
  );
  assert.equal(hex(hashPersonalMessage(message)), hex(expected));
  assert.notEqual(Buffer.byteLength(message, 'utf8'), message.length, 'the two lengths really do differ');

  const wallet = newWallet();
  assert.equal(verifySignature({ wallet: wallet.address, message, signature: wallet.sign(message) }), true);
});

/* ------------------------------------------------------------ nonce + flow */

test('a nonce signs in once and only once', async () => {
  const db = nonceStore();
  const session = createSessionService({ cfg: cfgWith(), db });
  const wallet = newWallet();

  const issued = await session.issueNonce(wallet.address);
  assert.equal(issued.wallet, wallet.address);
  assert.equal(issued.chainId, DEFAULT_CHAIN_ID);
  assert.equal(issued.message, buildSignInMessage({ wallet: wallet.address, nonce: issued.nonce, issuedAt: issued.issuedAt }));
  assert.equal(Date.parse(issued.expiresAt) - Date.parse(issued.issuedAt), NONCE_TTL_MS);

  const signature = wallet.sign(issued.message);
  const first = await session.verify({ wallet: wallet.address, nonce: issued.nonce, signature });
  assert.equal(first.ok, true);
  assert.equal(first.wallet, wallet.address);

  const second = await session.verify({ wallet: wallet.address, nonce: issued.nonce, signature });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'bad_nonce');
});

test('a nonce issued for one spelling of an address is redeemable by any spelling', async () => {
  const db = nonceStore();
  const session = createSessionService({ cfg: cfgWith(), db });
  const wallet = newWallet();

  const issued = await session.issueNonce(wallet.address.toLowerCase());
  const result = await session.verify({
    wallet: wallet.address.toUpperCase().replace('0X', '0x'),
    nonce: issued.nonce,
    signature: wallet.sign(issued.message),
  });
  assert.equal(result.ok, true, 'one address, one account, whatever the case');
  assert.equal(result.wallet, wallet.address);
});

test('verify rejects a wrong signature, a wrong wallet and a wrong message', async () => {
  const db = nonceStore();
  const session = createSessionService({ cfg: cfgWith(), db });
  const wallet = newWallet();
  const other = newWallet();

  const a = await session.issueNonce(wallet.address);
  const wrongSig = await session.verify({
    wallet: wallet.address,
    nonce: a.nonce,
    signature: other.sign(a.message),
  });
  assert.equal(wrongSig.ok, false);
  assert.equal(wrongSig.error, 'bad_signature');

  // Same signature, claimed for a wallet that did not make it.
  const b = await session.issueNonce(other.address);
  const wrongWallet = await session.verify({
    wallet: other.address,
    nonce: b.nonce,
    signature: wallet.sign(b.message),
  });
  assert.equal(wrongWallet.ok, false);
  assert.equal(wrongWallet.error, 'bad_signature');

  const c = await session.issueNonce(wallet.address);
  const mismatch = await session.verify({
    wallet: wallet.address,
    nonce: c.nonce,
    signature: wallet.sign(c.message),
    message: 'STOXVAULT\nsomething else entirely',
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error, 'message_mismatch');
  assert.equal(db.rows.size, 1, 'a mismatched message does not burn the nonce');
});

test('a signature collected by another site does not work here', async () => {
  const db = nonceStore();
  const ours = createSessionService({ cfg: cfgWith(), db });
  const wallet = newWallet();

  const issued = await ours.issueNonce(wallet.address);
  // The user signs a message with the SAME nonce, but another site's domain.
  const foreign = buildSignInMessage({
    wallet: wallet.address,
    nonce: issued.nonce,
    issuedAt: issued.issuedAt,
    domain: 'evil.example',
    uri: 'https://evil.example',
  });
  const result = await ours.verify({ wallet: wallet.address, nonce: issued.nonce, signature: wallet.sign(foreign) });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'bad_signature', 'the domain binding is what refuses it');
});

test('an expired nonce is refused before the store is even asked', async () => {
  const db = nonceStore();
  let clock = Date.parse('2026-09-23T12:00:00.000Z');
  const session = createSessionService({ cfg: cfgWith(), db, now: () => clock });
  const wallet = newWallet();

  const issued = await session.issueNonce(wallet.address);
  const signature = wallet.sign(issued.message);

  clock += NONCE_TTL_MS + 1000;
  const result = await session.verify({ wallet: wallet.address, nonce: issued.nonce, signature });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'nonce_expired');
  assert.equal(db.rows.size, 1, 'an expired nonce is not consumed, it just expires');

  const bad = await session.verify({ wallet: wallet.address, nonce: 'not-a-nonce', signature });
  assert.equal(bad.error, 'bad_nonce');

  const badWallet = await session.verify({ wallet: 'nope', nonce: issued.nonce, signature });
  assert.equal(badWallet.error, 'bad_wallet');
});

/* ------------------------------------------------------------------ tokens */

test('session tokens survive a round trip and nothing else', () => {
  const db = nonceStore();
  const session = createSessionService({ cfg: cfgWith('secret-one'), db });
  const wallet = newWallet().address;

  const { token, expiresAt } = session.issueToken(wallet);
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(Date.parse(expiresAt) - Date.now() > SESSION_TTL_MS - 5000);

  const read = session.readToken(token);
  assert.equal(read.wallet, wallet);
  assert.equal(read.expiresAt, expiresAt);

  // A token minted for a lower-case spelling reads back as the one canonical form.
  assert.equal(session.readToken(session.issueToken(wallet.toLowerCase()).token).wallet, wallet);

  const [body, sig] = token.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ v: 2, w: wallet, iat: 1, exp: 99999999999 })).toString('base64url');
  assert.equal(session.readToken(`${forgedPayload}.${sig}`), null, 'payload swap');
  assert.equal(session.readToken(`${body}.${'A'.repeat(sig.length)}`), null, 'signature swap');
  assert.equal(session.readToken(body), null, 'no signature');
  assert.equal(session.readToken(`${body}.${sig}.${sig}`), null, 'extra segment');
  assert.equal(session.readToken(''), null);
  assert.equal(session.readToken(null), null);

  const otherServer = createSessionService({ cfg: cfgWith('secret-two'), db });
  assert.equal(otherServer.readToken(token), null, 'a token from another secret is not ours');
});

test('a session token expires after seven days', () => {
  let clock = Date.parse('2026-09-23T12:00:00.000Z');
  const session = createSessionService({ cfg: cfgWith(), db: nonceStore(), now: () => clock });
  const wallet = newWallet().address;
  const { token } = session.issueToken(wallet);

  clock += SESSION_TTL_MS - 1000;
  assert.equal(session.readToken(token).wallet, wallet);

  clock += 2000;
  assert.equal(session.readToken(token), null);
});

test('requireAuth gates on the Bearer token and sets req.wallet', () => {
  const session = createSessionService({ cfg: cfgWith(), db: nonceStore() });
  const wallet = newWallet().address;
  const { token } = session.issueToken(wallet);

  const res = () => ({
    code: null,
    body: null,
    status(code) {
      this.code = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  });

  let called = 0;
  const req = { headers: { authorization: `Bearer ${token}` } };
  const r1 = res();
  session.requireAuth(req, r1, () => { called += 1; });
  assert.equal(called, 1);
  assert.equal(req.wallet, wallet);
  assert.equal(r1.code, null);

  for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: token }, { authorization: 'Basic abc' }]) {
    const r = res();
    let next = 0;
    session.requireAuth({ headers }, r, () => { next += 1; });
    assert.equal(next, 0, `${JSON.stringify(headers)} should not authenticate`);
    assert.equal(r.code, 401);
    assert.equal(r.body.error, 'unauthorized');
  }

  const optional = { headers: {} };
  let optionalNext = 0;
  session.optionalAuth(optional, res(), () => { optionalNext += 1; });
  assert.equal(optionalNext, 1);
  assert.equal(optional.wallet, undefined);
});

test('the service refuses to run without a session secret', () => {
  assert.throws(() => createSessionService({ cfg: { sessionSecret: '' }, db: nonceStore() }), /sessionSecret/);
  assert.throws(() => createSessionService({ cfg: cfgWith() }), /db is required/);
});

test('the service binds to the configured domain and chain', async () => {
  const db = nonceStore();
  const session = createSessionService({
    cfg: { sessionSecret: 's', authDomain: 'localhost:4800', authUri: 'http://localhost:4800', authChainId: 46630 },
    db,
  });
  const wallet = newWallet();
  const issued = await session.issueNonce(wallet.address);

  assert.ok(issued.message.startsWith('localhost:4800 wants you to sign in'), issued.message);
  assert.ok(issued.message.includes('Chain ID: 46630'), issued.message);
  assert.equal(issued.chainId, 46630);
  assert.equal(session.domain, 'localhost:4800');

  const ok = await session.verify({ wallet: wallet.address, nonce: issued.nonce, signature: wallet.sign(issued.message) });
  assert.equal(ok.ok, true);
});
