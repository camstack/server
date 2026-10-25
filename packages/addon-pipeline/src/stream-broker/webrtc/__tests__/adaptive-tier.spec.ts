import { describe, it, expect } from 'vitest'
import { pickAdaptiveTier, VIEWPORT_TILE_MAX_PX } from '../adaptive-tier.js'

const ALL = ['high', 'mid', 'low'] as const

describe('pickAdaptiveTier', () => {
  it('defaults to the smallest available tier when there are no hints', () => {
    expect(pickAdaptiveTier({ available: ALL })).toEqual({ tier: 'low', reason: 'default-low' })
    expect(pickAdaptiveTier({ available: ['high', 'mid'] })).toEqual({
      tier: 'mid',
      reason: 'default-low',
    })
  })

  it('does not send a phone-sized player (430×242) to high before a probe', () => {
    expect(pickAdaptiveTier({ available: ALL, viewportWidth: 430, viewportHeight: 242 })).toEqual({
      tier: 'low',
      reason: 'default-low',
    })
  })

  it('caps a tiny grid tile to low even after a fat probe', () => {
    expect(
      pickAdaptiveTier({
        available: ALL,
        viewportWidth: VIEWPORT_TILE_MAX_PX - 80,
        viewportHeight: 90,
      }),
    ).toEqual({ tier: 'low', reason: 'default-low' })
    expect(
      pickAdaptiveTier({
        available: ALL,
        viewportWidth: VIEWPORT_TILE_MAX_PX - 80,
        viewportHeight: 90,
        downlinkMbps: 50,
      }),
    ).toEqual({ tier: 'low', reason: 'viewport-ceiling' })
  })

  it('uses downlink as the limiter: 1 Mbps → low, 4 Mbps → mid, 20 Mbps → high', () => {
    expect(pickAdaptiveTier({ available: ALL, downlinkMbps: 1 })).toEqual({
      tier: 'low',
      reason: 'downlink',
    })
    expect(pickAdaptiveTier({ available: ALL, downlinkMbps: 4 })).toEqual({
      tier: 'mid',
      reason: 'downlink',
    })
    expect(pickAdaptiveTier({ available: ALL, downlinkMbps: 20 })).toEqual({
      tier: 'high',
      reason: 'downlink',
    })
  })

  it('honours an explicit prefersTier, falling back smallest-first when missing', () => {
    expect(pickAdaptiveTier({ available: ALL, prefersTier: 'low' })).toEqual({
      tier: 'low',
      reason: 'prefers-tier',
    })
    expect(pickAdaptiveTier({ available: ['high', 'mid'], prefersTier: 'low' })).toEqual({
      tier: 'mid',
      reason: 'prefers-tier-fallback',
    })
  })
})
