// STOCKDROP configuration.
//
// Every environment variable listed in CONTRACT.md section 2 is parsed here, with the
// documented defaults, plus the derived values the rest of the server relies on.
//
// Secrets (vault secret key, session secret, admin key, database url, RPC url with the
// Helius key in it) are attached as NON-ENUMERABLE properties: they are readable as
// `CFG.sessionSecret` but invisible to JSON.stringify, object spread, console.log and
// Object.keys. Nothing here ever logs a secret value.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { log } from './util/log.js';
import { parseDefaultBasket } from './engine/validate.js';

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_ENV_PATH = path.join(SERVER_ROOT, '.env');

export class ConfigError extends Error {
  constructor(message, code = 'config_error') {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ base58 */

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_INDEX = (() => {
  const m = new Map();
  for (let i = 0; i < B58_ALPHABET.length; i++) m.set(B58_ALPHABET[i], i);
  return m;
})();

/** @param {Uint8Array|Buffer|number[]} bytes */
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
  // digits already carries one leading zero digit, hence buf.length - 1
  let zeros = 0;
  while (zeros < buf.length - 1 && buf[zeros] === 0) zeros++;
  return '1'.repeat(zeros) + digits.reverse().map((d) => B58_ALPHABET[d]).join('');
}

/** @param {string} str @returns {Uint8Array} */
export function b58decode(str) {
  if (typeof str !== 'string' || str.length === 0) throw new ConfigError('base58: empty input', 'bad_base58');
  const bytes = [];
  for (const ch of str) {
    const value = B58_INDEX.get(ch);
    if (value === undefined) throw new ConfigError('base58: invalid character', 'bad_base58');
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
    if (ch === '1') leading++;
    else break;
  }
  const out = new Uint8Array(leading + bytes.length);
  out.set(bytes.reverse(), leading);
  return out;
}

/* ------------------------------------------------------- ed25519 derivation */

// PKCS#8 header for a raw ed25519 seed: SEQ { INT 0, SEQ { OID 1.3.101.112 }, OCTET STRING { OCTET STRING (32) } }
const PKCS8_ED25519_HEADER = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * Derive the ed25519 public key from a 32-byte seed using node:crypto only.
 * @param {Uint8Array} seed32
 * @returns {Buffer} 32 raw public key bytes
 */
export function publicKeyFromSeed(seed32) {
  if (seed32.length !== 32) throw new ConfigError('ed25519 seed must be 32 bytes', 'bad_vault_secret');
  const der = Buffer.concat([PKCS8_ED25519_HEADER, Buffer.from(seed32)]);
  const priv = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const spki = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' });
  return Buffer.from(spki.subarray(spki.length - 32));
}

/**
 * Turn a base58 secret key into a vault descriptor. Accepts the 64-byte Solana form
 * (seed || pubkey) or a bare 32-byte seed. With the 64-byte form the embedded public
 * key must match the one derived from the seed, otherwise the file is corrupt.
 * @param {string} secretBase58
 */
export function deriveVault(secretBase58) {
  const raw = b58decode(String(secretBase58).trim());
  if (raw.length !== 64 && raw.length !== 32) {
    throw new ConfigError(`VAULT_SECRET_KEY must decode to 32 or 64 bytes (got ${raw.length})`, 'bad_vault_secret');
  }
  const seed = raw.subarray(0, 32);
  const derived = publicKeyFromSeed(seed);
  if (raw.length === 64) {
    const embedded = Buffer.from(raw.subarray(32));
    if (!crypto.timingSafeEqual(embedded, derived)) {
      throw new ConfigError('VAULT_SECRET_KEY is inconsistent: embedded public key does not match the seed', 'bad_vault_secret');
    }
  }
  const secretKeyBytes = raw.length === 64 ? Uint8Array.from(raw) : Uint8Array.from(Buffer.concat([Buffer.from(seed), derived]));
  const address = b58encode(derived);
  const vault = {};
  Object.defineProperty(vault, 'address', { value: address, enumerable: true });
  Object.defineProperty(vault, 'publicKeyBytes', { value: Uint8Array.from(derived), enumerable: false });
  Object.defineProperty(vault, 'secretKeyBytes', { value: secretKeyBytes, enumerable: false });
  Object.defineProperty(vault, 'secretKey', { value: b58encode(secretKeyBytes), enumerable: false });
  return Object.freeze(vault);
}

/* ---------------------------------------------------------------- env files */

/**
 * Minimal .env parser (no dotenv dependency).
 * Supports `KEY=value`, `export KEY=value`, `#` comments, single/double quoted values
 * (with \n \t \r \" \\ escapes inside double quotes) and trailing ` # comment` on
 * unquoted values.
 * @param {string} text
 * @returns {Record<string,string>}
 */
export function parseEnvFile(text) {
  const out = {};
  if (typeof text !== 'string') return out;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment);
      value = value.trim();
    }
    out[key] = value;
  }
  return out;
}

