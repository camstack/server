/**
 * THE MISSING LINK between "the broker served a pre-roll window" and "a file on
 * disk contains it".
 *
 * D193's verification measured a served pre-roll span of 7.9–10.0 s on five
 * cameras (in the per-intent key that D381 has since collapsed into
 * `preRollSpanMs`) and concluded the delivery plan was proven. Then `ffprobe` on the
 * first segment of an attach (101/low, 2026-08-20) reported 12.001 s of media
 * for a segment whose file name was 12 000 ms older than its successor's — i.e.
 * media accumulated live, one packet at a time, with NO burst in it.
 *
 * Both measurements are real and neither can be reconciled with the other,
 * because NOTHING in the system ties the RTSP session that was served to the
 * writer that produced the file. `restream prime` names a `sessionId` the
 * recorder has never heard of; `recorder: writer spawned` names a device and a
 * profile the restreamer has never heard of. Every explanation for the gap —
 * ffmpeg discarded it, the dial carried no intent, the burst was abandoned
 * mid-flight — produces exactly the same pair of lines.
 *
 * So the join key is the one thing that already crosses the boundary: the
 * `User-Agent` the recorder's ffmpeg puts on its own RTSP dial. This file pins
 * that the restreamer REPORTS it, and reports the delivery OUTCOME separately
 * from the decision to serve — because "served" and "delivered" are different
 * facts and the paced replay can abort between them.
 */
import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RtspRestreamer } from '../rtsp/rtsp-restreamer.js'
import { RECORDING_PRE_ROLL_REQUEST_MS, type RestreamDeclaration } from '../rtsp/restream-intent.js'
import { RtspSession } from '../rtsp/rtsp-session.js'

/**
 * The declaration the shipped recording dial actually makes (D382): an intent
 * AND the amount of history it asks for. A test that declared only the intent
 * would be pinning the omission this record removed — the session would be
 * served nothing, which is now the correct answer to a dial that asked for
 * nothing.
 */
