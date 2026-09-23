// The HTTP surface, end to end, with no network.
//
// The app is built by createApp({cfg, db, deps}) and listened on port 0, so
// these are real requests over a real socket. Jupiter, the Solana RPC and the
// price-history sources are injected as fakes through `deps`: nothing in this
// file talks to the internet, and every response asserted here is one the
// server actually produced.
//
// The state under test is the one the project is in today: TOKEN_MINT blank,
// coin not launched.

process.env.STOCKDROP_QUIET = '1';
process.env.LOG_LEVEL = 'silent';

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { buildConfig } = await import('../src/config.js');
const { openDb } = await import('../src/db/index.js');
const { createApp } = await import('../src/index.js');
const { b58encode, b58decode, buildSignInMessage, hashPersonalMessage, toChecksumAddress } = await import('../src/services/session.js');
const { buildAttribution, buildCycle } = await import('../src/api/me.js');
const { secp256k1 } = await import('@noble/curves/secp256k1');
const { keccak_256 } = await import('@noble/hashes/sha3');
const { createHoldersService, aggregate, parseAccountSlice, tokenAccountsByOwnerParams } = await import('../src/services/holders.js');

const VAULT_ADDRESS = '769fv6KK6SAQ5FBAXdUZLdrppdHn5CqqgJBpFCLyf9up';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

const NVDA = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const AAPL = 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp';
const GOOGL = 'XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN';
const MSFT = 'XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX';
const AMZN = 'Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg';
const TSLA = 'XsafvsGtzFqqHgTnA3aPC83EAMkacU5mcGtcSayhpVV';
const PRIVATE = 'Xs11111111111111111111111111111111111111111'; // no Yahoo listing: exercises the CoinGecko path
const THIN = 'Xs22222222222222222222222222222222222222222'; // below LIQ_MIN_USD: must never rank

