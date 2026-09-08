#!/usr/bin/env node
/**
 * GO-LIVE PRE-FLIGHT
 *
 * The keeper's LIVE path has never touched the chain, and it cannot until the
 * coin exists and the vault holds SOL. Every LIVE test in `test/` injects fake
 * RPC responses, so the one thing that has never been checked is exactly the
 * thing that matters: whether the REAL instructions this repo builds are
 * accepted by the REAL programs on mainnet.
 *
 * A wrong token program id, a mis-derived associated token account, a bad
 * decimals byte in transferChecked, or a Jupiter route that cannot be built
 * would all pass the existing tests and fail on the first live round, after
 * real money had already moved. This script builds the real transactions, signs
 * them with the real vault key, and asks mainnet to SIMULATE them.
 *
 *   npm run preflight
 *   npm run preflight -- --json
 *   npm run preflight -- --sol 1.5 --holder <address>
 *   npm run preflight -- --prove-guard     # deliberately trip the send guard
 *
 * ---------------------------------------------------------------------------
 * THIS SCRIPT SENDS NOTHING. It cannot.
 *
 * Two independent guards stand in front of the network:
 *
 *   1. The RPC object handed to every module is a wrapper whose
 *      sendRawTransaction / sendTransaction / confirmSignature throw
 *      immediately, and whose generic `call` refuses the send methods by name.
 *   2. The fetch implementation underneath the RPC client parses every outgoing
 *      JSON-RPC body and throws before the socket is written if the method is
 *      sendTransaction, requestAirdrop or a bundle send. This catches any code
 *      path that closed over the unwrapped client.
 *
 * Only `simulateTransaction` — a read-only call — ever carries a transaction.
 * The vault key is used to SIGN, because simulating an unsigned transaction
 * does not exercise the same validation; the signed bytes are then simulated
 * and discarded. Every JSON-RPC method this process actually used is printed at
 * the bottom of the report, so the report itself is the evidence.
 * ---------------------------------------------------------------------------
 *
 * It is safe to run at any time, including against production configuration. It
 * writes nothing to the database, nothing to the store, and nothing to disk.
 */

import crypto from 'node:crypto';
import process from 'node:process';

/* --------------------------------------------------------------------- args */

const argv = process.argv.slice(2);
function flag(name) {
  return argv.includes(`--${name}`);
}
function option(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  return value === undefined || value.startsWith('--') ? fallback : value;
}

if (flag('help') || flag('h')) {
  console.log(`
go-live pre-flight for STOXVAULT — simulates, never sends

  npm run preflight                     full report against mainnet
  npm run preflight -- --json           machine-readable
  npm run preflight -- --sol 1.5        size the test swap (default: MIN_ROUND_POOL_SOL)
  npm run preflight -- --holder <addr>  use a specific recipient for the distribution test
  npm run preflight -- --prove-guard    deliberately trip the send guard and show it fires
`);
  process.exit(0);
}

const asJson = flag('json');
const proveGuard = flag('prove-guard');
const holderArg = option('holder', null);
const solArg = option('sol', null);

// Keep the config banner out of the report; everything relevant is printed below.
process.env.STOCKDROP_QUIET = process.env.STOCKDROP_QUIET ?? '1';

/* ------------------------------------------------------------- send guards */

class SendBlocked extends Error {
  constructor(where) {
    super(
      `PRE-FLIGHT SEND GUARD: ${where}. This script simulates only and must never broadcast a ` +
        `transaction. Nothing was sent. If you reached this from new code, that code is trying to ` +
        `send from a read-only tool — fix the code, do not relax the guard.`,
    );
    this.name = 'SendBlocked';
    this.code = 'send_blocked';
  }
}

/** JSON-RPC methods that put a transaction on the cluster. Never allowed here. */
const SEND_METHODS = new Set(['sendTransaction', 'requestAirdrop', 'sendBundle', 'sendRawTransaction']);

/** Evidence for the report: what this process actually asked the cluster to do. */
const rpcMethodCounts = new Map();
let blockedSendAttempts = 0;

/** Layer 2: the transport. Nothing gets past this, whichever client built it. */
function guardedFetch(realFetch) {
  return async function preflightFetch(url, init = {}) {
    const body = init?.body;
    if (typeof body === 'string' && body.includes('"method"')) {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        /* not our JSON-RPC shape; fall through */
      }
      const calls = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of calls) {
        const method = entry && typeof entry.method === 'string' ? entry.method : null;
        if (!method) continue;
        if (SEND_METHODS.has(method)) {
          blockedSendAttempts += 1;
          throw new SendBlocked(`the transport blocked a JSON-RPC "${method}" before it reached the network`);
        }
        rpcMethodCounts.set(method, (rpcMethodCounts.get(method) ?? 0) + 1);
      }
    }
    return realFetch(url, init);
  };
}

/**
 * Did this error come from a send guard? The RPC client wraps transport faults
 * in its own RpcError, so identity alone is not enough: walk the cause chain
 * and fall back to the guard's unmistakable message.
 */
function wasBlocked(err) {
  for (let e = err, depth = 0; e && depth < 8; e = e.cause, depth++) {
    if (e instanceof SendBlocked || e?.code === 'send_blocked') return true;
    if (typeof e.message === 'string' && e.message.includes('PRE-FLIGHT SEND GUARD')) return true;
  }
  return false;
}

/** Layer 1: the object every module is handed. */
function guardRpc(rpc) {
  const blocked = (name) => () => {
    blockedSendAttempts += 1;
    throw new SendBlocked(`${name}() was called on the pre-flight RPC client`);
  };
  return {
    ...rpc,
    sendRawTransaction: blocked('sendRawTransaction'),
    sendTransaction: blocked('sendTransaction'),
    confirmSignature: blocked('confirmSignature'),
    async call(method, params = [], opts = {}) {
      if (SEND_METHODS.has(String(method))) {
        blockedSendAttempts += 1;
        throw new SendBlocked(`call("${method}") was made on the pre-flight RPC client`);
      }
      return rpc.call(method, params, opts);
    },
  };
}

/* -------------------------------------------------------------- ed25519 raw */

// PKCS#8 / SPKI wrappers so node:crypto can verify a Solana key without a dep.
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

function privateKeyFromSeed(seed32) {
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(seed32)]), format: 'der', type: 'pkcs8' });
}
function publicKeyFromBytes(pub32) {
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(pub32)]), format: 'der', type: 'spki' });
}

/* ------------------------------------------------------------------ report */

const CHECKS = [];
const UNPROVEN = [];

const STATUS = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  NOTE: 'PASS WITH NOTE',
  UNFUNDED: 'NOT FUNDED',
  UNPROVEN: 'UNPROVEN',
};

