import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import type { IScopedLogger, StreamSource } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PRIME_MAX_SPAN_MS } from '../rtsp/rtsp-restreamer.js'
import { RtspSession } from '../rtsp/rtsp-session.js'
import { StreamBroker } from '../stream-broker/stream-broker.js'

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
 * WebRTC IS EXEMPT FROM THE JOIN-BURST BOUND, AND MUST STAY EXEMPT.
 *
 * The operator's requirement is absolute: WebRTC must always be able to take
 * the last GOP. A browser/viewer peer terminates the media itself — it does not
 * re-emit on a real-time clock, so it does not forward the burst's compression
 * to anyone, and it is protected instead by `PacedRtpReplay` spreading the same
 * bytes over ~300 ms. The D57 bound exists for the OTHER shape of consumer: an
 * ffmpeg copy of the restream URL (the HomeKit leg) that re-clocks what it
 * receives and turns burst span into peer-visible jitter.
 *
 * A grep is not a proof of that exemption, because the two paths are NOT
 * independent. They share one surface:
 *
 *     StreamBroker.getRtpPreBuffer()
 *       ├─ rtsp/rtsp-restreamer.ts  ← setRtpPreBufferSupplier  (BOUNDED, D57)
 *       └─ webrtc/session.ts        ← rtpBootstrap             (UNBOUNDED)
 *
 * so the realistic way WebRTC gets starved is not someone editing
 * `session.ts` — it is someone "improving" the bound by trimming the RING or
 * `getRtpPreBuffer()` itself, one level ABOVE the split, which reads as a
 * tidier fix and silently takes WebRTC's GOP with it. These tests fail if the
 * withholding decision ever migrates above that fork.
 *
 * The second shared mechanism is the `pendingKeyframe` latch. D57 removed an
 * `isMuted()` test from the unlatch loop in `pushRtpPassthrough` so it now
 * covers EVERY still-pending session. That loop iterates
 * `RtspRestreamer.sessions` — RTSP sessions only. WebRTC subscribers attach via
 * `StreamBroker.onVideoRtp` and are in a different collection entirely, so the
 * widened loop cannot reach them; the third test pins that by driving both
 * consumers off one packet stream.
 */

const RTP_HEADER_SIZE = 12

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

interface RtpPacketOptions {
  readonly seq: number
  readonly timestamp: number
  readonly marker: boolean
  readonly payload: Buffer
}

function buildRtpPacket(opts: RtpPacketOptions): Buffer {
  const header = Buffer.alloc(RTP_HEADER_SIZE)
  header[0] = 0x80
  header[1] = (opts.marker ? 0x80 : 0x00) | 96
  header.writeUInt16BE(opts.seq & 0xffff, 2)
  header.writeUInt32BE(opts.timestamp >>> 0, 4)
  header.writeUInt32BE(0x11223344, 8)
  return Buffer.concat([header, opts.payload])
}

function nalPayload(nalType: number, body: Buffer): Buffer {
  const nri = 0x60
  return Buffer.concat([Buffer.from([nri | nalType]), body])
}

interface GopState {
  readonly seq: number
  readonly ts: number
}

/** One packet of a synthetic GOP: its bytes plus the two flags the native
 *  reader derives from its depacketizer before forwarding. */
interface GopPacket {
  readonly rtp: Buffer
  readonly isKeyframe: boolean
  readonly isParameterSet: boolean
}

/**
 * Deliver one source RTP packet exactly as the NATIVE RTSP reader does.
 *
 * This must mirror `StreamBroker`'s own fan-out order, because the shortcut
 * does not work: `pushVideoRtp` (the `push-rtp` provider entry point) fills the
 * ring and the `onVideoRtp` subscribers but NEVER calls
 * `rtspRestreamer.pushRtpPassthrough` — the push provider owns the Annex-B
 * plane. Driving these tests through `pushVideoRtp` alone would leave the
 * restreamer with zero packets, and every "the RTSP consumer received nothing"
 * assertion below would pass because nothing was ever offered to it. The
 * positive-control test at the end of this file exists to keep that from
 * silently returning.
 */
