// config + util tests. `node --test test/`

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// importing config.js builds CFG from server/.env; keep its boot line out of the test output
process.env.STOCKDROP_QUIET = '1';
const {
  CFG,
  ConfigError,
  LAMPORTS_PER_SOL,
  b58decode,
  b58encode,
  buildConfig,
  deriveVault,
  loadConfig,
  nextRoundAtFor,
  parseEnvFile,
  publicKeyFromSeed,
  solToLamports,
  uiToRaw,
} = await import('../src/config.js');
const { canonicalHash, canonicalJson, sha256Hex } = await import('../src/util/canonical.js');
const { redact, createLogger } = await import('../src/util/log.js');

/** A real ed25519 keypair in the Solana 64-byte (seed || pubkey) base58 form. */
function makeKeypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const seed = Buffer.from(pkcs8.subarray(pkcs8.length - 32));
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const pub = Buffer.from(spki.subarray(spki.length - 32));
  return { seed, pub, address: b58encode(pub), secretBase58: b58encode(Buffer.concat([seed, pub])) };
}

/* ------------------------------------------------------------------ base58 */

test('base58 round-trips arbitrary bytes, including leading zeros', () => {
  for (const bytes of [
    Buffer.from([0, 0, 1, 2, 3]),
    Buffer.from('hello stockdrop', 'utf8'),
    crypto.randomBytes(64),
    Buffer.alloc(32, 0),
  ]) {
    assert.deepEqual(Buffer.from(b58decode(b58encode(bytes))), bytes);
  }
  // known vector: 32 zero bytes is the Solana system program address
  assert.equal(b58encode(Buffer.alloc(32, 0)), '11111111111111111111111111111111');
  assert.throws(() => b58decode('0OIl'), /invalid character/);
});

/* ------------------------------------------------------------- env parsing */

test('parseEnvFile handles comments, quotes, export and inline comments', () => {
  const parsed = parseEnvFile(
    [
      '# a comment',
      '',
      'PORT=4700',
      'LIVE=0                      # 0 = DRY_RUN',
      'export TOKEN_SYMBOL=DROP',
      'QUOTED="a b # not a comment"',
      "SINGLE='  spaced  '",
      'ESCAPED="line1\\nline2"',
      'EMPTY=',
      'not a pair',
    ].join('\n'),
  );
  assert.equal(parsed.PORT, '4700');
  assert.equal(parsed.LIVE, '0');
  assert.equal(parsed.TOKEN_SYMBOL, 'DROP');
  assert.equal(parsed.QUOTED, 'a b # not a comment');
  assert.equal(parsed.SINGLE, '  spaced  ');
  assert.equal(parsed.ESCAPED, 'line1\nline2');
  assert.equal(parsed.EMPTY, '');
  assert.equal(parsed['not a pair'], undefined);
});

test('loadConfig reads the env file but lets process env win', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stockdrop-env-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const envPath = path.join(dir, '.env');
  await fs.writeFile(envPath, 'PORT=1234\nTOKEN_SYMBOL=FROMFILE\nCORS_ORIGIN=https://from.file\n', 'utf8');

  const cfg = loadConfig({ envPath, env: { TOKEN_SYMBOL: 'FROMENV' }, quiet: true });
  assert.equal(cfg.port, 1234, 'file value used when process env has none');
  assert.equal(cfg.tokenSymbol, 'FROMENV', 'process env wins');
  assert.equal(cfg.corsOrigin, 'https://from.file');

  const none = loadConfig({ envPath: null, env: {}, quiet: true });
  assert.equal(none.port, 4700);
});

/* -------------------------------------------------------------- defaults */