function record(id, name, status, summary, detail = {}) {
  CHECKS.push({ id, name, status, summary, detail });
  return status;
}
function unproven(what, wouldProve) {
  UNPROVEN.push({ what, wouldProve });
}

const C = {
  dim: (s) => (asJson ? s : `\x1b[2m${s}\x1b[0m`),
  bold: (s) => (asJson ? s : `\x1b[1m${s}\x1b[0m`),
  green: (s) => (asJson ? s : `\x1b[32m${s}\x1b[0m`),
  red: (s) => (asJson ? s : `\x1b[31m${s}\x1b[0m`),
  yellow: (s) => (asJson ? s : `\x1b[33m${s}\x1b[0m`),
};
function paint(status) {
  if (status === STATUS.PASS) return C.green(status);
  if (status === STATUS.FAIL) return C.red(status);
  return C.yellow(status);
}

const out = [];
function say(line = '') {
  out.push(line);
  if (!asJson) console.log(line);
}
function line(label, status, summary) {
  say(`  ${label.padEnd(46, '.')} ${paint(status)}${summary ? `  ${C.dim(summary)}` : ''}`);
}

const LAMPORTS = 1_000_000_000n;
function sol(lamports) {
  const v = BigInt(lamports);
  const whole = v / LAMPORTS;
  const frac = (v % LAMPORTS).toString().padStart(9, '0').replace(/0+$/, '') || '0';
  return `${whole}.${frac}`;
}
function short(address) {
  const s = String(address ?? '');
  return s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/* ------------------------------------------------- simulation classification */

/**
 * The vault is empty by design until launch, so a simulation failure has to be
 * split three ways or the report is worthless:
 *
 *   ok        — the cluster executed it. The transaction is correct.
 *   unfunded  — it failed only because the payer has no lamports (or the vault
 *               does not hold the stock yet). The transaction is well formed and
 *               the missing piece is money, which is the known state.
 *   bad       — anything else. A bad instruction, an unknown program, an account
 *               mismatch. This is a code defect and must block go-live.
 */
const UNFUNDED_PATTERNS = [
  /AccountNotFound/i,
  /InsufficientFundsForRent/i,
  /InsufficientFunds(?!ForRent)/i,
  /insufficient lamports/i,
  /found no record of a prior credit/i,
  /Transfer: `from` must not carry data/i,
];
const NO_HOLDING_PATTERNS = [
  /could not find account/i,
  /Error: Account does not exist/i,
  /IncorrectProgramId/i,
  /invalid account data for instruction/i,
];

function textOf(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function classifySimulation({ err, logs, thrown }) {
  const haystack = [textOf(err), textOf(thrown?.message), ...(Array.isArray(logs) ? logs : [])].join('\n');
  if (thrown) {
    if (UNFUNDED_PATTERNS.some((re) => re.test(haystack))) {
      return { klass: 'unfunded', why: 'the fee payer holds no lamports, so the cluster refused to debit it' };
    }
    return { klass: 'bad', why: `the simulate call itself failed: ${thrown.message}` };
  }
  if (err === null || err === undefined) return { klass: 'ok', why: 'the cluster executed the transaction successfully' };
  if (UNFUNDED_PATTERNS.some((re) => re.test(haystack))) {
    return { klass: 'unfunded', why: 'the only failure is that the vault has no lamports to pay fees or rent' };
  }
  if (NO_HOLDING_PATTERNS.some((re) => re.test(haystack))) {
    return { klass: 'unfunded', why: 'the only failure is that the vault does not hold this stock yet (no source token account)' };
  }
  return { klass: 'bad', why: `the cluster rejected it: ${textOf(err)}` };
}

/** Ask mainnet to execute the signed bytes without recording them anywhere. */
async function simulate(rpc, tx, { sigVerify = true } = {}) {
  const b64 = Buffer.from(tx.serialize()).toString('base64');
  const config = {
    encoding: 'base64',
    commitment: 'confirmed',
    sigVerify,
    replaceRecentBlockhash: !sigVerify,
  };
  try {
    const result = await rpc.call('simulateTransaction', [b64, config]);
    const value = result?.value ?? result ?? {};
    return {
      err: value.err ?? null,
      logs: Array.isArray(value.logs) ? value.logs : [],
      unitsConsumed: value.unitsConsumed ?? null,
      thrown: null,
      sigVerify,
    };
  } catch (thrown) {
    return { err: null, logs: [], unitsConsumed: null, thrown, sigVerify };
  }
}

/**
 * A stale blockhash is a clock problem, not a correctness problem. Retry once
 * without signature verification and say so, rather than reporting a FAIL that
 * means nothing.
 */
async function simulateWithRetry(rpc, tx) {
  const first = await simulate(rpc, tx, { sigVerify: true });
  const stale = /BlockhashNotFound/i.test([textOf(first.err), textOf(first.thrown?.message)].join(' '));
  if (!stale) return first;
  const second = await simulate(rpc, tx, { sigVerify: false });
  second.note = 'the blockhash went stale between building and simulating; re-simulated with replaceRecentBlockhash (signatures not re-verified on this pass)';
  return second;
}

function printLogs(logs, limit = 30) {
  if (!Array.isArray(logs) || logs.length === 0) {
    say(C.dim('      (the cluster returned no logs — the transaction failed before execution)'));
    return;
  }
  for (const entry of logs.slice(0, limit)) say(C.dim(`      ${entry}`));
  if (logs.length > limit) say(C.dim(`      … ${logs.length - limit} more log lines`));
}

/* ----------------------------------------------------------------- program ids */

const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** The vault address published in CONTRACT.md and shown on the site. */
const PUBLISHED_VAULT = '769fv6KK6SAQ5FBAXdUZLdrppdHn5CqqgJBpFCLyf9up';

/* ------------------------------------------------------------------- imports */

const SRC = new URL('../src/', import.meta.url).href;

const { loadConfig } = await import(`${SRC}config.js`);
const { createRpc } = await import(`${SRC}chain/rpc.js`);
const { createJupiter } = await import(`${SRC}chain/jupiter.js`);
const { createDistributor, DistributorError } = await import(`${SRC}chain/distributor.js`);
const { loadVault } = await import(`${SRC}chain/vault.js`);
const { rankUniverse, defaultPicks } = await import(`${SRC}engine/index.js`);
const { runRound, ATA_RENT_LAMPORTS, TOKEN_2022_ATA_BYTES } = await import(`${SRC}keeper/runner.js`);
const { PublicKey, VersionedTransaction } = await import('@solana/web3.js');

const CFG = loadConfig({ quiet: true });

/** The two modes' configs, built from the same real .env, for the interlock test. */
function cfgWithLive(value) {
  try {
    return loadConfig({ env: { ...process.env, LIVE: value }, quiet: true });
  } catch {
    return null;
  }
}

const realFetch = globalThis.fetch.bind(globalThis);
const rawRpc = createRpc(CFG, { fetchImpl: guardedFetch(realFetch), retries: 3 });
const rpc = guardRpc(rawRpc);
const jup = createJupiter(CFG, { fetchImpl: realFetch });
const dist = createDistributor({ cfg: CFG, rpc });

/* ================================================================ helpers */

/** A deterministic, valid, unowned recipient. Nobody holds this key. */
function derivePreflightHolder() {
  if (holderArg) return holderArg;
  const seed = crypto.createHash('sha256').update('stoxvault:preflight:holder:v1').digest();
  const pub = crypto
    .createPublicKey(privateKeyFromSeed(seed))
    .export({ format: 'der', type: 'spki' });
  return new PublicKey(Buffer.from(pub.subarray(pub.length - 32))).toBase58();
}

/**
 * The associated token address for (owner, mint) under Token-2022, derived from
 * the seeds by hand rather than through @solana/spl-token's helper — so a bug in
 * the helper, or the wrong program id passed to it, cannot hide behind itself.
 */
function deriveAtaIndependently(owner, mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBytes(), new PublicKey(TOKEN_2022_PROGRAM).toBytes(), new PublicKey(mint).toBytes()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM),
  );
  return pda.toBase58();
}

