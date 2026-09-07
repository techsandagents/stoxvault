/**
 * Regression tests for the two web modules that render the ledger and the
 * basket. They exercise the pure decision functions those modules export, so no
 * DOM is needed: the bugs fixed here were all decisions taken before any
 * element was touched.
 *
 *   1. rounds.js showed a Jupiter quote in the "Received" column of a swap that
 *      failed, i.e. presented a quote as a fill.
 *   2. basket.js re-rendered picks over a universe that failed to load, calling
 *      every blue chip delisted, and overwrote the error pane's retry button.
 *   3. basket.js coerced a null pool to 0 (Number(null) === 0), so an unreadable
 *      vault balance rendered as "0.000 SOL" next to the Vault panel's em dash.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { swapReceipt } from '../../web/public/js/ui/rounds.js';
import { picksPaneState, validateBasket } from '../../web/public/js/ui/basket.js';
import { num } from '../../web/public/js/format.js';

const RULES = { minPicks: 2, maxPicks: 5, minPct: 10, maxPct: 60, universeSize: 20, defaultBasketSize: 5 };

/* ------------------------------------------------ 1. quote is not a fill -- */

test('a FAILED swap never reports its quote as a received amount', () => {
  // Exactly what the runner persists when the swap fails after quoting.
  const swap = { mint: 'Xs...TSLA', symbol: 'TSLAx', solLamports: '1000000', quotedOut: '42000000', receivedRaw: null, tx: null, status: 'FAILED', error: 'slippage' };
  const { filled, quoted } = swapReceipt(swap);
  assert.equal(filled, null, 'a failed swap received nothing');
  assert.equal(quoted, '42000000', 'the quote is still available, labelled as a quote');
});

test('a swap still swapping does not report a fill either', () => {
  const { filled, quoted } = swapReceipt({ quotedOut: '42000000', receivedRaw: null, status: 'PENDING' });
  assert.equal(filled, null);
  assert.equal(quoted, '42000000');
});

test('a DONE swap reports its received amount and no quote', () => {
  const { filled, quoted } = swapReceipt({ quotedOut: '42000000', receivedRaw: '41870000', status: 'DONE' });
  assert.equal(filled, '41870000', 'the fill is the measured amount, not the quote');
  assert.equal(quoted, null, 'a filled swap has nothing to label as a quote');
});

test('a DONE swap that received exactly zero is a zero fill, not unknown', () => {
  const { filled, quoted } = swapReceipt({ quotedOut: '42000000', receivedRaw: '0', status: 'DONE' });
  assert.equal(filled, '0');
  assert.equal(quoted, null);
});

test('a swap with neither a fill nor a quote reports nothing at all', () => {
  const { filled, quoted } = swapReceipt({ status: 'FAILED' });
  assert.equal(filled, null);
  assert.equal(quoted, null);
  assert.deepEqual(swapReceipt(undefined), { filled: null, quoted: null, status: '' });
});

/* --------------------------------- 2. a failed universe is not a verdict -- */

test('a failed universe keeps the picks pane in its error state', () => {
  assert.equal(picksPaneState({ universeFailed: true, pickCount: 4 }), 'error');
  assert.equal(picksPaneState({ universeFailed: true, pickCount: 0 }), 'error');
});

test('a loaded universe still renders picks and empties normally', () => {
  assert.equal(picksPaneState({ universeFailed: false, pickCount: 4 }), 'ready');
  assert.equal(picksPaneState({ universeFailed: false, pickCount: 0 }), 'empty');
});

test('four blue chips are not called delisted when the universe failed to load', () => {
  const picks = [
    { mint: 'mNVDA', pct: 30 },
    { mint: 'mAAPL', pct: 30 },
    { mint: 'mMSFT', pct: 20 },
    { mint: 'mTSLA', pct: 20 },
  ];
  const state = validateBasket(picks, { rules: RULES, index: new Map(), universeKnown: false, universeFailed: true });
  assert.notEqual(state.code, 'not_in_universe', 'an empty index is not evidence of a delisting');
  assert.equal(state.ok, true, 'the basket itself is still valid');
  assert.equal(state.badMints.size, 0, 'no pick is blamed for a fetch failure');
  assert.match(state.text, /top 20 did not load/, 'the line names the real problem');
  assert.equal(state.level, 'warn');
});

test('a pick genuinely outside a fetched universe is still reported', () => {
  const index = new Map([['mNVDA', {}], ['mAAPL', {}]]);
  const picks = [
    { mint: 'mNVDA', pct: 50 },
    { mint: 'mGONE', pct: 50 },
  ];
  const state = validateBasket(picks, { rules: RULES, index, universeKnown: true, universeFailed: false });
  assert.equal(state.code, 'not_in_universe');
  assert.equal(state.ok, false);
  assert.ok(state.badMints.has('mGONE'));
});

test('the other rules still hold when the universe is unknown', () => {
  const opts = { rules: RULES, index: new Map(), universeKnown: false, universeFailed: true };
  assert.equal(validateBasket([{ mint: 'a', pct: 100 }], opts).code, 'count');
  assert.equal(validateBasket([{ mint: 'a', pct: 50 }, { mint: 'a', pct: 50 }], opts).code, 'duplicate');
  assert.equal(validateBasket([{ mint: 'a', pct: 90 }, { mint: 'b', pct: 10 }], opts).code, 'range');
  assert.equal(validateBasket([{ mint: 'a', pct: 40 }, { mint: 'b', pct: 40 }], opts).code, 'sum');
});

test('a fully loaded universe keeps the plain success line', () => {
  const index = new Map([['a', {}], ['b', {}]]);
  const state = validateBasket([{ mint: 'a', pct: 60 }, { mint: 'b', pct: 40 }], {
    rules: RULES,
    index,
    universeKnown: true,
    universeFailed: false,
  });
  assert.equal(state.ok, true);
  assert.equal(state.level, 'ok');
  assert.equal(state.text, '2 stocks, 100% allocated.');
});

/* ------------------------------------------- 3. unknown must stay unknown -- */

test('an unknown pool stays null instead of coercing to zero', () => {
  // The coercion the projection panel used to make: Number(null) === 0.
  assert.equal(Number(null), 0);
  assert.equal(num(null), null, 'null pool -> unknown');
  assert.equal(num(undefined), null);
  assert.equal(num(''), null);
  assert.equal(num('  '), null);
  assert.equal(num(false), null);
  assert.equal(num([]), null);
  assert.equal(num(NaN), null);
});

test('a real pool figure still passes through, including a true zero', () => {
  assert.equal(num(0), 0, 'a vault that really is empty still reads 0');
  assert.equal(num(4.211), 4.211);
  assert.equal(num('4.211'), 4.211);
});
