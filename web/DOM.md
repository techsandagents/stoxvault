# STOCKDROP — web DOM contract

Everything the JS layer is allowed to touch in `public/index.html`, and how.
The shell (HTML + CSS) is finished and owns all visual decisions. `app.js`
fetches data, fills the slots listed here, and flips the states listed here.
**Do not add new markup patterns** — clone the `<template>` for the row you need.
If something is genuinely missing, add it to this file first.

Files: `public/index.html`, `public/css/{tokens,base,layout,components}.css`,
`public/assets/{logo,favicon}.svg`. You create `public/js/config.js` and
`public/js/app.js` (already referenced at the end of `<body>`; `config.js` is a
classic script and runs first, `app.js` is `type="module"`).

---

## 0. Conventions

| Thing | Meaning |
|---|---|
| `#id` | a unique element, stable forever |
| `[data-field="x"]` | a slot **inside a cloned template** — never has an id |
| `[data-action="x"]` | a click target inside a template (event delegation) |
| `[data-role="x"]` | a structural hook inside a template (a tbody, a logo slot) |
| `[data-cell="x"]` | which table cell this is (drives the mobile card layout) |
| `[data-label="x"]` | the label the mobile card shows for that cell — already set |

Nothing in a `<template>` has an `id`. Templates are cloned many times; every
hook inside them is a class or `data-*`. Keep it that way.

Rendering pattern for every list:

```js
const tpl = document.getElementById('tpl-stock-row');
const row = tpl.content.firstElementChild.cloneNode(true);
row.dataset.mint = s.mint;
row.querySelector('[data-field="price"]').textContent = fmtUsd(s.priceUsd);
frag.appendChild(row);
// …then one replaceChildren on the container
container.replaceChildren(frag);
```

Always build into a `DocumentFragment` and land it with a single
`replaceChildren` — never `innerHTML +=` in a loop.

---

## 1. The pane state machine (the only way to switch loading/ready/empty/error)

A container carries `data-state="loading" | "ready" | "empty" | "error"`.
Its **direct children** carrying `.pane` are shown/hidden by CSS:

```html
<div id="thing" data-state="loading">
  <div class="pane pane--loading">…skeleton…</div>
  <div class="pane pane--ready">…real content…</div>
  <div class="pane pane--empty">…honest empty copy…</div>
  <div class="pane pane--error">…message + retry button…</div>
</div>
```

JS only ever does `el.dataset.state = 'ready'`. Never set `style.display`,
never add `hidden` to a pane.

Two rules you must respect:

1. **Panes must stay direct children of the element that owns `data-state`.**
   The CSS uses a child combinator. That is why the tape's state lives on
   `#tape-viewport`, not on `#tape`.
2. `.pane-as-grid` / `.pane-as-flex` / `.pane-as-tbody` on a pane declare what
   `display` it gets when shown (default `block`). They are already set in the
   markup; do not remove them.

**Inline value skeletons.** Single numbers do not get a separate skeleton pane;
they carry `.skel-text` and are masked automatically while the nearest
`[data-state]` ancestor is `loading`. Set `data-state="ready"` on the container
and the real text you wrote into them appears. Never strip `.skel-text`.

Containers that own a state, and what "ready" means for each:

| Container | ready shows |
|---|---|
| `#tape-viewport` | `#tape-track` |
| `#hero-stats` | unmasks the four `.skel-text` stat values |
| `#basket-picks` | `#basket-picks-list` |
| `#basket-picker` | `#basket-add-list` |
| `#projection` | the key/value panel (starts as `empty` = not connected) |
| `#stocks-table` | `<tbody id="stocks-body">` |
| `#demand-panel` | `#demand-bars` |
| `#vault-figures` | unmasks the vault `.skel-text` values |
| `#vault-holdings-table` | `<tbody id="vault-holdings-body">` |
| `#rounds-table` | `<tbody id="rounds-body">` |
| `#chart-panel` | `#chart-mount` (the lightweight-charts container) |
| `.round-detail__inner` (inside `#tpl-round-detail`) | `[data-role="detail-content"]` |

---

## 2. Theme

