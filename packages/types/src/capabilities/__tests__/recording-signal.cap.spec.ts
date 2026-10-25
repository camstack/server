import { describe, expect, it } from 'vitest'
import {
  RecordingSignalRuntimeStateSchema,
  RecordingSignalStatusSchema,
  recordingSignalCapability,
} from '../recording-signal.cap.js'
import { CamStreamDescriptorSchema } from '../stream-catalog.cap.js'

describe('recording-signal — a camera-owned LEVEL the recorder follows', () => {
  it('the status is a level with its transition clock', () => {
    expect(
      RecordingSignalStatusSchema.parse({ active: true, reason: 'cleaning', lastChangedAt: 10 }),
    ).toEqual({ active: true, reason: 'cleaning', lastChangedAt: 10 })
    expect(RecordingSignalStatusSchema.safeParse({ active: 'yes', reason: '' }).success).toBe(false)
  })

  it('the runtime slice carries lastFetchedAt, and the cold-start empty status parses', () => {
    expect(
      RecordingSignalRuntimeStateSchema.safeParse({
        ...recordingSignalCapability.status.empty,
        lastFetchedAt: 0,
      }).success,
    ).toBe(true)
    expect(
      RecordingSignalRuntimeStateSchema.safeParse(recordingSignalCapability.status.empty).success,
    ).toBe(false)
  })

  it('is a camera-native, session-durable cap: a restored `active` would be a lie after a restart', () => {
    expect(recordingSignalCapability.scope).toBe('device')
    expect(recordingSignalCapability.deviceNative).toBe(true)
    expect(recordingSignalCapability.durability).toBe('session')
  })
})

describe('CamStreamDescriptor.profileHint — the publisher names the slot its stream IS', () => {
  it('accepts a low hint and rejects an unknown slot', () => {
    const base = { camStreamId: 'live', kind: 'pull-rfc4571' as const, url: 'lazy:rfc4571:live' }
    expect(CamStreamDescriptorSchema.parse({ ...base, profileHint: 'low' }).profileHint).toBe('low')
    expect(CamStreamDescriptorSchema.safeParse({ ...base, profileHint: 'main' }).success).toBe(
      false,
    )
  })
})
