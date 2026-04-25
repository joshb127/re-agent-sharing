import { useState, useCallback } from 'react'
import SearchBar from './components/SearchBar.jsx'
import ResultsGrid from './components/ResultsGrid.jsx'
import LoadingState from './components/LoadingState.jsx'

const STATES = { IDLE: 'idle', LOADING: 'loading', SUCCESS: 'success', ERROR: 'error' }

export default function App() {
  const [status, setStatus]   = useState(STATES.IDLE)
  const [query,  setQuery]    = useState('')
  const [data,   setData]     = useState(null)
  const [error,  setError]    = useState(null)

  const handleSearch = useCallback(async (q) => {
    setQuery(q)
    setStatus(STATES.LOADING)
    setError(null)
    setData(null)

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Server error ${res.status}`)
      }
      const json = await res.json()
      setData(json)
      setStatus(STATES.SUCCESS)
    } catch (err) {
      setError(err.message)
      setStatus(STATES.ERROR)
    }
  }, [])

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <span className="header-logo">🔬</span>
        <div>
          <div className="header-title">ReagentSearch</div>
          <div className="header-subtitle">Compare lab reagent prices across vendors</div>
        </div>
      </header>

      <main className="main">
        {/* Hero + Search (always visible) */}
        {status === STATES.IDLE && (
          <div className="hero">
            <h1 className="hero-title">Find the best price for any reagent</h1>
            <p className="hero-sub">
              Search by catalog number, CAS number, or product name.<br />
              We'll check Sigma-Aldrich, Thermo Fisher, VWR, Cayman, TCI, Strem, and more.
            </p>
          </div>
        )}

        <SearchBar onSearch={handleSearch} loading={status === STATES.LOADING} />

        {/* States */}
        {status === STATES.LOADING && <LoadingState query={query} />}

        {status === STATES.ERROR && (
          <div className="error-banner">
            <strong>Search failed:</strong> {error}
          </div>
        )}

        {status === STATES.SUCCESS && data && (
          <div style={{ marginTop: 32 }}>
            <ResultsGrid data={data} />
          </div>
        )}
      </main>
    </div>
  )
}
