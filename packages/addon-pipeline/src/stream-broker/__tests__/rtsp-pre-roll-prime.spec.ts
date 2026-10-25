/**
 * The prebuffer, at the JOIN: who is handed the history the ring retained.
 *
 * `rtsp-detection-intent-prime.spec.ts` (Stage 0) pins that a detection dial is
 * exempt from the live-edge withhold and takes the current-GOP burst. This file
 * pins the next step and, above all, its BLAST RADIUS: the retained window goes
 * to sessions that DECLARED an intent (detection or recording) and to nobody
 * else.
 *
 * The failure this guards against is not subtle, it is just invisible until a
 * controller complains: a viewer, a recorder leg or a HomeKit ffmpeg copy
 * handed seconds of backlog re-clocks it into peer-visible jitter — the
 * measured D57 failure (a 2 996 ms burst became 3 030 ms of jitter). So every
 * test here that asserts what detection receives has a sibling asserting that
 * the session next to it received the ordinary burst, or nothing.
 */
import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  for (const s of activeSockets) s.destroy()
  activeSockets.length = 0
})

function createMockSocket(): { socket: Socket; written: Buffer[] } {
  const written: Buffer[] = []
  const emitter = new EventEmitter()
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
  })
  Object.defineProperty(base, 'writableLength', { get: () => 0 })
  Object.defineProperty(base, 'destroyed', { get: () => false })
  const socket = base as unknown as Socket
  activeSockets.push(socket)
  return { socket, written }
}

/** A minimal RTP packet at a 90 kHz timestamp. */
function rtpWithTimestamp(ts: number): Buffer {
  const pkt = Buffer.alloc(20)
  pkt[0] = 0x80
  pkt[1] = 0x60 // PT=96, marker=0
  pkt.writeUInt32BE(ts >>> 0, 4)
  return pkt
}

