import { describe, expect, it } from 'vitest'
import {
  type DeviceOverride,
  parseDeviceOverride,
  serializeDeviceOverride,
} from '../stream-broker/stream-broker-manager.js'

describe('DeviceOverride.derivedStreams', () => {
  it('round-trips a derivedStreams entry', () => {
    const original: DeviceOverride = {
      derivedStreams: {
        'web-720p': {
          source: { kind: 'camStream', camStreamId: 'native:main' },
          encodeProfile: {
            video: { codec: 'h264', width: 1280, height: 720 },
            audio: 'passthrough',
          },
          preBuffer: { enabled: false, seconds: 0 },
          rtspEnabled: true,
        },
      },
    }
    const round = parseDeviceOverride(serializeDeviceOverride(original))
    expect(round).toEqual(original)
  })

  it('an absent derivedStreams field deserialises cleanly', () => {
    const original: DeviceOverride = { preBuffer: {} }
    const round = parseDeviceOverride(serializeDeviceOverride(original))
    expect(round.derivedStreams).toBeUndefined()
  })

  it('tolerates a derivedStreams entry without a source (unconfigured placeholder)', () => {
    const raw =
      '{"derivedStreams":{"x":{"encodeProfile":{"video":{"codec":"h264"},"audio":"passthrough"}}}}'
    const parsed = parseDeviceOverride(raw)
    expect(parsed.derivedStreams?.['x']?.source).toBeUndefined()
  })

  it('rejects a derivedStreams entry with an invalid source', () => {
    const bad =
      '{"derivedStreams":{"x":{"source":{"kind":"bogus"},"encodeProfile":{"video":{"codec":"h264"},"audio":"passthrough"}}}}'
    expect(() => parseDeviceOverride(bad)).toThrow()
  })
})
