/**
 * STOCKDROP chain tests — rpc, vault, jupiter, distributor.
 *
 * Nothing here touches the network or the chain: every test injects a fake
 * fetch or a fake rpc. The transactions the distributor builds are real,
 * signed, serialisable web3.js transactions; they are just never sent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, VersionedTransaction } from '@solana/web3.js';

import { createRpc, RpcError, TOKEN_2022_PROGRAM_ID as RPC_TOKEN_2022 } from '../src/chain/rpc.js';
import {
  b58decode,
  b58encode,
  describeVault,
  isAddress,
  keypairFromSecret,
  loadVault,
  parseSecretKey,
  VaultError,
  vaultPublicKey,
} from '../src/chain/vault.js';
import { createJupiter, JupiterError, SOL_MINT } from '../src/chain/jupiter.js';
import {
  computeUnitsFor,
  createDistributor,
  DistributorError,
  microLamportsFor,
  TOKEN_2022_PROGRAM,
} from '../src/chain/distributor.js';

/* --------------------------------------------------------------- helpers */

const noSleep = async () => {};

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function textResponse(text, { status = 500, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => {
      throw new Error('not json');
    },
    text: async () => text,
  };
}

/** A fetch stub that plays back a queue of responses (or a handler function). */
function fakeFetch(script) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const step = typeof script === 'function' ? script(calls.length, String(url), init) : script[calls.length - 1];
    if (step === undefined) throw new Error(`fakeFetch: no scripted response for call ${calls.length} (${url})`);
    if (step instanceof Error) throw step;
    return step;
  };
  fn.calls = calls;
  return fn;
}

const rpcOpts = (fetchImpl, extra = {}) => ({ fetchImpl, sleep: noSleep, random: () => 0, ...extra });

/* ------------------------------------------------------------------- rpc */

test('rpc: getBalanceLamports returns lamports as a bigint', async () => {
  const fetchImpl = fakeFetch([jsonResponse({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: 1_500_000_000 } })]);
  const rpc = createRpc({ rpcUrl: 'https://node.test' }, rpcOpts(fetchImpl));

  const balance = await rpc.getBalanceLamports('769fv6KK6SAQ5FBAXdUZLdrppdHn5CqqgJBpFCLyf9up');
  assert.equal(balance, 1_500_000_000n);
  assert.equal(typeof balance, 'bigint');

  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(body.method, 'getBalance');
  assert.equal(body.params[0], '769fv6KK6SAQ5FBAXdUZLdrppdHn5CqqgJBpFCLyf9up');
});

test('rpc: retries 429 and 5xx, then succeeds', async () => {
  const fetchImpl = fakeFetch([
    textResponse('slow down', { status: 429, headers: { 'retry-after': '0' } }),
    textResponse('bad gateway', { status: 502 }),
    jsonResponse({ jsonrpc: '2.0', id: 3, result: 311_000_000 }),
  ]);
  const rpc = createRpc({ rpcUrl: 'https://node.test' }, rpcOpts(fetchImpl));

  assert.equal(await rpc.getSlot(), 311_000_000);
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(rpc.stats().retries, 2);
});