- Light is the default. Dark comes from `prefers-color-scheme` automatically.
- An explicit choice is `document.documentElement.dataset.theme = 'dark' | 'light'`.
  Both directions win over the system preference.
- Persist under `localStorage['stockdrop:theme']`; read it and apply it **before
  first paint** if you can (an inline snippet is not available here, so apply it
  as the first statement of `app.js`). Wrap every `localStorage` access in
  try/catch — private windows throw.
- `#theme-toggle` — icon button. On toggle: swap `hidden` between
  `#theme-icon-sun` (shown in light) and `#theme-icon-moon`, update
  `aria-pressed` (`true` when dark) and `aria-label` ("Switch to dark theme" /
  "Switch to light theme").
- Also update `<meta name="theme-color">` if you like; not required.

---

## 3. Header

| id | type | JS writes |
|---|---|---|
| `#status-pill` | span.pill | `dataset.mode` = `LIVE` \| `DRY_RUN` \| `READ_ONLY` \| `OFFLINE` |
| `#status-pill-text` | span | `LIVE` / `DRY RUN` / `READ ONLY` / `OFFLINE` |
| `#btn-refresh` | button | click → refetch everything; add `.is-busy` while in flight if you want a hook (no CSS depends on it) |
| `#theme-toggle` | button | see §2 |
| `#wallet-badge` | span.badge | `hidden=false` once connected |
| `#wallet-address-short` | span | truncated address, `769f…f9up` |
| `#btn-connect` | button | opens `#wallet-modal` |
| `#connect-label` | span | `Connect wallet` → the truncated address after connect, or `Connecting…` while signing |
| `#btn-disconnect` | button | `hidden=false` once connected; clears the session |
| `#nav-links` | ul | set `aria-current="true"` on the `[data-nav-link]` anchor for the section in view (IntersectionObserver); remove it from the others |

The status pill is hidden below 768px by CSS. Do not fight that.

Tab title: update `document.title` when the countdown is known, e.g.
`STOCKDROP — next round in 02:14` (keep the brand first).

---

## 4. Ticker tape

```
#tape                     data-paused="true|false"
  #tape-viewport          data-state=loading|ready|empty|error
    #tape-skeleton        .pane--loading   (12 static chips, already in markup)
    #tape-track           .pane--ready     ← you fill this
    #tape-empty           .pane--empty
    #tape-error           .pane--error     contains #tape-retry
  #tape-pause             button, aria-pressed
```

The marquee is a CSS animation that translates the track by `-50%`. **You must
append the item list twice**: the first copy normal, the second copy with
`aria-hidden="true"` on every item. Anything else makes the loop jump.

```js
const frag = new DocumentFragment();
for (const pass of [false, true]) {
  for (const s of universe.stocks) {
    const it = tplTapeItem.content.firstElementChild.cloneNode(true);
    it.dataset.mint = s.mint;
    it.querySelector('[data-field="symbol"]').textContent = s.symbol;
    it.querySelector('[data-field="price"]').textContent  = fmtUsd(s.priceUsd);
    const c = it.querySelector('[data-field="change"]');
    c.textContent = fmtPct(s.change24h);
    c.dataset.dir = dirOf(s.change24h);           // 'up' | 'down' | 'flat'
    if (pass) it.setAttribute('aria-hidden', 'true');
    frag.appendChild(it);
  }
}
tapeTrack.replaceChildren(frag);
tapeViewport.dataset.state = 'ready';
```

`#tape-pause` toggles `#tape.dataset.paused` and its own `aria-pressed`. Hover
and focus already pause the tape in CSS. Under `prefers-reduced-motion` the
animation is off and the viewport scrolls manually — do not re-enable it.

Template `#tpl-tape-item`:
```html
<span class="tape__item" data-mint="">
  <span class="tape__symbol" data-field="symbol"></span>
  <span class="tape__price"  data-field="price"></span>
  <span class="tape__change" data-field="change" data-dir="flat"></span>
</span>
```

---

## 5. Hero

Token identity — **honest states only**. With `config.token.launched === false`
leave the markup exactly as shipped:

