# STOXVAULT — web DOM contract

Everything the JS layer is allowed to touch in `public/index.html`, and how.
The shell (HTML + CSS) is finished and owns all visual decisions. `app.js`
fetches data, fills the slots listed here, and flips the states listed here.
**Do not add new markup patterns** — clone the `<template>` for the row you need.
If something is genuinely missing, add it to this file first.

Files: `public/index.html`, `public/css/{tokens,base,layout,components}.css`,
`public/assets/*`. You own everything under `public/js/`: `config.js` (a classic
script, runs first), `app.js` (`type="module"`), and the modules it imports —
`api.js`, `wallet.js`, `format.js`, `charts.js`, `rules.js` and `ui/*`.

Pure decision functions live outside the DOM code and are covered by
`web/test/*.test.js` (`node --test web/test/` from the repo root).

**Nothing about the API changed in this redesign.** Same endpoints, same field
names, same behaviour. What changed is the *shape of the page*: it is now a
single screen with five tabs instead of one long scroll. §0.1 lists every
rename so you can find what moved.

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

## 0.1 Renamed, moved and removed (read this first)

The old page had a header nav, a hero, and six stacked `<section>`s. It now has
a header with a tab bar and five `role="tabpanel"` sections.

### Renamed / re-homed ids

| Old | New | Note |
|---|---|---|
| `#nav-links` (anchor nav) | `#tab-bar` | now a real `role="tablist"`; see §2 |
| `#hero-stats` (state owner for 4 stats) | `#card-vault`, `#card-round`, `#card-holders` | the hero split into three Overview cards, **each owning its own state** |
| `#stat-vault-sol` | `#vault-balance-sol` | one id for the vault balance now, not two |
| `#stat-vault-usd` | `#vault-balance-usd` | same |
| `#vault-figures` | still exists, **no longer a state owner** | it is just the `<p class="numeral">` wrapper. `#card-vault` owns the state |
| `#stat-distributed`, `#stat-rounds-count` | same ids, moved into the **Rounds** panel head | they describe the ledger, so they live with it |
| `#stat-eligible-wallets`, `#stat-pref-wallets` | same ids, moved into `#card-holders` | |
| `#basket-panel` | removed | the basket right column is a `.card`, no id needed |
| `.eyebrow` (class) | `.micro` | uppercase, letter-spaced, **muted gold**. `.eyebrow` still exists as the neutral variant |
| `#btn-refresh`, `#theme-toggle` | same ids, moved into the **footer** | the frames keep the header clean |
| `.stepper` (− input +) inside a pick row | `<input type="range" class="pick__slider">` | same min/max/step, same `[data-field="pct"]` |
| `[data-action="add-stock"]` on a stock **row** | `[data-action="toggle-pick"]` on `.tick` | it is a checkbox now: click toggles in **and** out |
| `#tape` and friends | same ids, moved to the bottom of the **Overview** panel | it is no longer page chrome under the header |

### Removed (and why)

| Removed | Why |
|---|---|
| `#donut`, `#donut-svg`, `#donut-arcs`, `#donut-placeholder`, `#donut-center-value`, `#donut-caption`, `#donut-legend`, `#tpl-legend-row` | the frames replace the donut with the labelled sliders and the total row; the same information, once |
| `#mint-badge`'s old hero position, `#token-status` | folded into `.idstrip` at the top of Overview (§3) |
| `#stocks-updated`'s section header, the whole `#stocks` section | the top 20 moved into the left column of the **Basket** panel |
| mcap / liquidity / 7-day sparkline **columns** in `#tpl-stock-row` | the frames' row is tick · ticker · rank · price · 24h. Those three numbers still exist — in the stock drawer (`#drawer-mcap`, `#drawer-liquidity`) |
| `#btn-drawer-add` still exists | but the row-level "Add" button is gone; the tick replaces it |
| `.pill` in the header | `#status-pill` moved into `.idstrip` on Overview |

### Added

`#tab-bar` and the five tabs · `#card-vault` / `#card-round` / `#card-holders`
· `#vault-progress` / `#vault-progress-fill` · `#round-ring` / `#round-ring-arc`
/ `#round-progress-pct` / `#round-progress-label` · `#round-snapshot` and its
parts · `#stat-your-share` · `#holders-threshold` / `#holders-note` ·
`#overview-eyebrow` · `#arrivals` and `#tpl-arrival-row` · `#rules-list` and
`#rule-*` · `#btn-vault-retry` / `#btn-round-retry` / `#btn-holders-retry` ·
`#basket-total-row` · `.tick` inside `#tpl-stock-row`.

---

## 1. The pane state machine (unchanged)

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

**Inline value skeletons.** Single numbers carry `.skel-text` and are masked
while the nearest `[data-state]` ancestor is `loading`. Never strip `.skel-text`.

Nesting is fine and is used: `#vault-holdings-table` owns its own state inside
`#card-vault`'s ready pane, so the holdings list can fail on its own.

Containers that own a state, and what "ready" means for each:

| Container | ready shows |
|---|---|
| `#card-vault` | the vault figures + progress bar + holdings block |
| `#card-round` | the countdown, schedule line and progress ring |
| `#card-holders` | the eligible-wallet numeral and the two figures under it |
| `#vault-holdings-table` | `<tbody id="vault-holdings-body">` |
| `#tape-viewport` | `#tape-track` |
| `#stocks-table` | `<tbody id="stocks-body">` |
| `#basket-picks` | `#basket-picks-list` |
| `#basket-picker` | `#basket-add-list` |
| `#projection` | the key/value panel (starts as `empty` = not connected) |
| `#demand-panel` | `#demand-bars` |
| `#rounds-table` | `<tbody id="rounds-body">` |
| `#chart-panel` | `#chart-mount` (the lightweight-charts container) |
| `.round-detail__inner` (inside `#tpl-round-detail`) | `[data-role="detail-content"]` |

---

## 2. The tab bar — the ONLY navigation

```html
<div class="tabbar" id="tab-bar" role="tablist" aria-label="Sections">
  <button role="tab" id="tab-overview" data-tab="overview"
          aria-controls="panel-overview" aria-selected="true"  tabindex="0">Overview</button>
  …
</div>

<section class="view" id="panel-overview" role="tabpanel"
         aria-labelledby="tab-overview" tabindex="-1">…</section>
<section class="view" id="panel-basket" … hidden>…</section>
```

Five tabs, in this order, and their panels:

| tab id | `data-tab` | panel id |
|---|---|---|
| `#tab-overview` | `overview` | `#panel-overview` |
| `#tab-basket` | `basket` | `#panel-basket` |
| `#tab-demand` | `demand` | `#panel-demand` |
| `#tab-rounds` | `rounds` | `#panel-rounds` |
| `#tab-how` | `how` | `#panel-how` |

The markup ships with Overview selected and the other four panels `hidden`, so
the first paint is correct before your JS runs. **Implement exactly this:**

```js
function selectTab(tab) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
  }
}
```

- Click on a tab selects it (delegate on `#tab-bar`).
- **Roving tabindex**: the selected tab is the only one with `tabindex="0"`.
- `ArrowRight` / `ArrowLeft` move selection **and focus**, wrapping.
  `Home` / `End` jump to first / last. `ArrowDown` may be treated as
  `ArrowRight`; do not hijack `Tab`.
- After a keyboard or click selection, call `tab.focus()`. Do **not** move focus
  into the panel; the panel is `tabindex="-1"` only so `focus()` works if you
  choose to.
- Selecting a tab must scroll it into view inside `#tab-bar`'s scroller on a
  phone: `tab.scrollIntoView({ inline: 'nearest', block: 'nearest' })`.
- Reflect the tab in the URL hash (`#basket`) if you like, and read it on boot.
  Do it with `history.replaceState`, never `location.hash =` (that would jump
  the page). An unknown hash falls back to Overview.
- The panels are `hidden`, not unmounted. Data for a hidden panel still loads —
  the boot order in §14 does not change.

**In-prose tab jumps.** The How-it-works copy contains
`<button class="link linkbtn" data-tab-link="basket">` and
`data-tab-link="rounds"`. Delegate on the document: a click selects that tab.
They used to be `<a href="#basket">`; they are buttons now because they switch
tab rather than navigate.

Only tabs and panels are involved. There is no other navigation on the page.

---

## 3. Header

| id | type | JS writes |
|---|---|---|
| `#btn-copy-ca` | button | the coin's contract address. `disabled` while `/api/config.token.mint` is null, and the click handler copies nothing in that state; enabled with no code change once a mint exists. Rewrite `title` and `aria-label` together: `Copy the $TICKER contract address` / `The $TICKER contract address is not available until launch` |
| `#coin-ticker` | span.mono | `$` + `config.token.symbol`, falling back to `$STOXVAULT` before launch. Never a mint, never a placeholder address |
| `#link-x` | anchor | static, do not touch |
| `#wallet-badge` | span.wallet-pill | `hidden = false` once connected. Contains a decorative green dot and `#wallet-address-short` |
| `#wallet-address-short` | span | truncated address, `769f…f9up` |
| `#btn-connect` | button | opens `#wallet-modal` |
| `#connect-label` | span | `Connect wallet` → the truncated address after connect, or `Connecting…` while signing |
| `#btn-disconnect` | button | `hidden = false` once connected; clears the session |

Tab title: update `document.title` when the countdown is known, e.g.
`STOXVAULT — next round in 02:14` (keep the brand first).

There is no status pill, no refresh button and no theme toggle in the header
any more. The pill is in the Overview identity strip (§4); refresh and theme
are in the footer (§13).

---

## 4. Overview — identity strip

Above the three cards, `.view__head` carries the honest token identity.

