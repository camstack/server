// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { OfflineBadge } from '../offline-badge'

const NOW = 1_700_000_000_000

afterEach(() => {
  vi.useRealTimers()
})

describe('OfflineBadge', () => {
  it('renders the "Unavailable" label', () => {
    render(<OfflineBadge lastChangedAt={null} />)
    expect(screen.getByText('Unavailable')).toBeTruthy()
  })

  it('appends the relative last-seen when lastChangedAt is provided', () => {
    vi.useFakeTimers().setSystemTime(NOW)
    render(<OfflineBadge lastChangedAt={NOW - 5 * 60_000} />)
    expect(screen.getByText('Unavailable')).toBeTruthy()
    expect(screen.getByText(/last seen 5m ago/i)).toBeTruthy()
  })

  it('renders only "Unavailable" (no last-seen) when lastChangedAt is null', () => {
    render(<OfflineBadge lastChangedAt={null} />)
    expect(screen.getByText('Unavailable')).toBeTruthy()
    expect(screen.queryByText(/last seen/i)).toBeNull()
  })

  it('renders only "Unavailable" when lastChangedAt is non-positive', () => {
    render(<OfflineBadge lastChangedAt={0} />)
    expect(screen.getByText('Unavailable')).toBeTruthy()
    expect(screen.queryByText(/last seen/i)).toBeNull()
  })

  it('exposes a descriptive title for accessibility', () => {
    vi.useFakeTimers().setSystemTime(NOW)
    const { container } = render(<OfflineBadge lastChangedAt={NOW - 2 * 60 * 60_000} />)
    const root = container.querySelector('[title]')
    expect(root?.getAttribute('title')).toMatch(/last seen 2h ago/i)
  })
})
