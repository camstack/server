import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StreamBroker } from '../stream-broker/stream-broker'
import type { StreamSource, IScopedLogger } from '@camstack/types'

/**
 * Source-RTP pre-buffer (the raw-RTP "instant start" GOP replay) regression
 * suite. Reproduces the cold-start gap that made device 97 (Hikvision H.264
 * Main, native:main) stutter/black in the first seconds of a session:
 *
 * The broker dials on-demand and tears the reader down on idle. The
 * source-RTP ring (`rtpRing`) is the raw-packet GOP a late-joining
 * repacketizer-path WebRTC viewer replays on connect (`getRtpPreBuffer`).
 * If a stale GOP from the PREVIOUS session leaks across the idle window —
 * because the ring is not reset on reader teardown — a new viewer replays
 * a degenerate/stale slice (the live `1 packet, sent=0` symptom), gets no
 * decodable GOP, and waits a full camera GOP for the next live IDR.
 */

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

const RTP_HEADER_SIZE = 12

interface RtpPacketOptions {
  readonly seq: number
  readonly timestamp: number
  readonly marker: boolean
  readonly payload: Buffer
}

/** Build a raw H.264 RTP packet (12-byte header + payload). */
function buildRtpPacket(opts: RtpPacketOptions): Buffer {
  const header = Buffer.alloc(RTP_HEADER_SIZE)
  header[0] = 0x80 // version 2
  header[1] = (opts.marker ? 0x80 : 0x00) | 96 // marker bit + payload type 96
  header.writeUInt16BE(opts.seq & 0xffff, 2)
  header.writeUInt32BE(opts.timestamp >>> 0, 4)
  header.writeUInt32BE(0x11223344, 8) // ssrc
  return Buffer.concat([header, opts.payload])
}

/** Single-NAL H.264 packet payload (e.g. SPS=7, PPS=8, IDR=5, non-IDR=1). */
function nalPayload(nalType: number, body: Buffer): Buffer {
  const nri = 0x60 // NRI = 3 (most important)
  return Buffer.concat([Buffer.from([nri | nalType]), body])
}

interface GopState {
  seq: number
  ts: number
}

/**
 * Push one full keyframe access unit (SPS, PPS, IDR) followed by `pCount`
 * P-frame slices into the broker via the source-RTP path. Returns the
 * advanced sequence/timestamp state so a subsequent GOP can continue
 * monotonically (as a real RTSP/TCP stream would).
 */
function pushGop(broker: StreamBroker, state: GopState, pCount: number): GopState {
  let { seq, ts } = state

  // Keyframe AU — SPS, PPS, IDR as separate single-NAL packets, IDR marked.
  broker.pushVideoRtp(
    buildRtpPacket({
      seq: seq++,
      timestamp: ts,
      marker: false,
      payload: nalPayload(7, Buffer.from([0x42, 0x00, 0x1f])),
    }),
  )
  broker.pushVideoRtp(
    buildRtpPacket({
      seq: seq++,
      timestamp: ts,
      marker: false,
      payload: nalPayload(8, Buffer.from([0xce, 0x3c, 0x80])),
    }),
  )
  broker.pushVideoRtp(
    buildRtpPacket({
      seq: seq++,
      timestamp: ts,
      marker: true,
      payload: nalPayload(5, Buffer.alloc(64, 0xab)),
    }),
  )
  ts += 3000

  for (let i = 0; i < pCount; i++) {
    broker.pushVideoRtp(
      buildRtpPacket({
        seq: seq++,
        timestamp: ts,
        marker: true,
        payload: nalPayload(1, Buffer.alloc(48, 0xcd)),
      }),
    )
    ts += 3000
  }

  return { seq, ts }
}

/** First NAL type of an RTP packet's H.264 payload. */
function rtpNalType(rtp: Buffer): number {
  return rtp[RTP_HEADER_SIZE]! & 0x1f
}

/** Grace window before the on-demand lifecycle suspends an idle broker. */
const SUSPEND_GRACE_MS = 5_000

