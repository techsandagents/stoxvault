#!/usr/bin/env node
/**
 * Full-pipeline rehearsal.
 *
 * Runs a complete round against REAL Jupiter quotes and the REAL top-20 ranking,
 * but with a synthetic holder set and a vault balance you choose. It is the way to
 * see exactly what a round will do before the coin exists or before flipping LIVE.
 *
 * It is hard-wired to DRY_RUN: the RPC it injects throws if anything tries to send
 * a transaction, so a regression that sends in dry-run mode fails loudly here.
 *
 *   node scripts/rehearse.mjs                 # 12 SOL pool, the default holder set
 *   node scripts/rehearse.mjs 40              # 40 SOL pool
 *   node scripts/rehearse.mjs 40 --json       # machine-readable
 *
 * Nothing it writes touches the real store: it uses ./data/rehearsal, wiped each run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const SRC = new URL('../src/', import.meta.url).href;

const args = process.argv.slice(2);
const json = args.includes('--json');
const poolSol = Number(args.find((a) => !a.startsWith('--')) || 12);
if (!Number.isFinite(poolSol) || poolSol <= 0) {
  console.error('usage: node scripts/rehearse.mjs [poolSol] [--json]');
  process.exit(1);
}

// A rehearsal must never touch live config: force dry-run, a fake mint, its own store.
process.env.LIVE = '0';
process.env.TOKEN_MINT = 'RehearseMint11111111111111111111111111111111';
process.env.TOKEN_SYMBOL = 'REHEARSE';
process.env.TOKEN_SUPPLY = process.env.TOKEN_SUPPLY || '1000000000';
process.env.TOKEN_DECIMALS = process.env.TOKEN_DECIMALS || '6';
process.env.DATA_DIR = './data/rehearsal';
process.env.START_KEEPER = '0';

// The rehearsal writes synthetic preferences and a fake round. That is fine in a
// throwaway file store and unacceptable in the real database, where it would put
// invented wallets into the public prefs list and a fake round into the public
// ledger. Postgres is therefore refused outright rather than silently isolated:
// on Railway, DATABASE_URL is set for the whole service, so a well-meaning
// `npm run rehearse` there would otherwise pollute production.
if (process.env.DATABASE_URL) {
  console.error('rehearse: DATABASE_URL is set, and this script writes synthetic prefs and a fake round.');
  console.error('          Refusing to touch a real database. Run it with DATABASE_URL unset:');
  console.error('');
  console.error('            DATABASE_URL= npm run rehearse -- 25');
  console.error('');
  process.exit(2);
}

const storeDir = path.join(serverRoot, 'data', 'rehearsal');
fs.rmSync(storeDir, { recursive: true, force: true });

const { CFG } = await import(SRC + 'config.js');
const { openDb } = await import(SRC + 'db/index.js');
const { createJupiter } = await import(SRC + 'chain/jupiter.js');
const { createUniverseService } = await import(SRC + 'services/universe.js');
const { runRound } = await import(SRC + 'keeper/runner.js');

const DEC = BigInt(10) ** BigInt(CFG.tokenDecimals);
const poolLamports = BigInt(Math.round(poolSol * 1e9));

/**
 * The cast. Balances are in whole tokens. On a 1B supply the 0.1% threshold is
 * 1,000,000, so `dust` is deliberately just under it and must receive nothing.
 */
const CAST = [
  { name: 'alice', wallet: 'A1iceRehearsa1Wa11et1111111111111111111111', tokens: 30_000_000, picks: [['TSLAx', 60], ['NVDAx', 40]] },
  { name: 'bob', wallet: 'Bob2Rehearsa1Wa11et22222222222222222222222', tokens: 10_000_000, picks: null },
  { name: 'carol', wallet: 'Caro13Rehearsa1Wa11et333333333333333333333', tokens: 5_000_000, picks: [['HOODx', 40], ['COINx', 30], ['MSTRx', 30]] },
  { name: 'dust', wallet: 'Dust4Rehearsa1Wa11et44444444444444444444444', tokens: 900_000, picks: null },
];

const db = await openDb(CFG);
const jup = createJupiter(CFG);
const universeService = createUniverseService({ cfg: CFG, db, jup });

const universe = await universeService.get({ force: true });
if (!universe.stocks.length) {
  console.error('no universe available (Jupiter unreachable and no seed)');
  process.exit(1);
}
const bySymbol = Object.fromEntries(universe.stocks.map((s) => [s.symbol, s]));

for (const person of CAST) {
  if (!person.picks) continue;
  const picks = person.picks.map(([symbol, pct]) => {
    const stock = bySymbol[symbol];
    if (!stock) throw new Error(`rehearsal pick ${symbol} is not in the current top ${CFG.universeSize}`);
    return { mint: stock.mint, symbol, pct };
  });
  await db.setPrefs({
    wallet: person.wallet,
    picks,
    signature: 'rehearsal',
    message: 'rehearsal',
    updatedAt: new Date().toISOString(),
  });
}

const holders = CAST.map((p) => ({ wallet: p.wallet, balance: String(BigInt(p.tokens) * DEC) }));