// Jupiter's search shape (id/icon/liquidity/mcap), not the Stock shape, so the
// normaliser is exercised too.
const SEARCH_ROWS = [
  { id: NVDA, symbol: 'NVDAx', name: 'NVIDIA', icon: 'https://x/NVDAx.png', decimals: 8, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', liquidity: 1903936, mcap: 74635885, holderCount: 73677 },
  { id: AAPL, symbol: 'AAPLx', name: 'Apple', icon: 'https://x/AAPLx.png', decimals: 8, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', liquidity: 395628, mcap: 49000000, holderCount: 41000 },
  { id: GOOGL, symbol: 'GOOGLx', name: 'Alphabet', icon: 'https://x/GOOGLx.png', decimals: 8, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', liquidity: 300000, mcap: 30000000, holderCount: 22000 },
  { id: MSFT, symbol: 'MSFTx', name: 'Microsoft', icon: 'https://x/MSFTx.png', decimals: 8, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', liquidity: 250000, mcap: 28000000, holderCount: 19000 },
  { id: AMZN, symbol: 'AMZNx', name: 'Amazon', icon: 'https://x/AMZNx.png', decimals: 8, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', liquidity: 200000, mcap: 21000000, holderCount: 15000 },
  { id: TSLA, symbol: 'TSMx', name: 'TSMC', icon: 'https://x/TSMx.png', decimals: 8, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', liquidity: 180000, mcap: 18000000, holderCount: 12000 },
  { id: PRIVATE, symbol: 'PRIVx', name: 'A Private Company', icon: null, decimals: 8, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', liquidity: 120000, mcap: 9000000, holderCount: 900 },
  { id: THIN, symbol: 'THINx', name: 'Thinly Traded', icon: null, decimals: 8, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', liquidity: 1200, mcap: 500000, holderCount: 40 },
];

// stockData.mcap is absolute USD, exactly as Jupiter reports it (verified live).
const PRICES = {
  [NVDA]: { usdPrice: 232.09, priceChange24h: 0.26, liquidity: 1903936, stockData: { price: 229.48, mcap: 5562502920000 } },
  [AAPL]: { usdPrice: 320.44, priceChange24h: -0.55, liquidity: 395628, stockData: { price: 320.01, mcap: 4669699774600 } },
  [GOOGL]: { usdPrice: 250.1, priceChange24h: 1.1, liquidity: 300000, stockData: { price: 249.9, mcap: 3500000000000 } },
  [MSFT]: { usdPrice: 470.5, priceChange24h: 0.4, liquidity: 250000, stockData: { price: 470.0, mcap: 3400000000000 } },
  [AMZN]: { usdPrice: 210.2, priceChange24h: -0.2, liquidity: 200000, stockData: { price: 210.0, mcap: 2500000000000 } },
  [TSLA]: { usdPrice: 190.0, priceChange24h: 0.9, liquidity: 180000, stockData: { price: 189.5, mcap: 1400000000000 } },
  [PRIVATE]: { usdPrice: 12.5, priceChange24h: 0, liquidity: 120000, stockData: { price: 12.5, mcap: 40000000000 } },
  [THIN]: { usdPrice: 3.5, priceChange24h: 0, liquidity: 1200, stockData: { price: 3.5, mcap: 2000000000 } },
  [SOL_MINT]: { usdPrice: 200, priceChange24h: 1.5, liquidity: 999999999 },
};

const YAHOO_BODY = {
  chart: {
    error: null,
    result: [
      {
        meta: { symbol: 'NVDA', currency: 'USD' },
        timestamp: [1756944000, 1757030400, 1757116800],
        indicators: {
          quote: [
            {
              open: [229.1, 231.0, null],
              high: [233.4, 234.9, null],
              low: [228.0, 230.1, null],
              close: [232.09, 233.5, null], // the third day has not printed yet
              volume: [140000000, 121000000, null],
            },
          ],
        },
      },
    ],
  },
};

const COINGECKO_BODY = {
  prices: [
    [1756944000000, 12.1],
    [1757030400000, 12.4],
  ],
  total_volumes: [
    [1756944000, 4000],
    [1757030400, 4200],
  ],
};

function makeDeps(overrides = {}) {
  const calls = { search: 0, prices: 0, rpc: [], fetch: [] };
  const deps = {
    jupiter: {
      async searchXStocks() {
        calls.search += 1;
        return SEARCH_ROWS;
      },
      async prices(mints) {
        calls.prices += 1;
        const out = {};
        for (const mint of mints) if (PRICES[mint]) out[mint] = PRICES[mint];
        return out;
      },
    },
    rpc: {
      async call(method, params) {
        calls.rpc.push({ method, params });
        if (method === 'getBalance') return { value: 2_500_000_000 };
        if (method === 'getSlot') return 350_000_000;
        throw new Error(`unexpected rpc call in a pre-launch test: ${method}`);
      },
    },
    async fetch(url) {
      calls.fetch.push(String(url));
      const target = String(url);
      if (target.includes('query1.finance.yahoo.com')) {
        return { ok: true, status: 200, json: async () => YAHOO_BODY };
      }
      if (target.includes('api.coingecko.com')) {
        return { ok: true, status: 200, json: async () => COINGECKO_BODY };
      }
      throw new Error(`no network in tests: ${target}`);
    },
    ...overrides,
  };
  deps.calls = calls;
  return deps;
}

async function makeServer({ env = {}, deps = makeDeps() } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stockdrop-api-'));
  const cfg = buildConfig({
    PORT: '0',
    SESSION_SECRET: 'test-session-secret',
    VAULT_ADDRESS,
    DATA_DIR: dir,
    CORS_ORIGIN: '*',
    ...env,
  });
  const db = await openDb(cfg);
  const app = createApp({ cfg, db, deps });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    cfg,
    db,
    deps,
    port: server.address().port,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await db.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function request(port, method, urlPath, { body, raw, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let payload = null;
    if (raw !== undefined) payload = Buffer.from(raw);
    else if (body !== undefined) payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        agent: false,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text === '' ? null : JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const get = (port, p, opts) => request(port, 'GET', p, opts);

/**
 * A throwaway Robinhood Wallet: a real secp256k1 key, an EIP-55 address, and an
 * EIP-191 `personal_sign` signature. This is what signs in now.
 */
function newWallet() {
  const privateKey = secp256k1.utils.randomSecretKey
    ? secp256k1.utils.randomSecretKey()
    : secp256k1.utils.randomPrivateKey();
  const pub = secp256k1.getPublicKey(privateKey, false);
  const address = toChecksumAddress(`0x${Buffer.from(keccak_256(pub.subarray(1))).subarray(12).toString('hex')}`);
  return {
    address,
    sign(message) {
      const sig = secp256k1.sign(hashPersonalMessage(message), privateKey, { prehash: false });
      return `0x${sig.r.toString(16).padStart(64, '0')}${sig.s.toString(16).padStart(64, '0')}${(27 + sig.recovery)
        .toString(16)
        .padStart(2, '0')}`;
    },
  };
}

/**
 * A throwaway SOLANA address. Sign-in cannot produce one any more — this exists
 * only for the holder-snapshot fixtures, which still read a Solana token, and
 * the gap between the two is exactly what this release is honest about.
 */
function newSolanaAddress() {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return b58encode(Buffer.from(spki.subarray(spki.length - 32)));
}

/** The whole sign-in dance, returning a usable Bearer token. */
async function signIn(port, wallet = newWallet()) {
  const nonce = await request(port, 'POST', '/api/auth/nonce', { body: { wallet: wallet.address } });
  assert.equal(nonce.status, 200, nonce.text);
  const verified = await request(port, 'POST', '/api/auth/verify', {
    body: { wallet: wallet.address, nonce: nonce.json.nonce, signature: wallet.sign(nonce.json.message) },
  });
  assert.equal(verified.status, 200, verified.text);
  return { wallet, token: verified.json.token, me: verified.json.me, nonce: nonce.json };
}

/* ------------------------------------------------------------ public reads */

test('GET / lists the API', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  const res = await get(s.port, '/');
  assert.equal(res.status, 200);
  assert.equal(res.json.name, 'stockdrop');
  assert.equal(res.json.launched, false);
  assert.equal(res.json.vault, VAULT_ADDRESS);
  assert.equal(res.json.api.health, 'GET /api/health');
  assert.ok(res.json.api.preview.includes('/api/rounds/preview'));
});

test('GET /api/health and /api/config are honest before launch', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  const health = await get(s.port, '/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(health.json).sort(), ['mode', 'nextRoundAt', 'ok', 'serverTime', 'tokenMint', 'vault', 'version'].sort());
  assert.equal(health.json.ok, true);
  assert.equal(health.json.tokenMint, null, 'no coin exists yet');
  assert.equal(health.json.mode, 'READ_ONLY', 'no vault secret in tests');
  assert.equal(health.json.vault, VAULT_ADDRESS);
  assert.ok(Date.parse(health.json.nextRoundAt) > Date.now());

  const config = await get(s.port, '/api/config');
  assert.equal(config.status, 200);
  assert.deepEqual(config.json.token, {
    name: null,
    symbol: null,
    mint: null,
    supply: '1000000000',
    supplyRaw: '1000000000000000',
    decimals: 6,
    launched: false,
  });
  assert.equal(config.json.vault.address, VAULT_ADDRESS);
  assert.equal(config.json.intervalHours, 6);
  assert.equal(config.json.rules.minPicks, 2);
  assert.equal(config.json.rules.maxPicks, 5);
  assert.equal(config.json.rules.minPct, 10);
  assert.equal(config.json.rules.maxPct, 60);
  assert.equal(config.json.rules.eligibleThresholdRaw, '1000000000000', '0.1% of 1B at 6 decimals');
});

test('GET /api/universe ranks by underlying market cap and drops illiquid stocks', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  const res = await get(s.port, '/api/universe');
  assert.equal(res.status, 200);
  assert.equal(res.json.source, 'jupiter');
  assert.equal(res.json.stale, false);
  assert.equal(res.json.stocks.length, 7, 'the thin stock is filtered out by LIQ_MIN_USD');
  assert.equal(res.json.all.length, 8);

  assert.deepEqual(res.json.stocks.map((s2) => s2.symbol), ['NVDAx', 'AAPLx', 'GOOGLx', 'MSFTx', 'AMZNx', 'TSMx', 'PRIVx']);
  assert.deepEqual(res.json.stocks.map((s2) => s2.rank), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(res.json.stocks.map((s2) => s2.isTop5), [true, true, true, true, true, false, false]);

  const nvda = res.json.stocks[0];
  assert.equal(nvda.mint, NVDA);
  assert.equal(nvda.name, 'NVIDIA');
  assert.equal(nvda.logo, 'https://x/NVDAx.png', 'icon maps to logo');
  assert.equal(nvda.yahooSymbol, 'NVDA', 'the ticker mapping comes from the seed file');
  assert.equal(nvda.priceUsd, 232.09);
  assert.equal(nvda.underlyingMcap, 5_562_502_920_000, 'stockData.mcap is already whole USD');
  assert.equal(nvda.liquidityUsd, 1903936);
  assert.equal(res.json.stocks.find((x) => x.symbol === 'PRIVx').yahooSymbol, null, 'no listing, no ticker');

  // Cached: a second read does not hit Jupiter again.
  const before = s.deps.calls.search;
  await get(s.port, '/api/universe');
  assert.equal(s.deps.calls.search, before, 'the universe is cached for an hour');
});

test('the universe falls back to the seed file when Jupiter is down', async (t) => {
  const deps = makeDeps({
    jupiter: {
      async searchXStocks() {
        throw new Error('jupiter is having a day');
      },
      async prices() {
        return {};
      },
    },
  });
  const s = await makeServer({ deps });
  t.after(() => s.close());

  const res = await get(s.port, '/api/universe');
  assert.equal(res.status, 200, 'a third-party outage is not a 500');
  assert.equal(res.json.source, 'seed');
  assert.equal(res.json.stale, true, 'stale data is labelled stale');
  assert.equal(res.json.stocks.length, 20);
  assert.equal(res.json.stocks[0].symbol, 'NVDAx');
});

test('GET /api/universe/:symbol/history serves candles, falls back, and validates', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  const yahoo = await get(s.port, '/api/universe/NVDAx/history?range=1mo');
  assert.equal(yahoo.status, 200);
  assert.equal(yahoo.json.symbol, 'NVDAx');
  assert.equal(yahoo.json.yahooSymbol, 'NVDA');
  assert.equal(yahoo.json.range, '1mo');
  assert.equal(yahoo.json.source, 'yahoo');
  assert.equal(yahoo.json.kind, 'candles');
  assert.equal(yahoo.json.candles.length, 2, 'the unprinted day is dropped, not zero-filled');
  assert.deepEqual(yahoo.json.candles[0], { t: 1756944000, o: 229.1, h: 233.4, l: 228.0, c: 232.09, v: 140000000 });
  assert.ok(s.deps.calls.fetch.some((u) => u.includes('range=1mo&interval=1d')));

  const line = await get(s.port, '/api/universe/PRIVx/history?range=3mo');
  assert.equal(line.status, 200);
  assert.equal(line.json.yahooSymbol, null);
  assert.equal(line.json.source, 'coingecko');
  assert.equal(line.json.kind, 'line', 'close-only data is not dressed up as candles');
  assert.equal(line.json.candles.length, 2);
  assert.equal(line.json.candles[0].c, 12.1);
  assert.ok(line.json.note.includes('no listed equity ticker'));
  assert.ok(s.deps.calls.fetch.some((u) => u.includes(`/contract/${PRIVATE}/market_chart/`) && u.includes('days=90')));

  assert.equal((await get(s.port, '/api/universe/NVDAx/history?range=5y')).status, 400);
  assert.equal((await get(s.port, '/api/universe/NVDAx/history?range=5y')).json.error, 'bad_range');
  assert.equal((await get(s.port, '/api/universe/NOPEx/history')).status, 404);
  assert.equal((await get(s.port, '/api/universe/NOPEx/history')).json.error, 'unknown_symbol');
  assert.equal((await get(s.port, '/api/universe/%20%20/history')).json.error, 'bad_symbol');

  const defaulted = await get(s.port, '/api/universe/AAPLx/history');
  assert.equal(defaulted.json.range, '1mo', 'range defaults to 1mo');
});

test('GET /api/stats and /api/vault before launch', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  const stats = await get(s.port, '/api/stats');
  assert.equal(stats.status, 200);
  assert.equal(stats.json.launched, false);
  assert.equal(stats.json.mode, 'READ_ONLY');
  assert.equal(stats.json.eligibleHolders, null, 'there is no token, so there are no holders to count');
  assert.equal(stats.json.prefHolders, 0);
  assert.equal(stats.json.demandBasis, 'equal-weight');
  assert.deepEqual(stats.json.demand, [], 'nobody has saved picks yet, so demand is empty, not invented');
  assert.deepEqual(stats.json.rounds, {
    count: 0,
    totalSolDistributed: 0,
    distributedRounds: 0,
    lastAt: null,
    lastDistributedAt: null,
    simulated: { rounds: 0, totalSol: 0, totalLamports: '0' },
  });
  assert.equal(stats.json.vault.balanceSol, 2.5);
  assert.equal(stats.json.vault.balanceUsd, 500);
  assert.equal(stats.json.solPriceUsd, 200);

  const vault = await get(s.port, '/api/vault');
  assert.equal(vault.status, 200);
  assert.equal(vault.json.address, VAULT_ADDRESS);
  assert.equal(vault.json.balanceSol, 2.5);
  assert.equal(vault.json.reserveSol, 0.05);
  assert.equal(vault.json.poolSol, 2.45);
  assert.deepEqual(vault.json.holdings, []);
  assert.ok(Date.parse(vault.json.updatedAt) > 0);
});

test('GET /api/vault reports carry-over dust with its ticker', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  await s.db.setKV('carry', [{ mint: NVDA, amountRaw: '12345678' }, { mint: AAPL, amountRaw: '0' }]);
  const vault = await get(s.port, '/api/vault');
  assert.equal(vault.json.holdings.length, 1, 'zero dust is not a holding');
  assert.deepEqual(vault.json.holdings[0], {
    symbol: 'NVDAx',
    mint: NVDA,
    amountRaw: '12345678',
    amountUi: 0.12345678,
    decimals: 8,
  });
});

test('GET /api/prefs/:wallet and /api/holders', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  const wallet = newWallet().address;
  const empty = await get(s.port, `/api/prefs/${wallet}`);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json, { wallet, picks: null, default: true });

  const bad = await get(s.port, '/api/prefs/not-a-wallet');
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'bad_wallet');
  assert.equal(bad.json.detail, 'wallet must be a 0x EVM address');

  // One address, one account: a prefs read in a different case finds the same row.
  const mixed = await get(s.port, `/api/prefs/${wallet.toLowerCase()}`);
  assert.equal(mixed.status, 200);
  assert.equal(mixed.json.wallet, wallet, 'the canonical EIP-55 spelling comes back');
  assert.equal(
    (await get(s.port, '/api/prefs/769fv6KK6SAQ5FBAXdUZLdrppdHn5CqqgJBpFCLyf9up')).json.error,
    'bad_wallet',
    'a Solana address is not a wallet here',
  );

  const holders = await get(s.port, '/api/holders');
  assert.equal(holders.status, 200);
  assert.deepEqual(holders.json, { items: [], total: 0, limit: 100, offset: 0 });

  assert.equal((await get(s.port, '/api/holders?limit=0')).json.error, 'bad_query');
  assert.equal((await get(s.port, '/api/holders?limit=abc')).json.error, 'bad_query');
  assert.equal((await get(s.port, '/api/holders?offset=-1')).json.error, 'bad_query');
  assert.equal((await get(s.port, '/api/holders?limit=5&offset=0')).status, 200);
});

test('GET /api/rounds and /api/rounds/preview work with no rounds and no token', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  const rounds = await get(s.port, '/api/rounds');
  assert.equal(rounds.status, 200);
  assert.deepEqual(rounds.json, { items: [], total: 0, limit: 50, offset: 0 });

  const missing = await get(s.port, '/api/rounds/r_2026-09-07T12');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, 'unknown_round');
  assert.equal((await get(s.port, '/api/rounds/what%20is%20this')).json.error, 'bad_round_id');

  const preview = await get(s.port, '/api/rounds/preview');
  assert.equal(preview.status, 200, preview.text);
  assert.equal(preview.json.simulated, true);
  assert.equal(preview.json.basis, 'no-token');
  assert.equal(preview.json.wouldSkip, 'no_token');
  assert.equal(preview.json.eligibleHolders, null);
  assert.equal(preview.json.poolSol, 2.45);
  assert.deepEqual(preview.json.top5, [NVDA, AAPL, GOOGL, MSFT, AMZN]);
  assert.deepEqual(preview.json.demand, []);
  assert.ok(preview.json.note.includes('has not launched'));
  assert.equal(s.deps.calls.rpc.some((c) => c.method !== 'getBalance'), false, 'no holder read is attempted without a mint');
});

test('unknown routes answer JSON, not HTML', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  const api = await get(s.port, '/api/does-not-exist');
  assert.equal(api.status, 404);
  assert.equal(api.headers['content-type']?.split(';')[0], 'application/json');
  assert.equal(api.json.error, 'not_found');

  const site = await get(s.port, '/nope');
  assert.equal(site.status, 404);
  assert.equal(site.json.error, 'not_found');

  const badJson = await request(s.port, 'POST', '/api/auth/nonce', {
    raw: '{not json',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.json.error, 'bad_json');
});

/* -------------------------------------------------------------- sign-in -- */

test('the full sign-in flow: nonce, signature, token, /api/me', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  const wallet = newWallet();
  const nonce = await request(s.port, 'POST', '/api/auth/nonce', { body: { wallet: wallet.address } });
  assert.equal(nonce.status, 200);
  assert.equal(nonce.json.wallet, wallet.address);
  assert.equal(
    nonce.json.message,
    buildSignInMessage({ wallet: wallet.address, nonce: nonce.json.nonce, issuedAt: nonce.json.issuedAt }),
  );
  assert.ok(
    nonce.json.message.startsWith(
      `${nonce.json.domain} wants you to sign in with your Ethereum account:\n${wallet.address}`,
    ),
    nonce.json.message,
  );
  assert.ok(nonce.json.message.includes('This is not a transaction.'));
  assert.ok(nonce.json.message.includes('Nothing leaves your wallet.'));
  assert.ok(nonce.json.message.includes(`Chain ID: ${nonce.json.chainId}`), nonce.json.message);
  assert.equal(nonce.json.chainId, 4663, 'Robinhood Chain mainnet');
  assert.equal(nonce.json.chainName, 'Robinhood Chain');
  assert.match(nonce.json.nonce, /^[0-9a-z]{24}$/, 'SIWE nonces are alphanumeric');
  assert.equal(Date.parse(nonce.json.expiresAt) - Date.parse(nonce.json.issuedAt), 10 * 60 * 1000);

  const verified = await request(s.port, 'POST', '/api/auth/verify', {
    body: { wallet: wallet.address, nonce: nonce.json.nonce, signature: wallet.sign(nonce.json.message) },
  });
  assert.equal(verified.status, 200, verified.text);
  assert.equal(verified.json.wallet, wallet.address);
  assert.match(verified.json.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(Date.parse(verified.json.expiresAt) - Date.now() > 6 * 24 * 3600 * 1000);

  const me = await get(s.port, '/api/me', { headers: { authorization: `Bearer ${verified.json.token}` } });
  assert.equal(me.status, 200);
  assert.deepEqual(me.json, verified.json.me, 'verify returns exactly what GET /api/me returns');
  assert.equal(me.json.wallet, wallet.address);
  assert.equal(me.json.balance, null, 'no coin, no balance');
  assert.equal(me.json.prefs, null);
  assert.equal(me.json.picksSource, 'default');
  assert.equal(me.json.projected.shareBps, null);

  // THE HONEST PART. Sign-in is EVM; holders, eligibility and payouts are
  // still Solana. The document says so in as many words and never offers an
  // eligible state or a balance.
  const attribution = me.json.attribution;
  assert.equal(attribution.signInChain, 'evm');
  assert.equal(attribution.signInChainId, 4663);
  assert.equal(attribution.signInChainName, 'Robinhood Chain');
  assert.equal(attribution.payoutChain, 'solana');
  assert.equal(attribution.chainsMatch, false);
  assert.equal(attribution.tokenSet, false);
  assert.equal(attribution.balanceRead, false);
  assert.equal(attribution.eligible, false, 'never true while the chains disagree');
  assert.equal(attribution.canReceive, false);
  assert.ok(attribution.note.includes('Robinhood Chain'), attribution.note);
  assert.ok(attribution.note.includes('Solana'), attribution.note);
  assert.ok(attribution.note.includes('the token is not set'), attribution.note);
  assert.equal(me.json.projected.note, attribution.note, 'one explanation, not two');
  assert.equal(me.json.cycle.eligible, null, 'unknown, never false-as-verdict and never true');
  assert.deepEqual(
    me.json.effectivePicks.map((p) => [p.symbol, p.pct]),
    [['AAPLx', 20], ['AMZNx', 20], ['GOOGLx', 20], ['MSFTx', 20], ['NVDAx', 20]],
    'the default basket is the top 5 at 20% each',
  );
});

test('sign-in rejects a wrong signature, a wrong wallet, a reused nonce and an expired one', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  const wallet = newWallet();
  const other = newWallet();

  // wrong signature (signed by another key)
  const n1 = await request(s.port, 'POST', '/api/auth/nonce', { body: { wallet: wallet.address } });
  const wrongSig = await request(s.port, 'POST', '/api/auth/verify', {
    body: { wallet: wallet.address, nonce: n1.json.nonce, signature: other.sign(n1.json.message) },
  });
  assert.equal(wrongSig.status, 401);
  assert.equal(wrongSig.json.error, 'bad_signature');

  // that nonce is now burned even though the attempt failed
  const replayFailed = await request(s.port, 'POST', '/api/auth/verify', {
    body: { wallet: wallet.address, nonce: n1.json.nonce, signature: wallet.sign(n1.json.message) },
  });
  assert.equal(replayFailed.status, 400);
  assert.equal(replayFailed.json.error, 'bad_nonce');

  // a nonce issued for one wallet cannot be redeemed by another
  const n2 = await request(s.port, 'POST', '/api/auth/nonce', { body: { wallet: wallet.address } });
  const message2 = buildSignInMessage({ wallet: other.address, nonce: n2.json.nonce, issuedAt: n2.json.issuedAt });
  const wrongWallet = await request(s.port, 'POST', '/api/auth/verify', {
    body: { wallet: other.address, nonce: n2.json.nonce, signature: other.sign(message2) },
  });
  assert.equal(wrongWallet.status, 400);
  assert.equal(wrongWallet.json.error, 'bad_nonce', 'the nonce belongs to the first wallet');

  // reuse of a successful nonce
  const good = await signIn(s.port);
  const reuse = await request(s.port, 'POST', '/api/auth/verify', {
    body: { wallet: good.wallet.address, nonce: good.nonce.nonce, signature: good.wallet.sign(good.nonce.message) },
  });
  assert.equal(reuse.status, 400);
  assert.equal(reuse.json.error, 'bad_nonce');

  // an expired nonce: the issue time is inside the nonce, so we can forge an old one
  const stale = `${(Date.now() - 11 * 60 * 1000).toString(36).padStart(8, '0')}${'a'.repeat(16)}`;
  const expired = await request(s.port, 'POST', '/api/auth/verify', {
    body: { wallet: wallet.address, nonce: stale, signature: wallet.sign('anything') },
  });
  assert.equal(expired.status, 400);
  assert.equal(expired.json.error, 'nonce_expired');

  // malformed input
  assert.equal((await request(s.port, 'POST', '/api/auth/nonce', { body: { wallet: 'nope' } })).json.error, 'bad_wallet');
  assert.equal((await request(s.port, 'POST', '/api/auth/nonce', { body: {} })).json.error, 'bad_wallet');
  assert.equal((await request(s.port, 'POST', '/api/auth/nonce', { body: [] })).json.error, 'bad_request');
  assert.equal(
    (await request(s.port, 'POST', '/api/auth/verify', { body: { wallet: wallet.address, nonce: '' } })).json.error,
    'bad_nonce',
  );
  assert.equal(
    (await request(s.port, 'POST', '/api/auth/verify', { body: { wallet: wallet.address, nonce: 'xy' } })).json.error,
    'bad_signature',
    'a missing signature is refused before anything else is checked',
  );
});

test('/api/me requires a valid Bearer token', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  for (const headers of [{}, { authorization: 'Bearer nonsense' }, { authorization: 'Basic abc' }]) {
    const res = await get(s.port, '/api/me', { headers });
    assert.equal(res.status, 401);
    assert.equal(res.json.error, 'unauthorized');
  }
  const put = await request(s.port, 'PUT', '/api/me/prefs', { body: { picks: [] } });
  assert.equal(put.status, 401);
});

