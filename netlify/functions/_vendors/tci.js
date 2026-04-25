'use strict';

const {
  HTML_HEADERS, apiHeaders, isBlocked, normalizeAvailability,
  buildShippingText, parsePrice, fetchJson, fetchHtml, buildUrl,
  extractJsonLd, extractNextData, isRelevantResult,
} = require('./_utils');

const ID    = 'tci';
const NAME  = 'TCI America';
const COLOR = '#002b7a';
const BASE  = 'https://www.tcichemicals.com';
const HDRS  = apiHeaders(`${BASE}/US/en/`);

// SAP Commerce OCC site-ID variants to try for TCI
const OCC_SITE_IDS = ['tci-us', 'tci_us', 'tcius', 'TCI_US', 'tci'];

async function search(query) {
  // ── Primary: SAP Commerce OCC search endpoint ────────────────────────────
  // This returns real product name + price + stock in a single call.
  // Standard Hybris format: /occ/v2/{siteId}/products/search?query=...
  for (const siteId of OCC_SITE_IDS) {
    try {
      const url = buildUrl(`${BASE}/occ/v2/${siteId}/products/search`, {
        query, fields: 'FULL', pageSize: 5, lang: 'en', curr: 'USD',
      });
      const data = await fetchJson(url, { headers: HDRS }, 6000);
      const items = data?.products ?? [];
      if (!Array.isArray(items) || !items.length) continue;

      const results = items.map(p => ({
        vendorId:      ID, vendorName: NAME, color: COLOR,
        catalogNumber: p.code || p.sku || '',
        productName:   p.name || p.summary || '',
        casNumber:     p.casNumber || p.cas || '',
        price:         parsePrice(p.price?.value),
        currency:      p.price?.currencyIso || 'USD',
        pricePer:      p.packagingDescription || '',
        availability:  normalizeAvailability(p.stock?.stockLevelStatus ?? p.stock?.stockLevel),
        shippingTime:  p.deliveryTime || buildShippingText(p) || null,
        productUrl:    p.code ? `${BASE}/US/en/p/${p.code}` : '',
      })).filter(r => r.productUrl.startsWith('http') && r.catalogNumber);

      if (!results.length) continue;

      // Relevance filter — OCC results should already be right, but be safe
      const relevant = results.filter(r =>
        isRelevantResult(query, r.productName, r.casNumber, r.catalogNumber)
      );

      if (relevant.length) {
        return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'success', results: relevant };
      }
    } catch (err) {
      if (isBlocked(err)) return blocked(err.message);
      // try next siteId
    }
  }

  // ── Fallback: old internal search API ───────────────────────────────────
  try {
    const r = await searchViaApi(query);
    if (r.status === 'success') {
      const relevant = r.results.filter(r =>
        isRelevantResult(query, r.productName, r.casNumber, r.catalogNumber)
      );
      if (relevant.length) return { ...r, results: relevant };
    }
  } catch (err) {
    if (isBlocked(err)) return blocked(err.message);
  }

  // ── Fallback: HTML scraping (least reliable — SPA shell only) ────────────
  // Note: TCI is a JS SPA so HTML scraping rarely returns real search results.
  // We still try it but rely on OCC product enrichment to validate catalog numbers.
  try {
    const r = await searchViaHtml(query);
    if (r.status === 'success') {
      // Enrich each scraped catalog number via OCC product lookup
      const enriched = await Promise.all(
        r.results.map(item =>
          Promise.race([
            enrichWithOccProduct(item),
            new Promise(resolve => setTimeout(() => resolve(item), 5000)),
          ])
        )
      );
      // Filter: only keep results where OCC confirmed a real product name matching query
      const relevant = enriched.filter(item =>
        item._occConfirmed &&
        isRelevantResult(query, item.productName, item.casNumber, item.catalogNumber)
      );
      if (relevant.length) {
        return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'success', results: relevant };
      }
    }
  } catch (err) {
    if (isBlocked(err)) return blocked(err.message);
  }

  return noResults();
}

/** Fetch a single TCI product from OCC, set _occConfirmed = true on success. */
async function enrichWithOccProduct(result) {
  if (!result.catalogNumber) return result;
  for (const siteId of OCC_SITE_IDS) {
    try {
      const url = buildUrl(`${BASE}/occ/v2/${siteId}/products/${result.catalogNumber}`, {
        fields: 'FULL', lang: 'en', curr: 'USD',
      });
      const data = await fetchJson(url, { headers: HDRS }, 4000);
      if (!data || !data.code) continue;
      return {
        ...result,
        _occConfirmed: true,
        productName:  data.name || data.summary || result.productName,
        casNumber:    data.casNumber || data.cas || result.casNumber || '',
        price:        parsePrice(data.price?.value),
        currency:     data.price?.currencyIso || 'USD',
        pricePer:     data.packagingDescription || '',
        availability: normalizeAvailability(data.stock?.stockLevelStatus ?? data.stock?.stockLevel),
        shippingTime: data.deliveryTime || buildShippingText(data) || result.shippingTime,
      };
    } catch (_) { /* try next siteId */ }
  }
  return result; // OCC failed, _occConfirmed stays falsy
}