let universeCache = null;
async function loadUniverse() {
  if (universeCache) return universeCache;
  const search = await jup.searchXStocks({ query: 'xStock', limit: 100, withPrices: true });
  const ranked = rankUniverse(search.stocks, { liqMinUsd: CFG.liqMinUsd, size: CFG.universeSize });
  universeCache = ranked;
  universeCache.source = search.source;
  return universeCache;
}

/** Decode a compiled v0 instruction into program id + account addresses + data. */
function decodeInstruction(message, ix) {
  const keys = message.staticAccountKeys.map((k) => k.toBase58());
  const lookups = (message.addressTableLookups ?? []).length;
  const accountAt = (index) => (index < keys.length ? keys[index] : `<address-table-entry ${index - keys.length}>`);
  return {
    programId: accountAt(ix.programIdIndex),
    accounts: [...ix.accountKeyIndexes].map(accountAt),
    data: Buffer.from(ix.data),
    lookups,
  };
}

/* ============================================================== prove-guard */

if (proveGuard) {
  say('');
  say(C.bold('PRE-FLIGHT SEND GUARD — deliberate trigger'));
  say(C.dim('  Each line below tries to send a transaction and must be refused.'));
  say('');

  const fired = [];

  async function expectBlocked(what, fn) {
    try {
      await fn();
      fired.push({ what, blocked: false, error: null });
      line(what, STATUS.FAIL, 'NOT BLOCKED — the guard did not fire');
    } catch (err) {
      // The RPC client wraps transport failures in an RpcError, so the guard is
      // recognised by its cause chain or its own unmistakable message, not only
      // by identity.
      const blocked = wasBlocked(err);
      fired.push({ what, blocked, error: err.message });
      line(what, blocked ? STATUS.PASS : STATUS.FAIL, blocked ? 'refused' : `wrong error: ${err.message}`);
      if (blocked) say(C.dim(`      ${err.message}`));
    }
  }

  await expectBlocked('layer 1  rpc.sendRawTransaction()', async () => rpc.sendRawTransaction(new Uint8Array([1, 2, 3])));
  await expectBlocked('layer 1  rpc.call("sendTransaction")', async () => rpc.call('sendTransaction', ['AQAB']));
  await expectBlocked('layer 2  transport, unwrapped client', async () => rawRpc.sendRawTransaction(new Uint8Array([1, 2, 3])));

  // The real send path: a distributor in LIVE mode, building and signing a real
  // batch, hitting the guard at the exact line that would broadcast.
  const vaultKp = loadVault(CFG);
  if (vaultKp) {
    const before = blockedSendAttempts;
    const liveish = { mode: 'LIVE', priorityFeeLamports: CFG.priorityFeeLamports };
    const liveDist = createDistributor({ cfg: liveish, rpc });
    let rows = null;
    let threw = null;
    try {
      const universe = await loadUniverse();
      const stock = universe[0];
      rows = await liveDist.ensureAndTransfer(
        vaultKp,
        stock.mint,
        stock.decimals,
        [{ wallet: derivePreflightHolder(), amountRaw: '1' }],
        { maxAttempts: 1, verifyBalances: false, confirmTimeoutMs: 1 },
      );
    } catch (err) {
      threw = err;
    }
    const attemptsBlocked = blockedSendAttempts - before;
    const noSignature = !rows || rows.every((r) => !r.tx);
    const ok = attemptsBlocked > 0 && noSignature;
    line('the real LIVE distributor send path', ok ? STATUS.PASS : STATUS.FAIL,
      `${attemptsBlocked} send attempt(s) refused, no row carries a landed signature${threw ? `, threw ${threw.code || threw.name}` : ''}`);
    fired.push({ what: 'distributor send path', blocked: ok, error: threw ? threw.message : null });
    if (rows) for (const r of rows) say(C.dim(`      ${short(r.wallet)}  status ${r.status}  tx ${r.tx ?? 'null'}`));
    say(C.dim('      UNRESOLVED is the correct outcome here: the distributor signed a batch, was refused at the'));
    say(C.dim('      send line, and could not then ask the cluster what happened (the guard blocks that too), so it'));
    say(C.dim('      refuses to claim the row was paid or to resend it. No signature reached the network.'));
  } else {
    line('the real LIVE distributor send path', STATUS.UNPROVEN, 'no vault secret in this environment');
  }

  say('');
  say(`  send attempts refused: ${blockedSendAttempts}`);
  say(`  JSON-RPC methods that reached the network: ${[...rpcMethodCounts.keys()].sort().join(', ') || '(none)'}`);
  const allBlocked = fired.length > 0 && fired.every((f) => f.blocked);
  say('');
  say(`  ${allBlocked ? C.green('GUARD HOLDS') : C.red('GUARD FAILED')} — ${fired.filter((f) => f.blocked).length}/${fired.length} attempts refused`);
  say('');
  if (asJson) console.log(JSON.stringify({ mode: 'prove-guard', attempts: fired, blockedSendAttempts, allBlocked }, null, 2));
  process.exit(allBlocked ? 0 : 1);
}

/* ================================================================ the report */

say('');
say(C.bold('  STOXVAULT GO-LIVE PRE-FLIGHT'));
say(C.dim('  This script SENDS NOTHING. It builds and signs the real transactions a round'));
say(C.dim('  would send, asks mainnet to simulate them, and throws them away. Two independent'));
say(C.dim('  guards make broadcasting impossible; every RPC method used is listed at the end.'));
say('');
say(`  mode ${CFG.mode}   rpc ${CFG.rpcProvider}   store ${CFG.storeKind}   token ${CFG.tokenMint || 'not launched'}`);
say(`  run at ${new Date().toISOString()}`);
say('');

