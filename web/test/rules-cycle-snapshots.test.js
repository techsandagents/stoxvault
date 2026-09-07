/**
 * Tests for the front-end decisions this release added, all of them pure:
 *
 *   1. rules.js  — the copy for "How it works" step 2 and the ledger footnote is
 *      derived from /api/config.rules (antiCheat, openSnapshotWindowMin), and a
 *      server that reports no flag produces NO claim, so the shipped wording
 *      stands. Plus the contract-address button's state, which must stay
 *      disabled and copy nothing while token.mint is null.
 *   2. basket.js — reading /api/me.cycle: the verdict and the "you bought this
 *      cycle, your first drop is next round" note, with an absent cycle object
 *      producing no verdict at all.
 *   3. rounds.js — finding a round's two snapshots wherever the server records
 *      them, and returning null rather than inventing one.
 *
 * Run from the repo root:  node --test web/test/
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { snapshotRuleCopy, ledgerFootNote, coinButtonState, windowPhrase } from '../public/js/rules.js';
import { readCycle } from '../public/js/ui/basket.js';
import { snapshotSide } from '../public/js/ui/rounds.js';

/** The shape /api/config actually returns, with the anti-cheat rule on. */
const CONFIG = {
  token: { name: null, symbol: null, mint: null, decimals: 6, launched: false },
  intervalHours: 6,
  rules: { jitterMin: 10, antiCheat: true, openSnapshotWindowMin: 60 },
};

/* ------------------------------------------- 1. the rule, from the server -- */

test('anti-cheat copy states two snapshots and the smaller balance', () => {
  const copy = snapshotRuleCopy(CONFIG);
  assert.ok(copy, 'the server named the rule, so the page states it');
  assert.equal(copy.hours, '6');
  assert.match(copy.title, /two snapshots/i);
  assert.match(copy.after, /an hour before the mark/);
  assert.match(copy.after, /smaller of the two balances/);
  assert.match(copy.after, /first drop is the round after/);
  assert.match(copy.after, /±10 minutes/);
});

test('anti-cheat off states the single-snapshot rule instead', () => {
  const copy = snapshotRuleCopy({ ...CONFIG, rules: { ...CONFIG.rules, antiCheat: false } });
  assert.ok(copy);
  assert.equal(copy.title, 'A snapshot is taken');
  assert.doesNotMatch(copy.after, /two snapshots/i);
  assert.doesNotMatch(copy.after, /smaller/i);
});

test('a server that never mentions the rule gets no sentence invented for it', () => {
  // Exactly the /api/config a server without the anti-cheat release returns.
  const older = { intervalHours: 6, rules: { jitterMin: 10 } };
  assert.equal(snapshotRuleCopy(older), null);
  assert.equal(snapshotRuleCopy({ rules: { antiCheat: true } }), null, 'no interval, no rewrite');
  assert.equal(snapshotRuleCopy(null), null);
});

test('the opening window is worded from the number the server sent', () => {
  assert.equal(windowPhrase(60), 'an hour');
  assert.equal(windowPhrase(120), '2 hours');
  assert.equal(windowPhrase(90), '90 minutes');
  assert.equal(windowPhrase(5), '5 minutes');
  assert.equal(windowPhrase(null), null);
  assert.equal(windowPhrase(0), null);

  const copy = snapshotRuleCopy({ ...CONFIG, rules: { ...CONFIG.rules, openSnapshotWindowMin: 90 } });
  assert.match(copy.after, /90 minutes before the mark/);
});

test('an anti-cheat round with no window still says a window exists', () => {
  const copy = snapshotRuleCopy({ ...CONFIG, rules: { antiCheat: true, jitterMin: 10 } });
  assert.match(copy.after, /when the cycle opens/);
  assert.doesNotMatch(copy.after, /null|undefined|NaN/);
});

test('the ledger footnote follows the same flags', () => {
  assert.match(ledgerFootNote(CONFIG), /two snapshots — one 60 minutes before the mark/);
  assert.match(ledgerFootNote(CONFIG), /smaller of the two balances/);
  assert.match(
    ledgerFootNote({ rules: { jitterMin: 10 } }),
    /^Times are UTC\. The snapshot is taken at a random offset within ±10 minutes of each mark\.$/,
  );
  assert.equal(ledgerFootNote({ rules: {} }), null, 'no jitter reported, no new sentence');
  assert.equal(ledgerFootNote({ rules: { jitterMin: null, antiCheat: true } }), null);
});

/* ------------------------------------------ 1b. the contract-address button */

test('the contract button is disabled and copies nothing before launch', () => {
  const state = coinButtonState(CONFIG);
  assert.equal(state.mint, null, 'there is no mint to copy');
  assert.equal(state.disabled, true);
  assert.equal(state.ticker, '$STOXVAULT');
  assert.match(state.label, /not available until launch/);
});

