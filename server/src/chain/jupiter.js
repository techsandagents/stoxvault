/**
 * STOCKDROP chain / Jupiter
 *
 * Four endpoints, exactly as CONTRACT.md section 7 pins them:
 *   GET  {JUP_BASE}/swap/v1/quote          route + expected output
 *   POST {JUP_BASE}/swap/v1/swap           an unsigned v0 transaction
 *   GET  {JUP_BASE}/price/v3?ids=...       usd price, 24h change, liquidity, stockData
 *   GET  {JUP_BASE}/tokens/v2/search       the xStock universe
 *
 * Everything has a hard timeout and three attempts. `searchXStocks` degrades to
 * `data/xstocks.seed.json` when the network is unusable — a stale universe is
 * honest (it is stamped with `source: 'seed'` and the file's own fetchedAt) and
 * lets a round still run; an invented universe would not be.
 *
 * Quotes are never treated as fills. In LIVE mode the received amount is the
 * measured on-chain delta; the quote only sizes the trade and bounds slippage.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SEED_PATH = path.resolve(HERE, '../../data/xstocks.seed.json');

/** xStock tickers are the underlying ticker plus a lowercase x: NVDAx, BRK.Bx, SPYx. */
const XSTOCK_SYMBOL = /^[A-Z0-9][A-Z0-9.\-]{0,9}x$/;

export class JupiterError extends Error {
  constructor(message, { code = 'jupiter_error', status = null, endpoint = null, retryable = false, cause = null } = {}) {
    super(message);
    this.name = 'JupiterError';
    this.code = code;
    this.status = status;
    this.endpoint = endpoint;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Base-unit amounts always cross this boundary as strings; parse them exactly. */
function rawString(value, what) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return value.trim();
  throw new JupiterError(`${what}: expected a base-unit integer, got ${JSON.stringify(value)}`, { code: 'bad_response' });
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * @param {{jupBase?: string, slippageBps?: number, priorityFeeLamports?: number}} cfg
 * @param {{
 *   fetchImpl?: typeof fetch, timeoutMs?: number, attempts?: number, backoffMs?: number,
 *   sleep?: (ms:number)=>Promise<void>, seedPath?: string, logger?: object, random?: () => number,
 *   readFile?: (p: string, enc: string) => Promise<string>
 * }} [opts]
 */
export function createJupiter(cfg = {}, opts = {}) {
  const base = String(cfg.jupBase || 'https://lite-api.jup.ag').replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new JupiterError('no fetch implementation available', { code: 'no_fetch' });

  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 15_000;
  const attempts = Number.isFinite(opts.attempts) ? Math.max(1, opts.attempts) : 3;
  const backoffMs = Number.isFinite(opts.backoffMs) ? opts.backoffMs : 500;
  const sleep = opts.sleep || ((ms) => delay(ms));
  const random = opts.random || Math.random;
  const seedPath = opts.seedPath || DEFAULT_SEED_PATH;
  const readFile = opts.readFile || ((p, enc) => fs.readFile(p, enc));
  const logger = opts.logger || null;

  let seedCache = null;

  /** One HTTP round trip with a timeout; classifies its own failure. */
  async function once(endpoint, url, { method = 'GET', body = null }) {
    const signal = AbortSignal.timeout(timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: body ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
      throw new JupiterError(aborted ? `${endpoint}: timed out after ${timeoutMs}ms` : `${endpoint}: ${err?.message || 'network error'}`, {
        code: aborted ? 'timeout' : 'network',
        endpoint,
        retryable: true,
        cause: err,
      });
    }

    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* the status is enough */
      }
      throw new JupiterError(`${endpoint}: HTTP ${res.status}${detail ? ` ${detail}` : ''}`, {
        code: 'http_error',
        status: res.status,
        endpoint,
        retryable: res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500,
      });
    }

    try {
      return await res.json();
    } catch (err) {
      throw new JupiterError(`${endpoint}: response was not JSON`, { code: 'bad_response', endpoint, retryable: true, cause: err });
    }
  }