/* ---------------------------------------------------------------- prefs -- */

test('PUT /api/me/prefs validates every documented failure and round-trips a save', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  const { wallet, token } = await signIn(s.port);
  const auth = { authorization: `Bearer ${token}` };
  const put = (picks, extra = {}) => request(s.port, 'PUT', '/api/me/prefs', { headers: auth, body: { picks, ...extra } });

  const cases = [
    { code: 'count', picks: [{ mint: NVDA, pct: 100 }] },
    { code: 'count', picks: [] },
    { code: 'count', picks: [{ mint: NVDA, pct: 20 }, { mint: AAPL, pct: 20 }, { mint: GOOGL, pct: 20 }, { mint: MSFT, pct: 20 }, { mint: AMZN, pct: 10 }, { mint: TSLA, pct: 10 }] },
    { code: 'range', picks: [{ mint: NVDA, pct: 70 }, { mint: AAPL, pct: 30 }] },
    { code: 'range', picks: [{ mint: NVDA, pct: 95 }, { mint: AAPL, pct: 5 }] },
    { code: 'range', picks: [{ mint: NVDA, pct: 50.5 }, { mint: AAPL, pct: 49.5 }] },
    { code: 'sum', picks: [{ mint: NVDA, pct: 50 }, { mint: AAPL, pct: 40 }] },
    { code: 'not_in_universe', picks: [{ mint: 'SomeOtherMintThatIsNotListed11111111111111', pct: 50 }, { mint: AAPL, pct: 50 }] },
    { code: 'not_in_universe', picks: [{ mint: THIN, pct: 50 }, { mint: AAPL, pct: 50 }] },
    { code: 'duplicate', picks: [{ mint: NVDA, pct: 50 }, { mint: NVDA, pct: 50 }] },
  ];

  for (const testCase of cases) {
    const res = await put(testCase.picks);
    assert.equal(res.status, 400, JSON.stringify(testCase));
    assert.equal(res.json.error, 'invalid_picks', JSON.stringify(testCase));
    assert.equal(res.json.code, testCase.code, `${JSON.stringify(testCase.picks)} -> ${res.json.code}`);
    assert.equal(typeof res.json.detail, 'string');
  }

  assert.equal((await put('nope')).json.code, 'count', 'picks must be an array');
  assert.equal((await request(s.port, 'PUT', '/api/me/prefs', { headers: auth, body: [] })).json.error, 'bad_request');
  assert.equal(
    (await put([{ mint: NVDA, pct: 60 }, { mint: AAPL, pct: 40 }], { signature: 'x'.repeat(500) })).json.error,
    'bad_request',
  );

  // the good case
  const saved = await put([{ mint: AAPL, pct: 40 }, { mint: NVDA, pct: 60 }], { signature: 'sig', message: 'msg' });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.json.picks, [
    { mint: NVDA, symbol: 'NVDAx', pct: 60 },
    { mint: AAPL, symbol: 'AAPLx', pct: 40 },
  ], 'normalised and sorted by weight');
  assert.equal(saved.json.wallet, wallet.address);
  assert.equal(saved.json.signature, 'sig');
  assert.ok(Date.parse(saved.json.updatedAt) > 0);

  // publicly readable, exactly as stored
  const publicRead = await get(s.port, `/api/prefs/${wallet.address}`);
  assert.equal(publicRead.status, 200);
  assert.deepEqual(publicRead.json, saved.json);

  // and it shows up in the public list and in /api/me
  const holders = await get(s.port, '/api/holders');
  assert.equal(holders.json.total, 1);
  assert.deepEqual(holders.json.items[0].picks, saved.json.picks);
  assert.deepEqual(Object.keys(holders.json.items[0]).sort(), ['picks', 'updatedAt', 'wallet']);

  const me = await get(s.port, '/api/me', { headers: auth });
  assert.equal(me.json.picksSource, 'prefs');
  assert.deepEqual(me.json.effectivePicks, saved.json.picks);

  // and it can be removed again
  const removed = await request(s.port, 'DELETE', '/api/me/prefs', { headers: auth });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json, { ok: true });
  assert.deepEqual((await get(s.port, `/api/prefs/${wallet.address}`)).json, {
    wallet: wallet.address,
    picks: null,
    default: true,
  });
  assert.equal((await get(s.port, '/api/holders')).json.total, 0);
});

