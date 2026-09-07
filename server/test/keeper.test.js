/**
 * STOCKDROP keeper tests — the round state machine and the scheduler.
 *
 * The store is the real JSON store in a temp directory (resume behaviour is
 * meaningless against a fake), but nothing else is real: the rpc, Jupiter and
 * the distributor are injected fakes that count their calls. No socket is
 * opened and no transaction is ever built.
 *
 * The invariant every one of these tests is protecting: what the round document
 * says must be exactly what the pure engine computes from the same inputs, and
 * DRY_RUN must reach zero send paths.
 */

process.env.STOCKDROP_QUIET = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';

import { openDb } from '../src/db/index.js';
import { applySwapResults, buildRoundPlan } from '../src/engine/index.js';
import { b58encode } from '../src/chain/vault.js';
import { rebuildPlan, roundIdFor, runRound } from '../src/keeper/runner.js';
import { jitterFor, nextMark, planNext, start } from '../src/keeper/scheduler.js';

const { buildConfig } = await import('../src/config.js');

/* ------------------------------------------------------------- fixtures */

const LAMPORTS = 1_000_000_000n;
const address = () => Keypair.generate().publicKey.toBase58();

const VAULT_KEY = Keypair.generate();
const VAULT = VAULT_KEY.publicKey.toBase58();
const VAULT_SECRET = b58encode(VAULT_KEY.secretKey);
const TOKEN_MINT = address();

/** Six synthetic xStocks, already ranked (the universe service hands them over ranked). */
const STOCKS = [
  ['NVDAx', 'NVIDIA', 5_562_502_920_000],
  ['AAPLx', 'Apple', 3_400_000_000_000],
  ['GOOGLx', 'Alphabet', 2_900_000_000_000],
  ['MSFTx', 'Microsoft', 2_800_000_000_000],
  ['AMZNx', 'Amazon', 2_400_000_000_000],
  ['TSLAx', 'Tesla', 1_300_000_000_000],
].map(([symbol, name, mcap], i) => ({
  mint: address(),
  symbol,
  name,
  logo: null,
  decimals: 8,
  tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  yahooSymbol: symbol.slice(0, -1),
  priceUsd: 100 + i,
  change24h: 0.5,
  underlyingMcap: mcap,
  underlyingPrice: 200 + i,
  liquidityUsd: 1_000_000 - i * 1000,
  holderCount: 1000 + i,
  rank: i + 1,
  isTop5: i < 5,
}));
const bySymbol = (symbol) => STOCKS.find((s) => s.symbol === symbol).mint;

/** 3 eligible holders (>= 0.1% of a 1B/6dp supply = 1e12 raw) and one that is not. */
const HOLDERS = [
  { wallet: address(), balance: '3000000000000' }, // 3,000,000 tokens
  { wallet: address(), balance: '1000000000000' }, // 1,000,000 tokens (exactly the threshold)
  { wallet: address(), balance: '6000000000000' }, // 6,000,000 tokens
  { wallet: address(), balance: '500000000000' }, //    500,000 tokens -> not eligible
];

function makeCfg(env = {}) {
  return buildConfig({
    LIVE: '0',
    VAULT_SECRET_KEY: VAULT_SECRET,
    TOKEN_MINT,
    TOKEN_SUPPLY: '1000000000',
    TOKEN_DECIMALS: '6',
    MIN_ROUND_POOL_SOL: '0.5',
    FEE_RESERVE_SOL: '0.05',
    ...env,
  });
}