function deliver(broker: StreamBroker, pkt: GopPacket): void {
  broker.getRtspRestreamer().pushRtpPassthrough(pkt.rtp, pkt.isKeyframe, pkt.isParameterSet)
  broker.pushVideoRtp(pkt.rtp)
}

/**
 * Push one keyframe AU (SPS, PPS, IDR) then `pCount` P-slices, advancing the
 * RTP clock by `stepTicks` (90 kHz) per frame. A GOP of `pCount` P-frames at
 * `stepTicks` therefore spans `pCount * stepTicks / 90` ms — which is how these
 * tests build a burst deliberately WIDER than the RTSP bound.
 */
function pushGop(
  broker: StreamBroker,
  state: GopState,
  pCount: number,
  stepTicks: number,
): GopState {
  let seq = state.seq
  let ts = state.ts

  deliver(broker, {
    rtp: buildRtpPacket({
      seq: seq++,
      timestamp: ts,
      marker: false,
      payload: nalPayload(7, Buffer.from([0x42, 0x00, 0x1f])),
    }),
    isKeyframe: false,
    isParameterSet: true,
  })
  deliver(broker, {
    rtp: buildRtpPacket({
      seq: seq++,
      timestamp: ts,
      marker: false,
      payload: nalPayload(8, Buffer.from([0xce, 0x3c, 0x80])),
    }),
    isKeyframe: false,
    isParameterSet: true,
  })
  deliver(broker, {
    rtp: buildRtpPacket({
      seq: seq++,
      timestamp: ts,
      marker: true,
      payload: nalPayload(5, Buffer.alloc(64, 0xab)),
    }),
    isKeyframe: true,
    isParameterSet: false,
  })
  ts += stepTicks

  for (let i = 0; i < pCount; i++) {
    deliver(broker, {
      rtp: buildRtpPacket({
        seq: seq++,
        timestamp: ts,
        marker: true,
        payload: nalPayload(1, Buffer.alloc(48, 0xcd)),
      }),
      isKeyframe: false,
      isParameterSet: false,
    })
    ts += stepTicks
  }

  return { seq, ts }
}

/** 90 kHz span of a pre-buffer snapshot, in ms — the exact quantity D57 bounds. */
function spanMs(packets: readonly Buffer[]): number {
  if (packets.length === 0) return 0
  const first = packets[0]!.readUInt32BE(4)
  const last = packets[packets.length - 1]!.readUInt32BE(4)
  return ((last - first) | 0) / 90
}

function pushRtpSource(): StreamSource {
  return { type: 'push-rtp', url: '', videoCodec: 'h264' }
}

// ── RTSP session harness (the BOUNDED consumer, for the contrast test) ──

interface MockSocket {
  readonly socket: Socket
  readonly written: Buffer[]
}

function createMockSocket(): MockSocket {
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
    remoteAddress: '127.0.0.1',
    remotePort: 55555,
  })
  // DEFINED, not spread — `Object.assign` copies a getter's current VALUE, and
  // a `writableLength` frozen at 0 makes a withhold indistinguishable from a
  // socket that silently absorbed everything.
  Object.defineProperty(base, 'writableLength', { get: () => 0 })
  Object.defineProperty(base, 'destroyed', { get: () => false })
  return { socket: base as unknown as Socket, written }
}

const sessionSdp =
  'v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:trackID=0\r\n'

function attachRtspSession(broker: StreamBroker, mock: MockSocket): void {
  const restreamer = broker.getRtspRestreamer()
  restreamer.setCameraSdp(sessionSdp, 'h264', null)
  const session = new RtspSession(mock.socket, sessionSdp, undefined, false)
  restreamer.addSession(session)
  mock.socket.emit(
    'data',
    Buffer.from(
      'SETUP rtsp://localhost/test/trackID=0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n',
    ),
  )
  mock.socket.emit('data', Buffer.from('PLAY rtsp://localhost/test RTSP/1.0\r\nCSeq: 2\r\n\r\n'))
  mock.written.length = 0
}

function countRtpFrames(written: readonly Buffer[]): number {
  return interleavedRecords(written).length
}