test('rpc: a JSON-RPC error is not retried and carries the method', async () => {
  const fetchImpl = fakeFetch([jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid param' } })]);
  const rpc = createRpc({ rpcUrl: 'https://node.test' }, rpcOpts(fetchImpl));

  await assert.rejects(
    () => rpc.getBalanceLamports('nope'),
    (err) => {
      assert.ok(err instanceof RpcError);
      assert.equal(err.retryable, false);
      assert.equal(err.method, 'getBalance');
      assert.match(err.message, /Invalid param/);
      return true;
    },
  );
  assert.equal(fetchImpl.calls.length, 1);
});

test('rpc: gives up after the configured number of attempts', async () => {
  const fetchImpl = fakeFetch(() => textResponse('nope', { status: 503 }));
  const rpc = createRpc({ rpcUrl: 'https://node.test' }, rpcOpts(fetchImpl, { retries: 3 }));

  await assert.rejects(() => rpc.getSlot(), /HTTP 503/);
  assert.equal(fetchImpl.calls.length, 3);
});

test('rpc: getTokenAccountBalanceRaw sums every account of the owner', async () => {
  const account = (amount) => ({
    pubkey: 'acc',
    account: { data: { parsed: { info: { mint: 'M', owner: 'O', tokenAmount: { amount, decimals: 8 } } } } },
  });
  const fetchImpl = fakeFetch([jsonResponse({ jsonrpc: '2.0', id: 1, result: { value: [account('100'), account('250')] } })]);
  const rpc = createRpc({ rpcUrl: 'https://node.test' }, rpcOpts(fetchImpl));

  assert.equal(await rpc.getTokenAccountBalanceRaw('O', 'M', RPC_TOKEN_2022), 350n);
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepEqual(body.params[1], { mint: 'M' });
});

test('rpc: getMintInfo surfaces the transfer hook and pause state', async () => {
  const fetchImpl = fakeFetch([
    jsonResponse({
      jsonrpc: '2.0',
      id: 1,
      result: {
        value: {
          owner: RPC_TOKEN_2022,
          data: {
            parsed: {
              info: {
                decimals: 8,
                supply: '12345',
                extensions: [
                  { extension: 'transferHook', state: { programId: null } },
                  { extension: 'pausableConfig', state: { paused: false } },
                  { extension: 'permanentDelegate', state: { delegate: 'BackedDelegate' } },
                ],
              },
            },
          },
        },
      },
    }),
  ]);
  const rpc = createRpc({ rpcUrl: 'https://node.test' }, rpcOpts(fetchImpl));

  const info = await rpc.getMintInfo('MINT');
  assert.equal(info.programId, RPC_TOKEN_2022);
  assert.equal(info.decimals, 8);
  assert.equal(info.supplyRaw, 12345n);
  assert.equal(info.transferHookProgramId, null);
  assert.equal(info.paused, false);
  assert.equal(info.permanentDelegate, 'BackedDelegate');
  assert.deepEqual(info.extensions, ['transferHook', 'pausableConfig', 'permanentDelegate']);
});

test('rpc: sendRawTransaction base64-encodes the bytes and returns the signature', async () => {
  const fetchImpl = fakeFetch([jsonResponse({ jsonrpc: '2.0', id: 1, result: 'SIGNATURE' })]);
  const rpc = createRpc({ rpcUrl: 'https://node.test' }, rpcOpts(fetchImpl));

  const signature = await rpc.sendRawTransaction(Uint8Array.from([1, 2, 3, 4]));
  assert.equal(signature, 'SIGNATURE');
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(body.params[0], Buffer.from([1, 2, 3, 4]).toString('base64'));
  assert.equal(body.params[1].encoding, 'base64');
  assert.equal(body.params[1].skipPreflight, false);
});

test('rpc: getSignatureStatuses lines up with the signatures asked for', async () => {
  const fetchImpl = fakeFetch([
    jsonResponse({
      jsonrpc: '2.0',
      id: 1,
      result: { value: [{ slot: 5, confirmations: null, confirmationStatus: 'finalized', err: null }, null] },
    }),
  ]);
  const rpc = createRpc({ rpcUrl: 'https://node.test' }, rpcOpts(fetchImpl));

  const statuses = await rpc.getSignatureStatuses(['a', 'b']);
  assert.equal(statuses.length, 2);
  assert.equal(statuses[0].confirmationStatus, 'finalized');
  assert.equal(statuses[1], null);
});

test('rpc: confirmSignature reports an expired blockhash instead of hanging', async () => {
  let call = 0;
  const rpc = createRpc(
    { rpcUrl: 'https://node.test' },
    rpcOpts(
      fakeFetch((n, _url, init) => {
        const body = JSON.parse(init.body);
        call++;
        if (body.method === 'getSignatureStatuses') return jsonResponse({ jsonrpc: '2.0', id: n, result: { value: [null] } });
        if (body.method === 'getBlockHeight') return jsonResponse({ jsonrpc: '2.0', id: n, result: 200 });
        throw new Error(`unexpected method ${body.method}`);
      }),
    ),
  );

  const result = await rpc.confirmSignature('sig', { lastValidBlockHeight: 100, timeoutMs: 5000 });
  assert.equal(result.status, 'expired');
  assert.ok(call >= 2);
});

test('rpc: never puts the endpoint (which may carry an api key) in an error message', async () => {
  const fetchImpl = fakeFetch([textResponse('boom', { status: 400 })]);
  const rpc = createRpc({ rpcUrl: 'https://mainnet.helius-rpc.com/?api-key=SUPER_SECRET' }, rpcOpts(fetchImpl));
  await assert.rejects(
    () => rpc.getSlot(),
    (err) => {
      assert.ok(!err.message.includes('SUPER_SECRET'));
      assert.ok(!String(err.stack).includes('SUPER_SECRET'));
      return true;
    },
  );
});

/* ----------------------------------------------------------------- vault */

test('vault: base58 round-trips, including leading zero bytes', () => {
  const bytes = Uint8Array.from([0, 0, 7, 13, 255, 128, 1]);
  assert.deepEqual(Array.from(b58decode(b58encode(bytes))), Array.from(bytes));

  const key = Keypair.generate();
  assert.deepEqual(Array.from(b58decode(key.publicKey.toBase58())), Array.from(key.publicKey.toBytes()));
  assert.equal(b58encode(key.publicKey.toBytes()), key.publicKey.toBase58());
});

test('vault: isAddress accepts a real pubkey and rejects noise', () => {
  assert.equal(isAddress(Keypair.generate().publicKey.toBase58()), true);
  assert.equal(isAddress('769fv6KK6SAQ5FBAXdUZLdrppdHn5CqqgJBpFCLyf9up'), true);
  assert.equal(isAddress('not a key'), false);
  assert.equal(isAddress(''), false);
  assert.equal(isAddress('0OIl'), false);
});

test('vault: accepts base58 (64 byte), base58 seed (32 byte) and a json array', () => {
  const key = Keypair.generate();
  const base58 = b58encode(key.secretKey);
  const jsonArray = JSON.stringify(Array.from(key.secretKey));
  const seed = b58encode(key.secretKey.slice(0, 32));

  assert.equal(keypairFromSecret(base58).publicKey.toBase58(), key.publicKey.toBase58());
  assert.equal(keypairFromSecret(jsonArray).publicKey.toBase58(), key.publicKey.toBase58());
  assert.equal(keypairFromSecret(Array.from(key.secretKey)).publicKey.toBase58(), key.publicKey.toBase58());
  assert.equal(keypairFromSecret(seed).publicKey.toBase58(), key.publicKey.toBase58());

  assert.equal(parseSecretKey(base58).kind, 'base58');
  assert.equal(parseSecretKey(jsonArray).kind, 'json');
});

test('vault: loadVault returns null with no secret and a keypair with one', () => {
  assert.equal(loadVault({ mode: 'READ_ONLY' }), null);
  assert.equal(loadVault({ mode: 'DRY_RUN', vaultSecretKey: '' }), null);
  assert.equal(loadVault({}), null);

  const key = Keypair.generate();
  const cfg = { mode: 'LIVE', vaultSecretKey: b58encode(key.secretKey), vaultAddress: key.publicKey.toBase58() };
  const loaded = loadVault(cfg);
  assert.equal(loaded.publicKey.toBase58(), key.publicKey.toBase58());
  assert.equal(vaultPublicKey(cfg).toBase58(), key.publicKey.toBase58());
});

test('vault: refuses a secret that disagrees with VAULT_ADDRESS, without echoing the secret', () => {
  const key = Keypair.generate();
  const other = Keypair.generate();
  const secret = b58encode(key.secretKey);
  try {
    loadVault({ mode: 'LIVE', vaultSecretKey: secret, vaultAddress: other.publicKey.toBase58() });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof VaultError);
    assert.equal(err.code, 'vault_address_mismatch');
    assert.ok(!err.message.includes(secret), 'the error must not contain the secret');
  }
});

test('vault: a malformed secret throws without echoing it', () => {
  const junk = 'lllllllllllllllllllllllllllllllllllll0OI';
  try {
    keypairFromSecret(junk);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof VaultError);
    assert.ok(!err.message.includes(junk));
  }
  assert.throws(() => keypairFromSecret(b58encode(Uint8Array.from([1, 2, 3]))), /32 or 64 bytes/);
});

