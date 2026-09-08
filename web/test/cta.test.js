/**
 * Tests for the call-to-action banner's decision layer (`public/js/cta.js`).
 *
 * The banner is the one element on the page that actively asks somebody to do
 * something, so the interesting cases are not the five happy states — they are
 * the refusals. A field the API did not send must never become a claim, and
 * "eligible", "you have picked" and "you need N tokens" are all claims.
 *
 * Everything under test is pure: no DOM, no fetch, no clock.
 *
 * Run from the repo root:  node --test web/test/
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ctaState,
  ctaCopy,
  shouldShow,
  parseDismissed,
  serialiseDismissed,
  savedPicks,
  savedPicksText,
  basketText,
  thresholdText,
} from '../public/js/cta.js';

/* The live server's own shapes, trimmed to what the banner reads. */

const LAUNCHED = {
  token: { name: 'StoxVault', symbol: 'STOXVAULT', mint: '7NACVp3qt8xLQcWtQYZnqsk6k8kn334s2TopimmRpump', launched: true },
  rules: { eligibleBps: 10, eligibleThresholdUi: 1000000 },
  defaultBasket: { picks: [{ mint: 'Xs3o', symbol: 'SPCXx', pct: 100 }], resolved: true },
};

const PRE_LAUNCH = {
  token: { name: null, symbol: null, mint: null, launched: false },
  rules: { eligibleBps: 10 },
  defaultBasket: { picks: [], resolved: false },
};

const SYMBOLS = new Map([
  ['NVDAmint', 'NVDAx'],
  ['TSLAmint', 'TSLAx'],
  ['SPCXmint', 'SPCXx'],
]);
const symbolOf = (mint) => SYMBOLS.get(mint) || null;

const eligibleMe = (extra = {}) => ({
  wallet: 'Wa11et',
  balance: { raw: '5000000000000', ui: 5000000, eligible: true, thresholdUi: 1000000 },
  prefs: null,
  effectivePicks: [{ mint: 'SPCXmint', pct: 100 }],
  picksSource: 'default',
  ...extra,
});

/* ============================================================ the five states */

test('A — a stranger is asked to connect, and told what the default is', () => {
  const view = ctaState({ config: LAUNCHED, me: null, connected: false });
  assert.equal(view.state, 'connect');
  assert.equal(view.key, 'connect');
  assert.equal(view.defaultText, '100% SPCXx', "the server's own default, not a guess");

  const copy = ctaCopy(view);
  assert.equal(copy.primary.action, 'connect', 'the primary action opens the wallet modal');
  assert.equal(copy.secondary.action, 'basket', 'and a secondary one lets you look first');
  assert.match(copy.text, /100% SPCXx/);
});

test('B — connected, eligible and nothing saved is the state that matters', () => {
  const view = ctaState({ config: LAUNCHED, me: eligibleMe(), connected: true, symbolOf });
  assert.equal(view.state, 'choose');
  assert.equal(view.picksText, null, 'nothing was saved, so nothing is claimed to be');

  const copy = ctaCopy(view, { countdown: '4h 36m' });
  assert.match(copy.title, /have not picked/i);
  assert.match(copy.text, /100% SPCXx/, 'the default is named');
  assert.equal(copy.meta, 'Next round in 4h 36m.', 'the countdown makes it concrete');
  assert.equal(copy.primary.action, 'basket');
});

test('B — an unknown countdown drops the line rather than printing a placeholder', () => {
  const copy = ctaCopy(ctaState({ config: LAUNCHED, me: eligibleMe(), connected: true }), { countdown: null });
  assert.equal(copy.meta, null);
});

test('C — a saved basket reads as a receipt, with no primary button', () => {
  const me = eligibleMe({
    prefs: { picks: [{ mint: 'NVDAmint', pct: 60 }, { mint: 'TSLAmint', pct: 40 }] },
    picksSource: 'prefs',
  });
  const view = ctaState({ config: LAUNCHED, me, connected: true, symbolOf });
  assert.equal(view.state, 'saved');
  assert.equal(view.picksText, 'NVDAx 60%, TSLAx 40%');

  const copy = ctaCopy(view);
  assert.equal(copy.primary, null, 'a receipt has no gold bar to press');
  assert.match(copy.text, /NVDAx 60%, TSLAx 40%/);
  assert.match(copy.text, /next round/i, 'the full-cycle rule is stated');
});

