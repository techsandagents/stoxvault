/**
 * STOCKDROP engine — property tests over generated holder sets.
 *
 * The PRNG is a seeded mulberry32 written here on purpose: Math.random would
 * make a failure impossible to reproduce, and a round that cannot be reproduced
 * is exactly what this project promises never to ship.
 *
 * Invariants under test:
 *   - Sum of per-stock lamports <= pool, and the unspent remainder is smaller
 *     than the number of stocks (i.e. it is pure rounding, never a skimmed cut).
 *   - Per stock: sum of transfers + dust === received + carryIn, exactly.
 *   - No negative and no fractional amount ever appears.
 *   - A zero-balance wallet is never eligible and never receives anything.
 *   - Eligibility is inclusive at exactly the threshold.
 *   - The same inputs always produce the identical plan.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  allocate,
  applySwapResults,
  buildRoundPlan,
  computeEligible,
  DEFAULT_RULES,
  eligibleThreshold,
  rankUniverse,
  splitPool,
  validatePicks,
} from '../src/engine/index.js';

// ------------------------------------------------------------------- PRNG --

/** mulberry32: tiny, fast, fully deterministic from a 32-bit seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const choice = (rng, list) => list[randInt(rng, 0, list.length - 1)];

/** A random non-negative BigInt with up to `digits` decimal digits. */
function randBig(rng, digits) {
  let out = '';
  for (let i = 0; i < digits; i += 1) out += String(randInt(rng, 0, 9));
  return BigInt(out.replace(/^0+(?=\d)/, ''));
}

test('the PRNG is deterministic and reproducible from its seed', () => {
  const a = mulberry32(20260907);
  const b = mulberry32(20260907);
  const seqA = Array.from({ length: 8 }, a);
  const seqB = Array.from({ length: 8 }, b);
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, Array.from({ length: 8 }, mulberry32(20260908)));
  for (const v of seqA) assert.ok(v >= 0 && v < 1);
});

// -------------------------------------------------------------- generators --

const SUPPLY_RAW = 1_000_000_000n * 1_000_000n; // 1B tokens, 6 decimals
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

function makeStock(i, rng) {
  const symbol = `S${String(i).padStart(2, '0')}x`;
  return {
    mint: `TEST_MINT_${symbol}`,
    symbol,
    name: `Test Company ${i}`,
    logo: null,
    decimals: 8,
    tokenProgram: TOKEN_2022,
    yahooSymbol: `S${i}`,
    priceUsd: null,
    change24h: null,
    underlyingMcap: randInt(rng, 1, 5000) * 1_000_000_000,
    underlyingPrice: null,
    // A third of the feed is below the $50k liquidity floor, so the ranked
    // universe is genuinely a subset and prefs can point at dropped mints.
    liquidityUsd: rng() < 0.33 ? randInt(rng, 0, 49_999) : randInt(rng, 50_000, 9_000_000),
    holderCount: null,
  };
}

/** Random valid basket: 2..5 picks, each 10..60, summing to exactly 100. */
function randomPicks(rng, stocks) {
  const maxPicks = Math.min(DEFAULT_RULES.maxPicks, stocks.length);
  if (maxPicks < DEFAULT_RULES.minPicks) return null;
  const k = randInt(rng, DEFAULT_RULES.minPicks, maxPicks);

  const pool = stocks.slice();
  const chosen = [];
  for (let i = 0; i < k; i += 1) chosen.push(pool.splice(randInt(rng, 0, pool.length - 1), 1)[0]);

  const pcts = new Array(k).fill(DEFAULT_RULES.minPct);
  let left = 100 - DEFAULT_RULES.minPct * k;
  let guard = 0;
  while (left > 0 && guard < 10000) {
    guard += 1;
    const i = randInt(rng, 0, k - 1);
    if (pcts[i] >= DEFAULT_RULES.maxPct) continue;
    pcts[i] += 1;
    left -= 1;
  }
  if (left !== 0) return null; // k too small to reach 100 under the cap (k=1 only)
  return chosen.map((stock, i) => ({ mint: stock.mint, symbol: stock.symbol, pct: pcts[i] }));
}

const ZERO_WALLET = 'TEST_WALLET_ZERO_BALANCE';
const EXACT_WALLET = 'TEST_WALLET_EXACT_THRESHOLD';
const EXCLUDED_WALLET = 'TEST_WALLET_EXCLUDED_LP';

