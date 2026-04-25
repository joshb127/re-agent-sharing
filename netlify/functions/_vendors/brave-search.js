'use strict';

/**
 * Brave Search API — premium search with site: filtering per vendor.
 * Requires BRAVE_API_KEY env var (2 000 free queries / month).
 *
 * For each vendor we:
 *  1. Query Brave Web Search API: `{query} site:{vendorDomain}`
 *  2. Filter URLs by vendor-specific catNoRe to get real product pages
 *  3. Fetch each product page and extract price from JSON-LD / __NEXT_DATA__
 */

const {
  HTML_HEADERS, isBlocked, normalizeAvailability,
  parsePrice, fetchHtml, fetchJson, extractJsonLd, extractNextData,
  isRelevantResult, buildShippingText, stampResult,
} = require('./_utils');

// ── Vendor configs ────────────────────────────────────────────────────────────
const VENDORS = [
  {
    id: 'sigma', name: 'Sigma-Aldrich', color: '#e31e24',
    searchDomain: 'sigmaaldrich.com',
    catNoRe:      /sigmaaldrich\.com\/US\/en\/product\/\w+\/([A-Z0-9_-]+)/i,
  },
  {
    id: 'thermofisher', name: 'Thermo Fisher', color: '#ff6200',
    searchDomain: 'thermofisher.com',
    catNoRe:      /thermofisher\.com\/order\/catalog\/product\/([A-Z0-9-]+)/i,
  },
  {
    id: 'vwr', name: 'VWR', color: '#0066cc',
    searchDomain: 'vwr.com',
    catNoRe:      /vwr\.com\/store\/product\/([^/?#\s]+)/i,
  },
  {
    id: 'cayman', name: 'Cayman Chemical', color: '#008B45',
    searchDomain: 'caymanchem.com',
    catNoRe:      /caymanchem\.com\/product\/(\d{4,7})/,
  },
  {
    id: 'tci', name: 'TCI America', color: '#002b7a',
    searchDomain: 'tcichemicals.com',
    catNoRe:      /tcichemicals\.com\/US\/en\/p\/([A-Z][0-9]+)/,
  },
  {
    id: 'strem', name: 'Strem Chemicals', color: '#6B3A7D',
    searchDomain: 'strem.com',
    catNoRe:      /strem\.com\/catalog\/(?:y\/)?([^/?#\s]+)/,
  },
];

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

// ── Main entry point ─────────────────────────────────────────────────────────
async function searchAllVendors(query, apiKey) {
  return Promise.all(VENDORS.map(v => searchOneVendor(query, v, apiKey)));
}

// ── Per-vendor Brave search ───────────────────────────────────────────────────
async function searchOneVendor(query, vendor, apiKey) {
  try {
    const productUrls = await braveSearch(query, vendor.searchDomain, vendor.catNoRe, apiKey, 3);
    if (!productUrls.length) return noResults(vendor);

    // Fetch each product page for price data (parallel, 6s cap)
    const results = (
      await Promise.all(
        productUrls.map(url =>
          Promise.race([
            fetchProductData(url, vendor),
            new Promise(resolve => setTimeout(() => resolve(null), 6000)),
          ])
        )
      )
    ).filter(Boolean);

    if (!results.length) return noResults(vendor);

    // Relevance filter
    const relevant = results.filter(r =>
      isRelevantResult(query, r.productName, r.casNumber, r.catalogNumber)
    );

    return relevant.length
      ? { vendorId: vendor.id, vendorName: vendor.name, color: vendor.color, status: 'success', results: relevant }
      : noResults(vendor);

  } catch (err) {
    return {
      vendorId: vendor.id, vendorName: vendor.name, color: vendor.color,
      status: isBlocked(err) ? 'blocked' : 'error',
      results: [], error: err.message,
    };
  }
}

// ── Brave Web Search API call ─────────────────────────────────────────────────
async function braveSearch(query, vendorDomain, catNoRe, apiKey, maxResults = 3) {
  const q = `${query} site:${vendorDomain}`;
  const url = `${BRAVE_SEARCH_URL}?q=${encodeURIComponent(q)}&count=10&search_lang=en&country=US`;

  const data = await fetchJson(url, {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
  }, 8000);

  const webResults = data?.web?.results || [];
  const urls = [];
  for (const r of webResults) {
    const href = r.url || '';
    if (catNoRe.test(href) && !urls.includes(href)) {
      urls.push(href);
      if (urls.length >= maxResults) break;
    }
  }
  return urls;
}

// ── Fetch one product page and extract price ──────────────────────────────────
async function fetchProductData(url, vendor) {
  try {
    const html = await fetchHtml(url, { headers: HTML_HEADERS }, 7000);
    const catNo = (url.match(vendor.catNoRe) || [])[1] || '';

    const base = {
      vendorId:      vendor.id,
      vendorName:    vendor.name,
      color:         vendor.color,
      catalogNumber: catNo,
      productName:   catNo,
      casNumber:     '',
      price:         null,
      currency:      'USD',
      pricePer:      '',
      availability:  null,
      shippingTime:  null,
      productUrl:    url,
    };

    // ── JSON-LD (schema.org/Product) — best source ──────────────────────
    const ldProducts = extractJsonLd(html);
    for (const p of ldProducts) {
      const offers = Array.isArray(p.offers) ? p.offers : [p.offers].filter(Boolean);
      if (!offers.length) {
        if (p.name) return stampResult({ ...base, productName: p.name }, 'link');
        continue;
      }
      return stampResult({
        ...base,
        productName:  p.name || base.productName,
        casNumber:    p.casNumber || p.cas || '',
        price:        parsePrice(offers[0].price),
        currency:     offers[0].priceCurrency || 'USD',
        pricePer:     offers[0].description || offers[0].name || '',
        availability: normalizeAvailability(offers[0].availability?.replace('https://schema.org/', '')),
        shippingTime: buildShippingText(offers[0]),
      }, 'live');
    }

    // ── __NEXT_DATA__ (Next.js SSR blob) ────────────────────────────────
    const next = extractNextData(html);
    if (next) {
      const prod =
        next?.props?.pageProps?.product ??
        next?.props?.pageProps?.productData ??
        next?.props?.pageProps?.item ?? null;
      if (prod) {
        return stampResult({
          ...base,
          productName:  prod.name || prod.displayName || base.productName,
          casNumber:    prod.casNumber || prod.cas || '',
          price:        parsePrice(prod.price?.value ?? prod.listPrice ?? prod.price),
          currency:     prod.price?.currencyIso || prod.price?.currency || 'USD',
          pricePer:     prod.packSize || prod.unitSize || prod.packagingDescription || '',
          availability: normalizeAvailability(
            prod.stock?.stockLevelStatus ?? prod.availability ?? prod.stockStatus
          ),
          shippingTime: buildShippingText(prod),
        }, 'live');
      }
    }

    // ── Title fallback ───────────────────────────────────────────────────
    const titleMatch = html.match(/<title[^>]*>([^<]{4,120})<\/title>/i);
    if (titleMatch) {
      const titleParts = titleMatch[1].split(/\s*\|\s*/);
      const productName = titleParts.slice(0, -1).join(' | ').trim() || titleMatch[1].trim();
      return stampResult({ ...base, productName }, 'link');
    }

    return stampResult(base, 'link');
  } catch (_) {
    return null;
  }
}

function noResults(vendor) {
  return {
    vendorId: vendor.id, vendorName: vendor.name, color: vendor.color,
    status: 'no_results', results: [],
  };
}

module.exports = { searchAllVendors, VENDORS };