test('vault: describeVault says what it has without saying what it is', () => {
  const key = Keypair.generate();
  const secret = b58encode(key.secretKey);
  const line = describeVault({ vaultAddress: key.publicKey.toBase58(), vaultSecretKey: secret });
  assert.match(line, /signer loaded/);
  assert.ok(!line.includes(secret));
  assert.match(describeVault({}), /read-only/);
});

/* --------------------------------------------------------------- jupiter */

const jupOpts = (fetchImpl, extra = {}) => ({ fetchImpl, sleep: noSleep, random: () => 0, ...extra });

test('jupiter: quote builds the documented url and normalises the amounts', async () => {
  const fetchImpl = fakeFetch([jsonResponse({ inAmount: 1_000_000_000, outAmount: '431245', routePlan: [{ swapInfo: {} }] })]);
  const jup = createJupiter({ jupBase: 'https://lite-api.jup.ag', slippageBps: 100 }, jupOpts(fetchImpl));

  const quote = await jup.quote({ outputMint: 'XSTOCK', amount: 1_000_000_000n });
  assert.equal(quote.outAmount, '431245');
  assert.equal(quote.inAmount, '1000000000');

  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.pathname, '/swap/v1/quote');
  assert.equal(url.searchParams.get('inputMint'), SOL_MINT);
  assert.equal(url.searchParams.get('outputMint'), 'XSTOCK');
  assert.equal(url.searchParams.get('amount'), '1000000000');
  assert.equal(url.searchParams.get('slippageBps'), '100');
  assert.equal(url.searchParams.get('restrictIntermediateTokens'), 'true');
});