function makeScenario(rng) {
  const stockCount = randInt(rng, 3, 26);
  const all = Array.from({ length: stockCount }, (_, i) => makeStock(i, rng));
  const universe = rankUniverse(all, { liqMinUsd: 50_000, size: 20 });

  const eligibleBps = choice(rng, [1, 5, 10, 25, 100]);
  const threshold = eligibleThreshold(SUPPLY_RAW, eligibleBps);

  const holders = [
    { wallet: ZERO_WALLET, balance: '0' },
    { wallet: EXACT_WALLET, balance: threshold.toString() },
    { wallet: EXCLUDED_WALLET, balance: (threshold * 10_000n).toString() },
  ];
  const count = randInt(rng, 1, 40);
  for (let i = 0; i < count; i += 1) {
    const roll = rng();
    let balance;
    if (roll < 0.2) balance = randBig(rng, randInt(rng, 1, 11)); // often below the threshold
    else if (roll < 0.3) balance = threshold - 1n; // just under: must be excluded
    else balance = threshold + randBig(rng, randInt(rng, 1, 14));
    holders.push({ wallet: `TEST_WALLET_${String(i).padStart(3, '0')}`, balance: balance.toString() });
  }

  // Prefs for roughly 60% of wallets. Some point at mints that did not make the
  // ranked universe (illiquid or delisted) so the re-spread path is exercised.
  const prefsByWallet = new Map();
  const dropped = all.filter((s) => !universe.some((u) => u.mint === s.mint));
  for (const holder of holders) {
    if (rng() > 0.6) continue;
    const source = rng() < 0.25 && dropped.length > 0 ? [...universe, ...dropped] : universe;
    const picks = randomPicks(rng, source);
    if (!picks) continue;
    prefsByWallet.set(holder.wallet, {
      wallet: holder.wallet,
      picks,
      signature: null,
      message: null,
      updatedAt: '2026-09-07T00:00:00.000Z',
    });
  }

  const poolLamports = rng() < 0.1 ? 0n : BigInt(randInt(rng, 1, 250_000_000_000));

  return { all, universe, eligibleBps, threshold, holders, prefsByWallet, poolLamports };
}

const INTEGER_STRING = /^\d+$/;

// ------------------------------------------------------------- properties --

test('property: pool split is exhaustive, floored, and never over-spends', () => {
  const rng = mulberry32(20260907);
  for (let i = 0; i < 200; i += 1) {
    const s = makeScenario(rng);
    const plan = buildRoundPlan({
      poolLamports: s.poolLamports,
      reserveLamports: 50_000_000n,
      holders: s.holders,
      prefsByWallet: s.prefsByWallet,
      universe: s.universe,
      rules: { ...DEFAULT_RULES, eligibleBps: s.eligibleBps },
      supplyRaw: SUPPLY_RAW,
      excluded: [EXCLUDED_WALLET],
      eligibleBps: s.eligibleBps,
    });

    const spent = plan.demand.reduce((acc, d) => acc + BigInt(d.solLamports), 0n);
    assert.equal(spent, BigInt(plan.spentLamports), `scenario ${i}: spent total must match the plan`);
    assert.ok(spent <= s.poolLamports, `scenario ${i}: spent ${spent} > pool ${s.poolLamports}`);
    assert.equal(BigInt(plan.remainderLamports), s.poolLamports - spent);

    for (const d of plan.demand) {
      assert.match(d.solLamports, INTEGER_STRING, `scenario ${i}: lamports must be a whole number`);
      assert.match(d.weight, INTEGER_STRING);
      assert.ok(BigInt(d.solLamports) >= 0n);
      assert.ok(Number.isInteger(d.shareBps) && d.shareBps >= 0);
    }

    if (plan.demand.length > 0 && BigInt(plan.totalWeight) > 0n) {
      const remainder = s.poolLamports - spent;
      assert.ok(
        remainder < BigInt(plan.demand.length),
        `scenario ${i}: unspent ${remainder} must be pure rounding, under ${plan.demand.length} lamports`,
      );
      assert.equal(plan.demand.reduce((a, d) => a + d.shareBps, 0), 10000, `scenario ${i}: shareBps must total 10000`);
    } else {
      assert.equal(spent, 0n);
    }
  }
});

