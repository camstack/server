import * as net from 'node:net'
import type { IScopedLogger, StreamSource } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PREBUFFER_SEC } from '../prebuffer'
import { isSlabView } from '../stream-broker/slab-pool'
import { StreamBroker } from '../stream-broker/stream-broker'

/**
 * The REAL `Rfc4571Reader` feeding a real broker over loopback TCP: the
 * packets that land in the source-RTP ring are views of the broker's packet
 * slabs, and carry exactly the bytes the camera sent (D868).
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

const SDP = ['v=0', 'm=video 0 RTP/AVP 96', 'a=rtpmap:96 H264/90000'].join('\r\n')

function framed(rtp: Buffer): Buffer {
  const len = Buffer.alloc(2)
  len.writeUInt16BE(rtp.length, 0)
  return Buffer.concat([len, rtp])
}

/** A single-NAL packet: IDR (type 5) when `idr`, else a P slice (type 1). */
function videoRtp(seq: number, idr: boolean, body: Buffer): Buffer {
  const h = Buffer.alloc(12)
  h[0] = 0x80
  h[1] = 0x80 | 96
  h.writeUInt16BE(seq & 0xffff, 2)
  h.writeUInt32BE((seq * 3000) >>> 0, 4)
  h.writeUInt32BE(0x11223344, 8)
  return Buffer.concat([h, Buffer.from([0x60 | (idr ? 5 : 1)]), body])
}

describe('Rfc4571Reader -> broker ring', () => {
  const brokers: StreamBroker[] = []
  const servers: net.Server[] = []
  const sockets: net.Socket[] = []

  afterEach(async () => {
    for (const b of brokers) await b.stop().catch(() => {})
    for (const s of sockets) s.destroy()
    for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()))
    brokers.length = 0
    servers.length = 0
    sockets.length = 0
  })

  it('cuts packets into the broker slab pool, byte for byte', async () => {
    const server = net.createServer((sock) => {
      sockets.push(sock)
      sock.on('error', () => {})
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    const broker = new StreamBroker('slab/main', createMockLogger())
    broker.setPrebuffer({ enabled: true, seconds: DEFAULT_PREBUFFER_SEC })
    brokers.push(broker)
    const source: StreamSource = {
      type: 'rfc4571',
      url: `tcp://127.0.0.1:${port}`,
      videoCodec: 'h264',
      metadata: { sdp: SDP },
    }
    await broker.start(source)
    const deadline = Date.now() + 3000
    while (sockets.length === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10))
    expect(sockets.length).toBe(1)

    const sent = [
      videoRtp(1, true, Buffer.alloc(900, 0xa1)),
      videoRtp(2, false, Buffer.alloc(1100, 0xb2)),
      videoRtp(3, false, Buffer.alloc(500, 0xc3)),
    ]
    // One TCP write, so the reader cuts all three out of one socket buffer.
    sockets[0]!.write(Buffer.concat(sent.map(framed)))
    while (broker.getRtpPreBuffer().length < 3 && Date.now() < deadline + 3000) {
      await new Promise((r) => setTimeout(r, 10))
    }

    const ring = broker.getRtpPreBuffer()
    expect(ring.length).toBe(3)
    expect(ring.every((p) => isSlabView(p))).toBe(true)
    ring.forEach((p, i) => expect(p.equals(sent[i]!)).toBe(true))
    // Consecutive packets share one slab: no allocation per packet.
    expect(ring[1]!.buffer).toBe(ring[0]!.buffer)
    expect(ring[2]!.buffer).toBe(ring[0]!.buffer)
  })
})
