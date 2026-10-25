// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MediaCard, MediaGrid } from '../media-grid'

describe('MediaGrid', () => {
  it('shows pending distinctly from empty', () => {
    const { rerender } = render(<MediaGrid status="pending" pendingMessage="Loading…" />)
    expect(screen.getByText('Loading…')).toBeTruthy()
    rerender(<MediaGrid status="empty" emptyMessage="Nothing here" />)
    expect(screen.getByText('Nothing here')).toBeTruthy()
  })

  it('renders ready children', () => {
    render(
      <MediaGrid status="ready">
        <MediaCard label="one">
          <span>tile</span>
        </MediaCard>
      </MediaGrid>,
    )
    expect(screen.getByText('tile')).toBeTruthy()
  })
})
