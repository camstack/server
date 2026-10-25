import * as net from 'node:net'
import type { EncodedPacket, IScopedLogger, StreamSource } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { DEFAULT_PREBUFFER_SEC } from '../prebuffer'
import { RtpDepacketizer, type RtpPacketClass } from '../rtsp/rtp-depacketizer.js'
import { StreamBroker } from '../stream-broker/stream-broker'
import { gop, type Gop } from './fixtures/nal-sequence-fixtures.js'
import {
  countRtpFrames,
  createMockSocket,
  destroyMockSockets,
  playSession,
} from './fixtures/rtsp-session-mock.js'

/**
 * The Annex-B plane is built only while something consumes it.
 *
 * The native RTP path used to reassemble every NAL (one `allocUnsafe` + copy
 * per NAL, FU fragments gathered into a fresh buffer) and concatenate every
 * multi-NAL picture into one access unit, for every camera, whether or not a
 * single consumer of that plane existed. On the hub most brokers have none:
 * the RTSP restream (detection dials, recorder, egress legs) and the WebRTC
 * RTP path are served from the SOURCE RTP, which the pre-buffer ring already
 * owns. Those copies were the two largest allocation sites of the process
 * measured at 166–232 major GCs a minute.
 *
 * Now every packet is CLASSIFIED (what it carries, from its payload headers —
 * `classifyRtpPacket`), and NALs are reassembled only while an encoded
 * subscriber, a pipe client, a clip ring or an Annex-B-mode restreamer is
 * there. The plane arms at the next keyframe access unit after a consumer
 * attaches, so the first `EncodedPacket` it emits decodes, and the input stats
 * keep counting pictures from the RTP side while it is idle — a camera nobody
 * watches through Annex-B must not read 0 fps.
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

const T0 = new Date('2026-10-15T10:00:00.000Z').getTime()
const TICKS_25FPS = 3600
const SLICES_PER_PICTURE = 3

/** Did the logger see an info line whose message starts with `prefix`? */
function infoLines(logger: IScopedLogger, prefix: string): number {
  const info = logger.info as ReturnType<typeof vi.fn>
  return info.mock.calls.filter((call) => String(call[0]).startsWith(prefix)).length
}

