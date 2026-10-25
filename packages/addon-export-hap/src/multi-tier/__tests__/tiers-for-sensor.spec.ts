/**
 * Which tiers a camera is allowed to claim.
 *
 * The rule is that a tier is DERIVED from the sensor, never assumed: a 1080p
 * camera that advertises 4K is telling the controller it can do something it
 * cannot, and the failure surfaces as a stream that never starts rather than as
 * a refusal anyone can read.
 */
import { decode, decodeWithLists } from '@homebridge/hap-nodejs'
import { describe, expect, it } from 'vitest'

import { peakBitrateKbpsFor, tiersForSensor } from '../tiers-for-sensor.js'
import {
  encodeVideoStreamConfiguration,
  TierQuality,
  TierVideoCodec,
} from '../video-stream-tiers.js'

describe('tiersForSensor', () => {
  it('offers 4K only to a sensor that has it', () => {
    const t = tiersForSensor(3840, 2160)
    expect(t[0]?.width).toBe(3840)
    expect(t[0]?.targetAverageBitrateKbps).toBe(4500)
  })

  it('offers 2K to a 2K sensor, and never 4K', () => {
    const t = tiersForSensor(2560, 1440)
    expect(t.map((x) => x.width)).not.toContain(3840)
    expect(t[0]?.width).toBe(2560)
  })

  it('a 1080p camera claims 1080p as its HIGH, not as a medium of something bigger', () => {
    // Quality is relative to what this camera has. Labelling its best stream
    // MEDIUM would make the controller look for a better one that is not there.
    const t = tiersForSensor(1920, 1080)
    expect(t[0]?.width).toBe(1920)
    expect(t[0]?.quality).toBe(TierQuality.HIGH)
  })

  it('never claims HIGHEST — we cannot prove we serve 4K and 2K at once', () => {
    // The guide reserves it for exactly that, and says a camera that cannot do
    // both should not use the value.
    for (const [w, h] of [
      [3840, 2160],
      [2560, 1440],
      [1920, 1080],
    ] as const) {
      expect(tiersForSensor(w, h).map((t) => t.quality)).not.toContain(TierQuality.HIGHEST)
    }
  })

  it('always ends with a LOW tier — the guide wants three encodings per sensor', () => {
    expect(tiersForSensor(3840, 2160).at(-1)?.quality).toBe(TierQuality.LOW)
    expect(tiersForSensor(1920, 1080).at(-1)?.quality).toBe(TierQuality.LOW)
  })

  it('gives every tier a distinct identifier — it is how a controller selects one', () => {
    const ids = tiersForSensor(3840, 2160).map((t) => t.identifier)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('what a 4K camera actually advertises on the wire', () => {
  it('announces HEVC and carries every tier as its own TLV', () => {
    const lists = decodeWithLists(
      encodeVideoStreamConfiguration({
        codec: TierVideoCodec.H265,
        payloadType: 96,
        tiers: tiersForSensor(3840, 2160),
      }),
    )
    expect((lists[0x01] as Buffer).readUInt8(0)).toBe(TierVideoCodec.H265)
    const tiers = lists[0x03] as Buffer[]
    expect(tiers.length).toBe(3)
    expect(decode(tiers[0] as Buffer)[0x04]?.readUInt16LE(0)).toBe(3840)
  })
})

describe('the guide’s Minimum Requirements table, restated', () => {
  /**
   * § 2: *"The accessory must support at least three concurrent video encodings
   * on each sensor"*, and the 16:9 table names them exactly:
   *
   *   4K camera    → 3840x2160, 1920x1080, 640x360
   *   2K camera    → 2560x1440, 1920x1080, 640x360
   *   1080p camera → 1920x1080, 1280x720,  640x360
   *
   * The 1080p row is the one that was wrong: it produced two tiers, because
   * the medium stream of a 1080p camera is 720p and nothing emitted it. A
   * controller reading two tiers is reading a camera that does not meet the
   * minimum.
   */
  it.each([
    [3840, 2160, [3840, 1920, 640]],
    [2560, 1440, [2560, 1920, 640]],
    [1920, 1080, [1920, 1280, 640]],
  ])('a %ix%i sensor offers exactly the three widths the table names', (w, h, widths) => {
    expect(tiersForSensor(w, h).map((t) => t.width)).toEqual(widths)
  })

  it('never offers fewer than three encodings, whatever the sensor', () => {
    for (const [w, h] of [
      [3840, 2160],
      [2560, 1440],
      [2304, 1296],
      [1920, 1080],
      [1280, 720],
      [640, 360],
    ] as const) {
      expect(tiersForSensor(w, h).length, `${w}x${h}`).toBeGreaterThanOrEqual(3)
    }
  })

  /**
   * § 2: *"maximum bitrates should not be exceeded"*, with the table giving a
   * maximum per resolution. A peak computed as average × 1.1 overshoots three
   * of the four rows — 1080p would claim 1870 against a ceiling of 1800.
   */
  it.each([
    [3840, 4500, 5000],
    [2560, 2800, 3000],
    [1920, 1700, 1800],
    [1280, 768, 800],
    [640, 180, 190],
  ])('a %ipx-wide tier targets %i kbps and peaks no higher than %i', (width, avg, max) => {
    const all = [
      ...tiersForSensor(3840, 2160),
      ...tiersForSensor(2560, 1440),
      ...tiersForSensor(1920, 1080),
    ]
    const tier = all.find((t) => t.width === width)
    expect(tier, `no tier of width ${width}`).toBeDefined()
    expect(tier?.targetAverageBitrateKbps).toBe(avg)
    expect(peakBitrateKbpsFor(width)).toBe(max)
  })
})