| id | pre-launch text (already in the markup) | post-launch |
|---|---|---|
| `#token-name` | `Token TBA` | `config.token.name` |
| `#token-symbol` | `not launched` | `$SYMBOL` |
| `#token-mint` | `TBA — not launched` | the mint, truncated |
| `#btn-copy-mint` | `disabled` | enable, copies the full mint |

Never invent a name, ticker or mint. Never show a placeholder that reads like a
real address.

`#mode-banner` (`.badge--sim`, starts `hidden`): show when `mode !== 'LIVE'`,
with `#mode-banner-text` = `Simulated — dry run` or `Read-only — no vault key`.

Stats — container `#hero-stats`, flip it to `ready` when `/api/stats` lands:

| id | content | fallback |
|---|---|---|
| `#stat-vault-sol` | vault SOL, 3 dp | `—` |
| `#stat-vault-usd` | `≈ $1,234` | `—` |
| `#countdown-value` | `HH:MM:SS`, ticks every second, `aria-hidden` | `--:--:--` |
| `#stat-next-round-at` | `18:00 UTC · in 2h 14m` | `—` |
| `#countdown-sr` | screen-reader text, **update at most once a minute** | — |
| `#stat-pref-wallets` | wallets with saved picks | `0` |
| `#stat-eligible-wallets` | `— eligible holders (no token yet)` pre-launch, else the count | |
| `#stat-distributed` | total SOL distributed | `0` |
| `#stat-rounds-count` | `12 rounds · last 06:00 UTC` or `no rounds yet` | |

The countdown is the one ticking number on the page: `#countdown-value` is
`aria-hidden="true"` so a screen reader is not spammed once a second; write a
coarse sentence into `#countdown-sr` (`aria-live="polite"`) at most once a
minute, e.g. `Next round in about 2 hours.`

---

## 6. Basket configurator

### Elements

| id | role |
|---|---|
| `#basket-source` | `Showing the default basket` / `Showing your saved basket` / `Showing unsaved edits` |
| `#basket-dirty` | badge, `hidden=false` when the working set differs from what is saved |
| `#basket-picks` | state owner |
| `#basket-picks-list` | `<ul>` you fill with `#tpl-pick-row` |
| `#basket-picks-empty` | shown when the user removed everything; `#btn-empty-default` restores the default |
| `#basket-picks-error` / `#basket-error-text` / `#btn-basket-retry` | fetch failure |
| `#basket-total` | `85%`, plus `dataset.ok = 'true'|'false'` |
| `#basket-meter` / `#basket-meter-fill` | set `fill.style.width = total + '%'`, `#basket-meter.dataset.ok`, and keep `#basket-meter`'s `aria-label` in sync (`Allocation total 85 percent of 100`) |
| `#basket-validation` | one short sentence; `dataset.level = 'info'|'ok'|'warn'|'error'`. It is `role="status" aria-live="polite"` — write plain text, no markup |
| `#btn-autobalance` | spread the remainder evenly, respecting 10–60 and integers |
| `#btn-reset-basket` | back to the default top-5 basket |
| `#btn-revert-basket` | `hidden` unless dirty; restores the saved prefs |
| `#btn-save-basket` | primary. Label: `Connect to save` (disconnected, disabled) → `Save basket` (valid) → `Signing…` (in flight) → `Saved` briefly |
| `#basket-picker` | state owner for the add-list |
| `#basket-search` | `input` event filters `#basket-add-list`; set `#basket-picker.dataset.state='empty'` when nothing matches |
| `#basket-add-list` | chips from `#tpl-picker-chip`, one per universe stock not already picked |
| `#basket-add-count` | `15 of 20 available` |

### Pick row — `#tpl-pick-row`

