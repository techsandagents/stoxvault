# Deploy runbook

**Deployed 2026-09-07.** Server: https://stockdrop-production.up.railway.app (Railway project `stockdrop`).
Site: https://stockdrop-ten.vercel.app (Vercel project `stockdrop`, root `web/`).
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

## 3. Go-live checklist

- [ ] Coin launched. `TOKEN_MINT`, `TOKEN_NAME`, `TOKEN_SYMBOL` set on Railway.
- [ ] `EXCLUDED_WALLETS` contains the LP / bonding-curve accounts. Verify each on Solscan.
- [ ] Postgres attached and `DATABASE_URL` set. Restart and confirm rounds persist.
- [ ] Helius key set. Holder snapshots on a public RPC will rate-limit past a few thousand holders.
- [ ] Vault funded with the pool **plus** a rent buffer. Roughly 0.002 SOL per new stock account
      per holder on the first round: 1,000 holders × 5 stocks ≈ 10 SOL once, then near zero.
- [ ] Run `npm run rehearse -- 25` and confirm both checks PASS. It runs a whole round against real
      Jupiter quotes with a synthetic holder set, and fails loudly if anything tries to send.
- [ ] Run `npm run round -- --dry` against production config and read the whole plan.
- [ ] Only then set `LIVE=1`.

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