| id | pre-launch text (already in the markup) | post-launch |
|---|---|---|
| `#overview-eyebrow` | `Vault fills from trading fees` | leave it alone; it states the mechanism, not a claim about activity |
| `#token-name` | `Token TBA` | `config.token.name` |
| `#token-symbol` | `not launched` | `$SYMBOL` |
| `#token-mint` | `TBA — not launched` | the mint, truncated (full value in `title`) |
| `#btn-copy-mint` | `disabled` | enable, copies the full mint |
| `#status-pill` | `dataset.mode` = `LIVE` \| `DRY_RUN` \| `READ_ONLY` \| `OFFLINE` | |
| `#status-pill-text` | `LIVE` / `DRY RUN` / `READ ONLY` / `OFFLINE` | |
| `#mode-banner` | `.badge--sim`, starts `hidden` | show when `mode !== 'LIVE'`, with `#mode-banner-text` = `Simulated — dry run` or `Read-only — no vault key` |

Never invent a name, ticker or mint. Never show a placeholder that reads like a
real address.

---

## 5. Overview — the three cards

Three `.card`s in `.cards`. Each owns its own `data-state`, so one failing
endpoint degrades one card. Each has a loading skeleton, a ready pane, an
honest empty pane and an error pane with a retry button.

### 5a. `#card-vault` — retry `#btn-vault-retry`, message `#vault-error-text`

**The vault address is not rendered anywhere on this site.** There is no
address element, no copy button for it, no Solscan link and no "send SOL here"
callout. `/api/config.vault.address` and `/api/vault.address` are both read past
and never printed.

| id | content | note |
|---|---|---|
| `#vault-balance-sol` | `4.2610` | **the number only.** The unit `SOL` is a separate `.numeral__unit` span already in the markup — do not append it |
| `#vault-balance-usd` | `≈ $612` | |
| `#vault-reserve` | `0.05 SOL` | |
| `#vault-progress` | set its `aria-label` in sync, e.g. `Pool 4.21 of the 0.50 SOL minimum` | |
| `#vault-progress-fill` | `style.width = pct + '%'` where pct = `min(100, pool / minPool * 100)` | the one place `style.width` is allowed, along with the other bars |
| `#vault-pool` | `4.2110 SOL` | |
| `#vault-min-pool` | from `/api/config` | |
| `#vault-holdings-table` | state owner; body `#vault-holdings-body`, rows from `#tpl-holding-row` | |
| `#vault-holdings-count` | `3 tokens` / `none` | |
| `#vault-updated` | `updated 12:04 UTC` | |

### 5b. `#card-round` — retry `#btn-round-retry`, message `#round-error-text`

| id | content |
|---|---|
| `#countdown-value` | `HH:MM:SS`, ticks every second, `aria-hidden="true"`, falls back to `--:--:--` |
| `#countdown-sr` | screen-reader sentence, `aria-live="polite"`, **updated at most once a minute** (`Next round in about 2 hours.`) |
| `#stat-next-round-at` | `Every 6 hours · snapshot ±10 min random offset` or `18:00 UTC · in 2h 14m` — whichever the config supports. `—` when unknown |
| `#round-ring` | rewrite its `aria-label`: `Round progress 69 percent` |
| `#round-ring-arc` | `setAttribute('stroke-dasharray', `${C * pct / 100} ${C}`)` with **C = 213.63** (2π × r, r = 34). The arc is already rotated −90° so it starts at 12 o'clock |
| `#round-progress-pct` | `69%`, or `—` |
| `#round-progress-label` | one word: `Filling` / `Snapshot` / `Buying` / `Sending` / `Settled`. `—` when unknown |

### 5c. Snapshot state — `#round-snapshot`, inside the round card

A snapshot is a moment inside a round, not a place, so it is a state of this
card rather than a sixth tab.

- `#round-snapshot` starts `hidden`. Set `hidden = false` **only** when the API
  reports a snapshot for the cycle running now. Hide it again when the next
  cycle starts.
- `#snapshot-offset` — the signed offset in words, e.g. `-4 min 12 sec`. The
  surrounding sentence ("from the mark. The exact moment cannot be gamed.") is
  static copy; do not rewrite it.
- `#snapshot-check` starts `hidden`; show it only when a wallet is connected
  **and** the API returned that wallet's snapshot balance.
- `#snapshot-balance` — `42,850,000 STOX`, or leave the block hidden. Never
  invent a balance, and never show one before the token exists.

### 5d. `#card-holders` — retry `#btn-holders-retry`, message `#holders-error-text`

| id | content |
|---|---|
| `#stat-eligible-wallets` | **a count or an em dash, nothing else.** This is a display numeral; a sentence here wraps to four lines. Pre-launch write `—` and put the explanation in `#holders-note` |
| `#holders-threshold` | `≥ 0.1%` from `config.rules.eligiblePct`. The words `of supply` are static |
| `#stat-pref-wallets` | wallets with saved picks, or `—` |
| `#stat-your-share` | `3.12%` for the connected wallet, else `—`. Same value as `#proj-share`; write both |
| `#holders-note` | the honest sentence: `No token yet — there is nobody to count.` / `Connect a wallet to see your share.` |

---

## 6. Overview — the price tape

Unchanged mechanically, only moved: it is now the last block of the Overview
panel rather than a strip under the header.

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

