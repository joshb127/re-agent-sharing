'use strict';

// ============================================================
//  Shared utilities — zero external dependencies
//  Uses Node 18+ built-in fetch + regex for HTML parsing
// ============================================================

const HTML_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'DNT': '1',
  'Connection': 'keep-alive',
};

function apiHeaders(referer) {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': referer,
    'Origin': new URL(referer).origin,
  };
}

/** Fetch JSON with timeout. Throws an error with .status if non-2xx. */
async function fetchJson(url, options = {}, timeoutMs = 7000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

/** Fetch HTML text with timeout. */
async function fetchHtml(url, options = {}, timeoutMs = 7000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.text();
  } finally {
    clearTimeout(id);
  }
}

/** Returns true if the error looks like a bot-block (403/429/503). */
function isBlocked(err) {
  const s = err.status || (err.response && err.response.status);
  return s === 403 || s === 429 || s === 503;
}

/** Normalise arbitrary availability text to a consistent string. */
function normalizeAvailability(raw) {
  if (!raw) return null;
  const r = String(raw).toLowerCase().trim();
  if (r.includes('in stock') || r === 'available' || r === 'yes' || r === 'stocked') return 'In Stock';
  if (r.includes('limited') || r.includes('low stock')) return 'Limited Stock';
  if (r.includes('out of stock') || r === 'unavailable' || r === 'no') return 'Out of Stock';
  if (r.includes('backorder')) return 'Backordered';
  if (r.includes('discontinued') || r.includes('obsolete')) return 'Discontinued';
  if (r.includes('call') || r.includes('contact')) return 'Contact Vendor';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * Extract Next.js SSR data embedded as __NEXT_DATA__ in HTML.
 * Many vendor sites (Sigma, Thermo, etc.) use Next.js and embed
 * the full page data in this script tag.
 */
function extractNextData(html) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch (_) { return null; }
}

/**
 * Extract schema.org Product JSON-LD from HTML using regex.
 * No cheerio or HTML parser needed.
 */
function extractJsonLd(html) {
  const results = [];
  const pattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1].trim());
      const items = Array.isArray(data) ? data : [data];
      items.forEach(item => {
        if (item['@type'] === 'Product') results.push(item);
        if (item['@graph']) {
          item['@graph']
            .filter(n => n['@type'] === 'Product')
            .forEach(n => results.push(n));
        }
      });
    } catch (_) { /* skip malformed JSON-LD */ }
  }
  return results;
}

