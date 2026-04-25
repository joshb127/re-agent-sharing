# reagent-compare — Handoff to browser Claude

Paste this file into a new **Claude Project** (as Knowledge) or drop it at the
start of a fresh conversation. It's self-contained: any Claude instance reading
only this file should be able to keep working without asking you for backstory.

---

## What this project is

A website that compares lab reagent vendors (Sigma-Aldrich, Thermo Fisher,
Fisher Scientific, etc.) on **price and shipping times**, with the promise that
every price/shipping number shown is **live-verified** — pulled from the actual
vendor page, not cached marketing copy. Target user: lab managers, scientists,
procurement folks tired of opening six tabs to price-compare one reagent.

**Owner:** Josh (berg@vincerebio.com)
**State:** working prototype, runs locally via `npm run dev:local`, not yet deployed publicly.

---

## Tech stack

| Layer | Tech |
|---|---|
| Frontend | React 18 + Vite 5, no CSS framework (hand-rolled in `App.css`) |
| Backend | Netlify Functions (`netlify/functions/search.js`) — Node 18 `exports.handler` |
| Scraping | Built-in `fetch`, regex, JSON-LD / `__NEXT_DATA__` extraction |
| Search engines (URL discovery) | Brave Search API (optional key), DuckDuckGo HTML (no key) |
| Cache | Firebase (optional, 15-min TTL) — skipped if env vars missing |
| Dev server | Custom `scripts/local-dev.mjs` — no Netlify CLI needed |

---

## File tree (abridged)

```
reagent-compare/
├── index.html
├── package.json                        # "dev:local" script → local-dev.mjs
├── vite.config.js                      # /api/search → :8888 proxy
├── netlify.toml
├── scripts/
│   └── local-dev.mjs                   # One-command dev server (no Netlify CLI)
├── src/
│   ├── App.jsx, App.css, main.jsx
│   └── components/
│       ├── SearchBar.jsx
│       ├── ResultsGrid.jsx             # Handles timeout / no-results states
│       ├── VendorCard.jsx              # Renders one vendor's result + provenance pill
│       └── LoadingState.jsx
└── netlify/
    └── functions/
        ├── search.js                   # HTTP entrypoint, fans out to vendors, caches
        └── _vendors/
            ├── _utils.js               # Shared: fetchJson, fetchHtml, isRelevantResult,
            │                           #         stampResult, extractPriceFromHtml,
            │                           #         extractShippingFromHtml, buildShippingText
            ├── sigma.js                # Sigma-Aldrich (GraphQL + HTML + enrichment)
            ├── thermofisher.js         # Thermo Fisher (HTML + enrichment)
            ├── brave-search.js         # Generic vendor discovery via Brave Search
            ├── ddg-search.js           # Generic vendor discovery via DuckDuckGo HTML
            ├── index.js                # Vendor registry
            └── test-harness.js         # Diagnostic runner — `node test-harness.js --vendors=...`
```

---

## Data contract (what every result looks like)

Every result object returned by a vendor module has this shape:

```js
{
  vendorId:      'sigma',            // machine id
  vendorName:    'Sigma-Aldrich',
  color:         '#e31e24',          // brand color for the card stripe
  catalogNumber: 'A7906',
  productName:   'Albumin from bovine serum',
  casNumber:     '9048-46-8',
  price:         52.40,              // number | null  (USD)
  currency:      'USD',
  pricePer:      '1 g',              // pack size or similar
  availability:  'In Stock',         // normalized to a known set
  shippingTime:  'Ships next business day',  // string | null
  productUrl:    'https://www.sigmaaldrich.com/US/en/product/sial/a7906',
  // Provenance — added by _utils.stampResult(r, source):
  source:        'live',             // 'api' | 'live' | 'listing' | 'link'
  fetchedAt:     1745351600000       // Date.now() at scrape time
}
```

`source` meanings (shown as a pill on each card):

- `api` — vendor's structured API returned this (best, rare)
- `live` — parsed from the vendor's live product page (JSON-LD / `__NEXT_DATA__` / HTML regex)
- `listing` — parsed from a vendor search-results listing page
- `link` — only the URL is verified; no structured price/shipping — click through. Rendered with an orange pill.

---

## Flow of a search request

```
Browser
  └─ GET /api/search?q=acetone
       └─ Vite proxy → POST /.netlify/functions/search?q=acetone (port 8888)
            └─ search.js:
                 1. Check Firebase cache (if configured) — hit? return cached payload
                 2. Fan out to vendor modules in parallel, each wrapped in runWithTimeout
                 3. Merge results, stamp with cachedAt/cacheAgeMs/cacheTtlMs/timedOut
                 4. Write back to cache (15 min TTL)
                 5. Return { results: [...per-vendor-bundles...], timedOut }
```

---

## What's DONE and working

