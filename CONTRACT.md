# STOCKDROP — Build Contract

This is the binding interface document for everyone building in this repo. If you need to
deviate, change THIS file first and say so in your report. Read SPEC.md for the why.

Working name is STOCKDROP. Coin name, ticker and mint are intentionally BLANK until launch:
the UI must render honest "TBA / not launched" states, never placeholders that look real.

Vault address (public, real, generated 2026-09-07): `769fv6KK6SAQ5FBAXdUZLdrppdHn5CqqgJBpFCLyf9up`
The secret lives only in `server/.env` (gitignored) and later in Railway env. Never log it, never
send it to the browser, never write it anywhere else.

---

## 1. Repo layout

```
stockdrop/
  SPEC.md  CONTRACT.md  README.md  .env.example  .gitignore
  server/                      Node 20, ESM, Express. Deploys to Railway. API + keeper in ONE process.
    package.json               deps: @solana/web3.js 1.98, @solana/spl-token 0.4, @noble/curves 1.9.7, express, cors, pg
    railway.json
    .env                       local secrets (gitignored)
    data/xstocks.seed.json     snapshot of all 100 xStocks with Yahoo symbol mapping (seed / offline fallback)
    data/state/                JSON store when DATABASE_URL is blank (gitignored)
    scripts/gen-vault.mjs      done
    scripts/run-round.mjs      CLI: run one round now (respects LIVE)
    src/index.js               entry: loads config, opens db, starts API, starts scheduler
    src/config.js              env parsing, all defaults, derived values (vault pubkey, rpc url, mode)
    src/db/index.js            openDb(config) -> Store (see §4). Picks pg or json.
    src/db/pg.js  src/db/json.js
    src/api/                   express routers: public.js, auth.js, me.js, rounds.js, admin.js
    src/services/universe.js   ranks top-20 from Jupiter, caches, refreshes hourly
    src/services/history.js    candles from Yahoo (cache 1h), fallback CoinGecko
    src/services/holders.js    holder snapshot via RPC (Helius getTokenAccounts when key present, else getProgramAccounts)
    src/services/session.js    nonce + HMAC session tokens + EIP-191 secp256k1 verification (@noble/curves)
    src/engine/                PURE functions, no IO, bigint math: ranking.js, validate.js, allocate.js, round.js
    src/chain/                 rpc.js, jupiter.js (quote/swap/price), distributor.js (Token-2022 transfers), vault.js (keypair)
    src/keeper/                scheduler.js (6h + jitter), runner.js (state machine, resumable)
    test/                      node:test files. `npm test` must pass.
  web/                         static site, no build step. Deploys to Vercel (outputDirectory = public).
    vercel.json
    public/index.html  public/css/*  public/js/*  public/assets/*
    public/js/config.js        window.STOCKDROP = { apiBase }
```