test('jupiter: a quote with no route is an error, not a zero fill', async () => {
  const fetchImpl = fakeFetch([jsonResponse({ error: 'No routes found' })]);
  const jup = createJupiter({}, jupOpts(fetchImpl));
  await assert.rejects(() => jup.quote({ outputMint: 'X', amount: '1000' }), (err) => {
    assert.ok(err instanceof JupiterError);
    assert.equal(err.code, 'no_route');
    return true;
  });
});

test('jupiter: retries three times on 5xx and then throws', async () => {
  const fetchImpl = fakeFetch(() => textResponse('upstream down', { status: 502 }));
  const jup = createJupiter({}, jupOpts(fetchImpl));
  await assert.rejects(() => jup.quote({ outputMint: 'X', amount: '1000' }), /HTTP 502/);
  assert.equal(fetchImpl.calls.length, 3);
});

test('jupiter: buildSwapTx posts the quote back unchanged', async () => {
  const quote = { outAmount: '10', inAmount: '20', routePlan: [] };
  const fetchImpl = fakeFetch([jsonResponse({ swapTransaction: 'BASE64TX', lastValidBlockHeight: 42, prioritizationFeeLamports: 200000 })]);
  const jup = createJupiter({ priorityFeeLamports: 200000 }, jupOpts(fetchImpl));

  const built = await jup.buildSwapTx({ quoteResponse: quote, userPublicKey: 'VAULT' });
  assert.equal(built.swapTransaction, 'BASE64TX');
  assert.equal(built.lastValidBlockHeight, 42);

  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepEqual(sent.quoteResponse, quote);
  assert.equal(sent.userPublicKey, 'VAULT');
  assert.equal(sent.wrapAndUnwrapSol, true);
  assert.equal(sent.dynamicComputeUnitLimit, true);
  assert.equal(sent.prioritizationFeeLamports, 200000);
});

test('jupiter: prices chunk at 50 ids and solPriceUsd degrades to null', async () => {
  const ids = Array.from({ length: 120 }, (_, i) => `mint${i}`);
  const fetchImpl = fakeFetch((n, url) => {
    const asked = new URL(url).searchParams.get('ids').split(',');
    const body = {};
    for (const id of asked) body[id] = { usdPrice: 1.5, priceChange24h: -0.5, liquidity: 90000, stockData: { price: 10, mcap: 1e12 } };
    return jsonResponse(body);
  });
  const jup = createJupiter({}, jupOpts(fetchImpl));

  const map = await jup.prices(ids);
  assert.equal(Object.keys(map).length, 120);
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(map.mint7.usdPrice, 1.5);
  assert.equal(map.mint7.stockData.mcap, 1e12);

  const broken = createJupiter({}, jupOpts(fakeFetch(() => textResponse('down', { status: 500 }))));
  assert.equal(await broken.solPriceUsd(), null);
});

