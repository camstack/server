import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import type { IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PRIME_BURST_BOUND,
  PRIME_MAX_PACKETS,
  PRIME_MAX_SPAN_MS,
  type PrimeBurstBound,
  RtspRestreamer,
} from '../rtsp/rtsp-restreamer.js'
import { RtspSession } from '../rtsp/rtsp-session.js'
import { MAX_WRITE_BUFFER } from '../rtsp/rtsp-types.js'

/**
 * Reassemble the interleaved RTP records a session wrote.
 *
 * `RtspSession.writeInterleaved` emits the 4-byte header and the SHARED payload
 * as two corked writes (one `writev`) instead of copying the payload into a
 * combined buffer — that copy ran once per packet per connected client and was
 * the broker's largest allocation source. The socket peer sees the same bytes
 * either way, so this helper rejoins the pair and every assertion below keeps
 * reading a whole `$ ch len payload` record.
 */
function interleavedRecords(written: readonly Buffer[]): readonly Buffer[] {
  const out: Buffer[] = []
  for (let i = 0; i < written.length; i++) {
    const head = written[i]
    if (head === undefined || head.length !== 4 || head[0] !== 0x24) continue
    const payload = written[i + 1]
    if (payload === undefined) continue
    out.push(Buffer.concat([head, payload]))
    i++
  }
  return out
}

/**
 * The D57 join-burst bound is CONFIGURABLE, and it is read PER JOIN.
 *
 * D57 shipped the bound as two module constants. That is wrong for one reason
 * the decision itself names: the bound's reachability is a property of the
 * CAMERA. The ring holds `[most recent keyframe AU .. now]`, so a burst's span
 * at join time is the elapsed time since the last IDR — uniform in
 * `[0, idrIntervalMs]`. A camera whose IDR interval is 4 s therefore has
 * roughly half its joins withheld under a 2 000 ms bound, and no cluster value
 * can be right for both it and a 1.8 s-GOP camera at once.
 *
 * Two properties are pinned here and neither is implied by the other:
 *
 *  1. The DEFAULT is unchanged — 2 000 ms / 2 000 packets, chosen against a
 *     measured distribution (p50 1 800 ms untouched, confirmed-harmful 2 996 ms
 *     excluded). A configurable bound that silently moved its default would
 *     re-open the HomeKit failure on every camera at once.
 *  2. The bound is supplied by a PULL, not captured at construction. A
 *     restreamer outlives every settings change made to it: the broker is
 *     created on the first dial and reused for the life of the stream, so a
 *     bound latched at construction would apply the value that was current when
 *     the camera was first published and ignore every later edit — silently,
 *     because the only symptom is a burst that is or is not withheld.
 */

interface MockSocket {
  readonly socket: Socket
  readonly written: Buffer[]
  setWritableLength: (n: number) => void
}

function createMockSocket(): MockSocket {
  const written: Buffer[] = []
  const emitter = new EventEmitter()
  let writableLength = 0

  const base = Object.assign(emitter, {
    write(chunk: Buffer | string): boolean {
      written.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk))
      return true
    },
    // `writeInterleaved` corks the header+payload pair into one `writev`.
    cork() {
      /* no-op: this mock records each chunk as the peer would see it */
    },
    uncork() {
      /* no-op */
    },
    destroy: vi.fn(),
    unshift(_chunk: Buffer) {
      /* no-op for mock */
    },
    remoteAddress: '127.0.0.1',
    remotePort: 55555,
  })
  // Accessors must be DEFINED, not spread: `Object.assign` copies a getter's
  // current VALUE, which would freeze `writableLength` at 0 and make every
  // backpressure-adjacent assertion in this file vacuously pass.
  Object.defineProperty(base, 'writableLength', { get: () => writableLength })
  Object.defineProperty(base, 'destroyed', { get: () => false })
  const socket = base as unknown as Socket

  return {
    socket,
    written,
    setWritableLength: (n) => {
      writableLength = n
    },
  }
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

