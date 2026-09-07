/**
 * STOCKDROP chain / JSON-RPC client
 *
 * A thin, dependency-free client over cfg.rpcUrl. web3.js ships its own
 * Connection, but it hides retry policy, swallows the HTTP status behind
 * generic errors, and makes the keeper hard to test without a socket. The
 * keeper needs to know the difference between "the node is rate limiting us"
 * (retry) and "this transaction is invalid" (never retry), so it speaks
 * JSON-RPC directly.
 *
 * Every method:
 *   - has an AbortSignal timeout,
 *   - retries with exponential backoff on 429 / 5xx / network faults only,
 *   - returns base-unit amounts as BigInt, never as floats.
 *
 * The RPC url may embed a Helius api key, so it is never logged: errors carry
 * the method name and the HTTP status, never the endpoint.
 */

import { setTimeout as delay } from 'node:timers/promises';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** JSON-RPC / transport failure. `retryable` says whether another attempt could help. */
export class RpcError extends Error {
  constructor(message, { code = 'rpc_error', status = null, method = null, retryable = false, retryAfterMs = null, cause = null } = {}) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.status = status;
    this.method = method;
    this.retryable = retryable;
    /** Server-requested wait before the next attempt (from Retry-After), in ms. */
    this.retryAfterMs = retryAfterMs;
    if (cause) this.cause = cause;
  }
}

/**
 * Solana JSON-RPC error codes that mean "try again", not "this is wrong".
 * -32005 node is behind / too many requests, -32004 block not available,
 * -32014 block status not yet available, -32002 tx simulation failed on a
 * stale bank (rare, but retrying with a fresh blockhash is the fix).
 */
const RETRYABLE_RPC_CODES = new Set([-32005, -32004, -32014]);

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function toBase64(raw) {
  if (typeof raw === 'string') return raw; // already base64
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString('base64');
  if (Array.isArray(raw)) return Buffer.from(Uint8Array.from(raw)).toString('base64');
  if (Buffer.isBuffer(raw)) return raw.toString('base64');
  throw new RpcError('sendRawTransaction expects bytes or a base64 string', { code: 'bad_argument' });
}

/** Parse Retry-After (seconds, or an HTTP date). Returns ms, or null. */
function retryAfterMs(headers) {
  const value = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds, 60) * 1000);
  const when = Date.parse(value);
  if (Number.isFinite(when)) return Math.max(0, Math.min(when - Date.now(), 60_000));
  return null;
}

/** amount fields come back as decimal strings; anything else is a bug upstream. */
function rawAmount(value, what) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  throw new RpcError(`${what}: expected a base-unit integer, got ${JSON.stringify(value)}`, { code: 'bad_response' });
}

/**
 * @param {{rpcUrl?: string}} cfg
 * @param {{
 *   fetchImpl?: typeof fetch, timeoutMs?: number, retries?: number, backoffMs?: number,
 *   maxBackoffMs?: number, sleep?: (ms:number)=>Promise<void>, commitment?: string,
 *   logger?: {debug:Function,warn:Function}, random?: () => number
 * }} [opts]
 */
