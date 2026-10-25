import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import type { IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PRIME_MAX_PACKETS, PRIME_MAX_SPAN_MS, RtspRestreamer } from '../rtsp/rtsp-restreamer.js'
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
 * The RTSP join burst: pacing, bound, backpressure and drop visibility.
 *
 * Measured on the live hub before this suite existed: `servePendingSessionsRtp`
 * replayed the WHOLE retained GOP ring to every joining non-muted client in one
 * synchronous nested loop — 224 KB in 181 ms (9.9 Mbps against 485 kbps steady)
 * on 101/mid, 1.27 MB in 250 ms on 101/high. A HomeKit session that ended
 * 17:43:16.545Z reported maxJitter 272324 @90 kHz = 3030 ms, against a
 * `restream prime` burst logged at spanMs 2996 for that same session start —
 * the jitter the controller measured IS the burst span.
 *
 * The properties pinned here are the ones a "do all the packets arrive?" test
 * would pass against the broken code:
 *   1. no single synchronous turn emits the whole ring,
 *   2. total order is burst-then-live (a live packet never overtakes the tail),
 *   3. a burst wider than the bound is not replayed at all,
 *   4. a backlogged socket stops the burst instead of absorbing 24 MB,
 *   5. every drop is counted and logged.
 */

interface MockSocket {
  readonly socket: Socket
  readonly written: Buffer[]
  /** Force the socket's reported kernel backlog (drives the MAX_WRITE_BUFFER gate). */
  setWritableLength: (n: number) => void
  /** Report a backlog as soon as `n` frames have been written. */
  backlogAfterWrites: (n: number) => void
}