test('C — picks that cannot all be named degrade to the generic sentence', () => {
  // A saved stock that fell out of the top 20 has no symbol to print. Better a
  // vaguer receipt than one with a raw mint or a gap in it.
  const me = eligibleMe({
    prefs: { picks: [{ mint: 'NVDAmint', pct: 60 }, { mint: 'DelistedMint', pct: 40 }] },
    picksSource: 'prefs',
  });
  const view = ctaState({ config: LAUNCHED, me, connected: true, symbolOf });
  assert.equal(view.state, 'saved', 'they did save something, and that is still true');
  assert.equal(view.picksText, null);
  assert.doesNotMatch(ctaCopy(view).text, /DelistedMint/);
});

test('D — below the threshold states the threshold as a fact and does not sell', () => {
  const me = eligibleMe({ balance: { raw: '10', ui: 10, eligible: false, thresholdUi: 1000000 } });
  const view = ctaState({ config: LAUNCHED, me, connected: true, symbolOf });
  assert.equal(view.state, 'below');
  assert.equal(view.thresholdText, '1,000,000 STOXVAULT (0.1% of supply)');

  const copy = ctaCopy(view);
  assert.equal(copy.primary, null);
  assert.equal(copy.secondary.action, 'basket', 'the basket is still offered');
  assert.doesNotMatch(copy.text, /\bbuy\b|\bmore\b|\btop up\b/i, 'it must not tell anyone to buy');
});

test('D — a wallet below the line that already saved a basket keeps its receipt wording', () => {
  const me = eligibleMe({
    balance: { raw: '10', ui: 10, eligible: false, thresholdUi: 1000000 },
    prefs: { picks: [{ mint: 'TSLAmint', pct: 100 }] },
    picksSource: 'prefs',
  });
  const view = ctaState({ config: LAUNCHED, me, connected: true, symbolOf });
  assert.equal(view.state, 'below');
  assert.equal(view.picksText, '100% TSLAx');
  assert.match(ctaCopy(view).text, /saved basket stays as it is/);
});

test('E — before launch there is nothing to ask for', () => {
  assert.equal(ctaState({ config: PRE_LAUNCH, me: null, connected: false }).state, 'none');
  assert.equal(ctaState({ config: PRE_LAUNCH, me: eligibleMe(), connected: true }).state, 'none');
  assert.equal(ctaCopy({ state: 'none' }), null);
});

test('E — an unreadable config renders nothing at all', () => {
  for (const config of [null, undefined, 'nope', 42, []]) {
    assert.equal(ctaState({ config, connected: false }).state, 'none', `${JSON.stringify(config)} must show nothing`);
  }
  assert.equal(ctaState({ config: { token: {} } }).state, 'none', 'no launched flag is not a launch');
  assert.equal(ctaState({ config: { token: { launched: 'true' } } }).state, 'none', 'a string is not the boolean');
});

/* ====================================================== degradation, in detail */

test('eligibility the server did not state is never invented in either direction', () => {
  // A `me` with no balance at all: the coin is launched but the chain read
  // failed. That is neither "you qualify" nor "you are below the line".
  assert.equal(ctaState({ config: LAUNCHED, me: { wallet: 'W', balance: null }, connected: true }).state, 'none');
  assert.equal(ctaState({ config: LAUNCHED, me: { wallet: 'W' }, connected: true }).state, 'none');
  assert.equal(
    ctaState({ config: LAUNCHED, me: { balance: { eligible: 'yes' } }, connected: true }).state,
    'none',
    'a truthy string is not a boolean the API sent',
  );
});

test('a connected session with no /api/me document yet says nothing', () => {
  // This is the moment between a successful signature and the first `me` load.
  assert.equal(ctaState({ config: LAUNCHED, me: null, connected: true }).state, 'none');
});

test('effectivePicks alone is never read as a choice', () => {
  // Every eligible wallet has effectivePicks — it is what a round WOULD buy,
  // which is the default when nothing was saved. Reading it as a saved basket
  // is exactly how 57 wallets would be told they had picked when they had not.
  const me = eligibleMe({ effectivePicks: [{ mint: 'SPCXmint', pct: 100 }], picksSource: 'default', prefs: null });
  assert.equal(savedPicks(me), null);
  assert.equal(ctaState({ config: LAUNCHED, me, connected: true, symbolOf }).state, 'choose');
});