## 7. Basket — left column, the top 20 as selectable rows

```
#stocks-table            data-state, class="table table--picker table--cards"
  thead                  sort buttons: [data-sort="rank|price|change24h"]
  #stocks-skeleton       .pane--loading  (8 rows, already in markup)
  #stocks-body           .pane--ready    ← you fill this
  #stocks-empty          .pane--empty
  #stocks-error          .pane--error    (#stocks-error-text, #btn-stocks-retry)
#stocks-updated          "updated 12:04 UTC · Jupiter"
```

`table--cards` turns the table into cards below 768px, with the tick pinned to
the card's top-right corner. It is pure CSS. Each `<td>` already carries the
`data-label` the card shows — **keep them when you clone**, and do not reorder
cells.

Row template `#tpl-stock-row`:

```html
<tr class="stock-row" data-mint="" data-symbol="" data-clickable="true" data-picked="false">
  <td data-cell="select">
    <button class="tick" role="checkbox" aria-checked="false" data-action="toggle-pick"
            aria-label="Add to basket">…</button>
  </td>
  <td data-cell="identity">
    <span class="cell-identity">
      <button class="cell-identity__ticker linklike" data-action="open-stock"></button>
      <span class="cell-identity__name" data-field="name"></span>
    </span>
  </td>
  <td class="num" data-cell="rank"><span class="rank" data-field="rank"></span></td>
  <td class="num" data-cell="price" data-field="price"></td>
  <td class="num" data-cell="change"><span data-field="change" data-dir="flat"></span></td>
</tr>
```

Per row you must:
- set `dataset.mint`, `dataset.symbol`;
- write the ticker into `[data-action="open-stock"]`'s `textContent`;
- fill `[data-field="name"]`, `[data-field="rank"]` (**the number only — the
  `#` is drawn by CSS**), `[data-field="price"]`, `[data-field="change"]` plus
  its `data-dir`;
- set **both** `row.dataset.picked` and the tick's `aria-checked` to
  `'true'`/`'false'` — the gold wash comes from `data-picked`, the semantics
  from `aria-checked`, and they must never disagree;
- rewrite the tick's `aria-label` to name the stock and the direction:
  `Add NVDAx to your basket` / `Remove NVDAx from your basket`;
- disable the tick (`disabled = true`) on unpicked rows when the basket already
  holds 5, and keep its `aria-label` honest (`Basket is full — remove one first`).

Row interaction:
- The tick (`[data-action="toggle-pick"]`) toggles the stock in and out of the
  basket. Adding uses the smallest legal percent and then auto-balances.
- Mouse: the whole `<tr data-clickable="true">` opens the drawer. Ignore clicks
  that originate inside `[data-action="toggle-pick"]`.
- Keyboard: the ticker `<button data-action="open-stock">` is the accessible
  path to the drawer. Do **not** put `role="button"` or `tabindex` on the `<tr>`.
- Mark the open row with `.is-active`; clear it when the drawer closes.

Sorting: on a `[data-sort]` click set `aria-sort` on that `<th>` to
`ascending`/`descending` and `none` on all others (the arrow is CSS-driven),
then re-render `#stocks-body`. Default is rank ascending, already in the markup.

---

## 8. Basket — right column, the allocation panel

### Elements

| id | role |
|---|---|
| `#basket-source` | `Showing the default basket` / `Showing your saved basket` / `Showing unsaved edits` |
| `#basket-dirty` | badge, `hidden = false` when the working set differs from what is saved |
| `#basket-picks` | state owner |
| `#basket-picks-list` | `<ul>` you fill with `#tpl-pick-row` |
| `#basket-picks-empty` | shown when the user removed everything; `#btn-empty-default` restores the default |
| `#basket-picks-error` / `#basket-error-text` / `#btn-basket-retry` | fetch failure |
| `#basket-total-row` | the total row; no JS needed on the row itself |
| `#basket-total` | `85%`, plus `dataset.ok = 'true'|'false'`. **At exactly 100% it turns gold** — that is `data-ok="true"`, nothing else |
| `#basket-meter` / `#basket-meter-fill` | `fill.style.width = total + '%'`, `#basket-meter.dataset.ok`, and keep `#basket-meter`'s `aria-label` in sync (`Allocation total 85 percent of 100`) |
| `#basket-validation` | one short sentence; `dataset.level = 'info'|'ok'|'warn'|'error'`. It is `role="status" aria-live="polite"` — plain text, no markup |
| `#btn-save-basket` | the full-width gold bar. Label: `Connect to save` (disconnected, `disabled`) → `Save basket` (valid) → `Signing…` (in flight) → `Saved` briefly |
| `#btn-autobalance` | spread the remainder evenly, respecting 10–60 and integers |
| `#btn-reset-basket` | back to the default top-5 basket |
| `#btn-revert-basket` | `hidden` unless dirty; restores the saved prefs |
| `#basket-picker` | state owner for the add-list |
| `#basket-search` | `input` event filters `#basket-add-list`; set `#basket-picker.dataset.state='empty'` when nothing matches |
| `#basket-add-list` | chips from `#tpl-picker-chip`, one per universe stock not already picked |
| `#basket-add-count` | `15 of 20 available` |

