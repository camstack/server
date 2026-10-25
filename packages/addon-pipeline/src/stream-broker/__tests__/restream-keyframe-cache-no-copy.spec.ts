import { EventEmitter } from 'node:events'
import * as net from 'node:net'
import type { IScopedLogger, StreamSource } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RtspRestreamer } from '../rtsp/rtsp-restreamer.js'
import { RtspSession } from '../rtsp/rtsp-session.js'
import { ownsBackingStore } from '../stream-broker/owned-buffer.js'
import { isSlabView } from '../stream-broker/slab-pool.js'
import { StreamBroker } from '../stream-broker/stream-broker.js'
import { DEFAULT_PREBUFFER_SEC } from '../prebuffer'
import { gop } from './fixtures/nal-sequence-fixtures.js'

/**
 * The restreamer's keyframe cache holds the SOURCE packet, never a copy of it.
 *
 * `pushRtpPassthrough` used to `Buffer.from(rtpData)` every packet of every
 * keyframe access unit, per camera, and hold the copies for a GOP. Two costs:
 * a full copy of every keyframe packet (the largest packets of the stream) on
 * the ingest path, and — since a ~1.3 KB `Buffer.from` is a view of a shared
 * 8 KiB pool slab — a GOP-long pin on every slab those copies landed in, the
 * exact failure `owned-buffer.ts` was written for. The broker already detaches
 * every source packet once for its pre-buffer ring; the cache now keeps a
 * reference to that owned buffer, so the keyframe AU costs one allocation
 * shared by the ring, the cache and every session's write queue.
 *
 * The cache itself stays: it is the fallback a joiner is primed from when the
 * ring is cold (`rtpPreBufferSupplier` answers nothing).
 */

interface IdentitySocket {
  readonly socket: net.Socket
  /** The chunk OBJECTS written — identity preserved, nothing copied. */
  readonly written: Buffer[]
}

const sockets: IdentitySocket[] = []

afterEach(() => {
  for (const s of sockets) s.socket.destroy()
  sockets.length = 0
})

function createIdentitySocket(): IdentitySocket {
  const written: Buffer[] = []
  const emitter = new EventEmitter()
  const base = Object.assign(emitter, {
    write(chunk: Buffer | string): boolean {
      written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      return true
    },
    cork() {},
    uncork() {},
    destroy: vi.fn(),
    unshift(_chunk: Buffer) {},
    remoteAddress: '127.0.0.1',
    remotePort: 55555,
  })
  Object.defineProperty(base, 'writableLength', { get: () => 0 })
  Object.defineProperty(base, 'destroyed', { get: () => false })
  // The mock stands in for a `net.Socket`; the fields RtspSession reads are the ones above.
  const socket = base as unknown as net.Socket
  const identity: IdentitySocket = { socket, written }
  sockets.push(identity)
  return identity
}

const SDP = 'v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:trackID=0\r\n'

function playSession(restreamer: RtspRestreamer, mock: IdentitySocket): RtspSession {
  const session = new RtspSession(mock.socket, SDP, undefined, false)
  restreamer.addSession(session)
  mock.socket.emit(
    'data',
    Buffer.from(
      'SETUP rtsp://localhost/test/trackID=0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n',
    ),
  )
  mock.socket.emit('data', Buffer.from('PLAY rtsp://localhost/test RTSP/1.0\r\nCSeq: 2\r\n\r\n'))
  mock.written.length = 0
  return session
}

/** A 20-byte RTP packet (header + 8 payload bytes) with the given timestamp, as a view of a pool slab. */
function pooledRtp(ts: number): Buffer {
  const pkt = Buffer.allocUnsafe(20)
  pkt.fill(0)
  pkt[0] = 0x80
  pkt[1] = 0x60
  pkt.writeUInt32BE(ts >>> 0, 4)
  return pkt
}

/** The payload chunks a session was handed (every record is header, payload). */
function payloads(written: readonly Buffer[]): Buffer[] {
  const out: Buffer[] = []
  for (let i = 0; i + 1 < written.length; i++) {
    const head = written[i]!
    if (head.length === 4 && head[0] === 0x24) {
      out.push(written[i + 1]!)
      i++
    }
  }
  return out
}

