import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatRelativeTime, isSameLocalDay, MIN_PLAUSIBLE_TIMESTAMP_MS } from '../format'

const NOW = 1_700_000_000_000
const DAY_MS = 24 * 60 * 60 * 1000

afterEach(() => {
  vi.useRealTimers()
})

function at(deltaMs: number): number {
  return NOW - deltaMs
}

describe('formatRelativeTime', () => {
  it('returns "just now" for very recent timestamps', () => {
    vi.useFakeTimers().setSystemTime(NOW)
    expect(formatRelativeTime(at(0))).toBe('just now')
    expect(formatRelativeTime(at(5_000))).toBe('just now')
  })

  it('formats minutes for sub-hour deltas', () => {
    vi.useFakeTimers().setSystemTime(NOW)
    expect(formatRelativeTime(at(60_000))).toBe('1m ago')
    expect(formatRelativeTime(at(5 * 60_000))).toBe('5m ago')
  })

  it('formats hours for sub-day deltas', () => {
    vi.useFakeTimers().setSystemTime(NOW)
    expect(formatRelativeTime(at(60 * 60_000))).toBe('1h ago')
  })

  it('formats days for >= 1 day deltas', () => {
    vi.useFakeTimers().setSystemTime(NOW)
    expect(formatRelativeTime(at(24 * 60 * 60_000))).toBe('1d ago')
  })

  it('returns "—" for null/undefined/non-positive input', () => {
    vi.useFakeTimers().setSystemTime(NOW)
    expect(formatRelativeTime(null)).toBe('—')
    expect(formatRelativeTime(undefined)).toBe('—')
    expect(formatRelativeTime(0)).toBe('—')
    expect(formatRelativeTime(-5)).toBe('—')
  })

  it('returns "—" for a seeded "known value, unknown change time" stamp below the sane floor', () => {
    vi.useFakeTimers().setSystemTime(NOW)
    // Homematic's HM_SEEDED_CHANGED_AT = 1: a known value with no real
    // change instant. A bare `<= 0` check would have rendered this as
    // "20000+ days ago" instead of hiding it.
    expect(formatRelativeTime(1)).toBe('—')
    expect(formatRelativeTime(MIN_PLAUSIBLE_TIMESTAMP_MS - 1)).toBe('—')
  })

  it('treats a timestamp at or above the floor as a real instant', () => {
    vi.useFakeTimers().setSystemTime(MIN_PLAUSIBLE_TIMESTAMP_MS + DAY_MS)
    expect(formatRelativeTime(MIN_PLAUSIBLE_TIMESTAMP_MS)).toBe('1d ago')
  })

  it('treats future timestamps (clock skew) as "just now"', () => {
    vi.useFakeTimers().setSystemTime(NOW)
    expect(formatRelativeTime(NOW + 10_000)).toBe('just now')
  })
})

describe('isSameLocalDay', () => {
  it('is true for the same calendar day', () => {
    const now = new Date(2026, 0, 15, 10, 0, 0)
    const sameDayMorning = new Date(2026, 0, 15, 0, 30, 0).getTime()
    expect(isSameLocalDay(sameDayMorning, now)).toBe(true)
  })

  it('is false across a day boundary', () => {
    const now = new Date(2026, 0, 15, 10, 0, 0)
    const yesterday = new Date(2026, 0, 14, 23, 59, 0).getTime()
    expect(isSameLocalDay(yesterday, now)).toBe(false)
  })
})
