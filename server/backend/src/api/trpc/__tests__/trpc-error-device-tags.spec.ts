/**
 * A tRPC error line about a camera has to say WHICH camera.
 *
 * The 2026-08-29 intercom refusals logged code, path, principal and message and
 * no `deviceId`, so "is talk-back broken fleet-wide or on the doorbell?" could
 * not be answered from the log at all — the fleet is 30 cameras and the answer
 * decides whether you look at the auth gate or at one camera's firmware.
 *
 * The tag is derived from the codegen'd selector table, not from a hand-listed
 * set of paths, so these cases are really asserting that the derivation holds
 * for each input shape the table describes.
 */
import { describe, expect, it } from 'vitest'
import { trpcErrorDeviceTags } from '../trpc-error-device-tags.js'

describe('trpcErrorDeviceTags', () => {
  it('names the camera behind a refused intercom call', () => {
    expect(trpcErrorDeviceTags('intercom.startSession', { deviceId: 102 })).toEqual({
      deviceId: 102,
    })
  })

  it('covers every intercom method — a refusal anywhere in the talk flow is per-camera', () => {
    for (const method of [
      'startSession',
      'handleAnswer',
      'stopSession',
      'startTalkSession',
      'pushTalkAudio',
      'endTalkSession',
    ]) {
      expect(
        trpcErrorDeviceTags(`intercom.${method}`, { deviceId: 102 }),
        `intercom.${method}`,
      ).toEqual({ deviceId: 102 })
    }
  })

  it('tags the first device and the count for a batch call', () => {
    // `deviceCount` is what stops a reader taking a batch line for a single
    // camera's failure.
    expect(
      trpcErrorDeviceTags('deviceManager.getBindingsBatch', { deviceIds: [101, 102, 620] }),
    ).toEqual({ deviceId: 101, deviceCount: 3 })
  })

  it('tags nothing for a system-scope path — a call about no device is not device 0', () => {
    expect(trpcErrorDeviceTags('system.getInfo', {})).toEqual({})
  })

  it('tags nothing when the path is unknown or absent', () => {
    expect(trpcErrorDeviceTags(undefined, { deviceId: 102 })).toEqual({})
    expect(trpcErrorDeviceTags('nope.notAPath', { deviceId: 102 })).toEqual({})
  })

  it('tags nothing when the input carries no usable id', () => {
    // An optional `deviceId` that was not sent, a null, and a non-numeric each
    // reference no device — a placeholder id here would be a lie in a log.
    expect(trpcErrorDeviceTags('intercom.startSession', {})).toEqual({})
    expect(trpcErrorDeviceTags('intercom.startSession', { deviceId: null })).toEqual({})
    expect(trpcErrorDeviceTags('intercom.startSession', { deviceId: 'x' })).toEqual({})
    expect(trpcErrorDeviceTags('intercom.startSession', undefined)).toEqual({})
  })
})
