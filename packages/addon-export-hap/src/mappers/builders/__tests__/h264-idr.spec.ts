import { describe, expect, it } from 'vitest'

import { rtpPacketCarriesIdr } from '../h264-idr.js'

/**
 * Build an RTP packet with the given payload. `csrcCount` and `extension`
 * exist because the payload offset is the whole difficulty here: reading NAL
 * type at a fixed offset 12 works on every packet ffmpeg emits today and
 * silently misreads the moment one carries a contributing source or a header
 * extension — and a keyframe counter that reads the wrong byte reports zero
 * keyframes on a session that had them, which is worse than no counter.
 */
function rtp(
  payload: readonly number[],
  opts: { csrcCount?: number; extension?: boolean } = {},
): Buffer {
  const csrcCount = opts.csrcCount ?? 0
  const extension = opts.extension ?? false
  const head = Buffer.alloc(12 + csrcCount * 4)
  head[0] = 0x80 | csrcCount | (extension ? 0x10 : 0)
  head[1] = 99
  if (!extension) return Buffer.concat([head, Buffer.from(payload)])
  // One 4-byte extension word: profile(2) length(2) + 1*4 bytes of data.
  const ext = Buffer.alloc(8)
  ext.writeUInt16BE(0xbede, 0)
  ext.writeUInt16BE(1, 2)
  return Buffer.concat([head, ext, Buffer.from(payload)])
}

describe('rtpPacketCarriesIdr', () => {
  it('detects a single-NAL IDR and ignores a single-NAL non-IDR', () => {
    expect(rtpPacketCarriesIdr(rtp([0x65, 0x88, 0x84]))).toBe(true)
    expect(rtpPacketCarriesIdr(rtp([0x41, 0x9a, 0x00]))).toBe(false)
  })

  it('does NOT count SPS or PPS as a keyframe on their own', () => {
    // `dump_extra` puts these ahead of every IDR. Counting them would double
    // every keyframe and make the interval look half its real length.
    expect(rtpPacketCarriesIdr(rtp([0x67, 0x42, 0xc0]))).toBe(false)
    expect(rtpPacketCarriesIdr(rtp([0x68, 0xce]))).toBe(false)
  })

  it('counts an FU-A IDR ONLY on its start fragment', () => {
    // A 720p IDR spans dozens of fragments. Counting each one would report
    // "40 keyframes" for a single frame and a keyframe interval of ~0 ms.
    const start = rtp([0x7c, 0x85, 0x88])
    const middle = rtp([0x7c, 0x05, 0x88])
    const end = rtp([0x7c, 0x45, 0x88])
    expect(rtpPacketCarriesIdr(start)).toBe(true)
    expect(rtpPacketCarriesIdr(middle)).toBe(false)
    expect(rtpPacketCarriesIdr(end)).toBe(false)
  })

  it('finds an IDR aggregated inside a STAP-A alongside SPS and PPS', () => {
    const stap = [
      0x78,
      0x00,
      0x04,
      0x67,
      0x42,
      0xc0,
      0x1f, // SPS
      0x00,
      0x02,
      0x68,
      0xce, // PPS
      0x00,
      0x03,
      0x65,
      0x88,
      0x84, // IDR
    ]
    expect(rtpPacketCarriesIdr(rtp(stap))).toBe(true)
  })

  it('reads the payload past CSRCs and a header extension', () => {
    expect(rtpPacketCarriesIdr(rtp([0x65, 0x88], { csrcCount: 2 }))).toBe(true)
    expect(rtpPacketCarriesIdr(rtp([0x65, 0x88], { extension: true }))).toBe(true)
    expect(rtpPacketCarriesIdr(rtp([0x65, 0x88], { csrcCount: 3, extension: true }))).toBe(true)
  })

  it('returns false rather than throwing on a truncated or empty packet', () => {
    // This runs on EVERY forwarded packet. A throw here kills the media path.
    expect(rtpPacketCarriesIdr(Buffer.alloc(0))).toBe(false)
    expect(rtpPacketCarriesIdr(Buffer.alloc(12))).toBe(false)
    expect(rtpPacketCarriesIdr(rtp([0x7c]))).toBe(false)
    expect(rtpPacketCarriesIdr(rtp([0x78, 0x00, 0x40, 0x65]))).toBe(false)
  })
})