```html
<li class="pick-row" data-mint="" data-symbol="">
  <span class="logo-slot pick-row__logo" data-role="logo">
    <span data-field="mono"></span>
    <img class="logo-slot__img" data-field="logo" alt="" hidden>
  </span>
  <span class="pick-row__id">
    <span class="pick-row__ticker" data-field="symbol"></span>
    <span class="pick-row__name"   data-field="name"></span>
  </span>
  <span class="alloc-bar pick-row__bar" aria-hidden="true">
    <span class="alloc-bar__fill" data-field="bar"></span>
  </span>
  <span class="stepper pick-row__step">
    <button class="stepper__btn" data-action="dec" aria-label="Decrease allocation">−</button>
    <input class="stepper__input" type="number" min="10" max="60" step="5" data-field="pct" aria-label="Allocation percent">
    <span class="stepper__suffix">%</span>
    <button class="stepper__btn" data-action="inc" aria-label="Increase allocation">+</button>
  </span>
  <button class="btn btn--icon btn--sm pick-row__remove" data-action="remove" aria-label="Remove from basket">…</button>
</li>
```

Per row you must:
- set `dataset.mint`, `dataset.symbol`;
- fill `[data-field="symbol"]`, `[data-field="name"]`;
- set `[data-field="bar"].style.width = pct + '%'`;
- set `[data-field="pct"].value = pct`;
- rewrite the three `aria-label`s to name the stock:
  `Decrease NVDAx allocation`, `NVDAx allocation percent`, `Remove NVDAx from basket`;
- disable `[data-action="dec"]` at 10 and `[data-action="inc"]` at 60;
- add `.is-invalid` to the row (and to its `.stepper`) when that row is the
  reason the basket is invalid;
- add `.is-stale` and a `<span class="pick-row__note">` if a saved pick is no
  longer in the universe (copy: `No longer in the top 20 — its share is spread
  across your other picks`).

Keyboard: the `−`/`+` buttons and the number input are already focusable. Also
handle `ArrowUp`/`ArrowDown` on the input (step 5, clamped) and re-validate on
`input`, not only on `change`.

Validation rules (mirror `engine/validate.js`, do not invent your own):
2–5 picks, each an integer 10–60, sum exactly 100, no duplicates, every mint in
the current universe. Map the API's `invalid_picks` codes
(`count|range|sum|not_in_universe|duplicate`) onto the same sentences you show
locally so client and server never disagree.

### Chip — `#tpl-picker-chip`
Set `dataset.mint`, `dataset.symbol`, `[data-field="symbol"]`, the logo slot.
Add `.is-selected` and `disabled` for stocks already in the basket. Click
(`[data-action="add-stock"]`) adds it at the smallest legal percent and
auto-balances.

### Donut

`#donut-svg` is a 120×120 viewBox with `r=46`, stroke width 18, wrapped in
`#donut-arcs` which is already rotated `-90deg` so arcs start at 12 o'clock.

- Hide `#donut-placeholder` (`hidden = true`) as soon as there is at least one
  pick; show it again when the basket is empty.
- For each slice append to `#donut-arcs`:
  ```js
  const C = 2 * Math.PI * 46;                      // 289.03
  const arc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  arc.setAttribute('class', 'donut__arc');
  arc.setAttribute('cx', '60'); arc.setAttribute('cy', '60'); arc.setAttribute('r', '46');
  arc.dataset.slice = String(i);                   // 0..4 → the five stroke colours
  arc.setAttribute('stroke-dasharray', `${C * pct / 100} ${C}`);
  arc.setAttribute('stroke-dashoffset', `${-C * offsetPct / 100}`);
  ```
- `#donut-center-value` → `100%` (or the current total), `#donut-caption` →
  `5 stocks · 100% allocated` or `Nothing allocated yet.`
- `#donut-legend` ← one `#tpl-legend-row` per slice, `data-slice` matching the
  arc index so the swatch colour matches.

### Projection panel `#projection`

Starts at `data-state="empty"` (the not-connected block, whose
`#btn-projection-connect` opens the wallet modal). After `/api/me`:

| id | content |
|---|---|
| `#proj-balance` | `1,250,000 TOKEN` or `— (token not launched)` |
| `#proj-eligibility` | `Yes` / `No — need 1,000,000` / `Unknown until launch` |
| `#proj-share` | `0.42% of the pool` or `—` |
| `#proj-pool` | `4.21 SOL` |
| `#proj-note` | why the number is an estimate; say `simulated` when `mode !== 'LIVE'` |
| `#projection-sim` | badge, `hidden=false` in DRY_RUN |