Ownership during the parallel build (do not edit files you don't own; add new files only inside your area):
- FOUNDATION agent: `src/config.js`, `src/db/*`, `src/index.js` skeleton, `test/db.test.js`
- API agent: `src/api/*`, `src/services/*`, `src/index.js` (wire routers), `test/api*.test.js`
- ENGINE agent: `src/engine/*`, `src/chain/*`, `src/keeper/*`, `scripts/run-round.mjs`, `test/engine*.test.js`, `test/keeper*.test.js`
- WEB agent: everything under `web/`

---

## 2. Environment (server/src/config.js exports `CFG`)

| env | default | meaning |
|---|---|---|
| PORT | 4700 | |
| LIVE | 0 | `0` = DRY_RUN: compute everything, simulate swaps with Jupiter quotes, persist rounds flagged `simulated:true`, send NOTHING on chain. `1` = real. |
| RPC_URL | https://api.mainnet-beta.solana.com | |
| HELIUS_API_KEY | "" | when set: `rpcUrl = https://mainnet.helius-rpc.com/?api-key=KEY` and holder snapshots use Helius DAS `getTokenAccounts` |
| DATABASE_URL | "" | Postgres. blank → JSON file store |
| DATA_DIR | ./data/state | json store dir |
| VAULT_SECRET_KEY | "" | base58 64-byte. blank → server runs read-only (no keeper), `config.vault = null` |
| VAULT_ADDRESS | derived | public key. If VAULT_SECRET_KEY is set, derived from it and must match if both present. |
| TOKEN_MINT | "" | blank → "not launched": no holder snapshot, rounds SKIPPED with reason `no_token` |
| TOKEN_NAME / TOKEN_SYMBOL | "" | blank → UI shows TBA |
| TOKEN_SUPPLY | 1000000000 | ui units |
| TOKEN_DECIMALS | 6 | |
| ELIGIBLE_BPS | 10 | eligible if balance ≥ supply × bps / 10000 (0.1% = 1,000,000 on 1B) |
| EXCLUDED_WALLETS | "" | comma list. Vault address is ALWAYS excluded in addition. |
| ROUND_INTERVAL_HOURS | 6 | rounds at 00/06/12/18 UTC |
| ROUND_JITTER_MIN | 10 | snapshot taken at a random offset within ±jitter of the mark (jitter seeded per round, recorded) |
| ANTICHEAT | 1 | `cfg.antiCheat`. `1` = a wallet is weighted on **min(open, close)** across the whole cycle (§7). `0` = the old, gameable close-snapshot-only rule, and every round says so (`snapshotMode: 'close-only'`). |
| OPEN_SNAPSHOT_WINDOW_MIN | 60 | `cfg.openSnapshotWindowMin`. Length, in minutes, of the window at the **start** of a cycle inside which that cycle's OPEN snapshot is taken. Capped at `intervalHours/4` by the scheduler so it can never leave its own cycle. |
| MIN_ROUND_POOL_SOL | 0.5 | below this the round is SKIPPED (`low_pool`) and SOL carries over |
| FEE_RESERVE_SOL | 0.05 | flat floor always left in the vault. It is NOT the rent budget: each round additionally reserves its own measured ATA rent + per-tx fees (§7, `Round.rentEstimate`) before splitting the pool. |
| UNIVERSE_SIZE | 20 | |
| DEFAULT_BASKET_SIZE | 5 | |
| LIQ_MIN_USD | 50000 | Jupiter `liquidity` filter before ranking |
| SLIPPAGE_BPS | 100 | |
| PRIORITY_FEE_LAMPORTS | 200000 | |
| ADMIN_KEY | "" | blank → admin routes return 503 |
| SESSION_SECRET | random per boot if blank (log a warning) | HMAC key for session tokens |
| CORS_ORIGIN | * | |
| JUP_BASE | https://lite-api.jup.ag | |
| AUTH_CHAIN_ID | 4663 | the EVM chain sign-in is bound to. Robinhood Chain mainnet is 4663 (`0x1237`); testnet is 46630. Goes into the EIP-4361 `Chain ID` field |
| AUTH_CHAIN_NAME | Robinhood Chain | display only |
| AUTH_CHAIN_RPC_URL | https://rpc.mainnet.chain.robinhood.com | verified live 2026-09-23; public fallback `https://robinhood-rpc.publicnode.com` |
| SITE_ORIGIN | https://stoxvault.vercel.app | EIP-4361 domain binding: `cfg.authDomain` is its host, `cfg.authUri` its origin. A signature collected by another site does not rebuild to this message |

`CFG.walletChain` = `'evm'`, `CFG.payoutChain` = `'solana'`, `CFG.walletChainMatchesPayout` = `false`.
That last flag is the single switch every honest state on the site hangs off (§5 `attribution`): while it is
false, a connected wallet can prove it is yours but can never be matched to a holder, shown a balance or paid.

`CFG.mode` = `'LIVE' | 'DRY_RUN' | 'READ_ONLY'` (read-only when no vault secret).
`CFG.rules` = `{ minPicks: 2, maxPicks: 5, minPct: 10, maxPct: 60, eligibleBps, intervalHours, universeSize, defaultBasketSize, antiCheat, openSnapshotWindowMin }`.

---

## 3. Data model

```ts
Stock {
  mint, symbol, name, logo, decimals (8), tokenProgram, yahooSymbol,
  priceUsd, change24h, underlyingMcap, underlyingPrice, liquidityUsd, holderCount,
  rank (1..20 within the current universe), isTop5
}
Universe { updatedAt, source, stocks: Stock[20], all: Stock[] (every liquid xStock, for reference) }

Pick { mint, symbol, pct }             // pct integer 10..60
Prefs { wallet, picks: Pick[], signature, message, updatedAt }   // stored as signed by the user
                                       // `wallet` is an EIP-55 EVM address (§5); `signature` is EIP-191 hex.
                                       // `Holder.wallet` below is still a base58 SOLANA address — the two
                                       // are different chains and, today, never the same set.

Holder { wallet, balance: string (base units, bigint as string),
         openBalance?, closeBalance?: string, reduced?: true }   // the last three only under the full-cycle rule (§7)
Snapshot { takenAt, slot, tokenMint, supply, eligibleThreshold, holders: Holder[] (eligible only), excluded: string[], hash (sha256 of canonical JSON) }

CycleSnapshot {                        // one end of a cycle, stored in kv, not on the round
  kind: 'open'|'close', roundId, forRoundId?, mode: 'LIVE'|'DRY_RUN',
  takenAt, slot, tokenMint, supply,
  holders: Holder[],                   // RAW, not filtered by the eligibility threshold:
                                       // the threshold is applied to min(open, close), so a
                                       // pre-filtered end would hide the balance that minimum needs
  holderCount, source, cycleStart, scheduledFor, hash
}
SnapshotRef { takenAt, slot, hash, holderCount, source, roundId, key, mode, opensRoundId? }  // as recorded on a Round

Round {
  id (e.g. r_2026-09-07T12), scheduledAt, startedAt, finishedAt, jitterMin: number|null,
  status: 'PENDING'|'SNAPSHOT'|'SWAPPING'|'DISTRIBUTING'|'DONE'|'SKIPPED'|'FAILED',
  mode: 'LIVE'|'DRY_RUN',            // the mode the round was OPENED in; it never changes
  simulated: boolean,                // === (mode !== 'LIVE')
  skipReason: 'no_token'|'no_vault'|'low_pool'|'no_holders'|'rent_unfunded'|null,
  balanceLamports: string,           // vault SOL at PENDING
  poolLamports: string,              // what the round may actually spend (after reserve + rent + fees)
  reserveLamports: string,           // FEE_RESERVE_SOL + rentEstimate.totalLamports
  rentEstimate: {                    // null until SNAPSHOT; recorded so the ledger explains the SOL
    accounts: number,                //   max recipient token accounts = Σ (holder, stock) pairs
    perAccountLamports: string,      //   rent-exempt minimum for a 170-byte Token-2022 account
    rentLamports: string,            //   accounts × perAccountLamports  (the project pays, SPEC §4)
    txCount: number,                 //   swap txs + transfer batches (8 recipients per batch)
    feeLamports: string,             //   txCount × (5000 + PRIORITY_FEE_LAMPORTS)
    totalLamports: string,           //   rentLamports + feeLamports
    source: 'rpc'|'constant',        //   getMinimumBalanceForRentExemption, else 2074080 lamports
    grossPoolLamports, netPoolLamports: string
  } | null,
  universe: Stock[20] (as used), top5: string[] (mints),
  snapshot: Snapshot | null,            // the EFFECTIVE holder set the round paid: balances are
                                        //   min(open, close) when the full-cycle rule applied
  snapshotMode: 'full-cycle'|'prev-close'|'close-only'|null,
  openSnapshot: SnapshotRef | null,     // which snapshot opened this cycle (null under close-only)
  closeSnapshot: SnapshotRef | null,    // the snapshot taken at the round itself
  antiCheat: {                          // null until SNAPSHOT
    enabled: boolean,                   //   cfg.antiCheat
    mode: same as snapshotMode,
    rule: 'weight = min(openBalance, closeBalance)',
    windowMin: number,
    note: string|null,                  //   why the rule was weakened, when it was. NEVER silent.
    stats: {                            //   null under close-only (there is nothing to combine)
      wallets, openHolders, closeHolders, held, joinedThisCycle, leftThisCycle,
      reduced, steady, zeroWeight,      //   counts, including the wallets that carry no weight
      openWeight, closeWeight, weight: string   //   bigint sums; weight ≤ min(openWeight, closeWeight)
    } | null,
    joinedThisCycle: [{ wallet, closeBalance }],            // bought mid-cycle: paid NEXT round
    leftThisCycle:   [{ wallet, openBalance }],             // sold before the close: paid nothing
    reduced:         [{ wallet, openBalance, closeBalance }]// weighted below one end of the cycle
  } | null,
  demand: [{ mint, symbol, weight: string /*bigint*/, shareBps: number, solLamports: string }],
  swaps:  [{ mint, symbol, solLamports, quotedOut, receivedRaw, beforeRaw, tx: string|null,
             status: 'PENDING'|'SENDING'|'DONE'|'FAILED'|'SKIPPED'|'UNRESOLVED', error }],
  transfers: [{ wallet, mint, symbol, amountRaw: string, tx: string|null, status: 'PENDING'|'DONE'|'FAILED'|'SKIPPED_DUST', error }],
  carryIn:  [{ mint, amountRaw }], carryOut: [{ mint, amountRaw }],
  undelivered: [{ mint, amountRaw }],   // bought but not delivered; included in carryOut
  resumeFrom: string|null,              // the step a FAILED round died in (`--retry <id>`)
  modeMismatch: { roundMode, processMode } | null,
  stats: { eligibleHolders, prefHolders, defaultHolders, transfersDone, transfersFailed,
           transfersSkippedDust, swapsDone, swapsFailed, swapsUnresolved,
           solSpentLamports, solUnresolvedLamports }
  error: string|null
}
```

Swap statuses:
- `PENDING` nothing sent. `SKIPPED` its share of the pool floored to 0 lamports.
- `SENDING` **the vault signed this transaction and handed it to the cluster; the outcome is not
  known yet.** The row carries the signature and `beforeRaw` (the vault's balance of that mint
  before the first attempt) and is written BEFORE `sendRawTransaction`, so a crash between the two
  leaves evidence. A `SENDING` row is always reconciled on resume, never re-sent.
- `DONE` the tokens are in the vault; `receivedRaw` in LIVE is the measured balance delta from
  before the FIRST attempt, so a fill from any attempt is counted.
- `FAILED` nothing landed and nothing can: the SOL stayed in the vault and joins the next pool.
- `UNRESOLVED` a signature exists and the chain will not say what happened to it. The SOL may or
  may not be gone, so the keeper stops touching this allocation: it is never re-sent, not even by
  `--retry`, and an operator settles it against `tx` by hand.

All token amounts cross the API as **strings of base units** plus a `decimals` field, and as ui numbers only in clearly-named `*Ui` fields.

---

## 4. Store interface (`src/db/index.js` → `openDb(cfg)` returns this; both pg and json implement it)

```js
{
  // prefs
  getPrefs(wallet) -> Prefs|null
  setPrefs(prefs) -> Prefs
  deletePrefs(wallet) -> void
  listPrefs({limit=100, offset=0}) -> { items: Prefs[], total }
  allPrefs() -> Prefs[]                          // keeper use
  // nonces / sessions
  putNonce(wallet, nonce, expiresAt) ; takeNonce(wallet, nonce) -> boolean (consumes; false if missing/expired)
  // rounds
  createRound(round) -> Round ; updateRound(id, patch) -> Round ; getRound(id) -> Round|null
  listRounds({limit=50, offset=0}) -> { items: Round[] (without transfers array, with stats), total }
  latestRound() -> Round|null
  unfinishedRound() -> Round|null                 // status not in DONE/SKIPPED/FAILED — used for resume
  // transfers are stored inside the round document for json; a separate table for pg. Either way:
  markTransfer(roundId, wallet, mint, patch) -> void   // idempotent
  // kv
  getKV(key) -> any|null ; setKV(key, value) -> void     // universe cache, carry-over, last snapshot
  close()
}
```
pg tables: `prefs(wallet pk, picks jsonb, signature, message, updated_at)`, `nonces(wallet, nonce, expires_at)`,
`rounds(id pk, doc jsonb, status, created_at, finished_at)`, `transfers(round_id, wallet, mint, doc jsonb, status, pk(round_id,wallet,mint))`, `kv(key pk, value jsonb)`.
Schema is created on boot if missing (`CREATE TABLE IF NOT EXISTS`).

---

## 5. HTTP API (JSON, prefix `/api`, CORS per config)

Public:
- `GET /api/health` → `{ ok, mode, vault, tokenMint, nextRoundAt, serverTime, version }`
- `GET /api/config` → `{ token: {name, symbol, mint, supply, decimals, launched: bool}, vault: {address}, rules, mode, intervalHours, nextRoundAt }`
- `GET /api/universe` → `Universe` (top 20 + `all`)
- `GET /api/universe/:symbol/history?range=1mo|3mo|1y` → `{ symbol, yahooSymbol, range, candles: [{t,o,h,l,c,v}] , source }` (404 if unknown symbol)
- `GET /api/stats` → `{ mode, launched, vault: {balanceSol, balanceUsd}, solPriceUsd, prefHolders, eligibleHolders|null, rounds: {count, totalSolDistributed, lastAt}, demand: [{symbol, mint, pct}] , demandBasis: 'equal-weight'|'holding-weighted', nextRoundAt }`
  - demand = aggregate community weights over prefs holders. Pre-launch (no mint) it is the plain average of picks (`equal-weight`). Post-launch, weighted by snapshot balance (`holding-weighted`). Always sums to 100.
- `GET /api/vault` → `{ address, balanceSol, balanceUsd, reserveSol, poolSol, holdings: [{symbol, mint, amountRaw, amountUi}] (carry-over dust), updatedAt }`
- `GET /api/prefs/:wallet` → `Prefs` or `{ wallet, picks: null, default: true }`
- `GET /api/holders?limit&offset` → `{ items: [{wallet, picks, updatedAt}], total }`
- `GET /api/rounds?limit&offset` → `{ items, total }` ; `GET /api/rounds/:id` → full Round
- `GET /api/rounds/preview` → what the next round would do NOW: `{ simulated: true, basis: 'live-snapshot'|'no-token', poolSol, demand, top5, note }` (with no token: demand from equal-weight prefs, no per-holder amounts)

Auth (one message signature, never a transaction) — **EVM / Robinhood Wallet since 2026-09-23**:

A **wallet** is a `0x`-prefixed 20-byte EVM address. Input is accepted in any case; the server stores,
compares and displays exactly one canonical spelling, the **EIP-55 checksum** form. `requireWallet` in
`api/router.js` normalises before anything else sees the value, so `0xabc…` and `0xABC…` can never
become two accounts. A base58 Solana address is now `bad_wallet`.

- `POST /api/auth/nonce` body `{ wallet }` → `{ wallet, nonce, message, issuedAt, expiresAt, chainId, chainName, domain, uri }`.
  The message is **EIP-4361 (Sign-In With Ethereum)**, fields in the standard's order:
  ```
  <domain> wants you to sign in with your Ethereum account:
  <wallet, EIP-55 checksummed>

  Sign to verify you own this wallet. This is not a transaction. Nothing leaves your wallet.

  URI: <uri>
  Version: 1
  Chain ID: <chainId>
  Nonce: <nonce>
  Issued At: <ISO time>
  ```
  The statement keeps the two promises word for word. `domain` / `uri` bind the signature to this site and
  `Chain ID` to Robinhood Chain, so a signature collected elsewhere, or for another chain, does not rebuild
  to this text and is refused. The nonce is 24 alphanumeric characters (8 base36 digits of the issue time +
  16 hex of randomness, no separator — EIP-4361 forbids one) and carries its own issue time, so the server
  rebuilds the exact message from `{wallet, nonce}` alone.
- `POST /api/auth/verify` body `{ wallet, nonce, signature }` → `{ token, wallet, expiresAt, me }` where `me` is the same object as GET /api/me.
  `signature` is a 65-byte `r || s || v` **EIP-191 personal_sign** signature as `0x` hex (bare hex and base64 are also accepted).
  Verification: `keccak256("\x19Ethereum Signed Message:\n" + byteLength(message) + message)`, secp256k1 public-key
  recovery, and the last 20 bytes of `keccak256(uncompressed pubkey without its 0x04 tag)` must equal the claimed wallet.
  `v` may be 27/28 or 0/1. **An upper-half `s` is refused (EIP-2)** so one signature cannot be replayed in its
  malleable twin. Curve and hash come from `@noble/curves` / `@noble/hashes` — the only dependency this change
  added, and no elliptic-curve maths is hand-rolled on an auth path. Nonce is single-use, 10 min TTL, and is
  burned before the signature is checked.
- Session token: `base64url(json payload).base64url(hmacSha256(SESSION_SECRET, payload))`, 7-day expiry, `v: 2`. Sent as `Authorization: Bearer <token>`.

Me (Bearer):
- `GET /api/me` → `{ wallet, balance: … | null, attribution, prefs, effectivePicks, picksSource, projected, cycle, nextRoundAt }`
- **`attribution` is the honest state, and it is the point of the EVM move.** Sign-in is an EVM address; holder
  balances, eligibility and every payout still read a SOLANA token, and the keeper still pays out on Solana. An
  EVM address can never appear in a Solana holder snapshot, so the server does not read a balance at all while
  the two disagree — "we did not look, and here is why" is the truth, and "we looked and you hold zero" is not.
  ```ts
  attribution: {
    signInChain: 'evm', signInChainId: number, signInChainName: string,
    payoutChain: 'solana',
    chainsMatch: boolean,      // cfg.walletChainMatchesPayout — false today
    tokenSet: boolean,         // cfg.launched
    balanceRead: boolean,      // chainsMatch && tokenSet: the ONLY case a balance is read
    eligible: false,           // hard false while chainsMatch is false. No code path makes it true.
    canReceive: false,
    headline: string, note: string   // each reason named once, and dropped when it stops being true
  }
  ```
  While `balanceRead` is false: `balance` is `null`, `projected.shareBps` is `null` with `attribution.note` as its
  note, and `cycle.eligible` is `null` — unknown, never `false`-as-verdict and never `true`.
- `PUT /api/me/prefs` body `{ picks: [{mint, pct}], signature?, message? }` → validated with engine `validatePicks` → `Prefs`. Errors: 400 `{ error: 'invalid_picks', code, detail }` codes: `count`, `range`, `sum`, `not_in_universe`, `duplicate`.
- `DELETE /api/me/prefs` → `{ ok: true }` (back to default basket)

Admin (`X-Admin-Key`):
- `POST /api/admin/round/run` → runs a round now (respects LIVE) → Round
- `POST /api/admin/universe/refresh` → Universe
- `GET /api/admin/status` → keeper state, last errors, config summary (no secrets)

Errors: JSON `{ error: '<code>', detail?: string }` with proper status codes. Never leak stack traces.

---

## 6. Engine (pure, bigint) — `src/engine/*`

```js
rankUniverse(all: Stock[], { liqMinUsd, size }) -> Stock[size]   // filter liquidity ≥ min, sort by underlyingMcap desc (fallback tokenMcap), assign rank, isTop5 = rank ≤ 5
validatePicks(picks, universe, rules) -> Pick[] (normalized, sorted by pct desc) | throws PickError{code}
defaultPicks(universe, rules) -> Pick[]                           // top5 × 20
combineSnapshots(openHolders, closeHolders) -> { holders, stats }
   // the full-cycle rule, pure. balance = min(open, close) as BigInt, a wallet absent from a
   // snapshot counting as 0. Every wallet seen in EITHER snapshot comes back, flagged
   // joinedThisCycle (open 0, close > 0) or reduced (both > 0 and different); the ones whose
   // minimum is 0 carry no weight but are counted in `stats`. Accepts holder arrays or Snapshots.
computeEligible(holders, { supplyRaw, eligibleBps, excluded }) -> Holder[]   // balance ≥ floor(supplyRaw*bps/10000), not excluded
   // openBalance / closeBalance / reduced pass through untouched when the input carries them, so
   // eligibility is decided by whatever balance the caller supplied — the cycle minimum, under §7.
computeDemand(eligible, prefsByWallet, universe, rules) -> { perStock: Map<mint, {weight: bigint, contributors: [{wallet, weight: bigint}]}>, totalWeight: bigint }
   // weight_hs = balance_h × pct_hs   (bigint). Picks not in the current universe are re-spread across the holder's remaining valid picks pro-rata; if none remain, the holder falls back to default picks.
splitPool(poolLamports: bigint, perStock) -> Map<mint, bigint>     // floor(pool × weight / totalWeight); remainder (≤ nStocks lamports) stays in vault
allocate(receivedRaw: bigint, contributors, carryInRaw: bigint) -> { transfers: [{wallet, amountRaw}], dustRaw }
   // amount_h = floor((received + carryIn) × weight_h / Σweight); amount 0 → SKIPPED_DUST; dust = total − Σ amounts
snapshotHash(snapshot) -> hex sha256 of canonical JSON (sorted keys, holders sorted by wallet)
```
Round math must be **exactly reproducible** from the stored round document by anyone. Tests must include the worked example from SPEC.md §3 and property checks (Σ transfers + dust == received + carryIn; Σ splitPool ≤ pool).

---

## 7. Keeper (`src/keeper/*`)

Scheduler: compute next mark (00/06/12/18 UTC), add jitter in [−J, +J] minutes (deterministic from round id via sha256, recorded in the round as `jitterMin`), sleep, run. On boot: if `unfinishedRound()` exists, RESUME it before scheduling.

**The full-cycle rule (anti-cheat).** One snapshot at round time pays a wallet that bought minutes
before it and sold minutes after: that wallet contributed nothing to the cycle and diluted everyone
who held. So a cycle has TWO snapshots and a wallet's weight for the round is
**`min(openBalance, closeBalance)`** in BigInt.

- The round at mark **T** with interval **I** owns the cycle **(T−I, T]**.
- **OPEN** is taken inside the cycle's FIRST hour, at `T − I + openOffsetFor(roundId)`. The offset is
  `sha256('open:' + roundId)`'s first 6 bytes modulo the window, so it is reproducible and auditable
  but not guessable in advance — the same construction as the round jitter, in its own hash domain.
  The window is `OPEN_SNAPSHOT_WINDOW_MIN` minutes, capped at `I/4`, so it can never land outside its
  own cycle or after the close. `scheduler.planOpenSnapshot(cfg, mark)` returns the whole plan.
- **CLOSE** is the round's own snapshot, already within ±`ROUND_JITTER_MIN` of the mark.
- The **first** reading taken inside the open window is the one the cycle is judged by; a later one
  would be a weaker open, so `takeOpenSnapshot` never overwrites an existing one.

What the rule does, by construction: bought mid-cycle → open 0 → weight 0 → no drop, and the wallet
is in the NEXT cycle's open snapshot, so it is paid then. Sold before the close → close 0 → no drop.
Topped up → weighted on what it held all cycle, not the peak. Held steady → unaffected, to the base
unit. Eligibility (≥ `ELIGIBLE_BPS`) is tested against that same minimum, so the threshold has to be
cleared for the whole cycle, not at one instant.

**Snapshot keys** (kv, split by mode exactly like the carry-over dust):

| key | written by | holds |
|---|---|---|
| `open-snapshot:<roundId>` | the scheduler at the open moment; also the previous round, which writes its close here for the next cycle | that cycle's `CycleSnapshot` |
| `open-snapshot:sim:<roundId>` | the same, in DRY_RUN | |
| `close-snapshot:last` | every round at SNAPSHOT | the newest close `CycleSnapshot`, the fallback open |
| `close-snapshot:sim:last` | the same, in DRY_RUN | |

A DRY_RUN round never reads or writes the LIVE keys and a LIVE round never reads the sim ones. A
rehearsal that consumed the live open snapshot would decide real-looking payouts from it, and one
that overwrote it would destroy the only record of what wallets held during a real cycle.

**Fallback chain** when this cycle has no open snapshot (first round ever, or the keeper was down for
that window), in order — the outcome is always recorded in `Round.snapshotMode`:
1. `open-snapshot[:sim]:<this round id>` → `snapshotMode: 'full-cycle'`.
2. otherwise `close-snapshot[:sim]:last`, provided it is not this round's own close: it was taken at
   the start of this cycle, so it is a legitimate open → `snapshotMode: 'prev-close'`, with a note
   naming when it was taken (and a second note if the two snapshots span more than 1.5 cycles).
3. otherwise the close snapshot alone → `snapshotMode: 'close-only'` and a note on the round saying
   the full-cycle rule could not be enforced for it. `close-only` is exactly the window the rule
   exists to close, so it is never silent: it is on the round document and in the API.

In every case the close snapshot is also written as the NEXT cycle's open (`kind: 'close'`), so the
system is back on the full rule after one round. That write is only a placeholder and loses to a real
one: `takeOpenSnapshot` replaces a stored `close` with a reading taken inside the window (the
unannounced one is the stronger open) and never replaces a stored `open`, and a round refuses to
overwrite an `open` that is already there — a late round and an early open window can overlap. `ANTICHEAT=0` skips all of it: no open snapshot is scheduled or read,
`snapshotMode` is `'close-only'` and `antiCheat.enabled` is false with a note saying it was turned off
by configuration.

The next mark is chosen **strictly after the last mark this keeper handled**, not from the clock
alone (`planNext(cfg, now, afterMark)`; the keeper seeds `afterMark` on boot from
`latestRound().scheduledAt` and updates it before every fire). Jitter is signed: a mark with a
negative jitter fires *before* itself, so a round can finish while its own mark is still in the
future — and a scheduler that only looked at the clock would select that same mark again and again
until it passed, running dozens of junk rounds back to back.

**Mode is a property of the round, not of the process.** A round records the `mode` it was opened
in. On resume, `round.mode !== CFG.mode` is refused: the round is marked FAILED with
`modeMismatch` and an error naming both modes, and a fresh round is opened in the current mode
(an operator who named the round with `--retry` gets the refusal back instead). A simulated round
is never completed with real sends, and a live round is never completed with simulated ones.

Runner state machine (each step persists before proceeding, so a crash resumes idempotently):
```
PENDING     → read vault SOL; pool = balance − reserve. if TOKEN_MINT blank → SKIPPED(no_token). if pool < MIN → SKIPPED(low_pool)
SNAPSHOT    → take the CLOSE snapshot (services/holders) → load this cycle's OPEN snapshot (fallback
              chain above) → combineSnapshots → computeEligible over min(open, close)
              → record openSnapshot / closeSnapshot / snapshotMode / antiCheat on the round, and
                store the close as the next cycle's open + `close-snapshot[:sim]:last`
              → if no eligible holder → SKIPPED(no_holders). refresh universe. freeze prefs (allPrefs).
              plan once to learn the round's shape → rentEstimate (recipient accounts × rent + per-tx fees)
              → pool = pool − rentEstimate.totalLamports; if that is under MIN → SKIPPED(rent_unfunded)
              → re-split the reduced pool. persist demand + rentEstimate.
SWAPPING    → for each stock with solLamports>0 and status PENDING/SENDING (FAILED only with --retry):
              Jupiter quote → DRY_RUN: receivedRaw = quote.outAmount, tx=null, nothing signed.
              LIVE: read the vault's balance of the mint ONCE (beforeRaw) → build → sign → persist the
              row as SENDING with its signature and beforeRaw → send → confirm → receivedRaw = measured
              delta from beforeRaw. Before any further attempt, RECONCILE the previous signature
              (getSignatureStatuses with searchTransactionHistory, plus the vault's balance against
              beforeRaw): landed → adopt it and stop; provably dead (on-chain error, or the blockhash
              expired) → a fresh attempt is safe; unknown → status UNRESOLVED, never a second send.
              3 dead attempts → swap FAILED, SOL stays. persist after each.
DISTRIBUTING→ for each DONE swap: allocate → for each transfer with status PENDING: ensure ATA (Token-2022, payer = vault) + transferChecked, batched 8 per tx (LIVE) / mark DONE with tx=null (DRY_RUN). persist per batch. 3 retries then FAILED (operator re-runs `scripts/run-round.mjs --retry <id>`).
DONE        → undelivered = every transfer that is neither DONE nor SKIPPED_DUST, summed per mint;
              carryOut = allocation dust + undelivered, written to the carry key; stats computed.
```

**Carry-over is keyed by mode.** LIVE writes kv `carry`, DRY_RUN writes kv `carry:sim`, and neither
reads the other. A rehearsal that consumed the live key would fold real dust into fictional
allocations and then overwrite the key with quote-derived numbers, making real tokens in the vault
invisible forever, and would make the next LIVE round allocate more than it received. Only the
latest round may write its carry key.

**Rent is the project's cost, and the round sizes itself around it** (SPEC.md §4: never deducted
from a holder's drop). The vault is the payer for every recipient token account, ~0.00207 SOL each,
so 50 holders on a 5-stock basket is ~0.51 SOL — ten times the flat `FEE_RESERVE_SOL`. The estimate
is an upper bound (accounts that already exist cost nothing) and is recorded on the round as
`rentEstimate`. A round that cannot cover it is SKIPPED with `rent_unfunded` rather than half-paid.

**Nothing bought is ever stranded.** Stock that a round bought but could not deliver stays in the
vault, so it is added to `carryOut` (and listed in `undelivered`) and the next round hands it out.
`--retry` on a round whose undelivered tokens have already carried over to a later round is refused,
because sending them again would spend them twice.
xStocks are Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`), 8 decimals, no transfer-hook program, so `createAssociatedTokenAccountIdempotentInstruction` + `createTransferCheckedInstruction` from @solana/spl-token with `TOKEN_2022_PROGRAM_ID` are sufficient. Rent is paid by the vault (project pays). The memecoin itself is standard SPL Token (pump.fun), 6 decimals.

Jupiter: `GET {JUP_BASE}/swap/v1/quote?inputMint=So111...&outputMint=<mint>&amount=<lamports>&slippageBps=<bps>&restrictIntermediateTokens=true` then `POST {JUP_BASE}/swap/v1/swap` `{ quoteResponse, userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports }` → `swapTransaction` (base64 v0 tx). Sign with web3.js `VersionedTransaction.deserialize` + `tx.sign([vault])`, send with `skipPreflight:false`, confirm by polling `getSignatureStatuses`. Received amount in LIVE mode = **actual** delta of the vault's xStock token balance measured before/after (not the quote).

Prices: `GET {JUP_BASE}/price/v3?ids=a,b,c` → `{ [mint]: { usdPrice, priceChange24h, liquidity, stockData: { price, mcap } } }`.
Universe source: `GET {JUP_BASE}/tokens/v2/search?query=xStock&limit=100` (fields: id, symbol, name, icon, decimals, tokenProgram, liquidity, mcap, holderCount). Fallback: `data/xstocks.seed.json`.

---

## 8. Web (static, vanilla ES modules, no framework, no bundler)

- Loads `public/js/config.js` (sets `window.STOCKDROP.apiBase`; default `http://localhost:4700` when on localhost, else the Railway URL placeholder `https://stockdrop-production.up.railway.app` — read from `<meta name="api-base">` so it is one-line to change).
- Wallet connect: **Robinhood Wallet only**, two routes, because it has no browser extension.
  a) **Injected EVM provider** — EIP-6963 (`eip6963:announceProvider` / `eip6963:requestProvider`, matching
     `info.rdns` then `info.name` against `/robinhood/i`) with an EIP-1193 `window.ethereum` fallback,
     including its `providers` array. This is the Robinhood Wallet in-app browser on a phone.
  b) **WalletConnect** — a QR scanned with the app, the only desktop route. Gated on a project id read from
     `<meta name="walletconnect-project-id">` exactly as `api-base` is read; with none, the option renders
     **disabled with the reason** rather than appearing and failing. The library is a dynamic import from a
     CDN at a pinned exact version (`@walletconnect/ethereum-provider@2.17.0`), fetched only when a project
     id exists. There is no bundler and must not be one.
  Connect flow = `connect()` → check the chain → `POST /api/auth/nonce` → `personal_sign(hex(utf8(message)), address)`
  → `POST /api/auth/verify` → store token in localStorage → `GET /api/me`. **Exactly one signature.**
  `js/wallet.js` routes every provider call through one allow-list — `eth_requestAccounts`, `eth_accounts`,
  `eth_chainId`, `personal_sign`, `wallet_switchEthereumChain`, `wallet_addEthereumChain` — and nothing else is
  reachable. NEVER `eth_sendTransaction`, `eth_sign`, `eth_signTypedData*`, or any token approval, anywhere.
  A chain that is not **Robinhood Chain (4663 / `0x1237`, RPC `https://rpc.mainnet.chain.robinhood.com`)** is
  stated plainly and the switch is offered as a button — `wallet_switchEthereumChain` with
  `wallet_addEthereumChain` as the 4902 fallback. Nothing switches a network silently. Addresses are compared
  with `sameAddress()` (case-insensitive): the wallet says lower case, the server says EIP-55.
