import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SearchResultsList } from './SearchResultsList'

const base = {
  groups: [],
  activeKey: null,
  query: 'porch',
  totalMatched: 0,
  truncated: false,
  onSelect: () => undefined,
  onHover: () => undefined,
}

describe('SearchResultsList — unanswered sources', () => {
  it('says it is still searching, not "no results", while a source is pending', () => {
    render(<SearchResultsList {...base} pending />)
    expect(screen.getByTestId('search-pending')).toBeTruthy()
  })

  it('says no results once everything answered', () => {
    render(<SearchResultsList {...base} pending={false} />)
    expect(screen.queryByTestId('search-pending')).toBeNull()
  })
})