describe('StreamBroker — the Annex-B plane is built only for a consumer', () => {
  let broker: StreamBroker
  let logger: IScopedLogger
  let lb: Loopback
  let upstream: net.Socket
  let processPacket: MockInstance<(rtpData: Buffer) => RtpPacketClass | null>
  let seq = 1
  let timestamp = 0

  /** One GOP of 3-slice FU-fragmented H.265 pictures, continuing the stream. */
  const nextGop = (pFrames: number): Gop => {
    const g = gop({
      codec: 'h265',
      seq,
      timestamp,
      stepTicks: TICKS_25FPS,
      slicesPerPicture: SLICES_PER_PICTURE,
      pFrames,
      packaging: 'fu',
    })
    seq = g.nextSeq
    timestamp = g.nextTimestamp
    return g
  }

  const write = (packets: readonly Buffer[]): void => {
    upstream.write(Buffer.concat(packets.map(framed)))
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    processPacket = vi.spyOn(RtpDepacketizer.prototype, 'processPacket')
    logger = createMockLogger()
    broker = new StreamBroker('101/main', logger)
    broker.setPrebuffer({ enabled: true, seconds: DEFAULT_PREBUFFER_SEC })
    lb = await startLoopback()
    seq = 1
    timestamp = 0
  })

  afterEach(async () => {
    processPacket.mockRestore()
    destroyMockSockets()
    await broker.stop()
    for (const c of lb.connections) c.destroy()
    await new Promise<void>((resolve) => lb.server.close(() => resolve()))
    vi.useRealTimers()
  })

  async function startStreaming(): Promise<void> {
    await broker.start(rfc4571Source(lb.port))
    await waitFor(() => lb.connections.length === 1)
    upstream = lb.connections[0]!
  }

  it('with no consumer nothing is reassembled, while the stats, the ring and the RTSP restream are all served', async () => {
    await startStreaming()
    // An RTSP client is served from the source RTP — it is not an Annex-B consumer.
    const client = createMockSocket()
    playSession(broker.getRtspRestreamer(), client)

    const first = nextGop(24)
    write(first.packets)
    await waitFor(() => broker.getStats().packetCount >= first.pictures.length)

    vi.setSystemTime(T0 + 2_000)
    const second = nextGop(0)
    write(second.packets)
    await waitFor(() => broker.getStats().packetCount >= first.pictures.length + 1)

    // Not one NAL reassembled: the plane had no consumer.
    expect(processPacket).not.toHaveBeenCalled()
    expect(infoLines(logger, 'annex-b plane armed')).toBe(0)

    // The stats still count PICTURES from the source RTP — 26 over 2 000 ms.
    const stats = broker.getStats()
    expect(stats.packetCount).toBe(first.pictures.length + 1)
    expect(stats.inputFps).toBeCloseTo(13, 5)
    expect(stats.idrIntervalMs).toBe(2_000)
    expect(stats.totalBytes).toBeGreaterThan(0)

    // The ring still knows where the keyframe AU is (per-packet flags), so a
    // joiner gets the current GOP…
    const ring = broker.getRtpPreBuffer()
    expect(ring).toHaveLength(second.pictures[0]!.packets.length)
    // …and the RTSP client was fed the whole way (at least: a client that joined
    // on a cold ring is primed from the restreamer's keyframe cache, which hands
    // it the very first parameter-set packet once more than the live feed).
    expect(countRtpFrames(client.written)).toBeGreaterThanOrEqual(
      first.packets.length + second.packets.length,
    )
  })

  it('a consumer attaching mid-GOP is handed its first picture at the next keyframe AU, complete', async () => {
    await startStreaming()
    const first = nextGop(4)
    // Keyframe + two P pictures before anyone is listening.
    write(first.pictures.slice(0, 3).flatMap((p) => p.packets))
    await waitFor(() => broker.getStats().packetCount >= 3)

    const received: EncodedPacket[] = []
    broker.onEncodedData((p) => {
      if (p.type === 'video') received.push(p)
    })

    // The rest of the GOP: P pictures a decoder could not start from.
    write(first.pictures.slice(3).flatMap((p) => p.packets))
    await waitFor(() => broker.getStats().packetCount >= first.pictures.length)
    expect(received).toHaveLength(0)
    expect(infoLines(logger, 'annex-b plane armed')).toBe(0)

    // The next keyframe AU arms the plane; its picture is the first one out,
    // self-contained (VPS/SPS/PPS + the three IRAP slices), then every P.
    const second = nextGop(3)
    write(second.packets)
    await waitFor(() => received.length >= second.pictures.length)
    expect(received).toHaveLength(second.pictures.length)
    expect(received[0]!.keyframe).toBe(true)
    expect(received[0]!.data).toEqual(second.pictures[0]!.annexB)
    expect(received.slice(1).map((p) => p.data)).toEqual(
      second.pictures.slice(1).map((p) => p.annexB),
    )
    expect(infoLines(logger, 'annex-b plane armed')).toBe(1)
  })

  it('the last consumer leaving idles the plane; the next one starts clean at a keyframe again', async () => {
    const received: EncodedPacket[] = []
    const unsubscribe = broker.onEncodedData((p) => {
      if (p.type === 'video') received.push(p)
    })
    await startStreaming()

    const first = nextGop(4)
    write(first.packets)
    await waitFor(() => received.length >= first.pictures.length)
    expect(received.map((p) => p.data)).toEqual(first.pictures.map((p) => p.annexB))
    const reassembledWhileConsumed = processPacket.mock.calls.length
    expect(reassembledWhileConsumed).toBe(first.packets.length)

    unsubscribe()
    const second = nextGop(4)
    write(second.packets)
    await waitFor(
      () => broker.getStats().packetCount >= first.pictures.length + second.pictures.length,
    )
    // Idle: not one more packet reassembled, said once.
    expect(processPacket.mock.calls.length).toBe(reassembledWhileConsumed)
    expect(infoLines(logger, 'annex-b plane idle')).toBe(1)

    // A new consumer mid-GOP waits for the keyframe and gets a clean start.
    received.length = 0
    broker.onEncodedData((p) => {
      if (p.type === 'video') received.push(p)
    })
    const third = nextGop(2)
    write(third.packets)
    await waitFor(() => received.length >= third.pictures.length)
    expect(received[0]!.keyframe).toBe(true)
    expect(received[0]!.data).toEqual(third.pictures[0]!.annexB)
    expect(received).toHaveLength(third.pictures.length)
  })

  it('a clip ring is a consumer: it keeps the plane built with nobody attached', async () => {
    broker.setClipRetention(10)
    await startStreaming()
    const first = nextGop(4)
    write(first.packets)
    await waitFor(() => broker.getClipBuffer().length >= first.pictures.length)
    expect(broker.getClipBuffer().map((p) => p.data)).toEqual(first.pictures.map((p) => p.annexB))
    expect(processPacket).toHaveBeenCalledTimes(first.packets.length)
  })
})