function createMockSocket(): MockSocket {
  const written: Buffer[] = []
  const emitter = new EventEmitter()
  let writableLength = 0
  let backlogAfter = Number.POSITIVE_INFINITY

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
  // backpressure assertion in this file vacuously pass.
  Object.defineProperty(base, 'writableLength', {
    get: () => (countRtpFrames(written) >= backlogAfter ? MAX_WRITE_BUFFER + 1 : writableLength),
  })
  Object.defineProperty(base, 'destroyed', { get: () => false })
  const socket = base as unknown as Socket

  return {
    socket,
    written,
    setWritableLength: (n) => {
      writableLength = n
    },
    backlogAfterWrites: (n) => {
      backlogAfter = n
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

/** Build a minimal RTP packet carrying the given 90 kHz timestamp. */
function rtpWithTimestamp(ts: number): Buffer {
  const pkt = Buffer.alloc(20)
  pkt[0] = 0x80
  pkt[1] = 0x60 // PT=96, marker=0
  pkt.writeUInt32BE(ts >>> 0, 4)
  return pkt
}

/** Interleaved RTP data frames ($-magic) written to a session's socket. */
function rtpFrames(written: readonly Buffer[]): readonly Buffer[] {
  return interleavedRecords(written)
}

function countRtpFrames(written: readonly Buffer[]): number {
  return rtpFrames(written).length
}

/** 90 kHz timestamps of the RTP packets written, in write order. */
function writtenTimestamps(written: readonly Buffer[]): readonly number[] {
  // frame = [$ , channel, len16, rtp…]; RTP timestamp is at rtp offset 4.
  return rtpFrames(written).map((f) => f.readUInt32BE(4 + 4))
}

const sdp = 'v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:trackID=0\r\n'

/** Add a session, drive it through SETUP + PLAY, and clear the response writes. */
function playSession(restreamer: RtspRestreamer, mock: MockSocket, muted: boolean): RtspSession {
  const session = new RtspSession(mock.socket, sdp, undefined, muted)
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

describe('RTSP join burst — pacing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('never emits the whole ring in one synchronous turn', () => {
    const burst = ring(300, 900)
    const { restreamer } = makeRestreamer(burst)
    const viewer = createMockSocket()
    playSession(restreamer, viewer, false)

    // A non-keyframe live packet triggers the prime.
    restreamer.pushRtpPassthrough(rtpWithTimestamp(900 * 90 + 3000), false, false)

    // Broken code writes all 300 here. Paced, the synchronous first chunk is
    // bounded by PACED_REPLAY_DEFAULTS (min 32 / max 128 packets per tick).
    const synchronous = countRtpFrames(viewer.written)
    expect(synchronous).toBeGreaterThan(0)
    expect(synchronous).toBeLessThanOrEqual(128)
    expect(synchronous).toBeLessThan(burst.length)

    vi.advanceTimersByTime(1000)

    // Completeness: every burst packet plus the live trigger, in order.
    expect(writtenTimestamps(viewer.written)).toEqual([
      ...burst.map((b) => b.readUInt32BE(4)),
      900 * 90 + 3000,
    ])
  })

  it('spreads the burst across several scheduler ticks', () => {
    const burst = ring(300, 900)
    const { restreamer } = makeRestreamer(burst)
    const viewer = createMockSocket()
    playSession(restreamer, viewer, false)

    restreamer.pushRtpPassthrough(rtpWithTimestamp(900 * 90 + 3000), false, false)

    const perTurn: number[] = [countRtpFrames(viewer.written)]
    for (let i = 0; i < 20 && countRtpFrames(viewer.written) < burst.length; i++) {
      const before = countRtpFrames(viewer.written)
      vi.advanceTimersByTime(5)
      perTurn.push(countRtpFrames(viewer.written) - before)
    }
    // At least 4 separate emission turns (300 packets at ≤128/tick).
    expect(perTurn.filter((n) => n > 0).length).toBeGreaterThanOrEqual(4)
  })

  it('keeps a small burst single-shot (no added latency for a short GOP)', () => {
    const burst = ring(8, 100)
    const { restreamer } = makeRestreamer(burst)
    const viewer = createMockSocket()
    playSession(restreamer, viewer, false)

    restreamer.pushRtpPassthrough(rtpWithTimestamp(100 * 90 + 3000), false, false)

    expect(countRtpFrames(viewer.written)).toBe(burst.length + 1)
  })

  it('delivers live packets arriving mid-replay BEHIND the replay tail', () => {
    const burst = ring(300, 900)
    const { restreamer } = makeRestreamer(burst)
    const viewer = createMockSocket()
    playSession(restreamer, viewer, false)

    const base = 900 * 90
    restreamer.pushRtpPassthrough(rtpWithTimestamp(base + 3000), false, false)
    // Two more live packets while the replay is still draining.
    expect(countRtpFrames(viewer.written)).toBeLessThan(burst.length)
    restreamer.pushRtpPassthrough(rtpWithTimestamp(base + 6000), false, false)
    restreamer.pushRtpPassthrough(rtpWithTimestamp(base + 9000), false, false)

    vi.advanceTimersByTime(1000)

    const ts = writtenTimestamps(viewer.written)
    expect(ts).toEqual([
      ...burst.map((b) => b.readUInt32BE(4)),
      base + 3000,
      base + 6000,
      base + 9000,
    ])
  })

  it('does not re-prime a session whose replay is still in flight', () => {
    const burst = ring(300, 900)
    const { restreamer } = makeRestreamer(burst)
    const viewer = createMockSocket()
    playSession(restreamer, viewer, false)

    const base = 900 * 90
    for (let i = 1; i <= 5; i++)
      restreamer.pushRtpPassthrough(rtpWithTimestamp(base + i * 3000), false, false)
    vi.advanceTimersByTime(1000)

    // 300 burst + 5 live, each exactly once — no duplicated burst.
    expect(countRtpFrames(viewer.written)).toBe(burst.length + 5)
  })

  it('stops the paced burst when a session goes away mid-replay', () => {
    const burst = ring(300, 900)
    const { restreamer } = makeRestreamer(burst)
    const viewer = createMockSocket()
    const session = playSession(restreamer, viewer, false)

    restreamer.pushRtpPassthrough(rtpWithTimestamp(900 * 90 + 3000), false, false)
    const before = countRtpFrames(viewer.written)
    restreamer.removeSession(session.getSessionId())

    vi.advanceTimersByTime(1000)
    expect(countRtpFrames(viewer.written)).toBe(before)
  })
})

describe('RTSP join burst — bound', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('withholds a burst wider than PRIME_MAX_SPAN_MS and joins at the next keyframe', () => {
    // The measured HomeKit case: 187 packets spanning 2996 ms.
    const burst = ring(187, 2996)
    expect(2996).toBeGreaterThan(PRIME_MAX_SPAN_MS)
    const { restreamer, logger } = makeRestreamer(burst)
    const viewer = createMockSocket()
    playSession(restreamer, viewer, false)

    restreamer.pushRtpPassthrough(rtpWithTimestamp(2996 * 90 + 3000), false, false)
    vi.advanceTimersByTime(1000)
    expect(countRtpFrames(viewer.written)).toBe(0)
    expect(logger.warn).toHaveBeenCalled()

    // The next live keyframe AU start unlatches it — first frame = the live edge.
    restreamer.pushRtpPassthrough(rtpWithTimestamp(2996 * 90 + 6000), true, false)
    vi.advanceTimersByTime(1000)
    expect(writtenTimestamps(viewer.written)).toEqual([2996 * 90 + 6000])
  })

  it('serves a burst at the span bound', () => {
    const burst = ring(120, PRIME_MAX_SPAN_MS)
    const { restreamer } = makeRestreamer(burst)
    const viewer = createMockSocket()
    playSession(restreamer, viewer, false)

    restreamer.pushRtpPassthrough(rtpWithTimestamp(PRIME_MAX_SPAN_MS * 90 + 3000), false, false)
    vi.advanceTimersByTime(1000)
    expect(countRtpFrames(viewer.written)).toBe(burst.length + 1)
  })

  it('withholds a burst over PRIME_MAX_PACKETS even when its span is short', () => {
    const burst = ring(PRIME_MAX_PACKETS + 1, 200)
    const { restreamer } = makeRestreamer(burst)
    const viewer = createMockSocket()
    playSession(restreamer, viewer, false)

    restreamer.pushRtpPassthrough(rtpWithTimestamp(200 * 90 + 3000), false, false)
    vi.advanceTimersByTime(5000)
    expect(countRtpFrames(viewer.written)).toBe(0)
  })
})