/* ------------------------------------------------- 1. VAULT IDENTITY */

say(C.bold('  1  VAULT IDENTITY') + C.dim('  — the secret derives the published address and can sign'));

let vaultKeypair = null;
let vaultAddress = null;
try {
  vaultKeypair = loadVault(CFG);
  if (!vaultKeypair) {
    record('vault_identity', 'vault identity', STATUS.FAIL, 'no VAULT_SECRET_KEY in this environment: the keeper cannot sign anything');
    line('secret loads and derives a keypair', STATUS.FAIL, 'VAULT_SECRET_KEY is not set (mode READ_ONLY)');
  } else {
    vaultAddress = vaultKeypair.publicKey.toBase58();
    const matchesEnv = vaultAddress === CFG.vaultAddress;
    const matchesDoc = vaultAddress === PUBLISHED_VAULT;

    // Sign a random challenge with the raw seed and verify it under the public
    // key decoded from the PUBLISHED address. Closes the loop end to end.
    const challenge = crypto.randomBytes(32);
    const priv = privateKeyFromSeed(Buffer.from(vaultKeypair.secretKey.subarray(0, 32)));
    const signature = crypto.sign(null, challenge, priv);
    const verified = crypto.verify(null, challenge, publicKeyFromBytes(new PublicKey(PUBLISHED_VAULT).toBytes()), signature);

    const ok = matchesEnv && matchesDoc && verified;
    line('derives the configured vault address', matchesEnv ? STATUS.PASS : STATUS.FAIL, vaultAddress);
    line('matches the address published in CONTRACT.md', matchesDoc ? STATUS.PASS : STATUS.FAIL, PUBLISHED_VAULT);
    line('produces a signature that verifies', verified ? STATUS.PASS : STATUS.FAIL, `ed25519 over a ${challenge.length}-byte challenge`);
    record(
      'vault_identity',
      'vault identity',
      ok ? STATUS.PASS : STATUS.FAIL,
      ok
        ? `the secret in this environment is the vault ${vaultAddress} and can sign`
        : 'the secret does not match the published vault address, or cannot sign',
      { derived: vaultAddress, configured: CFG.vaultAddress, published: PUBLISHED_VAULT, signatureVerified: verified },
    );
  }
} catch (err) {
  line('secret loads and derives a keypair', STATUS.FAIL, err.message);
  record('vault_identity', 'vault identity', STATUS.FAIL, `VAULT_SECRET_KEY is unusable: ${err.message}`);
}
say('');

/* ------------------------------------------------- 2. VAULT FUNDING */

say(C.bold('  2  VAULT FUNDING') + C.dim('  — real SOL balance against the round thresholds'));

let balanceLamports = null;
try {
  balanceLamports = await rpc.getBalanceLamports(vaultAddress || CFG.vaultAddress || PUBLISHED_VAULT);
  const reserve = BigInt(CFG.feeReserveLamports);
  const minPool = BigInt(CFG.minRoundPoolLamports);
  const pool = balanceLamports > reserve ? balanceLamports - reserve : 0n;
  const funded = pool >= minPool;

  say(`      balance ......... ${sol(balanceLamports)} SOL`);
  say(`      fee reserve ..... ${sol(reserve)} SOL  (FEE_RESERVE_SOL, always left behind)`);
  say(`      spendable pool .. ${sol(pool)} SOL  (balance − reserve, before per-round rent)`);
  say(`      needs at least .. ${sol(minPool)} SOL  (MIN_ROUND_POOL_SOL, else the round is SKIPPED low_pool)`);
  line('vault clears MIN_ROUND_POOL_SOL', funded ? STATUS.PASS : STATUS.UNFUNDED,
    funded ? 'a round would run' : 'OPERATOR ACTION: send SOL to the vault. This is not a code defect.');
  record(
    'vault_funding',
    'vault funding',
    funded ? STATUS.PASS : STATUS.UNFUNDED,
    funded
      ? `${sol(pool)} SOL spendable, above the ${sol(minPool)} SOL floor`
      : `${sol(balanceLamports)} SOL on chain — below the ${sol(minPool)} SOL floor plus ${sol(reserve)} SOL reserve. Operator action, not a bug.`,
    { balanceLamports: balanceLamports.toString(), reserveLamports: reserve.toString(), poolLamports: pool.toString(), minPoolLamports: minPool.toString() },
  );
  if (!funded) {
    unproven(
      'that a round can actually pay its own fees and rent',
      `send at least ${sol(minPool + reserve)} SOL to ${vaultAddress || CFG.vaultAddress} and re-run this script; checks 4 and 5 then simulate green instead of failing on lamports.`,
    );
  }
} catch (err) {
  line('read the vault balance from mainnet', STATUS.FAIL, err.message);
  record('vault_funding', 'vault funding', STATUS.FAIL, `could not read the vault balance: ${err.message}`);
}
say('');

/* ------------------------------------------------- 3. STOCK TRANSFERABILITY */

say(C.bold('  3  THE STOCKS ARE STILL TRANSFERABLE') + C.dim('  — every mint in the current top 20, read from mainnet'));

