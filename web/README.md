# STOCKDROP — web

Static site. No build step, no bundler, no npm. `public/` is the deploy root:
plain HTML, four CSS files and a handful of ES modules that the browser loads
directly.

```
public/
  index.html            the shell — owned by the HTML/CSS layer, see ../DOM.md
  css/{tokens,base,layout,components}.css
  assets/{logo,favicon}.svg
  js/
    config.js           classic script: sets window.STOCKDROP.apiBase
    app.js              type="module": boot, polling, countdown, wallet session
    api.js              one typed wrapper per endpoint in ../../CONTRACT.md §5
    wallet.js           Phantom / Jupiter / Solflare, message signature only
    format.js           money, percents, base-unit amounts, UTC times
    charts.js           inline-SVG donut + sparkline, lightweight-charts candles
    ui/                 one module per section (tape, stocks, basket, vault,
                        rounds, demand, toast)
```

---

## Run it locally

The page is static, but it must be served over `http://` — ES modules and
`localStorage` do not work from a `file://` URL.

Any static server will do. With Node already on the machine:

```bash
cd web/public
npx serve .            # or: npx http-server -p 5173 .
```

or with Python:

```bash
cd web/public
python -m http.server 5173
```

Then open <http://localhost:5173>.

### Point it at a server

`js/config.js` resolves the API host in this order:

1. `?api=<url>` on the page URL — a one-off override for debugging
2. `http://localhost:4700` when the page itself is served from localhost
3. the `<meta name="api-base">` tag in `index.html`
4. `https://stockdrop-production.up.railway.app`

Localhost outranks the meta tag on purpose: the shipped tag points at Railway,
so without that rule a page opened locally would quietly talk to production.
`?api=` still wins, so a local page can be aimed at a remote server deliberately.

So a page served from `localhost` talks to a local server by default:

```bash
cd server && npm start          # boots on :4700
cd web/public && npx serve .    # open http://localhost:5173
```

The server needs `CORS_ORIGIN` to allow the page's origin. The default is `*`,
which is fine for local work; set it explicitly in production.

To run the local page against the deployed API without editing anything:

```
http://localhost:5173/?api=https://stockdrop-production.up.railway.app
```

The footer always prints which host the page is actually talking to, so there
is no guessing.

---

## Deploy

Vercel, static, no framework. `web/vercel.json` already sets
`outputDirectory: public` and `cleanUrls`. The only thing to change per
environment is one line in `public/index.html`:

```html
<meta name="api-base" content="https://stockdrop-production.up.railway.app">
```

Point it at the Railway URL for the server and redeploy. Nothing else in the
front end knows a hostname.

---

## What the front end does and does not do

- **It never signs a transaction.** `wallet.js` has exactly one wallet
  operation, `signMessage`. There is no code path to `signTransaction`,
  `signAndSendTransaction` or any RPC that moves value. Connecting costs
  nothing and cannot move a token.
- **It never invents a number.** Every figure on the page came from an API
  response in the current session. A failed request flips that section to its
  error pane; it does not fall back to a placeholder. Before the token launches,
  the identity strip stays on `TBA — not launched` and no holder count, price or
  eligibility figure is shown.
- **It labels simulated data.** When the server reports `mode !== 'LIVE'` the
  hero carries a `Simulated` badge, the projection panel carries one, and every
  round with `simulated: true` carries one in the ledger. A `tx` of `null`
  renders as the word `simulated`, never as a link.
- **Token amounts are BigInt all the way.** Base-unit strings from the API are
  converted with `BigInt` in `format.js`; `parseFloat` is never applied to a
  token amount. The full-precision value is in each cell's `title`.

## Wallet support

Three wallets, discovered through the Wallet Standard
(`wallet-standard:app-ready` / `wallet-standard:register-wallet`, matching
`wallet.name` case-insensitively) with the injected providers
`window.phantom.solana`, `window.solflare` and `window.jupiter.solana` as a
fallback:

| Wallet | Install |
|---|---|
| Phantom | <https://phantom.com> |
| Jupiter | <https://jup.ag> |
| Solflare | <https://solflare.com> |

Sign-in is `connect()` → `POST /api/auth/nonce` → `signMessage(message)` →
`POST /api/auth/verify` → bearer token in `localStorage` → `GET /api/me`. The
message text is the server's, byte for byte. Saving a basket asks for a second
signature over the picks themselves, so the stored preference is a public record
anyone can verify; if the wallet is unavailable after a reload the basket still
saves under the session token and the UI says so plainly.

## Polling

| What | Every |
|---|---|
| countdown | 1s |
| universe (tape, table, prices) | 30s |
| stats, community demand, `/api/me` | 60s |
| vault | 60s |
| rounds ledger | 5min |

All polling stops on `visibilitychange` when the tab is hidden and resumes with
an immediate refresh when it comes back.

## Editing rules

`public/index.html` and `public/css/*` are owned by the shell. The JS layer only
fills the slots and flips the states documented in `../DOM.md` — it never writes
markup by hand, never sets a colour from JS, and clones a `<template>` for every
repeated row.
