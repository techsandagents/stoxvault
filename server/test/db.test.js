// Store tests. `node --test test/`
// The JSON store is exercised for real against a temp directory; the pg store needs a
// live Postgres and is only smoke-imported here.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { openDb, STORE_METHODS, StoreError, jsonSafe, summarizeRound, normalizePrefs } from '../src/db/index.js';
import { openJsonStore } from '../src/db/json.js';

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stockdrop-db-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function freshStore(t) {
  const dir = await tmpDir(t);
  const store = await openDb({ dataDir: dir });
  t.after(() => store.close());
  return { store, dir };
}

const prefsFor = (wallet, picks = [{ mint: 'MintA', symbol: 'AAPLx', pct: 60 }, { mint: 'MintB', symbol: 'NVDAx', pct: 40 }]) => ({
  wallet,
  picks,
  signature: `sig-${wallet}`,
  message: `STOCKDROP\nWallet: ${wallet}`,
  updatedAt: '2026-09-07T12:00:00.000Z',
});

function roundFor(id, extra = {}) {
  return {
    id,
    scheduledAt: '2026-09-07T12:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    status: 'PENDING',
    simulated: true,
    skipReason: null,
    poolLamports: '10000000000',
    reserveLamports: '50000000',
    universe: [],
    top5: [],
    snapshot: null,
    demand: [],
    swaps: [],
    transfers: [],
    carryIn: [],
    carryOut: [],
    stats: {},
    error: null,
    ...extra,
  };
}

/* ------------------------------------------------------------- selection */

test('openDb picks the json store when DATABASE_URL is blank', async (t) => {
  const { store } = await freshStore(t);
  assert.equal(store.kind, 'json');
  for (const method of STORE_METHODS) assert.equal(typeof store[method], 'function', `missing ${method}`);
});

test('the json store creates its directory layout', async (t) => {
  const dir = await tmpDir(t);
  const store = await openJsonStore({ dataDir: path.join(dir, 'nested', 'state') });
  t.after(() => store.close());
  await store.setKV('k', 1);
  const entries = (await fs.readdir(path.join(dir, 'nested', 'state'))).sort();
  assert.deepEqual(entries, ['kv.json', 'rounds']);
});

/* ------------------------------------------------------------------ prefs */

test('prefs round-trip: get / set / list / all / delete', async (t) => {
  const { store } = await freshStore(t);
  assert.equal(await store.getPrefs('nobody'), null);

  const saved = await store.setPrefs(prefsFor('WalletA'));
  assert.equal(saved.wallet, 'WalletA');
  assert.equal(saved.picks.length, 2);
  assert.equal(saved.picks[0].pct, 60);
  assert.equal(saved.signature, 'sig-WalletA');
  assert.equal(saved.updatedAt, '2026-09-07T12:00:00.000Z');

  const read = await store.getPrefs('WalletA');
  assert.deepEqual(read, saved);

  // returned documents are copies: mutating them must not corrupt the store
  read.picks[0].pct = 99;
  assert.equal((await store.getPrefs('WalletA')).picks[0].pct, 60);

  // overwrite
  await store.setPrefs({ ...prefsFor('WalletA'), picks: [{ mint: 'MintC', pct: 100 }], updatedAt: '2026-09-08T00:00:00.000Z' });
  const updated = await store.getPrefs('WalletA');
  assert.equal(updated.picks.length, 1);
  assert.equal(updated.picks[0].mint, 'MintC');
  assert.equal(updated.picks[0].symbol, null);

  await store.setPrefs({ ...prefsFor('WalletB'), updatedAt: '2026-09-06T00:00:00.000Z' });
  const all = await store.allPrefs();
  assert.deepEqual(all.map((p) => p.wallet), ['WalletA', 'WalletB']);

  const page = await store.listPrefs({ limit: 1, offset: 0 });
  assert.equal(page.total, 2);
  assert.deepEqual(page.items.map((p) => p.wallet), ['WalletA'], 'newest first');
  const page2 = await store.listPrefs({ limit: 1, offset: 1 });
  assert.deepEqual(page2.items.map((p) => p.wallet), ['WalletB']);

  await store.deletePrefs('WalletA');
  assert.equal(await store.getPrefs('WalletA'), null);
  assert.equal((await store.listPrefs({})).total, 1);
  await store.deletePrefs('WalletA'); // deleting twice is fine
});