describe('StreamBroker source-RTP pre-buffer (instant-start GOP replay)', () => {
  let broker: StreamBroker

  beforeEach(() => {
    vi.useFakeTimers()
    broker = new StreamBroker('dev-97', createMockLogger())
  })

  afterEach(async () => {
    await broker.stop()
    vi.useRealTimers()
  })

  function pushRtpSource(): StreamSource {
    return { type: 'push-rtp', url: '', videoCodec: 'h264' }
  }

  /**
   * Drive the real on-demand idle teardown the way a WebRTC session does:
   * a viewer attaches an `onVideoRtp` subscriber, then detaches on close.
   * The detach drops demand to zero and schedules a suspend after the grace
   * window; advancing fake timers fires it, running the exact `suspend()` →
   * reader-teardown → `resetRtpPipeline()` path production idle-evict uses.
   */
  function idleSuspend(): void {
    // Pre-buffer counts as demand by default — disable it so a viewer
    // detach genuinely drops demand to zero (mirrors a WebRTC-only stream).
    broker.setPreBufferEnabled(false)
    const unsub = broker.onVideoRtp(() => {})
    unsub()
    vi.advanceTimersByTime(SUSPEND_GRACE_MS + 1)
    expect(broker.suspended).toBe(true)
  }

  it('captures the current GOP and leads the replay with the keyframe access unit', async () => {
    await broker.start(pushRtpSource())

    const state = pushGop(broker, { seq: 1000, ts: 90000 }, 5)
    // a couple of packets into the NEXT GOP-less tail to ensure trimming
    pushGop(broker, state, 2)

    const replay = broker.getRtpPreBuffer()
    expect(replay.length).toBeGreaterThan(0)
    // Must lead with a keyframe access unit (SPS, type 7) so the viewer's
    // decoder initialises from a complete GOP — not a mid-GOP P-slice.
    expect(rtpNalType(replay[0]!)).toBe(7)
  })

  it('does NOT leak a stale GOP across an on-demand reader teardown/redial', async () => {
    // Session 1: warm GOP captured.
    await broker.start(pushRtpSource())
    pushGop(broker, { seq: 1000, ts: 90000 }, 4)
    expect(broker.getRtpPreBuffer().length).toBeGreaterThan(0)

    // Idle teardown: the on-demand lifecycle drops the reader. The
    // source-RTP ring MUST be cleared with it — otherwise the stale GOP
    // leaks into the next session.
    idleSuspend()

    // Session 2 re-dials and the camera's first delivered packets are
    // mid-GOP P-slices (no IDR yet) — the realistic cold-start case.
    await broker.start(pushRtpSource())
    broker.pushVideoRtp(
      buildRtpPacket({
        seq: 5000,
        timestamp: 500000,
        marker: true,
        payload: nalPayload(1, Buffer.alloc(48, 0x11)),
      }),
    )
    broker.pushVideoRtp(
      buildRtpPacket({
        seq: 5001,
        timestamp: 503000,
        marker: true,
        payload: nalPayload(1, Buffer.alloc(48, 0x22)),
      }),
    )

    // No keyframe has arrived on the NEW dial → the replay must be empty
    // (viewer correctly falls back to waiting for the next live IDR),
    // NOT the stale GOP from session 1.
    expect(broker.getRtpPreBuffer()).toEqual([])
  })

  it('repopulates a fresh GOP after redial once the new keyframe arrives', async () => {
    await broker.start(pushRtpSource())
    pushGop(broker, { seq: 1000, ts: 90000 }, 4)
    idleSuspend()

    await broker.start(pushRtpSource())
    // Mid-GOP tail first, then the new dial's own keyframe.
    broker.pushVideoRtp(
      buildRtpPacket({
        seq: 5000,
        timestamp: 500000,
        marker: true,
        payload: nalPayload(1, Buffer.alloc(48, 0x11)),
      }),
    )
    pushGop(broker, { seq: 5001, ts: 503000 }, 2)

    const replay = broker.getRtpPreBuffer()
    expect(replay.length).toBeGreaterThan(0)
    expect(rtpNalType(replay[0]!)).toBe(7)
    // The leaked stale P-slice (ts 500000) must not be present — every
    // replayed packet belongs to the fresh GOP.
    for (const pkt of replay) {
      expect(pkt.readUInt32BE(4)).toBeGreaterThanOrEqual(503000)
    }
  })
})