const RECORD_DECL: RestreamDeclaration = {
  intent: 'recording',
  preRollRequestMs: RECORDING_PRE_ROLL_REQUEST_MS,
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

interface MockSocket {
  readonly socket: Socket
  readonly written: Buffer[]
  /** Frames accepted before the socket claims a full write buffer. */
  backlogAfter: number
}

function createMockSocket(): MockSocket {
  const written: Buffer[] = []
  const state = { accepted: 0, backlogAfter: Number.POSITIVE_INFINITY }
  const emitter = new EventEmitter()
  const base = Object.assign(emitter, {
    write(chunk: Buffer | string): boolean {
      state.accepted++
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
  Object.defineProperty(base, 'writableLength', {
    get: () => (state.accepted >= state.backlogAfter ? 4 * 1024 * 1024 : 0),
  })
  Object.defineProperty(base, 'destroyed', { get: () => false })
  const socket = base as unknown as Socket
  activeSockets.push(socket)
  return {
    socket,
    written,
    get backlogAfter(): number {
      return state.backlogAfter
    },
    set backlogAfter(n: number) {
      state.backlogAfter = n
    },
  }
}

function rtpWithTimestamp(ts: number): Buffer {
  const pkt = Buffer.alloc(20)
  pkt[0] = 0x80
  pkt[1] = 0x60
  pkt.writeUInt32BE(ts >>> 0, 4)
  return pkt
}

function burst(count: number, spanMs: number, endTs: number): readonly Buffer[] {
  const step = count > 1 ? (spanMs * 90) / (count - 1) : 0
  const startTs = endTs - spanMs * 90
  return Array.from({ length: count }, (_, i) => rtpWithTimestamp(Math.round(startTs + i * step)))
}

const SDP = 'v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:trackID=0\r\n'
const LIVE_TS = 900_000
const GOP_BURST = burst(20, 400, LIVE_TS)
const PRE_ROLL_BURST = burst(200, 10_000, LIVE_TS)
/** Exactly what `buildPassthroughArgs` puts on the recorder's dial. */
const RECORDER_UA = 'recorder/101/low/7'

/** SETUP + PLAY, with the recorder's `User-Agent` on the first request. */
function playRecorderSession(
  restreamer: RtspRestreamer,
  mock: MockSocket,
  userAgent: string | null,
): void {
  const session = new RtspSession(mock.socket, SDP, undefined, false, RECORD_DECL)
  restreamer.addSession(session)
  const ua = userAgent === null ? '' : `User-Agent: ${userAgent}\r\n`
  mock.socket.emit(
    'data',
    Buffer.from(
      `SETUP rtsp://localhost/test/trackID=0 RTSP/1.0\r\nCSeq: 1\r\n${ua}Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n`,
    ),
  )
  mock.socket.emit('data', Buffer.from('PLAY rtsp://localhost/test RTSP/1.0\r\nCSeq: 2\r\n\r\n'))
  mock.written.length = 0
}

interface Logged {
  readonly msg: string
  readonly meta: Record<string, unknown>
  readonly tags: Record<string, unknown>
}

function capturingRestreamer(logged: Logged[]): RtspRestreamer {
  const restreamer = new RtspRestreamer('101/native:low')
  restreamer.setCameraSdp(SDP, 'h264', null)
  restreamer.setRtpPreBufferSupplier(() => GOP_BURST)
  // ONE window for this stream (D381) — the supplier takes no intent, so every
  // session that declares one is served the same retained history.
  restreamer.setPreRollSupplier(() => ({
    packets: () => PRE_ROLL_BURST,
    preRollMs: 10_000,
  }))
  const push = (
    msg: string,
    fields?: { meta?: Record<string, unknown>; tags?: Record<string, unknown> },
  ) => {
    logged.push({ msg, meta: fields?.meta ?? {}, tags: fields?.tags ?? {} })
  }
  const logger = {
    info: push,
    warn: push,
    error: push,
    debug: () => {},
    child: () => logger,
    withTags: () => logger,
  }
  restreamer.setLogger(logger as unknown as Parameters<RtspRestreamer['setLogger']>[0])
  return restreamer
}

describe('the pre-roll burst names the consumer that received it', () => {
  it('reports the recorder dial by its User-Agent, with the deviceId tag', () => {
    const logged: Logged[] = []
    const restreamer = capturingRestreamer(logged)
    const rec = createMockSocket()
    playRecorderSession(restreamer, rec, RECORDER_UA)
    restreamer.pushRtpPassthrough(rtpWithTimestamp(LIVE_TS + 3000), false, false)
    vi.advanceTimersByTime(2000)

    const served = logged.find((l) => l.msg.includes('pre-roll served'))
    expect(served).toBeDefined()
    // Without this, the only identity in the line is a random 16-hex sessionId
    // that appears in no recorder log line anywhere.
    expect(served!.meta.consumer).toBe(RECORDER_UA)
    expect(served!.meta.intent).toBe('recording')
    expect(served!.meta.packets).toBe(PRE_ROLL_BURST.length)
    expect(served!.meta.spanMs).toBe(10_000)
    expect(served!.tags).toMatchObject({ deviceId: 101 })
    expect(served!.meta.sessionId).toBeTypeOf('string')
  })

  it('says so when a dial declared the intent but carried no User-Agent', () => {
    const logged: Logged[] = []
    const restreamer = capturingRestreamer(logged)
    const rec = createMockSocket()
    playRecorderSession(restreamer, rec, null)
    restreamer.pushRtpPassthrough(rtpWithTimestamp(LIVE_TS + 3000), false, false)
    vi.advanceTimersByTime(2000)

    const served = logged.find((l) => l.msg.includes('pre-roll served'))
    expect(served?.meta.consumer).toBe('unknown')
  })
})

describe('SERVED is not DELIVERED — the replay reports its own outcome', () => {
  it('reports a fully drained pre-roll replay against the same consumer key', () => {
    const logged: Logged[] = []
    const restreamer = capturingRestreamer(logged)
    const rec = createMockSocket()
    playRecorderSession(restreamer, rec, RECORDER_UA)
    restreamer.pushRtpPassthrough(rtpWithTimestamp(LIVE_TS + 3000), false, false)
    vi.advanceTimersByTime(2000)

    const done = logged.find((l) => l.msg.includes('pre-roll replay'))
    expect(done).toBeDefined()
    expect(done!.meta.consumer).toBe(RECORDER_UA)
    expect(done!.meta.aborted).toBe(false)
    expect(done!.meta.packets).toBe(PRE_ROLL_BURST.length)
    // Nothing dropped: every replayed packet plus every live packet appended
    // behind it while the replay was in flight reached the socket.
    expect(done!.meta.sent).toBe(Number(done!.meta.packets) + Number(done!.meta.enqueuedLive))
    expect(done!.tags).toMatchObject({ deviceId: 101 })
  })

  it('reports an ABANDONED replay — the burst was decided, then not delivered', () => {
    // The failure mode that reads EXACTLY like a served window in today's logs:
    // `restream prime` says `preRollSpanMs=9421, preRollServed=1`, and the
    // paced replay then hits `MAX_WRITE_BUFFER` on ffmpeg's socket and
    // abandons the rest. The recorder's first segment starts at the live edge
    // and nothing anywhere says the history was dropped on the floor.
    const logged: Logged[] = []
    const restreamer = capturingRestreamer(logged)
    const rec = createMockSocket()
    playRecorderSession(restreamer, rec, RECORDER_UA)
    rec.backlogAfter = 40
    restreamer.pushRtpPassthrough(rtpWithTimestamp(LIVE_TS + 3000), false, false)
    vi.advanceTimersByTime(2000)

    const done = logged.find((l) => l.msg.includes('pre-roll replay'))
    expect(done).toBeDefined()
    expect(done!.meta.aborted).toBe(true)
    expect(done!.meta.sent).toBeLessThan(PRE_ROLL_BURST.length)
    expect(done!.meta.consumer).toBe(RECORDER_UA)
  })

  it('stays quiet for an ordinary viewer join — this pair of lines is per-intent', () => {
    const logged: Logged[] = []
    const restreamer = capturingRestreamer(logged)
    const viewer = createMockSocket()
    const session = new RtspSession(viewer.socket, SDP, undefined, false, undefined)
    restreamer.addSession(session)
    viewer.socket.emit(
      'data',
      Buffer.from(
        'SETUP rtsp://localhost/test/trackID=0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n',
      ),
    )
    viewer.socket.emit(
      'data',
      Buffer.from('PLAY rtsp://localhost/test RTSP/1.0\r\nCSeq: 2\r\n\r\n'),
    )
    restreamer.pushRtpPassthrough(rtpWithTimestamp(LIVE_TS + 3000), false, false)
    vi.advanceTimersByTime(2000)

    expect(logged.filter((l) => l.msg.includes('pre-roll'))).toEqual([])
  })
})