### Pick row — `#tpl-pick-row`

```html
<li class="pick" data-mint="" data-symbol="" style="--pct:20">
  <span class="pick__top">
    <span class="pick__id">
      <span class="pick__ticker" data-field="symbol"></span>
      <span class="pick__name"   data-field="name"></span>
    </span>
    <span class="pick__pct mono" data-field="pctText">20%</span>
    <button class="pick__remove" data-action="remove" aria-label="Remove from basket">…</button>
  </span>
  <input class="pick__slider" type="range" min="10" max="60" step="5" value="20"
         data-field="pct" aria-label="Allocation percent">
</li>
```

Per row you must:
- set `dataset.mint`, `dataset.symbol`;
- fill `[data-field="symbol"]` and `[data-field="name"]`;
- set `[data-field="pct"].value = pct` **and** `[data-field="pctText"].textContent = pct + '%'`;
- set the filled portion of the slider with
  `li.style.setProperty('--pct', String(pct))`. This is the **only** custom
  property JS sets, and it is how the gold left half of the track is drawn.
  Setting it is required on every render and on every `input` event;
- rewrite the two `aria-label`s to name the stock:
  `NVDAx allocation percent`, `Remove NVDAx from basket`;
- add `.is-invalid` to the `<li>` when that row is the reason the basket is
  invalid;
- add `.is-stale` and a `<span class="pick__note">` if a saved pick is no longer
  in the universe (copy: `No longer in the top 20 — its share is spread across
  your other picks`).

Keyboard: a `range` input handles Arrow/Home/End/PageUp natively at `step=5`,
so **do not add key handlers**. Listen on `input` (live drag) as well as
`change`, and re-validate on both.

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

### Projection panel `#projection`

Starts at `data-state="empty"` (the not-connected block, whose
`#btn-projection-connect` opens the wallet modal). After `/api/me`:

| id | content |
|---|---|
| `#proj-balance` | `1,250,000 TOKEN` or `— (token not launched)` |
| `#proj-eligibility` | `Yes` / `No — need 1,000,000` / `Unknown until launch` |
| `#proj-cycle-row` | the whole `.kv__row`; `hidden = true` unless `/api/me.cycle` carries a boolean |
| `#proj-cycle` | did this wallet hold across the whole cycle: `Yes — counted at the smaller of the two snapshots` / `No — not for the cycle running now` |
| `#proj-share` | `0.42% of the pool` or `—` (also mirror the bare percentage into `#stat-your-share`) |
| `#proj-pool` | `4.21 SOL` |
| `#proj-cycle-note` | `.callout--info`, `hidden` unless the server sent a note or the wallet did not hold the full cycle. `#proj-cycle-note-title` / `#proj-cycle-note-text`. The server's `cycle.note` is rendered verbatim when it sends one — this is the "you bought this cycle, your first drop is the round after" case, and it stays calm, not alarming |
| `#proj-note` | why the number is an estimate; say `simulated` when `mode !== 'LIVE'` |
| `#projection-sim` | badge, `hidden = false` in DRY_RUN |

`/api/me.cycle` is read defensively: the boolean is taken from the first of
`heldFullCycle` / `heldWholeCycle` / `heldFull` / `fullCycle` / `held` the server
actually sends, the note from the first of `note` / `message` / `detail` / `text`.
A `me` document without a `cycle` object leaves both the row and the callout
hidden — no verdict is invented.

---

## 9. Demand panel

```
#demand-panel        data-state
  (loading)          .pane--loading  (6 bars)
  #demand-bars       .pane--ready    ← #tpl-demand-row
  #demand-empty      .pane--empty    "No picks saved yet"
  #demand-error      .pane--error    (#demand-error-text, #btn-demand-retry)
#demand-basis        badge: "equal-weight" | "holding-weighted"
#demand-note         one sentence explaining the basis
```

`#tpl-demand-row` is now a two-line row — label and percentage on top, the bar
underneath — to match the frames:

```html
<li class="bar-row" data-mint="" data-symbol="">
  <span class="bar-row__label">
    <span data-field="symbol"></span>
    <span class="bar-row__value" data-field="pct"></span>
  </span>
  <span class="bar-row__track"><span class="bar-row__fill" data-field="bar"></span></span>
</li>
```

Per row: `dataset.mint`, `[data-field="symbol"]`,
`[data-field="bar"].style.width` = share as a percentage of the **largest** bar
(so the chart uses the full width), and `[data-field="pct"]` = the true share.
Add `.is-mine` to rows that are in the connected wallet's basket.
There is no logo slot in this template any more.

`#demand-basis` must say `equal-weight` before launch. Do not claim
holding-weighted demand while there is no token.

The right-hand "Community demand → Vault buys once → Split to holders" flow is
**static markup**. JS does not touch it.

---

## 10. Rounds panel

