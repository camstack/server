import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { RtpHeader, RtpPacket } from 'werift'
import { H264Repacketizer } from '../h264-repacketizer.js'

/**
 * The repacketizer's output is the WIRE: a refactor of how its buffers are
 * assembled (D868: one owned output per packet, no `Buffer.from([...])` header
 * triplet and no `Buffer.concat` per fragment) must not move one byte.
 *
 * The digest below was recorded from the code BEFORE that change, over a
 * fixture that walks every path that builds a buffer: a STAP-A with SPS/PPS, an
 * IDR arriving as FU-A larger than the peer MTU (defragmented and re-cut), a
 * single oversized NAL (cut into FU-A), a small single NAL, and in-range FU-A.
 */

interface SourcePacket {
  readonly seq: number
  readonly ts: number
  readonly marker: boolean
  readonly payload: Buffer
}

function packet(p: SourcePacket): RtpPacket {
  return new RtpPacket(
    new RtpHeader({
      payloadType: 96,
      sequenceNumber: p.seq,
      timestamp: p.ts,
      ssrc: 0x01020304,
      marker: p.marker,
    }),
    p.payload,
  )
}

function nal(type: number, size: number, fill: number): Buffer {
  const out = Buffer.alloc(size, fill)
  out[0] = 0x60 | type
  return out
}

/** A NAL cut into FU-A packets of `fragment` payload bytes. */
function fua(nalUnit: Buffer, fragment: number): Buffer[] {
  const header = nalUnit[0]!
  const body = nalUnit.subarray(1)
  const out: Buffer[] = []
  for (let off = 0; off < body.length; off += fragment) {
    const part = body.subarray(off, Math.min(off + fragment, body.length))
    const start = off === 0 ? 0x80 : 0
    const end = off + fragment >= body.length ? 0x40 : 0
    out.push(
      Buffer.concat([Buffer.from([(header & 0xe0) | 28, start | end | (header & 0x1f)]), part]),
    )
  }
  return out
}

function stapA(...nals: Buffer[]): Buffer {
  const parts: Buffer[] = [Buffer.from([0x78])]
  for (const n of nals) {
    const len = Buffer.alloc(2)
    len.writeUInt16BE(n.length)
    parts.push(len, n)
  }
  return Buffer.concat(parts)
}

function buildStream(): SourcePacket[] {
  const out: SourcePacket[] = []
  let seq = 1000
  let ts = 90_000
  const push = (payload: Buffer, marker: boolean): void => {
    out.push({ seq: seq++, ts, marker, payload })
  }
  for (let gop = 0; gop < 3; gop++) {
    // Keyframe AU: STAP-A(SPS,PPS), then the IDR as 1500-byte FU-A fragments.
    push(stapA(nal(7, 24, 0x11 + gop), nal(8, 9, 0x22)), false)
    const idr = fua(nal(5, 4200 + gop * 17, 0x33 + gop), 1400)
    idr.forEach((p, i) => push(p, i === idr.length - 1))
    ts += 3000
    // A single NAL larger than the peer MTU: cut into FU-A on the way out.
    push(nal(1, 3100 + gop, 0x44), true)
    ts += 3000
    // A small single NAL.
    push(nal(1, 300 + gop, 0x55), true)
    ts += 3000
    // In-range FU-A (fits the peer MTU already): forwarded as is.
    const small = fua(nal(1, 2000, 0x66), 1000)
    small.forEach((p, i) => push(p, i === small.length - 1))
    ts += 3000
  }
  return out
}

function runStream(): string[] {
  const repacketizer = new H264Repacketizer(console, 1200)
  const lines: string[] = []
  for (const src of buildStream()) {
    for (const out of repacketizer.repacketize(packet(src))) {
      lines.push(
        `${out.header.sequenceNumber}/${out.header.timestamp}/${out.header.marker ? 1 : 0}/${out.payload.toString('hex')}`,
      )
    }
  }
  return lines
}

describe('H264Repacketizer wire output', () => {
  it('stays byte-identical to the recorded output', () => {
    const lines = runStream()
    const digest = createHash('sha256').update(lines.join('\n')).digest('hex')
    // eslint-disable-next-line no-console
    if (process.env['PRINT_GOLDEN'] === '1') console.log('GOLDEN', lines.length, digest)
    expect(lines.length).toBe(GOLDEN_PACKETS)
    expect(digest).toBe(GOLDEN_DIGEST)
  })

  it('never exceeds the peer MTU and keeps every output a valid H.264 payload', () => {
    for (const line of runStream()) {
      const payload = Buffer.from(line.split('/')[3]!, 'hex')
      expect(payload.length).toBeLessThanOrEqual(1200)
      expect([1, 5, 24, 28]).toContain(payload[0]! & 0x1f)
    }
  })
})

const GOLDEN_PACKETS = 33
const GOLDEN_DIGEST = '9a9d86f882be39a96f3d70a8319af334bd7381b75c352c85b0ff9df15d38f07b'
