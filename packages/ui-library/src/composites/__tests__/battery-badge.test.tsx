// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BatteryBadge } from '../battery-badge'

describe('BatteryBadge', () => {
  it('renders a numeric percentage for a normal (non-binary) battery', () => {
    render(<BatteryBadge status={{ percentage: 62, charging: 'none', sleeping: false }} />)
    // getByText throws if absent — its success IS the assertion.
    expect(screen.getByText('62%')).not.toBeNull()
  })

  it('shows neither a charger glyph nor a "charging" claim for an UNKNOWN power source', () => {
    const { container } = render(
      <BatteryBadge
        status={{ percentage: 62, charging: 'unknown', sleeping: false }}
        variant="full"
      />,
    )
    const title = container.querySelector('span[title]')?.getAttribute('title') ?? ''
    expect(title).not.toContain('charging')
    expect(container.querySelectorAll('svg')).toHaveLength(1)
    expect(container.textContent).not.toContain('unknown')
  })

  it('renders "Normal" for a binary battery at normal level', () => {
    render(
      <BatteryBadge
        status={{ percentage: 100, charging: 'none', sleeping: false, binary: true }}
      />,
    )
    expect(screen.getByText('Normal')).not.toBeNull()
    expect(screen.queryByText(/%/)).toBeNull()
  })

  it('renders "Low" for a binary battery below threshold', () => {
    render(
      <BatteryBadge status={{ percentage: 15, charging: 'none', sleeping: false, binary: true }} />,
    )
    expect(screen.getByText('Low')).not.toBeNull()
    expect(screen.queryByText(/%/)).toBeNull()
  })

  it('returns null when status is missing', () => {
    const { container } = render(<BatteryBadge status={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders "Unknown" — neutral, no fabricated 0 %, no warning icon — for a null (cold-seed) percentage (D315)', () => {
    const { container } = render(
      <BatteryBadge status={{ percentage: null, charging: 'unknown', sleeping: false }} />,
    )
    expect(screen.getByText('Unknown')).not.toBeNull()
    expect(screen.queryByText('0%')).toBeNull()
    const span = container.querySelector('span')
    expect(span?.className).toContain('text-foreground-subtle')
    expect(span?.className).not.toContain('text-rose-400')
  })

  it('renders a genuine 0 % reading as the real critical red badge — never confused with "unknown"', () => {
    const { container } = render(
      <BatteryBadge status={{ percentage: 0, charging: 'none', sleeping: false }} />,
    )
    expect(screen.getByText('0%')).not.toBeNull()
    expect(screen.queryByText('Unknown')).toBeNull()
    const span = container.querySelector('span')
    expect(span?.className).toContain('text-rose-400')
  })
})
