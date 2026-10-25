/**
 * The PREBUFFER, at the RING: what the broker RETAINS, and who may see it.
 *
 * `captureRtpForPreBuffer` trims the source-RTP ring at every keyframe so it
 * holds exactly `[current keyframe AU .. now]`. That is the reason a detection
 * decode session cannot analyse anything older than the motion edge that
 * attached it — the history was thrown away one IDR ago.
 *
 * The prebuffer (D381) keeps `seconds` of it — ONE configuration, installed by
 * `setPrebuffer`, and the only thing that sizes retention. The whole risk of
 * retaining more is the fork documented in `webrtc-join-burst-exemption.spec.ts`:
 *
 *     StreamBroker.rtpRing
 *       ├─ getRtpPreBuffer()      → WebRTC bootstrap + the RTSP join burst
 *       └─ getRtpPreRollBuffer(askMs) → history, capped at what is retained
 *
 * A wider ring that leaked into `getRtpPreBuffer()` would hand every WebRTC
 * viewer and every re-clocking RTSP leg seconds of backlog — the confirmed
 * HomeKit jitter failure D57 was written for, re-created from above. So these
 * tests pin both directions: the prebuffer window widens, and the shared one
 * does not move.
 */
import type { IScopedLogger, StreamSource } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamBroker } from '../stream-broker/stream-broker.js'
import type { PrebufferConfig } from '../prebuffer.js'
import { PRE_ROLL_ABSOLUTE_MAX_BYTES, PRE_ROLL_UNKNOWN_BITRATE_BYTES } from '../pre-roll.js'

/**
 * The one prebuffer configuration, stated in ms because every window in this
 * file is measured against a 90 kHz clock.
 *
 * `enabled` and `seconds` are ONE decision (D381), so `0` here is the prebuffer
 * being OFF — never an enabled window of length zero, which is the shape that
 * would retain nothing while reporting itself on.
 */
function prebufferOf(ms: number): PrebufferConfig {
  return ms > 0 ? { enabled: true, seconds: ms / 1000 } : { enabled: false, seconds: 0 }
}

const RTP_HEADER_SIZE = 12

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

interface GopPacket {
  readonly rtp: Buffer
  readonly isKeyframe: boolean
  readonly isParameterSet: boolean
}

/** Deliver one source RTP packet exactly as the native RTSP reader does. */
function deliver(broker: StreamBroker, pkt: GopPacket): void {
  broker.getRtspRestreamer().pushRtpPassthrough(pkt.rtp, pkt.isKeyframe, pkt.isParameterSet)
  broker.pushVideoRtp(pkt.rtp)
}

/**
 * One keyframe AU (SPS, PPS, IDR) then `pCount` P-slices, advancing the 90 kHz
 * clock by `stepTicks` per frame. Payload size is a parameter so a test can
 * make the ring heavy without making it long.
 */
function pushGop(
  broker: StreamBroker,
  state: GopState,
  pCount: number,
  stepTicks: number,
  payloadBytes = 48,
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
      payload: nalPayload(5, Buffer.alloc(payloadBytes, 0xab)),
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
        payload: nalPayload(1, Buffer.alloc(payloadBytes, 0xcd)),
      }),
      isKeyframe: false,
      isParameterSet: false,
    })
    ts += stepTicks
  }

  return { seq, ts }
}

/** 90 kHz span of a window, in ms — the quantity every bound here is measured in. */
function spanMs(packets: readonly Buffer[]): number {
  if (packets.length === 0) return 0
  const first = packets[0]!.readUInt32BE(4)
  const last = packets[packets.length - 1]!.readUInt32BE(4)
  return ((last - first) | 0) / 90
}

/** True when this packet is the first of a keyframe AU (the SPS in `pushGop`). */
function isKeyframeAuStart(packet: Buffer): boolean {
  const nal = packet[RTP_HEADER_SIZE]
  return nal !== undefined && (nal & 0x1f) === 7
}

function pushRtpSource(): StreamSource {
  return { type: 'push-rtp', url: '', videoCodec: 'h264' }
}