async function searchViaApi(query) {
  const url = buildUrl(`${BASE}/api/search`, {
    q: query, region: 'US', lang: 'en', rows: 5, start: 0,
  });
  const data = await fetchJson(url, { headers: HDRS });
  const items = data?.products ?? data?.items ?? data?.response?.docs ?? data?.hits ?? [];
  if (!Array.isArray(items) || !items.length) return noResults();

  const results = items.slice(0, 5).map(item => {
    const catNo = item.productCode || item.catalogNumber || item.sku || item.id || '';
    return {
      vendorId: ID, vendorName: NAME, color: COLOR,
      catalogNumber: catNo,
      productName:   item.productName || item.name || item.title || '',
      casNumber:     item.casNumber || item.cas || '',
      price:         parsePrice(item.price ?? item.unitPrice ?? item.priceValue),
      currency:      item.currency || 'USD',
      pricePer:      item.packSize || item.packagingDescription || '',
      availability:  normalizeAvailability(item.availability || item.stockStatus),
      shippingTime:  buildShippingText(item),
      productUrl:    catNo ? `${BASE}/US/en/p/${catNo}` : '',
    };
  }).filter(r => r.productUrl.startsWith('http'));

  return results.length
    ? { vendorId: ID, vendorName: NAME, color: COLOR, status: 'success', results }
    : noResults();
}

async function searchViaHtml(query) {
  const url = `${BASE}/US/en/search?q=${encodeURIComponent(query)}`;
  const html = await fetchHtml(url, { headers: HTML_HEADERS });

  const nextData = extractNextData(html);
  if (nextData) {
    const items =
      nextData?.props?.pageProps?.searchResults?.products ??
      nextData?.props?.pageProps?.products ??
      nextData?.props?.pageProps?.results ?? [];
    if (Array.isArray(items) && items.length) {
      const results = items.slice(0, 5).map(item => {
        const catNo = item.productCode || item.catalogNumber || item.sku || '';
        return {
          vendorId: ID, vendorName: NAME, color: COLOR,
          catalogNumber: catNo,
          productName: item.productName || item.name || '',
          casNumber: item.casNumber || item.cas || '',
          price: parsePrice(item.price ?? item.unitPrice),
          currency: item.currency || 'USD',
          pricePer: item.packSize || item.packagingDescription || '',
          availability: normalizeAvailability(item.availability || item.stockStatus),
          shippingTime: buildShippingText(item),
          productUrl: catNo ? `${BASE}/US/en/p/${catNo}` : '',
        };
      }).filter(r => r.productUrl.startsWith('http'));
      if (results.length) return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'success', results };
    }
  }

  const jsonLdProducts = extractJsonLd(html);
  if (jsonLdProducts.length) {
    const results = jsonLdProducts.slice(0, 5).map(p => {
      const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers;
      const catNo = p.sku || p.productID || '';
      return {
        vendorId: ID, vendorName: NAME, color: COLOR,
        catalogNumber: catNo, productName: p.name || '', casNumber: '',
        price: parsePrice(offer?.price), currency: offer?.priceCurrency || 'USD', pricePer: '',
        availability: normalizeAvailability(offer?.availability?.replace('https://schema.org/', '')),
        shippingTime: null,
        productUrl: p.url || (catNo ? `${BASE}/US/en/p/${catNo}` : ''),
      };
    }).filter(r => r.productUrl.startsWith('http'));
    if (results.length) return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'success', results };
  }

  // Regex — catalog numbers only; OCC product lookup validates and enriches them
  const hrefPattern = /href=["'](\/US\/en\/p\/([A-Z][0-9]+)[^"'?#]*)["']/gi;
  const seen = new Set();
  const results = [];
  let match;
  while ((match = hrefPattern.exec(html)) !== null && results.length < 8) {
    const href = match[1], catNo = match[2];
    if (seen.has(catNo)) continue;
    seen.add(catNo);
    results.push({
      vendorId: ID, vendorName: NAME, color: COLOR,
      catalogNumber: catNo, productName: catNo, casNumber: '',
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