test('community demand is equal-weight before launch and always sums to exactly 100', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  // Three wallets, three baskets: every stock earns 100 weight, which is a
  // third each. Largest-remainder has to hand out 34/33/33, not 33/33/33.
  const wallets = [newWallet().address, newWallet().address, newWallet().address];
  await s.db.setPrefs({ wallet: wallets[0], picks: [{ mint: NVDA, symbol: 'NVDAx', pct: 60 }, { mint: AAPL, symbol: 'AAPLx', pct: 40 }] });
  await s.db.setPrefs({ wallet: wallets[1], picks: [{ mint: AAPL, symbol: 'AAPLx', pct: 60 }, { mint: GOOGL, symbol: 'GOOGLx', pct: 40 }] });
  await s.db.setPrefs({ wallet: wallets[2], picks: [{ mint: GOOGL, symbol: 'GOOGLx', pct: 60 }, { mint: NVDA, symbol: 'NVDAx', pct: 40 }] });

  const stats = await get(s.port, '/api/stats');
  assert.equal(stats.json.prefHolders, 3);
  assert.equal(stats.json.demandBasis, 'equal-weight');
  assert.equal(stats.json.demand.reduce((acc, d) => acc + d.pct, 0), 100);
  assert.deepEqual(stats.json.demand.map((d) => d.symbol).sort(), ['AAPLx', 'GOOGLx', 'NVDAx']);
  assert.deepEqual(stats.json.demand.map((d) => d.pct).sort((a, b) => b - a), [34, 33, 33]);

  const preview = await get(s.port, '/api/rounds/preview');
  assert.equal(preview.json.demand.reduce((acc, d) => acc + d.pct, 0), 100);
  assert.equal(preview.json.demandContributors, 3);

  // A pick for a stock that is no longer listed does not create phantom demand.
  await s.db.setPrefs({ wallet: newWallet().address, picks: [{ mint: 'DelistedMint111111111111111111111111111111', symbol: 'GONEx', pct: 100 }] });
  const after = await get(s.port, '/api/stats');
  assert.equal(after.json.demand.reduce((acc, d) => acc + d.pct, 0), 100);
  assert.equal(after.json.demandContributors, 3, 'the wallet with only a delisted pick contributes nothing');
  assert.equal(after.json.prefHolders, 4);
});

/* ---------------------------------------------------------------- admin -- */

test('admin routes are off without a key and gated with one', async (t) => {
  const off = await makeServer();
  t.after(() => off.close());

  for (const [method, route] of [['POST', '/api/admin/round/run'], ['POST', '/api/admin/universe/refresh'], ['GET', '/api/admin/status']]) {
    const res = await request(off.port, method, route, { headers: { 'x-admin-key': 'anything' } });
    assert.equal(res.status, 503, `${method} ${route}`);
    assert.equal(res.json.error, 'admin_disabled');
  }

  const on = await makeServer({ env: { ADMIN_KEY: 'the-real-key' } });
  t.after(() => on.close());

  assert.equal((await get(on.port, '/api/admin/status')).status, 401);
  assert.equal((await get(on.port, '/api/admin/status')).json.error, 'unauthorized');
  assert.equal((await get(on.port, '/api/admin/status', { headers: { 'x-admin-key': 'wrong' } })).status, 401);
  assert.equal((await get(on.port, '/api/admin/status', { headers: { 'x-admin-key': 'the-real-key-longer' } })).status, 401);

  const status = await get(on.port, '/api/admin/status', { headers: { 'x-admin-key': 'the-real-key' } });
  assert.equal(status.status, 200, status.text);
  assert.equal(status.json.config.mode, 'READ_ONLY');
  assert.equal(status.json.config.hasAdminKey, true);
  assert.equal(status.json.rounds.latest, null);
  assert.equal(typeof status.json.keeper.loaded, 'boolean');
  assert.equal(
    JSON.stringify(status.json).includes('the-real-key'),
    false,
    'the admin key is never echoed back',
  );

  const refreshed = await request(on.port, 'POST', '/api/admin/universe/refresh', { headers: { 'x-admin-key': 'the-real-key' } });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.json.source, 'jupiter');
  assert.equal(refreshed.json.count, 7);
});

test('POST /api/admin/round/run reaches the keeper when one is loaded', async (t) => {
  const calls = [];
  const deps = makeDeps({
    keeper: {
      async runRound(args) {
        calls.push(args?.reason);
        return { id: 'r_2026-09-07T12', status: 'SKIPPED', skipReason: 'no_token', simulated: true };
      },
      async status() {
        return { state: 'idle', nextRunAt: null };
      },
    },
  });
  const s = await makeServer({ env: { ADMIN_KEY: 'k' }, deps });
  t.after(() => s.close());

  const res = await request(s.port, 'POST', '/api/admin/round/run', { headers: { 'x-admin-key': 'k' } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.skipReason, 'no_token');
  assert.deepEqual(calls, ['admin']);

  const status = await get(s.port, '/api/admin/status', { headers: { 'x-admin-key': 'k' } });
  assert.deepEqual(status.json.keeper.status, { state: 'idle', nextRunAt: null });
  assert.equal(status.json.keeper.canRun, true);
});

/* ----------------------------------------------------------------- CORS -- */

test('CORS headers are present for browsers and preflights', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  const simple = await get(s.port, '/api/health', { headers: { origin: 'https://stockdrop.vercel.app' } });
  assert.equal(simple.status, 200);
  assert.equal(simple.headers['access-control-allow-origin'], '*');

  const noOrigin = await get(s.port, '/api/health');
  assert.equal(noOrigin.headers['access-control-allow-origin'], '*', 'a wildcard config always sends the header');

  const preflight = await request(s.port, 'OPTIONS', '/api/me/prefs', {
    headers: {
      origin: 'https://stockdrop.vercel.app',
      'access-control-request-method': 'PUT',
      'access-control-request-headers': 'authorization,content-type',
    },
  });
  assert.ok(preflight.status === 204 || preflight.status === 200, `preflight status ${preflight.status}`);
  assert.equal(preflight.headers['access-control-allow-origin'], '*');
  assert.ok(preflight.headers['access-control-allow-methods'].includes('PUT'));
  assert.ok(preflight.headers['access-control-allow-headers'].toLowerCase().includes('authorization'));

  const locked = await makeServer({ env: { CORS_ORIGIN: 'https://stockdrop.vercel.app' } });
  t.after(() => locked.close());
  const allowed = await get(locked.port, '/api/health', { headers: { origin: 'https://stockdrop.vercel.app' } });
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://stockdrop.vercel.app');
  const denied = await get(locked.port, '/api/health', { headers: { origin: 'https://evil.example' } });
  assert.equal(denied.headers['access-control-allow-origin'], undefined, 'a foreign origin gets no grant');
});

