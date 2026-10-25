import { describe, expect, it } from 'vitest'
import {
  DeviceOverridesMapSchema,
  parseDeviceOverride,
  serializeDeviceOverride,
} from '../stream-broker/stream-broker-manager.js'

describe('deviceOverrides persistence (derivedStreams survives round-trip)', () => {
  it('DeviceOverridesMapSchema parses + preserves a derivedStreams entry', () => {
    const blob = {
      '97': {
        derivedStreams: {
          test: {
            source: { kind: 'camStream', camStreamId: 'native:main' },
            encodeProfile: { video: { codec: 'h264' }, audio: 'passthrough' },
            rtspEnabled: true,
          },
        },
        webrtcDebug: true,
      },
    }
    const parsed = DeviceOverridesMapSchema.parse(blob)
    expect(parsed['97']!.derivedStreams!['test']!.source).toEqual({
      kind: 'camStream',
      camStreamId: 'native:main',
    })
    expect(parsed['97']!.derivedStreams!['test']!.rtspEnabled).toBe(true)
    expect(parsed['97']!.webrtcDebug).toBe(true)
  })

  it('tolerates a legacy blob without derivedStreams', () => {
    const parsed = DeviceOverridesMapSchema.parse({ '5': { webrtcDebug: false } })
    expect(parsed['5']!.derivedStreams).toBeUndefined()
  })

  it('parses + preserves a per-source-stream hwaccel override', () => {
    const parsed = DeviceOverridesMapSchema.parse({
      '99': { hwaccel: { 'native:main': 'copy', 'native:sub': 'auto' } },
    })
    expect(parsed['99']!.hwaccel!['native:main']).toBe('copy')
    expect(parsed['99']!.hwaccel!['native:sub']).toBe('auto')
  })

  it('rejects an invalid hwaccel value', () => {
    expect(() =>
      DeviceOverridesMapSchema.parse({ '99': { hwaccel: { 'native:main': 'gpu-magic' } } }),
    ).toThrow()
  })

  it('tolerates a legacy blob without hwaccel', () => {
    const parsed = DeviceOverridesMapSchema.parse({ '5': { webrtcDebug: false } })
    expect(parsed['5']!.hwaccel).toBeUndefined()
  })

  it('round-trips a per-camStream sourceParser map', () => {
    const raw = JSON.stringify({ sourceParser: { 'native:main': 'ffmpeg-udp' } })
    const parsed = parseDeviceOverride(raw)
    expect(parsed.sourceParser).toEqual({ 'native:main': 'ffmpeg-udp' })
    expect(serializeDeviceOverride(parsed)).toContain('ffmpeg-udp')
  })

  it('round-trips a per-camStream sourceParserArgs map', () => {
    const raw = JSON.stringify({
      sourceParserArgs: {
        'native:main': {
          inputArgs: ['-use_wallclock_as_timestamps 1'],
          outputArgs: ['-avoid_negative_ts make_zero'],
        },
      },
    })
    const parsed = parseDeviceOverride(raw)
    expect(parsed.sourceParserArgs!['native:main']!.inputArgs).toEqual([
      '-use_wallclock_as_timestamps 1',
    ])
    expect(parsed.sourceParserArgs!['native:main']!.outputArgs).toEqual([
      '-avoid_negative_ts make_zero',
    ])
    expect(serializeDeviceOverride(parsed)).toContain('-avoid_negative_ts make_zero')
  })

  it('tolerates a partial sourceParserArgs entry (inputArgs only)', () => {
    const parsed = DeviceOverridesMapSchema.parse({
      '42': { sourceParserArgs: { 'native:sub': { inputArgs: ['-fflags +genpts+igndts'] } } },
    })
    expect(parsed['42']!.sourceParserArgs!['native:sub']!.inputArgs).toEqual([
      '-fflags +genpts+igndts',
    ])
    expect(parsed['42']!.sourceParserArgs!['native:sub']!.outputArgs).toBeUndefined()
  })

  it('drops a legacy preBufferSecOverride on parse (field removed)', () => {
    const raw = JSON.stringify({ preBufferSecOverride: 5, webrtcDebug: true })
    const parsed = parseDeviceOverride(raw)
    expect('preBufferSecOverride' in parsed).toBe(false)
    expect(parsed.webrtcDebug).toBe(true)
  })

  it('persists an UNCONFIGURED derived stream (absent source placeholder)', () => {
    // The UI creates a derived stream with no source until the user picks
    // one. That placeholder must round-trip so it survives a restart (the
    // original "test" stream the user lost had no source). Making `source`
    // required would reject the whole device-overrides blob on persist —
    // blocking EVERY device's overrides, not just this one.
    const blob = {
      '7': {
        derivedStreams: {
          test: {
            encodeProfile: { video: { codec: 'h264' }, audio: 'passthrough' },
          },
        },
      },
    }
    const parsed = DeviceOverridesMapSchema.parse(blob)
    expect(parsed['7']!.derivedStreams!['test']!.source).toBeUndefined()
  })

  it('round-trips a derived stream with a profile source', () => {
    const raw = JSON.stringify({
      derivedStreams: {
        'derived:low': {
          source: { kind: 'profile', profile: 'mid' },
          encodeProfile: {
            video: { codec: 'h264', width: 640, height: 360 },
            audio: 'passthrough',
          },
        },
      },
    })
    const parsed = parseDeviceOverride(raw)
    expect(parsed.derivedStreams?.['derived:low']?.source).toEqual({
      kind: 'profile',
      profile: 'mid',
    })
  })
})