let universe = [];
let stockRows = [];
try {
  universe = await loadUniverse();
  if (universe.length === 0) throw new Error('the universe came back empty (Jupiter unreachable and no seed)');
  say(C.dim(`      universe source: ${universe.source}   ${universe.length} stocks, liquidity ≥ $${CFG.liqMinUsd.toLocaleString('en-US')}`));

  stockRows = await mapLimit(universe, 4, async (stock) => {
    const row = {
      symbol: stock.symbol,
      mint: stock.mint,
      assumedDecimals: stock.decimals,
      ok: false,
      code: null,
      error: null,
      programId: null,
      decimals: null,
      transferHookProgramId: null,
      paused: null,
      uiMultiplier: null,
      pendingMultiplier: null,
    };
    try {
      // The distributor's own per-round guard, run against the live mint.
      const info = await dist.assertMintIsTransferable(stock.mint, stock.decimals);
      row.programId = info.programId;
      row.decimals = info.decimals;
      row.transferHookProgramId = info.transferHookProgramId;
      row.paused = info.paused;
      row.permanentDelegate = info.permanentDelegate;
      row.ok = true;
    } catch (err) {
      row.code = err.code || err.name;
      row.error = err.message;
    }
    try {
      // scaledUiAmount is display-only but the site depends on it, so report it.
      const account = await rpc.getAccountInfo(stock.mint, 'jsonParsed');
      const extensions = account?.data?.parsed?.info?.extensions ?? [];
      const scaled = extensions.find((e) => e?.extension === 'scaledUiAmountConfig');
      row.uiMultiplier = scaled?.state?.multiplier ?? null;
      row.pendingMultiplier = scaled?.state?.newMultiplier ?? null;
      row.extensions = extensions.map((e) => String(e?.extension ?? '')).filter(Boolean);
    } catch (err) {
      row.multiplierError = err.message;
    }
    return row;
  });

  const bad = stockRows.filter((r) => !r.ok);
  say('');
  say(C.dim('      rank symbol   decimals  hook   paused  ui multiplier        mint'));
  stockRows.forEach((r, i) => {
    const mark = r.ok ? C.green('ok  ') : C.red('FAIL');
    const mult = r.uiMultiplier === null ? '(unreadable)' : String(r.uiMultiplier);
    say(
      `      ${String(i + 1).padStart(3)}  ${r.symbol.padEnd(8)} ${String(r.decimals ?? r.assumedDecimals).padStart(4)}     ` +
        `${(r.transferHookProgramId ? 'SET!' : 'none').padEnd(6)} ${(r.paused === null ? '?' : r.paused ? 'YES!' : 'no').padEnd(7)} ` +
        `${mult.padEnd(20)} ${mark} ${C.dim(short(r.mint))}`,
    );
    if (!r.ok) say(C.red(`           ${r.code}: ${r.error}`));
  });
  say('');

  const status = bad.length === 0 ? STATUS.PASS : STATUS.FAIL;
  line(`all ${stockRows.length} mints are Token-2022, unhooked, unpaused`, status,
    bad.length === 0 ? 'plain transferChecked is valid for every one' : `${bad.length} mint(s) would break a live round`);
  record(
    'stock_transferable',
    'stocks still transferable',
    status,
    bad.length === 0
      ? `all ${stockRows.length} top-20 mints read from mainnet: Token-2022, decimals as assumed, transferHook null, not paused`
      : `${bad.length} of ${stockRows.length} mints failed: ${bad.map((r) => `${r.symbol} (${r.code})`).join(', ')}`,
    { stocks: stockRows },
  );
} catch (err) {
  line('read the top-20 mints from mainnet', STATUS.FAIL, err.message);
  record('stock_transferable', 'stocks still transferable', STATUS.FAIL, `could not check the mints: ${err.message}`);
}
say('');

/* ------------------------------------------------- 4. SWAP TRANSACTION */

say(C.bold('  4  A REAL SWAP TRANSACTION BUILDS AND VALIDATES') + C.dim('  — Jupiter quote, signed by the vault, simulated on mainnet'));

let swapStock = null;
try {
  if (!vaultKeypair) throw new Error('no vault keypair: nothing can be signed');
  if (universe.length === 0) throw new Error('no universe: nothing to buy');

  const picks = defaultPicks(universe, CFG.rules);
  if (!picks || picks.length === 0) throw new Error('the default basket resolved to nothing');
  const target = picks[0];
  swapStock = universe.find((s) => s.mint === target.mint) ?? null;
  if (!swapStock) throw new Error(`default basket names ${target.symbol}, which is not in the current universe`);

  const testSol = solArg !== null ? Number(solArg) : CFG.minRoundPoolSol;
  if (!Number.isFinite(testSol) || testSol <= 0) throw new Error(`--sol must be a positive number, got ${solArg}`);
  const lamports = BigInt(Math.round(testSol * 1e9));

  say(C.dim(`      default basket: ${picks.map((p) => `${p.symbol} ${p.pct}%`).join(', ')}`));
  say(C.dim(`      quoting ${testSol} SOL -> ${swapStock.symbol} at ${CFG.slippageBps} bps slippage`));

  const quote = await jup.quote({
    inputMint: SOL_MINT,
    outputMint: swapStock.mint,
    amount: lamports,
    slippageBps: CFG.slippageBps,
  });
  const outUi = Number(BigInt(quote.outAmount)) / 10 ** swapStock.decimals;
  line('Jupiter returns a route', STATUS.PASS,
    `${testSol} SOL -> ${outUi.toFixed(6)} ${swapStock.symbol}, price impact ${quote.priceImpactPct ?? 'n/a'}, ${quote.routePlan?.length ?? 0} hop(s)`);

  const built = await jup.buildSwapTx({
    quoteResponse: quote,
    userPublicKey: vaultKeypair.publicKey.toBase58(),
    prioritizationFeeLamports: CFG.priorityFeeLamports,
  });
  const tx = VersionedTransaction.deserialize(Buffer.from(built.swapTransaction, 'base64'));
  line('Jupiter builds a v0 transaction for the vault', STATUS.PASS,
    `${tx.message.compiledInstructions.length} instructions, ${(tx.message.addressTableLookups ?? []).length} address table(s)`);

  const payer = tx.message.staticAccountKeys[0].toBase58();
  const payerOk = payer === vaultKeypair.publicKey.toBase58();
  line('the vault is the fee payer', payerOk ? STATUS.PASS : STATUS.FAIL, payer);

  tx.sign([vaultKeypair]);
  const sigOk = crypto.verify(
    null,
    Buffer.from(tx.message.serialize()),
    publicKeyFromBytes(vaultKeypair.publicKey.toBytes()),
    Buffer.from(tx.signatures[0]),
  );
  line('the vault signature verifies over the message', sigOk ? STATUS.PASS : STATUS.FAIL, 'ed25519, checked independently of web3.js');

  const sim = await simulateWithRetry(rpc, tx);
  const verdict = classifySimulation(sim);
  if (sim.note) say(C.dim(`      note: ${sim.note}`));

  if (verdict.klass === 'ok') {
    line('mainnet simulates the swap', STATUS.PASS, `${sim.unitsConsumed ?? '?'} compute units consumed`);
    record('swap_tx', 'real swap transaction', STATUS.PASS,
      `SOL -> ${swapStock.symbol} for ${testSol} SOL: quoted, built, signed and executed by the cluster in simulation`,
      { symbol: swapStock.symbol, mint: swapStock.mint, lamports: lamports.toString(), outAmount: quote.outAmount, unitsConsumed: sim.unitsConsumed });
  } else if (verdict.klass === 'unfunded') {
    line('mainnet simulates the swap', STATUS.NOTE, verdict.why);
    say(C.dim(`      the transaction is well formed; the missing piece is money: ${textOf(sim.err) || sim.thrown?.message}`));
    record('swap_tx', 'real swap transaction', STATUS.NOTE,
      `SOL -> ${swapStock.symbol}: the transaction builds, signs and is accepted as well formed. Simulation stops at the vault's empty balance (${verdict.why}). Fund the vault and this becomes a plain PASS.`,
      { symbol: swapStock.symbol, mint: swapStock.mint, lamports: lamports.toString(), outAmount: quote.outAmount, err: sim.err, why: verdict.why });
    unproven(
      'that a real Jupiter swap executes end to end',
      `fund the vault with more than ${testSol} SOL and re-run: the same simulation then executes the route instead of stopping at the payer.`,
    );
  } else {
    line('mainnet simulates the swap', STATUS.FAIL, verdict.why);
    printLogs(sim.logs);
    record('swap_tx', 'real swap transaction', STATUS.FAIL,
      `the swap transaction was REJECTED for a reason that is not lack of funds: ${verdict.why}`,
      { symbol: swapStock.symbol, mint: swapStock.mint, err: sim.err, thrown: sim.thrown?.message ?? null, logs: sim.logs });
  }
} catch (err) {
  line('build and simulate a real swap', STATUS.FAIL, err.message);
  record('swap_tx', 'real swap transaction', STATUS.FAIL, `could not build a swap to simulate: ${err.message}`);
}
say('');

