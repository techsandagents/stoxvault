#!/usr/bin/env node
/**
 * Run one STOCKDROP round from the command line.
 *
 *   node scripts/run-round.mjs                 run a round now, honouring LIVE from the env
 *   node scripts/run-round.mjs --dry           force DRY_RUN even if LIVE=1
 *   node scripts/run-round.mjs --retry <id>    retry only the FAILED swaps/transfers of a round
 *   node scripts/run-round.mjs --resume        continue the unfinished round instead of opening one
 *   node scripts/run-round.mjs --json          print the round document instead of the table
 *
 * It prints what happened: the pool, the demand, every swap, every transfer.
 * In DRY_RUN every line is labelled simulated and no transaction exists.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, '..');
const LAMPORTS_PER_SOL = 1_000_000_000n;

/* ------------------------------------------------------------------- args */

function parseArgs(argv) {
  const out = { dry: false, retry: null, resume: false, json: false, help: false, roundId: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry' || arg === '--dry-run') out.dry = true;
    else if (arg === '--retry') out.retry = argv[++i] ?? '';
    else if (arg.startsWith('--retry=')) out.retry = arg.slice('--retry='.length);
    else if (arg === '--round') out.roundId = argv[++i] ?? '';
    else if (arg.startsWith('--round=')) out.roundId = arg.slice('--round='.length);
    else if (arg === '--resume') out.resume = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '-h' || arg === '--help') out.help = true;
    else {
      console.error(`unknown argument: ${arg}`);
      out.help = true;
    }
  }
  return out;
}

const HELP = `stockdrop run-round

  --dry            force DRY_RUN (compute and quote for real, send nothing)
  --retry <id>     retry the FAILED swaps and transfers of an existing round
  --round <id>     continue a specific round id
  --resume         continue the unfinished round, if any
  --json           print the round document as JSON
  -h, --help       this text
`;

/* ---------------------------------------------------------------- printing */

const isTty = process.stdout.isTTY;
const dim = (s) => (isTty ? `\u001b[2m${s}\u001b[0m` : s);
const bold = (s) => (isTty ? `\u001b[1m${s}\u001b[0m` : s);

function lamportsToSol(value, dp = 4) {
  const raw = BigInt(String(value ?? '0'));
  const whole = raw / LAMPORTS_PER_SOL;
  const frac = (raw % LAMPORTS_PER_SOL).toString().padStart(9, '0').slice(0, dp);
  return dp > 0 ? `${whole}.${frac}` : String(whole);
}

function rawToUi(value, decimals, dp = 6) {
  const raw = BigInt(String(value ?? '0'));
  const d = BigInt(Math.max(0, Number(decimals) || 0));
  const scale = 10n ** d;
  const whole = raw / scale;
  const frac = (raw % scale).toString().padStart(Number(d), '0').slice(0, dp);
  return dp > 0 && Number(d) > 0 ? `${whole}.${frac}` : String(whole);
}

const shorten = (s, head = 4, tail = 4) =>
  typeof s === 'string' && s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : String(s ?? '');

/** Fixed-width table. Numeric-looking columns are right-aligned. */
function table(headers, rows) {
  if (rows.length === 0) return dim('  (none)');
  const widths = headers.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i] ?? '').length)));
  const right = headers.map((_, i) => rows.every((r) => /^[\d.,\-+]*$/.test(String(r[i] ?? ''))));
  const line = (cells) =>
    '  ' +
    cells
      .map((cell, i) => (right[i] ? String(cell ?? '').padStart(widths[i]) : String(cell ?? '').padEnd(widths[i])))
      .join('  ')
      .trimEnd();
  return [dim(line(headers)), ...rows.map((r) => line(r))].join('\n');
}

