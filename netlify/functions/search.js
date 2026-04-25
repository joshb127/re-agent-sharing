'use strict';

// Firebase Admin is optional — gracefully skipped if not configured.
let db = null;
// Short cache window to stay consistent with the "live-verified" contract:
// fresh enough that price/shipping can't drift far, long enough to absorb
// refresh-mashing without re-scraping every vendor.
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function initFirebase() {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!json) return null;
  try {
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(json)) });
    }
    return admin.firestore();
  } catch (e) {
    console.warn('[Firebase] Init failed, caching disabled:', e.message);
    return null;
  }
}

const { vendors }           = require('./_vendors/index.js');
const { searchAllVendors: braveSearchAll } = require('./_vendors/brave-search.js');
const { searchAllVendors: ddgSearchAll   } = require('./_vendors/ddg-search.js');

const BRAVE_API_KEY = process.env.BRAVE_API_KEY;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const query = ((event.queryStringParameters || {}).q || '').trim();
  if (!query) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Missing required query parameter: ?q=' }),
    };
  }

  if (!db) db = initFirebase();

  const cacheKey = query.toLowerCase().replace(/[^a-z0-9\-.]/g, '_');

  // --- Cache read ---
  if (db) {
    try {
      const doc = await db.collection('reagent_searches').doc(cacheKey).get();
      if (doc.exists) {
        const cached = doc.data();
        const ageMs = Date.now() - cached.timestamp;
        if (ageMs < CACHE_TTL_MS) {
          console.log(`[Cache] HIT for "${query}" (age ${Math.round(ageMs / 1000)}s)`);
          return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({
              ...cached.payload,
              fromCache: true,
              cachedAt: cached.timestamp,
              cacheAgeMs: ageMs,
              cacheTtlMs: CACHE_TTL_MS,
            }),
          };
        }
      }
    } catch (e) {
      console.warn('[Cache] Read error:', e.message);
    }
  }

  let vendorResults;
  let searchMode;
  let timedOut = false;

  if (BRAVE_API_KEY) {
    // ── Brave Search (best quality, 2k free/month) ─────────────────────────
    console.log(`[Search] Brave Search for "${query}"`);
    searchMode = 'brave';
    const out = await runWithTimeout(
      () => braveSearchAll(query, BRAVE_API_KEY),
      25000,
      'Brave Search'
    );
    vendorResults = out.results;
    timedOut = out.timedOut;
    // Fall back to DDG if Brave returned nothing
    if (!hasAnyResults(vendorResults)) {
      console.log('[Search] Brave returned nothing, trying DDG');
      searchMode = 'ddg-fallback';
      const out2 = await runWithTimeout(() => ddgSearchAll(query), 30000, 'DDG');
      vendorResults = out2.results;
      timedOut = timedOut || out2.timedOut;
    }
  } else {
    // ── DuckDuckGo (free, no key needed) ────────────────────────────────────
    console.log(`[Search] DDG Search for "${query}"`);
    searchMode = 'ddg';
    const out = await runWithTimeout(() => ddgSearchAll(query), 30000, 'DDG');
    vendorResults = out.results;
    timedOut = out.timedOut;

    // If DDG also returned nothing, try direct vendor APIs as last resort
    if (!hasAnyResults(vendorResults)) {
      console.log('[Search] DDG empty, falling back to direct vendor APIs');
      searchMode = 'direct-fallback';
      vendorResults = await runDirectVendorSearch(query);
    }
  }

  const payload = {
    query,
    timestamp: Date.now(),
    vendorCount: vendorResults.length,
    vendors: vendorResults,
    searchMode,
    timedOut,
  };

  // --- Cache write ---
  if (db) {
    try {
      await db.collection('reagent_searches').doc(cacheKey).set({ payload, timestamp: Date.now() });
    } catch (e) {
      console.warn('[Cache] Write error:', e.message);
    }
  }

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify(payload),
  };
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function hasAnyResults(vendorResults) {
  return Array.isArray(vendorResults) &&
    vendorResults.some(v => v.results && v.results.length > 0);
}

async function runWithTimeout(fn, ms, label) {
  const TIMEOUT_SENTINEL = Symbol('timeout');
  try {
    const result = await Promise.race([
      fn(),
      new Promise(resolve =>
        setTimeout(() => {
          console.warn(`[Search] ${label} global timeout after ${ms}ms`);
          resolve(TIMEOUT_SENTINEL);
        }, ms)
      ),
    ]);
    if (result === TIMEOUT_SENTINEL) {
      return { results: [], timedOut: true };
    }
    return { results: Array.isArray(result) ? result : [], timedOut: false };
  } catch (err) {
    console.error(`[Search] ${label} failed:`, err.message);
    return { results: [], timedOut: false, error: err.message };
  }
}

async function runDirectVendorSearch(query) {
  console.log(`[Search] Direct vendor APIs for "${query}"`);
  return Promise.all(
    vendors.map(vendor =>
      Promise.race([
        vendor.search(query).catch(err => ({
          vendorId: vendor.id, vendorName: vendor.name, color: vendor.color,
          status: 'error', results: [], error: err.message,
        })),
        new Promise(resolve =>
          setTimeout(() => resolve({
            vendorId: vendor.id, vendorName: vendor.name, color: vendor.color,
            status: 'timeout', results: [],
          }), 8000)
        ),
      ])
    )
  );
}
