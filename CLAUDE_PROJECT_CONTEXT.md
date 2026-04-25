# ReagentSearch — Claude Project Context

## What this project is
A lab reagent price comparison website. Users search by product name, CAS number, or catalog number, and the app queries 6 chemical vendors in parallel and returns prices, availability, and links.

Live vendors: **Sigma-Aldrich, Thermo Fisher, VWR, Cayman Chemical, TCI America, Strem Chemicals**

---

## Tech Stack
- **Frontend**: React 18 + Vite (in `src/`)
- **Backend**: Netlify Functions (Node.js 18, CommonJS) in `netlify/functions/`
- **Search**: DuckDuckGo HTML scraping (free, no key) → Brave Search API (optional, better quality) → direct vendor APIs (last resort)
- **Caching**: Firebase Firestore (optional, 4-hour TTL) — gracefully disabled if `FIREBASE_SERVICE_ACCOUNT` env var not set
- **Deployment**: Netlify (run `netlify dev` from project root for local dev on port 8888)

---

## Key Files

```
reagent-compare/
├── netlify/
│   └── functions/
│       ├── search.js              # Main Netlify Function handler — orchestrates search
│       ├── package.json           # {"type":"commonjs"} — overrides root ESM
│       └── _vendors/
│           ├── _utils.js          # Shared utilities (fetch, JSON-LD, relevance filter, etc.)
│           ├── index.js           # Exports [sigma, thermofisher, vwr, cayman, tci, strem]
│           ├── ddg-search.js      # DuckDuckGo HTML search (primary, no API key)
│           ├── brave-search.js    # Brave Search API (optional, needs BRAVE_API_KEY)
│           ├── sigma.js           # Sigma-Aldrich (GraphQL API + HTML fallback)
│           ├── thermofisher.js    # Thermo Fisher (HTML scrape)
│           ├── vwr.js             # VWR (HTML scrape)
│           ├── cayman.js          # Cayman Chemical (HTML scrape)
│           ├── tci.js             # TCI America (SAP OCC API — blocked; HTML fallback)
│           ├── strem.js           # Strem Chemicals (HTML scrape)
│           └── test-apis.js       # CLI test script: node test-apis.js [query]
└── src/
    ├── App.jsx                    # Main app — search state machine
    ├── App.css                    # All styles
    └── components/
        ├── SearchBar.jsx
        ├── ResultsGrid.jsx        # Flattens vendor results, sort by price/shipping/vendor
        ├── VendorCard.jsx         # Displays one product result
        └── LoadingState.jsx
```

---

## How Search Works

**`netlify/functions/search.js`** is the entry point (`GET /api/search?q=acetone`):

1. **Cache check** — If Firebase configured, check Firestore for a cached result < 4 hours old
2. **Brave Search** (if `BRAVE_API_KEY` set) — queries `site:domain` per vendor, extracts product URLs, fetches pages for JSON-LD prices
3. **DuckDuckGo** (fallback, or default if no Brave key) — same approach using `html.duckduckgo.com/html/`
4. **Direct vendor APIs** (last resort) — calls each vendor module's `search(query)` directly

**DDG/Brave approach (primary):**
- Query: `acetone site:sigmaaldrich.com` (domain-only — path-specific `site:` returns 0 results in DDG)
- Extract product URLs from DDG's `uddg=` redirect links, validate against `catNoRe` regex
- Fetch each product page, extract price from `JSON-LD` (`schema.org/Product`) or `__NEXT_DATA__` (Next.js SSR)
- Run `isRelevantResult()` filter to reject unrelated products

**Env vars needed:**
- `BRAVE_API_KEY` — optional, enables Brave Search (2k free/month)
- `FIREBASE_SERVICE_ACCOUNT` — optional JSON string, enables Firestore caching

---

## Vendor-Specific Notes

| Vendor | Direct API | Notes |
|--------|-----------|-------|
| Sigma-Aldrich | GraphQL POST to `/api/2.0/catalog/products` | Must use `{"query":"..."}` body — it's GraphQL, not REST. Falls back to HTML + `__NEXT_DATA__` |
| Thermo Fisher | No working API found (404s) | HTML scrape only; prices often missing (SPA, need JS) |
| VWR | No working JSON API | HTML scrape; falls back to product page JSON-LD |
| Cayman Chemical | `/api/catalog/products?keyword=` | JSON API works; also has JSON-LD on product pages |
| TCI America | SAP Commerce OCC `/occ/v2/{siteId}/products/search` | **All OCC endpoints return 403 from serverless**; HTML scrape only |
| Strem Chemicals | No API | HTML + JSON-LD; works reasonably well |

---

## Key Utilities (`_utils.js`)

- `fetchJson(url, opts, timeoutMs)` — fetch with timeout, throws on non-2xx
- `fetchHtml(url, opts, timeoutMs)` — same but returns text
- `extractJsonLd(html)` — extracts all `schema.org/Product` JSON-LD blocks via regex
- `extractNextData(html)` — extracts `__NEXT_DATA__` SSR blob from Next.js pages
- `isRelevantResult(query, name, cas, cat)` — rejects unrelated products (e.g. featured items leaking into SPA scrapes). Matches on: exact CAS, catalog number, or all query words in product name
- `normalizeAvailability(raw)` — maps any availability string to standard values
- `buildShippingText(obj)` — extracts shipping time from various field names
- `parsePrice(raw)` — parses price to float or null

---

## Known Issues / Limitations

1. **DDG rate limiting** — DDG may rate-limit aggressive server-side requests. The code staggers vendor requests 150ms apart and uses realistic browser headers. Brave Search API is more reliable if available.
2. **SPA prices** — Most vendor sites render prices via JavaScript. The code relies on JSON-LD (server-rendered) or `__NEXT_DATA__` SSR blobs. Sites that client-side render prices (no SSR) will show "see product page."
3. **TCI shipping times** — OCC API blocked; no reliable shipping time data from TCI.
4. **Abbreviation searches** — `isRelevantResult` splits on words > 2 chars, so abbreviations like "THF" won't match "Tetrahydrofuran." Users should search full names.
5. **No price for Thermo Fisher** — Their search endpoints all 404. Prices only appear if JSON-LD is present on product page (which it often isn't for ThermoFisher).

---

## Running Locally

```bash
cd reagent-compare
npm install          # install frontend deps
cd netlify/functions
npm install          # installs firebase-admin if needed (optional)
cd ../..
netlify dev          # starts on localhost:8888
```

Test the backend directly:
```bash
node netlify/functions/_vendors/test-apis.js acetone
```

---

## Current State (as of last session)

- DDG search fixed: now uses domain-only `site:` filter (path-specific was returning 0 results)
- `sigma.js` and `brave-search.js` written from scratch (were empty files)
- All 6 vendor modules + utilities load without errors
- Frontend shows search mode indicator (DDG/Brave/Direct API) and improved no-results message
- Firebase caching wired up but optional
- No Brave API key configured yet — running on DDG only