```
#rounds-table          data-state, class="table table--ledger"
  #rounds-skeleton     .pane--loading (5 rows)
  #rounds-body         .pane--ready
  #rounds-empty        .pane--empty   ← #rounds-empty-time
  #rounds-error        .pane--error   (#rounds-error-text, #btn-rounds-retry)
#rounds-count          "12 rounds"
#stat-distributed      total SOL distributed, or "0"
#stat-rounds-count     "12 rounds · last 06:00 UTC" or "no rounds yet"
#btn-rounds-more       hidden until total > loaded; appends the next page
#rounds-foot-note      the anti-cheat rule in one line
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
`[data-role="detail-content"]`, then set the inner `.round-detail__inner`'s
`data-state` to `ready` (or `empty` for a skipped round, `error` on failure).

Row fields: `id`, `sim` (a `.badge--sim`, un-`hidden` when `round.simulated`),
`scheduledAt`, `status` (set both `textContent` and `dataset.status` — the
colour comes from `data-status`), `pool`, `stocks`, `holders`, `transfers`.

Detail fields: `hash`, `takenAt`, `eligible`, `pool`, `skipReason`, plus
`[data-role="swaps-body"]` filled with `#tpl-swap-row` and
`[data-role="transfers-body"]` filled with `#tpl-transfer-row`.

Three more rows carry the anti-cheat evidence, each `hidden` until the round
document actually has it — an older round simply shows fewer rows:

| row | field | content |
|---|---|---|
| `[data-row="snapshotMode"]` | `snapshotMode` | `round.snapshotMode` in words (`dual` → `two snapshots — weighted by the smaller balance`); an unknown value is printed verbatim, with the raw value in `title` |
| `[data-row="snapshotOpen"]` | `snapshotOpen` | the opening snapshot: `2026-09-07 11:02 UTC · aa11bb22…ee11ff22`, full hash and ISO time in `title` |
| `[data-row="snapshotClose"]` | `snapshotClose` | the closing snapshot, same shape |

The two snapshots are read from `round.snapshotOpen`/`round.snapshotClose`,
`round.openSnapshot`/`round.closeSnapshot` or `round.snapshots.open`/`.close` —
whichever the server sends. Never synthesise one from the other.
Tx links: set `href` to `https://solscan.io/tx/<sig>` and the text to the
truncated signature; when `tx === null` replace the anchor's text with
`simulated` (DRY_RUN) or `—` and remove the `href`.

Never render a transfer or a tx that the API did not return.

### "Stocks arrived in your wallet" — `#arrivals`

The card in the right column of the Rounds panel. It starts `hidden`.

- Show it (`hidden = false`) **only** when a wallet is connected and the latest
  round document contains transfers to that wallet. Otherwise it stays hidden;
  there is no empty state for it, because "no arrivals" is not news.
- `#arrivals-round` — `Round #016`.
- `#arrivals-list` — one `#tpl-arrival-row` per transfer:

```html
<li class="arrival" data-mint="">
  <span class="logo-slot logo-slot--lg" data-role="logo">
    <span data-field="mono"></span>
    <img class="logo-slot__img" data-field="logo" alt="" hidden>
  </span>
  <span class="arrival__id">
    <span class="arrival__ticker" data-field="symbol"></span>
    <span class="arrival__name"   data-field="name"></span>
  </span>
  <span class="arrival__amount mono" data-field="amount"></span>
</li>
```

`[data-field="amount"]` is the signed token amount (`+0.0184`) and is the one
place on the page besides price changes where green appears.

---

## 11. Stock drawer (`#stock-drawer`, a native `<dialog>`)

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
| `#drawer-mcap`, `#drawer-liquidity`, `#drawer-holders`, `#drawer-underlying` | stat grid — this is now the **only** place market cap and liquidity are shown |
| `#drawer-mint`, `#btn-copy-stock-mint` | full mint + copy |
| `#btn-drawer-add` | add to basket (disable when already picked or the basket is full) |
| `#btn-drawer-close`, `#btn-drawer-close-x` | close |

Chart-range tabs use the same roving-tabindex pattern as §2: `aria-selected`,
`tabindex` 0/-1, Arrow/Home/End, and selecting a tab sets `#chart-panel`'s
`aria-labelledby` to that tab's id and refetches
`/api/universe/:symbol/history?range=…`.

Chart colours must come from CSS variables, read at creation time and re-read
when the theme changes:
`getComputedStyle(document.documentElement).getPropertyValue('--chart-grid')`
— also `--chart-line`, `--chart-up`, `--chart-down`, `--chart-axis`, `--surface`.
Never hardcode a hex in JS. Destroy and recreate (or `applyOptions`) the chart
on theme change and on drawer close.

---

## 12. Wallet modal (`#wallet-modal`, a native `<dialog>`)

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

## 13. Theme, footer, toasts

### Theme — dark is the default

- **Dark is the default**, on bare `:root`. Light comes from
  `prefers-color-scheme: light` automatically.
- An explicit choice is `document.documentElement.dataset.theme = 'dark' | 'light'`.
  Both directions win over the system preference.
