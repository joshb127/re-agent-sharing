import { useState } from 'react'
import VendorCard from './VendorCard.jsx'

const STATUS_ICONS = {
  blocked: '🚫',
  timeout: '⏱️',
  error:   '⚠️',
  no_results: '🔍',
}
const STATUS_LABELS = {
  blocked:    'Blocked our request',
  timeout:    'Timed out',
  error:      'Error',
  no_results: 'No results found',
}

// Shipping sort: try to parse business days from text, default to 999 (unknown = last)
function parseShippingDays(text) {
  if (!text) return 999
  const t = text.toLowerCase()
  if (t.includes('today') || t.includes('same day')) return 0
  if (t.includes('next business') || t.includes('1 business')) return 1
  const m = t.match(/(\d+)\s*(?:[-–to]+\s*(\d+))?\s*business/)
  if (m) return Number(m[1])
  const m2 = t.match(/(\d+)\s*(?:[-–to]+\s*(\d+))?\s*day/)
  if (m2) return Number(m2[1])
  return 999
}

export default function ResultsGrid({ data }) {
  const [sort, setSort] = useState('price')
  const [showBlocked, setShowBlocked] = useState(false)

  // Flatten all successful results into one list
  const allResults = (data.vendors || []).flatMap(v =>
    v.status === 'success' ? v.results : []
  )

  // Filter out results that are missing a valid product URL
  const validResults = allResults.filter(r => r.productUrl && r.productUrl.startsWith('http'))

  // Sort results
  const sorted = [...validResults].sort((a, b) => {
    if (sort === 'price') {
      const pa = a.price ?? Infinity
      const pb = b.price ?? Infinity
      return pa - pb
    }
    if (sort === 'shipping') {
      return parseShippingDays(a.shippingTime) - parseShippingDays(b.shippingTime)
    }
    if (sort === 'vendor') {
      return a.vendorName.localeCompare(b.vendorName)
    }
    return 0
  })

  // Vendors that didn't return results (blocked, timeout, error, no_results)
  const failedVendors = (data.vendors || []).filter(v => v.status !== 'success')

  // Cache timestamp display
  const cachedAt = data.cachedAt || data.timestamp
  const cacheAge = cachedAt ? Math.round((Date.now() - cachedAt) / 60000) : null

  // Search mode label
  const searchModeLabel = {
    'brave':          '⚡ Brave Search',
    'ddg':            '🦆 DuckDuckGo',
    'ddg-fallback':   '🦆 DuckDuckGo',
    'direct-fallback':'🔌 Direct API',
  }[data.searchMode] || null

  return (
    <div>
      {/* Controls bar */}
      {sorted.length > 0 && (
        <div className="controls">
          <div className="controls-left">
            <strong>{sorted.length}</strong> result{sorted.length !== 1 ? 's' : ''} for &ldquo;{data.query}&rdquo;
          </div>
          <div className="controls-right">
            <span className="sort-label">Sort by:</span>
            {[
              { key: 'price',    label: '💰 Price' },
              { key: 'shipping', label: '🚚 Shipping' },
              { key: 'vendor',   label: '🏢 Vendor' },
            ].map(({ key, label }) => (
              <button
                key={key}
                className={`sort-btn ${sort === key ? 'active' : ''}`}
                onClick={() => setSort(key)}
              >
                {label}
              </button>
            ))}
            {searchModeLabel && (
              <span className="cache-note" title="Search method used to find products">
                {searchModeLabel}
              </span>
            )}
            {data.fromCache && cacheAge !== null && (
              <span className="cache-note" title="Results are cached to reduce load on vendor sites">
                ♻️ Cached {cacheAge < 1 ? 'just now' : `${cacheAge}m ago`}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Results grid */}
      {sorted.length > 0 ? (
        <div className="results-grid">
          {sorted.map((result, i) => (
            <VendorCard key={`${result.vendorId}-${result.catalogNumber}-${i}`} result={result} />
          ))}
        </div>
      ) : data.timedOut ? (
        <div className="no-results">
          <div className="no-results-icon">⏱️</div>
          <h2>Search took too long</h2>
          <p>One or more vendors didn&rsquo;t respond in time. Try the search again in a moment.</p>
        </div>
      ) : (
        <div className="no-results">
          <div className="no-results-icon">🔬</div>
          <h2>No results found for &ldquo;{data.query}&rdquo;</h2>
          <p>Suggestions:</p>
          <ul style={{ textAlign: 'left', display: 'inline-block', marginTop: 8 }}>
            <li>Try a CAS number (e.g. <strong>67-64-1</strong> for acetone)</li>
            <li>Try a vendor catalog number (e.g. <strong>A1978</strong>)</li>
            <li>Use the full chemical name instead of an abbreviation</li>
            <li>Check spelling — chemical names must match exactly</li>
          </ul>
        </div>
      )}

      {/* Blocked / failed vendors section */}
      {failedVendors.length > 0 && (
        <div className="blocked-section">
          <button
            className="blocked-toggle"
            onClick={() => setShowBlocked(b => !b)}
          >
            {showBlocked ? '▲' : '▼'}
            &nbsp;{failedVendors.length} vendor{failedVendors.length !== 1 ? 's' : ''} could not be reached
          </button>

          {showBlocked && (
            <div className="blocked-list">
              {failedVendors.map(v => (
                <div key={v.vendorId} className="blocked-chip">
                  <span className="status-icon">{STATUS_ICONS[v.status] || '❓'}</span>
                  <strong>{v.vendorName}</strong>
                  <span>— {STATUS_LABELS[v.status] || v.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