export function createRpc(cfg = {}, opts = {}) {
  const url = opts.url || cfg.rpcUrl || 'https://api.mainnet-beta.solana.com';
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new RpcError('no fetch implementation available', { code: 'no_fetch' });

  const defaultTimeout = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 20_000;
  const defaultRetries = Number.isFinite(opts.retries) ? opts.retries : 3;
  const backoffMs = Number.isFinite(opts.backoffMs) ? opts.backoffMs : 400;
  const maxBackoffMs = Number.isFinite(opts.maxBackoffMs) ? opts.maxBackoffMs : 8_000;
  const sleep = opts.sleep || ((ms) => delay(ms));
  const random = opts.random || Math.random;
  const commitment = opts.commitment || 'confirmed';
  const logger = opts.logger || null;

  let nextId = 1;
  const stats = { calls: 0, retries: 0, failures: 0 };

  async function once(method, params, { timeoutMs }) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params });
    const signal = AbortSignal.timeout(timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body,
        signal,
      });
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
      throw new RpcError(aborted ? `${method}: timed out after ${timeoutMs}ms` : `${method}: ${err?.message || 'network error'}`, {
        code: aborted ? 'timeout' : 'network',
        method,
        retryable: true,
        cause: err,
      });
    }

    if (!res.ok) {
      const status = res.status;
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* body already consumed or unreadable; the status is the signal */
      }
      throw new RpcError(`${method}: HTTP ${status}${detail ? ` ${detail}` : ''}`, {
        code: 'http_error',
        status,
        method,
        retryable: isRetryableStatus(status),
        retryAfterMs: retryAfterMs(res.headers),
      });
    }

    let json;
    try {
      json = await res.json();
    } catch (err) {
      throw new RpcError(`${method}: response was not JSON`, { code: 'bad_response', method, retryable: true, cause: err });
    }

    if (json && json.error) {
      const code = Number(json.error.code);
      throw new RpcError(`${method}: ${json.error.message || 'rpc error'}${json.error.code ? ` (${json.error.code})` : ''}`, {
        code: 'rpc_error',
        method,
        retryable: RETRYABLE_RPC_CODES.has(code),
        cause: json.error,
      });
    }
    if (!json || !('result' in json)) {
      throw new RpcError(`${method}: response had no result`, { code: 'bad_response', method, retryable: true });
    }
    return json.result;
  }

  /**
   * One JSON-RPC call with retry/backoff.
   * @param {string} method @param {any[]} params
   * @param {{timeoutMs?: number, retries?: number}} [callOpts]
   */
  async function call(method, params = [], callOpts = {}) {
    const timeoutMs = Number.isFinite(callOpts.timeoutMs) ? callOpts.timeoutMs : defaultTimeout;
    const retries = Number.isFinite(callOpts.retries) ? callOpts.retries : defaultRetries;
    stats.calls += 1;
    let lastError = null;
    for (let attempt = 0; attempt < Math.max(1, retries); attempt++) {
      try {
        return await once(method, params, { timeoutMs });
      } catch (err) {
        lastError = err;
        const canRetry = err instanceof RpcError && err.retryable && attempt < Math.max(1, retries) - 1;
        if (!canRetry) break;
        stats.retries += 1;
        const hinted = Number.isFinite(err.retryAfterMs) ? err.retryAfterMs : null;
        const wait = hinted ?? Math.min(maxBackoffMs, backoffMs * 2 ** attempt + Math.floor(random() * backoffMs));
        logger?.debug?.(`rpc ${method} attempt ${attempt + 1} failed (${err.code}); retrying in ${wait}ms`);
        await sleep(wait);
      }
    }
    stats.failures += 1;
    throw lastError;
  }

  /* ------------------------------------------------------------- accounts */

  /** @returns {Promise<bigint>} lamports */
  async function getBalanceLamports(address, callOpts = {}) {
    const result = await call('getBalance', [String(address), { commitment }], callOpts);
    return rawAmount(result?.value ?? result, 'getBalance');
  }

  /** @returns {Promise<number>} */
  async function getSlot(callOpts = {}) {
    const result = await call('getSlot', [{ commitment }], callOpts);
    return Number(result);
  }

  /** @returns {Promise<number>} */
  async function getBlockHeight(callOpts = {}) {
    const result = await call('getBlockHeight', [{ commitment }], callOpts);
    return Number(result);
  }

  /** @returns {Promise<{blockhash: string, lastValidBlockHeight: number}>} */
  async function getLatestBlockhash(commitmentOverride, callOpts = {}) {
    const result = await call('getLatestBlockhash', [{ commitment: commitmentOverride || commitment }], callOpts);
    const value = result?.value ?? result;
    if (!value?.blockhash) throw new RpcError('getLatestBlockhash: no blockhash in response', { code: 'bad_response' });
    return { blockhash: value.blockhash, lastValidBlockHeight: Number(value.lastValidBlockHeight) };
  }

  /** @returns {Promise<any>} raw jsonParsed account, or null */
  async function getAccountInfo(address, encoding = 'jsonParsed', callOpts = {}) {
    const result = await call('getAccountInfo', [String(address), { encoding, commitment }], callOpts);
    return result?.value ?? null;
  }

  /* --------------------------------------------------------------- tokens */

  /** @returns {Promise<{amountRaw: bigint, decimals: number, uiAmountString: string}>} */
  async function getTokenSupply(mint, callOpts = {}) {
    const result = await call('getTokenSupply', [String(mint), { commitment }], callOpts);
    const value = result?.value ?? result;
    if (!value) throw new RpcError('getTokenSupply: empty response', { code: 'bad_response' });
    return {
      amountRaw: rawAmount(value.amount, 'getTokenSupply.amount'),
      decimals: Number(value.decimals),
      uiAmountString: String(value.uiAmountString ?? ''),
    };
  }

  /**
   * Mint account facts the keeper actually depends on: which token program owns
   * it, its decimals, and whether a transfer hook has appeared. xStocks carry a
   * transferHook extension with a null programId today; if Backed ever points it
   * at a program, plain transferChecked stops working and the keeper must fail
   * loudly rather than silently mis-send.
   * @returns {Promise<null|{mint, programId, decimals, supplyRaw, extensions: string[], transferHookProgramId: string|null, paused: boolean, permanentDelegate: string|null}>}
   */
  async function getMintInfo(mint, callOpts = {}) {
    const account = await getAccountInfo(mint, 'jsonParsed', callOpts);
    if (!account) return null;
    const parsed = account.data?.parsed;
    const info = parsed?.info ?? {};
    const extensions = Array.isArray(info.extensions) ? info.extensions : [];
    const extNames = extensions.map((e) => String(e?.extension ?? '')).filter(Boolean);

    const hook = extensions.find((e) => e?.extension === 'transferHook');
    const hookProgram = hook?.state?.programId ?? null;
    const pausable = extensions.find((e) => e?.extension === 'pausableConfig');
    const delegate = extensions.find((e) => e?.extension === 'permanentDelegate');

    return {
      mint: String(mint),
      programId: String(account.owner ?? ''),
      decimals: Number(info.decimals ?? 0),
      supplyRaw: info.supply === undefined ? 0n : rawAmount(info.supply, 'mint.supply'),
      extensions: extNames,
      transferHookProgramId: hookProgram && hookProgram !== '11111111111111111111111111111111' ? String(hookProgram) : null,
      paused: Boolean(pausable?.state?.paused),
      permanentDelegate: delegate?.state?.delegate ? String(delegate.state.delegate) : null,
    };
  }

  /**
   * Total base units of `mint` held by `owner`, summed over every token account
   * it owns for that mint (an owner can legitimately have more than one).
   * @returns {Promise<bigint>}
   */
  async function getTokenAccountBalanceRaw(owner, mint, programId = TOKEN_2022_PROGRAM_ID, callOpts = {}) {
    const filter = mint ? { mint: String(mint) } : { programId: String(programId) };
    const result = await call(
      'getTokenAccountsByOwner',
      [String(owner), filter, { encoding: 'jsonParsed', commitment }],
      callOpts,
    );
    const accounts = result?.value ?? [];
    let total = 0n;
    for (const entry of accounts) {
      const amount = entry?.account?.data?.parsed?.info?.tokenAmount?.amount;
      if (amount === undefined || amount === null) continue;
      total += rawAmount(amount, 'tokenAmount.amount');
    }
    return total;
  }

  /** Every token account of `owner`, as [{ address, mint, amountRaw, decimals }]. */
  async function getTokenAccountsByOwner(owner, filter = { programId: TOKEN_2022_PROGRAM_ID }, callOpts = {}) {
    const result = await call('getTokenAccountsByOwner', [String(owner), filter, { encoding: 'jsonParsed', commitment }], callOpts);
    const accounts = result?.value ?? [];
    return accounts.map((entry) => {
      const info = entry?.account?.data?.parsed?.info ?? {};
      return {
        address: String(entry?.pubkey ?? ''),
        mint: String(info.mint ?? ''),
        owner: String(info.owner ?? owner),
        amountRaw: info.tokenAmount?.amount ? rawAmount(info.tokenAmount.amount, 'tokenAmount.amount') : 0n,
        decimals: Number(info.tokenAmount?.decimals ?? 0),
      };
    });
  }

  /* --------------------------------------------------------- transactions */

  /**
   * @param {string[]} signatures
   * @returns {Promise<Array<null|{slot:number, confirmations:number|null, confirmationStatus:string|null, err:any}>>}
   */
  async function getSignatureStatuses(signatures, { searchTransactionHistory = true, ...callOpts } = {}) {
    const list = (Array.isArray(signatures) ? signatures : [signatures]).map(String);
    if (list.length === 0) return [];
    const result = await call('getSignatureStatuses', [list, { searchTransactionHistory }], callOpts);
    const value = result?.value ?? [];
    return list.map((_, i) => value[i] ?? null);
  }

  /**
   * @param {Uint8Array|Buffer|string} raw signed transaction bytes (or base64)
   * @returns {Promise<string>} signature
   */
  async function sendRawTransaction(raw, options = {}) {
    const { skipPreflight = false, maxRetries = 3, preflightCommitment = 'confirmed', retries, timeoutMs } = options;
    const encoded = toBase64(raw);
    const result = await call(
      'sendTransaction',
      [encoded, { encoding: 'base64', skipPreflight, preflightCommitment, maxRetries }],
      // A send is not idempotent at the transport level, but a Solana
      // transaction is: the same signed bytes can only ever land once, so
      // resending after a timeout is safe and is how you beat a dropped packet.
      { retries: Number.isFinite(retries) ? retries : 2, timeoutMs },
    );
    if (typeof result !== 'string') throw new RpcError('sendTransaction: no signature in response', { code: 'bad_response' });
    return result;
  }

  /**
   * Poll getSignatureStatuses until the signature reaches `commitment`, the
   * transaction errors, or its blockhash expires (block height passes
   * lastValidBlockHeight — the honest "it will never land" signal).
   * @returns {Promise<{signature: string, status: 'confirmed'|'failed'|'expired'|'timeout', slot: number|null, err: any}>}
   *   confirmed = it landed; failed = it landed and errored; expired = its
   *   blockhash is past, it can never land; timeout = still unknown.
   */
  async function confirmSignature(signature, { lastValidBlockHeight = null, timeoutMs = 60_000, pollMs = 1500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let checkedHeight = 0;
    for (;;) {
      const [status] = await getSignatureStatuses([signature]);
      if (status) {
        if (status.err) {
          return { signature, status: 'failed', slot: status.slot ?? null, err: status.err };
        }
        const level = status.confirmationStatus || (status.confirmations === null ? 'finalized' : 'processed');
        if (level === 'confirmed' || level === 'finalized') {
          return { signature, status: 'confirmed', slot: status.slot ?? null, err: null };
        }
      }
      if (Date.now() >= deadline) return { signature, status: 'timeout', slot: null, err: null };
      if (lastValidBlockHeight !== null && Date.now() >= checkedHeight) {
        const height = await getBlockHeight();
        if (height > lastValidBlockHeight) return { signature, status: 'expired', slot: null, err: null };
        checkedHeight = Date.now() + 4000; // block height moves slowly; don't ask every poll
      }
      await sleep(pollMs);
    }
  }

  return {
    url: () => url,
    stats: () => ({ ...stats }),
    call,
    getBalanceLamports,
    getSlot,
    getBlockHeight,
    getLatestBlockhash,
    getAccountInfo,
    getTokenSupply,
    getMintInfo,
    getTokenAccountBalanceRaw,
    getTokenAccountsByOwner,
    getSignatureStatuses,
    sendRawTransaction,
    confirmSignature,
  };
}

export default createRpc;