test('jupiter: searchXStocks enriches with prices and keeps only xStocks', async () => {
  const seed = JSON.stringify({
    fetchedAt: '2026-09-07T00:00:00.000Z',
    stocks: [{ mint: 'XsNVDA', symbol: 'NVDAx', yahooSymbol: 'NVDA', decimals: 8, underlyingMcap: 1 }],
  });
  const fetchImpl = fakeFetch((n, url) => {
    if (url.includes('/tokens/v2/search')) {
      return jsonResponse([
        { id: 'XsNVDA', symbol: 'NVDAx', name: 'NVIDIA', icon: 'logo.png', decimals: 8, tokenProgram: RPC_TOKEN_2022, liquidity: 1_000_000, mcap: 74_000_000, holderCount: 73677 },
        { id: 'SoLBONK', symbol: 'BONK', name: 'Bonk', decimals: 5, tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', liquidity: 5_000_000 },
      ]);
    }
    return jsonResponse({ XsNVDA: { usdPrice: 232.09, priceChange24h: 0.26, liquidity: 1_903_936, stockData: { price: 229.48, mcap: 5_562_502_920_000 } } });
  });
  const jup = createJupiter({}, jupOpts(fetchImpl, { readFile: async () => seed, seedPath: 'seed.json' }));

  const found = await jup.searchXStocks({});
  assert.equal(found.source, 'jupiter');
  assert.equal(found.stocks.length, 1, 'BONK is not an xStock');
  const nvda = found.stocks[0];
  assert.equal(nvda.symbol, 'NVDAx');
  assert.equal(nvda.underlyingMcap, 5_562_502_920_000);
  assert.equal(nvda.liquidityUsd, 1_903_936);
  assert.equal(nvda.yahooSymbol, 'NVDA', 'yahoo mapping comes from the seed file');
  assert.equal(nvda.tokenProgram, RPC_TOKEN_2022);
});

test('jupiter: searchXStocks falls back to the seed file and says so', async () => {
  const seed = JSON.stringify({
    fetchedAt: '2026-09-07T00:00:00.000Z',
    stocks: [
      { mint: 'XsNVDA', symbol: 'NVDAx', underlyingMcap: 5.5e12, liquidityUsd: 1_900_000, decimals: 8 },
      { mint: 'XsAAPL', symbol: 'AAPLx', underlyingMcap: 3.4e12, liquidityUsd: 900_000, decimals: 8 },
    ],
  });
  const jup = createJupiter(
    {},
    jupOpts(fakeFetch(() => textResponse('offline', { status: 503 })), { readFile: async () => seed }),
  );

  const found = await jup.searchXStocks({});
  assert.equal(found.source, 'seed');
  assert.equal(found.fetchedAt, '2026-09-07T00:00:00.000Z');
  assert.equal(found.stocks.length, 2);
  assert.match(found.error, /503/);
});

test('jupiter: the real seed file on disk parses and holds the top-20 names', async () => {
  const jup = createJupiter({}, { fetchImpl: async () => textResponse('offline', { status: 503 }), sleep: noSleep });
  const seed = await jup.loadSeed();
  assert.ok(seed.stocks.length >= 20, `expected a full seed, got ${seed.stocks.length}`);
  const symbols = new Set(seed.stocks.map((s) => s.symbol));
  for (const symbol of ['NVDAx', 'AAPLx', 'TSLAx', 'SPYx']) assert.ok(symbols.has(symbol), `seed is missing ${symbol}`);
  for (const stock of seed.stocks) assert.equal(stock.tokenProgram, RPC_TOKEN_2022);
});

/* ----------------------------------------------------------- distributor */

/** The signature a node would report for bytes we sent: the tx's own first signature. */
function sigOf(raw) {
  return b58encode(VersionedTransaction.deserialize(raw).signatures[0]);
}

/** A plausible 64-byte transaction signature, as a previous run would have stored it. */
const fakeSignature = () => b58encode(Keypair.generate().secretKey);

/** A status object the cluster returns for a transaction that landed cleanly. */
const FINALIZED = { slot: 7, confirmations: null, confirmationStatus: 'finalized', err: null };

function distFakes({ mode = 'LIVE', confirm = () => ({ status: 'confirmed' }), statuses = () => [null] } = {}) {
  const balances = new Map();
  const sends = [];
  const blockhashes = [];
  const state = { deliverOnSend: null };

  const rpc = {
    async getMintInfo() {
      return { programId: TOKEN_2022_PROGRAM, decimals: 8, transferHookProgramId: null, paused: false, extensions: [] };
    },
    async getTokenAccountBalanceRaw(owner) {
      return balances.get(owner) ?? 0n;
    },
    async getLatestBlockhash() {
      // A retry always builds on a fresh blockhash, so it is a different
      // transaction with a different signature — as on a real cluster.
      const blockhash = Keypair.generate().publicKey.toBase58();
      blockhashes.push(blockhash);
      return { blockhash, lastValidBlockHeight: 1000 };
    },
    async sendRawTransaction(raw) {
      sends.push(raw);
      const signature = sigOf(raw);
      if (state.deliverOnSend) state.deliverOnSend(signature, raw);
      return signature;
    },
    async confirmSignature(signature) {
      const result = confirm(sends.length, signature);
      return { signature, slot: 1, err: null, ...result };
    },
    async getSignatureStatuses(sigs) {
      return statuses(sigs);
    },
  };

  const cfg = { mode, priorityFeeLamports: 200000, vaultAddress: null };
  const dist = createDistributor({ cfg, rpc, sleep: noSleep });
  return { cfg, rpc, dist, balances, sends, blockhashes, state };
}

test('distributor: compute budget maths', () => {
  assert.equal(computeUnitsFor(8), 400_000);
  assert.equal(computeUnitsFor(1), 85_000);
  assert.ok(computeUnitsFor(100) <= 1_400_000);
  assert.equal(microLamportsFor(200_000, 400_000), 500_000);
  assert.equal(microLamportsFor(0, 400_000), 0);
});

test('distributor: refuses to send unless the mode is LIVE', async () => {
  const { dist } = distFakes({ mode: 'DRY_RUN' });
  const vault = Keypair.generate();
  await assert.rejects(
    () => dist.ensureAndTransfer(vault, Keypair.generate().publicKey.toBase58(), 8, [{ wallet: Keypair.generate().publicKey.toBase58(), amountRaw: '100' }]),
    (err) => {
      assert.ok(err instanceof DistributorError);
      assert.equal(err.code, 'not_live');
      return true;
    },
  );
});

test('distributor: measureReceived is a real delta and never goes negative', async () => {
  const { dist, balances } = distFakes();
  const vault = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();

  balances.set(vault, 350n);
  assert.deepEqual(await dist.measureReceived(vault, mint, 100n), { beforeRaw: 100n, afterRaw: 350n, receivedRaw: 250n });

  balances.set(vault, 50n);
  const measured = await dist.measureReceived(vault, mint, 100n);
  assert.equal(measured.receivedRaw, 0n);
});

test('distributor: sends one batch, marks every transfer DONE with the signature', async () => {
  const { dist, sends } = distFakes();
  const vault = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  const wallets = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];

  const batches = [];
  const results = await dist.ensureAndTransfer(
    vault,
    mint,
    8,
    wallets.map((wallet, i) => ({ wallet, amountRaw: String(1000 + i) })),
    { batchSize: 8, onBatch: (rows) => batches.push(rows.length) },
  );

  assert.equal(sends.length, 1, 'one transaction for the whole batch');
  assert.equal(results.length, 3);
  for (const row of results) {
    assert.equal(row.status, 'DONE');
    assert.equal(row.tx, sigOf(sends[0]), 'the published tx is the signature of the transaction we sent');
    assert.equal(row.mint, mint);
  }
  assert.deepEqual(batches, [3]);

  // The bytes we produced are a real, signed v0 transaction.
  const tx = VersionedTransaction.deserialize(sends[0]);
  assert.equal(tx.signatures.length, 1);
  assert.equal(tx.message.version, 0);
  // 2 compute-budget instructions + (ATA + transfer) per recipient
  assert.equal(tx.message.compiledInstructions.length, 2 + wallets.length * 2);
});