function rtpWithTimestamp(ts: number): Buffer {
  const pkt = Buffer.alloc(20)
  pkt[0] = 0x80
  pkt[1] = 0x60
  pkt.writeUInt32BE(ts >>> 0, 4)
  return pkt
}

function rtpFrames(written: readonly Buffer[]): readonly Buffer[] {
  return interleavedRecords(written)
}

function countRtpFrames(written: readonly Buffer[]): number {
  return rtpFrames(written).length
}

const sdp = 'v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:trackID=0\r\n'

function playSession(restreamer: RtspRestreamer, mock: MockSocket): RtspSession {
  const session = new RtspSession(mock.socket, sdp, undefined, false)
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

/** A ring of `count` packets whose first→last timestamps span EXACTLY `spanMs`. */
function ring(count: number, spanMs: number): readonly Buffer[] {
  const lastTicks = spanMs * 90
  const stepTicks = count > 1 ? Math.floor(lastTicks / (count - 1)) : 0
  return Array.from({ length: count }, (_, i) =>
    rtpWithTimestamp(i === count - 1 ? lastTicks : i * stepTicks),
  )
}

function makeRestreamer(supplier: readonly Buffer[]): {
  restreamer: RtspRestreamer
  logger: IScopedLogger
} {
  const restreamer = new RtspRestreamer('101/native')
  const logger = createMockLogger()
  restreamer.setLogger(logger)
  restreamer.setCameraSdp(sdp, 'h264', null)
  restreamer.setRtpPreBufferSupplier(() => supplier)
  return { restreamer, logger }
}

describe('RTSP join burst — the bound is configurable', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps D57 defaults when no bound is configured', () => {
    // The measured distribution these numbers were chosen against: p50 1800 ms
    // must survive, the confirmed-harmful 2996 ms must not.
    expect(DEFAULT_PRIME_BURST_BOUND.maxSpanMs).toBe(2000)
    expect(DEFAULT_PRIME_BURST_BOUND.maxPackets).toBe(2000)
    expect(PRIME_MAX_SPAN_MS).toBe(DEFAULT_PRIME_BURST_BOUND.maxSpanMs)
    expect(PRIME_MAX_PACKETS).toBe(DEFAULT_PRIME_BURST_BOUND.maxPackets)
    expect(DEFAULT_PRIME_BURST_BOUND.maxSpanMs).toBeGreaterThan(1800)
    expect(DEFAULT_PRIME_BURST_BOUND.maxSpanMs).toBeLessThan(2996)
  })

  it('withholds a 2996 ms burst with no supplier wired (unconfigured = D57 behaviour)', () => {
    const burst = ring(187, 2996)
    const { restreamer } = makeRestreamer(burst)
    const viewer = createMockSocket()
    playSession(restreamer, viewer)

    restreamer.pushRtpPassthrough(rtpWithTimestamp(2996 * 90 + 3000), false, false)
    vi.advanceTimersByTime(1000)
    expect(countRtpFrames(viewer.written)).toBe(0)
  })

  it('serves that same burst when the camera raises its bound above its IDR interval', () => {
    // The 4 s-GOP camera. Its bursts routinely exceed 2000 ms simply because
    // its IDR interval does; a raised bound restores its instant start.
    const burst = ring(187, 2996)
    const { restreamer } = makeRestreamer(burst)
    restreamer.setPrimeBoundSupplier(() => ({ maxSpanMs: 4500, maxPackets: PRIME_MAX_PACKETS }))
    const viewer = createMockSocket()
    playSession(restreamer, viewer)

    restreamer.pushRtpPassthrough(rtpWithTimestamp(2996 * 90 + 3000), false, false)
    vi.advanceTimersByTime(1000)
    expect(countRtpFrames(viewer.written)).toBe(burst.length + 1)
  })

  it('withholds a burst the default would have served when the bound is lowered', () => {
    // The opposite escape hatch: a camera whose consumers are all jitter
    // sensitive can tighten below 2000 ms.
    const burst = ring(120, 1800)
    const { restreamer } = makeRestreamer(burst)
    restreamer.setPrimeBoundSupplier(() => ({ maxSpanMs: 1000, maxPackets: PRIME_MAX_PACKETS }))
    const viewer = createMockSocket()
    playSession(restreamer, viewer)

    restreamer.pushRtpPassthrough(rtpWithTimestamp(1800 * 90 + 3000), false, false)
    vi.advanceTimersByTime(1000)
    expect(countRtpFrames(viewer.written)).toBe(0)
  })

  it('applies a configured packet ceiling independently of the span', () => {
    const burst = ring(300, 200)
    const { restreamer } = makeRestreamer(burst)
    restreamer.setPrimeBoundSupplier(() => ({ maxSpanMs: PRIME_MAX_SPAN_MS, maxPackets: 100 }))
    const viewer = createMockSocket()
    playSession(restreamer, viewer)

    restreamer.pushRtpPassthrough(rtpWithTimestamp(200 * 90 + 3000), false, false)
    vi.advanceTimersByTime(5000)
    expect(countRtpFrames(viewer.written)).toBe(0)
  })

  it('reads the bound on EVERY join, not once at construction', () => {
    // A broker is created on the first dial and reused for the life of the
    // stream. A bound captured at construction would apply the value current
    // when the camera was first published and ignore every later edit — with
    // no symptom other than a burst that is or is not withheld.
    const burst = ring(187, 2996)
    const { restreamer } = makeRestreamer(burst)
    let bound: PrimeBurstBound = { maxSpanMs: 4500, maxPackets: PRIME_MAX_PACKETS }
    restreamer.setPrimeBoundSupplier(() => bound)

    const first = createMockSocket()
    playSession(restreamer, first)
    restreamer.pushRtpPassthrough(rtpWithTimestamp(2996 * 90 + 3000), false, false)
    vi.advanceTimersByTime(1000)
    expect(countRtpFrames(first.written)).toBe(burst.length + 1)

    // Operator tightens the bound. The SAME restreamer, a NEW join.
    bound = { maxSpanMs: 1000, maxPackets: PRIME_MAX_PACKETS }
    const second = createMockSocket()
    playSession(restreamer, second)
    restreamer.pushRtpPassthrough(rtpWithTimestamp(2996 * 90 + 6000), false, false)
    vi.advanceTimersByTime(1000)
    expect(countRtpFrames(second.written)).toBe(0)
  })

  it('still withholds from a MUTED session at its own tighter live-edge rule', () => {
    // LIVE_EDGE_MAX_SPAN_MS (500 ms) is a separate, tighter rule for the local
    // decoder loopback. Raising the join-burst bound must not relax it — a
    // muted decoder anchored 3 s in the past never drains that backlog.
    const burst = ring(187, 2996)
    const { restreamer } = makeRestreamer(burst)
    restreamer.setPrimeBoundSupplier(() => ({ maxSpanMs: 9000, maxPackets: PRIME_MAX_PACKETS }))
    const muted = createMockSocket()
    const session = new RtspSession(muted.socket, sdp, undefined, true)
    restreamer.addSession(session)
    muted.socket.emit(
      'data',
      Buffer.from(
        'SETUP rtsp://localhost/test/trackID=0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n',
      ),
    )
    muted.socket.emit('data', Buffer.from('PLAY rtsp://localhost/test RTSP/1.0\r\nCSeq: 2\r\n\r\n'))
    muted.written.length = 0

    restreamer.pushRtpPassthrough(rtpWithTimestamp(2996 * 90 + 3000), false, false)
    vi.advanceTimersByTime(1000)
    expect(countRtpFrames(muted.written)).toBe(0)
    // Sanity: the socket is not backlogged — the withhold is the live-edge
    // rule, not backpressure.
    muted.setWritableLength(0)
    expect(muted.socket.destroy).not.toHaveBeenCalled()
    expect(MAX_WRITE_BUFFER).toBeGreaterThan(0)
  })
})
