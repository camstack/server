import * as net from 'node:net'
import type { EncodedPacket, IScopedLogger, StreamSource } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PREBUFFER_SEC } from '../prebuffer'
import { MAX_MISSED_KEYFRAMES } from '../rtsp/rtsp-types.js'
import { StreamBroker } from '../stream-broker/stream-broker'
import { gop } from './fixtures/nal-sequence-fixtures.js'
import {
  countRtpFrames,
  createMockSocket,
  destroyMockSockets,
  playSession,
} from './fixtures/rtsp-session-mock.js'

/**
 * The broker's stats count PICTURES: `inputFps` is pictures per second and
 * `idrIntervalMs` is the GOP — one keyframe picture to the next.
 *
 * `pushEncodedPacket` bumps `packetsInWindow` once per EncodedPacket and
 * re-stamps `lastKeyframeMs` on every `keyframe` packet. While the Annex-B
 * plane was NAL-granular that read 75 fps on a 25 fps Hikvision G2 main stream
 * (3 slices per picture) and an 8–34 ms IDR interval (the gap between two IRAP
 * slices of ONE picture). Driven end to end here, through the RFC 4571 reader
 * and the real depacketizer, with only the clock faked.
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

const SDP = ['v=0', 'm=video 0 RTP/AVP 96', 'a=rtpmap:96 H265/90000'].join('\r\n')

function rfc4571Source(port: number): StreamSource {
  return {
    type: 'rfc4571',
    url: `tcp://127.0.0.1:${port}`,
    videoCodec: 'h265',
    metadata: { sdp: SDP },
  }
}

/** RFC 4571 length-prefix a raw RTP packet for the wire. */
function framed(rtp: Buffer): Buffer {
  const len = Buffer.alloc(2)
  len.writeUInt16BE(rtp.length, 0)
  return Buffer.concat([len, rtp])
}

interface Loopback {
  readonly server: net.Server
  readonly port: number
  readonly connections: net.Socket[]
}

async function startLoopback(): Promise<Loopback> {
  const connections: net.Socket[] = []
  const server = net.createServer((sock) => {
    connections.push(sock)
    sock.on('data', () => {})
    sock.on('error', () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { server, port, connections }
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

const T0 = new Date('2026-10-14T10:00:00.000Z').getTime()
const TICKS_25FPS = 3600
const SLICES_PER_PICTURE = 3

describe('StreamBroker — stats and EncodedPackets are per picture', () => {
  let broker: StreamBroker
  let lb: Loopback

  beforeEach(async () => {
    // Only the clock: the loopback TCP and the reader's timers stay real.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    broker = new StreamBroker('101/main', createMockLogger())
    broker.setPrebuffer({ enabled: true, seconds: DEFAULT_PREBUFFER_SEC })
    lb = await startLoopback()
  })

  afterEach(async () => {
    destroyMockSockets()
    await broker.stop()
    for (const c of lb.connections) c.destroy()
    await new Promise<void>((resolve) => lb.server.close(() => resolve()))
    vi.useRealTimers()
  })

  it('a 25 fps camera with 3 slices per picture reads 25 pictures/s and a GOP-long IDR interval', async () => {
    const received: EncodedPacket[] = []
    broker.onEncodedData((p) => {
      if (p.type === 'video') received.push(p)
    })

    await broker.start(rfc4571Source(lb.port))
    await waitFor(() => lb.connections.length === 1)
    const upstream = lb.connections[0]!

    // GOP 1: a keyframe picture (VPS, SPS, PPS, 3 IRAP slices FU-fragmented)
    // and 24 P pictures of 3 slices each — one second of video, delivered
    // within one tick of the faked clock.
    const first = gop({
      codec: 'h265',
      seq: 1,
      timestamp: 0,
      stepTicks: TICKS_25FPS,
      slicesPerPicture: SLICES_PER_PICTURE,
      pFrames: 24,
      packaging: 'fu',
    })
    upstream.write(Buffer.concat(first.packets.map(framed)))
    await waitFor(() => received.length >= first.pictures.length)

    // ONE EncodedPacket per picture, the keyframe self-contained.
    expect(received).toHaveLength(first.pictures.length)
    expect(received[0]!.keyframe).toBe(true)
    expect(received[0]!.data).toEqual(first.pictures[0]!.annexB)
    expect(received.slice(1).every((p) => !p.keyframe)).toBe(true)

    // Two seconds later the next keyframe picture closes the stats window.
    vi.setSystemTime(T0 + 2_000)
    const second = gop({
      codec: 'h265',
      seq: first.nextSeq,
      timestamp: first.nextTimestamp,
      stepTicks: TICKS_25FPS,
      slicesPerPicture: SLICES_PER_PICTURE,
      pFrames: 0,
      packaging: 'fu',
    })
    upstream.write(Buffer.concat(second.packets.map(framed)))
    await waitFor(() => received.length >= first.pictures.length + 1)

    const stats = broker.getStats()
    // 26 pictures over the 2 000 ms window — not 26 × 3 slices.
    expect(stats.inputFps).toBeCloseTo(13, 5)
    // Keyframe PICTURE to keyframe PICTURE — not IRAP slice to IRAP slice (0 ms).
    expect(stats.idrIntervalMs).toBe(2_000)
    expect(stats.packetCount).toBe(first.pictures.length + 1)
  })

  it('a backlogged RTSP client is closed after MAX_MISSED_KEYFRAMES pictures — not inside one fragmented IDR', async () => {
    await broker.start(rfc4571Source(lb.port))
    await waitFor(() => lb.connections.length === 1)
    const upstream = lb.connections[0]!
    const received: EncodedPacket[] = []
    broker.onEncodedData((p) => {
      if (p.type === 'video') received.push(p)
    })

    const client = createMockSocket()
    playSession(broker.getRtspRestreamer(), client)

    let seq = 1
    let timestamp = 0
    let pictures = 0
    const streamGop = async (): Promise<void> => {
      const g = gop({
        codec: 'h265',
        seq,
        timestamp,
        stepTicks: TICKS_25FPS,
        slicesPerPicture: SLICES_PER_PICTURE,
        pFrames: 4,
        packaging: 'fu',
      })
      seq = g.nextSeq
      timestamp = g.nextTimestamp
      pictures += g.pictures.length
      upstream.write(Buffer.concat(g.packets.map(framed)))
      await waitFor(() => received.length >= pictures)
    }

    // Joined on a clean GOP, served live.
    await streamGop()
    expect(countRtpFrames(client.written)).toBeGreaterThan(0)

    // The client stops draining. Every GOP opens with a 12-packet keyframe
    // picture; per-packet flags (the depacketizer's completed-NAL verdict,
    // false on the first two fragments of each IRAP slice) made the restreamer
    // see several keyframe starts per picture and close the client in ONE GOP.
    client.setBacklogged(true)
    for (let missed = 1; missed < MAX_MISSED_KEYFRAMES; missed++) {
      await streamGop()
      expect(client.destroy).not.toHaveBeenCalled()
    }
    await streamGop()
    expect(client.destroy).toHaveBeenCalledTimes(1)
  })
})