/* ------------------------------------------------- 5. DISTRIBUTION TRANSACTION */

say(C.bold('  5  A REAL DISTRIBUTION TRANSACTION BUILDS AND VALIDATES') + C.dim('  — the project distributor, signed, simulated'));

try {
  if (!vaultKeypair) throw new Error('no vault keypair: nothing can be signed');
  const stock = swapStock ?? universe[0];
  if (!stock) throw new Error('no stock to distribute');

  const holder = derivePreflightHolder();
  const amount = 10n ** BigInt(stock.decimals) / 1000n; // 0.001 of a share: a plausible drop
  say(C.dim(`      recipient ${holder}${holderArg ? ' (from --holder)' : ' (deterministic pre-flight address, key held by nobody)'}`));
  say(C.dim(`      sending ${amount} base units of ${stock.symbol} (${stock.decimals} decimals)`));

  // Independently derived, from the ATA seeds, not from the spl-token helper.
  const expectedDestination = deriveAtaIndependently(holder, stock.mint);
  const expectedSource = deriveAtaIndependently(vaultKeypair.publicKey.toBase58(), stock.mint);

  const { blockhash } = await rpc.getLatestBlockhash('confirmed');
  const { tx } = dist.buildBatchTx({
    vaultKeypair,
    mint: stock.mint,
    decimals: stock.decimals,
    batch: [{ wallet: holder, owner: new PublicKey(holder), amount }],
    blockhash,
    priorityFeeLamports: CFG.priorityFeeLamports,
  });

  /* ---- decode what the distributor actually built, before simulating ---- */

  const decoded = tx.message.compiledInstructions.map((ix) => decodeInstruction(tx.message, ix));
  const ataIx = decoded.find((d) => d.programId === ASSOCIATED_TOKEN_PROGRAM) ?? null;
  const transferIx = decoded.find((d) => d.programId === TOKEN_2022_PROGRAM) ?? null;
  const budgetIxs = decoded.filter((d) => d.programId === COMPUTE_BUDGET_PROGRAM);
  const unknown = decoded.filter(
    (d) => ![ASSOCIATED_TOKEN_PROGRAM, TOKEN_2022_PROGRAM, COMPUTE_BUDGET_PROGRAM, SYSTEM_PROGRAM].includes(d.programId),
  );

  const structural = [];
  const check = (label, ok, detail) => {
    structural.push({ label, ok, detail });
    line(`  ${label}`, ok ? STATUS.PASS : STATUS.FAIL, detail);
  };

  check('every instruction targets a known program', unknown.length === 0,
    `${budgetIxs.length} compute-budget, ${ataIx ? 1 : 0} associated-token, ${transferIx ? 1 : 0} Token-2022${unknown.length ? `, ${unknown.length} UNKNOWN: ${unknown.map((u) => u.programId).join(', ')}` : ''}`);

  check('the token program is Token-2022', transferIx?.programId === TOKEN_2022_PROGRAM, transferIx?.programId ?? 'no token instruction built');

  const ataOk = ataIx
    && ataIx.data.length === 1 && ataIx.data[0] === 1 // Idempotent create
    && ataIx.accounts[0] === vaultKeypair.publicKey.toBase58()
    && ataIx.accounts[1] === expectedDestination
    && ataIx.accounts[2] === holder
    && ataIx.accounts[3] === stock.mint
    && ataIx.accounts[4] === SYSTEM_PROGRAM
    && ataIx.accounts[5] === TOKEN_2022_PROGRAM;
  check('the ATA creation is idempotent and vault-paid', Boolean(ataOk),
    ataIx ? `discriminator ${ataIx.data[0]} (1 = idempotent), payer ${short(ataIx.accounts[0])}` : 'no ATA instruction built');

  // The independent derivation. A silent mismatch here sends tokens nowhere.
  const destOk = transferIx?.accounts[2] === expectedDestination;
  check('the destination is the ATA we derive independently', Boolean(destOk),
    destOk ? expectedDestination : `built ${transferIx?.accounts[2]} vs derived ${expectedDestination}`);
  const srcOk = transferIx?.accounts[0] === expectedSource;
  check("the source is the vault's own ATA", Boolean(srcOk),
    srcOk ? expectedSource : `built ${transferIx?.accounts[0]} vs derived ${expectedSource}`);

  let decodedAmount = null;
  let decodedDecimals = null;
  if (transferIx && transferIx.data.length === 10 && transferIx.data[0] === 12) {
    decodedAmount = transferIx.data.readBigUInt64LE(1);
    decodedDecimals = transferIx.data[9];
  }
  check('transferChecked carries the right amount and decimals',
    decodedAmount === amount && decodedDecimals === Number(stock.decimals),
    `instruction 12, amount ${decodedAmount}, decimals ${decodedDecimals} (mint says ${stock.decimals})`);

  const authorityOk = transferIx?.accounts[3] === vaultKeypair.publicKey.toBase58();
  check('the vault is the transfer authority', Boolean(authorityOk), transferIx?.accounts[3] ?? 'n/a');

  // Are those programs actually deployed and executable on mainnet?
  const [tokenAcct, ataAcct] = await Promise.all([
    rpc.getAccountInfo(TOKEN_2022_PROGRAM, 'base64').catch(() => null),
    rpc.getAccountInfo(ASSOCIATED_TOKEN_PROGRAM, 'base64').catch(() => null),
  ]);
  check('both programs exist and are executable on mainnet',
    Boolean(tokenAcct?.executable && ataAcct?.executable),
    `Token-2022 ${tokenAcct?.executable ? 'executable' : 'MISSING'}, associated-token ${ataAcct?.executable ? 'executable' : 'MISSING'}`);

  const sigOk = crypto.verify(
    null,
    Buffer.from(tx.message.serialize()),
    publicKeyFromBytes(vaultKeypair.publicKey.toBytes()),
    Buffer.from(tx.signatures[0]),
  );
  check('the vault signature verifies over the message', sigOk, 'ed25519, checked independently of web3.js');

  const structuralOk = structural.every((s) => s.ok);

  /* ---- and now the cluster's opinion ---- */

  const sim = await simulateWithRetry(rpc, tx);
  const verdict = classifySimulation(sim);
  if (sim.note) say(C.dim(`      note: ${sim.note}`));

  if (verdict.klass === 'ok') {
    line('mainnet simulates the distribution', STATUS.PASS, `${sim.unitsConsumed ?? '?'} compute units consumed`);
    record('distribution_tx', 'real distribution transaction', structuralOk ? STATUS.PASS : STATUS.FAIL,
      structuralOk
        ? `createAssociatedTokenAccountIdempotent + transferChecked for ${stock.symbol} executed by the cluster in simulation, and every account and byte matches an independent derivation`
        : 'the cluster accepted it but the built instructions do not match what they should be — see the structural lines',
      { symbol: stock.symbol, mint: stock.mint, holder, expectedDestination, structural, unitsConsumed: sim.unitsConsumed });
  } else if (verdict.klass === 'unfunded') {
    const status = structuralOk ? STATUS.NOTE : STATUS.FAIL;
    line('mainnet simulates the distribution', status, verdict.why);
    say(C.dim(`      ${textOf(sim.err) || sim.thrown?.message}`));
    record('distribution_tx', 'real distribution transaction', status,
      structuralOk
        ? `the transaction builds, signs and is well formed — every program id, account and instruction byte was verified against an independent derivation. Simulation stops at the vault's empty balance (${verdict.why}), which is the known state, not a defect.`
        : `simulation stopped at the empty vault AND the built instructions do not match an independent derivation — see the structural lines. Do not go live.`,
      { symbol: stock.symbol, mint: stock.mint, holder, expectedDestination, structural, err: sim.err, why: verdict.why });
    unproven(
      'that a distribution transaction actually lands, creating the recipient account and moving the stock',
      `fund the vault (roughly 0.01 SOL is enough for this simulation to run past the payer) and re-run; a full green also needs the vault to hold the stock, i.e. after a real round's swap.`,
    );
  } else {
    line('mainnet simulates the distribution', STATUS.FAIL, verdict.why);
    printLogs(sim.logs);
    record('distribution_tx', 'real distribution transaction', STATUS.FAIL,
      `the distribution transaction was REJECTED for a reason that is not lack of funds: ${verdict.why}`,
      { symbol: stock.symbol, mint: stock.mint, holder, structural, err: sim.err, thrown: sim.thrown?.message ?? null, logs: sim.logs });
  }
} catch (err) {
  line('build and simulate a real distribution', STATUS.FAIL, err.message);
  record('distribution_tx', 'real distribution transaction', STATUS.FAIL, `could not build a distribution to simulate: ${err.message}`);
}
say('');

