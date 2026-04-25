'use strict';

const {
  HTML_HEADERS, apiHeaders, isBlocked, normalizeAvailability,
  buildShippingText, parsePrice, fetchJson, fetchHtml, buildUrl,
  extractJsonLd, extractNextData, isRelevantResult, stampResult,
  extractPriceFromHtml, extractShippingFromHtml,
} = require('./_utils');

const ID    = 'thermofisher';
const NAME  = 'Thermo Fisher';
const COLOR = '#ff6200';
const BASE  = 'https://www.thermofisher.com';
const HDRS  = apiHeaders(`${BASE}/`);

async function search(query) {
  // NOTE: previously attempted /api/search/query and /search/searchWebservice.json
  // before HTML scraping. Both are undocumented and were adding latency without
  // ever returning results in practice. Go straight to HTML + enrichment.
  let results = [];

  try {
    const r = await searchViaHtml(query);
    if (r.status === 'success') results = r.results;
  } catch (err) {
    if (isBlocked(err)) return blocked(err.message);
    return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'error', results: [], error: err.message };
  }

  if (!results.length) return noResults();

  // Filter out irrelevant results (template / featured product leakage)
  const relevant = results.filter(r =>
    isRelevantResult(query, r.productName, r.casNumber, r.catalogNumber)
  );
  if (!relevant.length) return noResults();

  // Enrich results missing prices OR shipping via product page (parallel, 6s cap)
  const needsEnrich = relevant.some(r =>
    r.price === null || r.price === undefined || !r.shippingTime
  );
  const enriched = needsEnrich
    ? await Promise.all(
        relevant.map(r =>
          Promise.race([
            enrichFromProductPage(r),
            new Promise(resolve => setTimeout(() => resolve(r), 6000)),
          ])
        )
      )
    : relevant;

  return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'success', results: enriched };
}

async function enrichFromProductPage(result) {
  const hasPrice = result.price !== null && result.price !== undefined;
  const hasShip  = !!result.shippingTime;
  if ((hasPrice && hasShip) || !result.productUrl) return result;
  try {
    const html = await fetchHtml(result.productUrl, { headers: HTML_HEADERS }, 5500);

    const products = extractJsonLd(html);
    if (products.length) {
      const p = products[0];
      const offers = Array.isArray(p.offers) ? p.offers : [p.offers].filter(Boolean);
      if (offers.length) {
        const offer = offers[0];
        return stampResult({
          ...result,
          productName:  p.name || result.productName,
          price:        parsePrice(offer.price),
          currency:     offer.priceCurrency || 'USD',
          pricePer:     offer.description || offer.eligibleQuantity?.value || '',
          availability: normalizeAvailability(offer.availability?.replace('https://schema.org/', '')),
          shippingTime: buildShippingText(offer) || extractShippingFromHtml(html) || result.shippingTime,
        }, 'live');
      }
    }

    const nextData = extractNextData(html);
    if (nextData) {
      const prod = nextData?.props?.pageProps?.product ?? nextData?.props?.pageProps;
      if (prod?.price) {
        return stampResult({
          ...result,
          productName:  prod.name || prod.displayName || result.productName,
          price:        parsePrice(prod.price?.value ?? prod.listPrice ?? prod.price),
          currency:     prod.price?.currency || 'USD',
          pricePer:     prod.packSize || prod.unitSize || '',
          availability: normalizeAvailability(prod.availability || prod.stockStatus),
          shippingTime: buildShippingText(prod) || extractShippingFromHtml(html) || result.shippingTime,
        }, 'live');
      }
    }

    // Last-resort: raw HTML regex for price + shipping
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
  } catch (_) { /* keep original */ }
  return result;
}

