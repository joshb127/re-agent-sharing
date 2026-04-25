import { useState, useEffect } from 'react'

const ALL_VENDORS = [
  'Sigma-Aldrich',
  'Thermo Fisher',
  'VWR',
  'Cayman Chemical',
  'TCI America',
  'Strem Chemicals',
]

export default function LoadingState({ query }) {
  const [activeIdx, setActiveIdx] = useState(0)

  useEffect(() => {
    const id = setInterval(() => {
      setActiveIdx(i => (i + 1) % ALL_VENDORS.length)
    }, 700)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="loading-wrap">
      <div className="spinner" />
      <div>
        <div className="loading-title">Searching vendors…</div>
        <div className="loading-sub">Querying {ALL_VENDORS.length} suppliers for &ldquo;{query}&rdquo;</div>
      </div>
      <div className="vendor-pills">
        {ALL_VENDORS.map((v, i) => (
          <span key={v} className={`vendor-pill ${i === activeIdx ? 'querying' : ''}`}>
            {v}
          </span>
        ))}
      </div>
    </div>
  )
}