test('buildConfig applies every documented default', () => {
  const cfg = buildConfig({});
  assert.equal(cfg.port, 4700);
  assert.equal(cfg.live, false);
  assert.equal(cfg.rpcUrl, 'https://api.mainnet-beta.solana.com');
  assert.equal(cfg.rpcProvider, 'rpc');
  assert.equal(cfg.databaseUrl, '');
  assert.equal(cfg.storeKind, 'json');
  assert.equal(path.isAbsolute(cfg.dataDir), true);
  assert.equal(cfg.dataDir.endsWith(path.join('data', 'state')), true);
  assert.equal(cfg.vault, null);
  assert.equal(cfg.vaultAddress, null);
  assert.equal(cfg.mode, 'READ_ONLY');
  assert.equal(cfg.tokenMint, '');
  assert.equal(cfg.launched, false);
  assert.equal(cfg.tokenName, '');
  assert.equal(cfg.tokenSymbol, '');
  assert.equal(cfg.tokenSupplyUi, '1000000000');
  assert.equal(cfg.tokenDecimals, 6);
  assert.equal(cfg.eligibleBps, 10);
  assert.deepEqual(cfg.excluded, []);
  assert.equal(cfg.intervalHours, 6);
  assert.equal(cfg.roundJitterMin, 10);
  assert.equal(cfg.minRoundPoolSol, 0.5);
  assert.equal(cfg.feeReserveSol, 0.05);
  assert.equal(cfg.universeSize, 20);
  assert.equal(cfg.defaultBasketSize, 5);
  assert.equal(cfg.liqMinUsd, 50000);
  assert.equal(cfg.slippageBps, 100);
  assert.equal(cfg.priorityFeeLamports, 200000);
  assert.equal(cfg.adminKey, '');
  assert.equal(cfg.hasAdminKey, false);
  assert.equal(cfg.corsOrigin, '*');
  assert.equal(cfg.jupBase, 'https://lite-api.jup.ag');
  assert.equal(typeof cfg.version, 'string');
  assert.equal(Object.isFrozen(cfg), true);
});

test('rules object matches the contract', () => {
  const cfg = buildConfig({ ELIGIBLE_BPS: '25', UNIVERSE_SIZE: '12', DEFAULT_BASKET_SIZE: '3', ROUND_INTERVAL_HOURS: '4' });
  assert.deepEqual({ ...cfg.rules }, {
    minPicks: 2,
    maxPicks: 5,
    minPct: 10,
    maxPct: 60,
    eligibleBps: 25,
    intervalHours: 4,
    universeSize: 12,
    defaultBasketSize: 3,
    // null means "no explicit basket configured": holders who never picked get
    // the top `defaultBasketSize` split evenly.
    defaultBasket: null,
  });
  assert.equal(Object.isFrozen(cfg.rules), true);
});

test('DEFAULT_BASKET is carried into rules, and a malformed one is rejected', () => {
  assert.equal(buildConfig({ DEFAULT_BASKET: 'SPCXx:100' }).rules.defaultBasket, 'SPCXx:100');
  assert.equal(buildConfig({ DEFAULT_BASKET: 'NVDAx:60,TSLAx:40' }).rules.defaultBasket, 'NVDAx:60,TSLAx:40');
  assert.equal(buildConfig({ DEFAULT_BASKET: '' }).rules.defaultBasket, null);
  assert.equal(buildConfig({}).rules.defaultBasket, null);

  // A basket that does not total 100, repeats a ticker, or is unparseable must
  // be reported as invalid rather than silently becoming a different allocation
  // than the operator intended — this setting decides where real money goes.
  for (const bad of ['SPCXx:90', 'SPCXx:60,SPCXx:40', 'SPCXx', 'SPCXx:abc', 'SPCXx:0,NVDAx:100']) {
    assert.equal(buildConfig({ DEFAULT_BASKET: bad }).defaultBasketValid, false, `expected ${bad} to be invalid`);
  }
  assert.equal(buildConfig({ DEFAULT_BASKET: 'SPCXx:100' }).defaultBasketValid, true);
  assert.equal(buildConfig({}).defaultBasketValid, true);
});

test('bad numeric env values fall back to the default instead of NaN', () => {
  const cfg = buildConfig({ PORT: 'abc', ELIGIBLE_BPS: '-5', UNIVERSE_SIZE: '0', SLIPPAGE_BPS: 'x', ROUND_INTERVAL_HOURS: '99' });
  assert.equal(cfg.port, 4700);
  assert.equal(cfg.eligibleBps, 10);
  assert.equal(cfg.universeSize, 20);
  assert.equal(cfg.slippageBps, 100);
  assert.equal(cfg.intervalHours, 6);
});

/* --------------------------------------------------------------- derived */

