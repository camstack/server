import type { IScopedLogger, StreamSource } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamBroker } from '../stream-broker/stream-broker'
import { holdPacket, isSlabView, readSlabTotals, releasePacket } from '../stream-broker/slab-pool'

/**
 * The broker's source-RTP ring is served from packet slabs (D868): a stream
 * pushing for minutes allocates a handful of ArrayBuffers, not one per packet,
 * and a consumer that holds a snapshot keeps its bytes whatever the ring does.
 */

function createMockLogger(): IScopedLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
}

const PAYLOAD_BYTES = 1200
const PACKET_BYTES = 12 + 1 + PAYLOAD_BYTES

function rtp(seq: number, ts: number, nalType: number, fill: number, marker: boolean): Buffer {
  const header = Buffer.alloc(12)
  header[0] = 0x80
  header[1] = (marker ? 0x80 : 0) | 96
  header.writeUInt16BE(seq & 0xffff, 2)
  header.writeUInt32BE(ts >>> 0, 4)
  header.writeUInt32BE(0x11223344, 8)
  const body = Buffer.concat([Buffer.from([0x60 | nalType]), Buffer.alloc(PAYLOAD_BYTES, fill)])
  return Buffer.concat([header, body])
}

interface GopState {
  readonly seq: number
  readonly ts: number
}

/** One GOP: an IDR then `pCount` P slices; returns the next seq/ts. */
function pushGop(broker: StreamBroker, from: GopState, pCount: number, fill: number): GopState {
  let { seq, ts } = from
  broker.pushVideoRtp(rtp(seq++, ts, 5, fill, true))
  ts += 3000
  for (let i = 0; i < pCount; i++) {
    broker.pushVideoRtp(rtp(seq++, ts, 1, fill, true))
    ts += 3000
  }
  return { seq, ts }
}

describe('StreamBroker source-RTP ring on packet slabs', () => {
  let broker: StreamBroker

  beforeEach(() => {
    vi.useFakeTimers()
    broker = new StreamBroker('dev-slab', createMockLogger())
  })

  afterEach(async () => {
    await broker.stop()
    vi.useRealTimers()
  })

  const source: StreamSource = { type: 'push-rtp', url: '', videoCodec: 'h264' }

  it('serves the ring from slabs and allocates no new ArrayBuffer per packet', async () => {
    await broker.start(source)
    const before = readSlabTotals()
    let state: GopState = { seq: 1, ts: 90000 }
    const gops = 400
    for (let g = 0; g < gops; g++) {
      state = pushGop(broker, state, 29, g & 0xff)
      vi.advanceTimersByTime(1000) // one GOP per second of fake time
    }
    const pushed = gops * 30
    const allocs = readSlabTotals().allocs - before.allocs
    // Without slabs: one allocation per packet (12 000). With them: a few.
    expect(allocs).toBeLessThan(pushed / 50)
    const ring = broker.getRtpPreBuffer()
    expect(ring.length).toBe(30)
    expect(ring.every((p) => isSlabView(p))).toBe(true)
    expect(ring.every((p) => p.length === PACKET_BYTES)).toBe(true)
    const lastFill = (gops - 1) & 0xff
    expect(ring.every((p) => p[13] === lastFill && p[p.length - 1] === lastFill)).toBe(true)
  })

  it('keeps a held snapshot intact across a long churn', async () => {
    await broker.start(source)
    let state = pushGop(broker, { seq: 1, ts: 90000 }, 29, 0xa5)
    const snapshot = [...broker.getRtpPreBuffer()]
    for (const p of snapshot) holdPacket(p)
    for (let g = 0; g < 300; g++) {
      state = pushGop(broker, state, 29, g & 0x7f)
      vi.advanceTimersByTime(1000)
    }
    expect(snapshot.length).toBe(30)
    expect(snapshot.every((p) => p[p.length - 1] === 0xa5 && p.length === PACKET_BYTES)).toBe(true)
    for (const p of snapshot) releasePacket(p)
  })

  it('empties the ring on teardown so its slabs can be recycled', async () => {
    await broker.start(source)
    pushGop(broker, { seq: 1, ts: 90000 }, 29, 1)
    expect(broker.getRtpPreBuffer().length).toBeGreaterThan(0)
    await broker.stop()
    expect(broker.getRtpPreBuffer()).toEqual([])
  })
})