/** `count` packets spanning `spanMs`, ending at `endTs`. */
function burst(count: number, spanMs: number, endTs: number): readonly Buffer[] {
  const step = count > 1 ? (spanMs * 90) / (count - 1) : 0
  const startTs = endTs - spanMs * 90
  return Array.from({ length: count }, (_, i) => rtpWithTimestamp(Math.round(startTs + i * step)))
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

function countRtpFrames(written: readonly Buffer[]): number {
  return interleavedRecords(written).length
}

const SDP = 'v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:trackID=0\r\n'

const LIVE_TS = 900_000
/** The current GOP: 20 packets over 400 ms — inside the live-edge rule. */
const GOP_BURST = burst(20, 400, LIVE_TS)
/** The pre-roll window: the same GOP plus 3.6 s of history before it. */
const PRE_ROLL_BURST = burst(200, 4000, LIVE_TS)

function detectionSession(socket: Socket): RtspSession {
  return new RtspSession(socket, SDP, undefined, true, DETECT_DECL)
}

describe('RtspRestreamer — pre-roll on the detection join', () => {
  it('hands the detection dial the PRE-ROLL window, not just the current GOP', () => {
    const restreamer = new RtspRestreamer('101/native:main')
    restreamer.setCameraSdp(SDP, 'h264', null)
    restreamer.setRtpPreBufferSupplier(() => GOP_BURST)
    restreamer.setPreRollSupplier(() => ({
      packets: () => PRE_ROLL_BURST,
      preRollMs: 4000,
    }))

    const detect = createMockSocket()
    playSession(restreamer, detect.socket, detect.written, detectionSession(detect.socket))
    restreamer.pushRtpPassthrough(rtpWithTimestamp(LIVE_TS + 3000), false, false)
    vi.advanceTimersByTime(1000)

    expect(countRtpFrames(detect.written)).toBeGreaterThan(GOP_BURST.length)
  })

  it('hands a plain muted session and a viewer the ordinary burst — never the pre-roll', () => {
    const restreamer = new RtspRestreamer('101/native:main')
    restreamer.setCameraSdp(SDP, 'h264', null)
    restreamer.setRtpPreBufferSupplier(() => GOP_BURST)
    restreamer.setPreRollSupplier(() => ({
      packets: () => PRE_ROLL_BURST,
      preRollMs: 4000,
    }))

    const detect = createMockSocket()
    const muted = createMockSocket()
    const viewer = createMockSocket()
    playSession(restreamer, detect.socket, detect.written, detectionSession(detect.socket))
    playSession(
      restreamer,
      muted.socket,
      muted.written,
      new RtspSession(muted.socket, SDP, undefined, true),
    )
    playSession(
      restreamer,
      viewer.socket,
      viewer.written,
      new RtspSession(viewer.socket, SDP, undefined, false),
    )

    restreamer.pushRtpPassthrough(rtpWithTimestamp(LIVE_TS + 3000), false, false)
    vi.advanceTimersByTime(1000)

    expect(countRtpFrames(detect.written)).toBeGreaterThan(GOP_BURST.length)
    // The muted leg's burst spans 400 ms — inside the live-edge rule, so it IS
    // served, and what it is served is the current GOP and nothing more.
    expect(countRtpFrames(muted.written)).toBe(GOP_BURST.length + 1)
    expect(countRtpFrames(viewer.written)).toBe(GOP_BURST.length + 1)
  })

  it('preRollMs 0 leaves the detection join exactly where Stage 0 left it', () => {
    const restreamer = new RtspRestreamer('101/native:main')
    restreamer.setCameraSdp(SDP, 'h264', null)
    restreamer.setRtpPreBufferSupplier(() => GOP_BURST)
    // A broker with pre-roll off still answers the supplier — with the window
    // it would serve, which is the current GOP.
    restreamer.setPreRollSupplier(() => ({
      packets: () => GOP_BURST,
      preRollMs: 0,
    }))

    const detect = createMockSocket()
    playSession(restreamer, detect.socket, detect.written, detectionSession(detect.socket))
    restreamer.pushRtpPassthrough(rtpWithTimestamp(LIVE_TS + 3000), false, false)
    vi.advanceTimersByTime(1000)

    expect(countRtpFrames(detect.written)).toBe(GOP_BURST.length + 1)
  })

  it('admits a burst the D57 bound alone would withhold — up to preRollMs, no further', () => {
    // 4 s of media is double the 2 000 ms join-burst bound. It is served
    // because the operator asked for 4 s of pre-roll on THIS stream, and only
    // to the session that declared the detection intent.
    const restreamer = new RtspRestreamer('101/native:main')
    restreamer.setCameraSdp(SDP, 'h264', null)
    restreamer.setRtpPreBufferSupplier(() => GOP_BURST)
    restreamer.setPreRollSupplier(() => ({
      packets: () => PRE_ROLL_BURST,
      preRollMs: 4000,
    }))

    const detect = createMockSocket()
    playSession(restreamer, detect.socket, detect.written, detectionSession(detect.socket))
    restreamer.pushRtpPassthrough(rtpWithTimestamp(LIVE_TS + 3000), false, false)
    vi.advanceTimersByTime(1000)

    expect(countRtpFrames(detect.written)).toBeGreaterThanOrEqual(PRE_ROLL_BURST.length)
  })

  it('WITHHOLDS a window wider than the pre-roll the operator configured', () => {
    // The selector cannot produce this, but a supplier bug or a camera whose
    // current GOP alone is wider can. The restreamer re-checks rather than
    // trusting its input: over the bound the session joins at the next live
    // keyframe, clean, exactly as D57 prescribes.
    const restreamer = new RtspRestreamer('101/native:main')
    restreamer.setCameraSdp(SDP, 'h264', null)
    restreamer.setRtpPreBufferSupplier(() => burst(20, 2600, LIVE_TS))
    restreamer.setPreRollSupplier(() => ({
      packets: () => burst(200, 5000, LIVE_TS),
      preRollMs: 2000,
    }))

    const detect = createMockSocket()
    playSession(restreamer, detect.socket, detect.written, detectionSession(detect.socket))
    restreamer.pushRtpPassthrough(rtpWithTimestamp(LIVE_TS + 3000), false, false)
    vi.advanceTimersByTime(1000)

    expect(countRtpFrames(detect.written)).toBe(0)
  })

  it('falls back to the current GOP when the ring retained no history', () => {
    const restreamer = new RtspRestreamer('101/native:main')
    restreamer.setCameraSdp(SDP, 'h264', null)
    restreamer.setRtpPreBufferSupplier(() => GOP_BURST)
    // Pre-roll ON, but the broker had nothing older to give (a source that was
    // idle when motion fired).
    restreamer.setPreRollSupplier(() => ({
      packets: () => [],
      preRollMs: 4000,
    }))

    const detect = createMockSocket()
    playSession(restreamer, detect.socket, detect.written, detectionSession(detect.socket))
    restreamer.pushRtpPassthrough(rtpWithTimestamp(LIVE_TS + 3000), false, false)
    vi.advanceTimersByTime(1000)

    expect(countRtpFrames(detect.written)).toBe(GOP_BURST.length + 1)
  })

  it('needs no supplier at all — an unwired restreamer behaves as it always did', () => {
    const restreamer = new RtspRestreamer('101/native:main')
    restreamer.setCameraSdp(SDP, 'h264', null)
    restreamer.setRtpPreBufferSupplier(() => GOP_BURST)

    const detect = createMockSocket()
    playSession(restreamer, detect.socket, detect.written, detectionSession(detect.socket))
    restreamer.pushRtpPassthrough(rtpWithTimestamp(LIVE_TS + 3000), false, false)
    vi.advanceTimersByTime(1000)

    expect(countRtpFrames(detect.written)).toBe(GOP_BURST.length + 1)
  })
})

/**
 * The RECORDING intent (audit 2026-08-20, defect 2 — "pre-roll di fatto zero").
 *
 * An `events`-band recorder spawns its writer AT the trigger, so its footage
 * began after the event: measured on 1438, the footage started after the motion
 * in 60 % of episodes. The recorder is an RTSP client of this restreamer, so
 * the pre-roll the ring already retains is exactly the missing seconds — but it
 * is a NON-muted consumer (it records audio) and the detection suffix cannot
 * carry it without muting the recording.
 *
 * So the recorder declares its own intent, on the non-muted path. The blast
 * radius is pinned the same way Stage 2 pinned detection's: the viewer sitting
 * next to it still gets the ordinary current-GOP burst.
 */
function recordingSession(socket: Socket): RtspSession {
  return new RtspSession(socket, SDP, undefined, false, RECORD_DECL)
}

describe('RtspRestreamer — pre-roll on the recording join', () => {
  it('hands a RECORDING dial the pre-roll window, so the first segment predates the trigger', () => {
    const restreamer = new RtspRestreamer('1438/native:main')
    restreamer.setCameraSdp(SDP, 'h264', null)
    restreamer.setRtpPreBufferSupplier(() => GOP_BURST)
    restreamer.setPreRollSupplier(() => ({
      packets: () => PRE_ROLL_BURST,
      preRollMs: 4000,
    }))

    const rec = createMockSocket()
    playSession(restreamer, rec.socket, rec.written, recordingSession(rec.socket))

    restreamer.pushRtpPassthrough(rtpWithTimestamp(LIVE_TS), true, false)
    vi.advanceTimersByTime(1000)

    expect(countRtpFrames(rec.written)).toBeGreaterThanOrEqual(PRE_ROLL_BURST.length)
  })

  it('leaves the plain VIEWER next to it on the current GOP', () => {
    const restreamer = new RtspRestreamer('1438/native:main')
    restreamer.setCameraSdp(SDP, 'h264', null)
    restreamer.setRtpPreBufferSupplier(() => GOP_BURST)
    restreamer.setPreRollSupplier(() => ({
      packets: () => PRE_ROLL_BURST,
      preRollMs: 4000,
    }))

    const rec = createMockSocket()
    const viewer = createMockSocket()
    playSession(restreamer, rec.socket, rec.written, recordingSession(rec.socket))
    playSession(
      restreamer,
      viewer.socket,
      viewer.written,
      new RtspSession(viewer.socket, SDP, undefined, false),
    )

    restreamer.pushRtpPassthrough(rtpWithTimestamp(LIVE_TS), true, false)
    vi.advanceTimersByTime(1000)

    expect(countRtpFrames(rec.written)).toBeGreaterThanOrEqual(PRE_ROLL_BURST.length)
    expect(countRtpFrames(viewer.written)).toBeLessThan(PRE_ROLL_BURST.length)
  })
})

/**
 * ONE WINDOW, EVERY DECLARED INTENT (D381).
 *
 * There is no longer a window per intent to reconcile: the broker retains THE
 * prebuffer and the restreamer builds ONE plan per serve, shared by every
 * session that declared an intent. A recorder and a detection dial joining the
 * same keyframe are handed the same packets — the ring is mapped once — and the
 * per-intent numbers survive only as WHO joined, never as how much.
 *
 * What stays pinned is the blast radius, unchanged since D57: the plain viewer
 * beside them still sees the ordinary current-GOP burst.
 */
describe('RtspRestreamer — one window, served to every declared intent', () => {
  /** 10 s of retained history — the one window this stream holds. */
  const PREBUFFER_BURST = burst(400, 10_000, LIVE_TS)

  function oneWindowRestreamer(): RtspRestreamer {
    const restreamer = new RtspRestreamer('1438/native:main')
    restreamer.setCameraSdp(SDP, 'h264', null)
    restreamer.setRtpPreBufferSupplier(() => GOP_BURST)
    // No intent argument: the supplier cannot answer differently per consumer,
    // which is what makes "how much history does 1438 hold" one question.
    restreamer.setPreRollSupplier(() => ({
      packets: () => PREBUFFER_BURST,
      preRollMs: 10_000,
    }))
    return restreamer
  }

  it('serves the recorder and the detection dial beside it the SAME window', () => {
    const restreamer = oneWindowRestreamer()
    const record = createMockSocket()
    const detect = createMockSocket()
    playSession(
      restreamer,
      record.socket,
      record.written,
      new RtspSession(record.socket, SDP, undefined, false, RECORD_DECL),
    )
    playSession(restreamer, detect.socket, detect.written, detectionSession(detect.socket))
    restreamer.pushRtpPassthrough(rtpWithTimestamp(LIVE_TS + 3000), false, false)
    vi.advanceTimersByTime(2000)

    // Both declared an intent, so both take the retained window plus the live
    // packet that triggered the serve — one plan, mapped from the ring once.
    expect(countRtpFrames(record.written)).toBe(PREBUFFER_BURST.length + 1)
    expect(countRtpFrames(detect.written)).toBe(PREBUFFER_BURST.length + 1)
  })

  it('a 10 s burst is not withheld for exceeding the plain join-burst bound', () => {
    // The bound is widened by the window this stream RETAINS. Holding a
    // prebuffer burst to the plain D57 bound would withhold the whole thing —
    // the knob reading ON and behaving OFF, one layer below D192.
    const restreamer = oneWindowRestreamer()
    restreamer.setPrimeBoundSupplier(() => ({
      maxSpanMs: 2000,
      maxPackets: 2000,
    }))
    const record = createMockSocket()
    playSession(
      restreamer,
      record.socket,
      record.written,
      new RtspSession(record.socket, SDP, undefined, false, RECORD_DECL),
    )
    restreamer.pushRtpPassthrough(rtpWithTimestamp(LIVE_TS + 3000), false, false)
    vi.advanceTimersByTime(2000)

    expect(countRtpFrames(record.written)).toBe(PREBUFFER_BURST.length + 1)
  })

  it('the plain VIEWER beside both still sees one GOP — the D57 blast radius', () => {
    const restreamer = oneWindowRestreamer()
    const record = createMockSocket()
    const viewer = createMockSocket()
    playSession(
      restreamer,
      record.socket,
      record.written,
      new RtspSession(record.socket, SDP, undefined, false, RECORD_DECL),
    )
    playSession(
      restreamer,
      viewer.socket,
      viewer.written,
      new RtspSession(viewer.socket, SDP, undefined, false, undefined),
    )
    restreamer.pushRtpPassthrough(rtpWithTimestamp(LIVE_TS + 3000), false, false)
    vi.advanceTimersByTime(2000)

    expect(countRtpFrames(viewer.written)).toBe(GOP_BURST.length + 1)
    expect(countRtpFrames(record.written)).toBe(PREBUFFER_BURST.length + 1)
  })
})

/**
 * THE LINE HAS TO ANSWER A PER-CAMERA QUESTION.
 *
 * Found live on 2026-08-20: the prime line printed a pre-roll of `0` on cameras
 * whose pre-roll was 10 000, because the number was read off the plan and a
 * plan is only built when a session that wants history is joining. "The
 * operator turned it off" and "nobody joined this burst" printed identically —
 * on the SAME camera, minutes apart. A measure that lies is worse than no
 * measure.
 *
 * Under D381 the line carries `prebufferMs` (what this stream RETAINS, read
 * from the configuration on every serve) and `preRollSpanMs` (what the ring
 * could DELIVER, `-1` when nobody asked). The four per-intent durations are
 * gone with the two windows they measured; what remains per intent is who
 * joined: `recordingIntentServed` / `detectionPreRollServed`.
 */
/** One captured log line. Module scope: two describe blocks read it. */
interface Logged {
  readonly msg: string
  readonly meta: Record<string, unknown>
}

describe('RtspRestreamer — the prime line names the prebuffer, always', () => {
  function capturingRestreamer(logged: Logged[]): RtspRestreamer {
    const restreamer = new RtspRestreamer('1438/native:main')
    restreamer.setCameraSdp(SDP, 'h264', null)
    restreamer.setRtpPreBufferSupplier(() => GOP_BURST)
    // Configured for 10 s; the ring only holds the 4 s of `PRE_ROLL_BURST`.
    restreamer.setPreRollSupplier(() => ({
      packets: () => PRE_ROLL_BURST,
      preRollMs: 10_000,
    }))
    const logger = {
      info: (msg: string, fields?: { meta?: Record<string, unknown> }) => {
        logged.push({ msg, meta: fields?.meta ?? {} })
      },
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => logger,
      withTags: () => logger,
    }
    restreamer.setLogger(logger as unknown as Parameters<RtspRestreamer['setLogger']>[0])
    return restreamer
  }

  it('names the prebuffer on a burst only a plain VIEWER joined', () => {
    const logged: Logged[] = []
    const restreamer = capturingRestreamer(logged)
    const viewer = createMockSocket()
    playSession(
      restreamer,
      viewer.socket,
      viewer.written,
      new RtspSession(viewer.socket, SDP, undefined, false, undefined),
    )
    restreamer.pushRtpPassthrough(rtpWithTimestamp(LIVE_TS + 3000), false, false)
    vi.advanceTimersByTime(2000)

    const prime = logged.find((l) => l.msg.includes('restream prime'))
    // Read from the configuration, not off a plan that was never built.
    expect(prime?.meta.prebufferMs).toBe(10_000)
    // …and it says NOBODY who wanted history joined, which is a different fact
    // from "the prebuffer is off" and from "the ring had nothing to give".
    expect(prime?.meta.preRollSpanMs).toBe(-1)
    expect(prime?.meta.recordingIntentServed).toBe(false)
    expect(prime?.meta.detectionPreRollServed).toBe(false)
  })

  it('does NOT count a recorder as a detection session', () => {
    // Measured live 2026-08-20 on the very lines that had just been fixed for
    // the same class of lie: a burst whose only pre-roll consumer was ffmpeg
    // reported `detectionIntentServed=1`.
    const logged: Logged[] = []
    const restreamer = capturingRestreamer(logged)
    const record = createMockSocket()
    playSession(
      restreamer,
      record.socket,
      record.written,
      new RtspSession(record.socket, SDP, undefined, false, RECORD_DECL),
    )
    restreamer.pushRtpPassthrough(rtpWithTimestamp(LIVE_TS + 3000), false, false)
    vi.advanceTimersByTime(2000)

    const prime = logged.find((l) => l.msg.includes('restream prime'))
    expect(prime?.meta.detectionIntentServed).toBe(0)
    expect(prime?.meta.detectionPreRollServed).toBe(false)
    expect(prime?.meta.recordingIntentServed).toBe(true)
    expect(prime?.meta.preRollServed).toBe(1)
  })

  it('reports the DELIVERED span next to the window that was configured', () => {
    const logged: Logged[] = []
    const restreamer = capturingRestreamer(logged)
    const record = createMockSocket()
    playSession(
      restreamer,
      record.socket,
      record.written,
      new RtspSession(record.socket, SDP, undefined, false, RECORD_DECL),
    )
    restreamer.pushRtpPassthrough(rtpWithTimestamp(LIVE_TS + 3000), false, false)
    vi.advanceTimersByTime(2000)

    const prime = logged.find((l) => l.msg.includes('restream prime'))
    expect(prime?.meta.prebufferMs).toBe(10_000)
    // The ring only held 4 s of the 10 s configured — the honest degradation,
    // and it must stay distinguishable from the prebuffer being off.
    expect(prime?.meta.preRollSpanMs).toBe(4000)
    expect(prime?.meta.recordingIntentServed).toBe(true)
  })
})

/**
 * D382 — HISTORY GOES TO WHOEVER ASKED FOR IT, IN THE AMOUNT THEY ASKED.
 *
 * D381 left the ask implicit: a dial that declared an intent was served the
 * whole retained window, and detection declares its intent for an unrelated
 * reason (the live-edge exemption). So every detection dial on the fleet was
 * handed a recording-sized backlog nobody had decided it should have — the same
 * shape of defect (a value acting without a decision) that D381 itself retired.
 *
 * Every test below dies if the `requestedMs > 0` gate or the per-request plan
 * is removed: the first by serving history to a session that asked for none,
 * the third by serving one window to two sessions that asked for two.
 */
function declaring(socket: Socket, decl: RestreamDeclaration): RtspSession {
  return new RtspSession(socket, SDP, undefined, decl.intent !== 'recording', decl)
}

/** A supplier that HONOURS the request, as the broker's does via the cap. */
function requestHonouringRestreamer(retainedMs: number, logged?: Logged[]): RtspRestreamer {
  const restreamer = new RtspRestreamer('101/native:main')
  restreamer.setCameraSdp(SDP, 'h264', null)
  restreamer.setRtpPreBufferSupplier(() => GOP_BURST)
  restreamer.setPreRollSupplier(() => ({
    // `PRE_ROLL_BURST` is 200 packets over 4 000 ms, so a request of `n` ms
    // takes the newest `n/4000` of it — what `selectPreRollStart` does on the
    // real ring, keyframe alignment aside.
    packets: (requestedMs: number) => {
      const served = Math.min(requestedMs, retainedMs, 4000)
      const take = Math.max(GOP_BURST.length, Math.round((served / 4000) * 200))
      return PRE_ROLL_BURST.slice(PRE_ROLL_BURST.length - take)
    },
    preRollMs: retainedMs,
  }))
  if (logged) {
    const logger = {
      info: (msg: string, fields?: { meta?: Record<string, unknown> }) => {
        logged.push({ msg, meta: fields?.meta ?? {} })
      },
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => logger,
      withTags: () => logger,
    }
    restreamer.setLogger(logger as unknown as Parameters<RtspRestreamer['setLogger']>[0])
  }
  return restreamer
}

describe('D382 — an intent without an amount asks for nothing', () => {
  it('serves the ordinary current-GOP burst to a detection dial that named no amount', () => {
    const restreamer = requestHonouringRestreamer(4000)
    const detect = createMockSocket()
    playSession(
      restreamer,
      detect.socket,
      detect.written,
      declaring(detect.socket, { intent: 'detection', preRollRequestMs: 0 }),
    )
    restreamer.pushRtpPassthrough(rtpWithTimestamp(LIVE_TS + 3000), false, false)
    vi.advanceTimersByTime(1000)

    // The GOP plus the packet that triggered the serve — byte-for-byte what a
    // plain muted session next to it receives, and what detection received for
    // as long as there was no prebuffer at all.
    expect(countRtpFrames(detect.written)).toBe(GOP_BURST.length + 1)
  })

  it('still lifts the LIVE-EDGE withhold for that same session — the intent buys what it always bought', () => {
    // The reason detection dials this path in the first place (Stage 0). A
    // 1 900 ms burst is over `LIVE_EDGE_MAX_SPAN_MS`, so a plain muted session
    // is withheld it; the detection dial takes it even though it asked for no
    // history at all. Losing this would trade one regression for another.
    const restreamer = new RtspRestreamer('101/native:main')
    restreamer.setCameraSdp(SDP, 'h264', null)
    restreamer.setRtpPreBufferSupplier(() => burst(20, 1900, LIVE_TS))
    const detect = createMockSocket()
    const muted = createMockSocket()
    playSession(
      restreamer,
      detect.socket,
      detect.written,
      declaring(detect.socket, { intent: 'detection', preRollRequestMs: 0 }),
    )
    playSession(
      restreamer,
      muted.socket,
      muted.written,
      new RtspSession(muted.socket, SDP, undefined, true),
    )
    restreamer.pushRtpPassthrough(rtpWithTimestamp(LIVE_TS + 3000), false, false)
    vi.advanceTimersByTime(1000)

    expect(countRtpFrames(detect.written)).toBe(21)
    expect(countRtpFrames(muted.written)).toBe(0)
  })

  it('serves two sessions that asked for different amounts two different windows', () => {
    // One plan per stream would hand whichever joined first its window to both.
    const restreamer = requestHonouringRestreamer(4000)
    const small = createMockSocket()
    const large = createMockSocket()
    playSession(
      restreamer,
      small.socket,
      small.written,
      declaring(small.socket, { intent: 'detection', preRollRequestMs: 1000 }),
    )
    playSession(
      restreamer,
      large.socket,
      large.written,
      declaring(large.socket, { intent: 'recording', preRollRequestMs: 15_000 }),
    )
    restreamer.pushRtpPassthrough(rtpWithTimestamp(LIVE_TS + 3000), false, false)
    vi.advanceTimersByTime(2000)

    const smallFrames = countRtpFrames(small.written)
    const largeFrames = countRtpFrames(large.written)
    expect(smallFrames).toBeGreaterThan(GOP_BURST.length)
    expect(largeFrames).toBeGreaterThan(smallFrames)
  })
})

describe('D382 — one line per attach, and it can answer "what did the burst cost"', () => {
  it('names the history delivered and the time to the live edge, tagged by device', () => {
    const logged: Logged[] = []
    const restreamer = requestHonouringRestreamer(4000, logged)
    const detect = createMockSocket()
    playSession(
      restreamer,
      detect.socket,
      detect.written,
      declaring(detect.socket, { intent: 'detection', preRollRequestMs: 15_000 }),
    )
    restreamer.pushRtpPassthrough(rtpWithTimestamp(LIVE_TS + 3000), false, false)
    vi.advanceTimersByTime(2000)

    const attach = logged.find((l) => l.msg.includes('attach live-edge'))
    expect(attach).toBeDefined()
    expect(attach?.meta.intent).toBe('detection')
    expect(attach?.meta.requestedMs).toBe(15_000)
    expect(attach?.meta.retainedMs).toBe(4000)
    // The history BEYOND the ordinary join burst — the number the whole
    // question is about. `burstSpanMs - gopSpanMs`, so a plain join reads 0 and
    // the two populations are comparable on one line.
    expect(attach?.meta.preRollSpanMs).toBe(3600)
    expect(attach?.meta.gopSpanMs).toBe(400)
    expect(typeof attach?.meta.liveEdgeMs).toBe('number')
    expect(attach?.meta.liveEdgeMs).not.toBe(-1)
  })

  it('reports a HISTORY-FREE attach too — the control group the cost is measured against', () => {
    const logged: Logged[] = []
    const restreamer = requestHonouringRestreamer(4000, logged)
    const viewer = createMockSocket()
    playSession(
      restreamer,
      viewer.socket,
      viewer.written,
      new RtspSession(viewer.socket, SDP, undefined, false),
    )
    restreamer.pushRtpPassthrough(rtpWithTimestamp(LIVE_TS + 3000), false, false)
    vi.advanceTimersByTime(2000)

    const attach = logged.find((l) => l.msg.includes('attach live-edge'))
    expect(attach).toBeDefined()
    expect(attach?.meta.intent).toBe('none')
    expect(attach?.meta.requestedMs).toBe(0)
    expect(attach?.meta.preRollSpanMs).toBe(0)
  })
})
