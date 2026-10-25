/**
 * Key-frame detection for HEVC, beside the H.264 one.
 *
 * The H.264 detector reads NAL type from the low 5 bits of a ONE-byte header
 * (RFC 6184). HEVC's header is TWO bytes and the type is bits 1..6 of the
 * first (RFC 7798), so the H.264 parser applied to an HEVC packet reads a type
 * that means nothing and answers "no key frame" forever.
 *
 * Nothing on the media path gates on this — it is telemetry. That is exactly
 * why it matters: `videoKeyframes` and `msToFirstKeyframe` are the numbers that
 * proved the H.264 slice fix worked (D515), and an HEVC session reporting zero
 * key frames while streaming perfectly has the same shape as that bug.
 *
 * RFC 7798 payload types: 48 is an aggregation packet, 49 a fragmentation unit.
 * An IRAP picture — the HEVC equivalent of an IDR — is NAL type 16 through 23.
 */
import { describe, expect, it } from 'vitest'

import { rtpPacketCarriesKeyframe } from '../h264-idr.js'

/** A minimal 12-byte RTP header followed by `payload`. */
function rtpPacket(payload: readonly number[]): Buffer {
  return Buffer.concat([
    Buffer.from([0x80, 0x60, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.from(payload),
  ])
}

/** HEVC NAL header for `type`, layer 0, tid 1. */
function hevcNalHeader(type: number): readonly number[] {
  return [(type << 1) & 0x7e, 0x01]
}

describe('rtpPacketCarriesKeyframe — hevc', () => {
  it.each([
    ['BLA_W_LP', 16],
    ['IDR_W_RADL', 19],
    ['IDR_N_LP', 20],
    ['CRA_NUT', 21],
  ])('sees a single-nal %s as a key frame', (_name, type) => {
    expect(rtpPacketCarriesKeyframe(rtpPacket([...hevcNalHeader(type), 0xaf]), 'h265')).toBe(true)
  })

  it.each([
    ['TRAIL_R', 1],
    ['VPS', 32],
    ['SPS', 33],
    ['PPS', 34],
  ])('does not see %s as a key frame', (_name, type) => {
    expect(rtpPacketCarriesKeyframe(rtpPacket([...hevcNalHeader(type), 0xaf]), 'h265')).toBe(false)
  })

  /**
   * A 4K IRAP spans dozens of fragments. Counting each would report one key
   * frame per packet — the H.264 detector learned this already and the HEVC
   * one must not relearn it.
   */
  it('counts only the FIRST fragment of a fragmented IRAP', () => {
    const start = rtpPacket([...hevcNalHeader(49), 0x80 | 19, 0xaf])
    const middle = rtpPacket([...hevcNalHeader(49), 19, 0xaf])
    expect(rtpPacketCarriesKeyframe(start, 'h265')).toBe(true)
    expect(rtpPacketCarriesKeyframe(middle, 'h265')).toBe(false)
  })

  it('finds an IRAP inside an aggregation packet', () => {
    const nal = [...hevcNalHeader(19), 0xaf]
    const packet = rtpPacket([...hevcNalHeader(48), 0x00, nal.length, ...nal])
    expect(rtpPacketCarriesKeyframe(packet, 'h265')).toBe(true)
  })

  /**
   * The parser runs on every forwarded packet. One that throws would take the
   * media path down over telemetry.
   */
  it('never throws on a truncated packet', () => {
    for (const length of [0, 1, 11, 12, 13]) {
      expect(() => rtpPacketCarriesKeyframe(Buffer.alloc(length), 'h265')).not.toThrow()
    }
  })
})

describe('rtpPacketCarriesKeyframe — h264 is unchanged', () => {
  it('still sees a single-nal IDR', () => {
    expect(rtpPacketCarriesKeyframe(rtpPacket([0x65, 0xaf]), 'h264')).toBe(true)
  })

  it('does not read an h264 packet with the hevc rules', () => {
    // 0x65 as HEVC would be type (0x65 >> 1) & 0x3f = 50 — not an IRAP.
    expect(rtpPacketCarriesKeyframe(rtpPacket([0x65, 0xaf]), 'h265')).toBe(false)
  })
})
