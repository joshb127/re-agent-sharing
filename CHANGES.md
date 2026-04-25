# Fixes applied — 2026-04-18

Short version: bugs listed in `DIAGNOSTIC.md` have been patched. Source lines
changed are contained — no restructuring — so deploy should be a no-op build.

## What changed

### 1. Sigma-Aldrich HTML fallback now actually reaches the server
`netlify/functions/_vendors/sigma.js` — swapped the hash-fragment search URL
(`/US/en/search#q=...`, which the server never saw) for the real path-based
URL (`/US/en/search/<query>?focus=products&term=<query>...`). The HTML
fallback chain downstream of this URL (`__NEXT_DATA__`, JSON-LD, link regex)
is now operating on actual search results.

### 2. Cache TTL 4h → 15m, and cache metadata is now first-class
`netlify/functions/search.js` — TTL cut to 15 minutes to match the
"live-verified" contract. The cached payload now returns `cachedAt`,
`cacheAgeMs`, and `cacheTtlMs` so the UI can say exactly when the data was
verified.

### 3. Every result carries provenance
New `stampResult(r, source)` helper in `_utils.js`. All five scrape paths
(Sigma API / Sigma listing / Sigma link-only / Thermo listing / Thermo live
enrichment / Brave live / DDG live / fallback link-only) now tag each result
with:
- `source`: `api` | `live` | `listing` | `link`
- `fetchedAt`: unix ms of the scrape

`VendorCard` renders a pill + "Verified 12m ago" on every card. Link-only
results (only URL verified; no parsed price/shipping) get an orange pill so
they're visibly distinct from structured-data-backed cards.

### 4. `isRelevantResult` loosened
`_utils.js` — was "all query words must appear in product name" (which rejected
"BSA" when searching "bovine serum albumin"). Now:
- CAS-shaped query → still requires exact CAS/catalog match
- Catalog-shaped query → catalog prefix match OR query literal in name
- Word-bag query → majority (≥⌈N/2⌉) of query words must appear, OR the full
  query string appears literally in the name

### 5. Timeouts surface distinctly in the UI
`search.js` `runWithTimeout` now returns `{ results, timedOut }` instead of
silently resolving to `[]`. The top-level payload exposes `timedOut: true`.
`ResultsGrid` renders a dedicated "Search took too long" state so users can
distinguish a stalled backend from a legitimately empty result set.

### 6. Thermo Fisher's speculative API endpoints removed
`thermofisher.js` — dropped the two undocumented XHR endpoints that were
effectively always 404ing and adding round-trip latency. Goes straight to HTML
scraping + per-result enrichment from the live product page.

## Files touched

| File | Reason |
|---|---|
| `netlify/functions/search.js` | Cache TTL, cache metadata, timeout handling |
| `netlify/functions/_vendors/_utils.js` | Loosened `isRelevantResult`; new `stampResult` helper |
| `netlify/functions/_vendors/sigma.js` | Fixed hash URL; stamped results |
| `netlify/functions/_vendors/thermofisher.js` | Removed speculative APIs; stamped results |
| `netlify/functions/_vendors/brave-search.js` | Stamped results |
| `netlify/functions/_vendors/ddg-search.js` | Stamped results |
| `src/components/VendorCard.jsx` | Verified-at + source pill |
| `src/components/ResultsGrid.jsx` | Distinct timeout state |
| `netlify/functions/_vendors/test-harness.js` | (new) Local diagnostic runner |
| `DIAGNOSTIC.md` | (new) Full static review |

## How to see the changes live

The project folder is not a git repo and has no Netlify CLI credentials, so I
can't deploy from here. From your terminal, one of these will push the fix:

**If you use Netlify's GitHub-connected deploy:**
```bash
git add -A
git commit -m "fix: Sigma URL, stale cache, result provenance"
git push
# Netlify auto-builds — refresh your site URL in ~60s.
```

**If you use Netlify CLI direct deploy:**
```bash
npm run build
netlify deploy --prod
```

**To preview locally before deploying:**
```bash
netlify dev
# Then open http://localhost:8888
```

**To verify the scrapers themselves are returning real data:**
```bash
node netlify/functions/_vendors/test-harness.js --vendors=sigma,thermofisher
# writes test-harness-report.json
```

## Things you should see after deploy

1. A "Live" / "API" / "Listing" / "Link only" pill + "Verified Xm ago" on
   every result card.
2. Searches that previously returned "No results" because of
   `isRelevantResult` being too strict (e.g., "BSA" matching a product named
   "Bovine Serum Albumin, lyophilized") should now return hits.
3. Sigma should show up more reliably in results when its GraphQL API is
   down or rate-limiting — the HTML fallback is no longer broken.
4. If a vendor call stalls, you'll see "Search took too long" instead of
   "No results found for &ldquo;…&rdquo;".
