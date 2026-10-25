import { describe, it, expect } from 'vitest'
import {
  RtpDepacketizer,
  ANNEXB_START_CODE_LENGTH,
  type DepacketizedNal,
} from '../rtsp/rtp-depacketizer.js'

/**
 * Annex-B start-code headroom — the allocation contract the broker depends on.
 *
 * `stream-broker.ts`'s `handleDepacketizedNal` used to run, for EVERY video NAL
 * of every camera:
 *
 * ```ts
 * const startCode = Buffer.from([0x00, 0x00, 0x00, 0x01])
 * annexBData = Buffer.concat([startCode, nal])
 * ```
 *
 * — a 4-byte allocation plus a SECOND full-size copy of a NAL the depacketizer
 * had just finished assembling, purely to prepend four constant bytes. In the
 * runner that spends ~68% of a full core in GC, that is the packet path's
 * largest avoidable byte volume.
 *
 * The depacketizer now reassembles each NAL into a buffer that already reserves
 * the start code as leading headroom, and publishes BOTH views:
 *   - `annexB` — start code + NAL, ready to emit with no further work
 *   - `nal`    — a zero-copy view into `annexB` past the start code
 *
 * These tests pin that contract for every reassembly path. If `nal` ever stops
 * being a view into `annexB`, the broker's `annexBData = depacketized.annexB`
 * silently starts shipping the wrong bytes, so the aliasing is asserted
 * explicitly and not merely implied by a length check.
 */

const RTP_HEADER_SIZE = 12

interface RtpOptions {
  readonly marker: boolean
  readonly payload: Buffer
}

function rtp(opts: RtpOptions): Buffer {
  const header = Buffer.alloc(RTP_HEADER_SIZE)
  header[0] = 0x80
  header[1] = (opts.marker ? 0x80 : 0x00) | 96
  header.writeUInt16BE(1, 2)
  header.writeUInt32BE(90_000, 4)
  header.writeUInt32BE(0x11223344, 8)
  return Buffer.concat([header, opts.payload])
}

function collect(codec: 'h264' | 'h265', packets: readonly Buffer[]): DepacketizedNal[] {
  const out: DepacketizedNal[] = []
  const dep = new RtpDepacketizer(codec, (n) => out.push(n))
  for (const p of packets) dep.processPacket(p)
  return out
}

const START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01])

/** The invariant the broker's zero-copy emit rests on. */
function expectZeroCopyAnnexB(emitted: DepacketizedNal, expectedNal: Buffer): void {
  // Positive: the bytes are a correct Annex-B access unit.
  expect(emitted.annexB.subarray(0, ANNEXB_START_CODE_LENGTH)).toEqual(START_CODE)
  expect(emitted.annexB.subarray(ANNEXB_START_CODE_LENGTH)).toEqual(expectedNal)
  expect(emitted.nal).toEqual(expectedNal)

  // The saving: `nal` is a VIEW into `annexB`, not a second allocation. Same
  // backing store, offset by exactly the start code.
  expect(emitted.nal.buffer).toBe(emitted.annexB.buffer)
  expect(emitted.nal.byteOffset).toBe(emitted.annexB.byteOffset + ANNEXB_START_CODE_LENGTH)
  expect(emitted.annexB.length).toBe(emitted.nal.length + ANNEXB_START_CODE_LENGTH)
}

