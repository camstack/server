/**
 * Stage 0 of the motion-start parity work: a DETECTION decode session no
 * longer starts BLIND.
 *
 * `servePendingSessionsRtp` withholds the prime burst from every MUTED session
 * whose ring burst spans more than `LIVE_EDGE_MAX_SPAN_MS` (500 ms). That rule
 * was measured for re-clocked consumers (HomeKit-style legs) with ~zero decode
 * headroom, which never drain a 2-3 s backlog. A per-session DETECTION decode
 * is the opposite population: it decodes at source rate and publishes throttled
 * by the FrameSlot, so it drains the burst and starts producing frames at once.
 *
 * On a ~2 s-GOP camera the withhold means ~3 dials in 4 wait for the NEXT live
 * IDR before the first decoded frame — the 5.6→8.4 s spread on the blind ramp
 * between motion and the first inferenced frame, inside which camera 101's two
 * missed notifications happened.
 *
 * The exemption is gated on an EXPLICIT per-session intent (`/muted-detection`
 * on the dial path), never on `isMuted()` alone — the WebRTC/HomeKit muted
 * consumers keep today's behaviour byte-for-byte, which the second test here
 * pins.
 */
import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RtspRestreamer } from '../rtsp/rtsp-restreamer.js'
import {
  DETECTION_PRE_ROLL_REQUEST_MS,
  RECORDING_PRE_ROLL_REQUEST_MS,
  type RestreamDeclaration,
} from '../rtsp/restream-intent.js'
import { RtspSession } from '../rtsp/rtsp-session.js'

/**
 * The declarations the two shipped dials actually make (D382): an intent AND
 * the amount of history it asks for. A test that declared only the intent would
 * be pinning the omission this record removed — the session would be served
 * nothing, which is now the correct answer to a dial that asked for nothing.
 */
const DETECT_DECL: RestreamDeclaration = {
  intent: 'detection',
  preRollRequestMs: DETECTION_PRE_ROLL_REQUEST_MS,
}
const RECORD_DECL: RestreamDeclaration = {
  intent: 'recording',
  preRollRequestMs: RECORDING_PRE_ROLL_REQUEST_MS,
}

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