- Persist under `localStorage['stockdrop:theme']` — an internal identifier that
  deliberately kept its old name through the rename. Apply it as the first
  statement of `app.js`. Wrap every `localStorage` access in try/catch — private
  windows throw.
- `#theme-toggle` now lives in the **footer**. On toggle: swap `hidden` between
  `#theme-icon-sun` (shown while the page is light) and `#theme-icon-moon`
  (shown while dark), update `aria-pressed` (`true` when dark) and `aria-label`
  ("Switch to dark theme" / "Switch to light theme"). The markup ships with the
  moon shown and `aria-pressed="true"`, matching the dark default.
- Also update `<meta name="theme-color">` if you like; not required.

### Footer

`#btn-refresh` (footer) → refetch everything; add `.is-busy` while in flight if
you want a hook (no CSS depends on it).
`#footer-mode` → `mode DRY_RUN`, `#footer-api` → the API base host,
`#footer-updated` → last successful fetch time. `#footer-source` is a plain
sentence today; replace it with an anchor only when a real repository URL exists.

### Toasts

`#toast-region` is `role="status" aria-live="polite"` and renders a dark pill at
the **bottom centre**. Clone `#tpl-toast`:

```html
<div class="toast" data-kind="info" role="alert">
  <svg class="toast__icon">…</svg>
  <div class="toast__body">
    <p class="toast__title" data-field="title"></p>
    <p class="toast__text"  data-field="text"></p>
  </div>
  <div class="toast__actions" data-role="actions" hidden>
    <button class="btn btn--sm" data-action="retry">Retry</button>
  </div>
  <button class="btn btn--icon btn--sm toast__close" data-action="dismiss" aria-label="Dismiss">…</button>
</div>
```

- `dataset.kind` = `info` | `success` | `warn` | `error` (sets the icon colour;
  `error` also colours the border).
- The pill is one line: keep the title short and the text shorter. Leave
  `[data-field="text"]` empty when there is nothing to add.
- Show the retry affordance with `actions.hidden = false` and attach your retry
  callback to `[data-action="retry"]`.
- Auto-dismiss success/info after ~4s; **never** auto-dismiss an error that has
  a retry. Cap the region at ~3 toasts, dropping the oldest.
- Errors are for real failures only. A pre-launch "no token yet" is a normal
  empty state, not an error.

---

## 14. How-it-works panel

`#step-interval`, `#step-eligible-pct` and `#rule-*` are rewritten from
`/api/config` so the prose matches the running server.

Step 2 is the anti-cheat rule and belongs entirely to `/api/config.rules`:

- `#step-snapshot-title` / `#step-snapshot-text` are rewritten from
  `rules.antiCheat` and `rules.openSnapshotWindowMin`. With `antiCheat === true`
  the copy says two snapshots — one `openSnapshotWindowMin` before the mark, one
  at the drop — and that the wallet is weighted by the **smaller** of the two, so
  buying after the first snapshot pays nothing that round (the first drop is the
  round after) and selling before the drop pays nothing either. With
  `antiCheat === false` it states the single-snapshot rule.
- When the server sends no `antiCheat` flag at all, the shipped markup is left
  exactly as it is. The page never claims a rule the running server did not
  report.
- The rewrite rebuilds `#step-snapshot-text`, so it re-creates the
  `#step-interval` span inside it. Run it **before** the basket's `renderConfig`,
  which writes into that span.

`#rules-list` restates the basket rules in one place:
`#rule-picks-range` (`2–5`), `#rule-pct-range` (`10–60%`),
`#rule-universe-size` (`20`), `#rule-eligible-pct` (`0.1%`).

`[data-default-basket]` appears four times across the page — write the same
sentence into every one of them with `querySelectorAll`.
`[data-interval-hours]` is the interval in the opening summary.

---

## 15. Complete list of classes JS may add or remove

| class | on | meaning |
|---|---|---|
| `.is-copied` | a copy button | flash confirmation, ~1.2s |
| `.is-selected` | `.chip` in the picker | already in the basket |
| `.is-active` | a `<tr>` in `#stocks-body` | its drawer is open |
| `.is-invalid` | `.pick` | this row breaks validation |
| `.is-stale` | `.pick` | pick is no longer in the universe |
| `.is-mine` | `.bar-row` in `#demand-bars` | in the connected wallet's basket |
| `.is-busy` | `#btn-refresh` | a refetch is in flight (no CSS depends on it) |
| `.badge--live` / `.badge--muted` / `.badge--sim` / `.badge--warn` | badges | swap the badge tone |
| `.pick__note` | a new `<span>` inside a stale pick row | the nag copy |

Attributes JS may set: `data-state`, `data-mode`, `data-dir`, `data-status`,
`data-ok`, `data-paused`, `data-picked`, `data-level`, `data-round-id`,
`data-mint`, `data-symbol`, `aria-*`, `role` never, `hidden`, `disabled`,
`value`, `href`, `src`, `alt`, `textContent`, `title`.

Two style writes only, both declarative:
- `style.width = pct + '%'` on `#vault-progress-fill`, `#basket-meter-fill`,
  `[data-field="bar"]` in demand rows;