test('supply and eligibility thresholds are exact base-unit bigints', () => {
  const cfg = buildConfig({});
  assert.equal(cfg.supplyRaw, '1000000000000000'); // 1e9 ui * 1e6
  assert.equal(cfg.eligibleThresholdRaw, '1000000000000'); // 0.1% = 1,000,000 ui
  assert.equal(cfg.eligibleThresholdUi, 1_000_000);

  const nine = buildConfig({ TOKEN_SUPPLY: '999999999.123456789', TOKEN_DECIMALS: '9', ELIGIBLE_BPS: '1' });
  assert.equal(nine.supplyRaw, '999999999123456789');
  assert.equal(nine.eligibleThresholdRaw, (999999999123456789n / 10000n).toString());

  assert.equal(uiToRaw('1e9', 6), 1_000_000_000_000_000n);
  assert.equal(uiToRaw('0.0000005', 6), 0n);
  assert.equal(solToLamports(0.5), 500_000_000n);
  assert.equal(solToLamports('0.05'), 50_000_000n);
  assert.equal(LAMPORTS_PER_SOL, 1_000_000_000);
  assert.throws(() => uiToRaw('abc', 6), ConfigError);
});

test('lamport thresholds are derived without float error', () => {
  const cfg = buildConfig({ MIN_ROUND_POOL_SOL: '0.7', FEE_RESERVE_SOL: '0.29' });
  assert.equal(cfg.minRoundPoolLamports, '700000000');
  assert.equal(cfg.feeReserveLamports, '290000000');
});

test('helius key rewrites the rpc url', () => {
  const plain = buildConfig({ RPC_URL: 'https://my.rpc/x' });
  assert.equal(plain.rpcUrl, 'https://my.rpc/x');
  assert.equal(plain.hasHeliusKey, false);

  const helius = buildConfig({ RPC_URL: 'https://my.rpc/x', HELIUS_API_KEY: 'abc-123' });
  assert.equal(helius.rpcUrl, 'https://mainnet.helius-rpc.com/?api-key=abc-123');
  assert.equal(helius.rpcProvider, 'helius');
  assert.equal(helius.hasHeliusKey, true);
});

test('DATABASE_URL switches the store kind', () => {
  const cfg = buildConfig({ DATABASE_URL: 'postgres://u:p@h:5432/db' });
  assert.equal(cfg.storeKind, 'pg');
});

test('jup base loses its trailing slash', () => {
  assert.equal(buildConfig({ JUP_BASE: 'https://lite-api.jup.ag/' }).jupBase, 'https://lite-api.jup.ag');
});

test('token mint drives the launched flag', () => {
  assert.equal(buildConfig({}).launched, false);
  const launched = buildConfig({ TOKEN_MINT: 'So11111111111111111111111111111111111111112', TOKEN_SYMBOL: 'DROP' });
  assert.equal(launched.launched, true);
  assert.equal(launched.tokenSymbol, 'DROP');
});

/* ----------------------------------------------------------------- vault */

test('vault address is derived from the secret key with node:crypto', () => {
  const kp = makeKeypair();
  const cfg = buildConfig({ VAULT_SECRET_KEY: kp.secretBase58 });
  assert.equal(cfg.vaultAddress, kp.address);
  assert.equal(cfg.vault.address, kp.address);
  assert.equal(cfg.mode, 'DRY_RUN');
  assert.deepEqual(Buffer.from(publicKeyFromSeed(kp.seed)), kp.pub);

  // a bare 32-byte seed works too and derives the same address
  const fromSeed = buildConfig({ VAULT_SECRET_KEY: b58encode(kp.seed) });
  assert.equal(fromSeed.vaultAddress, kp.address);
});

test('the vault secret is never enumerable', () => {
  const kp = makeKeypair();
  const cfg = buildConfig({ VAULT_SECRET_KEY: kp.secretBase58, SESSION_SECRET: 's3cret', ADMIN_KEY: 'adm', DATABASE_URL: 'postgres://u:p@h/db' });
  const dumped = JSON.stringify(cfg);
  for (const secret of [kp.secretBase58, 's3cret', 'adm', 'postgres://u:p@h/db']) {
    assert.equal(dumped.includes(secret), false, `serialised config leaked ${secret.slice(0, 6)}...`);
  }
  assert.equal(JSON.stringify(cfg.vault), '{"address":"' + kp.address + '"}');
  assert.equal(Object.keys(cfg).includes('vaultSecretKey'), false);
  assert.equal(cfg.vaultSecretKey, kp.secretBase58, 'still readable by name');
  assert.equal(cfg.vault.secretKey, kp.secretBase58);
  assert.equal(cfg.vault.secretKeyBytes.length, 64);
  assert.equal(JSON.stringify(cfg.safeSummary()).includes(kp.secretBase58), false);
  assert.equal(cfg.bootSummary().includes(kp.secretBase58), false);
  assert.equal(cfg.bootSummary().includes(kp.address), true);
});

