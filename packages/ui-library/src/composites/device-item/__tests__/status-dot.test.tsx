// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { StatusDot } from '../status-dot'

const NOW = 1_700_000_000_000

afterEach(() => {
  vi.useRealTimers()
})

function title(scope: { querySelector: (s: string) => Element | null }): string | null {
  return scope.querySelector('[title]')?.getAttribute('title') ?? null
}

describe('StatusDot', () => {
  it('shows "Online" / "Disabled" titles', () => {
    const { container: a } = render(<StatusDot status="online" />)
    expect(title(a)).toBe('Online')
    const { container: b } = render(<StatusDot status="disabled" />)
    expect(title(b)).toBe('Disabled')
  })

  it('shows recording titles for the recording states', () => {
    const { container: a } = render(<StatusDot status="recording-continuous" />)
    expect(title(a)).toBe('Recording · always')
    const { container: b } = render(<StatusDot status="recording-events" />)
    expect(title(b)).toBe('Recording · on motion')
  })

  it('pulses the alive states and not the static ones', () => {
    const { container: alive } = render(<StatusDot status="recording-continuous" />)
    expect(alive.querySelector('span')?.className).toContain('animate-pulse')
    const { container: off } = render(<StatusDot status="offline" />)
    expect(off.querySelector('span')?.className).not.toContain('animate-pulse')
  })

  it('shows plain "Offline" when no lastChangedAt is provided', () => {
    const { container } = render(<StatusDot status="offline" />)
    expect(title(container)).toBe('Offline')
  })

  it('appends "last seen" to the Offline tooltip when lastChangedAt is provided', () => {
    vi.useFakeTimers().setSystemTime(NOW)
    const { container } = render(<StatusDot status="offline" lastChangedAt={NOW - 5 * 60_000} />)
    expect(title(container)).toBe('Offline · last seen 5m ago')
  })

  it('ignores lastChangedAt for non-offline statuses', () => {
    vi.useFakeTimers().setSystemTime(NOW)
    const { container } = render(<StatusDot status="online" lastChangedAt={NOW - 5 * 60_000} />)
    expect(title(container)).toBe('Online')
  })

  it('falls back to plain "Offline" when lastChangedAt is non-positive', () => {
    const { container } = render(<StatusDot status="offline" lastChangedAt={0} />)
    expect(title(container)).toBe('Offline')
  })
})