test('distributor: zero amounts are SKIPPED_DUST and never create an account', async () => {
  const { dist, sends } = distFakes();
  const vault = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  const wallet = Keypair.generate().publicKey.toBase58();

  const results = await dist.ensureAndTransfer(vault, mint, 8, [{ wallet, amountRaw: '0' }]);
  assert.equal(results[0].status, 'SKIPPED_DUST');
  assert.equal(sends.length, 0);
});

test('distributor: a bad recipient address fails alone and does not poison the batch', async () => {
  const { dist, sends } = distFakes();
  const vault = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  const good = Keypair.generate().publicKey.toBase58();

  const results = await dist.ensureAndTransfer(vault, mint, 8, [
    { wallet: 'definitely-not-a-pubkey', amountRaw: '10' },
    { wallet: good, amountRaw: '20' },
  ]);
  assert.equal(results[0].status, 'FAILED');
  assert.match(results[0].error, /valid solana address/);
  assert.equal(results[1].status, 'DONE');
  assert.equal(sends.length, 1);
});

test('distributor: onAttempt gets the real signature before anything is sent', async () => {
  const { dist, sends } = distFakes();
  const vault = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  const wallets = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];

  const attempts = [];
  const results = await dist.ensureAndTransfer(
    vault,
    mint,
    8,
    wallets.map((wallet) => ({ wallet, amountRaw: '1000' })),
    {
      onAttempt: (rows, signature) => {
        attempts.push({ signature, sendsSoFar: sends.length, rows });
      },
    },
  );

  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].sendsSoFar, 0, 'the attempt is recorded BEFORE the transaction is sent');
  assert.equal(attempts[0].signature, sigOf(sends[0]), 'the recorded signature is the one the chain will know');
  assert.deepEqual(
    attempts[0].rows.map((row) => row.wallet),
    wallets,
  );
  for (const row of attempts[0].rows) {
    assert.equal(row.attemptedTx, attempts[0].signature);
    assert.equal(row.status, 'PENDING');
    assert.equal(row.mint, mint);
  }
  for (const row of results) {
    assert.equal(row.status, 'DONE');
    assert.equal(row.tx, attempts[0].signature);
  }
});

test('distributor: nothing is sent when the attempt cannot be recorded first', async () => {
  const { dist, sends } = distFakes();
  const vault = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  const wallet = Keypair.generate().publicKey.toBase58();

  const results = await dist.ensureAndTransfer(vault, mint, 8, [{ wallet, amountRaw: '10' }], {
    maxAttempts: 2,
    onAttempt: async () => {
      throw new Error('store is down');
    },
  });

  assert.equal(sends.length, 0, 'an unrecorded transaction is never sent');
  assert.equal(results[0].status, 'FAILED');
  assert.equal(results[0].tx, null);
  assert.match(results[0].error, /store is down/);
});

