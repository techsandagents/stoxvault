// The Helius holder listing.
//
// This is the single most load-bearing call in the system: no holder list means
// no round can pay anybody. On 2026-09-08, the first time it was pointed at a
// real launched mint, it failed outright — the request carried BOTH `options`
// and `displayOptions`, Helius deserializes the second into the same field, and
// the whole call was rejected with "duplicate field `options`". Every test until
// then used an injected fake, so nothing had ever checked the shape of the
// request we actually put on the wire.
//
// Verified against the live endpoint that day: `options` alone works,
// `displayOptions` alone works, both together error.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHoldersService } from '../src/services/holders.js';
import { computeEligible } from '../src/engine/index.js';

const MINT = 'MintUnderTest1111111111111111111111111111111';

/** A config shaped like the real one, with a Helius key so the DAS path is taken. */
function cfg(extra = {}) {
  const base = {
    tokenMint: MINT,
    tokenDecimals: 6,
    supplyRaw: '1000000000000000',
    eligibleThresholdRaw: '1000000000000',
    excluded: [],
    vaultAddress: 'VaultAddress11111111111111111111111111111111',
    rpcUrl: 'https://mainnet.helius-rpc.com/?api-key=test',
    heliusApiKey: 'test',
    // The service branches on this flag, not on the key string.
    hasHeliusKey: true,
    ...extra,
  };
  return base;
}

/** Captures every JSON-RPC call so the request shape itself can be asserted. */
function recordingRpc(pages) {
  const calls = [];
  let page = 0;
  return {
    calls,
    client: {
      async call(method, params) {
        calls.push({ method, params });
        if (method === 'getTokenAccounts') {
          const accounts = pages[page] || [];
          page += 1;
          return { token_accounts: accounts, total: accounts.length };
        }
        if (method === 'getTokenSupply') return { value: { amount: '1000000000000000', decimals: 6 } };
        if (method === 'getSlot') return 0;
        return null;
      },
    },
  };
}

test('getTokenAccounts never sends both options and displayOptions', async () => {
  const { calls, client } = recordingRpc([[{ owner: 'WalletA', amount: '5000000000000' }]]);
  const svc = createHoldersService({ cfg: cfg(), rpc: client });
  await svc.snapshot({ mint: MINT, decimals: 6, excluded: [], supplyRaw: '1000000000000000', minBalanceRaw: '1000000000000' });

  const listing = calls.filter((c) => c.method === 'getTokenAccounts');
  assert.ok(listing.length > 0, 'the Helius listing path must actually be used');

  for (const call of listing) {
    const keys = Object.keys(call.params || {});
    const hasOptions = keys.includes('options');
    const hasDisplay = keys.includes('displayOptions');
    assert.ok(
      !(hasOptions && hasDisplay),
      'Helius maps displayOptions onto options, so sending both is rejected as a duplicate field '
      + 'and the entire snapshot fails. Send exactly one.',
    );
    assert.equal(call.params.mint, MINT);
    assert.ok(Number.isInteger(call.params.limit) && call.params.limit > 0, 'a page limit is required');
  }
});

test('the listing pages until a short page ends it', async () => {
  // A full page means "there may be more"; a short one means the end. Getting
  // this wrong silently truncates the holder set and underpays everyone missed.
  const full = Array.from({ length: 1000 }, (_, i) => ({ owner: `W${i}`, amount: '5000000000000' }));
  const { calls, client } = recordingRpc([full, [{ owner: 'Wlast', amount: '5000000000000' }]]);
  const svc = createHoldersService({ cfg: cfg(), rpc: client });
  const snap = await svc.snapshot({ mint: MINT, decimals: 6, excluded: [], supplyRaw: '1000000000000000', minBalanceRaw: '1000000000000' });

  const listing = calls.filter((c) => c.method === 'getTokenAccounts');
  assert.equal(listing.length, 2, 'a full page must be followed by another request');
  assert.equal(listing[0].params.page, 1);
  assert.equal(listing[1].params.page, 2);
  const holders = snap.holders || snap;
  assert.equal(holders.length, 1001, 'every page must reach the holder set');
});

test('several token accounts owned by one wallet are summed, not listed twice', async () => {
  const { client } = recordingRpc([[
    { owner: 'WalletA', amount: '3000000000000' },
    { owner: 'WalletA', amount: '4000000000000' },
    { owner: 'WalletB', amount: '9000000000000' },
  ]]);
  const svc = createHoldersService({ cfg: cfg(), rpc: client });
  const snap = await svc.snapshot({ mint: MINT, decimals: 6, excluded: [], supplyRaw: '1000000000000000', minBalanceRaw: '1000000000000' });
  const holders = snap.holders || snap;

  assert.equal(holders.length, 2, 'one row per wallet, not per token account');
  const a = holders.find((h) => h.wallet === 'WalletA');
  assert.equal(a.balance, '7000000000000', 'a wallet paying twice would be paid twice');
});

test('the snapshot reports raw holders and the engine is what excludes', async () => {
  // Deliberate split, and worth pinning so nobody "fixes" it later: the snapshot
  // is a faithful record of the chain, so the published hash means something and
  // so min(open, close) can be taken against real balances. Filtering happens in
  // computeEligible, once, against that record.
  //
  // The stake is concrete: on the live mint the pump.fun bonding curve holds
  // 350M of the 1B supply. If it is not removed at that step it takes a third of
  // every drop away from real holders.
  const CURVE = 'BondingCurve1111111111111111111111111111111';
  const { client } = recordingRpc([[
    { owner: CURVE, amount: '350000000000000' },
    { owner: 'WalletA', amount: '5000000000000' },
  ]]);
  const svc = createHoldersService({ cfg: cfg({ excluded: [CURVE] }), rpc: client });
  const snap = await svc.snapshot({ mint: MINT, decimals: 6, excluded: [CURVE], supplyRaw: '1000000000000000', minBalanceRaw: '1000000000000' });
  const holders = snap.holders || snap;

  assert.ok(holders.some((h) => h.wallet === CURVE), 'the raw record keeps every account the chain has');

  const eligible = computeEligible(holders, {
    supplyRaw: '1000000000000000',
    eligibleBps: 10,
    excluded: [CURVE],
  });
  assert.ok(!eligible.some((h) => h.wallet === CURVE), 'the curve must carry no weight in a round');
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].wallet, 'WalletA');
});

test('a blank mint returns nothing rather than asking the chain', async () => {
  const { calls, client } = recordingRpc([[]]);
  const svc = createHoldersService({ cfg: cfg({ tokenMint: '' }), rpc: client });
  const snap = await svc.snapshot({ mint: '', decimals: 6, excluded: [], supplyRaw: '1000000000000000', minBalanceRaw: '1000000000000' });
  const holders = snap.holders || snap;
  assert.equal(holders.length, 0);
  assert.equal(calls.filter((c) => c.method === 'getTokenAccounts').length, 0, 'no mint, no listing call');
});