test('normalizePrefs rejects junk', () => {
  assert.throws(() => normalizePrefs({ picks: [] }), StoreError);
  assert.throws(() => normalizePrefs({ wallet: 'W', picks: 'nope' }), StoreError);
  assert.throws(() => normalizePrefs({ wallet: 'W', picks: [{ pct: 50 }] }), StoreError);
});

/* ----------------------------------------------------------------- nonces */

test('a nonce is single-use and expires', async (t) => {
  const { store } = await freshStore(t);
  const soon = Date.now() + 600_000;

  await store.putNonce('WalletA', 'n1', soon);
  assert.equal(await store.takeNonce('WalletA', 'n1'), true);
  assert.equal(await store.takeNonce('WalletA', 'n1'), false, 'a nonce can only be spent once');

  await store.putNonce('WalletA', 'n2', new Date(Date.now() - 1000));
  assert.equal(await store.takeNonce('WalletA', 'n2'), false, 'expired');

  await store.putNonce('WalletA', 'n3', new Date(soon).toISOString());
  assert.equal(await store.takeNonce('WalletB', 'n3'), false, 'nonces are per wallet');
  assert.equal(await store.takeNonce('WalletA', 'n3'), true);

  assert.equal(await store.takeNonce('WalletA', 'never-issued'), false);
  await assert.rejects(() => store.putNonce('WalletA', 'n4', null), StoreError);
});

/* ----------------------------------------------------------------- rounds */

test('rounds round-trip: create / get / update / latest / unfinished', async (t) => {
  const { store } = await freshStore(t);
  assert.equal(await store.getRound('missing'), null);
  assert.equal(await store.latestRound(), null);
  assert.equal(await store.unfinishedRound(), null);

  const created = await store.createRound(roundFor('r_2026-09-07T12', { createdAt: '2026-09-07T12:00:00.000Z' }));
  assert.equal(created.id, 'r_2026-09-07T12');
  assert.equal(created.status, 'PENDING');
  assert.deepEqual(created.transfers, []);

  await assert.rejects(
    () => store.createRound(roundFor('r_2026-09-07T12')),
    (err) => err instanceof StoreError && err.code === 'round_exists',
  );

  const unfinished = await store.unfinishedRound();
  assert.equal(unfinished.id, 'r_2026-09-07T12');

  const patched = await store.updateRound('r_2026-09-07T12', {
    status: 'SNAPSHOT',
    snapshot: { takenAt: '2026-09-07T12:03:00.000Z', hash: 'abc', holders: [{ wallet: 'W1', balance: '5' }] },
    stats: { eligibleHolders: 1 },
  });
  assert.equal(patched.status, 'SNAPSHOT');
  assert.equal(patched.snapshot.holders.length, 1);
  assert.equal(patched.poolLamports, '10000000000', 'untouched fields survive a patch');
  assert.equal(typeof patched.updatedAt, 'string');

  await store.updateRound('r_2026-09-07T12', { status: 'DONE', finishedAt: '2026-09-07T12:30:00.000Z' });
  assert.equal(await store.unfinishedRound(), null, 'DONE rounds are not resumable');

  await assert.rejects(
    () => store.updateRound('nope', { status: 'DONE' }),
    (err) => err.code === 'round_not_found',
  );

  await store.createRound(roundFor('r_2026-09-07T18', { createdAt: '2026-09-07T18:00:00.000Z', status: 'SWAPPING' }));
  const latest = await store.latestRound();
  assert.equal(latest.id, 'r_2026-09-07T18');
  assert.equal((await store.unfinishedRound()).id, 'r_2026-09-07T18');
});

