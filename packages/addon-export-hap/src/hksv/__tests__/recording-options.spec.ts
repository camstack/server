/**
 * The advertisement. Every assertion here is "we do not promise what the sink
 * cannot produce" — the rule D50 was written from.
 */
import { describe, expect, it } from 'vitest'

import {
  buildRecordingOptions,
  deriveFragmentLengthMs,
  HKSV_ADVERTISED_FRAME_RATES,
  HKSV_FRAGMENT_LENGTHS_MS,
  HKSV_PREBUFFER_MS,
  normaliseAdvertisedFps,
} from '../recording-options.js'

describe('deriveFragmentLengthMs', () => {
  it('advertises the SHORTEST length that covers the camera key-frame interval', () => {
    // A camera cutting fragments every 8 s cannot honour a 4 s advertisement:
    // HKSV requires every fragment to be no LONGER than the selected length,
    // and on a copy branch there is no encoder to shorten it with.
    expect(deriveFragmentLengthMs(4_000)).toBe(4_000)
    expect(deriveFragmentLengthMs(2_000)).toBe(4_000)
    expect(deriveFragmentLengthMs(4_001)).toBe(8_000)
    expect(deriveFragmentLengthMs(8_000)).toBe(8_000)
  })

  it('refuses a camera whose key-frame interval exceeds every offered length', () => {
    expect(deriveFragmentLengthMs(12_000)).toBeNull()
  })

  it('guesses the shortest when the camera reports no GOP — and it IS a guess', () => {
    // Most non-Hikvision providers do not bind `stream-params`. 4 s is the
    // near-universal default, and the delegate warns when reality disagrees.
    expect(deriveFragmentLengthMs(undefined)).toBe(HKSV_FRAGMENT_LENGTHS_MS[0])
    expect(deriveFragmentLengthMs(0)).toBe(HKSV_FRAGMENT_LENGTHS_MS[0])
  })
})

describe('normaliseAdvertisedFps', () => {
  it('quantises a MEASURED rate onto the rates HomeKit cameras advertise', () => {
    // 101's 720p slot measures 10 fps. `[1280, 720, 10]` is a frame rate no
    // shipping HKSV camera offers, and the controller picks its recording
    // configuration out of exactly this list.
    expect(normaliseAdvertisedFps(10)).toBe(15)
    expect(normaliseAdvertisedFps(25)).toBe(24)
    expect(normaliseAdvertisedFps(29.97)).toBe(30)
    expect(normaliseAdvertisedFps(60)).toBe(30)
  })

  it('never leaves the offered set, whatever the probe returns', () => {
    for (const measured of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.4, 1_000]) {
      expect(HKSV_ADVERTISED_FRAME_RATES).toContain(normaliseAdvertisedFps(measured))
    }
  })

  it('is STABLE across probe drift — the whole selection depends on it', () => {
    // hap-nodejs hashes the supported configuration and DISCARDS the
    // controller's stored `selectedConfiguration` when that hash changes
    // (`deserialize: discarding saved selectedConfiguration`). The advertised
    // resolution carries a measured rate, so an advertisement that tracked the
    // probe exactly would un-configure HKSV on any restart where the
    // measurement moved by one frame — camera 104 already probed 9 then 10
    // across two restarts on 2026-08-07/08.
    const drift = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
    const advertised = new Set(drift.map((fps) => normaliseAdvertisedFps(fps)))
    expect(advertised).toEqual(new Set([15]))

    const fastDrift = [23, 24, 25, 26]
    expect(new Set(fastDrift.map((fps) => normaliseAdvertisedFps(fps)))).toEqual(new Set([24]))
  })
})

describe('buildRecordingOptions', () => {
  const options = buildRecordingOptions({
    width: 1280,
    height: 720,
    fps: 10,
    fragmentLengthMs: 4_000,
  })

  it('advertises exactly ONE resolution — the slot the child will actually pull', () => {
    // HAP documents 1920x1080 and 1280x720 as "required to be supported".
    // Listing both when the source is one of them is D50 in miniature: iOS
    // selects a configuration the copy branch then cannot deliver.
    // The rate is QUANTISED — see `normaliseAdvertisedFps`.
    expect(options.video.resolutions).toEqual([[1280, 720, 15]])
  })

  it('tracks the camera rate rather than pinning one constant', () => {
    const fast = buildRecordingOptions({
      width: 1920,
      height: 1080,
      fps: 25,
      fragmentLengthMs: 4_000,
    })
    expect(fast.video.resolutions).toEqual([[1920, 1080, 24]])
  })

  it('advertises the fragment length it was given', () => {
    const container = options.mediaContainerConfiguration
    expect(Array.isArray(container) ? container[0]?.fragmentLength : container.fragmentLength).toBe(
      4_000,
    )
  })

  it('promises a prebuffer the plane is sized to hold', () => {
    // The ring window is derived from this constant, so the two cannot drift.
    expect(options.prebufferLength).toBe(HKSV_PREBUFFER_MS)
    expect(options.prebufferLength).toBeGreaterThanOrEqual(4_000)
  })

  it('advertises AAC only — an fMP4 fragment has no plane to graft an SDP onto', () => {
    const codecs = Array.isArray(options.audio.codecs)
      ? options.audio.codecs
      : [options.audio.codecs]
    expect(codecs).toHaveLength(1)
    // AAC_LC === 0. The recorder's libopus can never serve HKSV (D80).
    expect(codecs[0]?.type).toBe(0)
    expect(codecs[0]?.audioChannels).toBe(1)
  })

  it('advertises every H.264 profile and level — a COPY passes through whatever the camera made', () => {
    // Narrowing to the camera's current encoder setting would withdraw
    // recording every time an operator changed it.
    expect(options.video.parameters.profiles).toHaveLength(3)
    expect(options.video.parameters.levels).toHaveLength(3)
  })
})
