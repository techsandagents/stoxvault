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
    package.json               pre-created. deps: @solana/web3.js 1.98, @solana/spl-token 0.4, express, cors, pg
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
    src/services/session.js    nonce + HMAC session tokens + ed25519 signature verification (node:crypto)
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

`CFG.mode` = `'LIVE' | 'DRY_RUN' | 'READ_ONLY'` (read-only when no vault secret).
`CFG.rules` = `{ minPicks: 2, maxPicks: 5, minPct: 10, maxPct: 60, eligibleBps, intervalHours, universeSize, defaultBasketSize }`.

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

Holder { wallet, balance: string (base units, bigint as string) }
Snapshot { takenAt, slot, tokenMint, supply, eligibleThreshold, holders: Holder[] (eligible only), excluded: string[], hash (sha256 of canonical JSON) }

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
  snapshot: Snapshot | null,
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

Auth (one message signature, never a transaction):
- `POST /api/auth/nonce` body `{ wallet }` → `{ nonce, message, expiresAt }`. Message text, exactly these lines joined by `\n`:
  ```
  STOCKDROP
  Sign to verify you own this wallet.
  This is not a transaction. Nothing leaves your wallet.
  Wallet: <wallet>
  Nonce: <nonce>
  Issued: <ISO time>
  ```
- `POST /api/auth/verify` body `{ wallet, nonce, signature }` (signature base58 OR base64 of the 64-byte ed25519 sig over the UTF-8 message bytes) → `{ token, wallet, expiresAt, me }` where `me` is the same object as GET /api/me.
  Verification = node:crypto `verify(null, msgBytes, spkiKey(walletPubkeyBytes), sig)`. Nonce is single-use, 10 min TTL.
- Session token: `base64url(json payload).base64url(hmacSha256(SESSION_SECRET, payload))`, 7-day expiry. Sent as `Authorization: Bearer <token>`.

Me (Bearer):
- `GET /api/me` → `{ wallet, balance: {raw, ui, eligible, thresholdUi, pctOfSupply} | null (no token yet), prefs: Prefs|null, effectivePicks: Pick[] (prefs or default top5), projected: { shareBps|null, note } }`
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
computeEligible(holders, { supplyRaw, eligibleBps, excluded }) -> Holder[]   // balance ≥ floor(supplyRaw*bps/10000), not excluded
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
SNAPSHOT    → holders (services/holders) → computeEligible → if none → SKIPPED(no_holders). refresh universe. freeze prefs (allPrefs).
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
- Wallet connect: three options only — **Phantom, Jupiter, Solflare**. Detection via the Wallet Standard (`wallet-standard:app-ready` / `wallet-standard:register-wallet` events, match wallet `name` case-insensitively to phantom / jupiter / solflare) with injected-provider fallback (`window.phantom?.solana`, `window.solflare`). If not installed: button shows "Install" linking to the wallet's site. Connect flow = `connect()` → `POST /api/auth/nonce` → `signMessage(utf8(message))` → `POST /api/auth/verify` → store token in localStorage → `GET /api/me`. NEVER call signTransaction / signAndSendTransaction anywhere.
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
- Web served statically (`npx serve web/public` or any static server) renders every section with live API data, connects Phantom via message signature, saves and reloads picks, works at 375px and 1280px, no console errors.
