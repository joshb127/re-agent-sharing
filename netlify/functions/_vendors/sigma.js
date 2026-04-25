'use strict';

/**
 * Sigma-Aldrich vendor module.
 *
 * Primary: GraphQL API at /api/2.0/catalog/products
 * Fallback: HTML search page with JSON-LD + __NEXT_DATA__ extraction
 *
 * Sigma's product search URL: https://www.sigmaaldrich.com/US/en/search#q={query}&t=Products
 * Their API is GraphQL — must POST {"query": "..."} — not REST.
 */

const {
  HTML_HEADERS, apiHeaders, isBlocked, normalizeAvailability,
  parsePrice, fetchHtml, fetchJson, extractJsonLd, extractNextData,
  isRelevantResult, buildShippingText, stampResult,
  extractPriceFromHtml, extractShippingFromHtml,
} = require('./_utils');

const ID    = 'sigma';
const NAME  = 'Sigma-Aldrich';
const COLOR = '#e31e24';
const BASE  = 'https://www.sigmaaldrich.com';
const CAT_RE = /sigmaaldrich\.com\/US\/en\/product\/\w+\/([A-Z0-9_-]+)/i;

// ── GQL query variants (different Sigma API schema versions) ─────────────────
function makeGqlBodies(searchTerm) {
  return [
    // Version 1: getCatalogProducts with paDetails (most complete)
    {
      query: `{getCatalogProducts(searchTerm:${JSON.stringify(searchTerm)},site:"US",lang:"en",perpage:5,currentpage:1,type:"substance"){items{productKey name casNumber brand{key}paDetails{materialNumber packSize price currency availability shippingTime}}itemCount}}`,
    },
    // Version 2: productSearch (newer schema)
    {
      query: `{productSearch(searchTerm:${JSON.stringify(searchTerm)},site:"US",language:"en",pageSize:5,pageNumber:1){items{productKey name casNumber brandKey offers{price currency packSize availability}}totalCount}}`,
    },
    // Version 3: simpler getCatalogProducts without paDetails
    {
      query: `{getCatalogProducts(searchTerm:${JSON.stringify(searchTerm)},site:"US",lang:"en",perpage:5,currentpage:1){items{productKey name casNumber brand{key}}itemCount}}`,
    },
  ];
}

async function search(query) {
  let bundle = null;

  try {
    const gqlResult = await searchViaGql(query);
    if (gqlResult && gqlResult.results && gqlResult.results.length > 0) bundle = gqlResult;
  } catch (_) { /* fall through */ }

  if (!bundle) {
    try {
      bundle = await searchViaHtml(query);
    } catch (err) {
      return {
        vendorId: ID, vendorName: NAME, color: COLOR,
        status: isBlocked(err) ? 'blocked' : 'error',
        results: [], error: err.message,
      };
    }
  }

  if (!bundle || bundle.status !== 'success' || !bundle.results?.length) return bundle;

  // ── Enrichment pass ────────────────────────────────────────────────────
  // Sigma's search endpoints increasingly return product metadata without
  // pricing or shipping. For any result missing either, fetch the live
  // product page and pull structured data (JSON-LD / __NEXT_DATA__ / HTML).
  // This is what makes the "always-accurate, always-live-verified" contract
  // actually true.
  const needsEnrich = bundle.results.some(r =>
    r.price === null || r.price === undefined || !r.shippingTime
  );
  if (!needsEnrich) return bundle;

  const enriched = await Promise.all(
    bundle.results.map(r =>
      Promise.race([
        enrichFromProductPage(r),
        new Promise(resolve => setTimeout(() => resolve(r), 6000)),
      ])
    )
  );
  return { ...bundle, results: enriched };
}