/** Four 1 s GOPs (10 P-frames at 100 ms), oldest first. */
function pushFourGops(broker: StreamBroker): GopState {
  let state: GopState = { seq: 1000, ts: 90_000 }
  for (let i = 0; i < 4; i++) state = pushGop(broker, state, 9, 9000)
  return state
}

describe('StreamBroker — pre-roll retention', () => {
  let broker: StreamBroker

  beforeEach(() => {
    vi.useFakeTimers()
    broker = new StreamBroker('101/native', createMockLogger())
  })

  afterEach(async () => {
    await broker.stop()
    vi.useRealTimers()
  })

  it('retains exactly the current GOP while the prebuffer is OFF (byte-for-byte)', async () => {
    await broker.start(pushRtpSource())
    pushFourGops(broker)

    // 3 keyframe-AU packets + 9 P-slices; the three older GOPs are gone.
    expect(broker.getRtpPreBuffer().length).toBe(12)
    // `undefined` asks for the WHOLE retention, and an off prebuffer retains
    // nothing — so even the greediest reader is served the current GOP.
    // ASKED for, and answered with the current GOP: there was no history.
    expect(broker.getRtpPreRollBuffer(4000).length).toBe(12)
  })

  it('retains earlier GOPs once the prebuffer is on', async () => {
    broker.setPrebuffer(prebufferOf(2000))
    await broker.start(pushRtpSource())
    pushFourGops(broker)

    // Keyframes sit 900 ms and 1900 ms back (the next is 2900 ms — outside), so
    // the window is the current GOP plus the one before it.
    const window = broker.getRtpPreRollBuffer(2000)
    expect(window.length).toBe(24)
    expect(isKeyframeAuStart(window[0]!)).toBe(true)
    expect(spanMs(window)).toBeCloseTo(1900, 0)
  })

  it('NEVER hands out a frame older than the prebuffer', async () => {
    broker.setPrebuffer(prebufferOf(2000))
    await broker.start(pushRtpSource())
    pushFourGops(broker)

    expect(spanMs(broker.getRtpPreRollBuffer(2000))).toBeLessThanOrEqual(2000)
  })

  it('starts the window at a KEYFRAME, never at a tail cut (D57)', async () => {
    // A 1.5 s prebuffer against 1 s GOPs: the 1900 ms-old keyframe is outside
    // the window, so the window starts at the 900 ms-old one — not 1500 ms back
    // mid-GOP, which would be undecodable.
    broker.setPrebuffer(prebufferOf(1500))
    await broker.start(pushRtpSource())
    pushFourGops(broker)

    const window = broker.getRtpPreRollBuffer(1500)
    expect(isKeyframeAuStart(window[0]!)).toBe(true)
    expect(window.length).toBe(12)
    expect(spanMs(window)).toBeCloseTo(900, 0)
  })

  it('leaves the SHARED pre-buffer at the current GOP — WebRTC never sees pre-roll', async () => {
    broker.setPrebuffer(prebufferOf(4000))
    await broker.start(pushRtpSource())
    pushFourGops(broker)

    // `rtpBootstrap` in the WebRTC server is literally `getRtpPreBuffer()`, and
    // it is also what a plain RTSP join burst is cut from. Both must keep
    // seeing one GOP however much history the prebuffer retained.
    const shared = broker.getRtpPreBuffer()
    expect(shared.length).toBe(12)
    expect(spanMs(shared)).toBeCloseTo(900, 0)
    expect(broker.getRtpPreRollBuffer(4000).length).toBeGreaterThan(shared.length)
  })

  it('turning the prebuffer back off releases the retained history at the next keyframe', async () => {
    broker.setPrebuffer(prebufferOf(4000))
    await broker.start(pushRtpSource())
    const state = pushFourGops(broker)
    expect(broker.getRtpPreRollBuffer(4000).length).toBeGreaterThan(12)

    broker.setPrebuffer(prebufferOf(0))
    pushGop(broker, state, 9, 9000)

    // ASKED for, and answered with the current GOP: there was no history.
    expect(broker.getRtpPreRollBuffer(4000).length).toBe(12)
    expect(broker.getRtpPreBuffer().length).toBe(12)
  })

  it('bounds the retained history by BYTES, dropping whole GOPs from the head', async () => {
    // Pathological: a 6 s prebuffer on a stream whose GOPs are heavy.
    // The retention must stay under its own budget rather than climb toward
    // `RTP_RING_MAX_BYTES`, whose overflow drops EVERY consumer's bootstrap.
    broker.setPrebuffer(prebufferOf(6000))
    await broker.start(pushRtpSource())

    let state: GopState = { seq: 1000, ts: 90_000 }
    // 8 GOPs × 12 packets × 256 KiB ≈ 3 MiB each: 6 s of them is ~18 MiB, far
    // over the budget, so the budget — not the time window — decides.
    for (let i = 0; i < 8; i++) state = pushGop(broker, state, 9, 9000, 256 * 1024)

    // The budget governs the HISTORY — everything before the current GOP, which
    // is the Stage 0 baseline and is served whatever it weighs.
    const window = broker.getRtpPreRollBuffer(6000)
    let currentGopStart = 0
    for (let i = window.length - 1; i >= 0; i--) {
      if (isKeyframeAuStart(window[i]!)) {
        currentGopStart = i
        break
      }
    }
    const historyBytes = window.slice(0, currentGopStart).reduce((sum, p) => sum + p.length, 0)
    // No bitrate measured on this passthrough-only path, so the budget is the
    // honest fallback: the flat cap this test was written against.
    expect(historyBytes).toBeLessThanOrEqual(PRE_ROLL_UNKNOWN_BITRATE_BYTES)
    expect(window.length).toBeLessThan(6 * 12)
    // Still decodable: whole GOPs were dropped, so it still starts at a keyframe.
    expect(isKeyframeAuStart(window[0]!)).toBe(true)
  })

  it('falls back to the current GOP when the ring holds no older keyframe', async () => {
    broker.setPrebuffer(prebufferOf(6000))
    await broker.start(pushRtpSource())
    pushGop(broker, { seq: 1000, ts: 90_000 }, 9, 9000)

    expect(broker.getRtpPreRollBuffer(6000).length).toBe(12)
  })

  it('serves nothing at all until the first keyframe', async () => {
    broker.setPrebuffer(prebufferOf(2000))
    await broker.start(pushRtpSource())
    deliver(broker, {
      rtp: buildRtpPacket({
        seq: 1,
        timestamp: 90_000,
        marker: true,
        payload: nalPayload(1, Buffer.alloc(48, 0xcd)),
      }),
      isKeyframe: false,
      isParameterSet: false,
    })

    expect(broker.getRtpPreRollBuffer(2000)).toEqual([])
  })
})