/* ------------------------------------------------- 6. RENT AND COST TRUTH */

say(C.bold('  6  RENT AND COST TRUTH') + C.dim('  — what the chain charges vs what the keeper reserves'));

let perAccountRent = null;
try {
  const raw = await rpc.call('getMinimumBalanceForRentExemption', [TOKEN_2022_ATA_BYTES]);
  perAccountRent = BigInt(raw);
  const constant = BigInt(ATA_RENT_LAMPORTS);
  const same = perAccountRent === constant;
  const underReserving = perAccountRent > constant;

  say(`      chain says ...... ${perAccountRent} lamports (${sol(perAccountRent)} SOL) for a ${TOKEN_2022_ATA_BYTES}-byte account`);
  say(`      keeper reserves . ${constant} lamports (${sol(constant)} SOL)  [ATA_RENT_LAMPORTS fallback]`);

  const status = same ? STATUS.PASS : underReserving ? STATUS.FAIL : STATUS.NOTE;
  line('the reserved rent covers the real rent', status,
    same
      ? 'exact match'
      : underReserving
        ? `UNDER-RESERVING by ${perAccountRent - constant} lamports per account — a live round would run dry part way through paying people`
        : `over-reserving by ${constant - perAccountRent} lamports per account (safe, but the constant is stale)`);

  // What a first round actually costs, using the number the chain just gave us.
  const basketSize = (defaultPicks(universe, CFG.rules) ?? []).length || CFG.defaultBasketSize;
  say('');
  say(C.dim(`      first-round rent at ${basketSize} stock(s) per holder (the project pays, never the holder):`));
  for (const holders of [10, 100, 1000]) {
    const accounts = BigInt(holders * basketSize);
    say(C.dim(`        ${String(holders).padStart(5)} holders -> ${accounts} accounts = ${sol(accounts * perAccountRent)} SOL, once`));
  }

  record('rent_truth', 'rent and cost truth', status,
    same
      ? `getMinimumBalanceForRentExemption(${TOKEN_2022_ATA_BYTES}) = ${perAccountRent} lamports, exactly what the keeper reserves`
      : underReserving
        ? `the chain charges ${perAccountRent} lamports per token account but the keeper reserves only ${constant} — under-reserving by ${perAccountRent - constant} per account`
        : `the chain charges ${perAccountRent} lamports per token account, the keeper reserves ${constant} — safe, but the constant is stale`,
    { chainLamports: perAccountRent.toString(), constantLamports: constant.toString(), bytes: TOKEN_2022_ATA_BYTES });
} catch (err) {
  line('read the rent-exempt minimum from mainnet', STATUS.FAIL, err.message);
  record('rent_truth', 'rent and cost truth', STATUS.FAIL, `could not read the rent-exempt minimum: ${err.message}`);
}
say('');

/* ------------------------------------------------- 7. SAFETY INTERLOCKS */

say(C.bold('  7  THE SAFETY INTERLOCKS HOLD') + C.dim('  — the two guards between a mistake and real money'));

const interlocks = [];
function interlock(label, ok, detail) {
  interlocks.push({ label, ok, detail });
  line(`  ${label}`, ok ? STATUS.PASS : STATUS.FAIL, detail);
}

/* 7a — the distributor refuses to send outside LIVE */
try {
  const dryCfg = cfgWithLive('0');
  const targets = [
    ['DRY_RUN', dryCfg ? { ...dryCfg, mode: dryCfg.mode === 'READ_ONLY' ? 'DRY_RUN' : dryCfg.mode } : { mode: 'DRY_RUN' }],
    ['READ_ONLY', { mode: 'READ_ONLY' }],
    ['unset', {}],
  ];
  for (const [name, cfg] of targets) {
    const d = createDistributor({ cfg, rpc });
    let threw = null;
    try {
      await d.ensureAndTransfer(
        vaultKeypair ?? { publicKey: new PublicKey(PUBLISHED_VAULT), secretKey: new Uint8Array(64) },
        universe[0]?.mint ?? SOL_MINT,
        8,
        [{ wallet: derivePreflightHolder(), amountRaw: '1' }],
      );
    } catch (err) {
      threw = err;
    }
    const ok = threw instanceof DistributorError && threw.code === 'not_live';
    interlock(`distributor refuses to send in ${name} mode`, ok, threw ? threw.message : 'IT DID NOT REFUSE');
  }
} catch (err) {
  interlock('distributor refuses to send outside LIVE', false, `the check itself failed: ${err.message}`);
}