/** A temp JSON store, torn down by the caller. */
async function makeDb(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `stockdrop-${name}-`));
  const db = await openDb({ dataDir: dir });
  return {
    db,
    dir,
    async close() {
      await db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The fake chain + Jupiter, with call counters. */
function makeFakes({ balanceLamports = 2_500_000_000n, quoteFor = null } = {}) {
  const calls = { quote: [], buildSwapTx: 0, send: 0, ensureAndTransfer: 0, balance: 0 };
  const rpc = {
    async getBalanceLamports() {
      calls.balance += 1;
      return balanceLamports;
    },
    async getSlot() {
      return 311_000_000;
    },
    async getTokenSupply() {
      return { amountRaw: 1_000_000_000_000_000n, decimals: 6, uiAmountString: '1000000000' };
    },
    async sendRawTransaction() {
      calls.send += 1;
      throw new Error('a DRY_RUN round must never send a transaction');
    },
    async confirmSignature() {
      throw new Error('a DRY_RUN round must never confirm a transaction');
    },
    async getLatestBlockhash() {
      throw new Error('a DRY_RUN round must never need a blockhash');
    },
  };

  const jup = {
    async quote({ outputMint, amount }) {
      calls.quote.push(outputMint);
      if (quoteFor) return quoteFor({ outputMint, amount });
      // A deterministic, plausible fill: 1000 lamports buys 1 base unit.
      return { inAmount: String(amount), outAmount: (BigInt(amount) / 1000n).toString(), routePlan: [] };
    },
    async buildSwapTx() {
      calls.buildSwapTx += 1;
      throw new Error('a DRY_RUN round must never build a swap transaction');
    },
    async searchXStocks() {
      return { source: 'test-jup', fetchedAt: new Date().toISOString(), stocks: STOCKS };
    },
  };

  const dist = {
    async ensureAndTransfer() {
      calls.ensureAndTransfer += 1;
      throw new Error('a DRY_RUN round must never call the distributor');
    },
    async measureReceived() {
      throw new Error('a DRY_RUN round must never measure an on-chain balance');
    },
    async balanceOf() {
      throw new Error('a DRY_RUN round must never read a token balance');
    },
  };

  const universeService = {
    async getUniverse() {
      return { updatedAt: new Date().toISOString(), source: 'test-universe', stocks: STOCKS };
    },
  };
  const holdersService = {
    async snapshot() {
      return { takenAt: new Date().toISOString(), slot: 311_000_000, supply: '1000000000000000', holders: HOLDERS, source: 'test-holders' };
    },
  };

  return { calls, rpc, jup, dist, universeService, holdersService };
}

const sum = (list, pick) => list.reduce((acc, item) => acc + BigInt(pick(item)), 0n);

/* --------------------------------------------------------------- rounds */

test('runRound: TOKEN_MINT blank produces SKIPPED / no_token and touches nothing else', async () => {
  const { db, close } = await makeDb('no-token');
  try {
    const cfg = makeCfg({ TOKEN_MINT: '' });
    assert.equal(cfg.launched, false);
    const { calls, rpc, jup, dist, universeService, holdersService } = makeFakes();

    const round = await runRound({ cfg, db, rpc, jup, dist, universeService, holdersService });

    assert.equal(round.status, 'SKIPPED');
    assert.equal(round.skipReason, 'no_token');
    assert.equal(round.simulated, true);
    assert.deepEqual(round.demand, []);
    assert.deepEqual(round.swaps, []);
    assert.deepEqual(round.transfers, []);
    assert.equal(round.snapshot, null);
    assert.equal(calls.quote.length, 0, 'nothing is quoted for a coin that does not exist');
    assert.equal(calls.send, 0);
    assert.ok(round.finishedAt);

    // The pool is still recorded honestly, so the ledger shows the vault balance.
    assert.equal(round.balanceLamports, '2500000000');
    assert.equal(round.poolLamports, '2450000000');

    const stored = await db.getRound(round.id);
    assert.equal(stored.status, 'SKIPPED');
    assert.equal((await db.listRounds({})).total, 1);
  } finally {
    await close();
  }
});

test('runRound: a pool below MIN_ROUND_POOL_SOL is SKIPPED / low_pool and the SOL carries over', async () => {
  const { db, close } = await makeDb('low-pool');
  try {
    const cfg = makeCfg({ MIN_ROUND_POOL_SOL: '0.5' });
    // 0.4 SOL balance - 0.05 reserve = 0.35 pool, under the 0.5 minimum.
    const { calls, rpc, jup, dist, universeService, holdersService } = makeFakes({ balanceLamports: 400_000_000n });

    const round = await runRound({ cfg, db, rpc, jup, dist, universeService, holdersService });

    assert.equal(round.status, 'SKIPPED');
    assert.equal(round.skipReason, 'low_pool');
    assert.equal(round.poolLamports, '350000000');
    assert.equal(calls.quote.length, 0);
    assert.equal(calls.send, 0);
    assert.equal(round.snapshot, null, 'no snapshot is taken for a round that cannot trade');
  } finally {
    await close();
  }
});

test('runRound: DRY_RUN happy path matches the engine exactly, is flagged simulated, and sends nothing', async () => {
  const { db, close } = await makeDb('happy');
  try {
    const cfg = makeCfg();
    const { calls, rpc, jup, dist, universeService, holdersService } = makeFakes();

    // Two holders express picks; the third has none and gets the default basket.
    await db.setPrefs({
      wallet: HOLDERS[0].wallet,
      picks: [
        { mint: bySymbol('TSLAx'), pct: 60 },
        { mint: bySymbol('NVDAx'), pct: 40 },
      ],
      signature: 'sig-a',
      message: 'msg-a',
    });
    await db.setPrefs({
      wallet: HOLDERS[2].wallet,
      picks: [
        { mint: bySymbol('NVDAx'), pct: 50 },
        { mint: bySymbol('MSFTx'), pct: 50 },
      ],
      signature: 'sig-c',
      message: 'msg-c',
    });

    const round = await runRound({ cfg, db, rpc, jup, dist, universeService, holdersService });

    assert.equal(round.status, 'DONE', round.error ?? '');
    assert.equal(round.simulated, true);
    assert.equal(round.skipReason, null);
    assert.equal(round.error, null);

    /* the snapshot */
    assert.equal(round.snapshot.holders.length, 3, 'the 500k-token wallet is below 0.1% of supply');
    assert.equal(round.snapshot.eligibleThreshold, '1000000000000');
    assert.match(round.snapshot.hash, /^[0-9a-f]{64}$/);
    assert.ok(round.snapshot.excluded.includes(VAULT), 'the vault is always excluded');
    assert.equal(round.stats.eligibleHolders, 3);
    assert.equal(round.stats.prefHolders, 2);
    assert.equal(round.stats.defaultHolders, 1);

    /* nothing was sent, nothing was signed */
    assert.equal(calls.send, 0);
    assert.equal(calls.buildSwapTx, 0);
    assert.equal(calls.ensureAndTransfer, 0);
    for (const swap of round.swaps) assert.equal(swap.tx, null);
    for (const transfer of round.transfers) assert.equal(transfer.tx, null);

    /* the money adds up */
    const pool = BigInt(round.poolLamports);
    assert.equal(pool, 2_450_000_000n);
    assert.ok(sum(round.demand, (d) => d.solLamports) <= pool, 'never allocates more than the pool');
    assert.equal(round.demand.reduce((acc, d) => acc + d.shareBps, 0), 10000);

    for (const swap of round.swaps) {
      assert.equal(swap.status, 'DONE');
      assert.equal(swap.receivedRaw, swap.quotedOut, 'DRY_RUN fills at the quote');
      assert.equal(swap.receivedRaw, (BigInt(swap.solLamports) / 1000n).toString());
    }
    assert.equal(round.stats.solSpentLamports, sum(round.swaps, (s) => s.solLamports).toString());
    assert.equal(calls.quote.length, round.swaps.length);

    /* conservation: everything received is either transferred or carried */
    const carry = new Map((round.carryOut ?? []).map((c) => [c.mint, BigInt(c.amountRaw)]));
    for (const swap of round.swaps) {
      const forMint = round.transfers.filter((t) => t.mint === swap.mint);
      const distributed = sum(forMint, (t) => t.amountRaw);
      assert.equal(distributed + (carry.get(swap.mint) ?? 0n), BigInt(swap.receivedRaw), `conservation failed for ${swap.symbol}`);
    }

    /* the document is reproducible: re-run the pure engine over it */
    const plan = rebuildPlan(round, cfg);
    const applied = applySwapResults(plan, round.swaps, round.carryIn ?? []);
    assert.equal(applied.transfers.length, round.transfers.length);
    for (const expected of applied.transfers) {
      const actual = round.transfers.find((t) => t.wallet === expected.wallet && t.mint === expected.mint);
      assert.ok(actual, `missing transfer for ${expected.wallet}`);
      assert.equal(actual.amountRaw, expected.amountRaw);
      assert.equal(actual.status, expected.status === 'SKIPPED_DUST' ? 'SKIPPED_DUST' : 'DONE');
    }
    assert.deepEqual(applied.carryOut, round.carryOut);

    /* an independent recomputation from the snapshot alone agrees */
    const independent = buildRoundPlan({
      poolLamports: round.poolLamports,
      reserveLamports: round.reserveLamports,
      holders: round.snapshot.holders,
      prefsByWallet: new Map((await db.allPrefs()).map((p) => [p.wallet, p.picks])),
      universe: round.universe,
      rules: cfg.rules,
    });
    assert.deepEqual(
      independent.demand.map((d) => [d.symbol, d.solLamports]),
      round.demand.map((d) => [d.symbol, d.solLamports]),
    );

    /* the holder with no prefs got the default top-5 basket */
    const defaulted = round.plan.holders.find((h) => h.wallet === HOLDERS[1].wallet);
    assert.equal(defaulted.source, 'default');
    assert.equal(defaulted.picks.length, cfg.defaultBasketSize);
    for (const pick of defaulted.picks) assert.equal(pick.pct, 20);

    /* the ledger is what the store returns, not just what we were handed */
    const stored = await db.getRound(round.id);
    assert.equal(stored.status, 'DONE');
    assert.equal(stored.transfers.length, round.transfers.length);
    assert.deepEqual(await db.getKV('carry'), round.carryOut);
  } finally {
    await close();
  }
});

test('runRound: a crash after SWAPPING resumes and never re-swaps', async () => {
  const { db, close } = await makeDb('resume');
  try {
    const cfg = makeCfg();
    const { calls, rpc, jup, dist, universeService, holdersService } = makeFakes();

    // A store that dies the moment the round tries to leave SWAPPING — including
    // when the runner tries to record the failure. That is a process crash.
    let crash = true;
    const crashingDb = {
      ...db,
      async updateRound(id, patch) {
        if (crash && (patch.status === 'DISTRIBUTING' || patch.status === 'FAILED')) throw new Error('process died');
        return db.updateRound(id, patch);
      },
    };

    await assert.rejects(
      () => runRound({ cfg, db: crashingDb, rpc, jup, dist, universeService, holdersService }),
      /process died/,
    );

    const quotesBefore = calls.quote.length;
    assert.ok(quotesBefore > 0);

    const midway = await db.unfinishedRound();
    assert.ok(midway, 'the interrupted round is still open');
    assert.equal(midway.status, 'SWAPPING');
    assert.ok(midway.swaps.every((s) => s.status === 'DONE'), 'every swap was persisted before the crash');
    assert.equal(midway.transfers.length, 0);

    crash = false;
    const resumed = await runRound({ cfg, db, rpc, jup, dist, universeService, holdersService });

    assert.equal(resumed.id, midway.id, 'it picked the same round back up');
    assert.equal(resumed.status, 'DONE');
    assert.equal(calls.quote.length, quotesBefore, 'a resumed round must not re-quote or re-swap');
    assert.ok(resumed.transfers.length > 0);
    assert.equal((await db.listRounds({})).total, 1, 'no second round was opened');
  } finally {
    await close();
  }
});

test('runRound: one failing swap leaves its SOL unspent and does not block the other stocks', async () => {
  const { db, close } = await makeDb('bad-swap');
  try {
    const cfg = makeCfg();
    const broken = bySymbol('AAPLx');
    const { calls, rpc, jup, dist, universeService, holdersService } = makeFakes({
      quoteFor: ({ outputMint, amount }) => {
        if (outputMint === broken) throw new Error('no route for AAPLx');
        return { inAmount: String(amount), outAmount: (BigInt(amount) / 1000n).toString(), routePlan: [] };
      },
    });

    const round = await runRound({ cfg, db, rpc, jup, dist, universeService, holdersService });

    assert.equal(round.status, 'DONE');
    const failed = round.swaps.find((s) => s.mint === broken);
    assert.equal(failed.status, 'FAILED');
    assert.match(failed.error, /no route/);
    assert.equal(failed.receivedRaw, null);
    assert.equal(failed.tx, null);
    assert.equal(calls.quote.filter((m) => m === broken).length, 3, 'three attempts, then it gives up');

    const others = round.swaps.filter((s) => s.mint !== broken);
    assert.ok(others.length > 0);
    for (const swap of others) assert.equal(swap.status, 'DONE');

    // The failed stock's SOL was never spent: spend excludes it, and it stays in
    // the vault for the next round.
    const spent = BigInt(round.stats.solSpentLamports);
    assert.equal(spent, sum(others, (s) => s.solLamports));
    assert.ok(spent + BigInt(failed.solLamports) <= BigInt(round.poolLamports));
    assert.ok(BigInt(failed.solLamports) > 0n, 'the failed stock did have SOL allocated');

    // Nobody is paid in the stock we could not buy.
    assert.equal(round.transfers.filter((t) => t.mint === broken).length, 0);
    assert.ok(round.transfers.length > 0, 'the other stocks were still distributed');
    assert.equal(round.stats.swapsFailed, 1);
  } finally {
    await close();
  }
});

test('runRound: --retry reopens a FAILED round at the step it died in', async () => {
  const { db, close } = await makeDb('retry');
  try {
    const cfg = makeCfg();
    const { calls, rpc, jup, dist, universeService, holdersService } = makeFakes();

    let breakMarkTransfer = true;
    const flakyDb = {
      ...db,
      async markTransfer(roundId, wallet, mint, patch) {
        if (breakMarkTransfer) throw new Error('store unavailable');
        return db.markTransfer(roundId, wallet, mint, patch);
      },
    };

    const failed = await runRound({ cfg, db: flakyDb, rpc, jup, dist, universeService, holdersService });
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.resumeFrom, 'DISTRIBUTING');
    assert.match(failed.error, /store unavailable/);

    const quotesBefore = calls.quote.length;
    breakMarkTransfer = false;
    const retried = await runRound({ cfg, db, rpc, jup, dist, universeService, holdersService, roundId: failed.id, retry: true });

    assert.equal(retried.id, failed.id);
    assert.equal(retried.status, 'DONE');
    assert.equal(retried.error, null);
    assert.equal(calls.quote.length, quotesBefore, 'the retry re-used the swaps that already happened');
    assert.ok(retried.transfers.every((t) => t.status === 'DONE' || t.status === 'SKIPPED_DUST'));
  } finally {
    await close();
  }
});

test('runRound: no eligible holders is SKIPPED / no_holders', async () => {
  const { db, close } = await makeDb('no-holders');
  try {
    const cfg = makeCfg();
    const fakes = makeFakes();
    fakes.holdersService = {
      async snapshot() {
        return { takenAt: new Date().toISOString(), slot: 1, supply: '1000000000000000', holders: [{ wallet: address(), balance: '10' }] };
      },
    };

    const round = await runRound({ cfg, db, ...fakes });
    assert.equal(round.status, 'SKIPPED');
    assert.equal(round.skipReason, 'no_holders');
    assert.equal(round.snapshot.holders.length, 0);
    assert.equal(fakes.calls.quote.length, 0);
  } finally {
    await close();
  }
});

test('runRound: an unavailable holders service fails the round honestly instead of inventing holders', async () => {
  const { db, close } = await makeDb('no-service');
  try {
    const cfg = makeCfg();
    const fakes = makeFakes();
    const round = await runRound({ cfg, db, ...fakes, holdersService: null });

    assert.equal(round.status, 'FAILED');
    assert.match(round.error, /holder snapshot unavailable/);
    assert.equal(round.resumeFrom, 'SNAPSHOT');
    assert.equal(fakes.calls.quote.length, 0);
  } finally {
    await close();
  }
});

/* ------------------------------------------------------------------ LIVE */

/**
 * LIVE-mode fakes: a chain that accepts every swap, fills 3% worse than the
 * quote, and a distributor whose per-transfer outcome the test decides.
 */
async function makeLiveFakes({ failTransfers = 0 } = {}) {
  const { ComputeBudgetProgram, TransactionMessage, VersionedTransaction } = await import('@solana/web3.js');
  const unsigned = new VersionedTransaction(
    new TransactionMessage({
      payerKey: VAULT_KEY.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })],
    }).compileToV0Message(),
  );

  const SLIPPED = 97n; // the fill is 97% of the quote
  const state = { failTransfers };
  const calls = { quote: [], sent: [], signed: [], transfers: [] };
  const lamportsByMint = new Map();

  const rpc = {
    async getBalanceLamports() {
      return 2_500_000_000n;
    },
    async getTokenSupply() {
      return { amountRaw: 1_000_000_000_000_000n, decimals: 6, uiAmountString: '1000000000' };
    },
    async sendRawTransaction(raw) {
      calls.sent.push(raw);
      calls.signed.push(VersionedTransaction.deserialize(raw));
      return `swapsig${calls.sent.length}`;
    },
    async confirmSignature(signature) {
      return { signature, status: 'confirmed', slot: 1, err: null };
    },
  };

  const jup = {
    async quote({ outputMint, amount }) {
      calls.quote.push(outputMint);
      lamportsByMint.set(outputMint, BigInt(amount));
      return { inAmount: String(amount), outAmount: (BigInt(amount) / 1000n).toString(), outputMint, routePlan: [] };
    },
    async buildSwapTx() {
      return { swapTransaction: Buffer.from(unsigned.serialize()).toString('base64'), lastValidBlockHeight: 1000, simulationError: null };
    },
  };

  const dist = {
    async balanceOf() {
      return 0n;
    },
    async measureReceived(vaultAddress, mint, beforeRaw) {
      const received = ((lamportsByMint.get(mint) / 1000n) * SLIPPED) / 100n;
      return { beforeRaw: BigInt(beforeRaw), afterRaw: BigInt(beforeRaw) + received, receivedRaw: received };
    },
    async ensureAndTransfer(vaultKeypair, mint, decimals, rows) {
      assert.equal(vaultKeypair.publicKey.toBase58(), VAULT, 'the vault signs its own transfers');
      calls.transfers.push({ mint, decimals, wallets: rows.map((r) => r.wallet) });
      const tx = `xfer${calls.transfers.length}`;
      return rows.map((row) => {
        if (state.failTransfers > 0) {
          state.failTransfers -= 1;
          return { wallet: row.wallet, mint, amountRaw: row.amountRaw, tx: null, status: 'FAILED', error: 'did not confirm' };
        }
        return { wallet: row.wallet, mint, amountRaw: row.amountRaw, tx, status: 'DONE', error: null };
      });
    },
  };

  const { universeService, holdersService } = makeFakes();
  return { cfg: makeCfg({ LIVE: '1' }), rpc, jup, dist, universeService, holdersService, calls, state, SLIPPED };
}