/* -------------------------------------------------------------- holders -- */

const MEME_MINT = 'Meme1111111111111111111111111111111111111111';

/** The 40 bytes an RPC returns for dataSlice{offset:32,length:40}: owner || amount LE. */
function accountSlice(owner, amount) {
  const buf = Buffer.alloc(40);
  Buffer.from(b58decode(owner)).copy(buf, 0);
  buf.writeBigUInt64LE(BigInt(amount), 32);
  return buf.toString('base64');
}

const gpaRow = (owner, amount) => ({ pubkey: 'ata', account: { data: [accountSlice(owner, amount), 'base64'] } });

test('holder snapshots aggregate per owner and stay empty before launch', async () => {
  const holderA = newSolanaAddress();
  const holderB = newSolanaAddress();

  assert.deepEqual(parseAccountSlice(accountSlice(holderA, 5n)), { wallet: holderA, balance: 5n });
  assert.equal(parseAccountSlice('short'), null);
  assert.deepEqual(
    aggregate([{ wallet: holderA, balance: 2n }, { wallet: holderA, balance: 3n }, { wallet: holderB, balance: 9n }]),
    [{ wallet: holderB, balance: '9' }, { wallet: holderA, balance: '5' }],
  );

  // No mint: nothing is read from the chain at all.
  const quiet = [];
  const blank = createHoldersService({
    cfg: buildConfig({ TOKEN_MINT: '' }),
    deps: { rpc: { async call(method) { quiet.push(method); throw new Error('should not be called'); } } },
  });
  assert.deepEqual(await blank.list(), []);
  assert.equal(await blank.supply(), null);
  assert.equal(await blank.balanceOf(holderA), null);
  const emptySnapshot = await blank.snapshot();
  assert.deepEqual(emptySnapshot.holders, []);
  assert.equal(emptySnapshot.launched, false);
  assert.equal(emptySnapshot.source, 'no-token');
  assert.deepEqual(quiet, [], 'a blank TOKEN_MINT never reaches the RPC');

  // With a mint: getProgramAccounts, two accounts for the same owner.
  const seen = [];
  const service = createHoldersService({
    cfg: buildConfig({ TOKEN_MINT: MEME_MINT }),
    deps: {
      rpc: {
        async call(method, params) {
          seen.push({ method, params });
          if (method === 'getProgramAccounts') {
            return { context: { slot: 987 }, value: [gpaRow(holderA, 1n), gpaRow(holderB, 400n), gpaRow(holderA, 40n)] };
          }
          if (method === 'getTokenSupply') return { value: { amount: '1000000000000000', decimals: 6 } };
          throw new Error(`unexpected ${method}`);
        },
      },
    },
  });

  assert.deepEqual(await service.list(), [
    { wallet: holderB, balance: '400' },
    { wallet: holderA, balance: '41' },
  ]);

  const snapshot = await service.snapshot({ force: true });
  assert.equal(snapshot.tokenMint, MEME_MINT);
  assert.equal(snapshot.slot, 987);
  assert.equal(snapshot.supply, '1000000000000000');
  assert.equal(snapshot.source, 'rpc-getProgramAccounts');
  assert.equal(snapshot.holders.length, 2);
  assert.equal(snapshot.accounts, 3, 'three token accounts, two owners');

  const gpa = seen.find((c) => c.method === 'getProgramAccounts');
  assert.equal(gpa.params[0], 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  assert.deepEqual(gpa.params[1].dataSlice, { offset: 32, length: 40 });
  assert.deepEqual(gpa.params[1].filters[0], { dataSize: 165 });
  assert.deepEqual(gpa.params[1].filters[1], { memcmp: { offset: 0, bytes: MEME_MINT } });
});

test('a refused getProgramAccounts response is re-asked in owner-prefix partitions', async () => {
  const holder = newSolanaAddress();
  let single = 0;
  let partitioned = 0;
  const service = createHoldersService({
    cfg: buildConfig({ TOKEN_MINT: MEME_MINT }),
    deps: {
      rpc: {
        async call(method, params) {
          if (method === 'getTokenSupply') return { value: { amount: '1000000000000000' } };
          if (method !== 'getProgramAccounts') throw new Error(`unexpected ${method}`);
          const filters = params[1].filters;
          if (filters.length === 2) {
            single += 1;
            throw new Error('Response too large: use a filter');
          }
          partitioned += 1;
          const prefix = filters[2].memcmp.bytes;
          const wanted = b58encode(Uint8Array.of(b58decode(holder)[0]));
          return { context: { slot: 5 }, value: prefix === wanted ? [gpaRow(holder, 77n)] : [] };
        },
      },
    },
  });

  assert.deepEqual(await service.list(), [{ wallet: holder, balance: '77' }]);
  assert.equal(single, 1);
  assert.equal(partitioned, 256, 'every owner prefix is covered exactly once');
});

test('with a Helius key the DAS method is used and paged to the end', async () => {
  const owners = Array.from({ length: 1003 }, () => newSolanaAddress());
  const pages = [];
  const service = createHoldersService({
    cfg: buildConfig({ TOKEN_MINT: MEME_MINT, HELIUS_API_KEY: 'not-a-real-key' }),
    deps: {
      rpc: {
        async call(method, params) {
          if (method === 'getTokenSupply') return { value: { amount: '1000000000000000' } };
          if (method === 'getSlot') return 42;
          assert.equal(method, 'getTokenAccounts', 'the DAS method, not getProgramAccounts');
          assert.equal(params.mint, MEME_MINT);
          pages.push(params.page);
          const slice = owners.slice((params.page - 1) * 1000, params.page * 1000);
          return { token_accounts: slice.map((owner) => ({ owner, amount: '1000000', address: 'ata' })) };
        },
      },
    },
  });

  const snapshot = await service.snapshot();
  assert.deepEqual(pages, [1, 2], 'the second, short page ends the walk');
  assert.equal(snapshot.holders.length, 1003);
  assert.equal(snapshot.slot, 42);
  assert.equal(snapshot.source, 'helius-das');
  assert.ok(snapshot.holders.every((h) => h.balance === '1000000'));
});

/* ------------------------------------------------- the day after launch -- */

test('with a token mint, the Solana holder set is real and an EVM sign-in is still not in it', async (t) => {
  // The holders are Solana addresses, because that is what a Solana token has.
  // The person signing in has a Robinhood Wallet address, because that is what
  // this site now accepts. The two sets cannot intersect, and the API says so
  // instead of showing a zero balance as if it had looked one up.
  const holder = newSolanaAddress();
  const whale = newSolanaAddress();
  const signer = newWallet();

  const deps = makeDeps({
    rpc: {
      async call(method, params) {
        if (method === 'getBalance') return { value: 2_500_000_000 };
        if (method === 'getSlot') return 777;
        if (method === 'getTokenSupply') return { value: { amount: '1000000000000000', decimals: 6 } };
        if (method === 'getProgramAccounts') {
          return {
            context: { slot: 777 },
            value: [gpaRow(holder, 2_000_000_000_000n), gpaRow(whale, 8_000_000_000_000n)],
          };
        }
        if (method === 'getTokenAccountsByOwner') {
          const owner = params[0];
          const amount = owner === holder ? '2000000000000' : '0';
          return { value: [{ account: { data: { parsed: { info: { tokenAmount: { amount } } } } } }] };
        }
        throw new Error(`unexpected ${method}`);
      },
    },
  });
  const s = await makeServer({ env: { TOKEN_MINT: MEME_MINT, TOKEN_SYMBOL: 'DROP', TOKEN_NAME: 'Stoxvault' }, deps });
  t.after(() => s.close());

  const health = await get(s.port, '/api/health');
  assert.equal(health.json.tokenMint, MEME_MINT);

  // The Solana side still works exactly as before: two eligible holders.
  const stats = await get(s.port, '/api/stats');
  assert.equal(stats.json.launched, true);
  assert.equal(stats.json.eligibleHolders, 2);
  assert.equal(stats.json.demandBasis, 'holding-weighted');
  assert.deepEqual(stats.json.demand, [], 'no saved picks yet, so no community demand to report');

  // The signed-in wallet is not one of them, and /api/me refuses to pretend.
  const { token } = await signIn(s.port, signer);
  const me = await get(s.port, '/api/me', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.status, 200, me.text);
  assert.equal(me.json.wallet, signer.address);
  assert.equal(me.json.balance, null, 'no balance is shown for an address the token cannot be held by');
  assert.equal(me.json.attribution.tokenSet, true, 'the token IS set here');
  assert.equal(me.json.attribution.chainsMatch, false, 'but the chains still do not match');
  assert.equal(me.json.attribution.balanceRead, false, 'so nothing was read');
  assert.equal(me.json.attribution.eligible, false);
  assert.equal(me.json.attribution.canReceive, false);
  assert.ok(me.json.attribution.note.includes('cannot appear in a holder snapshot'), me.json.attribution.note);
  assert.ok(!me.json.attribution.note.includes('the token is not set'), 'with a mint set, that reason is dropped');
  assert.equal(me.json.projected.shareBps, null, 'no share is projected, not even zero');
  assert.equal(me.json.cycle.eligible, null);

  // Saving a basket still works — the preference is real and is kept — but it
  // carries no holding weight, and the numbers say that rather than hiding it.
  const saved = await request(s.port, 'PUT', '/api/me/prefs', {
    headers: { authorization: `Bearer ${token}` },
    body: { picks: [{ mint: NVDA, pct: 60 }, { mint: AAPL, pct: 40 }] },
  });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.wallet, signer.address);
  const weighted = await get(s.port, '/api/stats');
  assert.equal(weighted.json.prefHolders, 1, 'the basket is stored and counted as a saved basket');
  assert.deepEqual(weighted.json.demand, [], 'but it moves no community demand: this wallet holds nothing');

  const preview = await get(s.port, '/api/rounds/preview');
  assert.equal(preview.status, 200, preview.text);
  assert.equal(preview.json.basis, 'live-snapshot');
  assert.equal(preview.json.eligibleHolders, 2, 'the two Solana holders');
  assert.equal(preview.json.prefHolders, 0, 'neither of whom has saved a basket');
  assert.equal(preview.json.defaultHolders, 2);
  assert.equal(preview.json.snapshotSlot, 777);
  assert.equal(preview.json.demand.reduce((acc, d) => acc + d.pct, 0), 100);
  assert.equal(preview.json.simulated, true, 'a preview is always a simulation');
});

