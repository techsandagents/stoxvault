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
import { ComputeBudgetProgram, Keypair, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

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

    /* the money adds up, after the round pays for its own token accounts */
    const pool = BigInt(round.poolLamports);
    const rent = round.rentEstimate;
    // 3 holders: 2 picks + 5 default picks + 2 picks = 9 recipient accounts.
    assert.equal(rent.accounts, 9);
    assert.equal(rent.perAccountLamports, '2074080');
    assert.equal(rent.rentLamports, (9n * 2_074_080n).toString());
    // 6 swaps + one 8-per-batch transfer tx per stock = 12 transactions.
    assert.equal(rent.txCount, 12);
    assert.equal(rent.feeLamports, (12n * (5_000n + BigInt(cfg.priorityFeeLamports))).toString());
    assert.equal(pool, 2_450_000_000n - BigInt(rent.totalLamports));
    assert.equal(BigInt(round.balanceLamports) - BigInt(round.reserveLamports), pool, 'balance = pool + reserve');
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
    // A rehearsal keeps its dust in its own key; the live carry is untouched.
    assert.deepEqual(await db.getKV('carry:sim'), round.carryOut);
    assert.equal(await db.getKV('carry'), null);
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

test('scheduler: a negative jitter never re-fires the same mark', async () => {
  const { db, close } = await makeDb('jitter-loop');
  try {
    const cfg = makeCfg();
    // The mark that exposed this: 12:00Z fires 403 seconds EARLY, so a round
    // that takes two minutes is still finished before its own mark.
    assert.equal(jitterFor('r_2026-09-08T12', 10).seconds, -403);

    // Planning is anchored on the last mark handled, not only on the clock.
    const after = planNext(cfg, Date.parse('2026-09-08T11:55:17Z'), Date.parse('2026-09-08T12:00:00Z'));
    assert.equal(after.mark.toISOString(), '2026-09-08T18:00:00.000Z');
    assert.equal(after.roundId, 'r_2026-09-08T18');

    let clock = Date.parse('2026-09-08T11:00:00Z');
    const timers = [];
    const runs = [];
    const keeper = start({
      cfg,
      db,
      rpc: {},
      jup: {},
      runRound: async (deps) => {
        runs.push(new Date(deps.scheduledAt).toISOString());
        clock += 2 * 60_000; // the round takes two minutes
        return { id: `r${runs.length}`, status: 'DONE', finishedAt: new Date(clock).toISOString(), error: null };
      },
      now: () => clock,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimer: () => {},
    });
    await keeper.ready();

    for (let i = 0; i < 6 && timers.length > 0; i++) {
      const timer = timers.shift();
      clock += timer.ms;
      await timer.fn();
    }
    keeper.stop();

    assert.equal(runs.length, 6, 'one round per fire, not a burst');
    assert.deepEqual(runs, [...new Set(runs)], 'no mark is ever run twice');
    assert.deepEqual(runs.slice(0, 4), [
      '2026-09-08T12:00:00.000Z',
      '2026-09-08T18:00:00.000Z',
      '2026-09-09T00:00:00.000Z',
      '2026-09-09T06:00:00.000Z',
    ]);
  } finally {
    await close();
  }
});

test('scheduler: a restart does not re-run the mark the last round already handled', async () => {
  const { db, close } = await makeDb('jitter-restart');
  try {
    const cfg = makeCfg();
    // The 12:00 round ran at 11:53 (jitter -403s) and the process restarted at
    // 11:56, before its own mark.
    await db.createRound({ id: 'r_2026-09-08T12', status: 'DONE', scheduledAt: '2026-09-08T12:00:00.000Z' });

    let ran = 0;
    const keeper = start({
      cfg,
      db,
      runRound: async () => {
        ran += 1;
        return null;
      },
      now: () => Date.parse('2026-09-08T11:56:00Z'),
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await keeper.ready();

    assert.equal(ran, 0, 'nothing was unfinished, so nothing ran');
    assert.equal(keeper.status().nextRoundId, 'r_2026-09-08T18');
    assert.equal(keeper.status().lastMark, '2026-09-08T12:00:00.000Z');
    keeper.stop();
  } finally {
    await close();
  }
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

/* ------------------------------------------- LIVE: sending exactly once */

/**
 * A LIVE chain that actually settles.
 *
 * Every send is counted and keyed by the transaction's own signature, and a
 * send that "lands" credits the vault's balance of the mint being bought. The
 * `script` decides, per send in order, what the keeper is allowed to learn:
 * whether the confirmation succeeds, whether the transaction really landed, and
 * whether the cluster will admit to having seen it. That is the whole space of
 * ways a swap can go wrong, and none of them may produce a second send for one
 * allocation.
 */
function makeSettlingChain({ script = [], balanceLamports = 2_500_000_000n, slipped = 97n } = {}) {
  // A fresh blockhash per build, so every swap transaction has its own
  // signature exactly as it would on chain.
  const unsignedTx = () =>
    new VersionedTransaction(
      new TransactionMessage({
        payerKey: VAULT_KEY.publicKey,
        recentBlockhash: Keypair.generate().publicKey.toBase58(),
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })],
      }).compileToV0Message(),
    );

  const balances = new Map(); // mint -> vault holding, base units
  const bySignature = new Map(); // signature -> behaviour
  const calls = { quote: [], sends: [], statusLookups: 0, transfers: [] };
  const lamportsByMint = new Map();
  let pendingMint = null;

  const fillFor = (mint) => ((lamportsByMint.get(mint) / 1000n) * slipped) / 100n;

  const rpc = {
    async getBalanceLamports() {
      return balanceLamports;
    },
    async getTokenSupply() {
      return { amountRaw: 1_000_000_000_000_000n, decimals: 6, uiAmountString: '1000000000' };
    },
    async sendRawTransaction(raw) {
      const tx = VersionedTransaction.deserialize(raw);
      const signature = b58encode(tx.signatures[0]);
      const behaviour = script[calls.sends.length] ?? { confirm: 'confirmed', lands: true, visible: true };
      const mint = pendingMint;
      calls.sends.push({ signature, mint });
      bySignature.set(signature, { ...behaviour, mint });
      if (behaviour.lands !== false) balances.set(mint, (balances.get(mint) ?? 0n) + fillFor(mint));
      return signature;
    },
    async confirmSignature(signature) {
      const behaviour = bySignature.get(signature);
      return { signature, status: behaviour?.confirm ?? 'confirmed', slot: 1, err: null };
    },
    async getSignatureStatuses(signatures, opts = {}) {
      calls.statusLookups += 1;
      assert.equal(opts.searchTransactionHistory, true, 'a reconciliation must search transaction history');
      return signatures.map((signature) => {
        const behaviour = bySignature.get(signature);
        if (!behaviour || behaviour.visible === false) return null;
        if (behaviour.lands === false) return { slot: 1, confirmations: 0, confirmationStatus: 'confirmed', err: { InstructionError: [0, 'custom'] } };
        return { slot: 1, confirmations: 0, confirmationStatus: 'confirmed', err: null };
      });
    },
  };

  const jup = {
    async quote({ outputMint, amount }) {
      calls.quote.push(outputMint);
      pendingMint = outputMint;
      lamportsByMint.set(outputMint, BigInt(amount));
      return { inAmount: String(amount), outAmount: (BigInt(amount) / 1000n).toString(), outputMint, routePlan: [] };
    },
    async buildSwapTx() {
      return { swapTransaction: Buffer.from(unsignedTx().serialize()).toString('base64'), lastValidBlockHeight: 1000, simulationError: null };
    },
  };

  const dist = {
    async balanceOf(owner, mint) {
      return balances.get(mint) ?? 0n;
    },
    async measureReceived(owner, mint, beforeRaw) {
      const after = balances.get(mint) ?? 0n;
      const before = BigInt(beforeRaw ?? 0);
      return { beforeRaw: before, afterRaw: after, receivedRaw: after > before ? after - before : 0n };
    },
    async ensureAndTransfer(vaultKeypair, mint, decimals, rows) {
      calls.transfers.push({ mint, wallets: rows.map((r) => r.wallet) });
      const tx = `xfer${calls.transfers.length}`;
      return rows.map((row) => ({ wallet: row.wallet, mint, amountRaw: row.amountRaw, tx, status: 'DONE', error: null }));
    },
  };

  const { universeService, holdersService } = makeFakes();
  return { cfg: makeCfg({ LIVE: '1' }), rpc, jup, dist, universeService, holdersService, calls, balances, fillFor };
}

test('runRound: a crash between send and persist leaves a SENDING row, and the resume adopts it instead of sending again', async () => {
  const { db, close } = await makeDb('sending-intent');
  try {
    const chain = makeSettlingChain();
    const { cfg, rpc, jup, dist, universeService, holdersService, calls } = chain;

    // A store that dies the instant the runner tries to record a finished swap:
    // the send already happened, the result never reaches disk. That is a SIGKILL
    // between rpc.sendRawTransaction and save({swaps}).
    let crash = true;
    const crashingDb = {
      ...db,
      async updateRound(id, patch) {
        const finishing = Array.isArray(patch.swaps) && patch.swaps.some((s) => s.status === 'DONE');
        if (crash && (finishing || patch.status === 'FAILED')) throw new Error('process died');
        return db.updateRound(id, patch);
      },
    };

    await assert.rejects(
      () => runRound({ cfg, db: crashingDb, rpc, jup, dist, vault: VAULT_KEY, universeService, holdersService }),
      /process died/,
    );

    assert.equal(calls.sends.length, 1, 'exactly one transaction was sent before the crash');
    const firstSend = calls.sends[0];

    const midway = await db.unfinishedRound();
    assert.equal(midway.status, 'SWAPPING');
    const intent = midway.swaps.find((s) => s.mint === firstSend.mint);
    assert.equal(intent.status, 'SENDING', 'the intent was written BEFORE the transaction was sent');
    assert.equal(intent.tx, firstSend.signature, 'the intent carries the signature that went to the cluster');
    assert.equal(intent.beforeRaw, '0', 'and the pre-send vault balance of that mint');

    crash = false;
    const resumed = await runRound({ cfg, db, rpc, jup, dist, vault: VAULT_KEY, universeService, holdersService });

    assert.equal(resumed.id, midway.id);
    assert.equal(resumed.status, 'DONE', resumed.error ?? '');
    assert.equal(
      calls.sends.filter((s) => s.signature === firstSend.signature).length,
      1,
      'the swap that already landed was never sent a second time',
    );
    assert.equal(calls.sends.length, resumed.swaps.length, 'one send per stock, no more');
    assert.equal(new Set(calls.sends.map((s) => s.mint)).size, resumed.swaps.length);

    const settled = resumed.swaps.find((s) => s.mint === firstSend.mint);
    assert.equal(settled.status, 'DONE');
    assert.equal(settled.tx, firstSend.signature, 'it adopted the first attempt rather than re-quoting');
    assert.equal(settled.receivedRaw, chain.fillFor(firstSend.mint).toString());
    assert.equal(settled.quotedOut, intent.quotedOut, 'the published quote survived the adoption');
    assert.equal(settled.beforeRaw, '0', 'measured against the balance from before the first attempt');
  } finally {
    await close();
  }
});

test('runRound: a swap that confirmed after a timeout is adopted, never re-sent', async () => {
  const { db, close } = await makeDb('adopt-timeout');
  try {
    // The first send lands, but the keeper's confirmation times out. Attempt 2
    // must discover the fill instead of buying the same allocation twice.
    const chain = makeSettlingChain({ script: [{ confirm: 'timeout', lands: true, visible: true }] });
    const { cfg, rpc, jup, dist, universeService, holdersService, calls } = chain;

    const round = await runRound({ cfg, db, rpc, jup, dist, vault: VAULT_KEY, universeService, holdersService });

    assert.equal(round.status, 'DONE', round.error ?? '');
    assert.equal(calls.sends.length, round.swaps.length, 'no allocation was sent twice');
    assert.ok(calls.statusLookups > 0, 'the previous signature was reconciled before any retry');

    const first = calls.sends[0];
    const swap = round.swaps.find((s) => s.mint === first.mint);
    assert.equal(swap.status, 'DONE');
    assert.equal(swap.tx, first.signature);
    // Measured from the balance taken before attempt ONE, so the fill is counted
    // rather than stranded outside receivedRaw.
    assert.equal(swap.receivedRaw, chain.fillFor(first.mint).toString());
    assert.equal(BigInt(round.stats.solSpentLamports), sum(round.swaps, (s) => s.solLamports));
  } finally {
    await close();
  }
});

test('runRound: a swap whose fate is unknown is recorded UNRESOLVED, and nothing is re-sent', async () => {
  const { db, close } = await makeDb('unresolved');
  try {
    // Sent, never confirmed, and the cluster will not say whether it exists.
    const chain = makeSettlingChain({ script: [{ confirm: 'timeout', lands: false, visible: false }] });
    const { cfg, rpc, jup, dist, universeService, holdersService, calls } = chain;

    const round = await runRound({ cfg, db, rpc, jup, dist, vault: VAULT_KEY, universeService, holdersService });

    assert.equal(round.status, 'DONE', round.error ?? '');
    const first = calls.sends[0];
    const swap = round.swaps.find((s) => s.mint === first.mint);
    assert.equal(swap.status, 'UNRESOLVED');
    assert.equal(swap.tx, first.signature, 'the signature an operator has to settle is on the record');
    assert.equal(swap.receivedRaw, null);
    assert.match(swap.error, /unknown/i);

    assert.equal(calls.sends.filter((s) => s.mint === first.mint).length, 1, 'an unknown fate never becomes a second send');
    assert.equal(calls.sends.length, round.swaps.length);
    assert.equal(round.stats.swapsUnresolved, 1);
    assert.equal(round.stats.solUnresolvedLamports, swap.solLamports);
    assert.ok(BigInt(round.stats.solSpentLamports) < sum(round.swaps, (s) => s.solLamports));
    assert.equal(round.transfers.filter((t) => t.mint === first.mint).length, 0, 'nobody is paid in a stock we may not own');

    // And a later run leaves it alone rather than gambling on it.
    const sendsBefore = calls.sends.length;
    const again = await runRound({ cfg, db, rpc, jup, dist, vault: VAULT_KEY, universeService, holdersService, roundId: round.id, retry: true });
    assert.equal(again.swaps.find((s) => s.mint === first.mint).status, 'UNRESOLVED');
    assert.equal(calls.sends.length, sendsBefore, 'a retry does not re-send an unresolved swap either');
  } finally {
    await close();
  }
});

test('runRound: a swap that provably cannot land is retried, exactly once more', async () => {
  const { db, close } = await makeDb('expired-retry');
  try {
    // An expired blockhash is the one honest "this can never land" signal, so a
    // fresh attempt is safe — and is what the round should do.
    const chain = makeSettlingChain({ script: [{ confirm: 'expired', lands: false, visible: false }] });
    const { cfg, rpc, jup, dist, universeService, holdersService, calls } = chain;

    const round = await runRound({ cfg, db, rpc, jup, dist, vault: VAULT_KEY, universeService, holdersService });

    assert.equal(round.status, 'DONE', round.error ?? '');
    const firstMint = calls.sends[0].mint;
    assert.equal(calls.sends.filter((s) => s.mint === firstMint).length, 2, 'one dead attempt, one real one');
    assert.equal(calls.sends.length, round.swaps.length + 1);

    const swap = round.swaps.find((s) => s.mint === firstMint);
    assert.equal(swap.status, 'DONE');
    assert.equal(swap.tx, calls.sends[1].signature);
    assert.equal(swap.receivedRaw, chain.fillFor(firstMint).toString());
  } finally {
    await close();
  }
});

/* --------------------------------------------------------------- mode */

test('runRound: a round created in DRY_RUN is never finished by a LIVE process', async () => {
  const { db, close } = await makeDb('mode-dry-to-live');
  try {
    const chain = makeSettlingChain();
    const { cfg, rpc, jup, dist, universeService, holdersService, calls } = chain;
    assert.equal(cfg.mode, 'LIVE');

    // A rehearsal that was interrupted halfway: quotes taken, nothing executed.
    const stale = await db.createRound({
      id: 'r_2026-09-07T06',
      scheduledAt: '2026-09-07T06:00:00.000Z',
      status: 'SWAPPING',
      mode: 'DRY_RUN',
      simulated: true,
      poolLamports: '2000000000',
      swaps: [{ mint: bySymbol('NVDAx'), symbol: 'NVDAx', solLamports: '2000000000', status: 'PENDING' }],
    });

    const round = await runRound({ cfg, db, rpc, jup, dist, vault: VAULT_KEY, universeService, holdersService });

    const refused = await db.getRound(stale.id);
    assert.equal(refused.status, 'FAILED');
    assert.match(refused.error, /DRY_RUN/);
    assert.match(refused.error, /LIVE/);
    assert.deepEqual(refused.modeMismatch, { roundMode: 'DRY_RUN', processMode: 'LIVE' });
    assert.equal(refused.swaps[0].status, 'PENDING', 'not one simulated allocation was executed');
    assert.ok(
      !calls.sends.some((s) => s.mint === bySymbol('NVDAx') && BigInt(2_000_000_000) === 0n),
      'the stale allocation was never sent',
    );

    assert.notEqual(round.id, stale.id, 'a fresh round was opened instead');
    assert.equal(round.mode, 'LIVE');
    assert.equal(round.simulated, false);
    assert.equal(round.status, 'DONE', round.error ?? '');
  } finally {
    await close();
  }
});

test('runRound: a round created in LIVE is never finished by a DRY_RUN process', async () => {
  const { db, close } = await makeDb('mode-live-to-dry');
  try {
    const cfg = makeCfg(); // DRY_RUN
    const fakes = makeFakes();

    // Real SOL already left the vault for this round.
    const paid = await db.createRound({
      id: 'r_2026-09-07T06',
      scheduledAt: '2026-09-07T06:00:00.000Z',
      status: 'SWAPPING',
      mode: 'LIVE',
      simulated: false,
      poolLamports: '2000000000',
      swaps: [{ mint: bySymbol('NVDAx'), symbol: 'NVDAx', solLamports: '2000000000', status: 'DONE', tx: 'realsig', receivedRaw: '2000000' }],
    });

    const round = await runRound({ cfg, db, ...fakes });

    const refused = await db.getRound(paid.id);
    assert.equal(refused.status, 'FAILED');
    assert.match(refused.error, /LIVE/);
    assert.match(refused.error, /DRY_RUN/);
    assert.equal(refused.swaps[0].tx, 'realsig', 'the real swap is untouched');
    assert.equal(refused.transfers.length, 0, 'no simulated transfer was written over real stock');
    assert.notEqual(round.id, paid.id);
    assert.equal(round.mode, 'DRY_RUN');

    // An operator who asks for that round by name is told why, not quietly given
    // a different one.
    const asked = await runRound({ cfg, db, ...fakes, roundId: paid.id, retry: true });
    assert.equal(asked.id, paid.id);
    assert.equal(asked.status, 'FAILED');
  } finally {
    await close();
  }
});

/* --------------------------------------------------------------- carry */

test('runRound: a simulated round never reads or writes the live carry key', async () => {
  const { db, close } = await makeDb('carry-modes');
  try {
    const cfg = makeCfg();
    const realDust = [{ mint: bySymbol('NVDAx'), amountRaw: '123456789' }];
    await db.setKV('carry', realDust);

    const round = await runRound({ cfg, db, ...makeFakes() });

    assert.equal(round.status, 'DONE', round.error ?? '');
    assert.equal(round.simulated, true);
    assert.deepEqual(round.carryIn, [], 'a rehearsal does not fold real dust into fictional allocations');
    assert.deepEqual(await db.getKV('carry'), realDust, 'the live carry key is exactly as it was');
    assert.deepEqual(await db.getKV('carry:sim'), round.carryOut);
    assert.ok(round.carryOut.length > 0, 'and the rehearsal still carries its own dust somewhere');
  } finally {
    await close();
  }
});

test('runRound: stock bought but not delivered carries over instead of being stranded', async () => {
  const { db, close } = await makeDb('undelivered');
  try {
    const fakes = await makeLiveFakes({ failTransfers: 2 });
    const { cfg, rpc, jup, dist, universeService, holdersService } = fakes;

    const round = await runRound({ cfg, db, rpc, jup, dist, vault: VAULT_KEY, universeService, holdersService });

    assert.equal(round.status, 'DONE');
    const failed = round.transfers.filter((t) => t.status === 'FAILED');
    assert.equal(failed.length, 2);

    const carry = new Map(round.carryOut.map((c) => [c.mint, BigInt(c.amountRaw)]));
    const undelivered = new Map(round.undelivered.map((c) => [c.mint, BigInt(c.amountRaw)]));
    assert.ok(undelivered.size > 0);
    for (const transfer of failed) {
      assert.ok(undelivered.has(transfer.mint), 'the stock we could not deliver is recorded');
      assert.ok(carry.get(transfer.mint) >= BigInt(transfer.amountRaw), 'and it is inside the carry-over');
    }

    // Conservation against reality: every token bought is either in a holder's
    // wallet or in the carry. Nothing is outside both.
    for (const swap of round.swaps) {
      if (swap.status !== 'DONE') continue;
      const delivered = sum(round.transfers.filter((t) => t.mint === swap.mint && t.status === 'DONE'), (t) => t.amountRaw);
      assert.equal(delivered + (carry.get(swap.mint) ?? 0n), BigInt(swap.receivedRaw), `stranded tokens for ${swap.symbol}`);
    }
    assert.deepEqual(await db.getKV('carry'), round.carryOut, 'the next round starts from it');
  } finally {
    await close();
  }
});

/* ---------------------------------------------------------------- rent */

test('runRound: a round that cannot pay for its own token accounts is SKIPPED / rent_unfunded', async () => {
  const { db, close } = await makeDb('rent');
  try {
    const cfg = makeCfg();
    const fakes = makeFakes(); // 2.5 SOL in the vault, 2.45 SOL of pool
    // 200 eligible holders on the default 5-stock basket = 1000 recipient
    // accounts. At ~0.00207 SOL of rent each that is ~2.07 SOL against a 2.45
    // SOL pool, which leaves less than the 0.5 SOL minimum.
    const many = Array.from({ length: 200 }, () => ({ wallet: address(), balance: '2000000000000' }));
    fakes.holdersService = {
      async snapshot() {
        return { takenAt: new Date().toISOString(), slot: 1, supply: '1000000000000000', holders: many, source: 'test-holders' };
      },
    };

    const round = await runRound({ cfg, db, ...fakes });

    assert.equal(round.status, 'SKIPPED');
    assert.equal(round.skipReason, 'rent_unfunded');
    assert.equal(round.snapshot.holders.length, 200, 'the snapshot is still published honestly');
    assert.equal(fakes.calls.quote.length, 0, 'nothing is bought for a round that cannot deliver it');
    assert.equal(round.transfers.length, 0);

    // The ledger says where the SOL would have gone.
    assert.equal(round.rentEstimate.accounts, 1000);
    assert.equal(round.rentEstimate.rentLamports, (1000n * 2_074_080n).toString());
    assert.equal(round.rentEstimate.source, 'constant');
    assert.ok(BigInt(round.rentEstimate.totalLamports) > BigInt(cfg.minRoundPoolLamports));
    assert.equal(round.poolLamports, round.rentEstimate.netPoolLamports);
    assert.ok(BigInt(round.poolLamports) < BigInt(cfg.minRoundPoolLamports));
  } finally {
    await close();
  }
});

test('runRound: the rent reserve is read from the RPC when it will answer', async () => {
  const { db, close } = await makeDb('rent-rpc');
  try {
    const cfg = makeCfg();
    const fakes = makeFakes();
    const asked = [];
    fakes.rpc.call = async (method, params) => {
      asked.push([method, params]);
      if (method === 'getMinimumBalanceForRentExemption') return 2_100_000;
      throw new Error(`unexpected rpc call ${method}`);
    };

    const round = await runRound({ cfg, db, ...fakes });

    assert.equal(round.status, 'DONE', round.error ?? '');
    assert.deepEqual(asked, [['getMinimumBalanceForRentExemption', [170]]]);
    assert.equal(round.rentEstimate.source, 'rpc');
    assert.equal(round.rentEstimate.perAccountLamports, '2100000');
    // No prefs in this store: 3 holders x the 5-stock default basket.
    assert.equal(round.rentEstimate.accounts, 15);
    assert.equal(round.rentEstimate.rentLamports, (15n * 2_100_000n).toString());
    assert.equal(BigInt(round.poolLamports), 2_450_000_000n - BigInt(round.rentEstimate.totalLamports));
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
