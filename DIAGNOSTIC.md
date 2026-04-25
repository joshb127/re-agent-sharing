# ReagentCompare — scraper & accuracy diagnostic

**Date:** 2026-04-18
**Scope:** Sigma-Aldrich + Thermo Fisher are the priority vendors; search pipeline
and result-card data contract are reviewed alongside them.

---

## How this was produced

The scrapers could not be exercised from this session (the sandbox's network
egress blocks every vendor and search domain). Findings below come from a static
read of `netlify/functions/` and `src/`. A runnable diagnostic harness has been
added at `netlify/functions/_vendors/test-harness.js` — run it locally to
convert these hypotheses into measured facts:

```bash
# From the project root, with internet:
node netlify/functions/_vendors/test-harness.js

# Narrow to your priority vendors + a single query:
node netlify/functions/_vendors/test-harness.js \
  --vendors=sigma,thermofisher \
  --queries="67-64-1,A1978,sodium chloride"
```

It writes `test-harness-report.json` with per-vendor, per-query status, result
count, how many results actually have a price / shipping string / reachable URL,
and a sample of the first result. That report is the ground truth we should
make decisions from.

---

## Critical bugs (high confidence, from code alone)

### 1. Sigma HTML fallback uses a hash-routed search URL → always returns an empty shell

In `netlify/functions/_vendors/sigma.js`:

```js
const searchUrl = `${BASE}/US/en/search#q=${encodeURIComponent(query)}&t=Products`;
const html = await fetchHtml(searchUrl, ...);
```

`#q=...` is a URL **fragment**. Fragments are never sent to the server, so the
server-side request is just `/US/en/search` — the generic search landing page
with no results for your query. Every regex / `__NEXT_DATA__` / JSON-LD pass
after this point is reading a page that knows nothing about the query. That's
why the HTML fallback almost certainly never recovers when the GraphQL call
fails; it silently returns `no_results` instead of real hits.

**Fix:** switch to a query-string or path-based search URL. Sigma's current
user-facing search pattern is (as of 2026-04):
`https://www.sigmaaldrich.com/US/en/search/<query>?focus=products&page=1&perpage=30&sort=relevance&term=<query>&type=product`
Verify the exact pattern with the harness, then replace the hash URL.

### 2. Result cards can display stale data while claiming to reflect the live site

