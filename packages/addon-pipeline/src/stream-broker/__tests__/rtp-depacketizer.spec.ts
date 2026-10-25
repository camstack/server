import { describe, it, expect, beforeEach } from 'vitest'
import { RtpDepacketizer, type DepacketizedNal } from '../rtsp/rtp-depacketizer'
import { RTP_HEADER_SIZE } from '../rtsp/rtsp-types'

// ── Helpers ─────────────────────────────────────────────────────────

/** Build a minimal RTP packet with the given payload, timestamp, and marker. */
function buildRtp(payload: Buffer, timestamp: number, marker: boolean, pt = 96): Buffer {
  const header = Buffer.allocUnsafe(RTP_HEADER_SIZE)
  header[0] = 0x80 // V=2, no padding, no extension, CC=0
  header[1] = (marker ? 0x80 : 0) | (pt & 0x7f)
  header.writeUInt16BE(0, 2) // sequence
  header.writeUInt32BE(timestamp >>> 0, 4)
  header.writeUInt32BE(0x12345678, 8) // SSRC
  return Buffer.concat([header, payload])
}

// ── H.264 Tests ─────────────────────────────────────────────────────

describe('RtpDepacketizer H.264', () => {
  let depacketizer: RtpDepacketizer
  let emitted: DepacketizedNal[]

  beforeEach(() => {
    emitted = []
    depacketizer = new RtpDepacketizer('h264', (nal) => {
      emitted.push(nal)
    })
  })

  it('emits single NAL unit packet (type 1-23)', () => {
    // NAL type 1 = non-IDR slice (P/B frame)
    const nalPayload = Buffer.from([0x61, 0xaa, 0xbb, 0xcc]) // type=1, NRI=3
    const rtp = buildRtp(nalPayload, 90000, true)

    depacketizer.processPacket(rtp)

    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.nal).toEqual(nalPayload)
    expect(emitted[0]!.keyframe).toBe(false)
    expect(emitted[0]!.parameterSet).toBe(false)
    expect(emitted[0]!.timestamp).toBe(90000)
    expect(emitted[0]!.marker).toBe(true)
  })

  it('detects SPS (type 7) as parameter set', () => {
    const sps = Buffer.from([0x67, 0x42, 0x00, 0x1e]) // NAL type 7, NRI=3
    depacketizer.processPacket(buildRtp(sps, 90000, false))

    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.parameterSet).toBe(true)
    expect(emitted[0]!.keyframe).toBe(false)
  })

  it('detects PPS (type 8) as parameter set', () => {
    const pps = Buffer.from([0x68, 0xce, 0x38, 0x80]) // NAL type 8, NRI=3
    depacketizer.processPacket(buildRtp(pps, 90000, false))

    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.parameterSet).toBe(true)
  })

  it('detects IDR (type 5) as keyframe', () => {
    const idr = Buffer.from([0x65, 0x88, 0x84, 0x00]) // NAL type 5, NRI=3
    depacketizer.processPacket(buildRtp(idr, 90000, true))

    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.keyframe).toBe(true)
    expect(emitted[0]!.parameterSet).toBe(false)
  })

  it('handles STAP-A (multiple NALs in one packet)', () => {
    // STAP-A header: type 24 (0x18)
    const sps = Buffer.from([0x67, 0x42, 0x00, 0x1e])
    const pps = Buffer.from([0x68, 0xce])

    const stapPayload = Buffer.alloc(1 + 2 + sps.length + 2 + pps.length)
    stapPayload[0] = 0x18 // STAP-A type 24
    stapPayload.writeUInt16BE(sps.length, 1)
    sps.copy(stapPayload, 3)
    stapPayload.writeUInt16BE(pps.length, 3 + sps.length)
    pps.copy(stapPayload, 5 + sps.length)

    depacketizer.processPacket(buildRtp(stapPayload, 90000, true))

    expect(emitted).toHaveLength(2)
    expect(emitted[0]!.nal).toEqual(sps)
    expect(emitted[0]!.parameterSet).toBe(true) // SPS
    expect(emitted[1]!.nal).toEqual(pps)
    expect(emitted[1]!.parameterSet).toBe(true) // PPS
  })

  it('reassembles FU-A fragments into single NAL', () => {
    const timestamp = 180000

    // Original NAL: type 5 (IDR), NRI=3 → first byte 0x65
    // Fragment into 3 FU-A packets
    // Original NAL data that the fragments reconstruct to:
    // Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66])

    // FU-A indicator: NRI from original (0x60) + FU-A type (28)
    const fuIndicator = 0x60 | 28 // 0x7C

    // Start fragment
    const startFuHeader = 0x80 | 5 // S=1, type=5
    const startPayload = Buffer.from([fuIndicator, startFuHeader, 0x11, 0x22])
    depacketizer.processPacket(buildRtp(startPayload, timestamp, false))
    expect(emitted).toHaveLength(0) // Not emitted yet

    // Middle fragment
    const midFuHeader = 5 // S=0, E=0, type=5
    const midPayload = Buffer.from([fuIndicator, midFuHeader, 0x33, 0x44])
    depacketizer.processPacket(buildRtp(midPayload, timestamp, false))
    expect(emitted).toHaveLength(0) // Still accumulating

    // End fragment
    const endFuHeader = 0x40 | 5 // E=1, type=5
    const endPayload = Buffer.from([fuIndicator, endFuHeader, 0x55, 0x66])
    depacketizer.processPacket(buildRtp(endPayload, timestamp, true))

    expect(emitted).toHaveLength(1)
    // Reassembled NAL: reconstructed header byte (NRI=0x60 | type=5 = 0x65) + data
    expect(emitted[0]!.nal).toEqual(Buffer.from([0x65, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66]))
    expect(emitted[0]!.keyframe).toBe(true)
    expect(emitted[0]!.marker).toBe(true)
  })

  it('discards FU-A fragments on timestamp gap', () => {
    const fuIndicator = 0x60 | 28

    // Start at timestamp 100
    const start = Buffer.from([fuIndicator, 0x80 | 5, 0xaa])
    depacketizer.processPacket(buildRtp(start, 100, false))

    // Middle at different timestamp (gap)
    const mid = Buffer.from([fuIndicator, 5, 0xbb])
    depacketizer.processPacket(buildRtp(mid, 200, false))

    // Should have discarded — nothing emitted
    expect(emitted).toHaveLength(0)
  })

  it('reset() clears FU reassembly state', () => {
    const fuIndicator = 0x60 | 28
    const start = Buffer.from([fuIndicator, 0x80 | 5, 0xaa])
    depacketizer.processPacket(buildRtp(start, 100, false))

    depacketizer.reset()

    // End fragment after reset — should not produce output (no start)
    const end = Buffer.from([fuIndicator, 0x40 | 5, 0xbb])
    depacketizer.processPacket(buildRtp(end, 100, true))

    expect(emitted).toHaveLength(0)
  })

  it('ignores packets smaller than RTP header', () => {
    depacketizer.processPacket(Buffer.from([0x80, 0x60]))
    expect(emitted).toHaveLength(0)
  })

  it('ignores empty RTP payload', () => {
    depacketizer.processPacket(buildRtp(Buffer.alloc(0), 0, false))
    expect(emitted).toHaveLength(0)
  })
})

