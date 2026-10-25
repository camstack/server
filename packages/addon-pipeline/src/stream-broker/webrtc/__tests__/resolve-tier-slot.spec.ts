/**
 * `resolveTierSlot` — pure helper picking a device's assigned tier camStream,
 * with TIER_PREFERENCE (high→mid→low) fallback when the preferred tier is
 * unassigned. See `resolve-tier-slot.ts` for the slice 3b context.
 */
import type { ProfileSlot } from '@camstack/types'
import { describe, expect, it } from 'vitest'

import { resolveTierSlot } from '../resolve-tier-slot.js'

const SLOTS: readonly ProfileSlot[] = [
  {
    deviceId: 104,
    profile: 'high',
    brokerId: '104/high',
    sourceCamStreamId: 'main',
    status: 'streaming',
  },
  {
    deviceId: 104,
    profile: 'mid',
    brokerId: '104/mid',
    sourceCamStreamId: 'derived-mid',
    status: 'streaming',
  },
  {
    deviceId: 104,
    profile: 'low',
    brokerId: '104/low',
    sourceCamStreamId: null,
    status: 'unassigned',
  },
  {
    deviceId: 591,
    profile: 'high',
    brokerId: '591/high',
    sourceCamStreamId: 'other-main',
    status: 'streaming',
  },
]

describe('resolveTierSlot', () => {
  it('returns the exact-tier slot when it is assigned', () => {
    const result = resolveTierSlot(SLOTS, 104, 'mid')
    expect(result).toEqual({ camStreamId: 'derived-mid', profile: 'mid' })
  })

  it('falls back through TIER_PREFERENCE order when the preferred tier is unassigned', () => {
    // low is unassigned for device 104; high and mid are both assigned, so
    // the high→mid→low fallback order should return high.
    const result = resolveTierSlot(SLOTS, 104, 'low')
    expect(result).toEqual({ camStreamId: 'main', profile: 'high' })
  })

  it('returns null when the device has no slots at all', () => {
    const result = resolveTierSlot(SLOTS, 12345, 'high')
    expect(result).toBeNull()
  })

  it('ignores slots belonging to a different deviceId', () => {
    // Device 591 only has a 'high' slot — asking for 'mid' must not fall
    // back to some OTHER device's slot.
    const result = resolveTierSlot(SLOTS, 591, 'mid')
    expect(result).toEqual({ camStreamId: 'other-main', profile: 'high' })
  })

  it('returns null when the only slots for the device are unassigned', () => {
    const onlyUnassigned: readonly ProfileSlot[] = [
      {
        deviceId: 700,
        profile: 'high',
        brokerId: '700/high',
        sourceCamStreamId: null,
        status: 'unassigned',
      },
    ]
    const result = resolveTierSlot(onlyUnassigned, 700, 'high')
    expect(result).toBeNull()
  })
})