test('bigints and Dates are stored as strings', async (t) => {
  const { store } = await freshStore(t);
  await store.createRound(roundFor('r_big', { poolLamports: 12_345_678_901n, startedAt: new Date('2026-09-07T12:00:00Z') }));
  const round = await store.getRound('r_big');
  assert.equal(round.poolLamports, '12345678901');
  assert.equal(round.startedAt, '2026-09-07T12:00:00.000Z');
  assert.equal(jsonSafe({ a: 1n, b: new Date('2026-01-01T00:00:00Z'), c: undefined }).a, '1');
});

test('listRounds paginates newest first and omits the heavy fields', async (t) => {
  const { store } = await freshStore(t);
  for (let i = 1; i <= 7; i++) {
    await store.createRound(
      roundFor(`r_${String(i).padStart(4, '0')}`, {
        createdAt: new Date(Date.UTC(2026, 8, 7, i)).toISOString(),
        status: i === 7 ? 'PENDING' : 'DONE',
        universe: Array.from({ length: 20 }, (_, n) => ({ mint: `M${n}`, symbol: `S${n}`, rank: n + 1 })),
        snapshot: { takenAt: '2026-09-07T12:00:00.000Z', hash: `h${i}`, holders: [{ wallet: 'W1', balance: '5' }, { wallet: 'W2', balance: '6' }] },
        transfers: [{ wallet: 'W1', mint: 'M0', amountRaw: '10', status: 'DONE' }],
        stats: { transfersDone: 1 },
      }),
    );
  }

  const all = await store.listRounds({});
  assert.equal(all.total, 7);
  assert.deepEqual(all.items.map((r) => r.id), ['r_0007', 'r_0006', 'r_0005', 'r_0004', 'r_0003', 'r_0002', 'r_0001']);

  const page = await store.listRounds({ limit: 3, offset: 3 });
  assert.equal(page.total, 7);
  assert.deepEqual(page.items.map((r) => r.id), ['r_0004', 'r_0003', 'r_0002']);

  const tail = await store.listRounds({ limit: 3, offset: 6 });
  assert.deepEqual(tail.items.map((r) => r.id), ['r_0001']);
  assert.deepEqual((await store.listRounds({ limit: 3, offset: 99 })).items, []);

  const item = page.items[0];
  assert.equal(item.transfers, undefined, 'no transfers array in the list');
  assert.equal(item.universe, undefined, 'no 20-stock universe in the list');
  assert.equal(item.transferCount, 1);
  assert.equal(item.universeSize, 20);
  assert.equal(item.snapshot.holders, undefined);
  assert.equal(item.snapshot.holderCount, 2);
  assert.equal(item.snapshot.hash, 'h4');
  assert.deepEqual(item.stats, { transfersDone: 1 });
  assert.equal(item.poolLamports, '10000000000');

  // the full document still has everything
  const full = await store.getRound('r_0004');
  assert.equal(full.transfers.length, 1);
  assert.equal(full.universe.length, 20);
  assert.equal(full.snapshot.holders.length, 2);
});

/* -------------------------------------------------------------- transfers */

test('markTransfer is idempotent and never downgrades a DONE row', async (t) => {
  const { store } = await freshStore(t);
  await store.createRound(roundFor('r_x'));

  const first = await store.markTransfer('r_x', 'W1', 'M1', { symbol: 'NVDAx', amountRaw: '1500', status: 'PENDING' });
  assert.equal(first.wallet, 'W1');
  assert.equal(first.mint, 'M1');
  assert.equal(first.amountRaw, '1500');
  assert.equal(first.status, 'PENDING');
  assert.equal(first.tx, null);

  // same call again -> still exactly one row
  await store.markTransfer('r_x', 'W1', 'M1', { symbol: 'NVDAx', amountRaw: '1500', status: 'PENDING' });
  assert.equal((await store.getRound('r_x')).transfers.length, 1);

  await store.markTransfer('r_x', 'W1', 'M1', { status: 'DONE', tx: 'sig111' });
  let round = await store.getRound('r_x');
  assert.equal(round.transfers.length, 1);
  assert.equal(round.transfers[0].status, 'DONE');
  assert.equal(round.transfers[0].tx, 'sig111');
  assert.equal(round.transfers[0].amountRaw, '1500');

  // a re-run of the distributor must not resend or lose the signature
  await store.markTransfer('r_x', 'W1', 'M1', { status: 'PENDING', tx: null });
  round = await store.getRound('r_x');
  assert.equal(round.transfers[0].status, 'DONE');
  assert.equal(round.transfers[0].tx, 'sig111');

  // a different mint for the same wallet is a different row
  await store.markTransfer('r_x', 'W1', 'M2', { amountRaw: '7', status: 'SKIPPED_DUST' });
  round = await store.getRound('r_x');
  assert.equal(round.transfers.length, 2);

  await assert.rejects(
    () => store.markTransfer('missing', 'W1', 'M1', { status: 'DONE' }),
    (err) => err.code === 'round_not_found',
  );
});

