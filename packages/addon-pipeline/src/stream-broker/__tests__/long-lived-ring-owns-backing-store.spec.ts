/**
 * A buffer that enters a LONG-LIVED ring owns its backing store.
 *
 * Node serves `Buffer.from` / `Buffer.allocUnsafe` / `Buffer.concat` under
 * 4 KiB from shared 8 KiB pool slabs. A ring that keeps one such buffer for
 * 20–60 s pins the whole slab — and every short-lived packet that happened to
 * share it. On the hub this held 550–980 MB of ArrayBuffers for ~150–250 MB of
 * payload and ran a full GC every 0.2–0.5 s. The clip ring (sub-stream NALs of
 * 0.1–1.5 KB) and the source-RTP pre-buffer ring (every ~1.3 KB packet since
 * the last keyframe) are the two long holders; both must copy a pooled entry
 * into its own allocation on the way in, and their byte budgets must count
 * what an entry really costs.
 */
import { isSlabView, SLAB_BYTES } from '../stream-broker/slab-pool'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EncodedPacket, IScopedLogger, StreamSource } from '@camstack/types'

import { EncodedRingBuffer } from '../stream-broker/encoded-ring-buffer.js'
import { StreamBroker } from '../stream-broker/stream-broker.js'

/** Deliberately local: the spec must fail on the ASSERTION, not on an import. */
function ownsItsArrayBuffer(buf: Buffer): boolean {
  return buf.byteOffset === 0 && buf.buffer.byteLength === buf.length
}

/** What a stored buffer really pins: its slab when shared, itself when owned. */
function pinnedBytes(buf: Buffer): number {
  return ownsItsArrayBuffer(buf) ? buf.length : buf.buffer.byteLength
}

/** A small buffer the way the ingest path makes one — from the shared pool. */
function pooled(bytes: number, fill: number): Buffer {
  const buf = Buffer.allocUnsafe(bytes)
  buf.fill(fill)
  return buf
}

function packet(pts: number, data: Buffer, keyframe = false): EncodedPacket {
  return { type: 'video', data, pts, dts: pts, keyframe, codec: 'h264' }
}

const RTP_HEADER_SIZE = 12

interface RtpPacketOptions {
  readonly seq: number
  readonly timestamp: number
  readonly marker: boolean
  readonly nalType: number
  readonly bodyBytes: number
}

/** A raw single-NAL H.264 RTP packet; `Buffer.concat` under 4 KiB is pooled. */
function buildRtpPacket(opts: RtpPacketOptions): Buffer {
  const header = Buffer.alloc(RTP_HEADER_SIZE)
  header[0] = 0x80
  header[1] = (opts.marker ? 0x80 : 0x00) | 96
  header.writeUInt16BE(opts.seq & 0xffff, 2)
  header.writeUInt32BE(opts.timestamp >>> 0, 4)
  header.writeUInt32BE(0x11223344, 8)
  return Buffer.concat([
    header,
    Buffer.from([0x60 | opts.nalType]),
    Buffer.alloc(opts.bodyBytes, 0xcd),
  ])
}

function createMockLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
  return logger
}

function pushRtpSource(): StreamSource {
  return { type: 'push-rtp', url: '', videoCodec: 'h264' }
}

interface GopState {
  seq: number
  ts: number
}

/** One keyframe AU (SPS, PPS, IDR) then `pCount` P-slices, all pooled. */
function pushGop(broker: StreamBroker, state: GopState, pCount: number): GopState {
  let { seq, ts } = state
  broker.pushVideoRtp(
    buildRtpPacket({ seq: seq++, timestamp: ts, marker: false, nalType: 7, bodyBytes: 3 }),
  )
  broker.pushVideoRtp(
    buildRtpPacket({ seq: seq++, timestamp: ts, marker: false, nalType: 8, bodyBytes: 3 }),
  )
  broker.pushVideoRtp(
    buildRtpPacket({ seq: seq++, timestamp: ts, marker: true, nalType: 5, bodyBytes: 1200 }),
  )
  ts += 3600
  for (let i = 0; i < pCount; i++) {
    broker.pushVideoRtp(
      buildRtpPacket({ seq: seq++, timestamp: ts, marker: true, nalType: 1, bodyBytes: 1200 }),
    )
    ts += 3600
  }
  return { seq, ts }
}