Rules text `#rule-picks-range`, `#rule-pct-range`, `#rule-universe-size`,
`#rule-eligible-pct` should be rewritten from `/api/config.rules` so the page
never contradicts the server.

---

## 7. Top 20 table

```
#stocks-table            data-state, class="table table--wide table--cards"
  thead                  sort buttons: [data-sort="rank|price|change24h|underlyingMcap|liquidityUsd"]
  #stocks-skeleton       .pane--loading  (20 rows, already in markup)
  #stocks-body           .pane--ready    ← you fill this
  #stocks-empty          .pane--empty
  #stocks-error          .pane--error    (#stocks-error-text, #btn-stocks-retry)
#stocks-updated          "updated 12:04 UTC · Jupiter"
```

`table--cards` turns the table into cards below 768px. It is pure CSS. Each
`<td>` already carries the `data-label` the card shows — **keep them when you
clone**, and do not reorder cells.

Row template `#tpl-stock-row` fields: `rank`, `mono` (2-letter monogram
fallback), `logo` (img), `name`, `price`, `change` (+ `data-dir`), `mcap`,
`liquidity`, `spark`. Actions: `[data-action="open-stock"]` (the ticker button)
and `[data-action="add-stock"]`.

Logo slots everywhere follow the same rule:

```js
const img = el.querySelector('[data-field="logo"]');
el.querySelector('[data-field="mono"]').textContent = symbol.slice(0, 2).toUpperCase();
if (stock.logo) {
  img.src = stock.logo; img.alt = '';
  img.hidden = false;
  img.onerror = () => { img.hidden = true; };   // monogram shows through
}
```

Sparkline: replace the contents of `[data-field="spark"]` with an inline
`<svg viewBox="0 0 84 24" preserveAspectRatio="none"><path class="spark__line" d="…"/></svg>`
and set `data-dir` on the `.spark` span. Leave the shipped
`<span class="spark__empty">` in place when there is no history — that is the
"no data" state, not a bug.

Row interaction:
- Mouse: the whole `<tr data-clickable="true">` opens the drawer. Ignore clicks
  that originate inside `[data-action="add-stock"]`.
- Keyboard: the ticker `<button data-action="open-stock">` is the accessible
  path. Do **not** put `role="button"` or `tabindex` on the `<tr>`.
- Mark the open row with `.is-active`; clear it when the drawer closes.

Sorting: on a `[data-sort]` click set `aria-sort` on that `<th>` to
`ascending`/`descending` and `none` on all others (the arrow is CSS-driven),
then re-render `#stocks-body`. Default is rank ascending, already in the markup.

---

## 8. Stock drawer (`#stock-drawer`, a native `<dialog>`)

Open with `showModal()`, close with `close()`. Native focus trapping and Escape
come free — do not reimplement them. On close, return focus to the element that
opened it and clear `.is-active` on the table row.

| id | content |
|---|---|
| `#drawer-logo-mono` / `#drawer-logo-img` | logo slot, same pattern as rows |
| `#drawer-ticker`, `#drawer-name` | symbol, company |
| `#drawer-price`, `#drawer-change` | price and 24h (set `data-dir` on `#drawer-change`) |
| `#chart-range-tabs` | `role="tablist"`, buttons `#tab-1mo` `#tab-3mo` `#tab-1y`, each with `data-range` |
| `#chart-panel` | state owner for the chart |
| `#chart-mount` | pass this element to `LightweightCharts.createChart` |
| `#chart-error-text`, `#btn-chart-retry` | failure state |
| `#drawer-mcap`, `#drawer-liquidity`, `#drawer-holders`, `#drawer-underlying` | stat grid |
| `#drawer-mint`, `#btn-copy-stock-mint` | full mint + copy |
| `#btn-drawer-add` | add to basket (disable when already picked or the basket is full) |
| `#btn-drawer-close`, `#btn-drawer-close-x` | close |

Tabs, roving tabindex (implement exactly this):
- selected tab: `aria-selected="true"`, `tabindex="0"`; the others
  `aria-selected="false"`, `tabindex="-1"`;
- `ArrowLeft` / `ArrowRight` move selection and focus, wrapping;
- `Home` / `End` jump to first / last;
- selecting a tab sets `#chart-panel`'s `aria-labelledby` to that tab's id and
  refetches `/api/universe/:symbol/history?range=…`.