test('property: eligibility is inclusive at the threshold, excludes zero balances and the exclusion list', () => {
  const rng = mulberry32(424242);
  for (let i = 0; i < 200; i += 1) {
    const s = makeScenario(rng);
    const eligible = computeEligible(s.holders, {
      supplyRaw: SUPPLY_RAW,
      eligibleBps: s.eligibleBps,
      excluded: [EXCLUDED_WALLET],
    });
    const wallets = new Set(eligible.map((h) => h.wallet));

    assert.ok(wallets.has(EXACT_WALLET), `scenario ${i}: a balance of exactly the threshold is eligible`);
    assert.ok(!wallets.has(ZERO_WALLET), `scenario ${i}: a zero balance is never eligible`);
    assert.ok(!wallets.has(EXCLUDED_WALLET), `scenario ${i}: excluded wallets are dropped`);

    for (const holder of eligible) {
      const balance = BigInt(holder.balance);
      assert.ok(balance >= s.threshold, `scenario ${i}: ${holder.wallet} below threshold`);
      assert.ok(balance > 0n);
      assert.match(holder.balance, INTEGER_STRING);
    }
    for (const holder of s.holders) {
      const balance = BigInt(holder.balance);
      if (balance >= s.threshold && balance > 0n && holder.wallet !== EXCLUDED_WALLET) {
        assert.ok(wallets.has(holder.wallet), `scenario ${i}: ${holder.wallet} should be eligible`);
      }
    }
  }
});

test('property: a zero-balance wallet appears in no demand, no contributor list and no transfer', () => {
  const rng = mulberry32(77001);
  for (let i = 0; i < 120; i += 1) {
    const s = makeScenario(rng);
    const plan = buildRoundPlan({
      poolLamports: s.poolLamports,
      reserveLamports: 0n,
      holders: s.holders,
      prefsByWallet: s.prefsByWallet,
      universe: s.universe,
      rules: { ...DEFAULT_RULES, eligibleBps: s.eligibleBps },
      supplyRaw: SUPPLY_RAW,
      excluded: [EXCLUDED_WALLET],
      eligibleBps: s.eligibleBps,
    });

    assert.ok(!plan.eligible.some((h) => h.wallet === ZERO_WALLET));
    assert.ok(!plan.holders.some((h) => h.wallet === ZERO_WALLET));
    for (const contributors of plan.contributorsByMint.values()) {
      assert.ok(!contributors.some((c) => c.wallet === ZERO_WALLET));
      assert.ok(!contributors.some((c) => c.wallet === EXCLUDED_WALLET));
      for (const c of contributors) assert.ok(c.weight > 0n);
    }

    const swaps = plan.demand.map((d) => ({
      mint: d.mint,
      symbol: d.symbol,
      solLamports: d.solLamports,
      receivedRaw: randBig(rng, randInt(rng, 1, 12)).toString(),
      status: 'DONE',
      tx: null,
      error: null,
    }));
    const out = applySwapResults(plan, swaps, []);
    assert.ok(!out.transfers.some((t) => t.wallet === ZERO_WALLET));
    assert.ok(!out.transfers.some((t) => t.wallet === EXCLUDED_WALLET));
  }
});

