/**
 * STOCKDROP chain / vault keypair
 *
 * The one place in the process that turns the secret into a signer.
 *
 * Rules, without exception:
 *   - the secret is never logged, never returned in an error message, never
 *     attached to an object that could be JSON.stringify'd into a response;
 *   - READ_ONLY (no VAULT_SECRET_KEY) returns null, and the keeper simply does
 *     not run — it never guesses, never generates a key, never falls back;
 *   - if VAULT_ADDRESS is also set it must match the address derived from the
 *     secret, otherwise we refuse to start: a mismatch means the operator is
 *     one copy-paste away from sending stock to a wallet nobody controls.
 *
 * Accepts both shapes an operator plausibly has on disk: a base58 string (the
 * Phantom / solana-keygen export, 64 bytes or a bare 32-byte seed) and a JSON
 * array of 64 numbers (the `~/.config/solana/id.json` shape). No bs58 package:
 * base58 is 30 lines and a dependency here is a supply-chain hole aimed at the
 * exact byte string we most need to protect.
 */

import { Keypair, PublicKey } from '@solana/web3.js';

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_INDEX = (() => {
  const map = new Map();
  for (let i = 0; i < B58_ALPHABET.length; i++) map.set(B58_ALPHABET[i], i);
  return map;
})();

export class VaultError extends Error {
  constructor(message, code = 'vault_error') {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

/** base58 -> bytes. Throws VaultError on an invalid character (never echoes the input). */
export function b58decode(str) {
  if (typeof str !== 'string' || str.length === 0) throw new VaultError('base58: empty input', 'bad_base58');
  const bytes = [];
  for (const ch of str) {
    const value = B58_INDEX.get(ch);
    if (value === undefined) throw new VaultError('base58: invalid character in input', 'bad_base58');
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
  let leading = 0;
  for (const ch of str) {
    if (ch === '1') leading += 1;
    else break;
  }
  const out = new Uint8Array(leading + bytes.length);
  out.set(bytes.reverse(), leading);
  return out;
}

/** bytes -> base58. */
export function b58encode(bytes) {
  const buf = Uint8Array.from(bytes);
  if (buf.length === 0) return '';
  const digits = [0];
  for (const byte of buf) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      const x = (digits[i] << 8) + carry;
      digits[i] = x % 58;
      carry = (x / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let zeros = 0;
  while (zeros < buf.length - 1 && buf[zeros] === 0) zeros += 1;
  return '1'.repeat(zeros) + digits.reverse().map((d) => B58_ALPHABET[d]).join('');
}

/** True for a string that could be a Solana address (32 bytes of base58). */
export function isAddress(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return false;
  try {
    return b58decode(value).length === 32;
  } catch {
    return false;
  }
}

/**
 * Secret material -> 64 raw bytes, accepting:
 *   - base58 of 64 bytes (secret || public)
 *   - base58 of a 32-byte seed
 *   - JSON array of 64 (or 32) numbers
 * Never includes the input in an error.
 * @returns {{ bytes: Uint8Array, kind: 'base58'|'json', length: number }}
 */
export function parseSecretKey(secret) {
  if (secret instanceof Uint8Array) return { bytes: Uint8Array.from(secret), kind: 'bytes', length: secret.length };
  if (Array.isArray(secret)) {
    const bytes = Uint8Array.from(secret.map((n) => Number(n)));
    if (bytes.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      throw new VaultError('VAULT_SECRET_KEY json array contains a non-byte value', 'bad_vault_secret');
    }
    return { bytes, kind: 'json', length: bytes.length };
  }
  if (typeof secret !== 'string') throw new VaultError('VAULT_SECRET_KEY must be a base58 string or a json byte array', 'bad_vault_secret');

  const trimmed = secret.trim();
  if (trimmed === '') throw new VaultError('VAULT_SECRET_KEY is empty', 'bad_vault_secret');

  if (trimmed.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new VaultError('VAULT_SECRET_KEY looks like a json array but does not parse', 'bad_vault_secret');
    }
    if (!Array.isArray(parsed)) throw new VaultError('VAULT_SECRET_KEY json is not an array', 'bad_vault_secret');
    return parseSecretKey(parsed);
  }

  const bytes = b58decode(trimmed);
  return { bytes, kind: 'base58', length: bytes.length };
}

/**
 * Build a web3.js Keypair from any accepted secret shape.
 * @returns {Keypair}
 */
export function keypairFromSecret(secret) {
  const { bytes, length } = parseSecretKey(secret);
  if (length === 64) return Keypair.fromSecretKey(bytes, { skipValidation: false });
  if (length === 32) return Keypair.fromSeed(bytes);
  throw new VaultError(`VAULT_SECRET_KEY must decode to 32 or 64 bytes (got ${length})`, 'bad_vault_secret');
}

/**
 * loadVault(cfg) -> Keypair | null
 *
 * null in READ_ONLY (no secret configured). Throws when a secret is present but
 * unusable, or when it disagrees with VAULT_ADDRESS — a broken key must stop the
 * process, not degrade it into a mode where rounds silently do nothing.
 *
 * `cfg.vaultSecretKey` is the non-enumerable property config.js parked the raw
 * value on; `cfg.vault?.secretKeyBytes` is the already-validated byte form.
 *
 * @param {{mode?: string, vaultSecretKey?: string, vaultAddress?: string|null, vault?: {secretKeyBytes?: Uint8Array}}} cfg
 * @returns {Keypair|null}
 */
export function loadVault(cfg = {}) {
  const secret = cfg.vault?.secretKeyBytes || cfg.vaultSecretKey || '';
  if (!secret || (typeof secret === 'string' && secret.trim() === '')) return null;
  if (cfg.mode === 'READ_ONLY') return null;

  const keypair = keypairFromSecret(secret);
  const address = keypair.publicKey.toBase58();

  if (cfg.vaultAddress && cfg.vaultAddress !== address) {
    throw new VaultError(
      `VAULT_ADDRESS (${cfg.vaultAddress}) does not match the address derived from VAULT_SECRET_KEY (${address})`,
      'vault_address_mismatch',
    );
  }
  return keypair;
}

/**
 * The vault's public key without touching the secret: from VAULT_ADDRESS when
 * that is all we have, from the secret otherwise. Safe to call anywhere.
 * @returns {PublicKey|null}
 */
export function vaultPublicKey(cfg = {}) {
  if (cfg.vaultAddress) {
    try {
      return new PublicKey(cfg.vaultAddress);
    } catch {
      throw new VaultError(`VAULT_ADDRESS is not a valid public key: ${cfg.vaultAddress}`, 'bad_vault_address');
    }
  }
  const keypair = loadVault(cfg);
  return keypair ? keypair.publicKey : null;
}

/** A one-line, secret-free description for logs. */
export function describeVault(cfg = {}) {
  const address = cfg.vaultAddress || (cfg.vault?.address ?? null);
  if (!address) return 'vault: none (read-only)';
  const signer = Boolean(cfg.vault?.secretKeyBytes || cfg.vaultSecretKey);
  return `vault: ${address}${signer ? ' (signer loaded)' : ' (address only, read-only)'}`;
}

export default loadVault;