describe('RtpDepacketizer — Annex-B start-code headroom', () => {
  it('h264 single NAL: annexB carries the start code and nal aliases it', () => {
    const nal = Buffer.concat([Buffer.from([0x60 | 1]), Buffer.alloc(200, 0xab)])
    const [emitted] = collect('h264', [rtp({ marker: true, payload: nal })])

    expect(emitted).toBeDefined()
    expectZeroCopyAnnexB(emitted!, nal)
  })

  it('h264 FU-A: a fragmented NAL is reassembled ONCE, into start-code headroom', () => {
    // 20 × 1400B fragments — the shape every large 4K slice actually arrives in.
    const fragments: Buffer[] = []
    for (let i = 0; i < 20; i++) fragments.push(Buffer.alloc(1400, i + 1))
    const body = Buffer.concat(fragments)

    const packets: Buffer[] = []
    fragments.forEach((frag, i) => {
      const isStart = i === 0
      const isEnd = i === fragments.length - 1
      const fuIndicator = 0x60 | 28
      const fuHeader = (isStart ? 0x80 : 0x00) | (isEnd ? 0x40 : 0x00) | 5 // IDR
      packets.push(
        rtp({
          marker: isEnd,
          payload: Buffer.concat([Buffer.from([fuIndicator, fuHeader]), frag]),
        }),
      )
    })

    const emitted = collect('h264', packets)
    expect(emitted).toHaveLength(1)

    // Reconstructed NAL = rebuilt header byte + every fragment, in order.
    const expectedNal = Buffer.concat([Buffer.from([0x60 | 5]), body])
    expectZeroCopyAnnexB(emitted[0]!, expectedNal)
    expect(emitted[0]!.keyframe).toBe(true)
    expect(emitted[0]!.nal).toHaveLength(1 + 20 * 1400)
  })

  it('h264 STAP-A: every aggregated NAL gets its own headroom buffer', () => {
    const a = Buffer.concat([Buffer.from([0x60 | 7]), Buffer.alloc(12, 0x11)]) // SPS
    const b = Buffer.concat([Buffer.from([0x60 | 8]), Buffer.alloc(6, 0x22)]) // PPS
    const sizeA = Buffer.alloc(2)
    sizeA.writeUInt16BE(a.length, 0)
    const sizeB = Buffer.alloc(2)
    sizeB.writeUInt16BE(b.length, 0)
    const payload = Buffer.concat([Buffer.from([0x60 | 24]), sizeA, a, sizeB, b])

    const emitted = collect('h264', [rtp({ marker: true, payload })])
    expect(emitted).toHaveLength(2)
    expectZeroCopyAnnexB(emitted[0]!, a)
    expectZeroCopyAnnexB(emitted[1]!, b)
    expect(emitted[0]!.parameterSet).toBe(true)
    expect(emitted[1]!.parameterSet).toBe(true)

    // Two NALs from one RTP packet must not share one allocation — the broker
    // buffers parameter sets and concatenates them later.
    expect(emitted[0]!.annexB.buffer === emitted[1]!.annexB.buffer).toBe(
      emitted[0]!.annexB.byteOffset !== emitted[1]!.annexB.byteOffset,
    )
  })

  it('h265 single NAL and FU reassembly both produce aliased annexB/nal', () => {
    const single = Buffer.concat([Buffer.from([(1 << 1) & 0x7e, 0x01]), Buffer.alloc(80, 0x33)])
    const [one] = collect('h265', [rtp({ marker: true, payload: single })])
    expect(one).toBeDefined()
    expectZeroCopyAnnexB(one!, single)

    // FU: two fragments of an IRAP (type 19) NAL.
    const f1 = Buffer.alloc(900, 0x44)
    const f2 = Buffer.alloc(700, 0x55)
    const fuType = (49 << 1) & 0x7e
    const mk = (frag: Buffer, start: boolean, end: boolean): Buffer =>
      rtp({
        marker: end,
        payload: Buffer.concat([
          Buffer.from([fuType, 0x01, (start ? 0x80 : 0) | (end ? 0x40 : 0) | 19]),
          frag,
        ]),
      })

    const emitted = collect('h265', [mk(f1, true, false), mk(f2, false, true)])
    expect(emitted).toHaveLength(1)
    const expectedNal = Buffer.concat([Buffer.from([(19 << 1) & 0x7e, 0x01]), f1, f2])
    expectZeroCopyAnnexB(emitted[0]!, expectedNal)
    expect(emitted[0]!.keyframe).toBe(true)
  })

  it('the broker can emit annexB verbatim — no concat needed for a plain VCL NAL', () => {
    // This is the whole point: for a non-keyframe NAL (no pending parameter
    // sets) the broker assigns `depacketized.annexB` straight into the
    // EncodedPacket. Assert that buffer is already byte-exact Annex-B, so that
    // assignment cannot be shipping a malformed access unit.
    const nal = Buffer.concat([Buffer.from([0x40 | 1]), Buffer.alloc(4096, 0x7e)])
    const [emitted] = collect('h264', [rtp({ marker: true, payload: nal })])

    expect(emitted!.parameterSet).toBe(false)
    expect(emitted!.keyframe).toBe(false)
    expect(emitted!.annexB).toEqual(Buffer.concat([START_CODE, nal]))
    // …and it cost exactly one buffer: nal is the same memory.
    expect(emitted!.nal.buffer).toBe(emitted!.annexB.buffer)
  })
})