describe('RTSP join burst — backpressure', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('aborts the prime instead of pushing the ring into a backlogged socket', () => {
    const burst = ring(300, 900)
    const { restreamer, logger } = makeRestreamer(burst)
    const viewer = createMockSocket()
    viewer.backlogAfterWrites(10)
    playSession(restreamer, viewer, false)

    restreamer.pushRtpPassthrough(rtpWithTimestamp(900 * 90 + 3000), false, false)
    vi.advanceTimersByTime(2000)

    // Ten written, then the backlog gate stops the burst — the broken code
    // wrote all 300 regardless of `writableLength`.
    expect(countRtpFrames(viewer.written)).toBe(10)
    expect(logger.warn).toHaveBeenCalled()
    // The socket is NOT closed: our own catch-up burst must never kill a client.
    expect(viewer.socket.destroy).not.toHaveBeenCalled()
  })

  it('logs a non-muted client on LIVE-path backlog, and does NOT close it', () => {
    const burst = ring(4, 20)
    const { restreamer, logger } = makeRestreamer(burst)
    const viewer = createMockSocket()
    playSession(restreamer, viewer, false)

    // Join burst first (single-shot, under singleShotMax).
    restreamer.pushRtpPassthrough(rtpWithTimestamp(20 * 90 + 3000), false, false)
    vi.advanceTimersByTime(100)
    viewer.setWritableLength(MAX_WRITE_BUFFER + 1)
    restreamer.pushRtpPassthrough(rtpWithTimestamp(20 * 90 + 6000), false, false)

    // This assertion used to be `destroy` HAS been called: a non-muted client
    // was closed on its FIRST backlogged packet. That rule asked who the
    // session was, and it is what killed the recorder's own pull 899 times in
    // 24 h on 2026-09-01 — see `rtsp-backlog-liveness.spec.ts` for the measured
    // chain and the keyframe bound that replaced it. Being momentarily behind
    // is no longer a verdict on anyone.
    expect(viewer.socket.destroy).not.toHaveBeenCalled()

    // The property this test has always really defended: the drop is REPORTED,
    // per camera. Silence here read as "never happened" for three hours once.
    const warned = vi
      .mocked(logger.warn)
      .mock.calls.some(([, extras]) => extras?.tags?.deviceId === 101)
    expect(warned).toBe(true)
  })

  it('logs the drop-until-keyframe latch on a muted session', () => {
    const burst = ring(4, 20)
    const { restreamer, logger } = makeRestreamer(burst)
    const muted = createMockSocket()
    playSession(restreamer, muted, true)

    // Near-live burst (span 20 ms ≤ 500 ms) so the muted session joins.
    restreamer.pushRtpPassthrough(rtpWithTimestamp(20 * 90 + 3000), false, false)
    vi.advanceTimersByTime(100)
    muted.setWritableLength(MAX_WRITE_BUFFER + 1)
    restreamer.pushRtpPassthrough(rtpWithTimestamp(20 * 90 + 6000), false, false)

    // Muted sessions are latched, never closed…
    expect(muted.socket.destroy).not.toHaveBeenCalled()
    // …and the latch is no longer silent.
    const warned = vi
      .mocked(logger.warn)
      .mock.calls.some(([, extras]) => extras?.tags?.deviceId === 101)
    expect(warned).toBe(true)
  })
})