/** Build shipping time string from various field names vendors use. */
function buildShippingText(obj) {
  const candidates = [
    obj.shippingTime, obj.shipping_time, obj.deliveryTime, obj.delivery_time,
    obj.leadTime, obj.lead_time, obj.estimatedDelivery,
    obj.availabilityMessage, obj.availability_message, obj.dispatchMessage,
  ];
  for (const c of candidates) {
    if (c && typeof c === 'string' && c.trim()) return c.trim();
  }
  const days =
    obj.shippingDays ?? obj.shipping_days ?? obj.daysToShip ??
    obj.leadTimeDays ?? obj.lead_time_days;
  if (days !== undefined && days !== null) {
    const n = Number(days);
    if (n === 0) return 'Ships today';
    if (n === 1) return 'Ships next business day';
    return `Ships in ${n} business day${n !== 1 ? 's' : ''}`;
  }
  if (obj.estimatedShippingDate || obj.ship_date) {
    const d = new Date(obj.estimatedShippingDate || obj.ship_date);
    if (!isNaN(d)) {
      return `Ships by ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    }
  }
  return null;
}

/** Parse a price value to float or null. */
function parsePrice(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return isNaN(raw) ? null : raw;
  const n = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

/**
 * Last-resort price extractor: scans raw HTML for $-denominated prices that
 * sit inside common price-container markers. Used when JSON-LD and
 * __NEXT_DATA__ both fail to expose a price (Sigma/Thermo sometimes render
 * prices client-side but still emit microdata-ish HTML).
 *
 * Returns { price, currency, pricePer } or null.
 */
function extractPriceFromHtml(html) {
  if (!html) return null;

  // Microdata / itemprop price — very reliable when present
  const microdata = html.match(
    /itemprop=["']price["'][^>]*content=["']([\d.,]+)["']/i
  );
  if (microdata) {
    const price = parsePrice(microdata[1]);
    if (price != null) {
      const curMatch = html.match(
        /itemprop=["']priceCurrency["'][^>]*content=["']([A-Z]{3})["']/
      );
      return { price, currency: curMatch ? curMatch[1] : 'USD', pricePer: '' };
    }
  }

  // data-price / data-list-price attributes
  const dataPrice = html.match(
    /data-(?:list-)?price(?:-value)?=["']\s*\$?\s*([\d,]+\.\d{2})\s*["']/i
  );
  if (dataPrice) {
    return { price: parsePrice(dataPrice[1]), currency: 'USD', pricePer: '' };
  }

  // Price containers with dollar amounts — look for class="price..." then $XX.XX nearby
  const classPrice = html.match(
    /class=["'][^"']*\bprice(?:-value|-amount|-current|-display)?\b[^"']*["'][^>]*>\s*\$?\s*([\d,]+\.\d{2})/i
  );
  if (classPrice) {
    return { price: parsePrice(classPrice[1]), currency: 'USD', pricePer: '' };
  }

  // Fallback: any dollar-prefixed price that looks reasonable ($1.00 - $99,999.99)
  // Only use if the page appears to be a product page (has "add to cart" or similar)
  if (/(add to cart|buy now|add to basket|add to quote)/i.test(html)) {
    const anyPrice = html.match(/\$\s*([\d,]{1,7}\.\d{2})\b/);
    if (anyPrice) return { price: parsePrice(anyPrice[1]), currency: 'USD', pricePer: '' };
  }

  return null;
}

/**
 * Last-resort shipping extractor: scans raw HTML for common shipping phrases.
 * Returns a human-readable shipping string or null.
 */
function extractShippingFromHtml(html) {
  if (!html) return null;
  const patterns = [
    // "Ships in 2 business days"
    /ships?\s+(?:in|within)\s+(\d+[\u2013\-]?\d*\s+business\s+days?)/i,
    // "Estimated to ship in 2-3 business days"
    /estimated\s+to\s+ship\s+(?:in\s+)?(\d+[\u2013\-]?\d*\s+business\s+days?)/i,
    // "Available for immediate shipment"
    /(available\s+for\s+immediate\s+shipment)/i,
    // "Ships today"
    /\b(ships?\s+today)\b/i,
    // "Ships next business day"
    /\b(ships?\s+next\s+business\s+day)\b/i,
    // "Usually ships within X days"
    /usually\s+ships?\s+within\s+(\d+\s+(?:business\s+)?days?)/i,
    // "In stock, ships X"
    /in\s+stock[^<>]{0,30}ships?\s+([^<>.]{3,40})/i,
    // "Estimated delivery: ..."
    /estimated\s+delivery[:\s]+([^<>\n.]{3,50})/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      let txt = m[1].trim().replace(/\s+/g, ' ');
      // Capitalize first letter
      txt = txt.charAt(0).toUpperCase() + txt.slice(1);
      // If phrase doesn't start with "Ships" or "Available", prepend "Ships in"
      if (!/^(ships?|available|estimated|in\s+stock)/i.test(txt)) {
        txt = `Ships in ${txt}`;
      }
      return txt;
    }
  }
  return null;
}

/**
 * Returns true if a product result is plausibly relevant to the search query.
 * Filters out template/featured products that leak into SPA page scrapes.
 *
 * Strategy:
 *   - CAS-shaped query → require CAS or catalog exact match (no fuzziness)
 *   - Catalog-shaped query → STRICT: the catalog field must exactly equal the
 *     query or start with `<query><separator>` (e.g. "A7906-1G" for "A7906").
 *     Do NOT fall through to word-bag matching — catalog queries that don't
 *     hit a catalog field are always wrong, even if they coincidentally appear
 *     in a product name.
 *   - Word-bag query → majority of query words must appear in product name,
 *     OR the full query appears literally in the name
 */
function isRelevantResult(query, productName, casNumber, catalogNumber) {
  if (!productName && !casNumber && !catalogNumber) return false;
  const q = query.toLowerCase().trim();
  const name = (productName || '').toLowerCase();
  const cas  = (casNumber || '').toLowerCase().trim();
  const cat  = (catalogNumber || '').toLowerCase().trim();

  // Exact CAS match (query looks like a CAS number: 2-7 / 2 / 1)
  if (/^\d{2,7}-\d{2}-\d$/.test(q)) return cas === q || cat === q;

  // Catalog-shaped query: letters+digits (e.g. "A7906") or pure digits ≥ 5
  // ("123456"), single token, length >= 4. Pure words like "acetone" don't
  // match (no digits), pure single digits don't match (too short).
  const catShaped =
    /^[a-z0-9][a-z0-9_\-]{3,}$/.test(q) &&
    !/\s/.test(q) &&
    /\d/.test(q); // require at least one digit — catalog numbers always have digits

  if (catShaped) {
    // 1. Catalog field match — exact, or pack-size variant with separator
    if (cat === q) return true;
    if (cat && (cat.startsWith(q + '-') || cat.startsWith(q + '_'))) return true;

    // 2. Whole-word match in product name. Resellers (Thermo/Fisher selling a
    //    BD tube, for example) usually carry the manufacturer part number as
    //    a word in the product name while using their own SKU as the catalog
    //    field. We require a word-boundary on BOTH sides so "362761" doesn't
    //    match "3627614".
    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundaryRe = new RegExp(`(?:^|[^a-z0-9])${esc}(?:[^a-z0-9]|$)`, 'i');
    if (boundaryRe.test(productName || '')) return true;

    return false;                    // different product — not relevant
  }

  // Whole-query literal match in name (handles multi-word phrases exactly)
  if (q.length >= 3 && name.includes(q)) return true;

  // Split query into meaningful words (skip very short ones)
  const words = q.split(/[\s,/()\-]+/).filter(w => w.length > 2);
  if (words.length === 0) return true; // can't filter, allow all

  // Majority match: at least ceil(N/2) query words present in name
  const hits = words.filter(w => name.includes(w)).length;
  return hits >= Math.ceil(words.length / 2);
}

/**
 * Stamp every result with provenance: when it was verified + where it came from.
 * `source` values:
 *   "api"     — pulled from the vendor's structured API (best)
 *   "live"    — pulled from the vendor's live product page (JSON-LD / __NEXT_DATA__)
 *   "listing" — parsed from a vendor search-results listing (less structured)
 *   "link"    — only the product URL is verified; price/shipping are best-effort
 */
function stampResult(r, source) {
  return {
    ...r,
    source,
    fetchedAt: Date.now(),
  };
}

/** Build a URL string with query params. */
function buildUrl(base, params) {
  const url = new URL(base);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  });
  return url.toString();
}

module.exports = {
  HTML_HEADERS,
  apiHeaders,
  isBlocked,
  normalizeAvailability,
  extractJsonLd,
  extractNextData,
  buildShippingText,
  isRelevantResult,
  parsePrice,
  extractPriceFromHtml,
  extractShippingFromHtml,
  fetchJson,
  fetchHtml,
  buildUrl,
  stampResult,
};