test('VAULT_ADDRESS must match the derived address', () => {
  const kp = makeKeypair();
  const other = makeKeypair();
  assert.equal(buildConfig({ VAULT_SECRET_KEY: kp.secretBase58, VAULT_ADDRESS: kp.address }).vaultAddress, kp.address);
  assert.throws(
    () => buildConfig({ VAULT_SECRET_KEY: kp.secretBase58, VAULT_ADDRESS: other.address }),
    (err) => err instanceof ConfigError && err.code === 'vault_address_mismatch',
  );
});

test('a corrupt secret key is rejected', () => {
  const kp = makeKeypair();
  const wrong = Buffer.concat([kp.seed, makeKeypair().pub]);
  assert.throws(() => deriveVault(b58encode(wrong)), (err) => err.code === 'bad_vault_secret');
  assert.throws(() => deriveVault(b58encode(Buffer.alloc(10))), (err) => err.code === 'bad_vault_secret');
});

test('VAULT_ADDRESS alone is honoured in read-only mode', () => {
  const kp = makeKeypair();
  const cfg = buildConfig({ VAULT_ADDRESS: kp.address });
  assert.equal(cfg.vaultAddress, kp.address);
  assert.equal(cfg.vault, null);
  assert.equal(cfg.mode, 'READ_ONLY');
});

test('mode: READ_ONLY without a secret, DRY_RUN with LIVE=0, LIVE with LIVE=1', () => {
  const kp = makeKeypair();
  assert.equal(buildConfig({ LIVE: '1' }).mode, 'READ_ONLY');
  assert.equal(buildConfig({ VAULT_SECRET_KEY: kp.secretBase58 }).mode, 'DRY_RUN');
  assert.equal(buildConfig({ VAULT_SECRET_KEY: kp.secretBase58, LIVE: '0' }).mode, 'DRY_RUN');
  assert.equal(buildConfig({ VAULT_SECRET_KEY: kp.secretBase58, LIVE: '1' }).mode, 'LIVE');
  assert.equal(buildConfig({ VAULT_SECRET_KEY: kp.secretBase58, LIVE: 'true' }).mode, 'LIVE');
  assert.equal(buildConfig({ VAULT_SECRET_KEY: kp.secretBase58, LIVE: 'yes' }).live, true);
});

test('excluded wallets always include the vault, trimmed and deduped', () => {
  const kp = makeKeypair();
  const cfg = buildConfig({ VAULT_SECRET_KEY: kp.secretBase58, EXCLUDED_WALLETS: ` poolA , poolB ,poolA,, ${kp.address} ` });
  assert.deepEqual(cfg.excluded, ['poolA', 'poolB', kp.address]);
  assert.equal(buildConfig({ EXCLUDED_WALLETS: 'a,a,b' }).excluded.join(','), 'a,b');
});

/* ------------------------------------------------------------ round marks */

test('nextRoundAt lands on the UTC interval marks', () => {
  const cfg = buildConfig({});
  const at = (iso) => cfg.nextRoundAt(new Date(iso)).toISOString();
  assert.equal(at('2026-09-07T00:00:00.000Z'), '2026-09-07T06:00:00.000Z');
  assert.equal(at('2026-09-07T00:00:00.001Z'), '2026-09-07T06:00:00.000Z');
  assert.equal(at('2026-09-07T05:59:59.999Z'), '2026-09-07T06:00:00.000Z');
  assert.equal(at('2026-09-07T11:59:00.000Z'), '2026-09-07T12:00:00.000Z');
  assert.equal(at('2026-09-07T12:00:00.000Z'), '2026-09-07T18:00:00.000Z');
  assert.equal(at('2026-09-07T23:30:00.000Z'), '2026-09-08T00:00:00.000Z');
  assert.equal(cfg.nextRoundAtIso(new Date('2026-09-07T11:59:00Z')), '2026-09-07T12:00:00.000Z');
  assert.equal(cfg.nextRoundAt() instanceof Date, true);
  assert.equal(cfg.nextRoundAt().getTime() > Date.now(), true);
});

test('nextRoundAt never steps past midnight for intervals that do not divide 24', () => {
  assert.equal(nextRoundAtFor(7, new Date('2026-09-07T00:00:00Z')).toISOString(), '2026-09-07T07:00:00.000Z');
  assert.equal(nextRoundAtFor(7, new Date('2026-09-07T21:30:00Z')).toISOString(), '2026-09-08T00:00:00.000Z');
  assert.equal(nextRoundAtFor(1, new Date('2026-09-07T10:10:00Z')).toISOString(), '2026-09-07T11:00:00.000Z');
  assert.equal(nextRoundAtFor(24, new Date('2026-09-07T10:10:00Z')).toISOString(), '2026-09-08T00:00:00.000Z');
});