describe('RtspRestreamer keyframe cache — a reference to the owned packet, never a copy', () => {
  it('serves a cold joiner the very buffer it was handed', () => {
    const restreamer = new RtspRestreamer('test-stream')
    restreamer.setCameraSdp(SDP, 'h264', null)
    restreamer.setRtpPreBufferSupplier(() => [])

    const owned = Buffer.allocUnsafeSlow(20)
    owned.fill(0)
    owned[0] = 0x80
    owned[1] = 0x60
    expect(ownsBackingStore(owned)).toBe(true)
    // The keyframe AU, as the broker hands it: already detached from the pool.
    restreamer.pushRtpPassthrough(owned, true, false)

    const viewer = createIdentitySocket()
    playSession(restreamer, viewer)
    // The next packet triggers the join; the ring is cold, so the cache primes it.
    restreamer.pushRtpPassthrough(pooledRtp(3000), false, false)

    const sent = payloads(viewer.written)
    expect(sent.length).toBeGreaterThanOrEqual(1)
    expect(sent.some((chunk) => chunk === owned)).toBe(true)
  })

  it('detaches a pooled packet itself when the caller did not — a cached entry never pins a slab', () => {
    const restreamer = new RtspRestreamer('test-stream')
    restreamer.setCameraSdp(SDP, 'h264', null)
    restreamer.setRtpPreBufferSupplier(() => [])

    const pooled = pooledRtp(0)
    expect(ownsBackingStore(pooled)).toBe(false)
    restreamer.pushRtpPassthrough(pooled, true, false)

    const viewer = createIdentitySocket()
    playSession(restreamer, viewer)
    restreamer.pushRtpPassthrough(pooledRtp(3000), false, false)

    const cached = payloads(viewer.written)[0]!
    expect(cached).not.toBe(pooled)
    expect(cached.equals(pooled)).toBe(true)
    expect(ownsBackingStore(cached)).toBe(true)
  })
})

// ── Through the broker: the ring and the restreamer share ONE owned copy ─────

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

const H265_SDP = ['v=0', 'm=video 0 RTP/AVP 96', 'a=rtpmap:96 H265/90000'].join('\r\n')

function rfc4571Source(port: number): StreamSource {
  return {
    type: 'rfc4571',
    url: `tcp://127.0.0.1:${port}`,
    videoCodec: 'h265',
    metadata: { sdp: H265_SDP },
  }
}

function framed(rtp: Buffer): Buffer {
  const len = Buffer.alloc(2)
  len.writeUInt16BE(rtp.length, 0)
  return Buffer.concat([len, rtp])
}

async function waitFor(pred: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = performance.now()
  while (!pred()) {
    if (performance.now() - started > timeoutMs) {
      throw new Error('waitFor: condition not met in time')
    }
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('StreamBroker — the source packet is detached once, for the ring and the restream alike', () => {
  it('a live RTSP client is written the same buffer objects the pre-buffer ring retains', async () => {
    const connections: net.Socket[] = []
    const server = net.createServer((sock) => {
      connections.push(sock)
      sock.on('data', () => {})
      sock.on('error', () => {})
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const broker = new StreamBroker('101/main', createMockLogger())
    // A pull source dials only on demand; the pre-buffer is the demand here.
    broker.setPrebuffer({ enabled: true, seconds: DEFAULT_PREBUFFER_SEC })
    try {
      await broker.start(rfc4571Source(port))
      await waitFor(() => connections.length === 1)
      const upstream = connections[0]!

      const viewer = createIdentitySocket()
      playSession(broker.getRtspRestreamer(), viewer)

      const g = gop({
        codec: 'h265',
        seq: 1,
        timestamp: 0,
        stepTicks: 3600,
        slicesPerPicture: 3,
        pFrames: 2,
        packaging: 'fu',
      })
      upstream.write(Buffer.concat(g.packets.map(framed)))
      await waitFor(() => payloads(viewer.written).length >= g.packets.length)

      const ring = broker.getRtpPreBuffer()
      expect(ring.length).toBe(g.packets.length)
      // Every ring entry is a view of the broker's packet slab (D868) …
      expect(ring.every((entry) => isSlabView(entry))).toBe(true)
      // … and the live feed handed the client THOSE objects, not the reader's
      // pooled views and not a second copy.
      const sent = payloads(viewer.written)
      for (const entry of ring) {
        expect(sent.some((chunk) => chunk === entry)).toBe(true)
      }
    } finally {
      await broker.stop()
      for (const c of connections) c.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