// ── Product-page enrichment: fetch the live page and extract price ───────────
async function enrichFromProductPage(result) {
  // Skip if we already have BOTH price and shipping, or we have no URL to hit.
  const hasPrice = result.price !== null && result.price !== undefined;
  const hasShip  = !!result.shippingTime;
  if ((hasPrice && hasShip) || !result.productUrl) return result;
  try {
    const html = await fetchHtml(result.productUrl, { headers: HTML_HEADERS }, 5500);

    // JSON-LD (schema.org/Product) — best source on Sigma product pages
    const ldProducts = extractJsonLd(html);
    for (const p of ldProducts) {
      const offers = Array.isArray(p.offers) ? p.offers : [p.offers].filter(Boolean);
      if (offers.length) {
        const offer = offers[0];
        return stampResult({
          ...result,
          productName:  p.name || result.productName,
          casNumber:    p.casNumber || p.cas || result.casNumber,
          price:        parsePrice(offer.price),
          currency:     offer.priceCurrency || 'USD',
          pricePer:     offer.description || offer.name || result.pricePer,
          availability: normalizeAvailability(offer.availability?.replace('https://schema.org/', '')),
          shippingTime: buildShippingText(offer) || result.shippingTime,
        }, 'live');
      }
    }

    // __NEXT_DATA__ fallback
    const next = extractNextData(html);
    if (next) {
      const prod =
        next?.props?.pageProps?.product ??
        next?.props?.pageProps?.productData ??
        next?.props?.pageProps?.item ??
        null;
      if (prod) {
        // Sigma's __NEXT_DATA__ product shape: paDetails[] has pack-size-level pricing
        const paDets = prod.paDetails || prod.packagingDetails || [];
        const pa = paDets[0];
        if (pa && (pa.price !== undefined || pa.listPrice !== undefined)) {
          return stampResult({
            ...result,
            productName:  prod.name || prod.displayName || result.productName,
            casNumber:    prod.casNumber || prod.cas || result.casNumber,
            price:        parsePrice(pa.price ?? pa.listPrice),
            currency:     pa.currency || 'USD',
            pricePer:     pa.packSize || pa.description || result.pricePer,
            availability: normalizeAvailability(pa.availability || prod.availability),
            shippingTime: pa.shippingTime || buildShippingText(prod) || result.shippingTime,
          }, 'live');
        }
        if (prod.price !== undefined) {
          return stampResult({
            ...result,
            productName:  prod.name || prod.displayName || result.productName,
            casNumber:    prod.casNumber || prod.cas || result.casNumber,
            price:        parsePrice(prod.price?.value ?? prod.price),
            currency:     prod.price?.currency || prod.currency || 'USD',
            pricePer:     prod.packSize || prod.unitSize || result.pricePer,
            availability: normalizeAvailability(prod.availability || prod.stockStatus),
            shippingTime: buildShippingText(prod) || extractShippingFromHtml(html) || result.shippingTime,
          }, 'live');
        }
      }
    }

    // Last-resort: raw HTML regex for price + shipping. Sigma sometimes renders
    // the price into plain HTML without populating JSON-LD offers.
    const htmlPrice = extractPriceFromHtml(html);
    const htmlShip  = extractShippingFromHtml(html);
    if (htmlPrice || htmlShip) {
      return stampResult({
        ...result,
        price:        htmlPrice ? htmlPrice.price : result.price,
        currency:     htmlPrice ? htmlPrice.currency : (result.currency || 'USD'),
        shippingTime: htmlShip || result.shippingTime,
      }, 'live');
    }
  } catch (_) { /* keep original; don't block the page */ }
  return result;
}

// ── GraphQL search ────────────────────────────────────────────────────────────
async function searchViaGql(query) {
  const endpoint = `${BASE}/api/2.0/catalog/products`;
  const headers = {
    ...apiHeaders(`${BASE}/US/en/search`),
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'x-gql-country': 'US',
    'x-gql-language': 'en',
  };

  for (const body of makeGqlBodies(query)) {
    try {
      const data = await fetchJson(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }, 8000);

      // Try to extract items from various response shapes
      const items =
        data?.data?.getCatalogProducts?.items ||
        data?.data?.productSearch?.items ||
        [];

      if (!items.length) continue;

      const results = items.slice(0, 5).flatMap(item => {
        const brand = item.brand?.key || item.brandKey || 'SIAL';
        const catNo = item.productKey || '';
        const productUrl = catNo
          ? `${BASE}/US/en/product/${brand.toLowerCase()}/${catNo}`
          : '';

        // paDetails contains pack-size-level pricing
        const paDets = item.paDetails || [];
        if (paDets.length > 0) {
          return paDets.slice(0, 2).map(pa => stampResult({
            vendorId:      ID, vendorName: NAME, color: COLOR,
            catalogNumber: pa.materialNumber || catNo,
            productName:   item.name || catNo,
            casNumber:     item.casNumber || '',
            price:         parsePrice(pa.price),
            currency:      pa.currency || 'USD',
            pricePer:      pa.packSize || '',
            availability:  normalizeAvailability(pa.availability),
            shippingTime:  pa.shippingTime || null,
            productUrl,
          }, 'api'));
        }

        // offers array (newer schema)
        const offers = item.offers || [];
        if (offers.length > 0) {
          return offers.slice(0, 2).map(o => stampResult({
            vendorId:      ID, vendorName: NAME, color: COLOR,
            catalogNumber: catNo,
            productName:   item.name || catNo,
            casNumber:     item.casNumber || '',
            price:         parsePrice(o.price),
            currency:      o.currency || 'USD',
            pricePer:      o.packSize || '',
            availability:  normalizeAvailability(o.availability),
            shippingTime:  null,
            productUrl,
          }, 'api'));
        }

        // No pricing, but at least return the product link
        if (catNo && productUrl) {
          return [stampResult({
            vendorId:      ID, vendorName: NAME, color: COLOR,
            catalogNumber: catNo,
            productName:   item.name || catNo,
            casNumber:     item.casNumber || '',
            price:         null,
            currency:      'USD',
            pricePer:      '',
            availability:  null,
            shippingTime:  null,
            productUrl,
          }, 'link')];
        }
        return [];
      });

      const relevant = results.filter(r =>
        isRelevantResult(query, r.productName, r.casNumber, r.catalogNumber)
      );
      if (relevant.length > 0) {
        return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'success', results: relevant };
      }
    } catch (_) { /* try next GQL variant */ }
  }
  return null;
}

