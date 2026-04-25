'use strict';

/**
 * DuckDuckGo HTML Search — free, no API key required.
 *
 * Queries DuckDuckGo's HTML interface with site: filters per vendor,
 * extracts real product URLs from the result links, then fetches each
 * product page to pull price + availability from JSON-LD schema data.
 *
 * Limitations vs. Brave API:
 *  - DDG may rate-limit aggressive usage
 *  - Result quality depends on DDG's index freshness
 *  - No guaranteed count per vendor
 */

const {
  HTML_HEADERS, isBlocked, normalizeAvailability,
  parsePrice, fetchHtml, extractJsonLd, extractNextData,
  isRelevantResult, buildShippingText, stampResult,
} = require('./_utils');

// ── Vendor configs ────────────────────────────────────────────────────────────
// searchDomain: used in DDG site: filter (domain-only — path-specific returns 0 results)
// catNoRe: used to validate product URLs extracted from DDG results
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

// DDG headers — mimic a real Chrome browser as closely as possible
const DDG_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://duckduckgo.com/',
  'DNT': '1',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-User': '?1',
  'Cache-Control': 'max-age=0',
};

// ── Main entry point ─────────────────────────────────────────────────────────
// Stagger DDG requests slightly to avoid triggering rate limits.
// 150ms between each vendor = ~900ms total for 6 vendors (+ their fetch time).
async function searchAllVendors(query) {
  const results = [];
  await Promise.all(
    VENDORS.map((v, i) =>
      new Promise(resolve => setTimeout(resolve, i * 150))
        .then(() => searchOneVendor(query, v))
        .then(r => { results[i] = r; })
    )
  );
  return results;
}

// ── Per-vendor DDG search ────────────────────────────────────────────────────
async function searchOneVendor(query, vendor) {
  try {
    const productUrls = await ddgSearch(query, vendor.searchDomain, vendor.catNoRe, 3);
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

// ── DuckDuckGo HTML scraper ──────────────────────────────────────────────────
async function ddgSearch(query, vendorDomain, catNoRe, maxResults = 3) {
  const q = `${query} site:${vendorDomain}`;
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=us-en`;

  const html = await fetchHtml(url, { headers: DDG_HEADERS }, 9000);

  // DDG wraps result URLs in a redirect: href="//duckduckgo.com/l/?uddg={encoded_url}"
  // Extract and decode those URLs
  const urls = [];
  const uddgRe = /href="\/\/duckduckgo\.com\/l\/\?uddg=([^"&]+)/gi;
  let m;
  while ((m = uddgRe.exec(html)) !== null) {
    try {
      const decoded = decodeURIComponent(m[1]);
      if (decoded.startsWith('http') && catNoRe.test(decoded) && !urls.includes(decoded)) {
        urls.push(decoded);
        if (urls.length >= maxResults) break;
      }
    } catch (_) { /* malformed URL encoding */ }
  }

  // Fallback: look for direct hrefs to the vendor domain
  if (!urls.length) {
    const directRe = /href="(https?:\/\/[^"]*)/gi;
    while ((m = directRe.exec(html)) !== null) {
      const href = m[1];
      if (catNoRe.test(href) && !urls.includes(href)) {
        urls.push(href);
        if (urls.length >= maxResults) break;
      }
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
      productName:   catNo,   // will be replaced below
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
      // Some vendors (Sigma) list multiple pack sizes as multiple offers
      // Return one result per offer, up to 2
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

    // ── Regex fallbacks for price in page HTML ───────────────────────────
    // title tag often has product name
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
  return { vendorId: vendor.id, vendorName: vendor.name, color: vendor.color, status: 'no_results', results: [] };
}

module.exports = { searchAllVendors, VENDORS };