test('runRound: LIVE signs and sends, and distributes the measured delta rather than the quote', async () => {
  const { db, close } = await makeDb('live');
  try {
    const { cfg, rpc, jup, dist, universeService, holdersService, calls, SLIPPED } = await makeLiveFakes();
    assert.equal(cfg.mode, 'LIVE');

    const round = await runRound({ cfg, db, rpc, jup, dist, vault: VAULT_KEY, universeService, holdersService });

    assert.equal(round.status, 'DONE', round.error ?? '');
    assert.equal(round.simulated, false);
    assert.equal(calls.sent.length, round.swaps.length, 'one swap transaction per stock');
    for (const tx of calls.signed) {
      assert.ok(tx.signatures.some((sig) => sig.some((b) => b !== 0)), 'the vault actually signed the swap');
    }
    for (const swap of round.swaps) {
      assert.equal(swap.status, 'DONE');
      assert.match(swap.tx, /^swapsig\d+$/);
      const quoted = BigInt(swap.quotedOut);
      assert.equal(BigInt(swap.receivedRaw), (quoted * SLIPPED) / 100n);
      assert.ok(BigInt(swap.receivedRaw) < quoted, 'the fill is the measured delta, not the quote');
    }
    assert.ok(calls.transfers.length > 0);
    for (const call of calls.transfers) assert.equal(call.decimals, 8, 'xStocks are 8 decimals');
    for (const transfer of round.transfers) {
      assert.equal(transfer.status, 'DONE');
      assert.match(transfer.tx, /^xfer\d+$/);
    }
    assert.equal(round.stats.transfersFailed, 0);

    // Conservation still holds against the real fill.
    const carry = new Map((round.carryOut ?? []).map((c) => [c.mint, BigInt(c.amountRaw)]));
    for (const swap of round.swaps) {
      const distributed = sum(round.transfers.filter((t) => t.mint === swap.mint), (t) => t.amountRaw);
      assert.equal(distributed + (carry.get(swap.mint) ?? 0n), BigInt(swap.receivedRaw));
    }
  } finally {
    await close();
  }
});

