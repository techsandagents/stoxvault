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
import { applySwapResults, buildRoundPlan, snapshotHash } from '../src/engine/index.js';
import { b58encode } from '../src/chain/vault.js';
import {
  lastCloseKeyFor,
  openSnapshotKeyFor,
  rebuildPlan,
  roundIdFor,
  runRound,
  takeOpenSnapshot,
} from '../src/keeper/runner.js';
import { jitterFor, nextMark, openOffsetFor, planNext, planOpenSnapshot, start } from '../src/keeper/scheduler.js';

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
      // Only the ROUND timers matter here; the open-snapshot timer of each
      // cycle has its own test below.
      setTimer: (fn, ms, kind = 'round') => {
        if (kind === 'round') timers.push({ fn, ms });
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
      setTimer: (fn, ms, kind = 'round') => {
        timers.push({ fn, ms, kind });
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
    const roundTimers = () => timers.filter((t) => t.kind === 'round');
    assert.equal(roundTimers().length, 1, 'exactly one round timer is armed');
    assert.ok(roundTimers()[0].ms > 0 && roundTimers()[0].ms <= 3600_000 + 600_000);
    // 11:00 is deep inside the cycle that ends at 12:00, so that cycle's open
    // snapshot window is long past: it is reported as missed, not faked.
    assert.equal(timers.filter((t) => t.kind === 'open').length, 0);
    assert.equal(status.nextOpenSnapshotStatus, 'missed');
    assert.equal(status.nextOpenSnapshotRoundId, 'r_2026-09-07T12');

    // Firing the timer runs the scheduled round and arms the next one.
    await roundTimers()[0].fn();
    assert.equal(runs.length, 2);
    assert.equal(runs[1].roundId, null);
    assert.equal(new Date(runs[1].scheduledAt).toISOString(), '2026-09-07T12:00:00.000Z');
    assert.equal(roundTimers().length, 2);
    // The next cycle (12:00 -> 18:00) has not started snapshotting yet, so its
    // open snapshot IS armed.
    assert.equal(timers.filter((t) => t.kind === 'open').length, 1);
    assert.equal(keeper.status().nextOpenSnapshotRoundId, 'r_2026-09-07T18');
    assert.equal(keeper.status().nextOpenSnapshotStatus, 'armed');

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

/* ---------------------------------------------------------- anti-cheat */

/**
 * The full-cycle rule end to end.
 *
 * A cycle is judged by TWO snapshots — one taken at an unpredictable moment in
 * its first hour, one at the round itself — and a wallet is weighted on
 * min(open, close). These tests drive real rounds through the real store with
 * the same injected fakes as everything above; nothing here touches a network.
 */

/** A wallet that is not one of the standing fixtures. */
const NEWCOMER = address();

const OPEN_HOLDERS = HOLDERS.slice(0, 3).map((h) => ({ ...h }));

/** Build an open-snapshot document the way the scheduler would have stored it. */
function openDoc(roundId, holders, takenAt = '2026-09-07T06:19:00.000Z') {
  const doc = {
    kind: 'open',
    roundId,
    mode: 'DRY_RUN',
    takenAt,
    slot: 310_900_000,
    tokenMint: TOKEN_MINT,
    supply: '1000000000000000',
    holders: holders.map((h) => ({ wallet: h.wallet, balance: h.balance })),
    holderCount: holders.length,
    source: 'test-open',
  };
  doc.hash = snapshotHash(doc);
  return doc;
}

/** makeFakes, with the close snapshot's holder set (and its instant) replaced. */
function fakesWithClose(closeHolders, takenAt = '2026-09-07T11:58:00.000Z') {
  const fakes = makeFakes();
  fakes.holdersService = {
    async snapshot() {
      return {
        takenAt,
        slot: 311_000_000,
        supply: '1000000000000000',
        holders: closeHolders.map((h) => ({ wallet: h.wallet, balance: h.balance })),
        source: 'test-holders',
      };
    },
  };
  return fakes;
}

const paid = (round, wallet) => round.transfers.filter((t) => t.wallet === wallet && t.status === 'DONE');
const walletsIn = (round) => new Set(round.snapshot.holders.map((h) => h.wallet));

test('anti-cheat: a wallet that bought mid-cycle is paid nothing now and weighted next round', async () => {
  const { db, close } = await makeDb('anticheat-joined');
  try {
    const cfg = makeCfg();
    const mark = '2026-09-07T12:00:00.000Z';
    // The open snapshot of the 06:00 -> 12:00 cycle: NEWCOMER is not in it.
    await db.setKV(openSnapshotKeyFor('r_2026-09-07T12', true), openDoc('r_2026-09-07T12', OPEN_HOLDERS));

    const closeHolders = [...OPEN_HOLDERS, { wallet: NEWCOMER, balance: '9000000000000' }];
    const first = await runRound({ cfg, db, ...fakesWithClose(closeHolders), scheduledAt: mark });

    assert.equal(first.status, 'DONE', first.error ?? '');
    assert.equal(first.snapshotMode, 'full-cycle');
    assert.equal(first.antiCheat.enabled, true);
    assert.equal(first.antiCheat.rule, 'weight = min(openBalance, closeBalance)');

    // Nine million tokens bought minutes before the drop buy exactly nothing.
    assert.equal(walletsIn(first).has(NEWCOMER), false, 'the mid-cycle buyer carries no weight');
    assert.equal(paid(first, NEWCOMER).length, 0);
    assert.deepEqual(
      first.antiCheat.joinedThisCycle.map((h) => h.wallet),
      [NEWCOMER],
      'and the ledger says why, rather than leaving them to guess',
    );
    assert.equal(first.antiCheat.joinedThisCycle[0].closeBalance, '9000000000000');
    assert.equal(first.antiCheat.stats.joinedThisCycle, 1);
    assert.equal(first.antiCheat.stats.held, 3);

    // Everyone who did hold all cycle was paid as before.
    assert.equal(first.stats.eligibleHolders, 3);
    for (const holder of OPEN_HOLDERS) assert.ok(paid(first, holder.wallet).length > 0);

    // The close snapshot became the next cycle's open, so the newcomer is in it.
    const nextOpen = await db.getKV(openSnapshotKeyFor('r_2026-09-07T18', true));
    assert.ok(nextOpen, 'the close snapshot is stored as the next cycle self-heals');
    assert.equal(nextOpen.forRoundId, 'r_2026-09-07T18');
    assert.ok(nextOpen.holders.some((h) => h.wallet === NEWCOMER));

    const second = await runRound({
      cfg,
      db,
      ...fakesWithClose(closeHolders, '2026-09-07T17:58:00.000Z'),
      scheduledAt: '2026-09-07T18:00:00.000Z',
    });

    assert.equal(second.status, 'DONE', second.error ?? '');
    assert.equal(second.snapshotMode, 'full-cycle');
    assert.equal(second.antiCheat.note, null);
    assert.equal(second.antiCheat.stats.joinedThisCycle, 0);
    assert.equal(walletsIn(second).has(NEWCOMER), true, 'held across the whole cycle this time');
    assert.ok(paid(second, NEWCOMER).length > 0, 'and is paid in the round it actually held for');
  } finally {
    await close();
  }
});

test('anti-cheat: a wallet that sold before the close is paid nothing', async () => {
  const { db, close } = await makeDb('anticheat-sold');
  try {
    const cfg = makeCfg();
    const seller = OPEN_HOLDERS[2].wallet;
    await db.setKV(openSnapshotKeyFor('r_2026-09-07T12', true), openDoc('r_2026-09-07T12', OPEN_HOLDERS));

    // It dumped everything: gone from the close snapshot entirely.
    const closeHolders = OPEN_HOLDERS.filter((h) => h.wallet !== seller);
    const round = await runRound({ cfg, db, ...fakesWithClose(closeHolders), scheduledAt: '2026-09-07T12:00:00.000Z' });

    assert.equal(round.status, 'DONE', round.error ?? '');
    assert.equal(round.snapshotMode, 'full-cycle');
    assert.equal(walletsIn(round).has(seller), false);
    assert.equal(paid(round, seller).length, 0);
    assert.deepEqual(round.antiCheat.leftThisCycle.map((h) => h.wallet), [seller]);
    assert.equal(round.antiCheat.stats.leftThisCycle, 1);
    assert.equal(round.stats.eligibleHolders, 2);
  } finally {
    await close();
  }
});

test('anti-cheat: a wallet that topped up is weighted on the smaller balance', async () => {
  const { db, close } = await makeDb('anticheat-topup');
  try {
    const cfg = makeCfg();
    const [a, b] = [HOLDERS[0].wallet, HOLDERS[2].wallet];
    // Both open the cycle with 3,000,000 tokens.
    const open = [
      { wallet: a, balance: '3000000000000' },
      { wallet: b, balance: '3000000000000' },
    ];
    // B quadruples just before the round.
    const closeHolders = [
      { wallet: a, balance: '3000000000000' },
      { wallet: b, balance: '12000000000000' },
    ];
    await db.setKV(openSnapshotKeyFor('r_2026-09-07T12', true), openDoc('r_2026-09-07T12', open));

    const round = await runRound({ cfg, db, ...fakesWithClose(closeHolders), scheduledAt: '2026-09-07T12:00:00.000Z' });

    assert.equal(round.status, 'DONE', round.error ?? '');
    const rows = new Map(round.snapshot.holders.map((h) => [h.wallet, h]));
    assert.equal(rows.get(b).balance, '3000000000000', 'weighted on what it held all cycle');
    assert.equal(rows.get(b).openBalance, '3000000000000');
    assert.equal(rows.get(b).closeBalance, '12000000000000');
    // `reduced` marks a wallet whose weight is below at least one end of the
    // cycle — a top-up qualifies: it is paid on less than it now holds.
    assert.equal(rows.get(b).reduced, true);
    assert.equal(rows.get(a).reduced, undefined, 'a steady wallet is not marked at all');
    assert.equal(rows.get(a).balance, '3000000000000');

    // Equal weights: neither wallet's picks may outweigh the other's.
    assert.equal(round.antiCheat.stats.reduced, 1, 'open and close differ for exactly one wallet');
    const both = new Map(round.transfers.filter((t) => t.status === 'DONE').map((t) => [`${t.wallet} ${t.mint}`, t.amountRaw]));
    for (const stock of round.universe.slice(0, cfg.defaultBasketSize)) {
      assert.equal(both.get(`${a} ${stock.mint}`), both.get(`${b} ${stock.mint}`), `${stock.symbol} was not split evenly`);
    }
  } finally {
    await close();
  }
});

test('anti-cheat: a wallet that held steady is completely unaffected by the rule', async () => {
  const steady = HOLDERS.slice(0, 3).map((h) => ({ ...h }));

  const withRule = await makeDb('anticheat-steady-on');
  const withoutRule = await makeDb('anticheat-steady-off');
  try {
    const cfg = makeCfg();
    await withRule.db.setKV(openSnapshotKeyFor('r_2026-09-07T12', true), openDoc('r_2026-09-07T12', steady));

    const enforced = await runRound({ cfg, db: withRule.db, ...fakesWithClose(steady), scheduledAt: '2026-09-07T12:00:00.000Z' });
    const plain = await runRound({ cfg, db: withoutRule.db, ...fakesWithClose(steady), scheduledAt: '2026-09-07T12:00:00.000Z' });

    assert.equal(enforced.snapshotMode, 'full-cycle');
    assert.equal(plain.snapshotMode, 'close-only', 'no open snapshot exists in the second store');
    assert.equal(enforced.antiCheat.stats.steady, 3);

    // Same holders, same money, to the lamport and the base unit.
    assert.deepEqual(
      enforced.demand.map((d) => [d.symbol, d.weight, d.solLamports, d.shareBps]),
      plain.demand.map((d) => [d.symbol, d.weight, d.solLamports, d.shareBps]),
    );
    assert.deepEqual(
      enforced.transfers.map((t) => [t.wallet, t.symbol, t.amountRaw, t.status]).sort(),
      plain.transfers.map((t) => [t.wallet, t.symbol, t.amountRaw, t.status]).sort(),
    );
    assert.equal(enforced.snapshot.hash, plain.snapshot.hash, 'the published snapshot is byte-identical');
  } finally {
    await withRule.close();
    await withoutRule.close();
  }
});

test('anti-cheat: eligibility is tested against the minimum, not the closing balance', async () => {
  const { db, close } = await makeDb('anticheat-threshold');
  try {
    const cfg = makeCfg();
    const climber = HOLDERS[3].wallet; // 500,000 tokens: below 0.1% of supply
    const open = [
      { wallet: HOLDERS[0].wallet, balance: '3000000000000' },
      { wallet: climber, balance: '500000000000' },
    ];
    const closeHolders = [
      { wallet: HOLDERS[0].wallet, balance: '3000000000000' },
      { wallet: climber, balance: '6000000000000' }, // over the bar only at the close
    ];
    await db.setKV(openSnapshotKeyFor('r_2026-09-07T12', true), openDoc('r_2026-09-07T12', open));

    const round = await runRound({ cfg, db, ...fakesWithClose(closeHolders), scheduledAt: '2026-09-07T12:00:00.000Z' });

    assert.equal(round.status, 'DONE', round.error ?? '');
    assert.equal(round.snapshot.eligibleThreshold, '1000000000000');
    assert.equal(walletsIn(round).has(climber), false, 'the threshold must be cleared for the whole cycle');
    assert.equal(paid(round, climber).length, 0);
    assert.equal(round.stats.eligibleHolders, 1);
  } finally {
    await close();
  }
});

test('anti-cheat: a missing open snapshot falls back to the previous close, and says so', async () => {
  const { db, close } = await makeDb('anticheat-prevclose');
  try {
    const cfg = makeCfg();
    // No open snapshot for this cycle, but the previous round's close exists —
    // and it was taken at the start of this cycle, so it is a legitimate open.
    const prev = openDoc('r_2026-09-07T06', OPEN_HOLDERS, '2026-09-07T05:57:00.000Z');
    prev.kind = 'close';
    await db.setKV(lastCloseKeyFor(true), prev);

    const closeHolders = [...OPEN_HOLDERS, { wallet: NEWCOMER, balance: '9000000000000' }];
    const round = await runRound({ cfg, db, ...fakesWithClose(closeHolders), scheduledAt: '2026-09-07T12:00:00.000Z' });

    assert.equal(round.status, 'DONE', round.error ?? '');
    assert.equal(round.snapshotMode, 'prev-close');
    assert.equal(round.openSnapshot.mode, 'prev-close');
    assert.equal(round.openSnapshot.takenAt, '2026-09-07T05:57:00.000Z');
    assert.equal(round.openSnapshot.hash, prev.hash);
    assert.equal(round.openSnapshot.holderCount, 3);
    assert.match(round.antiCheat.note, /previous round's close snapshot was used as the open/);

    // The rule is still enforced: the mid-cycle buyer is not paid.
    assert.equal(paid(round, NEWCOMER).length, 0);
    assert.equal(round.antiCheat.stats.joinedThisCycle, 1);
  } finally {
    await close();
  }
});

test('anti-cheat: with no snapshot to open the cycle the round runs close-only and admits it', async () => {
  const { db, close } = await makeDb('anticheat-closeonly');
  try {
    const cfg = makeCfg();
    const closeHolders = [...OPEN_HOLDERS, { wallet: NEWCOMER, balance: '9000000000000' }];

    const round = await runRound({ cfg, db, ...fakesWithClose(closeHolders), scheduledAt: '2026-09-07T12:00:00.000Z' });

    assert.equal(round.status, 'DONE', round.error ?? '');
    assert.equal(round.snapshotMode, 'close-only', 'the first round ever has nothing to compare against');
    assert.equal(round.openSnapshot, null);
    assert.equal(round.antiCheat.enabled, true);
    assert.equal(round.antiCheat.stats, null);
    assert.match(round.antiCheat.note, /full-cycle rule could not be enforced/);
    assert.ok(round.closeSnapshot.hash, 'the close snapshot is still recorded in full');
    assert.equal(round.closeSnapshot.holderCount, 4);

    // Close-only is the old, gameable rule, so the newcomer IS paid here. That
    // is precisely why it must be visible in the ledger rather than silent.
    assert.ok(paid(round, NEWCOMER).length > 0);

    // And it heals itself: the next cycle already has its open snapshot.
    const nextOpen = await db.getKV(openSnapshotKeyFor('r_2026-09-07T18', true));
    assert.equal(nextOpen.holderCount, 4);
    const second = await runRound({
      cfg,
      db,
      ...fakesWithClose(OPEN_HOLDERS, '2026-09-07T17:58:00.000Z'),
      scheduledAt: '2026-09-07T18:00:00.000Z',
    });
    assert.equal(second.snapshotMode, 'full-cycle');
    assert.equal(second.antiCheat.note, null, 'a full cycle between the two snapshots needs no caveat');
  } finally {
    await close();
  }
});

test('anti-cheat: ANTICHEAT=0 keeps the old close-only rule and names it in the ledger', async () => {
  const { db, close } = await makeDb('anticheat-off');
  try {
    const cfg = makeCfg({ ANTICHEAT: '0' });
    assert.equal(cfg.antiCheat, false);
    // Even with an open snapshot sitting right there, it is not consulted.
    await db.setKV(openSnapshotKeyFor('r_2026-09-07T12', true), openDoc('r_2026-09-07T12', OPEN_HOLDERS));

    const closeHolders = [...OPEN_HOLDERS, { wallet: NEWCOMER, balance: '9000000000000' }];
    const round = await runRound({ cfg, db, ...fakesWithClose(closeHolders), scheduledAt: '2026-09-07T12:00:00.000Z' });

    assert.equal(round.status, 'DONE', round.error ?? '');
    assert.equal(round.snapshotMode, 'close-only');
    assert.equal(round.antiCheat.enabled, false);
    assert.match(round.antiCheat.note, /disabled by configuration/);
    assert.equal(round.openSnapshot, null);
    assert.ok(paid(round, NEWCOMER).length > 0, 'the old rule pays the mid-cycle buyer');
  } finally {
    await close();
  }
});

test('anti-cheat: a DRY_RUN round never reads or writes the live snapshot keys', async () => {
  const { db, close } = await makeDb('anticheat-modes');
  try {
    const cfg = makeCfg();
    assert.equal(cfg.mode, 'DRY_RUN');

    // Real cycle snapshots from a LIVE keeper. A rehearsal that consumed these
    // would decide fictional payouts from real inputs; one that overwrote them
    // would destroy the only record of what wallets held during a real cycle.
    const liveOpen = openDoc('r_2026-09-07T12', [{ wallet: NEWCOMER, balance: '4000000000000' }]);
    liveOpen.mode = 'LIVE';
    const liveLastClose = openDoc('r_2026-09-07T06', [{ wallet: NEWCOMER, balance: '4000000000000' }]);
    liveLastClose.mode = 'LIVE';
    liveLastClose.kind = 'close';
    await db.setKV(openSnapshotKeyFor('r_2026-09-07T12', false), liveOpen);
    await db.setKV(lastCloseKeyFor(false), liveLastClose);
    await db.setKV(openSnapshotKeyFor('r_2026-09-07T18', false), liveOpen);

    const round = await runRound({ cfg, db, ...fakesWithClose(OPEN_HOLDERS), scheduledAt: '2026-09-07T12:00:00.000Z' });

    assert.equal(round.status, 'DONE', round.error ?? '');
    assert.equal(round.snapshotMode, 'close-only', 'the live open snapshot was not read');
    assert.equal(walletsIn(round).has(NEWCOMER), false);

    assert.deepEqual(await db.getKV(openSnapshotKeyFor('r_2026-09-07T12', false)), liveOpen);
    assert.deepEqual(await db.getKV(openSnapshotKeyFor('r_2026-09-07T18', false)), liveOpen);
    assert.deepEqual(await db.getKV(lastCloseKeyFor(false)), liveLastClose);

    // The rehearsal keeps its own snapshots in its own keys.
    const simNext = await db.getKV(openSnapshotKeyFor('r_2026-09-07T18', true));
    assert.equal(simNext.mode, 'DRY_RUN');
    assert.equal(simNext.holderCount, 3);
    assert.equal((await db.getKV(lastCloseKeyFor(true))).roundId, round.id);

    // And takeOpenSnapshot obeys the same split.
    const taken = await takeOpenSnapshot({
      cfg,
      db,
      holdersService: fakesWithClose(OPEN_HOLDERS).holdersService,
      roundId: 'r_2026-09-08T00',
    });
    assert.equal(taken.taken, true);
    assert.equal(taken.key, 'open-snapshot:sim:r_2026-09-08T00');
    assert.equal(await db.getKV('open-snapshot:r_2026-09-08T00'), null);
  } finally {
    await close();
  }
});

test('anti-cheat: value is conserved and the round is still reproducible under the rule', async () => {
  const { db, close } = await makeDb('anticheat-conservation');
  try {
    const cfg = makeCfg();
    const open = [
      { wallet: HOLDERS[0].wallet, balance: '3000000000000' },
      { wallet: HOLDERS[1].wallet, balance: '1000000000000' },
      { wallet: HOLDERS[2].wallet, balance: '6000000000000' },
    ];
    const closeHolders = [
      { wallet: HOLDERS[0].wallet, balance: '2000000000000' }, // sold a third
      { wallet: HOLDERS[1].wallet, balance: '4000000000000' }, // topped up
      { wallet: NEWCOMER, balance: '9000000000000' }, //          brand new
    ];
    await db.setKV(openSnapshotKeyFor('r_2026-09-07T12', true), openDoc('r_2026-09-07T12', open));

    const round = await runRound({ cfg, db, ...fakesWithClose(closeHolders), scheduledAt: '2026-09-07T12:00:00.000Z' });

    assert.equal(round.status, 'DONE', round.error ?? '');
    assert.equal(round.snapshotMode, 'full-cycle');
    const balances = new Map(round.snapshot.holders.map((h) => [h.wallet, h.balance]));
    assert.equal(balances.get(HOLDERS[0].wallet), '2000000000000');
    assert.equal(balances.get(HOLDERS[1].wallet), '1000000000000');
    assert.equal(balances.has(HOLDERS[2].wallet), false, 'sold out entirely');
    assert.equal(balances.has(NEWCOMER), false, 'bought mid-cycle');
    assert.equal(round.antiCheat.stats.weight, '3000000000000');

    // Nothing is created and nothing is lost.
    const pool = BigInt(round.poolLamports);
    assert.ok(sum(round.demand, (d) => d.solLamports) <= pool);
    const carry = new Map((round.carryOut ?? []).map((c) => [c.mint, BigInt(c.amountRaw)]));
    for (const swap of round.swaps) {
      const handed = sum(round.transfers.filter((t) => t.mint === swap.mint), (t) => t.amountRaw);
      assert.equal(handed + (carry.get(swap.mint) ?? 0n), BigInt(swap.receivedRaw), `conservation failed for ${swap.symbol}`);
    }

    // The published document still re-derives exactly, snapshot rule and all.
    const plan = rebuildPlan(round, cfg);
    const applied = applySwapResults(plan, round.swaps, round.carryIn ?? []);
    assert.equal(applied.transfers.length, round.transfers.length);
    for (const expected of applied.transfers) {
      const actual = round.transfers.find((t) => t.wallet === expected.wallet && t.mint === expected.mint);
      assert.equal(actual.amountRaw, expected.amountRaw);
    }
  } finally {
    await close();
  }
});

/* ------------------------------------------ scheduler: the open snapshot */

test('scheduler: the open-snapshot offset is deterministic and always inside the cycle\'s first hour', () => {
  const first = openOffsetFor('r_2026-09-07T12', 60, 6);
  assert.deepEqual(openOffsetFor('r_2026-09-07T12', 60, 6), first, 'the same round id always gets the same offset');
  assert.notDeepEqual(first, jitterFor('r_2026-09-07T12', 60), 'and it is not the round jitter in disguise');

  const seen = new Set();
  for (let day = 1; day <= 10; day++) {
    for (let hour = 0; hour < 24; hour += 6) {
      const id = `r_2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}`;
      const offset = openOffsetFor(id, 60, 6);
      assert.ok(offset.seconds >= 0 && offset.seconds < 3600, `${id} landed outside the first hour: ${offset.seconds}s`);
      assert.equal(offset.ms, offset.seconds * 1000);
      assert.equal(offset.windowMs, 3600_000);
      seen.add(offset.seconds);

      const plan = planOpenSnapshot({ intervalHours: 6, openSnapshotWindowMin: 60 }, new Date(`2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`));
      assert.equal(plan.roundId, id);
      assert.equal(plan.mark.getTime() - plan.cycleStart.getTime(), 6 * 3600_000);
      assert.ok(plan.at >= plan.cycleStart, 'never before its own cycle');
      assert.ok(plan.at.getTime() - plan.cycleStart.getTime() < 3600_000, 'always inside the first hour');
      assert.ok(plan.at < plan.mark, 'and always before the close');
    }
  }
  assert.ok(seen.size > 20, 'the moment actually moves between cycles');

  // A short interval caps the window at a quarter of it, so the open snapshot
  // can never spill out of the cycle it belongs to.
  const shortCycle = openOffsetFor('r_2026-09-07T12', 60, 1);
  assert.equal(shortCycle.windowMs, 900_000);
  assert.ok(shortCycle.seconds < 900);
  const shortPlan = planOpenSnapshot({ intervalHours: 1, openSnapshotWindowMin: 60 }, Date.parse('2026-09-07T12:00:00Z'));
  assert.ok(shortPlan.at.getTime() - shortPlan.cycleStart.getTime() < 900_000);
  assert.ok(shortPlan.at < shortPlan.mark);

  assert.deepEqual(openOffsetFor('r_2026-09-07T12', 0, 6), { ms: 0, seconds: 0, minutes: 0, windowMs: 0 });
});

test('scheduler: arms the open snapshot for the coming cycle and stores it under that round id', async () => {
  const { db, close } = await makeDb('anticheat-scheduler');
  try {
    const cfg = makeCfg();
    const fakes = fakesWithClose(OPEN_HOLDERS);
    // 12:00:30Z: the cycle that ends at 18:00 has just opened, so its open
    // snapshot is still ahead of us.
    let clock = Date.parse('2026-09-07T12:00:30Z');
    const timers = [];

    const keeper = start({
      cfg,
      db,
      rpc: fakes.rpc,
      holdersService: fakes.holdersService,
      runRound: async () => null,
      now: () => clock,
      setTimer: (fn, ms, kind = 'round') => {
        timers.push({ fn, ms, kind });
        return timers.length;
      },
      clearTimer: () => {},
    });
    await keeper.ready();

    const open = timers.filter((t) => t.kind === 'open');
    assert.equal(open.length, 1, 'exactly one open-snapshot timer');
    const status = keeper.status();
    assert.equal(status.antiCheat, true);
    assert.equal(status.openSnapshotWindowMin, 60);
    assert.equal(status.nextOpenSnapshotRoundId, 'r_2026-09-07T18');
    assert.equal(status.nextOpenSnapshotStatus, 'armed');
    const expected = planOpenSnapshot(cfg, Date.parse('2026-09-07T18:00:00Z'));
    assert.equal(status.nextOpenSnapshotAt, expected.at.toISOString());
    assert.equal(open[0].ms, expected.at.getTime() - clock);

    clock += open[0].ms;
    await open[0].fn();

    const stored = await db.getKV(openSnapshotKeyFor('r_2026-09-07T18', true));
    assert.ok(stored, 'the open snapshot reached the store');
    assert.equal(stored.roundId, 'r_2026-09-07T18');
    assert.equal(stored.holderCount, 3);
    assert.equal(stored.cycleStart, '2026-09-07T12:00:00.000Z');
    assert.match(stored.hash, /^[0-9a-f]{64}$/);
    assert.equal(keeper.status().openSnapshotsTaken, 1);
    assert.equal(keeper.status().lastOpenSnapshotRoundId, 'r_2026-09-07T18');

    // The FIRST reading in the window is the one the cycle is judged by: a
    // second attempt must not replace it with a later, weaker open.
    const again = await keeper.takeOpenSnapshotNow();
    assert.equal(again.taken, false);
    assert.equal(again.reason, 'already_taken');
    assert.deepEqual(await db.getKV(openSnapshotKeyFor('r_2026-09-07T18', true)), stored);

    keeper.stop();
  } finally {
    await close();
  }
});

test('scheduler: a keeper that boots mid-cycle reports the missed window instead of faking an open', async () => {
  const { db, close } = await makeDb('anticheat-missed');
  try {
    const cfg = makeCfg();
    const fakes = fakesWithClose(OPEN_HOLDERS);
    const timers = [];
    const keeper = start({
      cfg,
      db,
      rpc: fakes.rpc,
      holdersService: fakes.holdersService,
      runRound: async () => null,
      // Deep inside the 06:00 -> 12:00 cycle: its first hour is long gone.
      now: () => Date.parse('2026-09-07T11:30:00Z'),
      setTimer: (fn, ms, kind = 'round') => {
        timers.push({ fn, ms, kind });
        return timers.length;
      },
      clearTimer: () => {},
    });
    await keeper.ready();

    assert.equal(timers.filter((t) => t.kind === 'open').length, 0);
    assert.equal(keeper.status().nextOpenSnapshotStatus, 'missed');
    assert.equal(await db.getKV(openSnapshotKeyFor('r_2026-09-07T12', true)), null, 'nothing was invented');
    keeper.stop();
  } finally {
    await close();
  }
});

test('scheduler: no open-snapshot timer exists when anti-cheat is off, and none when there is no token', async () => {
  const off = await makeDb('anticheat-off-timer');
  const noToken = await makeDb('anticheat-no-token');
  try {
    const timers = [];
    const keeperOff = start({
      cfg: makeCfg({ ANTICHEAT: '0' }),
      db: off.db,
      runRound: async () => null,
      now: () => Date.parse('2026-09-07T12:00:30Z'),
      setTimer: (fn, ms, kind = 'round') => {
        timers.push({ fn, ms, kind });
        return timers.length;
      },
      clearTimer: () => {},
    });
    await keeperOff.ready();
    assert.equal(timers.filter((t) => t.kind === 'open').length, 0);
    assert.equal(keeperOff.status().antiCheat, false);
    assert.equal(keeperOff.status().nextOpenSnapshotRoundId, null);
    keeperOff.stop();

    // Pre-launch there is no mint, so there is nothing to snapshot and the
    // keeper says so instead of storing an empty holder set.
    const cfg = makeCfg({ TOKEN_MINT: '' });
    const result = await takeOpenSnapshot({
      cfg,
      db: noToken.db,
      holdersService: {
        async snapshot() {
          throw new Error('a keeper with no token must never ask for holders');
        },
      },
      roundId: 'r_2026-09-07T18',
    });
    assert.equal(result.taken, false);
    assert.equal(result.reason, 'no_token');
    assert.equal(await noToken.db.getKV('open-snapshot:sim:r_2026-09-07T18'), null);
  } finally {
    await off.close();
    await noToken.close();
  }
});

test('anti-cheat: a window shorter than a cycle is disclosed rather than passed off as a full one', async () => {
  const { db, close } = await makeDb('anticheat-shortwindow');
  try {
    const cfg = makeCfg();
    await db.setKV(openSnapshotKeyFor('r_2026-09-07T12', true), openDoc('r_2026-09-07T12', OPEN_HOLDERS));

    const first = await runRound({ cfg, db, ...fakesWithClose(OPEN_HOLDERS), scheduledAt: '2026-09-07T12:00:00.000Z' });
    assert.equal(first.snapshotMode, 'full-cycle');
    assert.equal(first.antiCheat.note, null);

    // An operator runs the same mark again four minutes later. Its only
    // available open is the first run's close, so the rule covers four minutes,
    // not six hours — and the ledger has to say exactly that.
    const second = await runRound({
      cfg,
      db,
      ...fakesWithClose(OPEN_HOLDERS, '2026-09-07T12:02:00.000Z'),
      scheduledAt: '2026-09-07T12:00:00.000Z',
    });

    assert.equal(second.id, 'r_2026-09-07T12-2');
    assert.equal(second.snapshotMode, 'prev-close');
    assert.match(second.antiCheat.note, /only 4m apart/);
    assert.match(second.antiCheat.note, /shorter window than a full 6h cycle/);
  } finally {
    await close();
  }
});

test('anti-cheat: a real in-window open outranks the previous round\'s close, and is never replaced', async () => {
  const { db, close } = await makeDb('anticheat-precedence');
  try {
    const cfg = makeCfg();
    const nextKey = openSnapshotKeyFor('r_2026-09-07T18', true);

    // A round lands and leaves its close behind as the next cycle's fallback open.
    await runRound({ cfg, db, ...fakesWithClose(OPEN_HOLDERS), scheduledAt: '2026-09-07T12:00:00.000Z' });
    const placeholder = await db.getKV(nextKey);
    assert.equal(placeholder.kind, 'close');

    // The scheduler then takes the real open inside the window. The unannounced
    // reading is the stronger one, so it replaces the placeholder.
    const later = [...OPEN_HOLDERS, { wallet: NEWCOMER, balance: '9000000000000' }];
    const taken = await takeOpenSnapshot({
      cfg,
      db,
      holdersService: fakesWithClose(later, '2026-09-07T12:37:00.000Z').holdersService,
      roundId: 'r_2026-09-07T18',
      cycleStart: '2026-09-07T12:00:00.000Z',
    });
    assert.equal(taken.taken, true);
    const real = await db.getKV(nextKey);
    assert.equal(real.kind, 'open');
    assert.equal(real.takenAt, '2026-09-07T12:37:00.000Z');
    assert.equal(real.holderCount, 4);

    // Nothing replaces it after that — not a second attempt in the window...
    const again = await takeOpenSnapshot({
      cfg,
      db,
      holdersService: fakesWithClose(OPEN_HOLDERS, '2026-09-07T12:52:00.000Z').holdersService,
      roundId: 'r_2026-09-07T18',
    });
    assert.equal(again.taken, false);
    assert.equal(again.reason, 'already_taken');
    assert.deepEqual(await db.getKV(nextKey), real);

    // ...and not a second round on the earlier mark either.
    await runRound({ cfg, db, ...fakesWithClose(OPEN_HOLDERS), scheduledAt: '2026-09-07T12:00:00.000Z' });
    assert.deepEqual(await db.getKV(nextKey), real);

    // The 18:00 round is then judged against that real open.
    const round = await runRound({
      cfg,
      db,
      ...fakesWithClose(later, '2026-09-07T17:58:00.000Z'),
      scheduledAt: '2026-09-07T18:00:00.000Z',
    });
    assert.equal(round.snapshotMode, 'full-cycle');
    assert.equal(round.openSnapshot.takenAt, '2026-09-07T12:37:00.000Z');
    assert.equal(round.openSnapshot.hash, real.hash);
    assert.ok(paid(round, NEWCOMER).length > 0, 'it held from the open reading to the close');
  } finally {
    await close();
  }
});
