'use strict';

/**
 * Vendor scraper diagnostic harness.
 *
 * Run locally (requires outbound internet to vendor sites):
 *   node netlify/functions/_vendors/test-harness.js
 *
 * Optional: narrow to a subset of vendors or queries:
 *   node netlify/functions/_vendors/test-harness.js --vendors=sigma,thermofisher --queries="67-64-1,A1978"
 *
 * Writes a human-readable table to stdout + a full JSON report to:
 *   ./test-harness-report.json
 *
 * What it measures per (vendor, query):
 *   - status:           success / no_results / blocked / error / timeout
 *   - resultCount:      how many result cards came back
 *   - withPrice:        how many of those have a numeric price
 *   - withShipping:     how many have a shipping string
 *   - withValidUrl:     how many have a productUrl that starts with http
 *   - reachable:        whether the URL actually 200s (HEAD request)
 *   - elapsedMs:        wall time for the vendor call
 *   - firstResult:      a sanitized sample of the first result for eyeballing
 */

const { vendors } = require('./index.js');

// ───────── CLI parsing ────────────────────────────────────────────────────
const args = process.argv.slice(2).reduce((acc, arg) => {
  const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) acc[m[1]] = m[2] ?? true;
  return acc;
}, {});

const DEFAULT_QUERIES = [
  '67-64-1',         // acetone (CAS)
  'A1978',           // Sigma catalog: bovine serum albumin
  'J65834',          // Thermo catalog (Alfa Aesar heritage number)
  'sodium chloride', // plain text
];

const selectedVendors = args.vendors
  ? new Set(String(args.vendors).split(',').map(s => s.trim().toLowerCase()))
  : null; // null = all

const queries = args.queries
  ? String(args.queries).split(',').map(s => s.trim()).filter(Boolean)
  : DEFAULT_QUERIES;

const VENDOR_TIMEOUT_MS = 20000; // generous — we want to see what the scraper actually does

// ───────── Helpers ────────────────────────────────────────────────────────
async function runVendor(vendor, query) {
  const started = Date.now();
  let raw;
  try {
    raw = await Promise.race([
      vendor.search(query),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('harness_timeout')), VENDOR_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    return {
      vendorId: vendor.id,
      vendorName: vendor.name,
      query,
      status: err.message === 'harness_timeout' ? 'timeout' : 'error',
      resultCount: 0,
      withPrice: 0,
      withShipping: 0,
      withValidUrl: 0,
      reachableUrls: 0,
      elapsedMs: Date.now() - started,
      error: err.message,
      firstResult: null,
    };
  }

  const elapsedMs = Date.now() - started;
  const results = Array.isArray(raw?.results) ? raw.results : [];
  const withPrice = results.filter(r => typeof r.price === 'number' && !isNaN(r.price)).length;
  const withShipping = results.filter(r => r.shippingTime && String(r.shippingTime).trim()).length;
  const validUrlResults = results.filter(r => r.productUrl && /^https?:\/\//.test(r.productUrl));

  // HEAD-check each URL in parallel with 4s cap per URL
  const reachable = await Promise.all(
    validUrlResults.map(r =>
      checkUrl(r.productUrl)
        .then(ok => (ok ? 1 : 0))
        .catch(() => 0)
    )
  );

  return {
    vendorId: vendor.id,
    vendorName: vendor.name,
    query,
    status: raw?.status || 'unknown',
    resultCount: results.length,
    withPrice,
    withShipping,
    withValidUrl: validUrlResults.length,
    reachableUrls: reachable.reduce((a, b) => a + b, 0),
    elapsedMs,
    error: raw?.error || null,
    firstResult: results[0]
      ? {
          productName: results[0].productName,
          catalogNumber: results[0].catalogNumber,
          casNumber: results[0].casNumber,
          price: results[0].price,
          currency: results[0].currency,
          pricePer: results[0].pricePer,
          availability: results[0].availability,
          shippingTime: results[0].shippingTime,
          productUrl: results[0].productUrl,
        }
      : null,
  };
}

async function checkUrl(url) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
    });
    // Some vendors reject HEAD; treat any 200-399 as reachable, 405 as "try GET"
    if (res.status === 405) {
      const g = await fetch(url, { method: 'GET', signal: controller.signal });
      return g.ok;
    }
    return res.ok;
  } finally {
    clearTimeout(id);
  }
}

function fmt(n, width) {
  return String(n).padEnd(width);
}

function printRow(cols, widths) {
  console.log(cols.map((c, i) => fmt(c, widths[i])).join(' | '));
}

// ───────── Main ───────────────────────────────────────────────────────────
(async () => {
  const activeVendors = vendors.filter(v =>
    !selectedVendors || selectedVendors.has(v.id.toLowerCase())
  );

  if (!activeVendors.length) {
    console.error('No vendors selected. Available:', vendors.map(v => v.id).join(', '));
    process.exit(1);
  }

  console.log('ReagentCompare scraper diagnostic');
  console.log('─'.repeat(80));
  console.log(`Vendors:  ${activeVendors.map(v => v.id).join(', ')}`);
  console.log(`Queries:  ${queries.join(' | ')}`);
  console.log(`Timeout:  ${VENDOR_TIMEOUT_MS}ms per vendor call`);
  console.log('─'.repeat(80));

  const all = [];
  for (const vendor of activeVendors) {
    for (const query of queries) {
      process.stdout.write(`  ${vendor.id.padEnd(14)} ${JSON.stringify(query).padEnd(22)} … `);
      const row = await runVendor(vendor, query);
      all.push(row);
      const verdict =
        row.status === 'success' && row.resultCount > 0
          ? `OK (${row.resultCount} results, ${row.withPrice} priced, ${row.reachableUrls}/${row.withValidUrl} URLs live)`
          : `${row.status.toUpperCase()}${row.error ? ' — ' + row.error : ''}`;
      console.log(`${row.elapsedMs}ms · ${verdict}`);
    }
  }

  console.log('─'.repeat(80));
  console.log('Summary');
  console.log('─'.repeat(80));

  const widths = [14, 22, 10, 6, 6, 8, 8, 8];
  printRow(['vendor', 'query', 'status', 'n', '$', 'ship', 'urls', 'live'], widths);
  printRow(Array(widths.length).fill('─'.repeat(20)).slice(0, widths.length), widths);
  for (const r of all) {
    printRow(
      [
        r.vendorId,
        JSON.stringify(r.query).slice(0, 20),
        r.status,
        r.resultCount,
        r.withPrice,
        r.withShipping,
        r.withValidUrl,
        r.reachableUrls,
      ],
      widths
    );
  }

  const reportPath = require('path').join(process.cwd(), 'test-harness-report.json');
  require('fs').writeFileSync(
    reportPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        queries,
        vendors: activeVendors.map(v => v.id),
        results: all,
      },
      null,
      2
    )
  );
  console.log('─'.repeat(80));
  console.log(`Full report written to: ${reportPath}`);
  console.log('Tip: open it to see firstResult samples (product name, price, URL) per run.');
})().catch(err => {
  console.error('Harness crashed:', err);
  process.exit(1);
});
