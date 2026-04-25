import { useState } from 'react'

const EXAMPLES = ['67-64-1', 'A1978', 'J65834', '10006317', 'sodium chloride']

export default function SearchBar({ onSearch, loading }) {
  const [value, setValue] = useState('')

  function handleSubmit(e) {
    e.preventDefault()
    const q = value.trim()
    if (q) onSearch(q)
  }

  function fillExample(ex) {
    setValue(ex)
    onSearch(ex)
  }

  return (
    <div className="search-wrap">
      <form className="search-form" onSubmit={handleSubmit}>
        <input
          className="search-input"
          type="text"
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder="Enter catalog # or CAS number (e.g. A1978, 67-64-1)"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          disabled={loading}
        />
        <button className="search-btn" type="submit" disabled={loading || !value.trim()}>
          {loading ? 'Searching…' : 'Search'}
        </button>
      </form>
      <p className="search-examples">
        Try:{' '}
        {EXAMPLES.map((ex, i) => (
          <span key={ex}>
            <button onClick={() => fillExample(ex)} type="button">{ex}</button>
            {i < EXAMPLES.length - 1 && ' · '}
          </span>
        ))}
      </p>
    </div>
  )
}
