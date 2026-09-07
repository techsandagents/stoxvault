// Sign-in: the message text, ed25519 verification, single-use nonces, session tokens.
//
// These tests generate a real ed25519 key with node:crypto and sign with it, so
// what is exercised here is the same code path a Phantom signature takes.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  NONCE_TTL_MS,
  SESSION_TTL_MS,
  b58decode,
  b58encode,
  buildSignInMessage,
  createSessionService,
  decodeSignature,
  isWallet,
  mintNonce,
  nonceIssuedAt,
  verifySignature,
} from '../src/services/session.js';

const VAULT_ADDRESS = '769fv6KK6SAQ5FBAXdUZLdrppdHn5CqqgJBpFCLyf9up';

/** A throwaway wallet backed by a real ed25519 key. */
function newWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const raw = Buffer.from(spki.subarray(spki.length - 32));
  return {
    address: b58encode(raw),
    privateKey,
    sign: (message) => crypto.sign(null, Buffer.from(message, 'utf8'), privateKey),
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

/* ------------------------------------------------------------------ base58 */

test('base58 round-trips and rejects non-base58', () => {
  assert.equal(b58encode(Uint8Array.of(0)), '1');
  assert.equal(b58encode(Uint8Array.of(0, 0, 1)), '112');
  assert.deepEqual([...b58decode('1')], [0]);

  for (let i = 0; i < 50; i++) {
    const bytes = crypto.randomBytes(32);
    const encoded = b58encode(bytes);
    assert.deepEqual(Buffer.from(b58decode(encoded)), bytes, `round trip failed for ${encoded}`);
  }

  assert.equal(b58decode('0OIl'), null, '0 O I l are not in the base58 alphabet');
  assert.equal(b58decode(''), null);
  assert.equal(b58decode(42), null);
});

test('isWallet accepts real addresses and nothing else', () => {
  assert.equal(isWallet(VAULT_ADDRESS), true);
  assert.equal(b58decode(VAULT_ADDRESS).length, 32);
  assert.equal(isWallet(newWallet().address), true);
  assert.equal(isWallet('not-a-wallet'), false);
  assert.equal(isWallet(''), false);
  assert.equal(isWallet(null), false);
  assert.equal(isWallet(`${VAULT_ADDRESS}xxxxxxxxxxxx`), false);
  assert.equal(isWallet(b58encode(crypto.randomBytes(31))), false, '31 bytes is not an address');
});

/* ----------------------------------------------------------------- message */

test('the sign-in message is exactly the six contract lines', () => {
  const message = buildSignInMessage({
    wallet: VAULT_ADDRESS,
    nonce: 'abc123',
    issuedAt: '2026-09-07T12:00:00.000Z',
  });

  assert.equal(
    message,
    'STOCKDROP\n'
      + 'Sign to verify you own this wallet.\n'
      + 'This is not a transaction. Nothing leaves your wallet.\n'
      + `Wallet: ${VAULT_ADDRESS}\n`
      + 'Nonce: abc123\n'
      + 'Issued: 2026-09-07T12:00:00.000Z',
  );
  assert.equal(message.split('\n').length, 6);
});

test('a nonce carries its own issue time', () => {
  const at = 1_757_246_400_000;
  const nonce = mintNonce(at);
  assert.equal(nonceIssuedAt(nonce), at);
  assert.equal(nonceIssuedAt('garbage'), null);
  assert.equal(nonceIssuedAt(''), null);
  assert.equal(nonceIssuedAt(null), null);
  assert.notEqual(mintNonce(at), mintNonce(at), 'nonces are random, not just timestamps');
});

/* --------------------------------------------------------------- signature */

test('verifySignature accepts base58 and base64, rejects everything else', () => {
  const wallet = newWallet();
  const message = buildSignInMessage({ wallet: wallet.address, nonce: 'n1', issuedAt: new Date().toISOString() });
  const sig = wallet.sign(message);

  assert.equal(verifySignature({ wallet: wallet.address, message, signature: b58encode(sig) }), true);
  assert.equal(verifySignature({ wallet: wallet.address, message, signature: sig.toString('base64') }), true);
  assert.equal(verifySignature({ wallet: wallet.address, message, signature: sig.toString('base64url') }), true);

  assert.equal(verifySignature({ wallet: wallet.address, message: `${message} `, signature: b58encode(sig) }), false, 'tampered message');
  assert.equal(verifySignature({ wallet: newWallet().address, message, signature: b58encode(sig) }), false, 'wrong wallet');
  assert.equal(verifySignature({ wallet: wallet.address, message, signature: 'not-a-signature' }), false);
  assert.equal(verifySignature({ wallet: wallet.address, message, signature: b58encode(crypto.randomBytes(64)) }), false);
  assert.equal(verifySignature({ wallet: 'nope', message, signature: b58encode(sig) }), false);

  // Both encodings of the same signature decode to the same 64 bytes.
  assert.deepEqual(decodeSignature(b58encode(sig)), sig);
  assert.deepEqual(decodeSignature(sig.toString('base64')), sig);
  assert.equal(decodeSignature(b58encode(crypto.randomBytes(32))), null, 'a 32-byte value is not a signature');
  assert.equal(decodeSignature('!!!'), null);
  assert.equal(decodeSignature('a'.repeat(500)), null, 'absurd lengths are refused outright');
});

/* ------------------------------------------------------------ nonce + flow */

test('a nonce signs in once and only once', async () => {
  const db = nonceStore();
  const session = createSessionService({ cfg: cfgWith(), db });
  const wallet = newWallet();

  const issued = await session.issueNonce(wallet.address);
  assert.equal(issued.message, buildSignInMessage({ wallet: wallet.address, nonce: issued.nonce, issuedAt: issued.issuedAt }));
  assert.equal(Date.parse(issued.expiresAt) - Date.parse(issued.issuedAt), NONCE_TTL_MS);

  const signature = b58encode(wallet.sign(issued.message));
  const first = await session.verify({ wallet: wallet.address, nonce: issued.nonce, signature });
  assert.equal(first.ok, true);

  const second = await session.verify({ wallet: wallet.address, nonce: issued.nonce, signature });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'bad_nonce');
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
    signature: b58encode(other.sign(a.message)),
  });
  assert.equal(wrongSig.ok, false);
  assert.equal(wrongSig.error, 'bad_signature');

  // Same signature, claimed for a wallet that did not make it.
  const b = await session.issueNonce(other.address);
  const wrongWallet = await session.verify({
    wallet: other.address,
    nonce: b.nonce,
    signature: b58encode(wallet.sign(b.message)),
  });
  assert.equal(wrongWallet.ok, false);
  assert.equal(wrongWallet.error, 'bad_signature');

  const c = await session.issueNonce(wallet.address);
  const mismatch = await session.verify({
    wallet: wallet.address,
    nonce: c.nonce,
    signature: b58encode(wallet.sign(c.message)),
    message: 'STOCKDROP\nsomething else entirely',
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error, 'message_mismatch');
  assert.equal(db.rows.size, 1, 'a mismatched message does not burn the nonce');
});

test('an expired nonce is refused before the store is even asked', async () => {
  const db = nonceStore();
  let clock = Date.parse('2026-09-07T12:00:00.000Z');
  const session = createSessionService({ cfg: cfgWith(), db, now: () => clock });
  const wallet = newWallet();

  const issued = await session.issueNonce(wallet.address);
  const signature = b58encode(wallet.sign(issued.message));

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

  const [body, sig] = token.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ v: 1, w: wallet, iat: 1, exp: 99999999999 })).toString('base64url');
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
  let clock = Date.parse('2026-09-07T12:00:00.000Z');
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
