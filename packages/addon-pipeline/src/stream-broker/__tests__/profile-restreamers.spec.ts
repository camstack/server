import { describe, it, expect } from 'vitest'
import {
  computeProfileRestreamerActions,
  buildProfileRtspEntries,
} from '../stream-broker/profile-restreamers.js'

const DEVICE = 15

describe('computeProfileRestreamerActions', () => {
  it('registers a profile token when a profile is assigned to a live source', () => {
    const actions = computeProfileRestreamerActions({
      deviceId: DEVICE,
      assignmentMap: { high: 'native:main' },
      sourceBrokerExists: () => true,
      currentBindings: new Map(),
    })
    expect(actions.register).toEqual([{ profileBrokerId: '15/high', camStreamId: 'native:main' }])
    expect(actions.unregister).toEqual([])
  })

  it('skips a profile whose assigned source has no live broker', () => {
    const actions = computeProfileRestreamerActions({
      deviceId: DEVICE,
      assignmentMap: { high: 'native:main' },
      sourceBrokerExists: () => false,
      currentBindings: new Map(),
    })
    expect(actions.register).toEqual([])
    expect(actions.unregister).toEqual([])
  })

  it('no-op when the binding already matches (stable token)', () => {
    const actions = computeProfileRestreamerActions({
      deviceId: DEVICE,
      assignmentMap: { high: 'native:main' },
      sourceBrokerExists: () => true,
      currentBindings: new Map([['15/high', '15/native:main']]),
    })
    expect(actions.register).toEqual([])
    expect(actions.unregister).toEqual([])
  })

  it('re-points (unregister + register) when a profile is reassigned to a new source', () => {
    const actions = computeProfileRestreamerActions({
      deviceId: DEVICE,
      assignmentMap: { high: 'native:ext' },
      sourceBrokerExists: () => true,
      currentBindings: new Map([['15/high', '15/native:main']]),
    })
    expect(actions.unregister).toEqual(['15/high'])
    expect(actions.register).toEqual([{ profileBrokerId: '15/high', camStreamId: 'native:ext' }])
  })

  it('unregisters a profile token when the profile becomes unassigned', () => {
    const actions = computeProfileRestreamerActions({
      deviceId: DEVICE,
      assignmentMap: {},
      sourceBrokerExists: () => true,
      currentBindings: new Map([['15/high', '15/native:main']]),
    })
    expect(actions.unregister).toEqual(['15/high'])
    expect(actions.register).toEqual([])
  })

  it('handles all three profiles at once: re-points one, leaves the others untouched', () => {
    const actions = computeProfileRestreamerActions({
      deviceId: DEVICE,
      assignmentMap: { high: 'native:main', mid: 'native:ext', low: 'native:sub' },
      sourceBrokerExists: () => true,
      currentBindings: new Map([
        ['15/high', '15/native:main'], // unchanged → no-op
        ['15/mid', '15/native:old'], // reassigned → re-point
        // low not yet bound → fresh register
      ]),
    })
    expect(actions.unregister).toEqual(['15/mid'])
    expect(actions.register).toEqual([
      { profileBrokerId: '15/mid', camStreamId: 'native:ext' },
      { profileBrokerId: '15/low', camStreamId: 'native:sub' },
    ])
  })
})

describe('buildProfileRtspEntries', () => {
  const entryFor = (profileBrokerId: string) => ({
    url: `rtsp://127.0.0.1:8554/tok-${profileBrokerId}`,
    mutedUrl: `rtsp://127.0.0.1:8554/tok-${profileBrokerId}/muted`,
    enabled: true,
  })

  it('maps each assigned profile to its profile-keyed restream + source meta', () => {
    const out = buildProfileRtspEntries({
      deviceId: 15,
      assignmentMap: { high: 'native:main', low: 'native:sub' },
      resolveEntry: (id) => entryFor(id),
      resolveMeta: (camStreamId) =>
        camStreamId === 'native:main'
          ? { codec: 'h265', resolution: { width: 3840, height: 2160 } }
          : { codec: 'h264', resolution: { width: 640, height: 360 } },
    })
    expect(out).toEqual([
      {
        profile: 'high',
        brokerId: '15/high',
        url: 'rtsp://127.0.0.1:8554/tok-15/high',
        mutedUrl: 'rtsp://127.0.0.1:8554/tok-15/high/muted',
        enabled: true,
        codec: 'h265',
        resolution: { width: 3840, height: 2160 },
      },
      {
        profile: 'low',
        brokerId: '15/low',
        url: 'rtsp://127.0.0.1:8554/tok-15/low',
        mutedUrl: 'rtsp://127.0.0.1:8554/tok-15/low/muted',
        enabled: true,
        codec: 'h264',
        resolution: { width: 640, height: 360 },
      },
    ])
  })

  it('skips a profile whose restream entry is not mintable', () => {
    const out = buildProfileRtspEntries({
      deviceId: 15,
      assignmentMap: { high: 'native:main', mid: 'native:ext' },
      resolveEntry: (id) => (id === '15/high' ? entryFor(id) : null),
      resolveMeta: () => ({}),
    })
    expect(out.map((e) => e.profile)).toEqual(['high'])
  })

  it('returns [] for a device with no assigned profiles', () => {
    const out = buildProfileRtspEntries({
      deviceId: 99,
      assignmentMap: {},
      resolveEntry: () => entryFor('x'),
      resolveMeta: () => ({}),
    })
    expect(out).toEqual([])
  })

  it('omits codec/resolution when the source advertises neither', () => {
    const out = buildProfileRtspEntries({
      deviceId: 15,
      assignmentMap: { mid: 'native:ext' },
      resolveEntry: (id) => entryFor(id),
      resolveMeta: () => ({}),
    })
    expect(out[0]).toEqual({
      profile: 'mid',
      brokerId: '15/mid',
      url: 'rtsp://127.0.0.1:8554/tok-15/mid',
      mutedUrl: 'rtsp://127.0.0.1:8554/tok-15/mid/muted',
      enabled: true,
    })
  })
})