Chart colours must come from CSS variables, read at creation time and re-read
when the theme changes:
`getComputedStyle(document.documentElement).getPropertyValue('--chart-grid')`
— also `--chart-line`, `--chart-up`, `--chart-down`, `--chart-axis`, `--surface`.
Never hardcode a hex in JS. Destroy and recreate (or `applyOptions`) the chart
on theme change and on drawer close.

---

## 9. Community demand

```
#demand-panel        data-state
  #demand-skeleton   .pane--loading  (6 bars)
  #demand-bars       .pane--ready    ← #tpl-demand-row
  #demand-empty      .pane--empty    "No picks saved yet"
  #demand-error      .pane--error    (#demand-error-text, #btn-demand-retry)
#demand-basis        badge: "equal-weight" | "holding-weighted"
#demand-note         one sentence explaining the basis
```

Per row: `dataset.mint`, `[data-field="symbol"]`, logo slot,
`[data-field="bar"].style.width` = share as a percentage of the **largest** bar
(so the chart uses the full width), and `[data-field="pct"]` = the true share.
Add `.is-mine` to rows that are in the connected wallet's basket — that is the
only place the accent colour appears in this chart.

`#demand-basis` must say `equal-weight` before launch. Do not claim
holding-weighted demand while there is no token.

---

## 10. Vault

Static, correct, already in the markup — **do not overwrite**:
`#vault-address` and `#footer-vault-address` =
`769fv6KK6SAQ5FBAXdUZLdrppdHn5CqqgJBpFCLyf9up`, and `#vault-explorer` points at
Solscan. Verify against `/api/config.vault.address` and, if they ever differ,
show an error toast rather than silently replacing the text.

| id | content |
|---|---|
| `#vault-balance-sol` | `4.2610 SOL` |
| `#vault-balance-usd` | `≈ $612` |
| `#vault-reserve` | `0.05 SOL` |
| `#vault-pool` | `4.2110 SOL` |
| `#vault-min-pool` | from `/api/config` |
| `#vault-updated` | `updated 12:04 UTC` |
| `#vault-figures` | state owner for the four masked values |
| `#vault-holdings-table` | state owner; body `#vault-holdings-body`, rows from `#tpl-holding-row` |
| `#vault-holdings-count` | `3 tokens` / `none` |

Copy buttons: `#btn-copy-vault`, `#btn-copy-vault-footer`, `#btn-copy-mint`,
`#btn-copy-stock-mint`. All follow one helper:

```js
await navigator.clipboard.writeText(text);
btn.classList.add('is-copied');
setTimeout(() => btn.classList.remove('is-copied'), 1200);
toast({ kind: 'success', title: 'Copied', text: 'Vault address copied.' });
```
`navigator.clipboard` can reject (insecure context, denied permission) — catch
it and toast an error instead of throwing.

---

## 11. Rounds ledger

```
#rounds-table          data-state, class="table table--ledger"
  #rounds-skeleton     .pane--loading (5 rows)
  #rounds-body         .pane--ready
  #rounds-empty        .pane--empty   ← #rounds-empty-time
  #rounds-error        .pane--error   (#rounds-error-text, #btn-rounds-retry)
#rounds-count          "12 rounds"
#btn-rounds-more       hidden until total > loaded; appends the next page
```

`#rounds-empty-time`: replace the shipped generic sentence with the real
`nextRoundAt` once `/api/config` answers, e.g. `18:00 UTC`. Until then leave the
honest generic text — never print a made-up time.

### Expandable rows

For each round append **two** nodes: a `#tpl-round-row` clone and a
`#tpl-round-detail` clone, both with the same `dataset.roundId`.

```js
row.dataset.roundId = r.id;
row.setAttribute('aria-expanded', 'false');
row.setAttribute('aria-controls', 'round-detail-' + r.id);
detail.id = 'round-detail-' + r.id;      // the ONLY id JS creates; keep this shape
detail.hidden = true;
```

