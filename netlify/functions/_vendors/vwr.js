'use strict';

const {
  HTML_HEADERS, apiHeaders, isBlocked, normalizeAvailability,
  buildShippingText, parsePrice, fetchJson, fetchHtml, buildUrl,
  extractJsonLd, extractNextData, isRelevantResult,
} = require('./_utils');

const ID    = 'vwr';
const NAME  = 'VWR';
const COLOR = '#0066cc';
const BASE  = 'https://us.vwr.com';
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

  const relevant = results.filter(r =>
    isRelevantResult(query, r.productName, r.casNumber, r.catalogNumber)
  );
  return relevant.length
    ? { vendorId: ID, vendorName: NAME, color: COLOR, status: 'success', results: relevant }
    : noResults();
}

async function searchViaApi(query) {
  const endpoints = [
    buildUrl(`${BASE}/store/content/external/catalog/productCatalogV2.jsp`, {
      query, country: 'US', catalogType: 'VWR', pageSize: 5,
    }),
    buildUrl(`${BASE}/store/content/external/catalog/productSearch.jsp`, {
      keyword: query, country: 'US', pageSize: 5,
    }),
  ];

  for (const url of endpoints) {
    try {
      const data = await fetchJson(url, { headers: HDRS });
      const items = data?.products ?? data?.items ?? data?.results ?? [];
      if (!Array.isArray(items) || !items.length) continue;

      const results = items.slice(0, 5).map(item => {
        const catNo = item.vwrCatalogNumber || item.catalogNumber || item.sku || '';
        const slug  = (item.productName || item.name || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        const pUrl  = item.productUrl
          ? (item.productUrl.startsWith('http') ? item.productUrl : `${BASE}${item.productUrl}`)
          : `${BASE}/store/product/${catNo}/${slug}`;
        return {
          vendorId:      ID, vendorName: NAME, color: COLOR,
          catalogNumber: catNo,
          productName:   item.productName || item.name || '',
          casNumber:     item.casNumber || item.cas || '',
          price:         parsePrice(item.price ?? item.priceValue ?? item.unitPrice),
          currency:      item.currency || 'USD',
          pricePer:      item.packSize || item.unitOfMeasure || '',
          availability:  normalizeAvailability(item.availability || item.inventoryStatus),
          shippingTime:  buildShippingText(item),
          productUrl:    pUrl,
        };
      }).filter(r => r.productUrl.startsWith('http'));

      if (results.length) return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'success', results };
    } catch (err) {
      if (isBlocked(err)) throw err;
    }
  }

  return noResults();
}

async function searchViaHtml(query) {
  const url = `${BASE}/store/search?keyword=${encodeURIComponent(query)}`;
  try {
    const html = await fetchHtml(url, { headers: HTML_HEADERS });

    const nextData = extractNextData(html);
    if (nextData) {
      const items =
        nextData?.props?.pageProps?.searchResults ??
        nextData?.props?.pageProps?.products ??
        nextData?.props?.pageProps?.results ?? [];
      if (Array.isArray(items) && items.length) {
        const results = items.slice(0, 5).map(item => {
          const catNo = item.vwrCatalogNumber || item.catalogNumber || item.sku || '';
          return {
            vendorId: ID, vendorName: NAME, color: COLOR,
            catalogNumber: catNo, productName: item.productName || item.name || '',
            casNumber: item.casNumber || item.cas || '',
            price: parsePrice(item.price ?? item.unitPrice), currency: item.currency || 'USD',
            pricePer: item.packSize || item.unitOfMeasure || '',
            availability: normalizeAvailability(item.availability || item.inventoryStatus),
            shippingTime: buildShippingText(item),
            productUrl: item.productUrl
              ? (item.productUrl.startsWith('http') ? item.productUrl : `${BASE}${item.productUrl}`)
              : (catNo ? `${BASE}/store/product/${catNo}` : ''),
          };
        }).filter(r => r.productUrl.startsWith('http'));
        if (results.length) return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'success', results };
      }
    }

    const jsonLdProducts = extractJsonLd(html);
    if (jsonLdProducts.length) {
      const results = jsonLdProducts.slice(0, 5).map(p => {
        const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers;
        return {
          vendorId: ID, vendorName: NAME, color: COLOR,
          catalogNumber: p.sku || p.productID || '', productName: p.name || '', casNumber: '',
          price: parsePrice(offer?.price), currency: offer?.priceCurrency || 'USD', pricePer: '',
          availability: normalizeAvailability(offer?.availability?.replace('https://schema.org/', '')),
          shippingTime: null, productUrl: p.url || '',
        };
      }).filter(r => r.productUrl.startsWith('http'));
      if (results.length) return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'success', results };
    }
  } catch (err) {
    if (isBlocked(err)) throw err;
  }

  return noResults();
}

function noResults() { return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'no_results', results: [] }; }
function blocked(msg) { return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'blocked', results: [], error: msg }; }

module.exports = { id: ID, name: NAME, color: COLOR, search };