async function searchViaHtml(query) {
  // Thermo's search endpoint has moved around; try a few known URLs in order.
  const encoded = encodeURIComponent(query);
  const candidates = [
    `${BASE}/search/results?query=${encoded}`,
    `${BASE}/us/en/home.html?searchType=site&search=${encoded}`,
    `${BASE}/order/catalog/en/US/adirect/lt?cmd=IVBrowseSearch&searchTerm=${encoded}`,
  ];

  let html = '';
  let fetchedUrl = '';
  let lastErr = null;
  for (const u of candidates) {
    try {
      html = await fetchHtml(u, { headers: HTML_HEADERS });
      fetchedUrl = u;
      if (html && html.length > 1000) break;
    } catch (err) {
      lastErr = err;
      if (isBlocked(err)) throw err;
    }
  }
  if (!html) {
    if (lastErr) throw lastErr;
    return noResults();
  }

  if (process.env.DEBUG_THERMO === '1') {
    console.log(`[thermo] fetched ${fetchedUrl} (${html.length} bytes)`);
    console.log(`[thermo] first 500 chars: ${html.slice(0, 500).replace(/\s+/g, ' ')}`);
  }

  try {

    const nextData = extractNextData(html);
    if (nextData) {
      const items =
        nextData?.props?.pageProps?.searchResults?.products ??
        nextData?.props?.pageProps?.results ??
        nextData?.props?.pageProps?.items ?? [];
      if (Array.isArray(items) && items.length) {
        const results = items.slice(0, 5).map(item => {
          const catNo = item.catalogNumber || item.sku || item.productNumber || '';
          const pUrl = item.url
            ? (item.url.startsWith('http') ? item.url : `${BASE}${item.url}`)
            : `${BASE}/order/catalog/product/${catNo}`;
          return stampResult({
            vendorId: ID, vendorName: NAME, color: COLOR,
            catalogNumber: catNo, productName: item.name || item.title || '',
            casNumber: item.casNumber || item.cas || '',
            price: parsePrice(item.price ?? item.listPrice), currency: item.currency || 'USD',
            pricePer: item.packSize || item.size || '',
            availability: normalizeAvailability(item.availability || item.availabilityStatus),
            shippingTime: buildShippingText(item), productUrl: pUrl,
          }, 'listing');
        }).filter(r => r.productUrl.startsWith('http'));
        if (results.length) return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'success', results };
      }
    }

    const jsonLdProducts = extractJsonLd(html);
    if (jsonLdProducts.length) {
      const results = jsonLdProducts.slice(0, 5).flatMap(p => {
        const offers = Array.isArray(p.offers) ? p.offers : [p.offers].filter(Boolean);
        const catNo = p.sku || p.productID || '';
        const pUrl = p.url || (catNo ? `${BASE}/order/catalog/product/${catNo}` : '');
        return offers.map(offer => stampResult({
          vendorId: ID, vendorName: NAME, color: COLOR,
          catalogNumber: catNo, productName: p.name || '', casNumber: '',
          price: parsePrice(offer.price), currency: offer.priceCurrency || 'USD', pricePer: '',
          availability: normalizeAvailability(offer.availability?.replace('https://schema.org/', '')),
          shippingTime: null, productUrl: pUrl,
        }, 'listing'));
      }).filter(r => r.productUrl.startsWith('http'));
      if (results.length) return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'success', results };
    }

    // Regex — multiple Thermo product URL shapes observed over the years
    const linkPatterns = [
      /href=["']((?:https:\/\/www\.thermofisher\.com)?\/order\/catalog\/product\/([A-Z0-9-]{4,20}))["']/gi,
      /href=["']((?:https:\/\/www\.thermofisher\.com)?\/(?:us|en-us)\/[^"'\s]+?\/product\/([A-Z0-9-]{4,20})(?:\.html)?)["']/gi,
      /href=["']((?:https:\/\/www\.thermofisher\.com)?\/p\/([A-Z0-9-]{4,20}))["']/gi,
      // Sometimes Thermo's SPA injects product data URLs in JSON blobs:
      /"(?:productUrl|url|href)"\s*:\s*"((?:https:\/\/www\.thermofisher\.com)?\/order\/catalog\/product\/([A-Z0-9-]{4,20}))"/gi,
    ];
    const seen = new Set();
    const results = [];
    for (const re of linkPatterns) {
      let match;
      while ((match = re.exec(html)) !== null && results.length < 5) {
        const href = match[1], catNo = match[2];
        if (seen.has(catNo)) continue;
        seen.add(catNo);
        results.push(stampResult({
          vendorId: ID, vendorName: NAME, color: COLOR,
          catalogNumber: catNo, productName: catNo, casNumber: '',
          price: null, currency: 'USD', pricePer: '',
          availability: null, shippingTime: null,
          productUrl: href.startsWith('http') ? href : `${BASE}${href.startsWith('/') ? href : '/' + href}`,
        }, 'link'));
      }
      if (results.length) break;
    }
    if (process.env.DEBUG_THERMO === '1') {
      console.log(`[thermo] regex link scan: ${results.length} matches`);
    }
    if (results.length) return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'success', results };
  } catch (err) {
    if (isBlocked(err)) throw err;
  }

  return noResults();
}

function noResults() { return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'no_results', results: [] }; }
function blocked(msg) { return { vendorId: ID, vendorName: NAME, color: COLOR, status: 'blocked', results: [], error: msg }; }

module.exports = { id: ID, name: NAME, color: COLOR, search };