test('property: transfers plus dust always equal received plus carry-in, exactly', () => {
  const rng = mulberry32(31337);
  for (let i = 0; i < 200; i += 1) {
    const s = makeScenario(rng);
    const plan = buildRoundPlan({
      poolLamports: s.poolLamports,
      reserveLamports: 50_000_000n,
      holders: s.holders,
      prefsByWallet: s.prefsByWallet,
      universe: s.universe,
      rules: { ...DEFAULT_RULES, eligibleBps: s.eligibleBps },
      supplyRaw: SUPPLY_RAW,
      excluded: [EXCLUDED_WALLET],
      eligibleBps: s.eligibleBps,
    });

    const carryIn = [];
    const swaps = plan.demand.map((d) => {
      if (rng() < 0.15) carryIn.push({ mint: d.mint, amountRaw: randBig(rng, randInt(rng, 1, 6)).toString() });
      const failed = rng() < 0.12;
      return {
        mint: d.mint,
        symbol: d.symbol,
        solLamports: d.solLamports,
        quotedOut: null,
        receivedRaw: failed ? null : (rng() < 0.08 ? '0' : randBig(rng, randInt(rng, 1, 13)).toString()),
        tx: null,
        status: failed ? 'FAILED' : 'DONE',
        error: failed ? 'simulated route failure' : null,
      };
    });

    const out = applySwapResults(plan, swaps, carryIn);
    const carryInByMint = new Map(carryIn.map((c) => [c.mint, BigInt(c.amountRaw)]));
    const carryOutByMint = new Map(out.carryOut.map((c) => [c.mint, BigInt(c.amountRaw)]));

    for (const line of out.perStock) {
      const sent = out.transfers
        .filter((t) => t.mint === line.mint)
        .reduce((acc, t) => acc + BigInt(t.amountRaw), 0n);
      const received = BigInt(line.receivedRaw);
      const carried = carryInByMint.get(line.mint) ?? 0n;

      assert.equal(BigInt(line.carryInRaw), carried, `scenario ${i}: carry-in must be preserved for ${line.symbol}`);
      assert.equal(
        sent + BigInt(line.dustRaw),
        received + carried,
        `scenario ${i}: conservation broken for ${line.symbol}`,
      );
      assert.equal(BigInt(line.distributedRaw), sent);
      assert.equal(carryOutByMint.get(line.mint) ?? 0n, BigInt(line.dustRaw));
      if (line.status !== 'DONE') {
        assert.equal(received, 0n, `scenario ${i}: a swap that did not finish distributes nothing`);
        assert.equal(sent, 0n);
      }
    }

    // Nothing negative, nothing fractional, nobody unexpected.
    for (const transfer of out.transfers) {
      assert.match(transfer.amountRaw, INTEGER_STRING, `scenario ${i}: amount must be whole base units`);
      assert.ok(BigInt(transfer.amountRaw) >= 0n);
      assert.equal(transfer.tx, null);
      assert.equal(transfer.status, BigInt(transfer.amountRaw) === 0n ? 'SKIPPED_DUST' : 'PENDING');
      const contributors = plan.contributorsByMint.get(transfer.mint) ?? [];
      assert.ok(
        contributors.some((c) => c.wallet === transfer.wallet),
        `scenario ${i}: ${transfer.wallet} is not a contributor to ${transfer.symbol}`,
      );
    }
    for (const carry of out.carryOut) {
      assert.match(carry.amountRaw, INTEGER_STRING);
      assert.ok(BigInt(carry.amountRaw) > 0n, 'zero carry-over lines are omitted, not written as 0');
    }
  }
});

test('property: allocate conserves value and leaves less dust than there are contributors', () => {
  const rng = mulberry32(90210);
  for (let i = 0; i < 500; i += 1) {
    const n = randInt(rng, 1, 30);
    const contributors = Array.from({ length: n }, (_, k) => ({
      wallet: `TEST_WALLET_${String(k).padStart(3, '0')}`,
      weight: randBig(rng, randInt(rng, 1, 15)) + 1n,
    }));
    const received = rng() < 0.1 ? 0n : randBig(rng, randInt(rng, 1, 14));
    const carryIn = rng() < 0.4 ? randBig(rng, randInt(rng, 1, 5)) : 0n;

    const result = allocate(received, contributors, carryIn);
    const sent = result.transfers.reduce((acc, t) => acc + t.amountRaw, 0n);

    assert.equal(sent + result.dustRaw, received + carryIn, `scenario ${i}: allocate must conserve value`);
    assert.ok(result.dustRaw >= 0n);
    assert.ok(result.dustRaw < BigInt(n), `scenario ${i}: dust ${result.dustRaw} should be under ${n}`);
    for (const transfer of result.transfers) {
      assert.equal(typeof transfer.amountRaw, 'bigint');
      assert.ok(transfer.amountRaw >= 0n);
    }
    // Weight order is respected: a bigger weight never receives less.
    const byWeight = result.transfers.slice().sort((a, b) => (b.weight > a.weight ? 1 : b.weight < a.weight ? -1 : 0));
    for (let k = 1; k < byWeight.length; k += 1) {
      assert.ok(byWeight[k - 1].amountRaw >= byWeight[k].amountRaw);
    }
  }
});

test('property: splitPool never exceeds the pool and rounds down by less than one lamport per stock', () => {
  const rng = mulberry32(5150);
  for (let i = 0; i < 500; i += 1) {
    const n = randInt(rng, 1, 20);
    const perStock = new Map();
    for (let k = 0; k < n; k += 1) perStock.set(`TEST_MINT_${k}`, { weight: randBig(rng, randInt(rng, 1, 16)) + 1n });
    const pool = rng() < 0.1 ? 0n : randBig(rng, randInt(rng, 1, 12));

    const split = splitPool(pool, perStock);
    const sum = [...split.values()].reduce((a, v) => a + v, 0n);
    assert.ok(sum <= pool, `scenario ${i}: split ${sum} exceeds pool ${pool}`);
    assert.ok(pool - sum < BigInt(n), `scenario ${i}: remainder ${pool - sum} must be under ${n}`);
    for (const value of split.values()) {
      assert.equal(typeof value, 'bigint');
      assert.ok(value >= 0n);
    }
  }
});