test('updateRound upserts transfers with the same DONE guard', async (t) => {
  const { store } = await freshStore(t);
  await store.createRound(roundFor('r_u', { transfers: [{ wallet: 'W1', mint: 'M1', amountRaw: '100', status: 'PENDING' }] }));
  await store.markTransfer('r_u', 'W1', 'M1', { status: 'DONE', tx: 'sigAAA' });

  // the runner re-persists its planned transfer list after a crash
  await store.updateRound('r_u', {
    status: 'DISTRIBUTING',
    transfers: [
      { wallet: 'W1', mint: 'M1', amountRaw: '100', status: 'PENDING', tx: null },
      { wallet: 'W2', mint: 'M1', amountRaw: '250', status: 'PENDING', tx: null },
    ],
  });

  const round = await store.getRound('r_u');
  assert.equal(round.status, 'DISTRIBUTING');
  assert.equal(round.transfers.length, 2);
  const w1 = round.transfers.find((x) => x.wallet === 'W1');
  assert.equal(w1.status, 'DONE');
  assert.equal(w1.tx, 'sigAAA');
  const w2 = round.transfers.find((x) => x.wallet === 'W2');
  assert.equal(w2.status, 'PENDING');
  assert.equal(w2.amountRaw, '250');
});

/* --------------------------------------------------------------------- kv */

test('kv stores arbitrary json and returns copies', async (t) => {
  const { store } = await freshStore(t);
  assert.equal(await store.getKV('carry'), null);
  await store.setKV('carry', [{ mint: 'M1', amountRaw: 42n }]);
  const carry = await store.getKV('carry');
  assert.deepEqual(carry, [{ mint: 'M1', amountRaw: '42' }]);
  carry[0].amountRaw = 'mutated';
  assert.equal((await store.getKV('carry'))[0].amountRaw, '42');

  await store.setKV('universe', { updatedAt: '2026-09-07T12:00:00.000Z', stocks: [] });
  assert.equal((await store.getKV('universe')).stocks.length, 0);
  await store.setKV('carry', null);
  assert.equal(await store.getKV('carry'), null);
});

/* -------------------------------------------------- durability + concurrency */

test('everything survives a reopen', async (t) => {
  const dir = await tmpDir(t);
  const first = await openJsonStore({ dataDir: dir });
  await first.setPrefs(prefsFor('WalletA'));
  await first.putNonce('WalletA', 'n1', Date.now() + 600_000);
  await first.createRound(roundFor('r_persist'));
  await first.markTransfer('r_persist', 'W1', 'M1', { amountRaw: '5', status: 'DONE', tx: 'sigZ' });
  await first.setKV('carry', { mint: 'M1' });
  await first.close();

  const second = await openJsonStore({ dataDir: dir });
  t.after(() => second.close());
  assert.equal((await second.getPrefs('WalletA')).picks.length, 2);
  assert.equal(await second.takeNonce('WalletA', 'n1'), true);
  const round = await second.getRound('r_persist');
  assert.equal(round.transfers[0].tx, 'sigZ');
  assert.deepEqual(await second.getKV('carry'), { mint: 'M1' });
  assert.equal((await second.listRounds({})).total, 1);
});

