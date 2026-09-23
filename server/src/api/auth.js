/**
 * STOXVAULT — wallet sign-in.
 *
 * Two calls, no transaction, no gas, no approval:
 *   POST /api/auth/nonce   -> the exact text to sign (EIP-4361)
 *   POST /api/auth/verify  -> a 7-day session token
 *
 * The message says in plain English that it is not a transaction, because a
 * wallet popup is exactly where users get robbed. Nothing in this project ever
 * asks for eth_sendTransaction, a token approval, or typed data that moves value.
 *
 * The wallet is a Robinhood Wallet EVM address. The signature is EIP-191
 * personal_sign and is verified in services/session.js.
 */

import express from 'express';
import { wrap, requireWallet, badRequest } from './router.js';
import { buildMe } from './me.js';

// A nonce is a database write, so one wallet cannot be used to hammer the store.
const NONCE_WINDOW_MS = 60_000;
const NONCE_MAX_PER_WINDOW = 30;

const STATUS_BY_ERROR = {
  bad_wallet: 400,
  bad_nonce: 400,
  nonce_expired: 400,
  message_mismatch: 400,
  bad_signature: 401,
};

export function createAuthRouter({ cfg, db, services }) {
  const router = express.Router();
  const { session } = services;
  const recent = new Map(); // wallet -> {count, since}

  function throttled(wallet) {
    const now = Date.now();
    const entry = recent.get(wallet);
    if (!entry || now - entry.since > NONCE_WINDOW_MS) {
      recent.set(wallet, { count: 1, since: now });
      if (recent.size > 5000) {
        for (const [key, value] of recent) if (now - value.since > NONCE_WINDOW_MS) recent.delete(key);
      }
      return false;
    }
    entry.count += 1;
    return entry.count > NONCE_MAX_PER_WINDOW;
  }

  router.post(
    '/nonce',
    wrap(async (req, res) => {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('bad_request', 'body must be a JSON object');
      const wallet = requireWallet(body.wallet);

      if (throttled(wallet)) {
        return res.status(429).json({ error: 'rate_limited', detail: 'too many sign-in attempts, wait a minute' });
      }

      const { nonce, message, issuedAt, expiresAt } = await session.issueNonce(wallet);
      // chainId / domain travel with the challenge so the browser can check it
      // is signing for the chain and the site it thinks it is, without ever
      // rebuilding the text itself.
      res.json({
        wallet,
        nonce,
        message,
        issuedAt,
        expiresAt,
        chainId: session.chainId,
        chainName: cfg.authChainName,
        domain: session.domain,
        uri: session.uri,
      });
    }),
  );

  router.post(
    '/verify',
    wrap(async (req, res) => {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('bad_request', 'body must be a JSON object');
      const wallet = requireWallet(body.wallet);

      const nonce = typeof body.nonce === 'string' ? body.nonce.trim() : '';
      if (nonce === '' || nonce.length > 64) throw badRequest('bad_nonce', 'nonce is missing or malformed');

      const signature = typeof body.signature === 'string' ? body.signature.trim() : '';
      if (signature === '') throw badRequest('bad_signature', 'signature is required');
      if (signature.length > 200) throw badRequest('bad_signature', 'signature is not a 65-byte personal_sign signature');

      const message = body.message === undefined || body.message === null ? undefined : String(body.message);

      const result = await session.verify({ wallet, nonce, signature, message });
      if (!result.ok) {
        return res.status(STATUS_BY_ERROR[result.error] ?? 400).json({ error: result.error, detail: result.detail });
      }

      const { token, expiresAt } = session.issueToken(wallet);
      const me = await buildMe({ cfg, db, services, wallet });
      res.json({ token, wallet, expiresAt, me });
    }),
  );

  return router;
}

export default createAuthRouter;