function printRound(round, cfg) {
  const decimals = new Map((round.universe ?? []).map((s) => [s.mint, Number(s.decimals ?? 8)]));
  const symbols = new Map((round.universe ?? []).map((s) => [s.mint, s.symbol]));
  const tag = round.simulated ? dim(' (simulated)') : '';

  console.log('');
  console.log(`${bold(round.id)}  ${bold(round.status)}${round.skipReason ? ` / ${round.skipReason}` : ''}${tag}`);
  console.log(
    dim(
      [
        `mode ${round.mode ?? cfg.mode}`,
        `scheduled ${round.scheduledAt ?? '-'}`,
        `finished ${round.finishedAt ?? '-'}`,
        round.jitterMin === null || round.jitterMin === undefined ? null : `jitter ${round.jitterMin}m`,
      ]
        .filter(Boolean)
        .join('   '),
    ),
  );
  console.log(
    `  vault ${cfg.vaultAddress ?? '-'}   balance ${lamportsToSol(round.balanceLamports)} SOL   reserve ${lamportsToSol(
      round.reserveLamports,
    )} SOL   pool ${bold(`${lamportsToSol(round.poolLamports)} SOL`)}`,
  );

  if (round.error) console.log(`  error: ${round.error}`);
  if (round.status === 'SKIPPED') {
    const why = {
      no_token: 'TOKEN_MINT is blank — the coin is not launched, so there are no holders to pay.',
      no_vault: 'no vault address is configured.',
      low_pool: `pool is below MIN_ROUND_POOL_SOL (${cfg.minRoundPoolSol} SOL); the SOL carries over to the next round.`,
      no_holders: 'no wallet met the eligibility threshold at snapshot.',
    }[round.skipReason];
    if (why) console.log(dim(`  ${why}`));
    console.log('');
    return;
  }

  if (round.snapshot) {
    console.log('');
    console.log(
      dim(
        `  snapshot ${round.snapshot.takenAt}  slot ${round.snapshot.slot ?? '-'}  eligible ${
          round.snapshot.holders?.length ?? 0
        }/${round.snapshot.totalHolders ?? '?'}  hash ${shorten(round.snapshot.hash, 8, 8)}`,
      ),
    );
  }

  if ((round.demand ?? []).length > 0) {
    console.log('');
    console.log(bold('  DEMAND & SWAPS'));
    const swapByMint = new Map((round.swaps ?? []).map((s) => [s.mint, s]));
    console.log(
      table(
        ['SYMBOL', 'SHARE', 'SOL IN', 'QUOTED', 'RECEIVED', 'STATUS', 'TX'],
        (round.demand ?? []).map((d) => {
          const swap = swapByMint.get(d.mint) ?? {};
          const dec = decimals.get(d.mint) ?? 8;
          return [
            d.symbol || shorten(d.mint),
            `${(d.shareBps / 100).toFixed(2)}%`,
            lamportsToSol(d.solLamports),
            swap.quotedOut ? rawToUi(swap.quotedOut, dec) : '-',
            swap.receivedRaw ? rawToUi(swap.receivedRaw, dec) : '-',
            swap.status ?? '-',
            swap.tx ? shorten(swap.tx, 6, 6) : round.simulated ? dim('simulated') : '-',
          ];
        }),
      ),
    );
    const failed = (round.swaps ?? []).filter((s) => s.status === 'FAILED');
    for (const swap of failed) console.log(`  ! ${swap.symbol || swap.mint}: ${swap.error}`);
  }

  const transfers = round.transfers ?? [];
  if (transfers.length > 0) {
    console.log('');
    console.log(bold(`  TRANSFERS (${transfers.length})`));
    const shown = transfers.slice(0, 40);
    console.log(
      table(
        ['WALLET', 'SYMBOL', 'AMOUNT', 'STATUS', 'TX'],
        shown.map((t) => [
          shorten(t.wallet, 6, 4),
          t.symbol || symbols.get(t.mint) || shorten(t.mint),
          rawToUi(t.amountRaw, decimals.get(t.mint) ?? 8),
          t.status,
          t.tx ? shorten(t.tx, 6, 6) : round.simulated ? dim('simulated') : '-',
        ]),
      ),
    );
    if (transfers.length > shown.length) console.log(dim(`  … ${transfers.length - shown.length} more`));
  }

  if ((round.carryOut ?? []).length > 0) {
    console.log('');
    console.log(bold('  CARRY-OVER DUST'));
    console.log(
      table(
        ['SYMBOL', 'AMOUNT'],
        round.carryOut.map((c) => [symbols.get(c.mint) || shorten(c.mint), rawToUi(c.amountRaw, decimals.get(c.mint) ?? 8)]),
      ),
    );
  }

  const stats = round.stats ?? {};
  console.log('');
  console.log(
    dim(
      `  holders ${stats.eligibleHolders ?? 0} (${stats.prefHolders ?? 0} with picks, ${stats.defaultHolders ?? 0} default)   ` +
        `swaps ${stats.swapsDone ?? 0} done / ${stats.swapsFailed ?? 0} failed   ` +
        `transfers ${stats.transfersDone ?? 0} done / ${stats.transfersFailed ?? 0} failed / ${stats.transfersSkippedDust ?? 0} dust   ` +
        `spent ${lamportsToSol(stats.solSpentLamports ?? '0')} SOL`,
    ),
  );
  console.log('');
}

