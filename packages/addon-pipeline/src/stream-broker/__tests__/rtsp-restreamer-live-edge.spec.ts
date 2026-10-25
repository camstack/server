import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RtspRestreamer } from '../rtsp/rtsp-restreamer.js'
import { RtspSession } from '../rtsp/rtsp-session.js'

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

const activeSockets: Array<{ destroy: () => void }> = []

afterEach(() => {
  for (const s of activeSockets) s.destroy()
  activeSockets.length = 0
})

/** Create a minimal mock socket that captures writes without streams. */
function createMockSocket(): { socket: Socket; written: Buffer[] } {
  const written: Buffer[] = []
  const emitter = new EventEmitter()

  const socket = Object.assign(emitter, {
    write(chunk: Buffer | string): boolean {
      if (Buffer.isBuffer(chunk)) written.push(Buffer.from(chunk))
      else written.push(Buffer.from(chunk))
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
    get writableLength() {
      return 0
    },
    get destroyed() {
      return false
    },
  }) as unknown as Socket

  activeSockets.push(socket)
  return { socket, written }
}

/** Build a minimal RTP packet with the given 90kHz timestamp. */
function rtpWithTimestamp(ts: number): Buffer {
  const pkt = Buffer.alloc(20)
  pkt[0] = 0x80
  pkt[1] = 0x60 // PT=96, marker=0
  pkt.writeUInt32BE(ts >>> 0, 4)
  return pkt
}

/** Add a session, drive it through SETUP + PLAY, and clear the response writes. */
function playSession(
  restreamer: RtspRestreamer,
  socket: Socket,
  written: Buffer[],
  session: RtspSession,
): void {
  restreamer.addSession(session)
  socket.emit(
    'data',
    Buffer.from(
      'SETUP rtsp://localhost/test/trackID=0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n',
    ),
  )
  socket.emit('data', Buffer.from('PLAY rtsp://localhost/test RTSP/1.0\r\nCSeq: 2\r\n\r\n'))
  written.length = 0
}

/** Count interleaved RTP data frames ($-magic) written to a session's socket. */
function countRtpFrames(written: Buffer[]): number {
  return interleavedRecords(written).length
}

describe('RtspRestreamer live-edge join for muted sessions', () => {
  const sdp = 'v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:trackID=0\r\n'

  it('withholds a >500ms-span GOP burst from a muted session while serving a non-muted one', () => {
    const restreamer = new RtspRestreamer('test-stream')
    restreamer.setCameraSdp(sdp, 'h264', null)

    // GOP burst spanning 1000ms (> LIVE_EDGE_MAX_SPAN_MS of 500ms): 0 → 90000 ticks.
    const burst = [rtpWithTimestamp(0), rtpWithTimestamp(90_000)] as const
    restreamer.setRtpPreBufferSupplier(() => burst)

    const muted = createMockSocket()
    const viewer = createMockSocket()
    playSession(
      restreamer,
      muted.socket,
      muted.written,
      new RtspSession(muted.socket, sdp, undefined, true),
    )
    playSession(
      restreamer,
      viewer.socket,
      viewer.written,
      new RtspSession(viewer.socket, sdp, undefined, false),
    )

    // A non-keyframe packet triggers servePendingSessionsRtp (the burst prime)
    // without unlatching the muted session at a keyframe boundary.
    restreamer.pushRtpPassthrough(rtpWithTimestamp(90_100), false, false)

    // Non-muted (viewer/recorder) gets the full 2-packet burst for instant start.
    expect(countRtpFrames(viewer.written)).toBeGreaterThanOrEqual(2)
    // Muted (local decoder) is left pending — it must start at the live edge.
    expect(countRtpFrames(muted.written)).toBe(0)
  })

  it('unlatches a pending muted session at the next live keyframe AU start', () => {
    const restreamer = new RtspRestreamer('test-stream')
    restreamer.setCameraSdp(sdp, 'h264', null)

    const burst = [rtpWithTimestamp(0), rtpWithTimestamp(90_000)] as const
    restreamer.setRtpPreBufferSupplier(() => burst)

    const muted = createMockSocket()
    playSession(
      restreamer,
      muted.socket,
      muted.written,
      new RtspSession(muted.socket, sdp, undefined, true),
    )

    // Full-GOP burst is withheld → muted stays pending, receives nothing.
    restreamer.pushRtpPassthrough(rtpWithTimestamp(90_100), false, false)
    expect(countRtpFrames(muted.written)).toBe(0)

    // A live keyframe AU start unlatches the muted session; it receives this
    // exact keyframe packet (its first frame = the live edge).
    restreamer.pushRtpPassthrough(rtpWithTimestamp(180_000), true, false)
    expect(countRtpFrames(muted.written)).toBeGreaterThanOrEqual(1)
  })
})

describe('RtspRestreamer keyframe RTP cache while client-less', () => {
  const sdp = 'v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:trackID=0\r\n'

  /** Feed one GOP (parameter set + keyframe + trailing P-frame) to the restreamer. */
  function pushGop(restreamer: RtspRestreamer, baseTs: number): void {
    restreamer.pushRtpPassthrough(rtpWithTimestamp(baseTs), false, true) // parameter set
    restreamer.pushRtpPassthrough(rtpWithTimestamp(baseTs), true, false) // keyframe
    restreamer.pushRtpPassthrough(rtpWithTimestamp(baseTs + 3000), false, false) // P-frame
  }

  it('resets the keyframe cache each GOP with zero sessions, so a late joiner gets one GOP', () => {
    const restreamer = new RtspRestreamer('test-stream')
    restreamer.setCameraSdp(sdp, 'h264', null)
    // No ring supplier → a late joiner is primed from the cached keyframe AU,
    // which is the array that leaks when the per-GOP latch never closes.

    // Ingest many GOPs while completely client-less. With the leak, every
    // keyframe/parameter-set packet appends forever (P-frames were dropped
    // before the terminating latch); fixed, only the last GOP survives.
    const GOPS = 8
    for (let i = 0; i < GOPS; i++) pushGop(restreamer, i * 90_000)

    // A non-muted client joins now and is served the cached keyframe AU.
    const viewer = createMockSocket()
    playSession(
      restreamer,
      viewer.socket,
      viewer.written,
      new RtspSession(viewer.socket, sdp, undefined, false),
    )
    // Trigger servePendingSessionsRtp with a P-frame (does not extend the cache).
    restreamer.pushRtpPassthrough(rtpWithTimestamp(GOPS * 90_000), false, false)

    // One GOP AU (paramset + keyframe + trailing P = 3) plus the trigger packet
    // broadcast to the now-live session = 4. The leak would prime the joiner
    // with GOPS*2 (=16) accumulated keyframe packets instead.
    expect(countRtpFrames(viewer.written)).toBeLessThanOrEqual(4)
  })

  /** A large (64 KB) RTP packet, as an RTSP-over-TCP camera sends whole NALs. */
  function rtpLarge(ts: number, sizeBytes: number): Buffer {
    const pkt = Buffer.alloc(sizeBytes)
    pkt[0] = 0x80
    pkt[1] = 0x60 // PT=96, marker=0
    pkt.writeUInt32BE(ts >>> 0, 4)
    return pkt
  }

  it('hard-bounds the keyframe cache when the latch never closes (all-intra stream)', () => {
    const restreamer = new RtspRestreamer('test-stream')
    restreamer.setCameraSdp(sdp, 'h264', null)

    // An all-intra stream: every packet is a keyframe, a P-frame never arrives,
    // so the per-GOP latch never closes. Without the defensive byte cap the
    // cache accumulates every packet forever (this is what reached ~1.5 GB).
    // 2000 × 64 KB = 128 MB of ingest, well past the 16 MB cap.
    const PKT = 60 * 1000
    for (let i = 0; i < 2000; i++)
      restreamer.pushRtpPassthrough(rtpLarge(i * 3000, PKT), true, false)

    // A viewer joins and is primed from whatever is currently cached. The cap
    // resets the cache every ~16 MB (~256 packets), so the prime burst is
    // bounded to << the 2000 ingested. Close the GOP to trigger the prime.
    const viewer = createMockSocket()
    playSession(
      restreamer,
      viewer.socket,
      viewer.written,
      new RtspSession(viewer.socket, sdp, undefined, false),
    )
    restreamer.pushRtpPassthrough(rtpLarge(2000 * 3000, PKT), false, false)

    // Cap = 16 MB / 60 KB ≈ 279 packets max retained; +1 trigger broadcast.
    // The unbounded leak would prime ~2000. Assert the burst is safely bounded.
    expect(countRtpFrames(viewer.written)).toBeLessThanOrEqual(300)
  })
})

/**
 * The muted withhold is the branch that decides a decode session starts BLIND
 * for up to one IDR interval, and it was the only drop in this file that
 * incremented nothing and logged nothing: `withheld` counts only the non-muted
 * over-bound branch, so `reportDrops` was never even called, and the `restream
 * prime (lat-probe)` info line returns early when nothing was served. A muted
 * join that was withheld therefore produced NO line at all.
 *
 * That silence is what made device 108 unexplainable: an 8.0 s IDR interval
 * means ~94% of its decode dials are withheld here (a ring burst is only
 * accepted at span ≤ 500 ms) and then wait for the next live keyframe — the
 * dominant term in a first-frame latency that reached 30-40 s and expired the
 * session-decode cold-start budget.
 */
describe('RtspRestreamer muted-withhold visibility', () => {
  const sdp = 'v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:trackID=0\r\n'

  function makeLogger() {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: () => logger,
      withTags: () => logger,
    }
    return logger
  }

  it('reports a withheld muted join with the deviceId and the reason', () => {
    const restreamer = new RtspRestreamer('108/native:main')
    const logger = makeLogger()
    restreamer.setLogger(logger)
    restreamer.setCameraSdp(sdp, 'h264', null)

    // A 1000ms-span ring burst — over LIVE_EDGE_MAX_SPAN_MS (500ms).
    const burst = [rtpWithTimestamp(0), rtpWithTimestamp(90_000)] as const
    restreamer.setRtpPreBufferSupplier(() => burst)

    const muted = createMockSocket()
    playSession(
      restreamer,
      muted.socket,
      muted.written,
      new RtspSession(muted.socket, sdp, undefined, true),
    )

    restreamer.pushRtpPassthrough(rtpWithTimestamp(90_100), false, false)

    // Still withheld — the behaviour is deliberate and unchanged.
    expect(countRtpFrames(muted.written)).toBe(0)
    // …but no longer silent.
    expect(logger.warn).toHaveBeenCalledWith(
      'restream dropped packets',
      expect.objectContaining({
        tags: { deviceId: 108 },
        meta: expect.objectContaining({ primeWithheldMutedLiveEdge: 1 }),
      }),
    )
  })

  it('reports a withheld muted join when the ring is cold (keyframe-only fallback)', () => {
    const restreamer = new RtspRestreamer('108/native:main')
    const logger = makeLogger()
    restreamer.setLogger(logger)
    restreamer.setCameraSdp(sdp, 'h264', null)
    // No ring supplier → `fromRing` false → the degenerate keyframe-only
    // fallback, which a muted session must also refuse.
    restreamer.pushRtpPassthrough(rtpWithTimestamp(0), true, false)
    restreamer.pushRtpPassthrough(rtpWithTimestamp(3000), false, false)

    const muted = createMockSocket()
    playSession(
      restreamer,
      muted.socket,
      muted.written,
      new RtspSession(muted.socket, sdp, undefined, true),
    )
    restreamer.pushRtpPassthrough(rtpWithTimestamp(6000), false, false)

    expect(countRtpFrames(muted.written)).toBe(0)
    expect(logger.warn).toHaveBeenCalledWith(
      'restream dropped packets',
      expect.objectContaining({
        tags: { deviceId: 108 },
        meta: expect.objectContaining({ primeWithheldMutedLiveEdge: 1 }),
      }),
    )
  })
})
