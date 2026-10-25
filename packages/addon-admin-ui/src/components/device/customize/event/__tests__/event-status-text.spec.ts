import { describe, expect, it } from 'vitest'
import { doorbellRingStatus, motionActiveSeconds, motionNowStatus } from '../event-status-text'

describe('motionNowStatus', () => {
  const now = Date.UTC(2026, 0, 15, 12, 0, 12)

  it('maps pending, unknown, quiet, and active with duration', () => {
    expect(motionNowStatus('pending', null, now)).toEqual({ kind: 'pending', seconds: null })
    expect(motionNowStatus('unknown', null, now)).toEqual({ kind: 'unknown', seconds: null })
    expect(motionNowStatus(false, null, now)).toEqual({ kind: 'quiet', seconds: null })
    expect(motionNowStatus(true, Date.UTC(2026, 0, 15, 12, 0, 0), now)).toEqual({
      kind: 'active',
      seconds: 12,
    })
    expect(motionNowStatus(true, null, now)).toEqual({ kind: 'unknown', seconds: null })
  })
})

describe('motionActiveSeconds', () => {
  it('rejects placeholders and negative skew', () => {
    expect(motionActiveSeconds(1, 10_000)).toBeNull()
    expect(
      motionActiveSeconds(Date.UTC(2026, 0, 15, 12, 0, 10), Date.UTC(2026, 0, 15, 12, 0, 12)),
    ).toBe(2)
  })
})

describe('doorbellRingStatus', () => {
  it('names pending, unknown, no ring yet, and a ring with count', () => {
    expect(doorbellRingStatus('pending', null)).toEqual({
      kind: 'pending',
      lastPressedAt: null,
      pressCount: null,
    })
    expect(doorbellRingStatus('unknown', 2)).toEqual({
      kind: 'unknown',
      lastPressedAt: null,
      pressCount: null,
    })
    expect(doorbellRingStatus(null, 0)).toEqual({
      kind: 'none',
      lastPressedAt: null,
      pressCount: 0,
    })
    const at = Date.UTC(2026, 0, 10, 8, 30, 0)
    expect(doorbellRingStatus(at, 3)).toEqual({
      kind: 'ring',
      lastPressedAt: at,
      pressCount: 3,
    })
  })
})
