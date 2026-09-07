// Tiny leveled logger. No dependencies, no config import (config imports this).
//
// Every value that reaches a log line goes through redact() first: anything that
// looks like a base58 secret (>= 80 chars, e.g. a 64-byte Solana keypair encodes
// to 87-88 chars) is replaced, and object keys whose name smells like a credential
// have their values replaced. The vault secret must never reach stdout.

import util from 'node:util';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const DEFAULT_LEVEL = 'info';

function parseLevel(name, fallback) {
  if (typeof name !== 'string') return fallback;
  const key = name.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, key) ? LEVELS[key] : fallback;
}

let currentLevel = parseLevel(process.env.LOG_LEVEL, LEVELS[DEFAULT_LEVEL]);

export function setLevel(name) {
  currentLevel = parseLevel(name, currentLevel);
  return levelName();
}

export function levelName() {
  for (const [name, value] of Object.entries(LEVELS)) if (value === currentLevel) return name;
  return DEFAULT_LEVEL;
}

// 80+ base58 characters in a row is a private key, never an address (32 bytes -> 43-44 chars).
const SECRET_LIKE = /[1-9A-HJ-NP-Za-km-z]{80,}/g;
const SECRET_KEY_NAME = /(secret|private|passwd|password|api[-_]?key|apikey|authorization|bearer|session[-_]?secret|admin[-_]?key|mnemonic|seed)/i;
const REDACTED = '[redacted]';

function redactString(s) {
  return s.replace(SECRET_LIKE, REDACTED);
}

/**
 * Deep-redact a value for logging.
 * - strings: base58 secrets stripped
 * - objects/arrays: cloned, credential-ish keys replaced, strings stripped
 * - everything else: returned unchanged
 */
export function redact(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    const err = new Error(redactString(value.message));
    err.name = value.name;
    if (value.code !== undefined) err.code = value.code;
    err.stack = typeof value.stack === 'string' ? redactString(value.stack) : value.stack;
    return err;
  }
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, seen));
  if (value instanceof Map) {
    const out = {};
    for (const [k, v] of value) out[String(k)] = SECRET_KEY_NAME.test(String(k)) ? REDACTED : redact(v, seen);
    return out;
  }
  if (value instanceof Set) return [...value].map((v) => redact(v, seen));
  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = SECRET_KEY_NAME.test(key) ? REDACTED : redact(value[key], seen);
  }
  return out;
}

function render(arg) {
  if (typeof arg === 'string') return redactString(arg);
  if (arg instanceof Error) {
    const safe = redact(arg);
    return safe.stack || `${safe.name}: ${safe.message}`;
  }
  return util.inspect(redact(arg), { depth: 4, breakLength: Infinity, colors: false });
}

function emit(level, scope, args) {
  if (LEVELS[level] < currentLevel) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${scope ? `[${scope}] ` : ''}${args.map(render).join(' ')}\n`;
  if (level === 'error' || level === 'warn') process.stderr.write(line);
  else process.stdout.write(line);
}

export function createLogger(scope = '') {
  const logger = {
    scope,
    debug: (...args) => emit('debug', scope, args),
    info: (...args) => emit('info', scope, args),
    warn: (...args) => emit('warn', scope, args),
    error: (...args) => emit('error', scope, args),
    child: (childScope) => createLogger(scope ? `${scope}:${childScope}` : childScope),
  };
  return logger;
}

export const log = createLogger();
export default log;