test('the server’s own picksSource is accepted when prefs are not echoed back', () => {
  const me = eligibleMe({ prefs: null, picksSource: 'prefs-adjusted', effectivePicks: [{ mint: 'NVDAmint', pct: 100 }] });
  assert.deepEqual(savedPicks(me), [{ mint: 'NVDAmint', pct: 100 }]);
  assert.equal(ctaState({ config: LAUNCHED, me, connected: true, symbolOf }).state, 'saved');
});

test('an empty or junk prefs list is not a saved basket', () => {
  assert.equal(savedPicks({ prefs: { picks: [] } }), null);
  assert.equal(savedPicks({ prefs: { picks: [null, {}, { pct: 20 }] } }), null, 'entries with no mint name nothing');
  assert.equal(savedPicks({ prefs: 'yes' }), null);
  assert.equal(savedPicks(null), null);
});

test('a default basket the server did not resolve leaves the sentence generic', () => {
  const config = { ...LAUNCHED, defaultBasket: { picks: [], resolved: false } };
  const view = ctaState({ config, connected: false });
  assert.equal(view.state, 'connect', 'the banner still runs — it just names nothing');
  assert.equal(view.defaultText, null);
  const copy = ctaCopy(view);
  assert.match(copy.text, /you get the standard basket\./);
  assert.doesNotMatch(copy.text, /currently/, 'nothing is named that the server did not name');
  assert.doesNotMatch(copy.text, /null|undefined|NaN/);
});

test('a not-eligible wallet with no threshold anywhere shows nothing rather than a scold', () => {
  const config = { token: { symbol: 'STOXVAULT', launched: true }, rules: {}, defaultBasket: { picks: [] } };
  const me = { balance: { eligible: false } };
  assert.equal(thresholdText(config, me), null);
  assert.equal(ctaState({ config, me, connected: true }).state, 'none');
});

test('half a threshold is still a fact worth stating', () => {
  const bpsOnly = { token: { symbol: 'STOXVAULT', launched: true }, rules: { eligibleBps: 10 }, defaultBasket: {} };
  assert.equal(thresholdText(bpsOnly, { balance: { eligible: false } }), '0.1% of supply');

  const uiOnly = { token: { symbol: 'STOXVAULT', launched: true }, rules: {}, defaultBasket: {} };
  assert.equal(thresholdText(uiOnly, { balance: { eligible: false, thresholdUi: 1000000 } }), '1,000,000 STOXVAULT');
});

test('a missing token symbol does not print "1,000,000 undefined"', () => {
  const config = { token: { launched: true }, rules: { eligibleBps: 10, eligibleThresholdUi: 1000000 } };
  assert.equal(thresholdText(config, {}), '1,000,000 (0.1% of supply)');
});

/* ================================================================ the wording */

test('every state names the default basket, or names nothing, but never a number the API did not send', () => {
  for (const state of ['connect', 'choose', 'saved', 'below']) {
    const copy = ctaCopy({ state, key: state, defaultText: null, picksText: null, thresholdText: '0.1% of supply' });
    assert.ok(copy, `${state} has copy`);
    assert.doesNotMatch(`${copy.title} ${copy.text}`, /null|undefined|NaN/, `${state} prints no holes`);
  }
});

test('no state promises money, a return or a bigger drop for picking', () => {
  const views = [
    ctaState({ config: LAUNCHED, connected: false }),
    ctaState({ config: LAUNCHED, me: eligibleMe(), connected: true, symbolOf }),
    ctaState({
      config: LAUNCHED,
      me: eligibleMe({ prefs: { picks: [{ mint: 'NVDAmint', pct: 100 }] }, picksSource: 'prefs' }),
      connected: true,
      symbolOf,
    }),
    ctaState({
      config: LAUNCHED,
      me: eligibleMe({ balance: { eligible: false, thresholdUi: 1000000 } }),
      connected: true,
      symbolOf,
    }),
  ];
  for (const view of views) {
    const copy = ctaCopy(view, { countdown: '4h 36m' });
    const words = `${copy.title} ${copy.text} ${copy.meta || ''}`;
    assert.doesNotMatch(words, /\bprofit|\breturn\b|\byield\b|\bearn\b|\bAPY\b|\bgain\b|guarantee/i, view.state);
    // "pick and get MORE" is the specific lie this product could tell: picking
    // changes which stocks arrive, not how much is spent on them.
    assert.doesNotMatch(words, /\bmore\b/i, `${view.state} must not imply picking pays more`);
  }
});