test('the contract button enables itself when the server reports a mint', () => {
  const launched = {
    ...CONFIG,
    token: { symbol: 'STOX', mint: 'MintAddressFromTheServer1111111111111111111', launched: true },
  };
  const state = coinButtonState(launched);
  assert.equal(state.mint, 'MintAddressFromTheServer1111111111111111111');
  assert.equal(state.disabled, false);
  assert.equal(state.ticker, '$STOX');
  assert.equal(state.label, 'Copy the $STOX contract address');
});

test('a blank or whitespace mint is treated as no mint', () => {
  for (const mint of ['', '   ', null, undefined, 42]) {
    const state = coinButtonState({ token: { symbol: 'STOX', mint } });
    assert.equal(state.mint, null, `mint ${JSON.stringify(mint)} must not be copyable`);
    assert.equal(state.disabled, true);
  }
});

test('a leading $ in the server symbol is not doubled', () => {
  assert.equal(coinButtonState({ token: { symbol: '$STOX' } }).ticker, '$STOX');
});

/* ---------------------------------------------------- 2. /api/me.cycle -- */

test('a wallet that held the whole cycle reads as held, with no callout', () => {
  const read = readCycle({ heldFullCycle: true });
  assert.equal(read.known, true);
  assert.equal(read.held, true);
  assert.equal(read.showNote, false);
});

test("a wallet that bought this cycle shows the server's own note", () => {
  const note = 'You bought during this cycle, so this round pays nothing. Your first drop is the next one.';
  const read = readCycle({ heldFullCycle: false, note });
  assert.equal(read.held, false);
  assert.equal(read.note, note);
  assert.equal(read.showNote, true, 'this is the confusing case: it must be shown');
});

test('a false verdict with no server note still shows the rule', () => {
  const read = readCycle({ held: false });
  assert.equal(read.held, false);
  assert.equal(read.note, null);
  assert.equal(read.showNote, true);
});

test('alternative field names the server might use are all accepted', () => {
  assert.equal(readCycle({ heldWholeCycle: true }).held, true);
  assert.equal(readCycle({ fullCycle: false }).held, false);
  assert.equal(readCycle({ heldFull: true }).held, true);
  assert.equal(readCycle({ held: true }).held, true);
  assert.equal(readCycle({ message: 'anything' }).note, 'anything');
  assert.equal(readCycle({ detail: 'anything' }).note, 'anything');
});

test('no cycle object yields no verdict at all', () => {
  for (const raw of [undefined, null, 'nope', 7, []]) {
    const read = readCycle(raw);
    assert.equal(read.known, false, `${JSON.stringify(raw)} must not produce a verdict`);
    assert.equal(read.held, null);
    assert.equal(read.showNote, false);
  }
});

test('a cycle object with neither flag nor note stays silent', () => {
  const read = readCycle({ openBalanceRaw: '1', closeBalanceRaw: '2' });
  assert.equal(read.known, false);
  assert.equal(read.showNote, false);
});

/* -------------------------------------------- 3. both round snapshots -- */

const OPEN = { takenAt: '2026-09-07T11:02:00.000Z', hash: 'aa11' };
const CLOSE = { takenAt: '2026-09-07T12:07:00.000Z', hash: 'ff99' };

test('the two snapshots are found under any of the shapes the server may use', () => {
  assert.deepEqual(snapshotSide({ snapshotOpen: OPEN }, 'open'), OPEN);
  assert.deepEqual(snapshotSide({ openSnapshot: OPEN }, 'open'), OPEN);
  assert.deepEqual(snapshotSide({ snapshots: { open: OPEN } }, 'open'), OPEN);
  assert.deepEqual(snapshotSide({ snapshots: { opening: OPEN } }, 'open'), OPEN);
  assert.deepEqual(snapshotSide({ snapshotClose: CLOSE }, 'close'), CLOSE);
  assert.deepEqual(snapshotSide({ closeSnapshot: CLOSE }, 'close'), CLOSE);
  assert.deepEqual(snapshotSide({ snapshots: { close: CLOSE } }, 'close'), CLOSE);
});

test('a round without two snapshots reports none, and none is invented', () => {
  const single = { snapshot: CLOSE, snapshotMode: undefined };
  assert.equal(snapshotSide(single, 'open'), null, 'the round snapshot is not an opening snapshot');
  assert.equal(snapshotSide(single, 'close'), null);
  assert.equal(snapshotSide({}, 'open'), null);
  assert.equal(snapshotSide(null, 'close'), null);
  assert.equal(snapshotSide({ snapshotOpen: 'not an object' }, 'open'), null);
  assert.equal(snapshotSide({ snapshotOpen: [] }, 'open'), null);
});

test('the open side never falls back to the close side', () => {
  assert.equal(snapshotSide({ snapshotClose: CLOSE }, 'open'), null);
  assert.equal(snapshotSide({ snapshotOpen: OPEN }, 'close'), null);
});