describe('clip ring (EncodedRingBuffer) owns the backing store of every entry', () => {
  it('a pooled NAL is stored in its own allocation, not as a view of a shared slab', () => {
    const ring = new EncodedRingBuffer(60, 16 * 1024 * 1024)
    for (let i = 0; i < 50; i++) {
      const nal = pooled(600, i)
      // The PRECONDITION: the input really is pooled, or this spec proves nothing.
      expect(ownsItsArrayBuffer(nal)).toBe(false)
      ring.push(packet(i * 40, nal, i === 0))
    }
    const stored = ring.getAllPackets()
    expect(stored.length).toBe(50)
    for (const p of stored) expect(ownsItsArrayBuffer(p.data)).toBe(true)
    // Content survives the copy.
    expect(stored[7]!.data.every((b) => b === 7)).toBe(true)
  })

  it('the byte budget counts what the entries PIN, which after detaching is their length', () => {
    const ring = new EncodedRingBuffer(60, 16 * 1024 * 1024)
    for (let i = 0; i < 20; i++) ring.push(packet(i * 40, pooled(600, 1)))
    const pinned = ring.getAllPackets().reduce((n, p) => n + pinnedBytes(p.data), 0)
    expect(ring.getBufferedBytes()).toBe(pinned)
  })

  it('an entry that already owns its allocation is stored as-is — no second copy', () => {
    const ring = new EncodedRingBuffer(60, 16 * 1024 * 1024)
    const owned = Buffer.allocUnsafeSlow(600)
    const big = Buffer.allocUnsafeSlow(8192)
    expect(ownsItsArrayBuffer(owned)).toBe(true)
    expect(ownsItsArrayBuffer(big)).toBe(true)
    ring.push(packet(0, owned, true))
    ring.push(packet(40, big))
    const stored = ring.getAllPackets()
    expect(stored[0]!.data).toBe(owned)
    expect(stored[1]!.data).toBe(big)
  })
})

describe('source-RTP pre-buffer ring owns the backing store of every packet', () => {
  let broker: StreamBroker

  beforeEach(() => {
    vi.useFakeTimers()
    broker = new StreamBroker('dev-97', createMockLogger())
  })

  afterEach(async () => {
    await broker.stop()
    vi.useRealTimers()
  })

  it('every retained packet is a view of a broker packet slab (D868), never of a pooled slab, alongside pooled churn', async () => {
    await broker.start(pushRtpSource())
    // The precondition, on the exact shape the ring is fed.
    expect(
      ownsItsArrayBuffer(
        buildRtpPacket({ seq: 0, timestamp: 0, marker: true, nalType: 1, bodyBytes: 1200 }),
      ),
    ).toBe(false)

    let state: GopState = { seq: 1000, ts: 90_000 }
    for (let gop = 0; gop < 3; gop++) {
      state = pushGop(broker, state, 24)
      // Short-lived traffic sharing the same slabs — must stay out of the ring.
      for (let k = 0; k < 200; k++) pooled(1300, 0x11)
    }

    const retained = broker.getRtpPreBuffer()
    expect(retained.length).toBeGreaterThan(0)
    // A packet slab holds only this stream's packets (`slab-pool.ts`), so the
    // ring still pins nothing that short-lived traffic shares.
    for (const pkt of retained) {
      expect(isSlabView(pkt)).toBe(true)
      expect(pkt.buffer.byteLength).toBe(SLAB_BYTES)
    }
  })

  it('a packet that already owns its allocation is retained as-is — no second copy', async () => {
    await broker.start(pushRtpSource())
    const idr = Buffer.allocUnsafeSlow(RTP_HEADER_SIZE + 1 + 1200)
    buildRtpPacket({ seq: 1, timestamp: 90_000, marker: true, nalType: 5, bodyBytes: 1200 }).copy(
      idr,
    )
    expect(ownsItsArrayBuffer(idr)).toBe(true)
    broker.pushVideoRtp(idr)
    const retained = broker.getRtpPreBuffer()
    expect(retained).toHaveLength(1)
    expect(retained[0]).toBe(idr)
  })
})
