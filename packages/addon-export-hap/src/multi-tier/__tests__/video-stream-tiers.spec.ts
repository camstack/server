/**
 * The tier TLV, checked by DECODING it — not by comparing bytes to bytes.
 *
 * A byte-for-byte fixture pins whatever the encoder happens to emit, including
 * its mistakes: it would have been just as green with the tiers concatenated
 * into one blob, which is the single most likely way to get a repeated HAP
 * field wrong. Decoding asks the question the controller will ask.
 */
import { decode, decodeWithLists } from '@homebridge/hap-nodejs'
import { describe, expect, it } from 'vitest'

import {
  encodeVideoStreamConfiguration,
  encodeVideoStreamTier,
  TierQuality,
  TierVideoCodec,
  type VideoStreamTier,
} from '../video-stream-tiers.js'

/** 4K at 30 fps, at the guide's own target bitrate. */
const TIER_4K: VideoStreamTier = {
  identifier: 1,
  quality: TierQuality.HIGH,
  targetAverageBitrateKbps: 4500,
  width: 3840,
  height: 2160,
  frameRate: 30,
}

const TIER_1080: VideoStreamTier = {
  identifier: 2,
  quality: TierQuality.MEDIUM,
  targetAverageBitrateKbps: 1700,
  width: 1920,
  height: 1080,
  frameRate: 30,
}

describe('encodeVideoStreamTier', () => {
  it('round-trips every field of a 4K tier', () => {
    const t = decode(encodeVideoStreamTier(TIER_4K))
    expect(t[0x01]?.readUInt32LE(0)).toBe(1)
    expect(t[0x02]?.readUInt8(0)).toBe(TierQuality.HIGH)
    expect(t[0x03]?.readUInt32LE(0)).toBe(4500)
    expect(t[0x04]?.readUInt16LE(0)).toBe(3840)
    expect(t[0x05]?.readUInt16LE(0)).toBe(2160)
    expect(t[0x06]?.readUInt8(0)).toBe(30)
  })

  it('writes 2160 as a uint16 — it does not fit a byte', () => {
    // 2160 & 0xff is 112. A width or height truncated to one byte decodes as a
    // plausible small number rather than as an error, which is the failure that
    // would look like HomeKit "just picking a low resolution".
    const t = decode(encodeVideoStreamTier(TIER_4K))
    expect(t[0x05]?.length).toBe(2)
  })
})

describe('encodeVideoStreamConfiguration', () => {
  it('announces HEVC with the NEW numbering, where H.264 is 1 and H.265 is 2', () => {
    // The library's own `VideoCodecType.H264` is 0. Emitting that would tell the
    // controller a codec that, under this specification, does not exist.
    const c = decode(
      encodeVideoStreamConfiguration({
        codec: TierVideoCodec.H265,
        payloadType: 99,
        tiers: [TIER_4K],
      }),
    )
    expect(c[0x01]?.readUInt8(0)).toBe(2)
    expect(c[0x02]?.readUInt8(0)).toBe(99)
  })

  it('emits the tiers as a REPEATED field, one TLV each', () => {
    // The whole point. A single blob holding both tiers decodes as one tier
    // with garbage in it, and the controller would offer a camera one stream.
    const lists = decodeWithLists(
      encodeVideoStreamConfiguration({
        codec: TierVideoCodec.H265,
        payloadType: 99,
        tiers: [TIER_4K, TIER_1080],
      }),
    )
    const tiers = lists[0x03]
    expect(Array.isArray(tiers)).toBe(true)
    expect((tiers as Buffer[]).length).toBe(2)
  })

  it('keeps each tier readable after the repetition', () => {
    const lists = decodeWithLists(
      encodeVideoStreamConfiguration({
        codec: TierVideoCodec.H265,
        payloadType: 99,
        tiers: [TIER_4K, TIER_1080],
      }),
    )
    const tiers = lists[0x03] as Buffer[]
    const first = tiers[0]
    const second = tiers[1]
    expect(first, 'the first tier').toBeDefined()
    expect(second, 'the second tier').toBeDefined()
    expect(decode(first as Buffer)[0x04]?.readUInt16LE(0)).toBe(3840)
    expect(decode(second as Buffer)[0x04]?.readUInt16LE(0)).toBe(1920)
  })

  it('carries a single tier just as happily', () => {
    const lists = decodeWithLists(
      encodeVideoStreamConfiguration({
        codec: TierVideoCodec.H264,
        payloadType: 99,
        tiers: [TIER_1080],
      }),
    )
    const tiers = lists[0x03]
    const one = Array.isArray(tiers) ? (tiers[0] as Buffer) : (tiers as Buffer)
    expect(decode(one)[0x04]?.readUInt16LE(0)).toBe(1920)
  })
})
