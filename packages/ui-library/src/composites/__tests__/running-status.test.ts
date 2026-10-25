import { describe, expect, it } from 'vitest'
import { runningDurationSince, runningStatusParts } from '../running-status'

describe('runningDurationSince', () => {
  const now = 1_700_000_000_000

  it('returns at least one minute under sixty minutes', () => {
    expect(runningDurationSince(now - 42 * 60_000, now)).toEqual({ minutes: 42 })
    expect(runningDurationSince(now - 30_000, now)).toEqual({ minutes: 1 })
  })

  it('returns whole hours from sixty minutes upward', () => {
    expect(runningDurationSince(now - 90 * 60_000, now)).toEqual({ hours: 1 })
    expect(runningDurationSince(now - 125 * 60_000, now)).toEqual({ hours: 2 })
  })

  it('returns null for unusable since values', () => {
    expect(runningDurationSince(null, now)).toBeNull()
    expect(runningDurationSince(0, now)).toBeNull()
    expect(runningDurationSince(now + 60_000, now)).toBeNull()
  })
})

describe('runningStatusParts', () => {
  const now = 1_700_000_000_000

  it('maps the three running states', () => {
    expect(runningStatusParts(null, null, null, now)).toEqual({ key: 'unknown' })
    expect(runningStatusParts(false, now, 'Pause', now)).toEqual({
      key: 'idle',
      phase: 'Pause',
    })
    expect(runningStatusParts(true, now - 42 * 60_000, 'Eco', now)).toEqual({
      key: 'running',
      duration: { minutes: 42 },
      phase: 'Eco',
    })
  })
})