/**
 * ONE RING, ONE RETENTION, CAPPED REQUESTS (D381).
 *
 * There are no longer two windows to reconcile. The ring retains THE prebuffer
 * and nothing else; a consumer that wants less than that ASKS for less and is
 * served it, and a consumer that asks for more than the stream retains is
 * served what exists — never a wider window than the bytes it was told about.
 * That cap is the whole contract: `max(detection, recording)` made "how much
 * history does 102 hold" a question with two answers and no owner, and neither
 * of the two numbers was the seconds the operator was shown.
 */
describe('StreamBroker — one retention, and every request capped at it', () => {
  let broker: StreamBroker

  beforeEach(() => {
    vi.useFakeTimers()
    broker = new StreamBroker('102/native', createMockLogger())
  })

  afterEach(async () => {
    await broker.stop()
    vi.useRealTimers()
  })

  it('the retention IS the prebuffer, and other consumers still see one GOP', async () => {
    broker.setPrebuffer(prebufferOf(4000))
    await broker.start(pushRtpSource())
    pushFourGops(broker)

    // The retention is the configuration, unmediated: no maximum over two
    // numbers, nothing else that can raise or lower it.
    expect(broker.getPreRollRetentionMs()).toBe(4000)
    // The ring held it, for a consumer that ASKED for it (D382)…
    expect(broker.getRtpPreRollBuffer(4000).length).toBeGreaterThan(12)
    // …and every other consumer still sees exactly one GOP (D57).
    expect(broker.getRtpPreBuffer().length).toBe(12)
  })

  it('honours a NARROWER request and CAPS a wider one at what is retained', async () => {
    broker.setPrebuffer(prebufferOf(4000))
    await broker.start(pushRtpSource())
    pushFourGops(broker)

    // 1 s GOPs, keyframes 900 / 1900 / 2900 / 3900 ms back. The whole retention
    // reaches all four; nothing asked for can reach further.
    const whole = broker.getRtpPreRollBuffer(4000)
    expect(whole.length).toBe(48)
    expect(spanMs(whole)).toBeCloseTo(3900, 0)

    // A consumer that wants less gets less — the 1900 ms keyframe, two GOPs.
    const narrow = broker.getRtpPreRollBuffer(2000)
    expect(narrow.length).toBe(24)
    expect(spanMs(narrow)).toBeLessThanOrEqual(2000)
    expect(isKeyframeAuStart(narrow[0]!)).toBe(true)

    // A consumer that asks for 99 s gets the 4 s that exist, and not one packet
    // more: the request is a wish, the retention is the truth.
    const greedy = broker.getRtpPreRollBuffer(99_000)
    expect(greedy.length).toBe(whole.length)
    expect(spanMs(greedy)).toBeLessThanOrEqual(4000)
  })

  it('caps at the retention even while the ring still physically holds more', async () => {
    // The cap has to bite where it MATTERS: the ring is trimmed at keyframes,
    // so between a prebuffer being narrowed and the next IDR the ring holds
    // more history than the stream is configured to retain. A reader served
    // out of the ring's raw contents would hand out the wider window — which is
    // exactly how a request could outrun the bytes anyone had budgeted for.
    broker.setPrebuffer(prebufferOf(4000))
    await broker.start(pushRtpSource())
    pushFourGops(broker)
    expect(broker.getRtpPreRollBuffer(4000).length).toBe(48)

    // Narrow the prebuffer. No keyframe has arrived, so the ring is untouched…
    broker.setPrebuffer(prebufferOf(2000))
    expect(broker.getPreRollRetentionMs()).toBe(2000)
    // …and every reader is nonetheless held to the 2 s now in force.
    expect(broker.getRtpPreRollBuffer(99_000).length).toBe(24)
    expect(broker.getRtpPreRollBuffer(4000).length).toBe(24)
    expect(spanMs(broker.getRtpPreRollBuffer(4000))).toBeLessThanOrEqual(2000)
  })

  it('the byte budget is derived from the OBSERVED bitrate, not a flat 8 MiB', async () => {
    broker.setPrebuffer(prebufferOf(10_000))
    await broker.start(pushRtpSource())
    // Nothing measured yet: the honest fallback is the historical flat cap.
    expect(broker.getPreRollBudget().bytes).toBe(PRE_ROLL_UNKNOWN_BITRATE_BYTES)

    // Now let the broker MEASURE a 4K-class bitrate over one stats window.
    const startMs = Date.now()
    for (let i = 0; i < 40; i++) {
      broker.pushEncodedPacket({
        type: 'video',
        data: Buffer.alloc(64 * 1024, 0xab),
        pts: i * 100,
        dts: i * 100,
        keyframe: i === 0,
        codec: 'h264',
      })
    }
    vi.setSystemTime(startMs + 2100)
    broker.pushEncodedPacket({
      type: 'video',
      data: Buffer.alloc(64 * 1024, 0xab),
      pts: 4200,
      dts: 4200,
      keyframe: false,
      codec: 'h264',
    })

    // ~10 Mbps × 10 s is far past 8 MiB: the flat cap would have delivered ~6 s
    // of a window the operator configured as 10 — D192's forbidden divergence.
    expect(broker.getPreRollBudget().bytes).toBeGreaterThan(PRE_ROLL_UNKNOWN_BITRATE_BYTES)
    expect(broker.getPreRollBudget().bytes).toBeLessThanOrEqual(PRE_ROLL_ABSOLUTE_MAX_BYTES)
  })
})