/* ------------------------------------------------------------ regressions */

test('balanceOf asks getTokenAccountsByOwner with exactly one filter key', async () => {
  const holder = newSolanaAddress();

  // The filter is an externally-tagged enum. Verified live against
  // api.mainnet-beta.solana.com: {mint, programId} together answers
  //   -32602 "Invalid parameter: invalid value: map, expected map with a single key"
  // while {mint} alone answers a real account list. Encode that in the shape.
  const params = tokenAccountsByOwnerParams(holder, MEME_MINT);
  assert.equal(params[0], holder);
  assert.deepEqual(Object.keys(params[1]), ['mint'], 'exactly one key, and it is the mint');
  assert.equal(params[1].mint, MEME_MINT);
  assert.equal(params[1].programId, undefined, 'programId must never travel with mint');
  assert.deepEqual(params[2], { encoding: 'jsonParsed', commitment: 'confirmed' });

  // And the service actually sends that shape. This RPC stub behaves like the
  // real node: a multi-key filter is a hard error, not an empty result.
  const seen = [];
  const service = createHoldersService({
    cfg: buildConfig({ TOKEN_MINT: MEME_MINT }),
    deps: {
      rpc: {
        async call(method, callParams) {
          assert.equal(method, 'getTokenAccountsByOwner');
          seen.push(callParams);
          const filter = callParams[1];
          if (Object.keys(filter).length !== 1) {
            throw new Error('getTokenAccountsByOwner: Invalid parameter: invalid value: map, expected map with a single key');
          }
          assert.equal(filter.mint, MEME_MINT);
          return {
            value: [
              { account: { data: { parsed: { info: { tokenAmount: { amount: '50000000000000' } } } } } },
              { account: { data: { parsed: { info: { tokenAmount: { amount: '1000000' } } } } } },
            ],
          };
        },
      },
    },
  });

  const balance = await service.balanceOf(holder);
  assert.notEqual(balance, null, 'a wallet holding 5% of supply is never told its balance is unreadable');
  assert.equal(balance.raw, '50000001000000', 'both token accounts are summed');
  assert.equal(balance.accounts, 2);
  assert.equal(seen.length, 1, 'one call is enough: filtering by mint covers both token programs');
  assert.deepEqual(Object.keys(seen[0][1]), ['mint']);
});

/** A round document as the keeper writes one, with per-holder rows everywhere. */
function heavyRound(id, { simulated, status, solSpentLamports, holders = 200, createdAt }) {
  const rows = Array.from({ length: holders }, (_, i) => ({
    wallet: `Holder${String(i).padStart(40, '0')}`,
    balance: String(1_000_000_000_000 + i),
  }));
  return {
    id,
    createdAt,
    scheduledAt: createdAt,
    startedAt: createdAt,
    finishedAt: createdAt,
    status,
    simulated,
    skipReason: null,
    poolLamports: '2450000000',
    reserveLamports: '50000000',
    top5: [NVDA, AAPL, GOOGL, MSFT, AMZN],
    universe: Array.from({ length: 20 }, (_, n) => ({ mint: `Mint${n}`, symbol: `S${n}`, rank: n + 1 })),
    snapshot: { takenAt: createdAt, slot: 1, tokenMint: MEME_MINT, hash: `h_${id}`, holders: rows },
    demand: [{ mint: NVDA, symbol: 'NVDAx', weight: '1', shareBps: 10000, solLamports: solSpentLamports }],
    swaps: [{ mint: NVDA, symbol: 'NVDAx', solLamports: solSpentLamports, quotedOut: '1', receivedRaw: '1', tx: null, status: 'DONE', error: null }],
    plan: {
      totalWeight: '1',
      spentLamports: solSpentLamports,
      remainderLamports: '0',
      holders: rows.map((r) => ({ wallet: r.wallet, balance: r.balance, source: 'default', picks: [{ mint: NVDA, pct: 100 }] })),
    },
    transfers: rows.map((r) => ({ wallet: r.wallet, mint: NVDA, symbol: 'NVDAx', amountRaw: '10', tx: null, status: 'DONE', error: null })),
    carryIn: [],
    carryOut: [],
    stats: { eligibleHolders: rows.length, transfersDone: rows.length, transfersFailed: 0, solSpentLamports },
    error: null,
  };
}

const iso = (hour) => new Date(Date.UTC(2026, 8, 6, hour)).toISOString();

test('simulated, failed and skipped rounds contribute zero SOL to the public total', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  // Four pre-launch dry runs: real Jupiter quotes, no swap, no transfer, and
  // solSpentLamports set to the whole pool because every simulated swap is DONE.
  for (let i = 0; i < 4; i++) {
    await s.db.createRound(heavyRound(`r_sim_${i}`, { simulated: true, status: 'DONE', solSpentLamports: '3950000000', createdAt: iso(i) }));
  }
  await s.db.createRound(heavyRound('r_failed', { simulated: false, status: 'FAILED', solSpentLamports: '1000000000', createdAt: iso(5) }));
  await s.db.createRound({ ...heavyRound('r_skipped', { simulated: false, status: 'SKIPPED', solSpentLamports: '0', createdAt: iso(6) }), skipReason: 'no_token' });

  const dryOnly = await get(s.port, '/api/stats');
  assert.equal(dryOnly.status, 200, dryOnly.text);
  assert.equal(dryOnly.json.rounds.count, 6, 'every round is still published');
  assert.equal(dryOnly.json.rounds.totalSolDistributed, 0, '15.8 simulated SOL is not 15.8 SOL distributed');
  assert.equal(dryOnly.json.rounds.distributedRounds, 0);
  assert.equal(dryOnly.json.rounds.lastDistributedAt, null);
  assert.equal(dryOnly.json.rounds.simulated.rounds, 4, 'the dry runs are reported, separately and labelled');
  assert.equal(dryOnly.json.rounds.simulated.totalSol, 15.8);
  assert.equal(dryOnly.json.rounds.simulated.totalLamports, '15800000000');

  // Go-live: one real round that really swapped and really sent.
  await s.db.createRound(heavyRound('r_real', { simulated: false, status: 'DONE', solSpentLamports: '2400000000', createdAt: iso(7) }));
  const live = await get(s.port, '/api/stats');
  assert.equal(live.json.rounds.totalSolDistributed, 2.4, 'only the real round counts');
  assert.equal(live.json.rounds.distributedRounds, 1);
  assert.equal(live.json.rounds.lastDistributedAt, iso(7));
  assert.equal(live.json.rounds.simulated.totalSol, 15.8, 'the dry-run figure never leaks into the headline');
  assert.equal(live.json.rounds.count, 7);

  // Repeating the call must not double-count anything: the aggregate is a
  // running total, not a re-scan.
  const again = await get(s.port, '/api/stats');
  assert.equal(again.json.rounds.totalSolDistributed, 2.4);
  assert.equal(again.json.rounds.simulated.totalSol, 15.8);
  assert.equal(again.json.rounds.distributedRounds, 1);
  assert.equal(again.json.rounds.simulated.rounds, 4);
});

test('a round that finishes after being counted as open is folded exactly once', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  await s.db.createRound({ ...heavyRound('r_open', { simulated: false, status: 'SWAPPING', solSpentLamports: '0', createdAt: iso(1) }), finishedAt: null });
  const open = await get(s.port, '/api/stats');
  assert.equal(open.json.rounds.totalSolDistributed, 0, 'a round in flight has distributed nothing yet');
  assert.equal(open.json.rounds.count, 1);

  await s.db.updateRound('r_open', { status: 'DONE', finishedAt: iso(2), stats: { solSpentLamports: '1500000000' } });
  const done = await get(s.port, '/api/stats');
  assert.equal(done.json.rounds.totalSolDistributed, 1.5);
  assert.equal(done.json.rounds.distributedRounds, 1);

  const repeat = await get(s.port, '/api/stats');
  assert.equal(repeat.json.rounds.totalSolDistributed, 1.5, 'counted once, not once per request');
  assert.equal(repeat.json.rounds.distributedRounds, 1);
});

