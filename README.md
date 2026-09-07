# STOCKDROP

A Solana memecoin whose creator fees buy **real tokenised stocks** and send them straight to
holders' wallets — weighted by the stocks each holder picked.

Every 6 hours:

1. The **vault** wallet's SOL balance becomes the round's pool.
2. Holders are snapshotted. Anyone holding at least **0.1% of supply** is eligible.
3. Each holder's share of the pool is spent on **their own picks** — 2 to 5 stocks from the
   **top 20 xStocks by company market cap**, each between 10% and 60%, summing to 100%.
4. Holders who never picked get the **default basket**, set by `DEFAULT_BASKET`. It is currently
   **100% SpaceX (SPCXx)**. Leave the setting blank for the top 5 at 20% each.
   A one-stock default is five times cheaper to deliver, because the project pays a token-account
   rent of about 0.002137 SOL per holder per stock.
5. Demand is aggregated, so it is **one swap per stock**, then the stock tokens are split back
   out pro-rata and transferred. Account rent is paid by the project, never deducted from a drop.
6. The full ledger is published: snapshot hash, per-stock swap tx, per-holder amount and tx.
   Anyone can recompute a round from the published document.

**Vault address:** `769fv6KK6SAQ5FBAXdUZLdrppdHn5CqqgJBpFCLyf9up`

Send SOL there to fund a round. That address is the only place funds sit, and it is shown on
the site.

---

## Live

| | |
|---|---|
| Site | https://stockdrop-ten.vercel.app |
| API | https://stockdrop-production.up.railway.app |
| Vault | `769fv6KK6SAQ5FBAXdUZLdrppdHn5CqqgJBpFCLyf9up` |

## Status

| | |
|---|---|
| Coin | **not launched** — name, ticker and mint are intentionally blank |
| Mode | `LIVE=0` → DRY_RUN. Rounds are computed and quoted for real, but nothing is sent on chain. |
| Stocks | xStocks by Backed, traded through Jupiter. Top 20 by underlying company market cap, filtered to real on-chain liquidity. |

Flip `LIVE=1` only after the coin exists, `TOKEN_MINT` is set, `EXCLUDED_WALLETS` lists the LP
and bonding-curve accounts, and the vault holds enough SOL to cover the pool plus rent.

---

## Layout

```
server/   Node 20 API + keeper. One process. Deploys to Railway.
web/      Static site, no build step. Deploys to Vercel.
SPEC.md       product spec and round algorithm
CONTRACT.md   binding interface: env, data model, store, HTTP API, engine, keeper, design brief
```

## Run locally

```bash
cd server
cp ../.env.example .env    # then set what you need; VAULT_SECRET_KEY is already generated
npm install
npm test
npm start                  # http://localhost:4700
```

```bash
cd web/public && npx serve .
```

The site points at `http://localhost:4700` automatically when served from localhost. To point it
elsewhere, edit the `<meta name="api-base">` tag in `web/public/index.html`.

Rehearse a full round against real Jupiter quotes with a synthetic holder set (this is the
fastest way to see exactly what a round does, and it fails if anything tries to send):

```bash
cd server && npm run rehearse -- 25
```

Run one round by hand:

```bash
cd server && npm run round -- --dry
```

## Deploy

See [DEPLOY.md](DEPLOY.md).

---

## What this is not

- Not investment advice, and not a fund. Holders receive tokens; nobody manages them afterwards.
- Not affiliated with Jupiter, Backed Finance, Robinhood, or any listed company. xStocks are
  issued by Backed; this project only buys them on the open market.
- The vault is a hot wallet operated by the project. It holds only what is sent for the next round.