Toggle (`[data-action="toggle-round"]`, delegated on `#rounds-body`):
`detail.hidden = !expanded`, flip `aria-expanded` on the row, and update the
button's `aria-label` (`Show round detail` / `Hide round detail`). The chevron
rotation is CSS. On first expand, fetch `GET /api/rounds/:id`, fill
`[data-role="detail-content"]`, then set the inner
`.round-detail__inner`'s `data-state` to `ready` (or `empty` for a skipped
round, `error` on failure).

Row fields: `id`, `sim` (a `.badge--sim`, un-`hidden` when `round.simulated`),
`scheduledAt`, `status` (set both `textContent` and `dataset.status` — the
colour comes from `data-status`), `pool`, `stocks`, `holders`, `transfers`.

Detail fields: `hash`, `takenAt`, `eligible`, `pool`, `skipReason`, plus
`[data-role="swaps-body"]` filled with `#tpl-swap-row` and
`[data-role="transfers-body"]` filled with `#tpl-transfer-row`.
Tx links: set `href` to `https://solscan.io/tx/<sig>` and the text to the
truncated signature; when `tx === null` replace the anchor's text with
`simulated` (DRY_RUN) or `—` and remove the `href`.

Never render a transfer or a tx that the API did not return.

---

## 12. How it works / footer

`#step-interval`, `#step-eligible-pct`, `#rule-*` — rewrite from `/api/config`
so the prose matches the running server. `#footer-mode` → `mode DRY_RUN`,
`#footer-api` → the API base host, `#footer-updated` → last successful fetch
time. `#footer-source` is a plain sentence today; replace it with an anchor only
when a real repository URL exists.

---

## 13. Toasts

`#toast-region` is `role="status" aria-live="polite"`. Clone `#tpl-toast`:

```html
<div class="toast" data-kind="info" role="alert">
  <svg class="toast__icon">…</svg>
  <div class="toast__body">
    <p class="toast__title" data-field="title"></p>
    <p class="toast__text"  data-field="text"></p>
  </div>
  <button class="btn btn--icon btn--sm toast__close" data-action="dismiss" aria-label="Dismiss">…</button>
  <div class="toast__actions" data-role="actions" hidden>
    <button class="btn btn--sm" data-action="retry">Retry</button>
  </div>
</div>
```

- `dataset.kind` = `info` | `success` | `warn` | `error` (sets the left rule colour).
- Show the retry affordance with `actions.hidden = false` and attach your retry
  callback to `[data-action="retry"]`.
- Auto-dismiss success/info after ~4s; **never** auto-dismiss an error that has
  a retry. Cap the region at ~3 toasts, dropping the oldest.
- Errors are for real failures only. A pre-launch "no token yet" is a normal
  empty state, not an error.

---

## 14. Wallet modal (`#wallet-modal`, a native `<dialog>`)

`#btn-connect` and `#btn-projection-connect` call `showModal()`.
`#btn-wallet-close` calls `close()`. Also close on backdrop click if you want
(`e.target === dialog`).

Three options only, each `<button data-wallet="phantom|jupiter|solflare">`:

| id | meta id | status id |
|---|---|---|
| `#wallet-phantom` | `#wallet-phantom-meta` | `#wallet-phantom-status` |
| `#wallet-jupiter` | `#wallet-jupiter-meta` | `#wallet-jupiter-status` |
| `#wallet-solflare` | `#wallet-solflare-meta` | `#wallet-solflare-status` |

Detection (Wallet Standard first, injected providers as fallback):
- detected → status text `Detected`, add `.badge--live`, meta `Ready to connect`;
- not detected → status `Install`, keep `.badge--muted`, meta `Not installed`,
  and on click open the wallet's site in a new tab
  (`https://phantom.com`, `https://jup.ag`, `https://solflare.com`)
  with `rel="noopener noreferrer"` — do not attempt a connection.

`#wallet-error` is `role="alert"`, starts `hidden`; use it for signature
rejection and verification failure. Keep the message short and factual.

Connect flow is fixed by CONTRACT.md §8: `connect()` → `POST /api/auth/nonce` →
`signMessage(utf8(message))` → `POST /api/auth/verify` → token in
`localStorage` → `GET /api/me`. **Never call `signTransaction` or
`signAndSendTransaction` anywhere in this app.**