// ── H.265 Tests ─────────────────────────────────────────────────────

describe('RtpDepacketizer H.265', () => {
  let depacketizer: RtpDepacketizer
  let emitted: DepacketizedNal[]

  beforeEach(() => {
    emitted = []
    depacketizer = new RtpDepacketizer('h265', (nal) => {
      emitted.push(nal)
    })
  })

  it('emits single NAL unit packet', () => {
    // H.265 NAL: 2-byte header. Type = (byte0 >> 1) & 0x3F
    // Type 1 = non-IDR TRAIL_R: byte0 = (1 << 1) = 0x02
    const nal = Buffer.from([0x02, 0x01, 0xaa, 0xbb])
    depacketizer.processPacket(buildRtp(nal, 90000, true))

    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.nal).toEqual(nal)
    expect(emitted[0]!.keyframe).toBe(false)
    expect(emitted[0]!.parameterSet).toBe(false)
  })

  it('detects VPS (type 32) as parameter set', () => {
    // Type 32: byte0 = (32 << 1) = 0x40
    const vps = Buffer.from([0x40, 0x01, 0x0c])
    depacketizer.processPacket(buildRtp(vps, 90000, false))

    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.parameterSet).toBe(true)
  })

  it('detects SPS (type 33) as parameter set', () => {
    const sps = Buffer.from([0x42, 0x01, 0x01])
    depacketizer.processPacket(buildRtp(sps, 90000, false))
    expect(emitted[0]!.parameterSet).toBe(true)
  })

  it('detects PPS (type 34) as parameter set', () => {
    const pps = Buffer.from([0x44, 0x01, 0x00])
    depacketizer.processPacket(buildRtp(pps, 90000, false))
    expect(emitted[0]!.parameterSet).toBe(true)
  })

  it('detects IRAP (types 16-21) as keyframe', () => {
    // BLA_W_LP = type 16: byte0 = (16 << 1) = 0x20
    const bla = Buffer.from([0x20, 0x01, 0xaa])
    depacketizer.processPacket(buildRtp(bla, 90000, true))
    expect(emitted[0]!.keyframe).toBe(true)

    // IDR_W_RADL = type 19: byte0 = (19 << 1) = 0x26
    const idr = Buffer.from([0x26, 0x01, 0xbb])
    depacketizer.processPacket(buildRtp(idr, 90001, true))
    expect(emitted[1]!.keyframe).toBe(true)

    // CRA = type 21: byte0 = (21 << 1) = 0x2A
    const cra = Buffer.from([0x2a, 0x01, 0xcc])
    depacketizer.processPacket(buildRtp(cra, 90002, true))
    expect(emitted[2]!.keyframe).toBe(true)
  })

  it('handles AP aggregation packet (type 48)', () => {
    // AP header: type 48 → byte0 = (48 << 1) = 0x60
    const vps = Buffer.from([0x40, 0x01, 0x0c])
    const sps = Buffer.from([0x42, 0x01, 0x01])

    const apPayload = Buffer.alloc(2 + 2 + vps.length + 2 + sps.length)
    apPayload[0] = 0x60 // AP type
    apPayload[1] = 0x01 // TID
    apPayload.writeUInt16BE(vps.length, 2)
    vps.copy(apPayload, 4)
    apPayload.writeUInt16BE(sps.length, 4 + vps.length)
    sps.copy(apPayload, 6 + vps.length)

    depacketizer.processPacket(buildRtp(apPayload, 90000, true))

    expect(emitted).toHaveLength(2)
    expect(emitted[0]!.nal).toEqual(vps)
    expect(emitted[0]!.parameterSet).toBe(true)
    expect(emitted[1]!.nal).toEqual(sps)
    expect(emitted[1]!.parameterSet).toBe(true)
  })

  it('reassembles FU fragments into single NAL', () => {
    const timestamp = 270000

    // Original NAL: type 19 (IDR_W_RADL), byte0 = (19 << 1) = 0x26, byte1 = 0x01
    // FU header payload type 49: byte0 = (49 << 1) | (original & 0x81) = 0x62 | 0x00 = 0x62
    // Actually: FU indicator preserves F bit and LayerID LSB from original
    // byte0 of FU: (49 << 1) | (originalByte0 & 0x81) = 0x62 | (0x26 & 0x81) = 0x62 | 0x00 = 0x62
    const fuByte0 = (49 << 1) | (0x26 & 0x81) // = 0x62
    const fuByte1 = 0x01 // TID from original

    // Original NAL data that the fragments reconstruct to:
    // Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66])

    // Start fragment: FU header S=1, type=19
    const startFu = 0x80 | 19 // = 0x93
    const startPayload = Buffer.from([fuByte0, fuByte1, startFu, 0x11, 0x22])
    depacketizer.processPacket(buildRtp(startPayload, timestamp, false))
    expect(emitted).toHaveLength(0)

    // Middle fragment
    const midFu = 19 // S=0, E=0, type=19
    const midPayload = Buffer.from([fuByte0, fuByte1, midFu, 0x33, 0x44])
    depacketizer.processPacket(buildRtp(midPayload, timestamp, false))
    expect(emitted).toHaveLength(0)

    // End fragment: E=1
    const endFu = 0x40 | 19 // = 0x53
    const endPayload = Buffer.from([fuByte0, fuByte1, endFu, 0x55, 0x66])
    depacketizer.processPacket(buildRtp(endPayload, timestamp, true))

    expect(emitted).toHaveLength(1)
    // Reassembled: 2-byte NAL header (reconstructed type 19) + data
    const reassembled = emitted[0]!.nal
    expect(reassembled.length).toBe(2 + 6) // 2-byte header + 6 bytes data
    const reassembledType = (reassembled[0]! >> 1) & 0x3f
    expect(reassembledType).toBe(19) // IDR_W_RADL
    expect(emitted[0]!.keyframe).toBe(true)
    expect(emitted[0]!.marker).toBe(true)
  })
})
