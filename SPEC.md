# STOXVAULT (formerly STOCKDROP) — Spec

Memecoin on Solana whose creator fees buy tokenised stocks (xStocks) and drop them
directly into holders' wallets, weighted by each holder's own stock picks.

Date: 2026-09-07. Status: SPEC ONLY, nothing built.

---

## 1. Decisions locked (from the founder)

| # | Question | Decision |
|---|----------|----------|
| 1 | "Top 5" default basket | Top 5 xStocks by underlying company market cap, refreshed every round |
| 2 | Min 10% / max 60% per stock | Yes. Forces at least 2 picks (e.g. 60/40). Max 5 picks. |
| 3 | Stock universe | xStocks (Backed) that have a Jupiter route with real liquidity |
| 4 | Eligibility | Hold >= 0.1% of total supply (= 1,000,000 on a 1B-supply coin) at snapshot |
| 4b | Token-account rent | Project pays. Never deducted from a holder's drop. |
| 5 | Preference storage | Off-chain database. Publicly viewable. Signed message proves wallet ownership. |
| 6 | Excluded wallets | LP / pool vault, bonding curve, dev + team wallets, known CEX deposit wallets, the fee wallet itself, the distributor wallet |
| 7 | Cadence | Every 6 hours (00:00, 06:00, 12:00, 18:00 UTC) |

---

## 2. Components

### 2.1 Token
- Launched on pump.fun (or equivalent). Creator fees accrue to `FEE_WALLET`.
- Supply assumed 1,000,000,000. Eligibility threshold expressed as 0.1% of supply so it survives any supply choice.

### 2.2 Website (`web/`)
- Connect wallet (Phantom / Solflare / Backpack via wallet-adapter).
- Sign a message (no transaction, no gas): `stockdrop:set-prefs:<nonce>:<json>`. Backend verifies signature, stores prefs.
- Picker: choose 2–5 stocks from the live xStocks list, assign integer % each.
  - Validation: each 10–100... no: each in [10, 60], count in [2, 5], sum == 100.
  - UI helper: "auto-balance" button spreads remainder evenly.
- Shows: your current prefs, your current balance, eligible or not, your projected share of the next round, your drop history (tx links).
- Public pages: every wallet's prefs (read-only), every round's ledger. This is what makes off-chain storage trustworthy: anyone can recompute a round.

### 2.3 Backend (`api/`)
- Postgres. Tables: `prefs(wallet, picks jsonb, sig, updated_at)`, `rounds`, `round_holders`, `round_swaps`, `round_transfers`, `excluded_wallets`, `xstocks(mint, symbol, mcap_usd, tradeable, updated_at)`.
- Endpoints: `GET /xstocks`, `GET /prefs/:wallet`, `POST /prefs` (signed), `GET /rounds`, `GET /rounds/:id`, `GET /holder/:wallet`.

### 2.4 Distributor / keeper (`keeper/`)
The "contract" in practice. A cron-driven Node process holding `DISTRIBUTOR_WALLET`.
Every 6h it runs the round algorithm below. Every step is logged and every tx hash is published.

> Why not an on-chain program? With preferences off-chain, an on-chain program can only
> hold the SOL; it still needs an off-chain crank to fetch Jupiter routes, read the holder
> list, and read prefs. The trust gain is small and the build cost is large. Ship the keeper
> with a fully public ledger first. An on-chain vault can be added later without changing
> anything users see.

---

## 3. Round algorithm

```
1. CLAIM      claim pending creator fees from pump.fun into FEE_WALLET
2. POOL       P = FEE_WALLET SOL balance minus a small tx-fee reserve (0.05 SOL)
              if P < MIN_ROUND_POOL (e.g. 0.5 SOL) -> skip round, carry over
3. SNAPSHOT   read all token accounts of the memecoin mint (Helius DAS / getProgramAccounts)
              drop excluded wallets
              drop balances < 0.1% of supply
              eligible_total = sum of remaining balances
              share[h] = balance[h] / eligible_total
4. PREFS      freeze prefs table as of round start (changes after this apply next round)
              for holders with no prefs: the configured DEFAULT_BASKET (currently SPCXx 100%),
              else 20% each on TOP5 (by mcap, refreshed now)
              for holders with prefs whose pick is no longer tradeable: that pick's % is
              redistributed proportionally across their remaining picks
5. DEMAND     for each stock s: D[s] = sum over h of share[h] * w[h][s]      (sums to 1.0)
              sol_in[s] = P * D[s]
6. SWAP       one Jupiter swap per stock: SOL -> xStock, slippage cap 1%, retry x3
              received[s] = actual xStock tokens received (not quoted)
              if a swap fails after retries: its SOL stays in FEE_WALLET for next round
7. ALLOCATE   amount[h][s] = received[s] * (share[h] * w[h][s]) / D[s]
              round down to token base units; leftover dust per stock stays in
              DISTRIBUTOR_WALLET as carry-over, added to received[s] next round
8. TRANSFER   create ATA for (h, s) if missing (project pays rent)
              batch SPL transfers, ~8–12 transfers per tx, priority fee, retry on failure
              a transfer that fails 3x is recorded as PENDING and retried next round
9. PUBLISH    write round record: snapshot hash, pool, TOP5 used, per-stock swap tx,
              per-holder amounts + transfer tx. Site shows it. Anyone can recompute.
```

