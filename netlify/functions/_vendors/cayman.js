'use strict';

const {
  HTML_HEADERS, apiHeaders, isBlocked, normalizeAvailability,
  buildShippingText, parsePrice, fetchJson, fetchHtml, buildUrl,
  extractJsonLd, extractNextData, isRelevantResult,
} = require('./_utils');

const ID    = 'cayman';
const NAME  = 'Cayman Chemical';
const COLOR = '#008B45';
const BASE  = 'https://www.caymanchem.com';
const HDRS  = apiHeaders(`${BASE}/`);

async function search(query) {
  let results = [];

  try {
    const r = await searchViaApi(query);
    if (r.status === 'success') results = r.results;
  } catch (err) {
    if (isBlocked(err)) return blocked(err.message);
  }

  if (!results.length) {
    try {
      const r = await searchViaHtml(query);
      if (r.status === 'success') results = r.results;
    } catch (err) {
      if (isBlocked(err)) return blocked(err.message);
      return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'error', results: [], error: err.message };
    }
  }

  if (!results.length) return noResults();

  // Filter irrelevant results
  results = results.filter(r =>
    isRelevantResult(query, r.productName, r.casNumber, r.catalogNumber)
  );
  if (!results.length) return noResults();

  // Enrich with product-page prices (parallel, 5s cap)
  const enriched = await Promise.all(
    results.map(r =>
      Promise.race([
        enrichFromProductPage(r),
        new Promise(resolve => setTimeout(() => resolve(r), 5000)),
      ])
    )
  );

  return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'success', results: enriched };
}

/** Fetch individual Cayman product page and extract price from JSON-LD. */
async function enrichFromProductPage(result) {
  // Skip if we already have a price
  if (result.price !== null && result.price !== undefined) return result;
  if (!result.productUrl) return result;
  try {
    const html = await fetchHtml(result.productUrl, { headers: HTML_HEADERS }, 5000);

    // JSON-LD Product schema (Cayman uses this)
    const products = extractJsonLd(html);
    if (products.length) {
      const p = products[0];
      const offers = Array.isArray(p.offers) ? p.offers : [p.offers].filter(Boolean);
      // Cayman products have multiple package sizes as multiple offers
      if (offers.length) {
        // Return first offer's pricing; we could return multiple but keep simple
        const offer = offers[0];
        return {
          ...result,
          productName:  p.name || result.productName,
          casNumber:    result.casNumber,
          price:        parsePrice(offer.price),
          currency:     offer.priceCurrency || 'USD',
          pricePer:     offer.description || offer.name || '',
          availability: normalizeAvailability(offer.availability?.replace('https://schema.org/', '')),
        };
      }
    }

    // Regex fallback for price patterns in HTML: $45.00 or 45.00 USD
    const priceMatch = html.match(/["']price["']\s*:\s*["']?([\d,.]+)["']?/);
    if (priceMatch) {
      return { ...result, price: parsePrice(priceMatch[1]) };
    }
  } catch (_) { /* keep original */ }
  return result;
}

async function searchViaApi(query) {
  const url = buildUrl(`${BASE}/api/catalog/products`, { keyword: query, count: 5 });
  const data = await fetchJson(url, { headers: HDRS });
  const items = data?.products ?? data?.items ?? data?.data ?? [];
  if (!Array.isArray(items) || !items.length) return noResults();

  const results = items.slice(0, 5).map(item => {
    const itemNo = String(item.itemNumber || item.catalogNumber || item.id || '');
    const inStock = item.inStock;
    return {
      vendorId:      ID, vendorName: NAME, color: COLOR,
      catalogNumber: itemNo,
      productName:   item.productName || item.name || item.title || '',
      casNumber:     item.casNumber || item.cas || '',
      price:         parsePrice(item.price ?? item.unitPrice),
      currency:      'USD',
      pricePer:      item.packSize || item.quantity || item.size || '',
      availability:  normalizeAvailability(
        item.availability ?? (inStock === true ? 'In Stock' : inStock === false ? 'Out of Stock' : null)
      ),
      shippingTime:  buildShippingText(item),
      productUrl:    itemNo ? `${BASE}/product/${itemNo}` : '',
    };
  }).filter(r => r.productUrl.startsWith('http'));

  return results.length
    ? { vendorId: ID, vendorName: NAME, color: COLOR, status: 'success', results }
    : noResults();
}

async function searchViaHtml(query) {
  const url = `${BASE}/search?q=${encodeURIComponent(query)}`;
  const html = await fetchHtml(url, { headers: HTML_HEADERS });

  // __NEXT_DATA__
  const nextData = extractNextData(html);
  if (nextData) {
    const items =
      nextData?.props?.pageProps?.products ??
      nextData?.props?.pageProps?.results ??
      nextData?.props?.pageProps?.searchResults ?? [];
    if (Array.isArray(items) && items.length) {
      const results = items.slice(0, 5).map(item => {
        const itemNo = String(item.itemNumber || item.catalogNumber || item.id || '');
        return {
          vendorId: ID, vendorName: NAME, color: COLOR,
          catalogNumber: itemNo,
          productName: item.productName || item.name || '',
          casNumber: item.casNumber || item.cas || '',
          price: parsePrice(item.price ?? item.unitPrice),
          currency: 'USD',
          pricePer: item.packSize || item.quantity || '',
          availability: normalizeAvailability(item.availability ?? (item.inStock ? 'In Stock' : null)),
          shippingTime: buildShippingText(item),
          productUrl: itemNo ? `${BASE}/product/${itemNo}` : '',
        };
      }).filter(r => r.productUrl.startsWith('http'));
      if (results.length) return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'success', results };
    }
  }

  // JSON-LD
  const jsonLdProducts = extractJsonLd(html);
  if (jsonLdProducts.length) {
    const results = jsonLdProducts.slice(0, 5).map(p => {
      const offer  = Array.isArray(p.offers) ? p.offers[0] : p.offers;
      const itemNo = p.sku || p.productID || '';
      return {
        vendorId: ID, vendorName: NAME, color: COLOR,
        catalogNumber: itemNo, productName: p.name || '', casNumber: '',
        price: parsePrice(offer?.price), currency: offer?.priceCurrency || 'USD', pricePer: '',
        availability: normalizeAvailability(offer?.availability?.replace('https://schema.org/', '')),
        shippingTime: null,
        productUrl: p.url || (itemNo ? `${BASE}/product/${itemNo}` : ''),
      };
    }).filter(r => r.productUrl.startsWith('http'));
    if (results.length) return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'success', results };
  }

  // Regex fallback — Cayman product URLs: /product/12345
  const linkPattern = /href=["'](\/product\/(\d{4,6})[^"']*)["'][^>]*>([^<]{3,100})</gi;
  const seen = new Set();
  const results = [];
  let match;
  while ((match = linkPattern.exec(html)) !== null && results.length < 5) {
    const href = match[1], itemNo = match[2], name = match[3].trim();
    if (seen.has(itemNo) || !name || name.toLowerCase().includes('view')) continue;
    seen.add(itemNo);
    results.push({
      vendorId: ID, vendorName: NAME, color: COLOR,
      catalogNumber: itemNo, productName: name, casNumber: '',
      price: null, currency: 'USD', pricePer: '',
      availability: null, shippingTime: null,
      productUrl: `${BASE}${href}`,
    });
  }

  return results.length
    ? { vendorId: ID, vendorName: NAME, color: COLOR, status: 'success', results }
    : noResults();
}

function noResults() { return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'no_results', results: [] }; }
function blocked(msg) { return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'blocked', results: [], error: msg }; }

module.exports = { id: ID, name: NAME, color: COLOR, search };