function createMockSocket(): { socket: Socket; written: Buffer[] } {
  const written: Buffer[] = []
  const emitter = new EventEmitter()
  const socket = Object.assign(emitter, {
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

function countRtpFrames(written: Buffer[]): number {
  return interleavedRecords(written).length
}

const SDP = 'v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:trackID=0\r\n'

/** A 1900 ms-span ring burst: over LIVE_EDGE_MAX_SPAN_MS (500), under the D57 bound (2000). */
const BURST_1900MS = [rtpWithTimestamp(0), rtpWithTimestamp(171_000)] as const

describe('RtspRestreamer — detection-intent join exemption', () => {
  it('serves the FULL burst to a detection-intent session at spanMs 1900', () => {
    const restreamer = new RtspRestreamer('101/native:main')
    restreamer.setCameraSdp(SDP, 'h264', null)
    restreamer.setRtpPreBufferSupplier(() => BURST_1900MS)

    const detect = createMockSocket()
    playSession(
      restreamer,
      detect.socket,
      detect.written,
      new RtspSession(detect.socket, SDP, undefined, true, DETECT_DECL),
    )

    // A non-keyframe packet triggers the prime WITHOUT unlatching anyone at a
    // live keyframe boundary — so anything received here came from the burst.
    restreamer.pushRtpPassthrough(rtpWithTimestamp(171_100), false, false)

    expect(countRtpFrames(detect.written)).toBeGreaterThanOrEqual(2)
  })

  it('still WITHHOLDS the same burst from a plain muted session (byte-for-byte today)', () => {
    const restreamer = new RtspRestreamer('101/native:main')
    restreamer.setCameraSdp(SDP, 'h264', null)
    restreamer.setRtpPreBufferSupplier(() => BURST_1900MS)

    const muted = createMockSocket()
    playSession(
      restreamer,
      muted.socket,
      muted.written,
      new RtspSession(muted.socket, SDP, undefined, true),
    )

    restreamer.pushRtpPassthrough(rtpWithTimestamp(171_100), false, false)

    expect(countRtpFrames(muted.written)).toBe(0)
  })

  it('exempts ONLY the detection session when both join the same stream', () => {
    const restreamer = new RtspRestreamer('101/native:main')
    restreamer.setCameraSdp(SDP, 'h264', null)
    restreamer.setRtpPreBufferSupplier(() => BURST_1900MS)

    const detect = createMockSocket()
    const muted = createMockSocket()
    playSession(
      restreamer,
      detect.socket,
      detect.written,
      new RtspSession(detect.socket, SDP, undefined, true, DETECT_DECL),
    )
    playSession(
      restreamer,
      muted.socket,
      muted.written,
      new RtspSession(muted.socket, SDP, undefined, true),
    )

    restreamer.pushRtpPassthrough(rtpWithTimestamp(171_100), false, false)

    expect(countRtpFrames(detect.written)).toBeGreaterThanOrEqual(2)
    expect(countRtpFrames(muted.written)).toBe(0)
  })

  it('serves a detection-intent session a burst OVER the span bound — the 4 s-GOP case', () => {
    // THE BEHAVIOUR CHANGE, and the case the whole fleet sits in. This test
    // used to assert the opposite ("keeps the D57 join-burst bound over a
    // detection-intent session"), on the reasoning that the bound is a property
    // of the stream. It is a property of the CONSUMER: D57 exists because a
    // burst becomes jitter for something that RE-EMITS on a real-time clock,
    // and a detection decode drains it instead.
    //
    // Measured over 6 h of the live fleet, whose cameras run 100-frame GOPs at
    // 25 fps (a 4 000 ms IDR interval): a burst's span at join is the time
    // since the last IDR, uniform in `[0, IDR]`, so a fixed 2 000 ms bound
    // withheld detection on roughly half of every camera's dials — 44-61 %
    // served. The only three cameras served on ~100 % of joins were the three
    // fastest in the fleet (first frame 1 487 / 1 655 / 1 946 ms, against
    // 4 531-10 807 ms for the rest).
    const restreamer = new RtspRestreamer('101/native:main')
    restreamer.setCameraSdp(SDP, 'h264', null)
    // 3000 ms span — mid-GOP on a 4000 ms-IDR camera, over the D57 bound.
    restreamer.setRtpPreBufferSupplier(() => [rtpWithTimestamp(0), rtpWithTimestamp(270_000)])

    const detect = createMockSocket()
    playSession(
      restreamer,
      detect.socket,
      detect.written,
      new RtspSession(detect.socket, SDP, undefined, true, DETECT_DECL),
    )

    restreamer.pushRtpPassthrough(rtpWithTimestamp(270_100), false, false)

    expect(countRtpFrames(detect.written)).toBeGreaterThanOrEqual(2)
  })

  it('WITHHOLDS that same over-bound burst from a recording leg, on the same stream', () => {
    // The regression that would cost HomeKit stability, pinned explicitly: the
    // exemption is per-consumer, so a leg that re-clocks what it receives must
    // still be withheld by D57 on a stream where detection is now served. A
    // recording dial is NOT muted (it keeps its audio), so the span bound is
    // what binds it — the live-edge rule never applied to it.
    const restreamer = new RtspRestreamer('101/native:main')
    restreamer.setCameraSdp(SDP, 'h264', null)
    restreamer.setRtpPreBufferSupplier(() => [rtpWithTimestamp(0), rtpWithTimestamp(270_000)])

    const detect = createMockSocket()
    const record = createMockSocket()
    playSession(
      restreamer,
      detect.socket,
      detect.written,
      new RtspSession(detect.socket, SDP, undefined, true, DETECT_DECL),
    )
    playSession(
      restreamer,
      record.socket,
      record.written,
      new RtspSession(record.socket, SDP, undefined, false, RECORD_DECL),
    )

    restreamer.pushRtpPassthrough(rtpWithTimestamp(270_100), false, false)

    expect(countRtpFrames(detect.written)).toBeGreaterThanOrEqual(2)
    expect(countRtpFrames(record.written)).toBe(0)
  })

  it('WITHHOLDS that same over-bound burst from a HomeKit-style muted leg', () => {
    const restreamer = new RtspRestreamer('101/native:main')
    restreamer.setCameraSdp(SDP, 'h264', null)
    restreamer.setRtpPreBufferSupplier(() => [rtpWithTimestamp(0), rtpWithTimestamp(270_000)])

    const detect = createMockSocket()
    const homekit = createMockSocket()
    playSession(
      restreamer,
      detect.socket,
      detect.written,
      new RtspSession(detect.socket, SDP, undefined, true, DETECT_DECL),
    )
    playSession(
      restreamer,
      homekit.socket,
      homekit.written,
      new RtspSession(homekit.socket, SDP, undefined, true),
    )

    restreamer.pushRtpPassthrough(rtpWithTimestamp(270_100), false, false)

    expect(countRtpFrames(detect.written)).toBeGreaterThanOrEqual(2)
    expect(countRtpFrames(homekit.written)).toBe(0)
  })

  it('a detection-intent session receives no audio — it is still a MUTED session', () => {
    const restreamer = new RtspRestreamer('101/native:main')
    restreamer.setCameraSdp(SDP, 'h264', null)

    const detect = createMockSocket()
    const session = new RtspSession(detect.socket, SDP, undefined, true, DETECT_DECL)
    playSession(restreamer, detect.socket, detect.written, session)

    expect(session.isMuted()).toBe(true)
    restreamer.pushAudioRtpPassthrough(rtpWithTimestamp(1000))
    expect(countRtpFrames(detect.written)).toBe(0)
  })
})