`netlify/functions/search.js` caches every query's full payload for 4 hours via
Firebase. `ResultsGrid` surfaces a small "Cached Xm ago" chip, but every
VendorCard shows the cached price/shipping with no other signal. Given your
stated contract ("always accurate, always linked to what's actually on the
websites"), this is the single biggest user-trust risk. Two fixes, pick one:

- **Strict live-verify (matches your stated preference):** on display,
  re-fetch the product page for each card and only show price / shipping /
  availability if the live page parse succeeds. Otherwise show "See product
  page" and leave just the outbound link. Drop the 4hr payload cache; keep a
  short (≤15min) cache keyed on the product URL to smooth rapid re-queries.
- **Source & freshness per card:** add `source` ("live" | "snippet" | "cache")
  and `verifiedAt` timestamps to every `result`, and render them on
  `VendorCard`. Honest but more UI work.

### 3. Primary search path (Brave / DDG) can attach snippet-scraped prices to live URLs

`search.js` prefers `braveSearchAll` when `BRAVE_API_KEY` is set, falling back
to `ddgSearchAll`. Both of those modules extract prices from search-result
snippets, which are the vendor's own metadata as the search engine indexed it —
sometimes days or weeks ago. The product URL attached to that price will still
open the live page, but the number shown on the card may not match what the user
sees after click-through. Same remediation as #2: re-fetch the live page before
showing a price, or tag the result with `source: "snippet"` and suppress price.

---

## Likely bugs (medium confidence — verify with the harness)

### 4. `isRelevantResult` rejects legitimate plain-text matches

`_utils.js` requires **every** query word (≥3 chars) to appear literally in the
product name. "bovine serum albumin" rejects a product listed as "BSA,
lyophilized powder" because "bovine", "serum", "albumin" don't all appear. CAS
and catalog matches are handled separately and are fine; the issue is only for
word-bag queries.

**Fix:** switch to majority-match (e.g. ≥60% of query words present) plus a
pass for CAS / catalog number hits inside either name OR the result's structured
fields.

### 5. `runWithTimeout` silently returns `[]` → UI cannot tell "we timed out" from "nothing found"

```js
new Promise(resolve => setTimeout(() => {
  console.warn(`[Search] ${label} global timeout`);
  resolve([]);
}, ms))
```

The whole vendor set disappears on a global timeout with no surface to the
client. Emit a sentinel envelope (`{ vendors: [], searchMode, timedOut: true }`)
so `ResultsGrid` can show a "Search took too long, try again" state rather than
"No results".

### 6. Thermo's speculative API endpoints are probably 404s

`thermofisher.js` hits `/api/search/query` and `/search/searchWebservice.json`
before falling back to HTML scraping. Both are undocumented; if they 404 on
every call, you're paying 2× network RTT per request for nothing. The harness's
`elapsedMs` column per vendor call will show whether Thermo is slow for this
reason — if so, delete those two endpoints and go straight to HTML.

### 7. 8-second cap on `runDirectVendorSearch` vs. 5-second enrich budget per result

When Thermo's initial scrape returns results without prices, it tries
`enrichFromProductPage` with a 5s cap **per result** in parallel. The outer
8-second cap in `runDirectVendorSearch` can cancel the entire vendor's answer
mid-enrichment on a single slow page. Either raise the outer cap, or move
enrichment outside the race.

### 8. Result ordering in `ResultsGrid` uses `parseShippingDays` heuristically

`parseShippingDays` matches `/(\d+)\s*(?:[-–to]+\s*(\d+))?\s*business/`. The
`[-–to]+` is a character class, which matches any combo of `-`, `–`, `t`, `o`
letters. "ships in 3tot business days" would match. Benign today but replace
with `(?:-|–|\s*to\s*)` for cleanliness.

---

## Design gaps (no bugs, but relevant to your goal)

### 9. No live link-integrity check before rendering a card

Every card renders an "Order on $vendor →" link but there's no guarantee the
URL still 200s. For the "always linked to what's actually on the websites"
promise, either:

- HEAD-check each URL server-side before returning (cheap; add a 2s cap), drop
  results that 404/410; or
- Accept that some links will rot and show a "⚠ This link may be outdated"
  badge when the product page fails a head check.

The test harness already does the HEAD check per result, so you can see in the
report how often URLs in today's scrapes are actually live.

### 10. Per-vendor rate limiting is unimplemented

Every inbound `/api/search` request fans out to all six vendors. A small traffic
spike will earn you 429s from Sigma/Thermo in minutes. Add request coalescing
(dedupe in-flight requests by normalized query) and a per-vendor token bucket
before you put this in front of real users.

### 11. No vendor coverage of pack sizes when they exist

Sigma's `paDetails` can return multiple pack sizes per SKU, each with its own
price. `sigma.js` takes the first two (`paDets.slice(0, 2)`) and flattens them
into the result list. This is fine, but the UI treats each pack size as a
separate "vendor card" with the same vendor name — visually redundant. A grouped
pack-size switcher inside one card would be tighter.

### 12. Currency is assumed USD throughout

`parsePrice` strips the currency symbol; the result's `currency` field defaults
to `'USD'` when the vendor didn't specify. If you ever expand beyond the US
site, this needs to become first-class (display the right symbol, and never mix
currencies in the sorted "cheapest first" list).

---

## Recommended next sequence

1. **Run the harness.** Get concrete data on Sigma + Thermo today. Take 2
   minutes: `node netlify/functions/_vendors/test-harness.js --vendors=sigma,thermofisher`
2. **Fix the Sigma hash URL bug (#1).** Probably unlocks the entire HTML
   fallback path.
3. **Implement live-verify on display (#2).** Replace the 4hr cache with a
   per-URL ≤15min cache, add a `verifiedAt` timestamp to every result, and
   re-fetch the product page before rendering a price. This is the single
   change that most directly delivers your "always accurate" promise.
4. **Decide the snippet-vs-live rule (#3).** Either never show a price from a
   snippet (safest), or tag snippet-sourced cards.
5. **Loosen `isRelevantResult` (#4)** so CAS/catalog queries still find the
   product when the display name uses a synonym/abbreviation.

Items 6–12 are smaller polish / hardening — tackle after steps 1–5 are proven
by the harness.