  async function request(endpoint, url, options = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await once(endpoint, url, options);
      } catch (err) {
        lastError = err;
        if (!(err instanceof JupiterError) || !err.retryable || attempt === attempts - 1) break;
        const wait = Math.min(8000, backoffMs * 2 ** attempt + Math.floor(random() * backoffMs));
        logger?.debug?.(`jupiter ${endpoint} attempt ${attempt + 1} failed (${err.code}); retrying in ${wait}ms`);
        await sleep(wait);
      }
    }
    throw lastError;
  }

  /* ----------------------------------------------------------------- seed */

  /** The shipped snapshot of the xStock universe. Read once, cached in memory. */
  async function loadSeed() {
    if (seedCache) return seedCache;
    const text = await readFile(seedPath, 'utf8');
    const parsed = JSON.parse(text);
    const stocks = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.stocks) ? parsed.stocks : [];
    seedCache = {
      fetchedAt: parsed?.fetchedAt ?? null,
      source: 'seed',
      stocks: stocks.filter((s) => s && typeof s.mint === 'string'),
    };
    return seedCache;
  }

  /** mint -> seed entry, for yahooSymbol and as the offline mcap of last resort. */
  async function seedIndex() {
    const seed = await loadSeed().catch(() => null);
    const index = new Map();
    if (!seed) return index;
    for (const stock of seed.stocks) index.set(stock.mint, stock);
    return index;
  }

  /* ---------------------------------------------------------------- quote */

  /**
   * quote({ inputMint = SOL, outputMint, amount, slippageBps, swapMode })
   * `amount` is base units of the input mint (lamports for SOL) as bigint/string.
   * @returns {Promise<object>} the raw Jupiter quote (pass it back to buildSwapTx unmodified)
   */
  async function quote({
    inputMint = SOL_MINT,
    outputMint,
    amount,
    slippageBps = cfg.slippageBps ?? 100,
    swapMode = 'ExactIn',
    restrictIntermediateTokens = true,
    onlyDirectRoutes = false,
  } = {}) {
    if (!outputMint) throw new JupiterError('quote: outputMint is required', { code: 'bad_argument' });
    const amountRaw = rawString(amount, 'quote.amount');
    if (amountRaw === '0') throw new JupiterError('quote: amount must be greater than zero', { code: 'bad_argument' });

    const params = new URLSearchParams({
      inputMint: String(inputMint),
      outputMint: String(outputMint),
      amount: amountRaw,
      slippageBps: String(slippageBps),
      swapMode,
      restrictIntermediateTokens: String(Boolean(restrictIntermediateTokens)),
    });
    if (onlyDirectRoutes) params.set('onlyDirectRoutes', 'true');

    const json = await request('quote', `${base}/swap/v1/quote?${params.toString()}`);
    if (!json || typeof json !== 'object') throw new JupiterError('quote: empty response', { code: 'bad_response' });
    if (json.error) throw new JupiterError(`quote: ${json.error}`, { code: 'no_route' });
    if (json.outAmount === undefined || json.outAmount === null) {
      throw new JupiterError('quote: response had no outAmount (no route)', { code: 'no_route' });
    }
    // Normalise the two fields the keeper does arithmetic on; leave the rest of
    // the document untouched because /swap wants it back byte-for-byte.
    json.inAmount = rawString(json.inAmount ?? amountRaw, 'quote.inAmount');
    json.outAmount = rawString(json.outAmount, 'quote.outAmount');
    return json;
  }

  /* ------------------------------------------------------------ swap build */

  /**
   * buildSwapTx({ quoteResponse, userPublicKey, prioritizationFeeLamports })
   * @returns {Promise<{swapTransaction: string, lastValidBlockHeight: number|null, prioritizationFeeLamports: number|null, computeUnitLimit: number|null, simulationError: any}>}
   */
  async function buildSwapTx({
    quoteResponse,
    userPublicKey,
    prioritizationFeeLamports = cfg.priorityFeeLamports ?? 200000,
    wrapAndUnwrapSol = true,
    dynamicComputeUnitLimit = true,
  } = {}) {
    if (!quoteResponse || typeof quoteResponse !== 'object') {
      throw new JupiterError('buildSwapTx: quoteResponse is required', { code: 'bad_argument' });
    }
    if (!userPublicKey) throw new JupiterError('buildSwapTx: userPublicKey is required', { code: 'bad_argument' });

    const json = await request('swap', `${base}/swap/v1/swap`, {
      method: 'POST',
      body: {
        quoteResponse,
        userPublicKey: String(userPublicKey),
        wrapAndUnwrapSol,
        dynamicComputeUnitLimit,
        prioritizationFeeLamports,
      },
    });

    if (!json?.swapTransaction) {
      throw new JupiterError(`swap: response had no swapTransaction${json?.error ? ` (${json.error})` : ''}`, { code: 'bad_response' });
    }
    return {
      swapTransaction: String(json.swapTransaction),
      lastValidBlockHeight: num(json.lastValidBlockHeight),
      prioritizationFeeLamports: num(json.prioritizationFeeLamports),
      computeUnitLimit: num(json.computeUnitLimit),
      simulationError: json.simulationError ?? null,
    };
  }

  /* --------------------------------------------------------------- prices */

  /**
   * prices(mints) -> { [mint]: { usdPrice, priceChange24h, liquidity, stockData: {price, mcap}|null, decimals } }
   * Chunked at 50 ids per request (the documented ceiling for price/v3).
   */
  async function prices(mints = []) {
    const ids = [...new Set((Array.isArray(mints) ? mints : [mints]).filter((m) => typeof m === 'string' && m !== ''))];
    if (ids.length === 0) return {};
    const out = {};
    for (const group of chunk(ids, 50)) {
      const json = await request('price', `${base}/price/v3?ids=${group.map(encodeURIComponent).join(',')}`);
      for (const [mint, entry] of Object.entries(json || {})) {
        if (!entry || typeof entry !== 'object') continue;
        const stock = entry.stockData && typeof entry.stockData === 'object' ? entry.stockData : null;
        out[mint] = {
          usdPrice: num(entry.usdPrice),
          priceChange24h: num(entry.priceChange24h),
          liquidity: num(entry.liquidity),
          decimals: num(entry.decimals),
          blockId: num(entry.blockId),
          stockData: stock ? { price: num(stock.price), mcap: num(stock.mcap) } : null,
        };
      }
    }
    return out;
  }

  /** SOL price in USD, or null when the feed is unavailable (never a guessed number). */
  async function solPriceUsd() {
    try {
      const map = await prices([SOL_MINT]);
      const price = map[SOL_MINT]?.usdPrice;
      return Number.isFinite(price) ? price : null;
    } catch (err) {
      logger?.warn?.(`jupiter: sol price unavailable (${err.code || err.name})`);
      return null;
    }
  }

  /* ------------------------------------------------------------- universe */

  /** Jupiter token entry + price entry + seed entry -> the Stock shape of CONTRACT.md section 3. */
  function toStock(token, price, seed) {
    const mint = String(token.id ?? token.mint ?? seed?.mint ?? '');
    const symbol = String(token.symbol ?? seed?.symbol ?? '');
    const stockData = price?.stockData ?? null;
    return {
      mint,
      symbol,
      name: String(token.name ?? seed?.name ?? symbol),
      logo: token.icon ?? token.logoURI ?? seed?.logo ?? null,
      decimals: Number.isFinite(num(token.decimals)) ? num(token.decimals) : (seed?.decimals ?? 8),
      tokenProgram: String(token.tokenProgram ?? seed?.tokenProgram ?? TOKEN_2022_PROGRAM_ID),
      yahooSymbol: seed?.yahooSymbol ?? null,
      priceUsd: num(price?.usdPrice) ?? num(token.usdPrice) ?? seed?.priceUsd ?? null,
      change24h: num(price?.priceChange24h) ?? num(token.stats24h?.priceChange) ?? seed?.change24h ?? null,
      underlyingPrice: num(stockData?.price) ?? seed?.underlyingPrice ?? null,
      underlyingMcap: num(stockData?.mcap) ?? seed?.underlyingMcap ?? null,
      tokenMcap: num(token.mcap) ?? seed?.tokenMcap ?? null,
      liquidityUsd: num(price?.liquidity) ?? num(token.liquidity) ?? seed?.liquidityUsd ?? null,
      holderCount: num(token.holderCount) ?? seed?.holderCount ?? null,
    };
  }

  function looksLikeXStock(token) {
    const symbol = String(token?.symbol ?? '');
    if (!XSTOCK_SYMBOL.test(symbol)) return false;
    const program = String(token?.tokenProgram ?? '');
    return program === '' || program === TOKEN_2022_PROGRAM_ID;
  }

  /**
   * searchXStocks({ query = 'xStock', limit = 100 })
   *
   * @returns {Promise<{source: 'jupiter'|'jupiter+seed'|'seed', fetchedAt: string, stocks: Stock[], error: string|null}>}
   *   `source` is recorded in the round document, so a round run off the seed can
   *   never be mistaken for one run off live data.
   */
  async function searchXStocks({ query = 'xStock', limit = 100, withPrices = true } = {}) {
    const seedByMint = await seedIndex();
    let tokens = null;
    let searchError = null;

    try {
      const json = await request('tokens/search', `${base}/tokens/v2/search?query=${encodeURIComponent(query)}&limit=${limit}`);
      const list = Array.isArray(json) ? json : Array.isArray(json?.tokens) ? json.tokens : Array.isArray(json?.data) ? json.data : null;
      if (!list) throw new JupiterError('tokens/search: unexpected response shape', { code: 'bad_response' });
      tokens = list.filter(looksLikeXStock);
      if (tokens.length === 0) throw new JupiterError('tokens/search: no xStocks in response', { code: 'empty' });
    } catch (err) {
      searchError = err;
      tokens = null;
    }

    if (!tokens) {
      // Offline: the shipped snapshot, stamped as such.
      const seed = await loadSeed();
      logger?.warn?.(`jupiter: falling back to the xStocks seed file (${searchError?.message || 'unknown error'})`);
      return {
        source: 'seed',
        fetchedAt: seed.fetchedAt || null,
        stocks: seed.stocks.map((s) => ({ ...s })),
        error: searchError ? String(searchError.message) : null,
      };
    }

    let priceMap = {};
    let priceError = null;
    if (withPrices) {
      try {
        priceMap = await prices(tokens.map((t) => String(t.id ?? t.mint)));
      } catch (err) {
        priceError = err;
        logger?.warn?.(`jupiter: price/v3 unavailable, ranking on seed market caps (${err.message})`);
      }
    }

    const stocks = tokens.map((token) => {
      const mint = String(token.id ?? token.mint ?? '');
      return toStock(token, priceMap[mint], seedByMint.get(mint));
    });

    return {
      source: priceError ? 'jupiter+seed' : 'jupiter',
      fetchedAt: new Date().toISOString(),
      stocks,
      error: priceError ? String(priceError.message) : null,
    };
  }

  return {
    base: () => base,
    quote,
    buildSwapTx,
    prices,
    solPriceUsd,
    searchXStocks,
    loadSeed,
  };
}

export default createJupiter;