- `element.style.setProperty('--pct', String(pct))` on a `.pick` row.

Everything else — colours, spacing, borders, fonts, layout — belongs to the CSS.
If you find yourself writing `style.color` or `style.background`, stop and use a
`data-*` hook instead.

---

## 16. Formatting rules (keep the columns aligned)

- Every number, ticker, address and table cell renders in IBM Plex Mono with
  tabular figures. The classes `.mono` / `.num` are already on the cells that
  need them; keep them when you write text.
- Money: `$1,234.56` under 10k, `$12.3K`, `$4.56M`, `$1.23B`, `$5.56T`.
- SOL: 4 dp for balances, 3 dp for pools. **Never append the unit to a value
  whose markup already has a `.numeral__unit` sibling** (`#vault-balance-sol`).
- Percent change: always signed, 2 dp, plus `data-dir`.
- Addresses: `first4…last4` (`769f…f9up`) via one shared `truncAddr()`; the full
  value goes in the `title` attribute and in the clipboard.
- Token amounts arrive as base-unit strings plus `decimals`. Convert with
  BigInt, not floats. Show at most 6 significant decimals for stock tokens
  (8 decimals) and label the raw amount in the `title`.
- Times: UTC everywhere, `HH:mm` or `YYYY-MM-DD HH:mm`, with the literal `UTC`
  next to the first one on screen. Do not silently localise.
- `null` / unknown renders as `—` (em dash), never `0`, `N/A` or `undefined`.
- **A display numeral takes a value, not a sentence.** `#vault-balance-sol`,
  `#countdown-value` and `#stat-eligible-wallets` are set at 40–54px; a sentence
  in one of them wraps to four lines. The explanation goes in the `.card__sub`
  or the note slot beside it.

### Copy buttons

`#btn-copy-ca` (header), `#btn-copy-mint` (Overview identity strip) and
`#btn-copy-stock-mint` (drawer). All follow one helper:

```js
await copyToClipboard(fullValue, btn, 'Contract address copied.');   // ui/toast.js
```
`copyToClipboard` tries `navigator.clipboard.writeText`, falls back to an
off-screen textarea plus `document.execCommand('copy')` when the Clipboard API is
missing or rejects (insecure context, denied permission), flashes `.is-copied` on
the button for ~1.2s and toasts. If both paths fail it toasts an error — it never
throws and never claims a copy that did not happen. Never pass a truncated value,
and never put the value in the URL.

---

## 17. Honesty rules (these are product requirements, not style)

1. If `TOKEN_MINT` is blank, the page says `TBA — not launched` and no holder,
   price, round or eligibility number is invented anywhere.
2. Anything derived from `mode !== 'LIVE'` carries a visible `Simulated` badge —
   the identity strip, the projection panel, every simulated round row.
3. Empty is not an error. Use the `empty` pane and its shipped copy.
4. Skipped rounds are shown, with their reason (`no_token`, `low_pool`,
   `no_holders`). They are evidence the keeper ran, not a failure to hide.
5. No number appears on screen that did not come from the API this session.
   **The frames contain mock figures — 214 eligible wallets, 12.34 SOL, a 69%
   ring. None of them may ship.** Every one of those slots starts as `—` in the
   markup and stays that way until the API answers.
6. The vault address is never rendered, and the page never tells anyone to send
   SOL anywhere. The balance is shown; the address is not (§5a).
7. The contract-address button copies `config.token.mint` or nothing at all. No
   placeholder that reads like an address, ever.
8. `#round-snapshot` and `#arrivals` are hidden unless the API reported the
   thing they describe. Neither has a fake or demo state.

---

## 18. Boot order that matches the shell

1. Apply the stored theme (dark is the default when nothing is stored).
2. Wire the tab bar (§2) and read the URL hash.
3. `GET /api/config` → rules text, token identity, mode pill, footer, countdown
   target, `#rounds-empty-time`, `#vault-min-pool`, `#holders-threshold`,
   `#rule-*`.
4. `GET /api/universe` → tape, `#stocks-body`, `#basket-add-list`, and the
   default basket (top 5 × 20%) if the user has no saved prefs.
5. `GET /api/stats` → `#card-round`, `#card-holders`, `#demand-bars`,
   `#demand-basis`, `#stat-distributed`, `#stat-rounds-count`.
6. `GET /api/vault` → `#card-vault` and holdings.
7. `GET /api/rounds?limit=25` → ledger.
8. Restore a stored session token → `GET /api/me` → basket, projection,
   `#stat-your-share`, `#snapshot-check`, `#arrivals`.

Each of these owns its own `[data-state]` container, so a slow or failing
endpoint degrades only its own card. Never leave a container on `loading`
after a rejection — flip it to `error` and offer the retry button that is
already in the markup.

Polling: prices/tape and stats every 60s, vault every 60s, rounds every
5 min, countdown every 1s. Pause polling when `document.hidden`. Panels that are
`hidden` still get their data — switching tab must never show a spinner for
something that was already fetched.