test('distributor: a batch that confirmed before the process died is not re-sent on the next run', async () => {
  // Eight holders, 12.5 AAPLx each (8 decimals). The batch confirms; the keeper
  // dies before it can persist the results, so every row is still PENDING on
  // disk — but each carries the signature onAttempt handed it before the send.
  const landed = new Set();
  const { dist, sends, state } = distFakes({
    confirm: () => ({ status: 'confirmed' }),
    statuses: (sigs) => sigs.map((sig) => (landed.has(sig) ? { ...FINALIZED } : null)),
  });
  state.deliverOnSend = (signature) => landed.add(signature);

  const vault = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  const wallets = Array.from({ length: 8 }, () => Keypair.generate().publicKey.toBase58());
  const amountRaw = '1250000000'; // 12.5 AAPLx
  const persisted = new Map();

  const first = await dist.ensureAndTransfer(
    vault,
    mint,
    8,
    wallets.map((wallet) => ({ wallet, amountRaw })),
    {
      batchSize: 8,
      onAttempt: (rows, signature) => {
        for (const row of rows) persisted.set(row.wallet, signature);
      },
      // no onBatch: the crash happens between confirmation and persistence
    },
  );
  assert.equal(sends.length, 1);
  for (const row of first) assert.equal(row.status, 'DONE');
  assert.equal(persisted.size, 8);

  // Restart: the reloaded rows are PENDING and carry the attempted signature.
  const second = await dist.ensureAndTransfer(
    vault,
    mint,
    8,
    wallets.map((wallet) => ({ wallet, amountRaw, status: 'PENDING', attemptedTx: persisted.get(wallet) })),
    { batchSize: 8 },
  );

  assert.equal(sends.length, 1, 'the confirmed batch must never be sent a second time');
  for (const row of second) {
    assert.equal(row.status, 'DONE');
    assert.equal(row.tx, persisted.get(row.wallet), 'settled against the recorded signature, not a balance delta');
    assert.equal(row.amountRaw, amountRaw, 'nobody is credited twice');
  }
});

test('distributor: a recorded signature the cluster cannot find leaves the row UNRESOLVED, never resent', async () => {
  const { dist, sends } = distFakes({ statuses: (sigs) => sigs.map(() => null) });
  const vault = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  const wallet = Keypair.generate().publicKey.toBase58();
  const priorSignature = fakeSignature();

  const results = await dist.ensureAndTransfer(vault, mint, 8, [
    { wallet, amountRaw: '1250000000', status: 'PENDING', attemptedTx: priorSignature },
  ]);

  assert.equal(sends.length, 0, 'a send whose fate is unknown is not repeated on a guess');
  assert.equal(results[0].status, 'UNRESOLVED');
  assert.equal(results[0].tx, null, 'no tx hash is published for a transfer that never confirmed');
  assert.equal(results[0].attemptedTx, priorSignature, 'the operator gets the signature to check');
  assert.match(results[0].error, new RegExp(priorSignature));
});

test('distributor: a stored value that is not a signature never strands a transfer', async () => {
  const { dist, sends } = distFakes();
  const vault = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  const wallet = Keypair.generate().publicKey.toBase58();

  const results = await dist.ensureAndTransfer(vault, mint, 8, [{ wallet, amountRaw: '10', attemptedTx: 'not-a-signature' }]);

  assert.equal(sends.length, 1, 'nothing this module wrote could look like that, so it is not an attempt');
  assert.equal(results[0].status, 'DONE');
  assert.equal(results[0].tx, sigOf(sends[0]));
});

test('distributor: a recorded signature that landed with an error is safely re-sent', async () => {
  const deadSignature = fakeSignature();
  const { dist, sends } = distFakes({
    confirm: () => ({ status: 'confirmed' }),
    statuses: (sigs) => sigs.map((sig) => (sig === deadSignature ? { ...FINALIZED, err: { InstructionError: [1, 'Custom'] } } : null)),
  });
  const vault = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  const wallet = Keypair.generate().publicKey.toBase58();

  const results = await dist.ensureAndTransfer(vault, mint, 8, [
    { wallet, amountRaw: '500', status: 'PENDING', attemptedTx: deadSignature },
  ]);

  assert.equal(sends.length, 1, 'a transaction that reverted moved no tokens, so a retry is safe');
  assert.equal(results[0].status, 'DONE');
  assert.equal(results[0].tx, sigOf(sends[0]));
});