test('runRound: --retry re-sends only the transfers that failed, and never re-swaps', async () => {
  const { db, close } = await makeDb('retry-done');
  try {
    const fakes = await makeLiveFakes({ failTransfers: 2 });
    const { cfg, rpc, jup, dist, universeService, holdersService, calls, state } = fakes;

    const round = await runRound({ cfg, db, rpc, jup, dist, vault: VAULT_KEY, universeService, holdersService });
    assert.equal(round.status, 'DONE');
    assert.equal(round.stats.transfersFailed, 2);

    const failed = round.transfers.filter((t) => t.status === 'FAILED');
    assert.equal(failed.length, 2);
    for (const transfer of failed) assert.equal(transfer.tx, null);

    const quotesBefore = calls.quote.length;
    const swapsBefore = calls.sent.length;
    const transferCallsBefore = calls.transfers.length;
    state.failTransfers = 0;

    const retried = await runRound({ cfg, db, rpc, jup, dist, vault: VAULT_KEY, universeService, holdersService, roundId: round.id, retry: true });

    assert.equal(retried.status, 'DONE');
    assert.equal(calls.quote.length, quotesBefore, 'a transfer retry never re-quotes');
    assert.equal(calls.sent.length, swapsBefore, 'a transfer retry never re-swaps');

    const resent = calls.transfers.slice(transferCallsBefore);
    assert.equal(resent.reduce((acc, call) => acc + call.wallets.length, 0), 2, 'only the two failed transfers were resent');
    const resentWallets = new Set(resent.flatMap((call) => call.wallets));
    for (const transfer of failed) {
      assert.ok(resentWallets.has(transfer.wallet));
      const after = retried.transfers.find((t) => t.wallet === transfer.wallet && t.mint === transfer.mint);
      assert.equal(after.status, 'DONE');
      assert.equal(after.error, null);
      assert.match(after.tx, /^xfer\d+$/);
      assert.equal(after.amountRaw, transfer.amountRaw, 'the amount owed did not change');
    }
    assert.equal(retried.stats.transfersFailed, 0);
    assert.equal(retried.transfers.length, round.transfers.length, 'no phantom transfers appeared');

    // Nothing left to retry: the round comes back untouched and nothing is sent.
    const again = await runRound({ cfg, db, rpc, jup, dist, vault: VAULT_KEY, universeService, holdersService, roundId: round.id, retry: true });
    assert.equal(again.status, 'DONE');
    assert.equal(calls.transfers.length, transferCallsBefore + resent.length);
    assert.equal(calls.quote.length, quotesBefore);
  } finally {
    await close();
  }
});

