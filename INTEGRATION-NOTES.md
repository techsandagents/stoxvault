# Integration notes (verified live 2026-09-07, main loop)

## Price history sources — all probed for real

**Yahoo** `https://query1.finance.yahoo.com/v8/finance/chart/<sym>?range=1mo&interval=1d`
with `User-Agent: Mozilla/5.0` returns 200 and 23 daily candles for every mapped ticker:
NVDA AAPL GOOGL MSFT AMZN AVGO META TSLA BRK-B SPY PLTR KO QQQ MCD GLD HOOD MSTR STRC COIN.
That covers 19 of the top 20 directly; the twentieth is SPCX, below.

**SPCXx (SpaceX) DOES have a Yahoo symbol: `SPCX`.** SpaceX IPO'd on Nasdaq on 2026-06-12 at
$135/share (largest IPO in history, $75B raised on 555.6M shares) and now trades near $148 with a
market cap around $1.95T. Jupiter's stockData.mcap of 1950.2B is therefore CORRECT and SpaceX
genuinely ranks #6 by underlying market cap, above Broadcom and Meta. Yahoo returns 23 candles
for SPCX on NasdaqGS ("Space Exploration Technologies"). The seed file is patched:
SPCXx.yahooSymbol = "SPCX". **All 20 top-ranked stocks have real OHLC candles.**

Sanity-checked implied share counts against the feed before trusting it: TSLA 3.96B, NVDA 24.24B,
AAPL 14.59B, KO 4.30B — all correct. The feed is trustworthy for ranking.

**Universal fallback, no per-symbol mapping needed:**
`https://api.coingecko.com/api/v3/coins/solana/contract/<MINT>/market_chart/?vs_currency=usd&days=30`
Verified against the SpaceX xStock mint `Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8` → 721 points.
Close-only, so it renders as a line chart, not candles. Keep it for any FUTURE xStock with no
Yahoo listing (Backed lists private companies periodically), not for a current top-20 name. Mark `source: 'coingecko'` and
`kind: 'line'` in the response so the front end picks the right renderer.
The `coins/<id>/market_chart` form also works (`spacex-xstocks`), but the contract form
needs no id table and should be preferred.

**Stooq is unusable** — it now serves a JavaScript proof-of-work challenge. Do not add it.

## Chain facts — verified by RPC against the live TSLAx mint
- xStocks are **Token-2022** (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`), **8 decimals**.
- Extensions present: `metadataPointer`, `permanentDelegate`, `defaultAccountState (initialized)`,
  `scaledUiAmountConfig (multiplier 1)`, `pausableConfig (paused false)`,
  `confidentialTransferMint`, `transferHook (programId: null)`, `tokenMetadata`.
- `transferHook.programId` is **null** → no hook program to satisfy, plain `transferChecked`
  works. If Backed ever sets a hook program this breaks; the distributor should read the mint's
  extensions once per round and fail loudly rather than silently if a hook appears.
- `permanentDelegate` and `pausableConfig` are held by Backed. Worth one line in the site's
  risk disclosure: the issuer can pause transfers or claw back. This is a property of xStocks,
  not of this project.
- `scaledUiAmountConfig.multiplier` is 1 today. If Backed ever applies a stock split it changes,
  and raw amounts stay correct while UI amounts scale. Store raw, display scaled.

## Vault
Generated locally, secret only in `server/.env`: `769fv6KK6SAQ5FBAXdUZLdrppdHn5CqqgJBpFCLyf9up`
Confirmed the base58 secret loads in `@solana/web3.js` `Keypair.fromSecretKey` and derives
exactly that address.
