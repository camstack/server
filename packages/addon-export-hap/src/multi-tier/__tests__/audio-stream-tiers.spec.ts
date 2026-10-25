/**
 * The `Supported Audio Stream Tiers` TLV8 (0x8044), checked by DECODING it.
 *
 * This characteristic is REQUIRED by `camera-multi-tier-rtp-stream-management`,
 * and it is not the WebRTC service's audio characteristic — that one is 0x805A
 * and belongs to a different service. Getting the two confused costs a service
 * the controller reads and abandons, with no error anywhere.
 *
 * The values restated here come from the guide (Developer Preview, 2026-06-03,
 * § 4.4 and § 2) and are written out rather than imported so that a change to
 * the encoder's own constants cannot quietly agree with itself:
 *
 *  - codec `3` is Opus, and it is the ONLY value this revision defines
 *  - packet time MUST be 20 ms, channels MUST be 1, and EXACTLY ONE tier is
 *    allowed
 *  - transmission is always 48 kHz with Opus even when capture is 16 or 24 kHz,
 *    "which is what should be reported by the characteristic"
 */
import { decode, decodeWithLists } from '@homebridge/hap-nodejs'
import { describe, expect, it } from 'vitest'

import { at, field, repeated } from './tlv-assert.js'
import {
  AudioSampleRate,
  AudioTierBitDepth,
  encodeAudioStreamConfiguration,
  opusTierForCapture,
  TierAudioCodec,
} from '../audio-stream-tiers.js'

describe('encodeAudioStreamConfiguration', () => {
  it('round-trips the codec, payload type and the single tier', () => {
    const bytes = encodeAudioStreamConfiguration({
      codec: TierAudioCodec.OPUS,
      payloadType: 110,
      tiers: [
        {
          identifier: 1,
          targetAverageBitrateBps: 24000,
          sampleRate: AudioSampleRate.RATE_48_KHZ,
          bitDepth: AudioTierBitDepth.BITS_16,
          packetTimeMs: 20,
          channels: 1,
        },
      ],
    })

    const top = decodeWithLists(bytes)
    expect((field(top, 1) as Buffer).readUInt8(0)).toBe(3)
    expect((field(top, 2) as Buffer).readUInt8(0)).toBe(110)

    const tierBlobs = repeated(top['3'], 3)
    expect(tierBlobs).toHaveLength(1)

    const tier = decode(at(tierBlobs, 0) as Buffer)
    expect(field(tier, 1).readUInt32LE(0)).toBe(1)
    expect(field(tier, 2).readUInt32LE(0)).toBe(24000)
    expect(field(tier, 3).readUInt8(0)).toBe(4)
    expect(field(tier, 4).readUInt8(0)).toBe(2)
    expect(field(tier, 5).readUInt8(0)).toBe(20)
    expect(field(tier, 6).readUInt8(0)).toBe(1)
  })

  it('refuses more than one tier, which this revision does not allow', () => {
    const tier = {
      identifier: 1,
      targetAverageBitrateBps: 24000,
      sampleRate: AudioSampleRate.RATE_48_KHZ,
      bitDepth: AudioTierBitDepth.BITS_16,
      packetTimeMs: 20,
      channels: 1,
    }
    expect(() =>
      encodeAudioStreamConfiguration({
        codec: TierAudioCodec.OPUS,
        payloadType: 110,
        tiers: [tier, { ...tier, identifier: 2 }],
      }),
    ).toThrow(/exactly one/i)
  })
})

describe('opusTierForCapture', () => {
  /**
   * The capture rate is 16 or 24 kHz; the REPORTED rate is 48 kHz regardless,
   * because that is Opus's transmission rate and the guide says the
   * characteristic carries the transmission rate.
   */
  it('reports 48 kHz whatever the capture rate is', () => {
    expect(opusTierForCapture(16000).sampleRate).toBe(AudioSampleRate.RATE_48_KHZ)
    expect(opusTierForCapture(24000).sampleRate).toBe(AudioSampleRate.RATE_48_KHZ)
  })

  it('pins the two values the revision fixes', () => {
    const tier = opusTierForCapture(16000)
    expect(tier.packetTimeMs).toBe(20)
    expect(tier.channels).toBe(1)
  })
})