// ── HTML scraping fallback ────────────────────────────────────────────────────
async function searchViaHtml(query) {
  // IMPORTANT: Sigma's user-facing search uses path routing (`/search/<term>`)
  // plus a ?term= query param. The previous hash-fragment URL (`#q=...`) never
  // reached the server — fragments are client-only — so the HTML fallback was
  // effectively no-op before this fix.
  const encoded = encodeURIComponent(query);
  const searchUrl =
    `${BASE}/US/en/search/${encoded}` +
    `?focus=products&page=1&perpage=30&sort=relevance&term=${encoded}&type=product`;
  const html = await fetchHtml(searchUrl, { headers: HTML_HEADERS }, 9000);

  // Try __NEXT_DATA__ first
  const next = extractNextData(html);
  if (next) {
    const searchResults =
      next?.props?.pageProps?.searchResults?.items ||
      next?.props?.pageProps?.items ||
      next?.props?.pageProps?.products || [];

    if (searchResults.length > 0) {
      const results = searchResults.slice(0, 5).map(item => {
        const brand = item.brand?.key || item.brandKey || 'sial';
        const catNo = item.productKey || item.catalogNumber || '';
        return stampResult({
          vendorId:      ID, vendorName: NAME, color: COLOR,
          catalogNumber: catNo,
          productName:   item.name || item.displayName || catNo,
          casNumber:     item.casNumber || '',
          price:         parsePrice(item.price?.value ?? item.listPrice),
          currency:      item.price?.currency || 'USD',
          pricePer:      item.packSize || '',
          availability:  normalizeAvailability(item.availability),
          shippingTime:  null,
          productUrl:    catNo ? `${BASE}/US/en/product/${brand.toLowerCase()}/${catNo}` : '',
        }, 'listing');
      }).filter(r => r.productUrl);

      const relevant = results.filter(r =>
        isRelevantResult(query, r.productName, r.casNumber, r.catalogNumber)
      );
      if (relevant.length > 0) {
        return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'success', results: relevant };
      }
    }
  }

  // JSON-LD on search results page
  const ldProducts = extractJsonLd(html);
  if (ldProducts.length > 0) {
    const results = ldProducts.slice(0, 5).map(p => {
      const offers = Array.isArray(p.offers) ? p.offers : [p.offers].filter(Boolean);
      const offer = offers[0];
      const catNo = (p.url?.match(CAT_RE) || [])[1] || p.sku || p.productID || '';
      return stampResult({
        vendorId:      ID, vendorName: NAME, color: COLOR,
        catalogNumber: catNo,
        productName:   p.name || '',
        casNumber:     p.casNumber || p.cas || '',
        price:         parsePrice(offer?.price),
        currency:      offer?.priceCurrency || 'USD',
        pricePer:      offer?.description || offer?.name || '',
        availability:  normalizeAvailability(offer?.availability?.replace('https://schema.org/', '')),
        shippingTime:  buildShippingText(offer || {}),
        productUrl:    p.url || '',
      }, 'listing');
    }).filter(r => r.productUrl.startsWith('http'));

    const relevant = results.filter(r =>
      isRelevantResult(query, r.productName, r.casNumber, r.catalogNumber)
    );
    if (relevant.length > 0) {
      return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'success', results: relevant };
    }
  }

  // Regex fallback: extract product links from the HTML
  const linkRe = /href="(\/US\/en\/product\/[^"]+)"[^>]*>\s*([^<]{3,100})/gi;
  const seen = new Set();
  const results = [];
  let m;
  while ((m = linkRe.exec(html)) !== null && results.length < 5) {
    const href = m[1];
    const name = m[2].trim();
    const fullUrl = `${BASE}${href}`;
    const catMatch = fullUrl.match(CAT_RE);
    if (!catMatch || seen.has(fullUrl)) continue;
    seen.add(fullUrl);
    results.push(stampResult({
      vendorId: ID, vendorName: NAME, color: COLOR,
      catalogNumber: catMatch[1],
      productName: name,
      casNumber: '',
      price: null, currency: 'USD', pricePer: '',
      availability: null, shippingTime: null,
      productUrl: fullUrl,
    }, 'link'));
  }

  if (results.length > 0) {
    return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'success', results };
  }

  return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'no_results', results: [] };
}

module.exports = { id: ID, name: NAME, color: COLOR, search };