1. **Sigma HTML fallback fixed.** Was using a hash-fragment URL (`#q=...`) that never reached the server. Now uses path-based URL `/US/en/search/<query>?focus=products&...`.
2. **Cache TTL 4h → 15 min.** Matches the "live-verified" promise. Payload exposes `cachedAt`, `cacheAgeMs`, `cacheTtlMs`.
3. **Every result has provenance** (`source` + `fetchedAt`). UI renders a pill ("Live" / "API" / "Listing" / "Link only") and "Verified Xm ago".
4. **`isRelevantResult` tightened for catalog-shaped queries.** See `_utils.js`. CAS queries: exact match only. Catalog queries (alphanumeric ≥4 chars, must contain a digit): exact match on `catalogNumber` field, or pack-size variant with separator (`A7906-1G`), or whole-word match in `productName` (for cases like Thermo reselling BD's `362761` — BD# shows up in product name but Thermo uses own SKU as catalog#).
5. **Timeouts surface distinctly in UI.** `runWithTimeout` returns `{ results, timedOut }`; `ResultsGrid` shows a "Search took too long" state instead of silently showing "No results."
6. **Thermo's speculative API endpoints dropped.** They were 404-ing. Goes straight to HTML scraping + per-result enrichment.
7. **Price / shipping extraction is multi-layer.** Enrichment (`enrichFromProductPage` in both sigma.js and thermofisher.js) now tries:
   - JSON-LD `offers.price` + `offers.availability`
   - `__NEXT_DATA__` — `pageProps.product` / `pageProps.productData` / `paDetails[]`
   - `extractPriceFromHtml` (microdata `itemprop="price"`, `data-price`, `class="price..."`, or `$XX.XX` near "Add to cart")
   - `extractShippingFromHtml` (regex for "Ships in X business days", "Ships today", "Ships next business day", "Estimated delivery…", etc.)
8. **Zero-install local dev.** `npm run dev:local` runs the function on :8888 and Vite on :3000 in one process — no Netlify CLI, no global installs.

---

## Open issues / next steps

### 1. Thermo HTML scraper falls through to link-only for many queries
`thermofisher.js` tries three search URLs, then `__NEXT_DATA__`, then JSON-LD, then a URL-regex fallback. The URL-regex path populates `productName` with the catalog# (not the real name). Consequence: when user searches a manufacturer part number (e.g., BD's `362761`) and Thermo carries it under a different SKU, the product name on our result is blank-ish and `isRelevantResult` filters it out.

**Fix path:** after the URL-regex scan returns N candidates, fetch each product page concurrently and extract the real `productName` (JSON-LD or `<title>`) before relevance-filtering. Cost: +~1 HEAD/GET per candidate, capped to 5. Probably worth it for manufacturer-part searches.

### 2. Some vendor pages render price entirely via JavaScript
For pages where the raw HTML has no `$XX.XX` and no JSON-LD offer, we can't get a price with anonymous `fetch`. Options: (a) accept the gap and show the orange "Link only" pill — current behavior; (b) use a headless browser (Playwright / Puppeteer) from a background worker — significant infra upgrade.

### 3. Acronym-to-full-name matching (e.g., "BSA" → "Bovine Serum Albumin")
`isRelevantResult` doesn't know acronyms. Currently fails gracefully (rejects instead of showing wrong thing) but means the user has to type the full name. Fix path: tiny hand-curated map of common lab acronyms in `_utils.js`. Low priority.

### 4. No deploy yet
Project folder isn't a git repo; user has no Netlify CLI auth set up locally. Deploy options: connect to GitHub via Netlify dashboard, or run `netlify deploy --prod` after `netlify login`.

---

## How to run locally (tell Josh this in every new session)

```
cd "/Users/joshberg/Dropbox/My Mac (Josh's MacBook Pro)/Desktop/reagent-compare"
npm run dev:local
# open http://localhost:3000
```

Note the path has spaces and an apostrophe — the double quotes are required. The apostrophe might be a smart quote (') in the actual path; easiest way to get the right path: in Terminal, type `cd ` then drag the folder from Finder onto the Terminal window.

**For Thermo debug logging:**
```
DEBUG_THERMO=1 npm run dev:local
```

**To re-run the diagnostic harness:**
```
node netlify/functions/_vendors/test-harness.js --vendors=sigma,thermofisher --queries="acetone,BSA,362761,7647-14-5"
# writes test-harness-report.json
```

Changes to files under `netlify/functions/**` require a server restart (Ctrl-C, re-run). Changes under `src/**` hot-reload via Vite.

---

## Useful test queries

| Query | What it tests |
|---|---|
| `acetone` | Basic word-bag match |
| `sodium chloride` | Multi-word majority match |
| `7647-14-5` | CAS exact match (NaCl) |
| `9048-46-8` | CAS exact match (BSA) |
| `A7906` | Sigma catalog# — should match A7906 and A7906-1G, not A79061 |
| `362761` | BD manufacturer part# — tests name-boundary match on resellers |
| `179124` | Sigma SKU — acetone |
| `BSA` | Known to fail currently (acronym problem) |

---

## Resume prompt for browser Claude

> I'm continuing work on `reagent-compare` — a React + Vite + Netlify Functions site that compares lab reagent vendors on price and shipping. I've attached `HANDOFF.md` which has the full project context, architecture, data contract, and list of open issues. My folder lives at `~/Dropbox/My Mac (Josh's MacBook Pro)/Desktop/reagent-compare` and I run it locally with `npm run dev:local` → http://localhost:3000.
>
> Read the handoff doc, then help me with [SPECIFIC NEXT TASK]. When you need to see a file I haven't pasted, tell me which one and I'll share it.

Replace `[SPECIFIC NEXT TASK]` with whatever you're picking up — likely:
- "Fix the Thermo link-only fallback so it enriches product names before filtering (Open Issue #1)."
- "Add acronym expansion to `isRelevantResult` (Open Issue #3)."
- "Help me get this deployed on Netlify."