test('GET /api/rounds carries no per-holder rows, while GET /api/rounds/:id is complete', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  await s.db.createRound(heavyRound('r_list', { simulated: true, status: 'DONE', solSpentLamports: '2450000000', holders: 1000, createdAt: iso(3) }));

  const list = await get(s.port, '/api/rounds');
  assert.equal(list.status, 200, list.text);
  assert.equal(list.json.items.length, 1);
  const item = list.json.items[0];

  assert.equal(item.transfers, undefined, 'no per-(wallet, mint) transfer rows');
  assert.equal(item.universe, undefined);
  assert.equal(item.snapshot.holders, undefined, 'no per-holder snapshot rows');
  assert.equal(item.plan.holders, undefined, 'no per-holder plan rows either — this is what OOMed /api/stats');
  assert.equal(item.plan.eligible, undefined);
  assert.equal(item.plan.contributorsByMint, undefined);

  // The counts survive, so the ledger page still says how big the round was.
  assert.equal(item.snapshot.holderCount, 1000);
  assert.equal(item.plan.holderCount, 1000);
  assert.equal(item.transferCount, 1000);
  assert.equal(item.universeSize, 20);
  assert.equal(item.plan.totalWeight, '1', 'the cheap scalars stay');
  assert.equal(item.stats.eligibleHolders, 1000);
  assert.equal(item.simulated, true);

  // No wallet address may appear anywhere in a list response.
  const text = JSON.stringify(list.json);
  assert.equal(text.includes('Holder0000'), false, 'not one holder address leaks into the list');
  assert.ok(text.length < 8_000, `a 1,000-holder round summarises small, got ${text.length} bytes`);

  // The full document is still served whole, so a round stays reproducible.
  const full = await get(s.port, '/api/rounds/r_list');
  assert.equal(full.status, 200, full.text);
  assert.equal(full.json.snapshot.holders.length, 1000);
  assert.equal(full.json.plan.holders.length, 1000);
  assert.equal(full.json.transfers.length, 1000);
  assert.equal(full.json.universe.length, 20);
});

/* -------------------------------------------------- anti-cheat / cycle -- */

/** A launched server whose chain answers with a fixed holder set. */
async function makeLaunchedServer({ holder, holderRaw = '2000000000000', whale, env = {} } = {}) {
  const deps = makeDeps({
    rpc: {
      async call(method, params) {
        if (method === 'getBalance') return { value: 2_500_000_000 };
        if (method === 'getSlot') return 777;
        if (method === 'getTokenSupply') return { value: { amount: '1000000000000000', decimals: 6 } };
        if (method === 'getProgramAccounts') {
          return {
            context: { slot: 777 },
            value: [gpaRow(holder, BigInt(holderRaw)), gpaRow(whale, 8_000_000_000_000n)],
          };
        }
        if (method === 'getTokenAccountsByOwner') {
          const owner = params[0];
          const amount = owner === holder ? holderRaw : owner === whale ? '8000000000000' : '0';
          return { value: [{ account: { data: { parsed: { info: { tokenAmount: { amount } } } } } }] };
        }
        throw new Error(`unexpected ${method}`);
      },
    },
  });
  return makeServer({ env: { TOKEN_MINT: MEME_MINT, TOKEN_SYMBOL: 'DROP', ...env }, deps });
}

const minutesAgo = (min) => new Date(Date.now() - min * 60_000).toISOString();

test('the anti-cheat settings are parsed, clamped and published in /api/config', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  assert.equal(s.cfg.antiCheat, true, 'anti-cheat defaults on');
  assert.equal(s.cfg.openSnapshotWindowMin, 60);
  assert.equal(s.cfg.rules.antiCheat, true);
  assert.equal(s.cfg.rules.openSnapshotWindowMin, 60);
  assert.equal(s.cfg.safeSummary().antiCheat, true);
  assert.equal(s.cfg.safeSummary().openSnapshotWindowMin, 60);

  const config = await get(s.port, '/api/config');
  assert.equal(config.status, 200);
  assert.equal(config.json.rules.antiCheat, true);
  assert.equal(config.json.rules.openSnapshotWindowMin, 60);
  // every documented field of /api/config is still there
  assert.equal(config.json.rules.minPicks, 2);
  assert.equal(config.json.rules.eligibleBps, 10);
  assert.equal(config.json.rules.jitterMin, 10);
  assert.equal(config.json.token.launched, false);
  assert.equal(config.json.vault.address, VAULT_ADDRESS);
  assert.ok(config.json.defaultBasket);

  const off = buildConfig({ ANTICHEAT: '0', OPEN_SNAPSHOT_WINDOW_MIN: '90' });
  assert.equal(off.antiCheat, false);
  assert.equal(off.rules.antiCheat, false);
  assert.equal(off.openSnapshotWindowMin, 90);

  assert.equal(buildConfig({ OPEN_SNAPSHOT_WINDOW_MIN: '1' }).openSnapshotWindowMin, 5, 'clamped up to five minutes');
  assert.equal(buildConfig({ OPEN_SNAPSHOT_WINDOW_MIN: '-30' }).openSnapshotWindowMin, 5);
  assert.equal(
    buildConfig({ OPEN_SNAPSHOT_WINDOW_MIN: '9999' }).openSnapshotWindowMin,
    360,
    'never longer than the 6h round interval',
  );
  assert.equal(
    buildConfig({ OPEN_SNAPSHOT_WINDOW_MIN: '9999', ROUND_INTERVAL_HOURS: '1' }).openSnapshotWindowMin,
    60,
    'the clamp follows the configured interval',
  );
  assert.equal(buildConfig({ OPEN_SNAPSHOT_WINDOW_MIN: 'soon' }).openSnapshotWindowMin, 60, 'nonsense falls back to the default');

  const stats = await get(s.port, '/api/stats');
  assert.equal(stats.json.antiCheat, true, '/api/stats says whether the rule is on');
  assert.equal(stats.json.openSnapshotWindowMin, 60);
  assert.equal(stats.json.rounds.totalSolDistributed, 0, 'and the distributed total is untouched');
});

test('/api/me reports an honest cycle before launch', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  const { token, me: verified } = await signIn(s.port);
  const me = await get(s.port, '/api/me', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.status, 200, me.text);
  const cycle = me.json.cycle;
  assert.ok(cycle, '/api/me carries a cycle object');
  assert.equal(cycle.antiCheat, true);
  assert.equal(cycle.windowMin, 60);
  assert.equal(Date.parse(cycle.nextRoundAt) - Date.parse(cycle.opensAt), 60 * 60_000, 'the window opens an hour before the mark');
  assert.equal(cycle.inOpenSnapshot, null, 'no snapshot is invented when there is no token');
  assert.equal(cycle.openSnapshotAt, null);
  assert.equal(cycle.openBalanceRaw, null);
  assert.equal(cycle.currentBalanceRaw, null);
  assert.equal(cycle.effectiveBalanceRaw, null);
  assert.equal(cycle.eligible, null, 'eligibility is unknown, not false');
  assert.equal(cycle.thresholdRaw, '1000000000000');
  assert.equal(cycle.note, me.json.attribution.note, 'the cycle note is the attribution note: one story');
  assert.ok(cycle.note.includes('the token is not set'), cycle.note);
  assert.deepEqual(verified.cycle, cycle, 'verify returns the same cycle as GET /api/me');
});

test('a launched server still attributes nothing to a Robinhood Wallet address', async (t) => {
  // The token exists, the snapshots are real, two Solana wallets are eligible —
  // and the wallet that actually signed in is on another chain entirely. This is
  // the state the site ships in, and the API must not soften it.
  const holder = newSolanaAddress();
  const whale = newSolanaAddress();
  const s = await makeLaunchedServer({ holder, whale });
  t.after(() => s.close());

  const signer = newWallet();
  const { token } = await signIn(s.port, signer);
  const auth = { authorization: `Bearer ${token}` };

  // Even with a genuine opening snapshot in the store, the EVM address is not in
  // it and never can be, so no verdict is offered.
  await s.db.setKV('snapshot:open', {
    takenAt: minutesAgo(5),
    hash: 'open_hash',
    holders: [{ wallet: holder, balance: '1500000000000' }, { wallet: whale, balance: '8000000000000' }],
  });

  const me = (await get(s.port, '/api/me', { headers: auth })).json;
  assert.equal(me.balance, null);
  assert.equal(me.cycle.eligible, null, 'not false-as-verdict, and certainly not true');
  assert.equal(me.cycle.currentBalanceRaw, null, 'nothing was read, so nothing is reported');
  assert.equal(me.cycle.openSnapshotAt, null, 'a snapshot this wallet cannot be in is not quoted at it');
  assert.equal(me.projected.shareBps, null);
  assert.equal(me.attribution.canReceive, false);
  assert.ok(me.attribution.note.includes('Solana'), me.attribution.note);

  // The Solana side of the same server is untouched and still honest about itself.
  assert.equal((await get(s.port, '/api/stats')).json.eligibleHolders, 2);
});

