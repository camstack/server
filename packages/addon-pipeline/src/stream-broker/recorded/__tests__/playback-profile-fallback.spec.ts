import { describe, expect, it } from 'vitest'
import {
  gapReachable,
  gapSnapTargetMs,
  profileSearchOrder,
  SNAP_MAX_DISTANCE_MS,
} from '../playback-profile-fallback.js'

describe('profileSearchOrder', () => {
  it('starts from the requested tier and walks the rest high → low', () => {
    expect(profileSearchOrder('mid')).toEqual(['mid', 'high', 'low'])
    expect(profileSearchOrder('high')).toEqual(['high', 'mid', 'low'])
  })
})

describe('gapReachable — a tier has footage for a seek only where the feeder could snap', () => {
  it('a gap with an edge inside the snap bound is reachable; one a day away is not', () => {
    expect(gapReachable({ nearestEdgeMs: 10_000 }, 5_000)).toBe(true)
    expect(gapReachable({ nearestEdgeMs: 5_000 + SNAP_MAX_DISTANCE_MS }, 5_000)).toBe(true)
    expect(gapReachable({ nearestEdgeMs: 5_000 + SNAP_MAX_DISTANCE_MS + 1 }, 5_000)).toBe(false)
    expect(gapReachable({ nearestEdgeMs: 5_000 + 86_400_000 }, 5_000)).toBe(false)
  })

  it('falls back to the footage BEHIND when nothing lies ahead — the feeder does the same', () => {
    expect(gapSnapTargetMs({ nearestEdgeMs: null, prevEndMs: 4_000 })).toBe(3_999)
    expect(gapReachable({ nearestEdgeMs: null, prevEndMs: 4_000 }, 5_000)).toBe(true)
    expect(gapReachable({ nearestEdgeMs: null, prevEndMs: null }, 5_000)).toBe(false)
    expect(gapReachable({ nearestEdgeMs: null }, 5_000)).toBe(false)
  })
})