---

## 15. Complete list of classes JS may add or remove

| class | on | meaning |
|---|---|---|
| `.is-copied` | a copy button | flash confirmation, ~1.2s |
| `.is-selected` | `.chip` in the picker | already in the basket |
| `.is-active` | a `<tr>` in `#stocks-body` | its drawer is open |
| `.is-invalid` | `.pick-row`, `.stepper` | this row breaks validation |
| `.is-stale` | `.pick-row` | pick is no longer in the universe |
| `.is-mine` | `.bar-row` in `#demand-bars` | in the connected wallet's basket |
| `.badge--live` / `.badge--muted` / `.badge--sim` / `.badge--warn` | badges | swap the badge tone |
| `.pick-row__note` | a new `<span>` inside a stale pick row | the nag copy |

Attributes JS may set: `data-state`, `data-mode`, `data-dir`, `data-status`,
`data-ok`, `data-paused`, `data-slice`, `data-level`, `data-round-id`,
`data-mint`, `data-symbol`, `aria-*`, `hidden`, `disabled`, `value`,
`style.width` (bars only), `href`, `src`, `alt`, `textContent`.

Everything else — colours, spacing, borders, fonts, layout — belongs to the CSS.
If you find yourself writing `style.color` or `style.background`, stop and use a
`data-*` hook instead.

---

## 16. Formatting rules (keep the columns aligned)

- Every number, ticker, address and table cell renders in IBM Plex Mono with
  tabular figures. The classes `.mono` / `.num` are already on the cells that
  need them; keep them when you write text.
- Money: `$1,234.56` under 10k, `$12.3K`, `$4.56M`, `$1.23B`, `$5.56T`.
- SOL: 4 dp for balances, 3 dp for pools. Always suffix the unit in a separate
  `.stat__unit` span where one exists.
- Percent change: always signed, 2 dp, plus `data-dir`.
- Addresses: `first4…last4` (`769f…f9up`) via one shared `truncAddr()`; the full
  value goes in the `title` attribute and in the clipboard.
- Token amounts arrive as base-unit strings plus `decimals`. Convert with
  BigInt, not floats. Show at most 6 significant decimals for stock tokens
  (8 decimals) and label the raw amount in the `title`.
- Times: UTC everywhere, `HH:mm` or `YYYY-MM-DD HH:mm`, with the literal `UTC`
  next to the first one on screen. Do not silently localise.
- `null` / unknown renders as `—` (em dash), never `0`, `N/A` or `undefined`.

---

## 17. Honesty rules (these are product requirements, not style)

1. If `TOKEN_MINT` is blank, the page says `TBA — not launched` and no holder,
   price, round or eligibility number is invented anywhere.
2. Anything derived from `mode !== 'LIVE'` carries a visible `Simulated` badge —
   the hero banner, the projection panel, every simulated round row.
3. Empty is not an error. Use the `empty` pane and its shipped copy.
4. Skipped rounds are shown, with their reason (`no_token`, `low_pool`,
   `no_holders`). They are evidence the keeper ran, not a failure to hide.
5. No number appears on screen that did not come from the API this session.

---

## 18. Boot order that matches the shell

1. Apply the stored theme.
2. `GET /api/config` → rules text, token identity, mode pill, footer, countdown
   target, `#rounds-empty-time`, `#vault-min-pool`.
3. `GET /api/universe` → tape, `#stocks-body`, `#basket-add-list`, and the
   default basket (top 5 × 20%) if the user has no saved prefs.
4. `GET /api/stats` → hero stats, `#demand-bars`, `#demand-basis`.
5. `GET /api/vault` → vault panel and holdings.
6. `GET /api/rounds?limit=25` → ledger.
7. Restore a stored session token → `GET /api/me` → basket + projection.

Each of these owns its own `[data-state]` container, so a slow or failing
endpoint degrades only its own section. Never leave a container on `loading`
after a rejection — flip it to `error` and offer the retry button that is
already in the markup.

Polling: prices/tape and hero stats every 60s, vault every 60s, rounds every
5 min, countdown every 1s. Pause polling when `document.hidden`.
