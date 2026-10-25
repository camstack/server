import { describe, it, expect, vi, afterEach } from 'vitest'
import { formatLastSeen } from '../format-last-seen'

const NOW = 1_700_000_000_000

afterEach(() => {
  vi.useRealTimers()
})

function at(deltaMs: number): number {
  return NOW - deltaMs
}

describe('formatLastSeen', () => {
  it('returns "just now" for very recent timestamps', () => {
    vi.useFakeTimers().setSystemTime(NOW)
    expect(formatLastSeen(at(0))).toBe('just now')
    expect(formatLastSeen(at(5_000))).toBe('just now')
  })

  it('formats minutes for sub-hour deltas', () => {
    vi.useFakeTimers().setSystemTime(NOW)
    expect(formatLastSeen(at(60_000))).toBe('1m ago')
    expect(formatLastSeen(at(5 * 60_000))).toBe('5m ago')
    expect(formatLastSeen(at(59 * 60_000))).toBe('59m ago')
  })

  it('formats hours for sub-day deltas', () => {
    vi.useFakeTimers().setSystemTime(NOW)
    expect(formatLastSeen(at(60 * 60_000))).toBe('1h ago')
    expect(formatLastSeen(at(2 * 60 * 60_000))).toBe('2h ago')
  })

  it('formats days for >= 1 day deltas', () => {
    vi.useFakeTimers().setSystemTime(NOW)
    expect(formatLastSeen(at(24 * 60 * 60_000))).toBe('1d ago')
    expect(formatLastSeen(at(3 * 24 * 60 * 60_000))).toBe('3d ago')
  })

  it('returns null for null/undefined/non-positive input', () => {
    vi.useFakeTimers().setSystemTime(NOW)
    expect(formatLastSeen(null)).toBeNull()
    expect(formatLastSeen(undefined)).toBeNull()
    expect(formatLastSeen(0)).toBeNull()
    expect(formatLastSeen(-5)).toBeNull()
  })

  it('returns null for a seeded "known value, unknown change time" stamp below the sane floor', () => {
    vi.useFakeTimers().setSystemTime(NOW)
    // Homematic's HM_SEEDED_CHANGED_AT = 1: a known value with no real
    // change instant. A bare `<= 0` check would have rendered this as
    // "20000+ days ago" instead of hiding it.
    expect(formatLastSeen(1)).toBeNull()
  })

  it('treats future timestamps (clock skew) as "just now"', () => {
    vi.useFakeTimers().setSystemTime(NOW)
    expect(formatLastSeen(NOW + 10_000)).toBe('just now')
  })
})