test('rebuildPlan: refuses to distribute when the stored demand cannot be reproduced', async () => {
  const { db, close } = await makeDb('tamper');
  try {
    const cfg = makeCfg();
    const round = await runRound({ cfg, db, ...makeFakes() });
    const tampered = { ...round, demand: round.demand.map((d, i) => (i === 0 ? { ...d, solLamports: '999999999' } : d)) };
    assert.throws(() => rebuildPlan(tampered, cfg), /does not match the stored round/);
  } finally {
    await close();
  }
});

/* ------------------------------------------------------------ scheduler */

test('scheduler: the round id and the UTC marks are what the contract says', () => {
  assert.equal(roundIdFor(new Date('2026-09-07T12:00:00Z')), 'r_2026-09-07T12');
  assert.equal(roundIdFor(new Date('2026-01-02T00:00:00Z')), 'r_2026-01-02T00');

  assert.equal(nextMark(6, Date.parse('2026-09-07T11:59:00Z')).toISOString(), '2026-09-07T12:00:00.000Z');
  assert.equal(nextMark(6, Date.parse('2026-09-07T12:00:00Z')).toISOString(), '2026-09-07T18:00:00.000Z');
  assert.equal(nextMark(6, Date.parse('2026-09-07T18:01:00Z')).toISOString(), '2026-09-08T00:00:00.000Z');
});