test('the two states that ask for a choice say picking changes which, not how much', () => {
  for (const state of ['connect', 'choose']) {
    const view = ctaState(
      state === 'connect'
        ? { config: LAUNCHED, connected: false }
        : { config: LAUNCHED, me: eligibleMe(), connected: true },
    );
    assert.match(ctaCopy(view).text, /which stocks arrive, not how much is spent/);
  }
});

test('the states about a saved basket say it applies from the next round', () => {
  const choose = ctaCopy(ctaState({ config: LAUNCHED, me: eligibleMe(), connected: true }));
  assert.match(choose.text, /counts from the next round on, never one already under way/);

  const saved = ctaCopy(
    ctaState({
      config: LAUNCHED,
      me: eligibleMe({ prefs: { picks: [{ mint: 'NVDAmint', pct: 100 }] }, picksSource: 'prefs' }),
      connected: true,
      symbolOf,
    }),
  );
  assert.match(saved.text, /from the next round on/);
});

/* ============================================================ basket wording */

test('a basket reads correctly whether it is one stock, an even split or not', () => {
  assert.equal(basketText([{ symbol: 'SPCXx', pct: 100 }]), '100% SPCXx');
  assert.equal(basketText([{ symbol: 'NVDAx', pct: 20 }, { symbol: 'TSLAx', pct: 20 }]), 'NVDAx, TSLAx — 20% each');
  assert.equal(basketText([{ symbol: 'NVDAx', pct: 60 }, { symbol: 'TSLAx', pct: 40 }]), 'NVDAx 60%, TSLAx 40%');
  assert.equal(basketText([]), null);
  assert.equal(basketText(null), null);
  assert.equal(basketText([{ pct: 50 }, { symbol: '  ' }]), null, 'unnamed picks name nothing');
});

test('saved picks need every symbol before any of them is printed', () => {
  const picks = [{ mint: 'NVDAmint', pct: 60 }, { mint: 'TSLAmint', pct: 40 }];
  assert.equal(savedPicksText(picks, symbolOf), 'NVDAx 60%, TSLAx 40%');
  assert.equal(savedPicksText(picks, () => null), null, 'no universe yet, so no names');
  assert.equal(savedPicksText(picks, undefined), null);
  assert.equal(savedPicksText([], symbolOf), null);
});

/* ================================================================= dismissal */

test('dismissal is per state, so new information is still shown', () => {
  const dismissed = parseDismissed('connect');
  assert.equal(shouldShow({ state: 'connect', key: 'connect' }, dismissed), false);
  assert.equal(
    shouldShow({ state: 'choose', key: 'choose' }, dismissed),
    true,
    'closing the stranger prompt must not hide "you qualify and have not chosen"',
  );
});

test('a stored value that is nonsense dismisses nothing', () => {
  for (const raw of [null, undefined, '', '   ', 42, {}, 'connect;choose', '<script>']) {
    const set = parseDismissed(raw);
    assert.equal(set.size, 0, `${JSON.stringify(raw)} must not dismiss anything`);
  }
  assert.deepEqual([...parseDismissed('connect,nope,saved')], ['connect', 'saved'], 'unknown keys are dropped');
});

test('the round trip through storage keeps only real state keys', () => {
  assert.equal(serialiseDismissed(new Set(['choose', 'made-up', 'below'])), 'choose,below');
  assert.equal(serialiseDismissed(new Set()), '');
  assert.equal(serialiseDismissed(null), '');
});

test('the none state is never shown, dismissed or not', () => {
  assert.equal(shouldShow({ state: 'none', key: null }, new Set()), false);
  assert.equal(shouldShow(null, new Set()), false);
  assert.equal(shouldShow({ state: 'choose' }, new Set()), false, 'no key, nothing to remember, nothing to show');
});