/* -------------------------------------------------------------- services */

async function tryImport(spec) {
  try {
    return await import(spec);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
}

/**
 * Turn a service module into something the runner can call: the namespace
 * itself when it exports the methods directly, otherwise whatever its factory
 * returns. Returns null when the module does not exist yet.
 */
async function resolveService(spec, { methods, factories, cfg, deps }) {
  const mod = await tryImport(spec);
  if (!mod) return null;
  for (const name of methods) if (typeof mod[name] === 'function') return mod;
  for (const name of [...factories, 'default']) {
    const factory = mod[name];
    if (typeof factory !== 'function') continue;
    try {
      const made = await factory(cfg, deps);
      if (made && typeof made === 'object') return made;
    } catch {
      try {
        const made = await factory({ cfg, ...deps });
        if (made && typeof made === 'object') return made;
      } catch {
        /* not this export; keep looking */
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------- main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  // Load the config ourselves so --dry can override LIVE, and keep the module's
  // own eager load quiet so the banner is printed once.
  process.env.STOCKDROP_QUIET = '1';
  const { loadConfig } = await import('../src/config.js');
  const { createLogger } = await import('../src/util/log.js');
  const { openDb } = await import('../src/db/index.js');
  const { createRpc } = await import('../src/chain/rpc.js');
  const { createJupiter } = await import('../src/chain/jupiter.js');
  const { createDistributor } = await import('../src/chain/distributor.js');
  const { loadVault } = await import('../src/chain/vault.js');
  const { runRound } = await import('../src/keeper/runner.js');

  const env = { ...process.env };
  delete env.STOCKDROP_QUIET;
  if (args.dry) env.LIVE = '0';
  const cfg = loadConfig({ env, quiet: true, root: SERVER_ROOT });
  const logger = createLogger('round');

  console.log(bold(`stockdrop  ${cfg.bootSummary()}`));
  if (cfg.mode === 'LIVE') console.log(bold('  LIVE MODE — this will send real transactions from the vault.'));
  else console.log(dim('  DRY_RUN — quotes are real, nothing is signed and nothing is sent.'));

  const db = await openDb(cfg);
  const rpc = createRpc(cfg, { logger });
  const jup = createJupiter(cfg, { logger });
  const dist = createDistributor({ cfg, rpc, logger });
  const vault = loadVault(cfg);

  const universeService = await resolveService('../src/services/universe.js', {
    methods: ['getUniverse', 'refresh', 'load'],
    factories: ['createUniverseService', 'createUniverse', 'openUniverse', 'universeService'],
    cfg,
    deps: { rpc, jup, db, logger },
  });
  const holdersService = await resolveService('../src/services/holders.js', {
    methods: ['snapshot', 'getSnapshot', 'takeSnapshot', 'getHolders'],
    factories: ['createHoldersService', 'createHolders', 'openHolders', 'holdersService'],
    cfg,
    deps: { rpc, jup, db, logger },
  });
  if (!holdersService && cfg.tokenMint) {
    console.error('  holders service (src/services/holders.js) is unavailable; a launched token cannot be snapshotted.');
  }

  let exitCode = 0;
  try {
    const round = await runRound({
      cfg,
      db,
      rpc,
      jup,
      dist,
      vault,
      holdersService,
      universeService,
      logger,
      roundId: args.retry || args.roundId || undefined,
      retry: Boolean(args.retry),
      resume: args.resume || Boolean(args.retry) || Boolean(args.roundId),
    });

    if (args.json) console.log(JSON.stringify(round, null, 2));
    else printRound(round, cfg);

    if (round.status === 'FAILED') exitCode = 1;
    if ((round.stats?.transfersFailed ?? 0) > 0 || (round.stats?.swapsFailed ?? 0) > 0) {
      console.log(dim(`  retry the failed parts with:  node scripts/run-round.mjs --retry ${round.id}`));
      exitCode = 2;
    }
  } finally {
    await db.close();
  }
  return exitCode;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`round failed: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