test('scheduler: jitter is deterministic per round id and inside the configured bounds', () => {
  const first = jitterFor('r_2026-09-07T12', 10);
  const again = jitterFor('r_2026-09-07T12', 10);
  assert.deepEqual(first, again, 'the same round id always gets the same jitter');

  const seen = new Set();
  for (let hour = 0; hour < 24; hour += 6) {
    for (const day of ['01', '02', '03', '04', '05']) {
      const id = `r_2026-09-${day}T${String(hour).padStart(2, '0')}`;
      const jitter = jitterFor(id, 10);
      assert.ok(Math.abs(jitter.seconds) <= 600, `${id} jitter out of bounds: ${jitter.seconds}s`);
      assert.equal(jitter.ms, jitter.seconds * 1000);
      assert.ok(Math.abs(jitter.minutes) <= 10);
      assert.deepEqual(jitterFor(id, 10), jitter);
      seen.add(jitter.seconds);
    }
  }
  assert.ok(seen.size > 10, 'jitter actually varies between rounds');

  assert.deepEqual(jitterFor('r_2026-09-07T12', 0), { ms: 0, seconds: 0, minutes: 0 });

  const cfg = { intervalHours: 6, roundJitterMin: 10 };
  const plan = planNext(cfg, Date.parse('2026-09-07T11:00:00Z'));
  assert.equal(plan.roundId, 'r_2026-09-07T12');
  assert.equal(plan.mark.toISOString(), '2026-09-07T12:00:00.000Z');
  const offset = plan.fireAt.getTime() - plan.mark.getTime();
  assert.ok(Math.abs(offset) <= 600_000, `fire time is ${offset}ms from the mark`);

  // A negative jitter that has already passed fires now, never in the past.
  const late = planNext(cfg, Date.parse('2026-09-07T12:00:30Z'));
  assert.ok(late.fireAt.getTime() >= Date.parse('2026-09-07T12:00:30Z'));
});