/** Read and parse an env file; missing file is not an error. */
export function readEnvFile(filePath = DEFAULT_ENV_PATH) {
  try {
    return parseEnvFile(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'EACCES')) return {};
    throw err;
  }
}

/* ------------------------------------------------------------- value parsing */

function str(env, key, fallback = '') {
  const v = env[key];
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim();
  return s === '' ? fallback : s;
}

function bool(env, key, fallback = false) {
  const v = str(env, key, '');
  if (v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

function int(env, key, fallback) {
  const v = str(env, key, '');
  if (v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function num(env, key, fallback) {
  const v = str(env, key, '');
  if (v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(value, min, max, fallback) {
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

function expandExponential(s) {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(s);
  if (!m) return s;
  const sign = m[1] === '-' ? '-' : '';
  const digits = (m[2] || '0') + (m[3] || '');
  const pointPos = (m[2] || '0').length + Number.parseInt(m[4], 10);
  if (pointPos <= 0) return `${sign}0.${'0'.repeat(-pointPos)}${digits}`;
  if (pointPos >= digits.length) return sign + digits + '0'.repeat(pointPos - digits.length);
  return `${sign}${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
}

/**
 * Decimal ui amount -> base units, exactly (no floats).
 * @param {string|number} value @param {number} decimals @returns {bigint}
 */
export function uiToRaw(value, decimals) {
  let s = typeof value === 'string' ? value.trim() : String(value);
  if (s === '') s = '0';
  if (/[eE]/.test(s)) s = expandExponential(s);
  let sign = 1n;
  if (s.startsWith('-')) {
    sign = -1n;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d*(?:\.\d*)?$/.test(s) || s === '' || s === '.') {
    throw new ConfigError(`not a decimal number: ${JSON.stringify(String(value))}`, 'bad_number');
  }
  const [intPart, fracPart = ''] = s.split('.');
  const frac = (fracPart + '0'.repeat(decimals)).slice(0, decimals);
  return sign * BigInt((intPart || '0') + frac);
}

/** SOL (ui) -> lamports, exactly. */
export function solToLamports(sol) {
  return uiToRaw(sol, 9);
}

/* ------------------------------------------------------------- round timing */

/**
 * Next round mark strictly after `now`, aligned to UTC midnight in `intervalHours`
 * steps (6h -> 00:00 / 06:00 / 12:00 / 18:00 UTC). Never steps past the next UTC
 * midnight, so intervals that do not divide 24 restart cleanly each day.
 * @param {number} intervalHours
 * @param {Date|number} [now]
 * @returns {Date}
 */
export function nextRoundAtFor(intervalHours, now = Date.now()) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(t)) throw new ConfigError('nextRoundAt: invalid time', 'bad_time');
  const d = new Date(t);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const step = intervalHours * 3600_000;
  const nextDay = dayStart + 86_400_000;
  const mark = dayStart + (Math.floor((t - dayStart) / step) + 1) * step;
  return new Date(Math.min(mark, nextDay));
}

/* ------------------------------------------------------------------- package */

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
const VERSION = readVersion();

/* -------------------------------------------------------------- buildConfig */

/**
 * Build a frozen config object from a plain environment map. Pure: it does not read
 * process.env or any .env file (use loadConfig for that) and it does not log.
 * @param {Record<string,string|undefined>} env
 * @param {{root?: string, now?: () => number}} [opts]
 */
export function buildConfig(env = {}, opts = {}) {
  const root = opts.root || SERVER_ROOT;

  const port = clampInt(int(env, 'PORT', 4700), 1, 65535, 4700);
  const live = bool(env, 'LIVE', false);

  const heliusApiKey = str(env, 'HELIUS_API_KEY', '');
  const baseRpcUrl = str(env, 'RPC_URL', 'https://api.mainnet-beta.solana.com');
  const rpcUrl = heliusApiKey ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(heliusApiKey)}` : baseRpcUrl;
  const rpcProvider = heliusApiKey ? 'helius' : 'rpc';

  const databaseUrl = str(env, 'DATABASE_URL', '');
  const dataDirRaw = str(env, 'DATA_DIR', './data/state');
  const dataDir = path.isAbsolute(dataDirRaw) ? path.normalize(dataDirRaw) : path.resolve(root, dataDirRaw);
  const storeKind = databaseUrl ? 'pg' : 'json';

  const vaultSecretKey = str(env, 'VAULT_SECRET_KEY', '');
  const vaultAddressEnv = str(env, 'VAULT_ADDRESS', '');
  let vault = null;
  if (vaultSecretKey) {
    vault = deriveVault(vaultSecretKey);
    if (vaultAddressEnv && vaultAddressEnv !== vault.address) {
      throw new ConfigError(
        `VAULT_ADDRESS (${vaultAddressEnv}) does not match the address derived from VAULT_SECRET_KEY (${vault.address})`,
        'vault_address_mismatch',
      );
    }
  }
  const vaultAddress = vault ? vault.address : vaultAddressEnv || null;

  const mode = !vault ? 'READ_ONLY' : live ? 'LIVE' : 'DRY_RUN';

  const tokenMint = str(env, 'TOKEN_MINT', '');
  const tokenName = str(env, 'TOKEN_NAME', '');
  const tokenSymbol = str(env, 'TOKEN_SYMBOL', '');
  const tokenDecimals = clampInt(int(env, 'TOKEN_DECIMALS', 6), 0, 18, 6);
  const tokenSupplyUi = str(env, 'TOKEN_SUPPLY', '1000000000');
  const supplyRawBig = uiToRaw(tokenSupplyUi, tokenDecimals);
  const eligibleBps = clampInt(int(env, 'ELIGIBLE_BPS', 10), 0, 10000, 10);
  const eligibleThresholdBig = (supplyRawBig * BigInt(eligibleBps)) / 10000n;

  const excludedEnv = str(env, 'EXCLUDED_WALLETS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const excluded = [];
  for (const w of [...excludedEnv, ...(vaultAddress ? [vaultAddress] : [])]) {
    if (!excluded.includes(w)) excluded.push(w);
  }

  const intervalHours = clampInt(int(env, 'ROUND_INTERVAL_HOURS', 6), 1, 24, 6);
  const roundJitterMin = Math.max(0, clampInt(int(env, 'ROUND_JITTER_MIN', 10), 0, 60 * intervalHours, 10));
  const minRoundPoolSol = Math.max(0, num(env, 'MIN_ROUND_POOL_SOL', 0.5));
  const feeReserveSol = Math.max(0, num(env, 'FEE_RESERVE_SOL', 0.05));
  const universeSize = clampInt(int(env, 'UNIVERSE_SIZE', 20), 1, 100, 20);
  const defaultBasketSize = clampInt(int(env, 'DEFAULT_BASKET_SIZE', 5), 1, universeSize, 5);
  // What a holder who never set preferences receives. Either an explicit
  // allocation by ticker ("SPCXx:100", "NVDAx:60,TSLAx:40") or blank for the
  // top `defaultBasketSize` split evenly. An explicit basket is resolved against
  // the live universe each round, so a ticker that drops out is not bought
  // anyway. Named tickers also cost far less to deliver: every stock a holder
  // receives needs its own token account, and the project pays that rent
  // (~0.002137 SOL each, measured on chain), so a one-stock default is five
  // times cheaper per holder than a five-stock one.
  const defaultBasketRaw = str(env, 'DEFAULT_BASKET', '');
  const defaultBasket = defaultBasketRaw === '' ? null : defaultBasketRaw;
  const defaultBasketValid = defaultBasket === null || parseDefaultBasket(defaultBasket) !== null;
  const liqMinUsd = Math.max(0, num(env, 'LIQ_MIN_USD', 50000));
  const slippageBps = clampInt(int(env, 'SLIPPAGE_BPS', 100), 1, 10000, 100);
  const priorityFeeLamports = Math.max(0, int(env, 'PRIORITY_FEE_LAMPORTS', 200000));

  const adminKey = str(env, 'ADMIN_KEY', '');
  const sessionSecretEnv = str(env, 'SESSION_SECRET', '');
  const sessionSecret = sessionSecretEnv || crypto.randomBytes(32).toString('hex');
  const sessionSecretIsEphemeral = !sessionSecretEnv;
  const corsOrigin = str(env, 'CORS_ORIGIN', '*');
  const jupBase = str(env, 'JUP_BASE', 'https://lite-api.jup.ag').replace(/\/+$/, '');

  const rules = Object.freeze({
    minPicks: 2,
    maxPicks: 5,
    minPct: 10,
    maxPct: 60,
    eligibleBps,
    intervalHours,
    universeSize,
    defaultBasketSize,
    defaultBasket,
  });

  const cfg = {
    version: VERSION,
    root,
    port,
    live,
    mode,

    rpcProvider,
    hasHeliusKey: Boolean(heliusApiKey),

    storeKind,
    dataDir,

    vaultAddress,
    vault,

    tokenMint,
    tokenName,
    tokenSymbol,
    tokenDecimals,
    tokenSupplyUi,
    launched: Boolean(tokenMint),
    supplyRaw: supplyRawBig.toString(),
    eligibleBps,
    eligibleThresholdRaw: eligibleThresholdBig.toString(),
    eligibleThresholdUi: Number(eligibleThresholdBig) / 10 ** tokenDecimals,
    excluded,

    intervalHours,
    roundJitterMin,
    minRoundPoolSol,
    minRoundPoolLamports: solToLamports(minRoundPoolSol).toString(),
    feeReserveSol,
    feeReserveLamports: solToLamports(feeReserveSol).toString(),

    universeSize,
    defaultBasketSize,
    defaultBasket,
    defaultBasketValid,
    liqMinUsd,
    slippageBps,
    priorityFeeLamports,

    hasAdminKey: Boolean(adminKey),
    sessionSecretIsEphemeral,
    corsOrigin,
    jupBase,

    rules,
    lamportsPerSol: LAMPORTS_PER_SOL,

    /** @param {Date|number} [now] @returns {Date} */
    nextRoundAt(now) {
      return nextRoundAtFor(intervalHours, now === undefined ? Date.now() : now);
    },
    /** @param {Date|number} [now] @returns {string} ISO */
    nextRoundAtIso(now) {
      return nextRoundAtFor(intervalHours, now === undefined ? Date.now() : now).toISOString();
    },
    /** One-line, secret-free description of this process. */
    bootSummary() {
      return [
        `mode=${mode}`,
        `vault=${vaultAddress || 'none (read-only)'}`,
        `token=${tokenMint || 'not launched'}`,
        `store=${storeKind === 'pg' ? 'postgres' : `json ${dataDir}`}`,
        `rpc=${rpcProvider}`,
        `port=${port}`,
        `v${VERSION}`,
      ].join(' ');
    },
    /** Secret-free object safe to serve from /api/admin/status. */
    safeSummary() {
      return {
        version: VERSION,
        mode,
        live,
        port,
        rpcProvider,
        storeKind,
        dataDir: storeKind === 'json' ? dataDir : null,
        vaultAddress,
        token: {
          mint: tokenMint || null,
          name: tokenName || null,
          symbol: tokenSymbol || null,
          decimals: tokenDecimals,
          supplyUi: tokenSupplyUi,
          supplyRaw: supplyRawBig.toString(),
          launched: Boolean(tokenMint),
        },
        eligibleBps,
        eligibleThresholdRaw: eligibleThresholdBig.toString(),
        excluded,
        intervalHours,
        roundJitterMin,
        minRoundPoolSol,
        feeReserveSol,
        universeSize,
        defaultBasketSize,
        defaultBasket,
        liqMinUsd,
        slippageBps,
        priorityFeeLamports,
        hasAdminKey: Boolean(adminKey),
        hasHeliusKey: Boolean(heliusApiKey),
        sessionSecretIsEphemeral,
        corsOrigin,
        jupBase,
      };
    },
  };

  // Secrets: readable by name, invisible to spread / JSON / console.
  const hidden = {
    rpcUrl,
    heliusApiKey,
    databaseUrl,
    vaultSecretKey,
    adminKey,
    sessionSecret,
  };
  for (const [key, value] of Object.entries(hidden)) {
    Object.defineProperty(cfg, key, { value, enumerable: false, writable: false, configurable: false });
  }

  return Object.freeze(cfg);
}

/**
 * Build the config from `server/.env` + process.env (process.env wins) and log a
 * one-line boot summary. Never logs a secret value.
 * @param {{envPath?: string|null, env?: Record<string,string|undefined>, quiet?: boolean, root?: string}} [opts]
 */
export function loadConfig(opts = {}) {
  const processEnv = opts.env || process.env;
  const fileEnv = opts.envPath === null ? {} : readEnvFile(opts.envPath || DEFAULT_ENV_PATH);
  const merged = { ...fileEnv };
  for (const key of Object.keys(processEnv)) {
    if (processEnv[key] !== undefined) merged[key] = processEnv[key];
  }
  const cfg = buildConfig(merged, { root: opts.root });
  const quiet = opts.quiet ?? (String(processEnv.STOCKDROP_QUIET || '') === '1');
  if (!quiet) {
    log.info('stockdrop', cfg.bootSummary());
    if (cfg.sessionSecretIsEphemeral) {
      log.warn('SESSION_SECRET is not set: sessions are signed with a random per-boot key and will not survive a restart.');
    }
    if (cfg.mode === 'READ_ONLY') {
      log.warn('VAULT_SECRET_KEY is not set: running READ_ONLY, the keeper will not run.');
    }
    if (!cfg.launched) {
      log.info('TOKEN_MINT is blank: the coin is not launched, rounds will be SKIPPED with reason no_token.');
    }
    // A malformed DEFAULT_BASKET silently becomes the top-N basket, which sends
    // real money somewhere the operator did not choose. Say so loudly.
    if (!cfg.defaultBasketValid) {
      log.warn(
        `DEFAULT_BASKET="${cfg.defaultBasket}" is not valid (expect TICKER:PCT entries totalling exactly 100, e.g. "SPCXx:100"). ` +
        `Holders with no picks will receive the top ${cfg.defaultBasketSize} instead.`,
      );
    } else if (cfg.defaultBasket) {
      log.info(`default basket for holders with no picks: ${cfg.defaultBasket}`);
    }
  }
  return cfg;
}

export const CFG = loadConfig();
export default CFG;