test('buildAttribution names each reason once, and drops it when it stops being true', () => {
  const notLaunched = buildAttribution(buildConfig({}));
  assert.equal(notLaunched.tokenSet, false);
  assert.equal(notLaunched.chainsMatch, false);
  assert.equal(notLaunched.balanceRead, false);
  assert.equal(notLaunched.eligible, false);
  assert.equal(notLaunched.canReceive, false);
  assert.equal(notLaunched.signInChainId, 4663);
  assert.ok(notLaunched.note.includes('Robinhood Chain address (chain 4663)'), notLaunched.note);
  assert.ok(notLaunched.note.includes('the token is not set'), notLaunched.note);

  const launched = buildAttribution(buildConfig({ TOKEN_MINT: MEME_MINT }));
  assert.equal(launched.tokenSet, true);
  assert.equal(launched.chainsMatch, false, 'a mint does not make the chains match');
  assert.equal(launched.balanceRead, false);
  assert.ok(!launched.note.includes('the token is not set'), launched.note);
  assert.ok(launched.note.includes('cannot appear in a holder snapshot'), launched.note);

  // A different sign-in chain is named, not hard-coded.
  const testnet = buildAttribution(buildConfig({ AUTH_CHAIN_ID: '46630', AUTH_CHAIN_NAME: 'Robinhood Chain testnet' }));
  assert.equal(testnet.signInChainId, 46630);
  assert.ok(testnet.note.includes('Robinhood Chain testnet address (chain 46630)'), testnet.note);
});

test('buildCycle still decides every anti-cheat case, for the day the payout side moves', () => {
  // The full-cycle rule is not going away — it is simply unreachable through
  // /api/me while sign-in and payout are on different chains. Testing the pure
  // function keeps every branch covered instead of quietly losing it.
  const cfg = buildConfig({ TOKEN_MINT: MEME_MINT, TOKEN_SYMBOL: 'DROP' });
  const wallet = newSolanaAddress();
  const whale = newSolanaAddress();
  const nowMs = Date.now();
  const bal = (raw) => ({ raw, ui: Number(raw) / 1e6 });
  const snap = (holders) => ({ takenAt: minutesAgo(5), hash: 'open_hash', holders });
  const run = (balance, openSnapshot) => buildCycle({ cfg, wallet, balance, openSnapshot, nowMs });

  // 1. the keeper has not opened this cycle's snapshot yet
  const pending = run(bal('2000000000000'), null);
  assert.equal(pending.currentBalanceRaw, '2000000000000');
  assert.equal(pending.currentBalanceUi, 2_000_000);
  assert.equal(pending.inOpenSnapshot, null, 'no snapshot is invented');
  assert.equal(pending.openBalanceRaw, null);
  assert.equal(pending.eligible, null);
  assert.ok(pending.note.includes('No opening snapshot'), pending.note);

  // 2. held all cycle: the smaller (opening) figure still clears the bar
  const held = run(bal('2000000000000'), snap([{ wallet, balance: '1500000000000' }, { wallet: whale, balance: '8000000000000' }]));
  assert.equal(held.inOpenSnapshot, true);
  assert.equal(held.openSnapshotHash, 'open_hash');
  assert.equal(held.openBalanceRaw, '1500000000000');
  assert.equal(held.effectiveBalanceRaw, '1500000000000', 'the smaller of the two counts');
  assert.equal(held.effectiveBalanceUi, 1_500_000);
  assert.equal(held.eligible, true);
  assert.ok(held.note.includes('all cycle'), held.note);

  // 3. sold during the cycle: the smaller figure is the one held now
  const fell = run(bal('2000000000000'), snap([{ wallet, balance: '3000000000000' }]));
  assert.equal(fell.openBalanceRaw, '3000000000000');
  assert.equal(fell.effectiveBalanceRaw, '2000000000000');
  assert.equal(fell.eligible, true);
  assert.ok(fell.note.includes('fell during this cycle'), fell.note);

  // 4. bought this cycle: not in the opening snapshot at all
  const bought = run(bal('2000000000000'), snap([{ wallet: whale, balance: '8000000000000' }]));
  assert.equal(bought.inOpenSnapshot, false);
  assert.equal(bought.openBalanceRaw, '0');
  assert.equal(bought.effectiveBalanceRaw, '0');
  assert.equal(bought.eligible, false);
  assert.ok(bought.note.includes('next one'), bought.note);

  // 5. under the threshold when the cycle opened, even though it holds more now
  const thin = run(bal('2000000000000'), snap([{ wallet, balance: '10000000' }]));
  assert.equal(thin.eligible, false);
  assert.equal(thin.effectiveBalanceRaw, '10000000');
  assert.ok(thin.note.includes('when this cycle opened'), thin.note);

  // 6. under the threshold right now
  const poor = run(bal('0'), snap([{ wallet, balance: '9000000000000' }]));
  assert.equal(poor.currentBalanceRaw, '0');
  assert.equal(poor.eligible, false);
  assert.ok(poor.note.includes('needed to qualify'), poor.note);

  // 7. anti-cheat off: the round snapshot alone decides
  const offCfg = buildConfig({ TOKEN_MINT: MEME_MINT, TOKEN_SYMBOL: 'DROP', ANTICHEAT: '0' });
  const off = buildCycle({ cfg: offCfg, wallet, balance: bal('2000000000000'), openSnapshot: null, nowMs });
  assert.equal(off.antiCheat, false);
  assert.equal(off.effectiveBalanceRaw, '2000000000000');
  assert.equal(off.eligible, true);
  assert.equal(off.inOpenSnapshot, null);
  assert.ok(off.note.includes('Anti-cheat is off'), off.note);
});

test('the anti-cheat switch is still published even though no wallet can be judged by it', async (t) => {
  const off = await makeLaunchedServer({ holder: newSolanaAddress(), whale: newSolanaAddress(), env: { ANTICHEAT: '0' } });
  t.after(() => off.close());
  assert.equal((await get(off.port, '/api/config')).json.rules.antiCheat, false);
  assert.equal((await get(off.port, '/api/stats')).json.antiCheat, false);
});

/** The same heavy round, plus the two snapshots the anti-cheat keeper records. */
function twoSnapshotRound(id, createdAt, holders = 50) {
  const base = heavyRound(id, { simulated: true, status: 'DONE', solSpentLamports: '2450000000', holders, createdAt });
  return {
    ...base,
    snapshotMode: 'min-of-open-and-round',
    openSnapshot: {
      takenAt: new Date(Date.parse(createdAt) - 60 * 60_000).toISOString(),
      slot: 1,
      tokenMint: MEME_MINT,
      hash: `open_${id}`,
      holders: base.snapshot.holders,
    },
    closeSnapshot: { ...base.snapshot, hash: `close_${id}` },
  };
}

test('the rounds ledger publishes both snapshots and the rule each round used', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  await s.db.createRound(twoSnapshotRound('r_two', iso(9), 300));

  const list = await get(s.port, '/api/rounds');
  assert.equal(list.status, 200, list.text);
  const item = list.json.items[0];
  assert.equal(item.snapshotMode, 'min-of-open-and-round');
  assert.equal(item.snapshots.open.takenAt, new Date(Date.parse(iso(9)) - 60 * 60_000).toISOString());
  assert.equal(item.snapshots.open.hash, 'open_r_two');
  assert.equal(item.snapshots.open.holderCount, 300);
  assert.equal(item.snapshots.close.takenAt, iso(9));
  assert.equal(item.snapshots.close.hash, 'close_r_two');
  assert.equal(item.snapshots.open.holders, undefined, 'a list never carries holder rows');
  assert.equal(item.openSnapshot.holders, undefined);
  assert.equal(item.closeSnapshot.holders, undefined);
  assert.equal(item.openSnapshot.holderCount, 300);
  const text = JSON.stringify(list.json);
  assert.equal(text.includes('Holder0000'), false, 'not one holder address leaks through the new fields');
  assert.ok(text.length < 8_000, `a 300-holder two-snapshot round still summarises small, got ${text.length} bytes`);

  const full = await get(s.port, '/api/rounds/r_two');
  assert.equal(full.status, 200, full.text);
  assert.equal(full.json.snapshotMode, 'min-of-open-and-round');
  assert.equal(full.json.openSnapshot.holders.length, 300, 'the full document is still reproducible');
  assert.equal(full.json.closeSnapshot.holders.length, 300);
  assert.equal(full.json.snapshots.open.hash, 'open_r_two');
  assert.equal(full.json.snapshots.close.hash, 'close_r_two');
  assert.equal(full.json.snapshots.open.holderCount, 300);
});

test('a round written before the anti-cheat rule degrades instead of throwing', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  await s.db.createRound(heavyRound('r_old', { simulated: true, status: 'DONE', solSpentLamports: '1000000000', holders: 3, createdAt: iso(10) }));
  await s.db.createRound({
    id: 'r_bare',
    createdAt: iso(11),
    scheduledAt: iso(11),
    status: 'SKIPPED',
    simulated: true,
    skipReason: 'no_token',
    snapshot: null,
  });

  const list = await get(s.port, '/api/rounds');
  assert.equal(list.status, 200, list.text);
  const bare = list.json.items.find((r) => r.id === 'r_bare');
  const old = list.json.items.find((r) => r.id === 'r_old');
  assert.deepEqual(bare.snapshots, { open: null, close: null }, 'a skipped round snapshotted nothing');
  assert.equal(bare.snapshotMode, null, 'the rule is copied, never guessed');
  assert.equal(old.snapshotMode, null);
  assert.equal(old.snapshots.open, null, 'an older round has no opening snapshot');
  assert.equal(old.snapshots.close.hash, 'h_r_old', 'its one snapshot is published as the closing one');
  assert.equal(old.snapshots.close.holderCount, 3);

  const oldFull = await get(s.port, '/api/rounds/r_old');
  assert.equal(oldFull.status, 200);
  assert.equal(oldFull.json.snapshots.open, null);
  assert.equal(oldFull.json.snapshot.holders.length, 3, 'the stored document is untouched');
  const bareFull = await get(s.port, '/api/rounds/r_bare');
  assert.equal(bareFull.status, 200);
  assert.deepEqual(bareFull.json.snapshots, { open: null, close: null });
  assert.equal(bareFull.json.snapshotMode, null);
});
