import { describe, it, expect } from 'vitest'
import {
  makeProfileBrokerId,
  parseProfileBrokerId,
  selectAssignedProfileSlots,
  makeSourceBrokerId,
} from '../schemas/streaming-shared.js'
import type { ProfileSlot } from '../schemas/streaming-shared.js'

function slot(
  p: Partial<ProfileSlot> & Pick<ProfileSlot, 'deviceId' | 'profile' | 'sourceCamStreamId'>,
): ProfileSlot {
  return {
    brokerId: `${p.deviceId}/${p.profile}`,
    status: p.sourceCamStreamId === null ? 'unassigned' : 'streaming',
    ...p,
  }
}

describe('makeProfileBrokerId / parseProfileBrokerId', () => {
  it('builds the canonical `${deviceId}/${profile}` id', () => {
    expect(makeProfileBrokerId(5, 'high')).toBe('5/high')
    expect(makeProfileBrokerId(127, 'low')).toBe('127/low')
  })

  it('round-trips a canonical id back to {deviceId, profile}', () => {
    expect(parseProfileBrokerId('5/high')).toEqual({ deviceId: 5, profile: 'high' })
    expect(parseProfileBrokerId(makeProfileBrokerId(42, 'mid'))).toEqual({
      deviceId: 42,
      profile: 'mid',
    })
  })

  it('returns null for a broker-internal cam-stream id (never a profile)', () => {
    // physical cam-stream ids / derived / adaptive refs are NOT consumer-facing
    expect(parseProfileBrokerId('5/native:main')).toBeNull()
    expect(parseProfileBrokerId('5/adaptive')).toBeNull()
    expect(parseProfileBrokerId('5/derived:hap-720p')).toBeNull()
  })

  it('makeSourceBrokerId addresses the physical source by camStreamId', () => {
    expect(makeSourceBrokerId(5, 'native:main')).toBe('5/native:main')
    expect(makeSourceBrokerId(7, 'native:sub')).toBe('7/native:sub')
    // a source brokerId is NOT a profile brokerId — parse must reject it
    expect(parseProfileBrokerId(makeSourceBrokerId(5, 'native:main'))).toBeNull()
  })

  it('returns null for malformed ids', () => {
    expect(parseProfileBrokerId('high')).toBeNull() // no slash
    expect(parseProfileBrokerId('abc/high')).toBeNull() // non-numeric device
    expect(parseProfileBrokerId('5/ultra')).toBeNull() // not a CamProfile
    expect(parseProfileBrokerId('/high')).toBeNull() // empty device
  })
})

describe('selectAssignedProfileSlots', () => {
  it('keeps only assigned slots (sourceCamStreamId != null), ordered high→mid→low', () => {
    const slots: ProfileSlot[] = [
      slot({ deviceId: 5, profile: 'low', sourceCamStreamId: 'native:sub' }),
      slot({ deviceId: 5, profile: 'mid', sourceCamStreamId: null }), // unassigned → dropped
      slot({ deviceId: 5, profile: 'high', sourceCamStreamId: 'native:main' }),
    ]
    const out = selectAssignedProfileSlots(slots)
    expect(out.map((s) => s.profile)).toEqual(['high', 'low'])
  })

  it('dedupes by physical source so the same encoder is not recorded twice', () => {
    const slots: ProfileSlot[] = [
      slot({ deviceId: 5, profile: 'high', sourceCamStreamId: 'native:main' }),
      slot({ deviceId: 5, profile: 'mid', sourceCamStreamId: 'native:main' }), // same source → dropped
      slot({ deviceId: 5, profile: 'low', sourceCamStreamId: 'native:sub' }),
    ]
    const out = selectAssignedProfileSlots(slots)
    expect(out.map((s) => s.profile)).toEqual(['high', 'low'])
  })

  it('scopes to a single device when deviceId is given', () => {
    const slots: ProfileSlot[] = [
      slot({ deviceId: 5, profile: 'high', sourceCamStreamId: 'native:main' }),
      slot({ deviceId: 7, profile: 'high', sourceCamStreamId: 'native:main' }),
    ]
    expect(selectAssignedProfileSlots(slots, 5).map((s) => s.deviceId)).toEqual([5])
  })

  it('does not mutate the input array', () => {
    const slots: ProfileSlot[] = [
      slot({ deviceId: 5, profile: 'low', sourceCamStreamId: 'native:sub' }),
      slot({ deviceId: 5, profile: 'high', sourceCamStreamId: 'native:main' }),
    ]
    const before = slots.map((s) => s.profile)
    selectAssignedProfileSlots(slots)
    expect(slots.map((s) => s.profile)).toEqual(before)
  })
})
