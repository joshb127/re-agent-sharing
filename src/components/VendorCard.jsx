// Maps availability strings to badge classes and display labels
function availabilityBadge(avail) {
  if (!avail) return { cls: 'badge-unknown', label: 'Unknown' }
  const a = avail.toLowerCase()
  if (a.includes('in stock') || a === 'available') return { cls: 'badge-in-stock', label: 'In Stock' }
  if (a.includes('limited') || a.includes('low')) return { cls: 'badge-limited', label: 'Limited Stock' }
  if (a.includes('out') || a.includes('unavailable')) return { cls: 'badge-out', label: 'Out of Stock' }
  if (a.includes('backorder')) return { cls: 'badge-backordered', label: 'Backordered' }
  if (a.includes('discontinued')) return { cls: 'badge-out', label: 'Discontinued' }
  return { cls: 'badge-unknown', label: avail }
}

// Returns true if shipping text suggests same/next-day
function isFastShipping(shippingTime) {
  if (!shippingTime) return false
  const s = shippingTime.toLowerCase()
  return s.includes('today') || s.includes('next business') || s.includes('1 business') || s.includes('same day')
}

// Turns a fetchedAt timestamp (ms) into a short "Verified Xm ago" string
function verifiedLabel(fetchedAt) {
  if (!fetchedAt) return null
  const ageSec = Math.max(0, Math.round((Date.now() - fetchedAt) / 1000))
  if (ageSec < 60)    return 'Verified just now'
  if (ageSec < 3600)  return `Verified ${Math.round(ageSec / 60)}m ago`
  if (ageSec < 86400) return `Verified ${Math.round(ageSec / 3600)}h ago`
  return `Verified ${Math.round(ageSec / 86400)}d ago`
}

// Map `source` to a short badge + description
function sourceBadge(source) {
  switch (source) {
    case 'api':     return { label: 'API',     title: 'Pulled from the vendor\u2019s own API' }
    case 'live':    return { label: 'Live',    title: 'Parsed from the live vendor product page' }
    case 'listing': return { label: 'Listing', title: 'Parsed from the vendor search results listing' }
    case 'link':    return { label: 'Link only', title: 'Only the product URL is verified \u2014 click through for price/shipping' }
    default:        return null
  }
}

export default function VendorCard({ result }) {
  const { cls, label } = availabilityBadge(result.availability)
  const fast = isFastShipping(result.shippingTime)

  const formattedPrice = result.price != null
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: result.currency || 'USD' }).format(result.price)
    : null

  const verified = verifiedLabel(result.fetchedAt)
  const src = sourceBadge(result.source)
  // "Link only" results mean we couldn't parse structured data from the page —
  // don't pretend the price/shipping is verified.
  const linkOnly = result.source === 'link'

  return (
    <div className="vendor-card">
      {/* Colored stripe at top — vendor's brand color */}
      <div className="vendor-card-stripe" style={{ background: result.color || '#94a3b8' }} />

      <div className="vendor-card-body">
        {/* Vendor name + availability badge */}
        <div className="vendor-header">
          <span className="vendor-name">{result.vendorName}</span>
          <span className={`vendor-badge ${cls}`}>{label}</span>
        </div>

        {/* Product name */}
        <div className="product-name">{result.productName || 'Product'}</div>

        {/* Catalog # and CAS # */}
        <div className="catalog-row">
          {result.catalogNumber && (
            <span title="Catalog number">Cat# {result.catalogNumber}</span>
          )}
          {result.casNumber && (
            <span title="CAS Registry Number">CAS {result.casNumber}</span>
          )}
        </div>

        {/* Price */}
        <div className="price-row">
          {formattedPrice ? (
            <>
              <span className="price-value">{formattedPrice}</span>
              {result.pricePer && <span className="price-per">/ {result.pricePer}</span>}
            </>
          ) : (
            <span className="price-unavailable">Price: see product page</span>
          )}
        </div>

        {/* Shipping time */}
        <div className="shipping-row">
          <span className="shipping-icon">🚚</span>
          {result.shippingTime ? (
            <span className={fast ? 'shipping-fast' : ''}>{result.shippingTime}</span>
          ) : (
            <span style={{ color: 'var(--text-3)' }}>Shipping: see product page</span>
          )}
        </div>

        {/* Provenance row — how we got this, and when */}
        {(src || verified) && (
          <div
            className="provenance-row"
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              marginTop: 10, fontSize: 12, color: 'var(--text-3, #64748b)',
            }}
          >
            {src && (
              <span
                title={src.title}
                style={{
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: linkOnly ? '#fff7ed' : '#f1f5f9',
                  color: linkOnly ? '#9a3412' : '#0f172a',
                  border: `1px solid ${linkOnly ? '#fed7aa' : '#e2e8f0'}`,
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                {src.label}
              </span>
            )}
            {verified && <span>{verified}</span>}
          </div>
        )}
      </div>

      {/* Order button — opens vendor product page */}
      <div className="vendor-card-footer">
        <a
          className="order-btn"
          href={result.productUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={`Order from ${result.vendorName}`}
        >
          View &amp; Order on {result.vendorName} →
        </a>
      </div>
    </div>
  )
}