test('listRounds still works when index.json is lost', async (t) => {
  const dir = await tmpDir(t);
  const first = await openJsonStore({ dataDir: dir });
  await first.createRound(roundFor('r_a', { createdAt: '2026-09-07T00:00:00.000Z' }));
  await first.createRound(roundFor('r_b', { createdAt: '2026-09-07T06:00:00.000Z' }));
  await first.close();
  await fs.rm(path.join(dir, 'index.json'));

  const second = await openJsonStore({ dataDir: dir });
  t.after(() => second.close());
  const { items, total } = await second.listRounds({});
  assert.equal(total, 2);
  assert.deepEqual(items.map((r) => r.id), ['r_b', 'r_a']);
});

test('concurrent writes from one process never lose or corrupt data', async (t) => {
  const dir = await tmpDir(t);
  const store = await openJsonStore({ dataDir: dir });
  t.after(() => store.close());
  await store.createRound(roundFor('r_conc'));

  await Promise.all([
    ...Array.from({ length: 60 }, (_, i) => store.setKV(`k${i}`, { i })),
    ...Array.from({ length: 60 }, (_, i) => store.setPrefs(prefsFor(`W${i}`))),
    ...Array.from({ length: 60 }, (_, i) => store.markTransfer('r_conc', `W${i}`, 'M1', { amountRaw: String(i), status: 'PENDING' })),
    // the same row hit twice at once must still produce one row
    ...Array.from({ length: 10 }, () => store.markTransfer('r_conc', 'DUP', 'M1', { amountRaw: '1', status: 'PENDING' })),
  ]);

  const round = await store.getRound('r_conc');
  assert.equal(round.transfers.length, 61, 'one row per (wallet, mint)');
  assert.equal((await store.listPrefs({ limit: 1000 })).total, 60);
  for (let i = 0; i < 60; i++) assert.deepEqual(await store.getKV(`k${i}`), { i });

  // the files on disk are valid json, not half-written
  const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'kv.json'), 'utf8'));
  assert.equal(Object.keys(onDisk).length, 60);
  const roundOnDisk = JSON.parse(await fs.readFile(path.join(dir, 'rounds', 'r_conc.json'), 'utf8'));
  assert.equal(roundOnDisk.transfers.length, 61);
  const leftovers = (await fs.readdir(dir)).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'no temp files left behind');
});

test('round ids with awkward characters get safe file names', async (t) => {
  const { store, dir } = await freshStore(t);
  await store.createRound(roundFor('r_2026-09-07T12:00/../x'));
  const round = await store.getRound('r_2026-09-07T12:00/../x');
  assert.equal(round.id, 'r_2026-09-07T12:00/../x');
  const files = await fs.readdir(path.join(dir, 'rounds'));
  assert.equal(files.length, 1);
  assert.equal(files[0].includes('/'), false);
  await assert.rejects(() => store.createRound(roundFor('..')), StoreError);
  await assert.rejects(() => store.createRound({ status: 'PENDING' }), StoreError);
});

test('a closed store refuses further work', async (t) => {
  const dir = await tmpDir(t);
  const store = await openJsonStore({ dataDir: dir });
  await store.setKV('a', 1);
  await store.close();
  await store.close(); // idempotent
  await assert.rejects(() => store.getKV('a'), (err) => err.code === 'store_closed');
});

/* -------------------------------------------------------------- summaries */

test('summarizeRound drops holders, transfers and the universe', () => {
  const summary = summarizeRound({
    id: 'r1',
    status: 'DONE',
    transfers: [{ wallet: 'W', mint: 'M' }],
    universe: [{ mint: 'M' }],
    snapshot: { hash: 'h', holders: [{ wallet: 'W', balance: '1' }] },
    stats: { transfersDone: 1 },
  });
  assert.deepEqual(summary, {
    id: 'r1',
    status: 'DONE',
    transferCount: 1,
    universeSize: 1,
    snapshot: { hash: 'h', holderCount: 1 },
    stats: { transfersDone: 1 },
  });
  assert.equal(summarizeRound(null), null);
  assert.equal(summarizeRound({ id: 'r2', snapshot: null }).snapshot, null);
});

/* --------------------------------------------------------------------- pg */

test('the pg store module loads and refuses to open without a url', async () => {
  const { openPgStore } = await import('../src/db/pg.js');
  assert.equal(typeof openPgStore, 'function');
  await assert.rejects(() => openPgStore({}), (err) => err.code === 'bad_argument');
});