test('the generator actually produces the interesting cases (guards against vacuous properties)', () => {
  const rng = mulberry32(20260907);
  const seen = {
    scenarios: 0,
    withDemand: 0,
    prefs: 0,
    prefsAdjusted: 0,
    default: 0,
    unspentRemainder: 0,
    skippedDust: 0,
    failedSwaps: 0,
    carriedDust: 0,
  };

  for (let i = 0; i < 200; i += 1) {
    const s = makeScenario(rng);
    const plan = buildRoundPlan({
      poolLamports: s.poolLamports,
      reserveLamports: 50_000_000n,
      holders: s.holders,
      prefsByWallet: s.prefsByWallet,
      universe: s.universe,
      rules: { ...DEFAULT_RULES, eligibleBps: s.eligibleBps },
      supplyRaw: SUPPLY_RAW,
      excluded: [EXCLUDED_WALLET],
      eligibleBps: s.eligibleBps,
    });
    seen.scenarios += 1;
    if (plan.demand.length > 0) seen.withDemand += 1;
    for (const holder of plan.holders) {
      if (holder.source === 'prefs') seen.prefs += 1;
      else if (holder.source === 'prefs-adjusted') seen.prefsAdjusted += 1;
      else seen.default += 1;
    }
    if (BigInt(plan.remainderLamports) > 0n) seen.unspentRemainder += 1;

    const swaps = plan.demand.map((d) => {
      const failed = rng() < 0.12;
      return {
        mint: d.mint,
        symbol: d.symbol,
        solLamports: d.solLamports,
        receivedRaw: failed ? null : randBig(rng, randInt(rng, 1, 6)).toString(),
        status: failed ? 'FAILED' : 'DONE',
        tx: null,
        error: null,
      };
    });
    seen.failedSwaps += swaps.filter((sw) => sw.status === 'FAILED').length;
    const out = applySwapResults(plan, swaps, []);
    seen.skippedDust += out.stats.transfersSkippedDust;
    seen.carriedDust += out.carryOut.length;
  }

  for (const [key, value] of Object.entries(seen)) {
    assert.ok(value > 0, `generator never produced "${key}" — the property tests would be vacuous (${JSON.stringify(seen)})`);
  }
});

test('property: every generated basket passes validatePicks, and the plan is reproducible', () => {
  const rng = mulberry32(60606);
  for (let i = 0; i < 80; i += 1) {
    const s = makeScenario(rng);

    for (const prefs of s.prefsByWallet.values()) {
      const inUniverse = prefs.picks.every((p) => s.universe.some((u) => u.mint === p.mint));
      if (!inUniverse) continue; // deliberately delisted picks are rejected by design
      const normalized = validatePicks(prefs.picks, s.universe, DEFAULT_RULES);
      assert.equal(normalized.reduce((a, p) => a + p.pct, 0), 100);
      assert.equal(normalized.length, prefs.picks.length);
    }

    const input = {
      poolLamports: s.poolLamports,
      reserveLamports: 50_000_000n,
      holders: s.holders,
      prefsByWallet: s.prefsByWallet,
      universe: s.universe,
      rules: { ...DEFAULT_RULES, eligibleBps: s.eligibleBps },
      supplyRaw: SUPPLY_RAW,
      excluded: [EXCLUDED_WALLET],
      eligibleBps: s.eligibleBps,
    };
    const a = buildRoundPlan(input);
    const b = buildRoundPlan(input);
    assert.deepEqual(a.demand, b.demand, `scenario ${i}: the same inputs must produce the same plan`);
    assert.deepEqual(a.holders, b.holders);
    assert.equal(a.spentLamports, b.spentLamports);

    // Every holder's effective basket adds to 100 (or is empty when nothing is listed).
    for (const holder of a.holders) {
      const total = holder.picks.reduce((acc, p) => acc + p.pct, 0);
      assert.ok(total === 100 || holder.picks.length === 0, `scenario ${i}: basket for ${holder.wallet} sums to ${total}`);
      assert.ok(['prefs', 'prefs-adjusted', 'default'].includes(holder.source));
      for (const pick of holder.picks) {
        assert.ok(s.universe.some((u) => u.mint === pick.mint), `scenario ${i}: basket must stay inside the universe`);
        assert.ok(Number.isInteger(pick.pct) && pick.pct > 0);
      }
    }
  }
});