- **The site must not imply a connected wallet will receive anything.** Sign-in is EVM, payouts are Solana, and
  the token is not set: `/api/me.attribution` says so and the page renders that sentence verbatim in
  `#proj-chain-note`, alongside a static callout in the wallet modal. No eligible state is invented and no
  balance is shown.
- Charts: TradingView `lightweight-charts` 4.x from unpkg for candles; everything else (donut, bars, sparklines) hand-drawn inline SVG. No chart.js, no random gradients.
- Every number that comes from DRY_RUN / simulated data is labelled "simulated" in the UI. Pre-launch states say "not launched yet". Do not fake holders, rounds, or fills.
- Design brief: see §9.

---

## 9. Design brief (web)

Reference points: Bloomberg terminal density, Nasdaq.com / Robinhood typographic restraint, a brokerage statement's rigor. Then a *light* Solana + memecoin voice in copy and small touches — not in the color system.

- **Palette**: near-black ink `#0B0D10` on paper `#F4F5F7` (light) with an optional dark mode; one accent only, Solana green `#14F195` used at ≤5% of pixels (live dots, active tab underline, primary button), Solana purple `#9945FF` only for the wallet badge. Gains/losses in classic finance green `#0E9F6E` / red `#D83A3A`. No gradients, no glow, no glassmorphism, no purple blobs.
- **Type**: `Inter` for UI, `IBM Plex Mono` (or JetBrains Mono) for every number, address, ticker and table cell. Tabular numerals (`font-variant-numeric: tabular-nums`). Tight hierarchy: one display size, two heading sizes, body 14–15px, table 13px.
- **Layout**: 12-col grid, max-width 1280, 8px spacing scale, hairline rules (`1px` at 8–12% opacity) instead of card shadows. Dense but breathable. Sticky top nav (logo mark, nav, live status pill, connect button). A real **ticker tape** of the 20 stocks under the nav.
- **Sections in order**: nav → tape → hero (one line of value prop + 4 live stats: vault SOL, next round countdown, wallets with picks, total distributed) → *Your basket* configurator (20 stocks as a selectable list with logos, pct steppers, live validation, donut, "projected next drop") → *Top 20* table (rank, logo, ticker, company, price, 24h, mcap, liquidity, 7-day sparkline; row click opens a candle chart drawer) → *Community demand* horizontal bar chart → *Vault* panel (address with copy, balance, reserve, holdings, "send SOL here" callout with QR-less big monospace address) → *Rounds* ledger (table + expandable detail) → *How it works* (rules in plain English, 6 steps) → footer (disclaimers: not investment advice; xStocks are issued by Backed Finance; project is not affiliated with Jupiter, Backed, or any issuer; vault address; source link).
- **Details that separate this from an AI template**: real empty states (e.g. "No rounds yet — first round runs at 18:00 UTC"), hover states on every row, focus rings, keyboard-usable steppers, skeleton loaders, error toasts with retry, the countdown ticks, the tape scrolls and pauses on hover, numbers align, addresses truncate `769f…9up` with copy, tab titles update, favicon exists, `prefers-reduced-motion` respected, 375px mobile layout that actually works (tape, table becomes cards, configurator stacks).
- **Voice**: headline like "Your memecoin buys you Wall Street." Sub: "Creator fees buy real tokenised stocks every 6 hours and send them to holders. You pick the stocks." Microcopy short, no exclamation marks, no emoji in UI chrome.
- **Never**: lorem ipsum, fake testimonials, fake charts, "coming soon" fluff sections, three-feature-card hero, stock-photo illustrations.

---

## 10. Definition of done

- `cd server && npm test` passes; `npm start` boots in DRY_RUN with the JSON store and serves every endpoint in §5 with real Jupiter/Yahoo data.
- `POST /api/admin/round/run` in DRY_RUN with `TOKEN_MINT` blank returns a SKIPPED(no_token) round; with a synthetic holder set injected in tests it produces a fully populated simulated round whose math matches the engine tests.
- Web served statically (`npx serve web/public` or any static server) renders every section with live API data, connects Robinhood Wallet via one `personal_sign` message, saves and reloads picks, works at 375px and 1280px, no console errors.
- `node --test web/test/` passes from the repo root.
- A connected wallet is never shown as eligible and never shown a balance while `walletChainMatchesPayout` is false, on the page and in `/api/me`.