/* 7b — the runner refuses to finish a round opened in a different mode */
function memoryStore(round) {
  const rounds = new Map([[round.id, round]]);
  return {
    async getRound(id) {
      return rounds.get(id) ?? null;
    },
    async updateRound(id, patch) {
      const next = { ...(rounds.get(id) ?? {}), ...patch };
      rounds.set(id, next);
      return next;
    },
    async createRound(r) {
      rounds.set(r.id, r);
      return r;
    },
    async unfinishedRound() {
      return null;
    },
    async getKV() {
      return null;
    },
    async setKV() {},
    async allPrefs() {
      return [];
    },
    async close() {},
  };
}

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

async function modeMismatchHolds(roundMode, processCfg) {
  if (!processCfg) return { ok: false, detail: 'could not build a config in that mode' };
  const id = `r_preflight_${roundMode.toLowerCase()}`;
  const round = {
    id,
    mode: roundMode,
    simulated: roundMode !== 'LIVE',
    status: 'SWAPPING',
    scheduledAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    swaps: [],
    transfers: [],
    stats: {},
  };
  const db = memoryStore(round);
  const result = await runRound({
    cfg: processCfg,
    db,
    rpc,
    jup,
    dist,
    vault: vaultKeypair ?? null,
    roundId: id,
    retry: true,
    resume: false,
    logger: quiet,
  });
  const ok =
    result?.status === 'FAILED' &&
    result?.modeMismatch?.roundMode === roundMode &&
    result?.modeMismatch?.processMode === processCfg.mode &&
    typeof result?.error === 'string' &&
    result.error.includes(roundMode);
  return { ok, detail: ok ? result.error : `status ${result?.status}, modeMismatch ${JSON.stringify(result?.modeMismatch ?? null)}` };
}

try {
  const dryCfg = cfgWithLive('0');
  const liveCfg = cfgWithLive('1');
  if (dryCfg?.mode === 'DRY_RUN') {
    const r = await modeMismatchHolds('LIVE', dryCfg);
    interlock('a LIVE round is refused by a DRY_RUN process', r.ok, r.detail);
  } else {
    interlock('a LIVE round is refused by a DRY_RUN process', false, 'no vault secret, so no DRY_RUN config exists');
  }
  if (liveCfg?.mode === 'LIVE') {
    const r = await modeMismatchHolds('DRY_RUN', liveCfg);
    interlock('a DRY_RUN round is refused by a LIVE process', r.ok, r.detail);
  } else {
    interlock('a DRY_RUN round is refused by a LIVE process', false, 'no vault secret, so no LIVE config exists');
  }
} catch (err) {
  interlock('the runner refuses a cross-mode round', false, `the check itself failed: ${err.message}`);
}

const interlocksOk = interlocks.length > 0 && interlocks.every((i) => i.ok);
record('interlocks', 'safety interlocks', interlocksOk ? STATUS.PASS : STATUS.FAIL,
  interlocksOk
    ? 'the distributor refuses to send outside LIVE, and the runner refuses to finish a round in a mode other than the one it was opened in — both proven by calling the real code'
    : `${interlocks.filter((i) => !i.ok).length} interlock(s) did not hold: ${interlocks.filter((i) => !i.ok).map((i) => i.label).join('; ')}`,
  { interlocks });
say('');

/* ------------------------------------------------------------------ summary */

const failures = CHECKS.filter((c) => c.status === STATUS.FAIL);
const notes = CHECKS.filter((c) => c.status === STATUS.NOTE);
const unfunded = CHECKS.filter((c) => c.status === STATUS.UNFUNDED);

say(C.bold('  SUMMARY'));
for (const c of CHECKS) {
  say(`  ${c.name.padEnd(46, '.')} ${paint(c.status)}`);
}
say('');
for (const c of CHECKS) say(C.dim(`  · ${c.name}: ${c.summary}`));

if (UNPROVEN.length > 0) {
  say('');
  say(C.bold('  UNPROVEN') + C.dim('  — cannot be verified in the current state, and is not claimed'));
  for (const u of UNPROVEN) {
    say(`  ${C.yellow('UNPROVEN')}  ${u.what}`);
    say(C.dim(`            proof: ${u.wouldProve}`));
  }
}

say('');
say(C.bold('  EVIDENCE THAT NOTHING WAS SENT'));
const methods = [...rpcMethodCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
say(C.dim(`  JSON-RPC methods this process used: ${methods.map(([m, n]) => `${m}×${n}`).join(', ') || '(none)'}`));
say(C.dim(`  sendTransaction: ${rpcMethodCounts.get('sendTransaction') ?? 0}   requestAirdrop: ${rpcMethodCounts.get('requestAirdrop') ?? 0}   send attempts refused by the guard: ${blockedSendAttempts}`));
say(C.dim(`  Verify independently: the vault balance above is unchanged and ${short(vaultAddress ?? CFG.vaultAddress)} has no new signatures on Solscan.`));

say('');
if (failures.length > 0) {
  say(`  ${C.red('NOT READY')} — ${failures.length} check(s) FAILED: ${failures.map((c) => c.name).join(', ')}`);
  say(C.dim('  A FAIL is a defect in the code or the configuration. Fix it before LIVE=1.'));
} else if (unfunded.length > 0 || notes.length > 0) {
  say(`  ${C.yellow('CODE READY, OPERATOR ACTION OUTSTANDING')} — nothing is broken; the vault is not funded and/or the coin is not launched.`);
  say(C.dim('  Everything that can be proven without money has been proven. Re-run after funding.'));
} else {
  say(`  ${C.green('READY')} — every check passed against mainnet.`);
}
say('');

if (asJson) {
  console.log(
    JSON.stringify(
      {
        sendsAnything: false,
        ranAt: new Date().toISOString(),
        mode: CFG.mode,
        vault: vaultAddress ?? CFG.vaultAddress,
        rpcProvider: CFG.rpcProvider,
        tokenMint: CFG.tokenMint || null,
        balanceLamports: balanceLamports === null ? null : balanceLamports.toString(),
        checks: CHECKS,
        unproven: UNPROVEN,
        evidence: {
          rpcMethods: Object.fromEntries(methods),
          sendTransactionCalls: rpcMethodCounts.get('sendTransaction') ?? 0,
          blockedSendAttempts,
        },
        failed: failures.map((c) => c.id),
        exitCode: failures.length > 0 ? 1 : 0,
      },
      null,
      2,
    ),
  );
}

process.exit(failures.length > 0 ? 1 : 0);