// The vault balance is forced; every write path throws so a stray send is caught.
const rpc = {
  getBalanceLamports: async () => poolLamports,
  getSlot: async () => 0,
  getTokenSupply: async () => ({ amount: String(CFG.supplyRaw ?? BigInt(CFG.tokenSupply) * DEC), decimals: CFG.tokenDecimals }),
  getMintInfo: async () => ({ decimals: CFG.tokenDecimals }),
  getTokenAccountBalanceRaw: async () => 0n,
  getLatestBlockhash: async () => { throw new Error('rehearsal: nothing may be built for sending'); },
  getSignatureStatuses: async () => ({ value: [null] }),
  sendRawTransaction: async () => { throw new Error('rehearsal: a transaction was sent in DRY_RUN'); },
};

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const round = await runRound({
  cfg: CFG,
  db,
  rpc,
  jup,
  dist: null,
  holdersService: async () => holders,
  universeService,
  logger: json ? quiet : { info: (m) => console.log(dim('  · ' + m)), warn: () => {}, error: console.error, debug: () => {} },
});

const stored = (await db.getRound(round.id)) || round;
const transfers = stored.transfers || round.transfers || [];

/* ------------------------------------------------------------------ report */

function dim(s) { return `\x1b[2m${s}\x1b[0m`; }
function bold(s) { return `\x1b[1m${s}\x1b[0m`; }
function sol(lamports) { return (Number(BigInt(lamports)) / 1e9).toFixed(4); }
function tok(raw, decimals = 8) { return (Number(BigInt(raw)) / 10 ** decimals).toFixed(6); }
const nameOf = Object.fromEntries(CAST.map((p) => [p.wallet, p.name]));

let routed = 0n;
let sentAnything = false;
for (const s of round.swaps) {
  routed += BigInt(s.solLamports);
  if (s.tx) sentAnything = true;
}
for (const t of transfers) if (t.tx) sentAnything = true;

const perStockSent = {};
for (const t of transfers) {
  if (t.status === 'SKIPPED_DUST') continue;
  perStockSent[t.mint] = (perStockSent[t.mint] || 0n) + BigInt(t.amountRaw);
}
let conserved = true;
const conservation = round.swaps.map((s) => {
  const received = BigInt(s.receivedRaw || '0');
  const sent = perStockSent[s.mint] || 0n;
  const carry = (round.carryOut || []).find((c) => c.mint === s.mint);
  const dust = carry ? BigInt(carry.amountRaw) : 0n;
  const delta = received - sent - dust;
  if (delta !== 0n) conserved = false;
  return { symbol: s.symbol, received: String(received), sent: String(sent), dust: String(dust), delta: String(delta) };
});

if (json) {
  console.log(JSON.stringify({
    round: { id: round.id, status: round.status, simulated: round.simulated, poolLamports: round.poolLamports, stats: round.stats },
    universe: universe.stocks.map((s) => s.symbol),
    swaps: round.swaps, transfers, conservation,
    checks: { nothingSent: !sentAnything, valueConserved: conserved, unroutedLamports: String(BigInt(round.poolLamports) - routed) },
  }, null, 2));
} else {
  console.log('');
  console.log(bold(`REHEARSAL  ${round.id}  ${round.status}${round.simulated ? '  (simulated)' : ''}`));
  console.log(dim(`  universe  ${universe.stocks.map((s) => s.symbol).join(' ')}`));
  console.log(`  pool ${sol(round.poolLamports)} SOL   reserve ${sol(round.reserveLamports)} SOL   eligible ${round.stats.eligibleHolders} of ${CAST.length} wallets`);
  console.log(`  ${round.stats.prefHolders} with saved picks, ${round.stats.defaultHolders} on the default basket`);

  console.log('\n  ' + bold('SWAPS') + dim('  (one per stock, real Jupiter quotes)'));
  for (const s of round.swaps) {
    console.log(`    ${s.symbol.padEnd(7)} ${sol(s.solLamports).padStart(9)} SOL  ->  ${tok(s.receivedRaw || '0').padStart(12)}  ${s.status}`);
  }
  console.log(dim(`    routed ${sol(routed)} of ${sol(round.poolLamports)} SOL, ${(BigInt(round.poolLamports) - routed).toString()} lamports left unrouted (rounding, stays in the vault)`));

  console.log('\n  ' + bold('TRANSFERS'));
  for (const t of transfers) {
    console.log(`    ${(nameOf[t.wallet] || t.wallet.slice(0, 8)).padEnd(7)} ${t.symbol.padEnd(7)} ${tok(t.amountRaw).padStart(12)}  ${t.status}`);
  }
  const paid = new Set(transfers.filter((t) => t.status !== 'SKIPPED_DUST').map((t) => t.wallet));
  for (const p of CAST) if (!paid.has(p.wallet)) console.log(dim(`    ${p.name.padEnd(7)} — nothing (below the ${CFG.rules.eligibleBps / 100}% threshold)`));

  console.log('\n  ' + bold('CHECKS'));
  for (const c of conservation) {
    console.log(`    ${c.symbol.padEnd(7)} received ${tok(c.received).padStart(12)} = sent ${tok(c.sent).padStart(12)} + dust ${tok(c.dust).padStart(10)}  ${c.delta === '0' ? 'ok' : 'MISMATCH ' + c.delta}`);
  }
  console.log('');
  console.log(`    value conserved on every stock ... ${conserved ? 'PASS' : 'FAIL'}`);
  console.log(`    nothing sent on chain .......... ${!sentAnything ? 'PASS' : 'FAIL'}`);
  console.log('');
}

await db.close?.();
process.exit(conserved && !sentAnything ? 0 : 1);