/* ---------------------------------------------------------- session secret */

test('SESSION_SECRET is random per boot when blank, stable when set', () => {
  const a = buildConfig({});
  const b = buildConfig({});
  assert.equal(a.sessionSecretIsEphemeral, true);
  assert.equal(a.sessionSecret.length >= 32, true);
  assert.notEqual(a.sessionSecret, b.sessionSecret);

  const fixed = buildConfig({ SESSION_SECRET: 'keep-me' });
  assert.equal(fixed.sessionSecret, 'keep-me');
  assert.equal(fixed.sessionSecretIsEphemeral, false);
});

/* ------------------------------------------------------------- module CFG */

test('the module-level CFG is usable and honest about the real environment', () => {
  assert.equal(['LIVE', 'DRY_RUN', 'READ_ONLY'].includes(CFG.mode), true);
  assert.equal(typeof CFG.bootSummary(), 'string');
  assert.equal(CFG.launched, Boolean(CFG.tokenMint));
  assert.equal(Object.isFrozen(CFG), true);
  if (CFG.vaultAddress) assert.equal(CFG.excluded.includes(CFG.vaultAddress), true);
  const summary = CFG.safeSummary();
  assert.equal(summary.token.launched, CFG.launched);
  if (CFG.vaultSecretKey) assert.equal(JSON.stringify(summary).includes(CFG.vaultSecretKey), false);
});

/* -------------------------------------------------------------- canonical */

test('canonicalJson is deterministic regardless of key order', () => {
  const a = { b: 1, a: { z: [3, 2, 1], y: 'x' }, c: null };
  const b = { c: null, a: { y: 'x', z: [3, 2, 1] }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson(a), '{"a":{"y":"x","z":[3,2,1]},"b":1,"c":null}');
  assert.equal(canonicalHash(a), canonicalHash(b));
});

test('canonicalJson is bigint-safe and drops undefined like JSON.stringify', () => {
  assert.equal(canonicalJson({ amount: 12345678901234567890n }), '{"amount":"12345678901234567890"}');
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonicalJson([1, undefined, 2]), '[1,null,2]');
  assert.equal(canonicalJson(new Date('2026-09-07T12:00:00Z')), '"2026-09-07T12:00:00.000Z"');
  assert.equal(canonicalJson(undefined), 'null');
  assert.equal(canonicalJson(Number.NaN), 'null');
  assert.equal(canonicalJson(new Map([['b', 2], ['a', 1]])), '{"a":1,"b":2}');
  const circular = { a: 1 };
  circular.self = circular;
  assert.throws(() => canonicalJson(circular), /circular/);
});

test('a snapshot-shaped document hashes stably', () => {
  const holders = [
    { wallet: 'B', balance: '2000000000000' },
    { wallet: 'A', balance: '3000000000000' },
  ];
  const snap = { takenAt: '2026-09-07T12:00:00.000Z', slot: 1, tokenMint: 'M', supply: '1', eligibleThreshold: '1', holders: [...holders].sort((x, y) => (x.wallet < y.wallet ? -1 : 1)), excluded: [] };
  const again = JSON.parse(JSON.stringify(snap));
  assert.equal(canonicalHash(snap), canonicalHash(again));
  assert.equal(canonicalHash(snap).length, 64);
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

/* -------------------------------------------------------------------- log */

test('redact strips base58 secrets and credential-shaped keys', () => {
  const kp = makeKeypair();
  assert.equal(kp.secretBase58.length >= 80, true);
  assert.equal(redact(`key=${kp.secretBase58} end`), 'key=[redacted] end');
  assert.equal(redact(kp.address), kp.address, 'a 32-byte address is not a secret');
  assert.deepEqual(redact({ vaultSecretKey: kp.secretBase58, address: kp.address }), {
    vaultSecretKey: '[redacted]',
    address: kp.address,
  });
  assert.deepEqual(redact({ nested: [{ SESSION_SECRET: 'x' }] }), { nested: [{ SESSION_SECRET: '[redacted]' }] });
  const circular = { a: 1 };
  circular.self = circular;
  assert.deepEqual(redact(circular), { a: 1, self: '[circular]' });
  assert.equal(typeof createLogger('test').info, 'function');
});