test('distributor: an unrelated purchase during the window never marks a transfer DONE', async () => {
  // The send is never confirmed and never ruled out. Meanwhile the first
  // recipient buys the same xStock on Jupiter, so their balance climbs past
  // what we owe them. That is not evidence of anything.
  const { dist, sends, balances, state } = distFakes({
    confirm: () => ({ status: 'timeout' }),
    statuses: (sigs) => sigs.map(() => null),
  });
  const vault = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  const wallets = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
  const amounts = [500n, 700n];

  state.deliverOnSend = () => {
    balances.set(wallets[0], (balances.get(wallets[0]) ?? 0n) + 5000n); // their own buy, not our transfer
  };

  const results = await dist.ensureAndTransfer(
    vault,
    mint,
    8,
    wallets.map((wallet, i) => ({ wallet, amountRaw: amounts[i].toString() })),
    { maxAttempts: 3 },
  );

  assert.equal(sends.length, 1, 'a send whose fate is unknown is not repeated');
  const buyer = results[0];
  assert.notEqual(buyer.status, 'DONE', 'a balance increase is not proof of payment');
  assert.equal(buyer.status, 'UNRESOLVED');
  assert.equal(buyer.tx, null, 'never publish a signature that did not land');
  assert.equal(buyer.attemptedTx, sigOf(sends[0]));
  assert.match(buyer.error, /not proof of payment/);
  assert.match(buyer.error, /neither confirmed nor ruled out/);

  assert.equal(results[1].status, 'UNRESOLVED');
  assert.equal(results[1].tx, null);
});

test('distributor: no row is ever DONE behind a signature that only reached processed', async () => {
  const { dist, sends } = distFakes({
    confirm: () => ({ status: 'timeout' }),
    statuses: (sigs) => sigs.map(() => ({ slot: 9, confirmations: 3, confirmationStatus: 'processed', err: null })),
  });
  const vault = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  const wallets = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];

  const results = await dist.ensureAndTransfer(
    vault,
    mint,
    8,
    wallets.map((wallet) => ({ wallet, amountRaw: '4200' })),
    { maxAttempts: 3 },
  );

  assert.equal(sends.length, 1);
  for (const row of results) {
    assert.notEqual(row.status, 'DONE');
    assert.equal(row.tx, null);
    assert.equal(row.attemptedTx, sigOf(sends[0]));
  }
});

test('distributor: an expired batch the ledger has never seen is retried, and DONE carries the confirming signature', async () => {
  const landed = new Set();
  const { dist, sends, state } = distFakes({
    confirm: (n) => (n === 1 ? { status: 'expired' } : { status: 'confirmed' }),
    statuses: (sigs) => sigs.map((sig) => (landed.has(sig) ? { ...FINALIZED } : null)),
  });
  state.deliverOnSend = (signature) => {
    if (sends.length > 1) landed.add(signature); // only the second attempt lands
  };

  const vault = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  const wallet = Keypair.generate().publicKey.toBase58();

  const results = await dist.ensureAndTransfer(vault, mint, 8, [{ wallet, amountRaw: '900' }], { maxAttempts: 3 });

  assert.equal(sends.length, 2, 'an expired blockhash the ledger never saw can never land, so a retry is safe');
  assert.equal(results[0].status, 'DONE');
  assert.equal(results[0].tx, sigOf(sends[1]));
  assert.notEqual(results[0].tx, sigOf(sends[0]));
});

test('distributor: a batch that truly fails is FAILED, not silently dropped', async () => {
  const { dist, sends } = distFakes({ confirm: () => ({ status: 'failed', err: { InstructionError: [1, 'Custom'] } }) });
  const vault = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  const wallet = Keypair.generate().publicKey.toBase58();

  const results = await dist.ensureAndTransfer(vault, mint, 8, [{ wallet, amountRaw: '100' }], { maxAttempts: 2 });
  assert.equal(results[0].status, 'FAILED');
  assert.match(results[0].error, /failed on chain/);
  assert.equal(sends.length, 2, 'it retried, then gave up');
});

test('distributor: refuses to send if a transfer hook appears on the mint', async () => {
  const { dist, rpc } = distFakes();
  rpc.getMintInfo = async () => ({ programId: TOKEN_2022_PROGRAM, decimals: 8, transferHookProgramId: 'HookProgram11111', paused: false });
  const vault = Keypair.generate();
  await assert.rejects(
    () => dist.ensureAndTransfer(vault, Keypair.generate().publicKey.toBase58(), 8, [{ wallet: Keypair.generate().publicKey.toBase58(), amountRaw: '5' }]),
    /transfer hook/,
  );
});

test('distributor: refuses a decimals mismatch', async () => {
  const { dist } = distFakes();
  const vault = Keypair.generate();
  await assert.rejects(
    () => dist.ensureAndTransfer(vault, Keypair.generate().publicKey.toBase58(), 6, [{ wallet: Keypair.generate().publicKey.toBase58(), amountRaw: '5' }]),
    /decimals/,
  );
});
