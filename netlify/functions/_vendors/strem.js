'use strict';

const {
  HTML_HEADERS, isBlocked, normalizeAvailability,
  parsePrice, fetchHtml, extractJsonLd,
} = require('./_utils');

const ID    = 'strem';
const NAME  = 'Strem Chemicals';
const COLOR = '#6B3A7D';
const BASE  = 'https://www.strem.com';

async function search(query) {
  try {
    return await searchViaHtml(query);
  } catch (err) {
    return {
      vendorId: ID, vendorName: NAME, color: COLOR,
      status: isBlocked(err) ? 'blocked' : 'error',
      results: [], error: err.message,
    };
  }
}

async function searchViaHtml(query) {
  const url = `${BASE}/catalog/search/${encodeURIComponent(query)}`;
  const html = await fetchHtml(url, { headers: HTML_HEADERS });

  // Try JSON-LD first
  const jsonLdProducts = extractJsonLd(html);
  if (jsonLdProducts.length) {
    const results = jsonLdProducts.slice(0, 5).map(p => {
      const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers;
      return {
        vendorId:      ID, vendorName: NAME, color: COLOR,
        catalogNumber: p.sku || p.productID || '',
        productName:   p.name || '',
        casNumber:     '',
        price:         parsePrice(offer?.price),
        currency:      offer?.priceCurrency || 'USD',
        pricePer:      '',
        availability:  normalizeAvailability(offer?.availability?.replace('https://schema.org/', '')),
        shippingTime:  null,
        productUrl:    p.url || '',
      };
    }).filter(r => r.productUrl.startsWith('http'));
    if (results.length) return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'success', results };
  }

  // Regex fallback — extract product links from Strem's HTML
  const linkPattern = /href=["'](\/catalog\/(?!search)[^"']+)["'][^>]*>([^<]{3,80})</gi;
  const seen = new Set();
  const results = [];
  let match;
  while ((match = linkPattern.exec(html)) !== null && results.length < 5) {
    const href = match[1];
    const name = match[2].trim();
    const fullUrl = `${BASE}${href}`;
    if (seen.has(fullUrl) || !name) continue;
    seen.add(fullUrl);
    results.push({
      vendorId:      ID, vendorName: NAME, color: COLOR,
      catalogNumber: href.match(/\/([0-9-]+)\/?$/)?.[1] || '',
      productName:   name,
      casNumber:     '',
      price:         null, currency: 'USD', pricePer: '',
      availability:  null, shippingTime: null,
      productUrl:    fullUrl,
    });
  }

  return results.length
    ? { vendorId: ID, vendorName: NAME, color: COLOR, status: 'success', results }
    : { vendorId: ID, vendorName: NAME, color: COLOR, status: 'no_results', results: [] };
}

module.exports = { id: ID, name: NAME, color: COLOR, search };