test('scheduler: resumes an unfinished round on boot before scheduling the next one', async () => {
  const { db, close } = await makeDb('boot');
  try {
    const cfg = makeCfg();
    await db.createRound({ id: 'r_2026-09-07T06', status: 'SWAPPING', scheduledAt: '2026-09-07T06:00:00.000Z' });

    const runs = [];
    const timers = [];
    const keeper = start({
      cfg,
      db,
      rpc: {},
      jup: {},
      runRound: async (deps) => {
        runs.push({ roundId: deps.roundId ?? null, scheduledAt: deps.scheduledAt ?? null });
        return { id: deps.roundId ?? 'r_new', status: 'DONE', finishedAt: new Date().toISOString(), error: null };
      },
      now: () => Date.parse('2026-09-07T11:00:00Z'),
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimer: () => {},
    });

    await keeper.ready();

    assert.equal(runs.length, 1, 'the unfinished round was resumed');
    assert.equal(runs[0].roundId, 'r_2026-09-07T06');

    const status = keeper.status();
    assert.equal(status.enabled, true);
    assert.equal(status.mode, 'DRY_RUN');
    assert.equal(status.lastRoundId, 'r_2026-09-07T06');
    assert.equal(status.nextRoundId, 'r_2026-09-07T12');
    assert.equal(status.nextMark, '2026-09-07T12:00:00.000Z');
    assert.equal(keeper.nextRoundAt(), status.nextRoundAt);
    assert.equal(timers.length, 1, 'exactly one timer is armed');
    assert.ok(timers[0].ms > 0 && timers[0].ms <= 3600_000 + 600_000);

    // Firing the timer runs the scheduled round and arms the next one.
    await timers[0].fn();
    assert.equal(runs.length, 2);
    assert.equal(runs[1].roundId, null);
    assert.equal(new Date(runs[1].scheduledAt).toISOString(), '2026-09-07T12:00:00.000Z');
    assert.equal(timers.length, 2);

    keeper.stop();
    assert.equal(keeper.nextRoundAt(), null);
    assert.equal(keeper.status().stopped, true);
  } finally {
    await close();
  }
});

test('scheduler: READ_ONLY has no keeper at all', async () => {
  const { db, close } = await makeDb('readonly');
  try {
    const cfg = buildConfig({ TOKEN_MINT });
    assert.equal(cfg.mode, 'READ_ONLY');

    let ran = 0;
    const keeper = start({
      cfg,
      db,
      runRound: async () => {
        ran += 1;
        return null;
      },
      setTimer: () => {
        throw new Error('READ_ONLY must not arm a timer');
      },
    });
    await keeper.ready();

    assert.equal(ran, 0);
    assert.equal(keeper.status().enabled, false);
    assert.equal(keeper.nextRoundAt(), null);
    keeper.stop();
  } finally {
    await close();
  }
});
