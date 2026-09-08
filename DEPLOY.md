# Deploy runbook (STOXVAULT)

**Deployed 2026-09-07.** Server: https://stockdrop-production.up.railway.app (Railway project `stockdrop`).
Site: https://stoxvault.vercel.app (Vercel project `stoxvault`, root `web/`). The API keeps its
original hostname (`stockdrop-production`), which is invisible to users; renaming the Railway
service would change that domain and require editing the meta tag in web/public/index.html.
Redeploy the server with `cd server && railway up`, the site with `cd web && vercel deploy --prod --yes`.
The admin key and session secret were generated at deploy time and live only in Railway variables.

Two targets: `server/` on Railway (API + keeper, one process), `web/` on Vercel (static).

---

## 1. Server → Railway

```bash
cd server
railway init          # name: stockdrop
railway up
```

Set variables (Railway dashboard or `railway variables --set`). The vault secret is in
`server/.env` locally — copy the value, never paste it into a file that is tracked:

| variable | value |
|---|---|
| `LIVE` | `0` until launch, then `1` |
| `VAULT_SECRET_KEY` | from `server/.env` |
| `RPC_URL` | public RPC until the Helius key exists |
| `HELIUS_API_KEY` | when available — overrides `RPC_URL` |
| `TOKEN_MINT` | blank until launch, then the pump.fun mint |
| `TOKEN_NAME` / `TOKEN_SYMBOL` | blank until launch |
| `EXCLUDED_WALLETS` | LP vault, bonding curve, any team wallet — comma separated |
| `ADMIN_KEY` | long random string |
| `SESSION_SECRET` | long random string |
| `CORS_ORIGIN` | the Vercel URL once known |
| `DATABASE_URL` | add a Railway Postgres and reference it. Without it the store is a JSON file on the container's ephemeral disk and rounds are lost on redeploy. **Add Postgres before going live.** |

Add a domain: `railway domain`. Note the URL.

## 2. Web → Vercel

Set the API base first: edit `<meta name="api-base" content="...">` in `web/public/index.html`
to the Railway URL.

```bash
cd web
vercel --prod
```

Then set `CORS_ORIGIN` on Railway to the Vercel URL and redeploy the server.

## Custom domain

`stoxvault.com` and `www.stoxvault.com` are attached to the Vercel project and waiting on DNS.
The two records to add at GoDaddy are in [DNS.md](DNS.md).

## 3. Go-live checklist

- [ ] Coin launched. `TOKEN_MINT`, `TOKEN_NAME`, `TOKEN_SYMBOL` set on Railway.
- [ ] `EXCLUDED_WALLETS` contains the LP / bonding-curve accounts. Verify each on Solscan.
- [ ] Postgres attached and `DATABASE_URL` set. Restart and confirm rounds persist.
- [ ] Helius key set. Holder snapshots on a public RPC will rate-limit past a few thousand holders.
- [ ] Vault funded with the pool **plus** a rent buffer. Roughly 0.002 SOL per new stock account
      per holder on the first round: 1,000 holders × 5 stocks ≈ 10 SOL once, then near zero.
- [ ] Run `npm run rehearse -- 25` and confirm both checks PASS. It runs a whole round against real
      Jupiter quotes with a synthetic holder set, and fails loudly if anything tries to send.
- [ ] Run `npm run preflight` against production configuration and read every line. **This is the
      only check that touches mainnet.** It builds the real Jupiter swap and the real
      `createAssociatedTokenAccountIdempotent` + `transferChecked` batch, signs them with the vault
      key, and asks mainnet to *simulate* them. It sends nothing and cannot: the RPC client it hands
      to every module throws on any send, and the transport under it refuses a `sendTransaction`
      body before the socket is written. Seven named checks: vault identity, vault funding, all 20
      mints still Token-2022 / unhooked / unpaused, a real swap transaction, a real distribution
      transaction (with the recipient ATA re-derived independently), rent reserved vs rent charged,
      and the two mode interlocks. Exit code is non-zero only on a genuine FAIL.
      - `NOT FUNDED` and `PASS WITH NOTE` on checks 4 and 5 are expected while the vault is empty —
        they mean the transaction is well formed and the only missing thing is money.
      - Anything else on 4 or 5 is a **FAIL** and must block go-live: it means mainnet rejected an
        instruction we built.
      - Re-run it **after funding the vault** and confirm checks 4 and 5 go to a plain `PASS`. That
        is the only moment the live path is proven end to end.
      - `npm run preflight -- --json` for CI. `npm run preflight -- --prove-guard` deliberately
        trips the send guard and shows all four refusal points firing.
- [ ] Run `npm run round -- --dry` against production config and read the whole plan.
- [ ] Only then set `LIVE=1`.
- [ ] After the first live round, run `npm run preflight` once more: it re-reads the mints, so an
      issuer that later sets a transfer hook or pauses a stock is caught before the next round.

## 4. Operating

- One round every 6 hours at 00:00 / 06:00 / 12:00 / 18:00 UTC, with jitter so the snapshot
  moment cannot be timed.
- Force a round: `POST /api/admin/round/run` with the `X-Admin-Key` header.
- Retry a round's failed transfers: `npm run round -- --retry <roundId>`.
- Watch: `railway logs`.

## 5. If the vault key is ever exposed

Generate a new vault (`npm run gen-vault` after deleting the two lines from `.env`), update
`VAULT_SECRET_KEY` on Railway, move any remaining balance, and publish the new address on the
site. The address is public information; the secret is the only thing that matters.
