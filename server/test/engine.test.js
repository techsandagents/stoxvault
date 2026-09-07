/**
 * STOCKDROP engine tests.
 *
 * Fixture mints are deliberately unmistakable strings ("TEST_MINT_NVDAx"), not
 * base58 lookalikes: nothing in this repo should ever be able to pass a test
 * fixture off as a real Solana address.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  allocate,
  applySwapResults,
  buildRoundPlan,
  canonicalSnapshot,
  computeDemand,
  computeEligible,
  defaultPicks,
  DEFAULT_RULES,
  effectiveBasket,
  eligibleThreshold,
  PickError,
  rankUniverse,
  respreadPicks,
  snapshotHash,
  splitPool,
  validatePicks,
} from '../src/engine/index.js';

// ---------------------------------------------------------------- fixtures --

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const mintOf = (symbol) => `TEST_MINT_${symbol}`;

function stock(symbol, name, underlyingMcap, liquidityUsd, extra = {}) {
  return {
    mint: mintOf(symbol),
    symbol,
    name,
    logo: null,
    decimals: 8,
    tokenProgram: TOKEN_2022,
    yahooSymbol: symbol.replace(/x$/, ''),
    priceUsd: null,
    change24h: null,
    underlyingMcap,
    underlyingPrice: null,
    liquidityUsd,
    holderCount: null,
    ...extra,
  };
}

// Six stocks: the five that make up the default basket, plus TSLAx below them.
// Market caps are round synthetic numbers; only their ORDER matters here.
const ALL_STOCKS = [
  stock('AMZNx', 'Amazon.com Inc', 2_400_000_000_000, 900_000),
  stock('TSLAx', 'Tesla Inc', 1_100_000_000_000, 2_400_000),
  stock('NVDAx', 'NVIDIA Corp', 4_400_000_000_000, 3_100_000),
  stock('MSFTx', 'Microsoft Corp', 2_500_000_000_000, 1_200_000),
  stock('AAPLx', 'Apple Inc', 3_500_000_000_000, 2_000_000),
  stock('GOOGLx', 'Alphabet Inc', 2_600_000_000_000, 800_000),
];

const UNIVERSE = rankUniverse(ALL_STOCKS, { liqMinUsd: 50_000, size: 20 });

const ALICE = 'TEST_WALLET_ALICE';
const BOB = 'TEST_WALLET_BOB';

// Memecoin: 1,000,000,000 supply at 6 decimals.
const SUPPLY_RAW = 1_000_000_000n * 1_000_000n; // 1e15 base units
const ONE_MILLION_TOKENS = 1_000_000n * 1_000_000n; // 1e12 base units = 0.1% of supply
const TEN_SOL = 10_000_000_000n;

// ------------------------------------------------------------- rankUniverse --

test('rankUniverse ranks by underlying market cap and marks the top five', () => {
  const ranked = rankUniverse(ALL_STOCKS, { liqMinUsd: 50_000, size: 20 });
  assert.deepEqual(
    ranked.map((s) => s.symbol),
    ['NVDAx', 'AAPLx', 'GOOGLx', 'MSFTx', 'AMZNx', 'TSLAx'],
  );
  assert.deepEqual(ranked.map((s) => s.rank), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(ranked.map((s) => s.isTop5), [true, true, true, true, true, false]);
});

test('rankUniverse drops stocks below the liquidity floor and never mutates its input', () => {
  const all = [
    stock('LIQx', 'Liquid Co', 1_000_000_000, 50_000), // exactly at the floor: kept
    stock('DRYx', 'Dry Co', 9_000_000_000_000, 49_999), // biggest company, no liquidity: dropped
    stock('NILx', 'No Data Co', 5_000_000_000, null), // unknown liquidity: dropped
  ];
  const before = JSON.stringify(all);
  const ranked = rankUniverse(all, { liqMinUsd: 50_000, size: 20 });
  assert.deepEqual(ranked.map((s) => s.symbol), ['LIQx']);
  assert.equal(ranked[0].rank, 1);
  assert.equal(JSON.stringify(all), before, 'input list must not be mutated');
  assert.equal('rank' in all[0], false);
});

test('rankUniverse falls back to tokenMcap and breaks ties on symbol then mint', () => {
  const all = [
    stock('ZZZx', 'Zeta Co', null, 100_000, { tokenMcap: 8_000_000 }),
    stock('AAAx', 'Alpha Co', null, 100_000, { tokenMcap: 8_000_000 }),
    stock('BBBx', 'Beta Co', 0, 100_000, { tokenMcap: 9_000_000 }),
    stock('CCCx', 'Gamma Co', null, 100_000, {}),
  ];
  const ranked = rankUniverse(all, { liqMinUsd: 0, size: 20 });
  assert.deepEqual(ranked.map((s) => s.symbol), ['BBBx', 'AAAx', 'ZZZx', 'CCCx']);
});

test('rankUniverse caps at size and de-duplicates repeated mints', () => {
  const dup = stock('NVDAx', 'NVIDIA Corp (dup feed row)', 4_400_000_000_000, 3_100_000);
  const ranked = rankUniverse([...ALL_STOCKS, dup], { liqMinUsd: 50_000, size: 3 });
  assert.deepEqual(ranked.map((s) => s.symbol), ['NVDAx', 'AAPLx', 'GOOGLx']);
  assert.equal(new Set(ranked.map((s) => s.mint)).size, 3);
});

// -------------------------------------------------------------- defaultPicks --

test('defaultPicks is the top five at twenty percent each', () => {
  const picks = defaultPicks(UNIVERSE, DEFAULT_RULES);
  assert.deepEqual(picks.map((p) => p.symbol), ['AAPLx', 'AMZNx', 'GOOGLx', 'MSFTx', 'NVDAx']);
  assert.deepEqual(picks.map((p) => p.pct), [20, 20, 20, 20, 20]);
  assert.equal(picks.reduce((a, p) => a + p.pct, 0), 100);
});

test('defaultPicks still sums to exactly 100 on a short universe', () => {
  const small = rankUniverse(ALL_STOCKS.slice(0, 3), { liqMinUsd: 0, size: 3 });
  const picks = defaultPicks(small, DEFAULT_RULES);
  assert.equal(picks.length, 3);
  assert.equal(picks.reduce((a, p) => a + p.pct, 0), 100);
  assert.deepEqual(picks.map((p) => p.pct), [34, 33, 33]);
  assert.deepEqual(defaultPicks([], DEFAULT_RULES), []);
});

// -------------------------------------------------------------- validatePicks --

test('validatePicks normalizes and sorts by pct desc then symbol asc', () => {
  const picks = validatePicks(
    [
      { mint: mintOf('AAPLx'), pct: 30 },
      { mint: mintOf('NVDAx'), pct: 40 },
      { mint: mintOf('MSFTx'), pct: 30 },
    ],
    UNIVERSE,
    DEFAULT_RULES,
  );
  assert.deepEqual(picks, [
    { mint: mintOf('NVDAx'), symbol: 'NVDAx', pct: 40 },
    { mint: mintOf('AAPLx'), symbol: 'AAPLx', pct: 30 },
    { mint: mintOf('MSFTx'), symbol: 'MSFTx', pct: 30 },
  ]);
});

test('validatePicks accepts a symbol instead of a mint and integer strings', () => {
  const picks = validatePicks([{ symbol: 'nvdax', pct: '60' }, { symbol: 'TSLAx', pct: 40 }], UNIVERSE, DEFAULT_RULES);
  assert.deepEqual(picks.map((p) => [p.mint, p.pct]), [
    [mintOf('NVDAx'), 60],
    [mintOf('TSLAx'), 40],
  ]);
});

function rejects(picks, code, label) {
  assert.throws(
    () => validatePicks(picks, UNIVERSE, DEFAULT_RULES),
    (err) => {
      assert.ok(err instanceof PickError, `${label}: expected a PickError, got ${err?.name}`);
      assert.equal(err.code, code, `${label}: expected code ${code}, got ${err.code}`);
      assert.equal(typeof err.detail, 'string');
      return true;
    },
    label,
  );
}

test('validatePicks rejects a pct of 9 (below the 10% floor) with code range', () => {
  rejects([{ mint: mintOf('NVDAx'), pct: 9 }, { mint: mintOf('AAPLx'), pct: 91 }], 'range', 'pct 9');
});

test('validatePicks rejects a pct of 61 (above the 60% cap) with code range', () => {
  rejects([{ mint: mintOf('NVDAx'), pct: 61 }, { mint: mintOf('AAPLx'), pct: 39 }], 'range', 'pct 61');
});

test('validatePicks rejects a fractional pct of 10.5 with code range', () => {
  rejects(
    [
      { mint: mintOf('NVDAx'), pct: 10.5 },
      { mint: mintOf('AAPLx'), pct: 49.5 },
      { mint: mintOf('MSFTx'), pct: 40 },
    ],
    'range',
    'pct 10.5',
  );
  rejects([{ mint: mintOf('NVDAx'), pct: '10.5' }, { mint: mintOf('AAPLx'), pct: 89.5 }], 'range', 'pct "10.5"');
});

test('validatePicks rejects six picks with code count', () => {
  rejects(
    [
      { mint: mintOf('NVDAx'), pct: 25 },
      { mint: mintOf('AAPLx'), pct: 15 },
      { mint: mintOf('GOOGLx'), pct: 15 },
      { mint: mintOf('MSFTx'), pct: 15 },
      { mint: mintOf('AMZNx'), pct: 15 },
      { mint: mintOf('TSLAx'), pct: 15 },
    ],
    'count',
    'six picks',
  );
});

test('validatePicks rejects one pick with code count', () => {
  rejects([{ mint: mintOf('NVDAx'), pct: 60 }], 'count', 'one pick');
  rejects([], 'count', 'zero picks');
  rejects(null, 'count', 'not an array');
});

test('validatePicks rejects a sum of 99 with code sum', () => {
  rejects([{ mint: mintOf('NVDAx'), pct: 49 }, { mint: mintOf('AAPLx'), pct: 50 }], 'sum', 'sum 99');
});

test('validatePicks rejects a sum of 101 with code sum', () => {
  rejects([{ mint: mintOf('NVDAx'), pct: 51 }, { mint: mintOf('AAPLx'), pct: 50 }], 'sum', 'sum 101');
});

test('validatePicks rejects a duplicate mint with code duplicate', () => {
  rejects([{ mint: mintOf('NVDAx'), pct: 50 }, { mint: mintOf('NVDAx'), pct: 50 }], 'duplicate', 'duplicate mint');
  rejects(
    [{ mint: mintOf('NVDAx'), pct: 50 }, { symbol: 'nvdax', pct: 50 }],
    'duplicate',
    'duplicate via symbol alias',
  );
});

test('validatePicks rejects a mint outside the universe with code not_in_universe', () => {
  rejects([{ mint: 'TEST_MINT_NOT_LISTED', pct: 50 }, { mint: mintOf('AAPLx'), pct: 50 }], 'not_in_universe', 'unknown mint');
  rejects([{ symbol: 'DOGEx', pct: 50 }, { mint: mintOf('AAPLx'), pct: 50 }], 'not_in_universe', 'unknown symbol');
  rejects([{ pct: 50 }, { mint: mintOf('AAPLx'), pct: 50 }], 'not_in_universe', 'no identity');
});

// ------------------------------------------------------------ computeEligible --

test('eligibility is inclusive at exactly the threshold and excludes the wallet list', () => {
  const threshold = eligibleThreshold(SUPPLY_RAW, 10);
  assert.equal(threshold, ONE_MILLION_TOKENS);

  const eligible = computeEligible(
    [
      { wallet: 'TEST_WALLET_EXACT', balance: threshold.toString() },
      { wallet: 'TEST_WALLET_UNDER', balance: (threshold - 1n).toString() },
      { wallet: 'TEST_WALLET_OVER', balance: (threshold * 3n).toString() },
      { wallet: 'TEST_WALLET_ZERO', balance: '0' },
      { wallet: 'TEST_WALLET_LP', balance: (threshold * 1000n).toString() },
    ],
    { supplyRaw: SUPPLY_RAW, eligibleBps: 10, excluded: ['TEST_WALLET_LP'] },
  );

  assert.deepEqual(eligible.map((h) => h.wallet), ['TEST_WALLET_OVER', 'TEST_WALLET_EXACT']);
  assert.deepEqual(eligible.map((h) => h.balance), [(threshold * 3n).toString(), threshold.toString()]);
});

test('computeEligible refuses a zero balance even when the threshold is zero', () => {
  const eligible = computeEligible(
    [{ wallet: 'TEST_WALLET_ZERO', balance: '0' }, { wallet: 'TEST_WALLET_ONE', balance: '1' }],
    { supplyRaw: 0, eligibleBps: 0 },
  );
  assert.deepEqual(eligible.map((h) => h.wallet), ['TEST_WALLET_ONE']);
});

test('computeEligible rejects a non-integer balance instead of coercing it', () => {
  assert.throws(
    () => computeEligible([{ wallet: 'TEST_WALLET_X', balance: 1.5 }], { supplyRaw: SUPPLY_RAW, eligibleBps: 10 }),
    TypeError,
  );
  assert.throws(
    () => computeEligible([{ wallet: 'TEST_WALLET_X', balance: '-5' }], { supplyRaw: SUPPLY_RAW, eligibleBps: 10 }),
    RangeError,
  );
});

// -------------------------------------------------------- prefs re-spreading --

test('respreadPicks re-normalizes to exactly 100 by largest remainder', () => {
  const out = respreadPicks([
    { mint: mintOf('NVDAx'), symbol: 'NVDAx', pct: 50 },
    { mint: mintOf('AAPLx'), symbol: 'AAPLx', pct: 30 },
  ]);
  assert.deepEqual(out, [
    { mint: mintOf('NVDAx'), symbol: 'NVDAx', pct: 63 },
    { mint: mintOf('AAPLx'), symbol: 'AAPLx', pct: 37 },
  ]);
  assert.equal(out.reduce((a, p) => a + p.pct, 0), 100);
});

test('a pick that left the universe is re-spread across the rest, and marked prefs-adjusted', () => {
  const index = new Map(UNIVERSE.map((s) => [s.mint, s]));
  const fallback = defaultPicks(UNIVERSE, DEFAULT_RULES);

  const adjusted = effectiveBasket(
    [
      { mint: mintOf('NVDAx'), pct: 50 },
      { mint: mintOf('AAPLx'), pct: 30 },
      { mint: 'TEST_MINT_DELISTED', pct: 20 },
    ],
    index,
    fallback,
  );
  assert.equal(adjusted.source, 'prefs-adjusted');
  assert.deepEqual(adjusted.picks.map((p) => [p.symbol, p.pct]), [['NVDAx', 63], ['AAPLx', 37]]);

  const kept = effectiveBasket([{ mint: mintOf('NVDAx'), pct: 60 }, { mint: mintOf('TSLAx'), pct: 40 }], index, fallback);
  assert.equal(kept.source, 'prefs');
  assert.deepEqual(kept.picks.map((p) => [p.symbol, p.pct]), [['NVDAx', 60], ['TSLAx', 40]]);

  const gone = effectiveBasket([{ mint: 'TEST_MINT_DELISTED', pct: 100 }], index, fallback);
  assert.equal(gone.source, 'default');
  assert.deepEqual(gone.picks, fallback);

  const none = effectiveBasket(null, index, fallback);
  assert.equal(none.source, 'default');
});

// -------------------------------------------------- SPEC section 3 example --

const WORKED_EXAMPLE = {
  poolLamports: TEN_SOL,
  reserveLamports: 50_000_000n, // 0.05 SOL
  holders: [
    { wallet: ALICE, balance: (3n * ONE_MILLION_TOKENS).toString() }, // 3,000,000 tokens
    { wallet: BOB, balance: ONE_MILLION_TOKENS.toString() }, // 1,000,000 tokens, exactly eligible
  ],
  prefs: new Map([
    [
      ALICE,
      {
        wallet: ALICE,
        picks: [
          { mint: mintOf('TSLAx'), symbol: 'TSLAx', pct: 60 },
          { mint: mintOf('NVDAx'), symbol: 'NVDAx', pct: 40 },
        ],
        signature: null,
        message: null,
        updatedAt: '2026-09-07T00:00:00.000Z',
      },
    ],
  ]),
};

function workedPlan() {
  return buildRoundPlan({
    poolLamports: WORKED_EXAMPLE.poolLamports,
    reserveLamports: WORKED_EXAMPLE.reserveLamports,
    holders: WORKED_EXAMPLE.holders,
    prefsByWallet: WORKED_EXAMPLE.prefs,
    universe: UNIVERSE,
    rules: { ...DEFAULT_RULES, eligibleBps: 10 },
    supplyRaw: SUPPLY_RAW,
    excluded: [],
  });
}

test('SPEC section 3 worked example: 10 SOL splits 4.5 / 3.5 / 0.5 x4', () => {
  const plan = workedPlan();

  assert.equal(plan.stats.eligibleHolders, 2);
  assert.equal(plan.stats.prefHolders, 1);
  assert.equal(plan.stats.defaultHolders, 1);
  assert.equal(plan.eligibleThreshold, ONE_MILLION_TOKENS.toString());

  // Bob's 1,000,000 tokens are exactly 0.1% of supply — he is in.
  assert.deepEqual(plan.eligible.map((h) => h.wallet), [ALICE, BOB]);
  assert.equal(plan.holders.find((h) => h.wallet === BOB).source, 'default');
  assert.equal(plan.holders.find((h) => h.wallet === ALICE).source, 'prefs');

  assert.deepEqual(
    plan.demand.map((d) => [d.symbol, d.weight, d.shareBps, d.solLamports]),
    [
      ['TSLAx', (180_000_000_000_000n).toString(), 4500, '4500000000'],
      ['NVDAx', (140_000_000_000_000n).toString(), 3500, '3500000000'],
      ['AAPLx', (20_000_000_000_000n).toString(), 500, '500000000'],
      ['AMZNx', (20_000_000_000_000n).toString(), 500, '500000000'],
      ['GOOGLx', (20_000_000_000_000n).toString(), 500, '500000000'],
      ['MSFTx', (20_000_000_000_000n).toString(), 500, '500000000'],
    ],
  );

  assert.equal(plan.totalWeight, (400_000_000_000_000n).toString());
  assert.equal(plan.demand.reduce((a, d) => a + d.shareBps, 0), 10000);
  assert.equal(plan.spentLamports, TEN_SOL.toString());
  assert.equal(plan.remainderLamports, '0');
  assert.equal(plan.poolLamports, TEN_SOL.toString());
  assert.equal(plan.reserveLamports, '50000000');
  assert.deepEqual(plan.top5.map((m) => m.replace('TEST_MINT_', '')), ['NVDAx', 'AAPLx', 'GOOGLx', 'MSFTx', 'AMZNx']);
});

test('SPEC section 3 worked example: 1.75 NVDAx splits exactly 1.5 to Alice, 0.25 to Bob', () => {
  const plan = workedPlan();
  const contributors = plan.contributorsByMint.get(mintOf('NVDAx'));
  assert.deepEqual(contributors, [
    { wallet: ALICE, weight: 120_000_000_000_000n },
    { wallet: BOB, weight: 20_000_000_000_000n },
  ]);

  // 1.75 NVDAx at 8 decimals.
  const received = 175_000_000n;
  const result = allocate(received, contributors, 0n);

  assert.deepEqual(result.transfers, [
    { wallet: ALICE, weight: 120_000_000_000_000n, amountRaw: 150_000_000n }, // 1.50 NVDAx
    { wallet: BOB, weight: 20_000_000_000_000n, amountRaw: 25_000_000n }, // 0.25 NVDAx
  ]);
  assert.equal(result.dustRaw, 0n);
  assert.equal(result.transfers.reduce((a, t) => a + t.amountRaw, 0n) + result.dustRaw, received);
});

test('applySwapResults turns the worked example into the round transfer list', () => {
  const plan = workedPlan();
  const swaps = plan.demand.map((d) => ({
    mint: d.mint,
    symbol: d.symbol,
    solLamports: d.solLamports,
    quotedOut: null,
    // NVDAx delivers exactly 1.75 tokens; the others deliver an amount that
    // does not divide evenly, so dust behaviour is exercised too.
    receivedRaw: d.symbol === 'NVDAx' ? '175000000' : '33333333',
    tx: null,
    status: 'DONE',
    error: null,
  }));

  const out = applySwapResults(plan, swaps, []);

  const nvda = out.transfers.filter((t) => t.symbol === 'NVDAx');
  assert.deepEqual(nvda, [
    { wallet: ALICE, mint: mintOf('NVDAx'), symbol: 'NVDAx', amountRaw: '150000000', tx: null, status: 'PENDING', error: null },
    { wallet: BOB, mint: mintOf('NVDAx'), symbol: 'NVDAx', amountRaw: '25000000', tx: null, status: 'PENDING', error: null },
  ]);

  // TSLAx is Alice alone: she takes everything, no dust.
  const tsla = out.transfers.filter((t) => t.symbol === 'TSLAx');
  assert.deepEqual(tsla.map((t) => [t.wallet, t.amountRaw]), [[ALICE, '33333333']]);

  // Bob alone holds AAPLx/AMZNx/GOOGLx/MSFTx demand.
  const aapl = out.transfers.filter((t) => t.symbol === 'AAPLx');
  assert.deepEqual(aapl.map((t) => [t.wallet, t.amountRaw]), [[BOB, '33333333']]);

  // Conservation, per stock: transfers + dust == received + carryIn.
  for (const line of out.perStock) {
    const sent = out.transfers
      .filter((t) => t.mint === line.mint)
      .reduce((a, t) => a + BigInt(t.amountRaw), 0n);
    assert.equal(sent + BigInt(line.dustRaw), BigInt(line.receivedRaw) + BigInt(line.carryInRaw));
  }
  assert.equal(out.stats.transfersSkippedDust, 0);
});

test('a failed swap distributes nothing and keeps its carry-over intact', () => {
  const plan = workedPlan();
  const carryIn = [{ mint: mintOf('NVDAx'), amountRaw: '4' }, { mint: mintOf('TSLAx'), amountRaw: '7' }];
  const swaps = plan.demand.map((d) => ({
    mint: d.mint,
    symbol: d.symbol,
    solLamports: d.solLamports,
    quotedOut: null,
    receivedRaw: d.symbol === 'TSLAx' ? null : '100000000',
    tx: null,
    status: d.symbol === 'TSLAx' ? 'FAILED' : 'DONE',
    error: d.symbol === 'TSLAx' ? 'route not found' : null,
  }));

  const out = applySwapResults(plan, swaps, carryIn);

  assert.equal(out.transfers.some((t) => t.symbol === 'TSLAx'), false);
  const tslaCarry = out.carryOut.find((c) => c.mint === mintOf('TSLAx'));
  assert.deepEqual(tslaCarry, { mint: mintOf('TSLAx'), amountRaw: '7' });

  // NVDAx: 100000000 received + 4 carried in = 100000004 over weights 6:1,
  // which does not divide evenly — one base unit of dust must survive.
  const nvda = out.transfers.filter((t) => t.symbol === 'NVDAx');
  const total = 100_000_004n;
  const alice = (total * 120_000_000_000_000n) / 140_000_000_000_000n;
  const bob = (total * 20_000_000_000_000n) / 140_000_000_000_000n;
  assert.deepEqual(nvda.map((t) => t.amountRaw), [alice.toString(), bob.toString()]);
  assert.deepEqual(nvda.map((t) => t.amountRaw), ['85714289', '14285714']);
  const nvdaDust = out.carryOut.find((c) => c.mint === mintOf('NVDAx'));
  assert.equal(BigInt(nvdaDust.amountRaw), total - alice - bob);
  assert.equal(nvdaDust.amountRaw, '1');
});

test('carry-over for a stock nobody demanded this round is preserved, not dropped', () => {
  const plan = workedPlan();
  const out = applySwapResults(plan, [], [{ mint: 'TEST_MINT_ORPHAN', amountRaw: '42' }]);
  assert.deepEqual(out.carryOut, [{ mint: 'TEST_MINT_ORPHAN', amountRaw: '42' }]);
  assert.deepEqual(out.transfers, []);
});

test('an allocation that floors to zero is recorded as SKIPPED_DUST, not silently dropped', () => {
  const contributors = [
    { wallet: 'TEST_WALLET_WHALE', weight: 1_000_000n },
    { wallet: 'TEST_WALLET_SHRIMP', weight: 1n },
  ];
  const plan = {
    demand: [{ mint: mintOf('NVDAx'), symbol: 'NVDAx' }],
    contributorsByMint: new Map([[mintOf('NVDAx'), contributors]]),
  };
  const out = applySwapResults(plan, [{ mint: mintOf('NVDAx'), symbol: 'NVDAx', receivedRaw: '10', status: 'DONE' }], []);
  assert.deepEqual(out.transfers.map((t) => [t.wallet, t.amountRaw, t.status]), [
    ['TEST_WALLET_WHALE', '9', 'PENDING'],
    ['TEST_WALLET_SHRIMP', '0', 'SKIPPED_DUST'],
  ]);
  assert.equal(out.stats.transfersSkippedDust, 1);
  assert.deepEqual(out.carryOut, [{ mint: mintOf('NVDAx'), amountRaw: '1' }]);
});

// ------------------------------------------------------------ demand / split --

test('computeDemand weights every holder by balance times pct', () => {
  const { perStock, totalWeight, holders } = computeDemand(
    computeEligible(WORKED_EXAMPLE.holders, { supplyRaw: SUPPLY_RAW, eligibleBps: 10 }),
    WORKED_EXAMPLE.prefs,
    UNIVERSE,
    DEFAULT_RULES,
  );
  assert.equal(totalWeight, 400_000_000_000_000n);
  assert.equal(perStock.get(mintOf('TSLAx')).weight, 180_000_000_000_000n);
  assert.equal(perStock.get(mintOf('NVDAx')).weight, 140_000_000_000_000n);
  assert.equal(holders.length, 2);
  assert.equal([...perStock.values()].reduce((a, e) => a + e.weight, 0n), totalWeight);
});

test('computeDemand on an empty holder set produces no demand at all', () => {
  const { perStock, totalWeight, holders } = computeDemand([], new Map(), UNIVERSE, DEFAULT_RULES);
  assert.equal(perStock.size, 0);
  assert.equal(totalWeight, 0n);
  assert.deepEqual(holders, []);
  assert.equal(splitPool(TEN_SOL, perStock).size, 0);
});

test('splitPool floors every share and leaves the remainder in the vault', () => {
  const perStock = new Map([
    ['TEST_MINT_A', { weight: 1n }],
    ['TEST_MINT_B', { weight: 1n }],
    ['TEST_MINT_C', { weight: 1n }],
  ]);
  const split = splitPool(100n, perStock);
  assert.deepEqual([...split.values()], [33n, 33n, 33n]);
  const sum = [...split.values()].reduce((a, v) => a + v, 0n);
  assert.equal(sum, 99n);
  assert.ok(100n - sum < 3n);
});

test('splitPool with zero total weight assigns nothing', () => {
  const split = splitPool(100n, new Map([['TEST_MINT_A', { weight: 0n }]]));
  assert.deepEqual([...split.values()], [0n]);
});

test('allocate with no contributors turns the whole receipt into dust', () => {
  const result = allocate(500n, [], 25n);
  assert.deepEqual(result.transfers, []);
  assert.equal(result.dustRaw, 525n);
  assert.equal(result.totalRaw, 525n);
});

// -------------------------------------------------------------- snapshotHash --

const SNAPSHOT = {
  takenAt: '2026-09-07T12:03:41.000Z',
  slot: 401_233_918,
  tokenMint: 'TEST_MINT_MEMECOIN',
  supply: SUPPLY_RAW.toString(),
  eligibleThreshold: ONE_MILLION_TOKENS.toString(),
  excluded: ['TEST_WALLET_LP', 'TEST_WALLET_VAULT'],
  holders: [
    { wallet: ALICE, balance: (3n * ONE_MILLION_TOKENS).toString() },
    { wallet: BOB, balance: ONE_MILLION_TOKENS.toString() },
  ],
};

test('snapshotHash is stable across key order, holder order and its own hash field', () => {
  const a = snapshotHash(SNAPSHOT);
  const b = snapshotHash({
    hash: 'whatever was there before',
    holders: [...SNAPSHOT.holders].reverse(),
    excluded: [...SNAPSHOT.excluded].reverse(),
    eligibleThreshold: SNAPSHOT.eligibleThreshold,
    supply: SNAPSHOT.supply,
    tokenMint: SNAPSHOT.tokenMint,
    slot: SNAPSHOT.slot,
    takenAt: SNAPSHOT.takenAt,
  });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('snapshotHash changes when a single base unit changes', () => {
  const moved = {
    ...SNAPSHOT,
    holders: [SNAPSHOT.holders[0], { wallet: BOB, balance: (ONE_MILLION_TOKENS + 1n).toString() }],
  };
  assert.notEqual(snapshotHash(SNAPSHOT), snapshotHash(moved));
});

test('canonicalSnapshot normalizes amounts to base-unit strings and sorts holders', () => {
  const canonical = canonicalSnapshot({
    ...SNAPSHOT,
    supply: SUPPLY_RAW,
    holders: [{ wallet: BOB, balance: ONE_MILLION_TOKENS }, { wallet: ALICE, balance: 3n * ONE_MILLION_TOKENS }],
  });
  assert.deepEqual(canonical.holders.map((h) => h.wallet), [ALICE, BOB]);
  assert.equal(canonical.supply, SUPPLY_RAW.toString());
  assert.equal(typeof canonical.holders[0].balance, 'string');
  assert.equal('hash' in canonical, false);
});

// ------------------------------------------------------ honest empty states --

test('a round with no holders plans nothing and spends nothing', () => {
  const plan = buildRoundPlan({
    poolLamports: TEN_SOL,
    reserveLamports: 50_000_000n,
    holders: [],
    prefsByWallet: new Map(),
    universe: UNIVERSE,
    rules: DEFAULT_RULES,
  });
  assert.deepEqual(plan.demand, []);
  assert.equal(plan.spentLamports, '0');
  assert.equal(plan.remainderLamports, TEN_SOL.toString());
  assert.equal(plan.totalWeight, '0');
  assert.equal(plan.stats.eligibleHolders, 0);
});

test('a round with no universe (no listed stocks) plans nothing rather than inventing one', () => {
  const plan = buildRoundPlan({
    poolLamports: TEN_SOL,
    reserveLamports: 0n,
    holders: WORKED_EXAMPLE.holders,
    prefsByWallet: new Map(),
    universe: [],
    rules: DEFAULT_RULES,
  });
  assert.deepEqual(plan.demand, []);
  assert.deepEqual(plan.top5, []);
  assert.equal(plan.spentLamports, '0');
  assert.equal(plan.holders.every((h) => h.source === 'default' && h.picks.length === 0), true);
});

test('buildRoundPlan still drops excluded, duplicate and empty wallets when eligibility ran upstream', () => {
  const plan = buildRoundPlan({
    poolLamports: TEN_SOL,
    reserveLamports: 0n,
    holders: [
      { wallet: ALICE, balance: '1000' },
      { wallet: ALICE, balance: '1000' }, // a second token account for the same owner
      { wallet: 'TEST_WALLET_VAULT', balance: '5000' },
      { wallet: 'TEST_WALLET_EMPTY', balance: '0' },
    ],
    prefsByWallet: new Map(),
    universe: UNIVERSE,
    rules: DEFAULT_RULES,
    excluded: ['TEST_WALLET_VAULT'],
  });
  assert.deepEqual(plan.eligible.map((h) => h.wallet), [ALICE]);
  assert.equal(plan.eligibleThreshold, null, 'no supply given means no threshold was applied here');
  for (const contributors of plan.contributorsByMint.values()) {
    assert.equal(contributors.length, 1);
    assert.equal(contributors[0].wallet, ALICE);
  }
});

test('buildRoundPlan refuses a negative pool instead of paying out backwards', () => {
  assert.throws(() => buildRoundPlan({ poolLamports: -1, universe: UNIVERSE }), RangeError);
  assert.throws(() => buildRoundPlan({ poolLamports: 1.5, universe: UNIVERSE }), TypeError);
});