### Worked example
Pool 10 SOL. Two eligible holders.
- Alice: 3M tokens, prefs TSLAx 60 / NVDAx 40
- Bob: 1M tokens, no prefs -> the default basket (this example predates DEFAULT_BASKET and assumes
  the blank setting: 20% each of TOP5, say NVDAx, AAPLx, MSFTx, GOOGLx, AMZNx)

share: Alice 0.75, Bob 0.25.
Demand: TSLAx 0.45, NVDAx 0.30+0.05=0.35, AAPLx 0.05, MSFTx 0.05, GOOGLx 0.05, AMZNx 0.05.
Swaps: 4.5 SOL TSLAx, 3.5 SOL NVDAx, 0.5 SOL each of the other four.
NVDAx received (say 1.75 tokens): Alice gets 1.75 × 0.30/0.35 = 1.5, Bob gets 0.25.

---

## 4. Rules and edge cases

- **Snapshot timing is unannounced within a ±10 min window** around each 6h mark, to blunt buy-before-snapshot-sell-after gaming. (Time-weighted balances are a v2 option.)
- **Eligibility is per round.** Drop below 0.1% and you skip that round, no penalty.
- **Prefs persist** until changed. No prefs ever = default basket forever.
- **TOP5 list** = xStocks sorted by underlying market cap (from the xStocks/Backed feed or a public equities API), filtered to those with a Jupiter route quoting >= $1k without >1% impact. Recomputed each round and recorded in the round ledger.
- **Delisted / untradeable stock in someone's prefs**: their % for it is spread over their other picks that round; site nags them to update.
- **Minimum drop**: if a holder's amount[h][s] rounds to 0 base units, nothing is sent; no ATA is created. Prevents paying rent for nothing.
- **Rent budget**: ~0.00204 SOL per new ATA. 1,000 eligible holders × 5 stocks = up to ~10 SOL on the first round, near zero afterwards. Funded from `OPS_WALLET`, not the pool. Flagged as the main hidden cost.
- **Fee wallet is single-purpose.** Nothing else ever touches it; its balance minus reserve IS the pool.
- **All math is integer / bigint** in base units. No floats in allocation.
- **Idempotency**: every transfer keyed by (round_id, wallet, mint); a re-run never double-sends.

---

## 5. Not in v1
- On-chain vault / program.
- Selling or rebalancing stocks already sent (holders own them outright; that's the point).
- Time-weighted eligibility.
- Non-xStocks assets.

---

## 6. Open items before build
- Coin name / ticker (folder is `stockdrop` as a placeholder).
- Which xStocks mcap feed: Backed's own list vs a public equities API.
- Hosting: Railway for api+keeper, Vercel for web (same pattern as your other desks).
- Dev/team wallet addresses for the exclusion list.

---

## 7. v0.2 additions (2026-09-07, founder decisions)

| Topic | Decision |
|---|---|
| Stock universe | **Top 20 xStocks** ranked by underlying company market cap (Jupiter price API `stockData.mcap`), filtered to on-chain liquidity >= $50k on Jupiter. Users pick only from these 20. Re-ranked every round and recorded in the ledger. |
| Default basket | Set by `DEFAULT_BASKET` (e.g. `SPCXx:100`). Currently **100% SpaceX**. Blank = top 5 at 20% each. Resolved against the live universe each round, so a ticker that drops out is not bought; if none of the configured tickers survive, it falls back to the top 5. |
| Vault | A dedicated Solana wallet (keypair generated locally, secret only in `.env` / Railway env). Founder sends SOL to the vault address. Every 6h the keeper swaps the vault's SOL into stocks and distributes. No pump.fun claim step; vault balance IS the pool. Vault address shown on the site. |
| Coin name / CA | Blank until launch (`TOKEN_NAME`, `TOKEN_SYMBOL`, `TOKEN_MINT` env). Site shows "TBA" states honestly. |
| Exclusion list | No dev address needed; `EXCLUDED_WALLETS` env (comma list) for LP / bonding curve / vault, filled at launch. |
| Wallets | Phantom, Jupiter, Solflare. Connect = one message signature (no transaction, no balance change). Balance is read server-side via RPC. Helius key via `HELIUS_API_KEY` later. |
| Deploy | `server/` -> Railway (API + keeper in one process). `web/` -> Vercel (static). |
| UI | Professional Wall Street brokerage / terminal aesthetic with a light Solana + memecoin voice. Real charts (candles from Yahoo, live prices from Jupiter, allocation + demand charts). |

Ranking snapshot at spec time (liq >= $50k, by underlying mcap):
NVDAx, AAPLx, GOOGLx, MSFTx, AMZNx, SPCXx, AVGOx, METAx, TSLAx, BRK.Bx, SPYx, PLTRx, KOx, QQQx, MCDx, GLDx, HOODx, MSTRx, STRCx, COINx. (CRCLx is #21.)

Chain facts verified: xStocks are Token-2022 mints, 8 decimals, extensions = permanentDelegate, pausable, scaledUiAmount (multiplier 1), transferHook with programId = null (no hook program -> plain `transferChecked` works), defaultAccountState initialized.