describe('WebRTC is exempt from the RTSP join-burst bound', () => {
  let broker: StreamBroker

  beforeEach(() => {
    vi.useFakeTimers()
    broker = new StreamBroker('101/native', createMockLogger())
  })

  afterEach(async () => {
    await broker.stop()
    vi.useRealTimers()
  })

  it('POSITIVE CONTROL: the RTSP consumer IS served a burst inside the bound', async () => {
    // Without this test the whole file is vacuous. `pushVideoRtp` does not
    // feed the restreamer, so a harness that forgot `pushRtpPassthrough`
    // would satisfy every "RTSP received nothing" assertion below while
    // proving nothing at all. This pins that the harness genuinely reaches
    // the RTSP path — a narrow GOP (900 ms, inside PRIME_MAX_SPAN_MS) must
    // arrive in full.
    await broker.start(pushRtpSource())
    const mock = createMockSocket()
    attachRtspSession(broker, mock)

    // 9 P-frames at 100 ms → span 900 ms, comfortably under the bound.
    pushGop(broker, { seq: 1000, ts: 90000 }, 9, 9000)
    vi.advanceTimersByTime(1000)

    expect(countRtpFrames(mock.written)).toBeGreaterThan(0)
    expect(spanMs(broker.getRtpPreBuffer())).toBeLessThan(PRIME_MAX_SPAN_MS)
  })

  it('hands WebRTC the WHOLE GOP when its span far exceeds the RTSP bound', async () => {
    await broker.start(pushRtpSource())

    // A 4 s GOP: 40 P-frames at 100 ms. Span 4000 ms — double the bound.
    pushGop(broker, { seq: 1000, ts: 90000 }, 40, 9000)

    // `rtpBootstrap` in `webrtc/broker-webrtc-server.ts` is literally
    // `() => broker.getRtpPreBuffer()`, so this IS the WebRTC join burst.
    const bootstrap = broker.getRtpPreBuffer()
    expect(spanMs(bootstrap)).toBeGreaterThan(PRIME_MAX_SPAN_MS)
    // Complete: the keyframe AU (3 packets) plus every P-slice. Withholding or
    // trimming at this level would starve WebRTC.
    expect(bootstrap.length).toBe(43)
    expect(bootstrap[0]!.readUInt32BE(4)).toBe(90000)
  })

  it('leaves the shared pre-buffer intact on the very join the RTSP path withholds', async () => {
    await broker.start(pushRtpSource())

    // The realistic shape: the GOP has ALREADY accumulated when the client
    // arrives. (A client attached before the first packet joins at span 0 and
    // is served — that is correct, and it is not the case D57 bounds.)
    const afterGop = pushGop(broker, { seq: 1000, ts: 90000 }, 40, 9000)
    const mock = createMockSocket()
    attachRtspSession(broker, mock)

    // One more live packet drives `servePendingSessionsRtp` for the new join.
    deliver(broker, {
      rtp: buildRtpPacket({
        seq: afterGop.seq,
        timestamp: afterGop.ts,
        marker: true,
        payload: nalPayload(1, Buffer.alloc(48, 0xcd)),
      }),
      isKeyframe: false,
      isParameterSet: false,
    })
    vi.advanceTimersByTime(1000)

    // The RTSP consumer is withheld — this is D57 doing its job…
    expect(countRtpFrames(mock.written)).toBe(0)
    // …and the shared ring the WebRTC path reads is UNAFFECTED by that
    // decision. If a future change bounds the ring instead of the consumer,
    // this is the assertion that breaks.
    const bootstrap = broker.getRtpPreBuffer()
    expect(spanMs(bootstrap)).toBeGreaterThan(PRIME_MAX_SPAN_MS)
    expect(bootstrap.length).toBe(44)
  })

  it('does not latch a WebRTC subscriber behind the RTSP pendingKeyframe gate', async () => {
    await broker.start(pushRtpSource())
    const afterGop = pushGop(broker, { seq: 1000, ts: 90000 }, 40, 9000)
    const mock = createMockSocket()
    attachRtspSession(broker, mock)

    // A WebRTC session subscribes through `onVideoRtp` — a different
    // collection from `RtspRestreamer.sessions`, which is what the widened
    // unlatch loop in `pushRtpPassthrough` iterates.
    const webrtcReceived: Buffer[] = []
    const unsub = broker.onVideoRtp((rtpData) => {
      webrtcReceived.push(rtpData)
    })

    // Five more live P-slices, all inside the withheld window.
    let { seq, ts } = afterGop
    for (let i = 0; i < 5; i++) {
      deliver(broker, {
        rtp: buildRtpPacket({
          seq: seq++,
          timestamp: ts,
          marker: true,
          payload: nalPayload(1, Buffer.alloc(48, 0xcd)),
        }),
        isKeyframe: false,
        isParameterSet: false,
      })
      ts += 9000
    }
    vi.advanceTimersByTime(1000)

    // RTSP: withheld, still pending, nothing written.
    expect(countRtpFrames(mock.written)).toBe(0)
    // WebRTC: every packet, live, with no keyframe latch of its own.
    expect(webrtcReceived.length).toBe(5)
    unsub()
  })

  it('keeps feeding WebRTC while the RTSP consumer waits out its withhold', async () => {
    await broker.start(pushRtpSource())
    const afterGop = pushGop(broker, { seq: 1000, ts: 90000 }, 40, 9000)
    const mock = createMockSocket()
    attachRtspSession(broker, mock)

    const webrtcReceived: Buffer[] = []
    const unsub = broker.onVideoRtp((rtpData) => {
      webrtcReceived.push(rtpData)
    })

    deliver(broker, {
      rtp: buildRtpPacket({
        seq: afterGop.seq,
        timestamp: afterGop.ts,
        marker: true,
        payload: nalPayload(1, Buffer.alloc(48, 0xcd)),
      }),
      isKeyframe: false,
      isParameterSet: false,
    })
    vi.advanceTimersByTime(1000)
    expect(countRtpFrames(mock.written)).toBe(0)
    expect(webrtcReceived.length).toBe(1)

    // GOP 2 — the next live keyframe AU. RTSP unlatches here (its first frame
    // is the live edge); WebRTC simply continues, having never stopped.
    pushGop(broker, { seq: afterGop.seq + 1, ts: afterGop.ts + 9000 }, 3, 9000)
    vi.advanceTimersByTime(1000)
    expect(countRtpFrames(mock.written)).toBeGreaterThan(0)
    expect(webrtcReceived.length).toBe(1 + 6)
    unsub()
  })

  /**
   * The mirror of the exemption: the configured bound must actually REACH the
   * restreamer, and it must reach ONLY the restreamer.
   *
   * `StreamBroker` wires `setPrimeBoundSupplier(() => this.joinBurstBound)` in
   * its constructor. Nothing else in this file would notice if that line were
   * deleted — every test above pins the DEFAULT bound's behaviour, which is
   * exactly what an unwired restreamer also produces. This is the test that
   * distinguishes "the bound is configured" from "the bound happens to be 2000".
   */
  it('applies a raised bound end-to-end through the broker, WITHOUT touching the ring', async () => {
    await broker.start(pushRtpSource())
    // 4 s of GOP — withheld under the default, served under a 4.5 s bound.
    broker.setJoinBurstBound({ maxSpanMs: 4500, maxPackets: 2000 })

    const afterGop = pushGop(broker, { seq: 1000, ts: 90000 }, 40, 9000)
    const mock = createMockSocket()
    attachRtspSession(broker, mock)

    deliver(broker, {
      rtp: buildRtpPacket({
        seq: afterGop.seq,
        timestamp: afterGop.ts,
        marker: true,
        payload: nalPayload(1, Buffer.alloc(48, 0xcd)),
      }),
      isKeyframe: false,
      isParameterSet: false,
    })
    vi.advanceTimersByTime(1000)

    // Served: the whole 43-packet ring as it stood at the join, plus the live
    // trigger appended behind the replay tail. (The restreamer is fed before
    // the ring captures, exactly as the native reader orders it, so the
    // trigger is not yet in the burst it primes with.)
    expect(countRtpFrames(mock.written)).toBe(44)
    // And the shared surface is untouched by the RESTREAM's bound either way —
    // raising it must not have been implemented by growing the ring.
    expect(broker.getRtpPreBuffer().length).toBe(44)
    expect(broker.getJoinBurstBound().maxSpanMs).toBe(4500)
  })
})
