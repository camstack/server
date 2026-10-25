import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StreamBroker } from '../stream-broker/stream-broker'
import type { StreamSource, IScopedLogger } from '@camstack/types'

/**
 * Source-RTP activity watchdog regression suite.
 *
 * Wi-Fi-attached IP cameras (Hikvision 192.168.10.245, device 127 — the live
 * incident) can silently stall their RTSP/TCP source: ICE/DTLS stay healthy,
 * the WebRTC session reports `rtpPacketsSent` advancing in tiny bursts, but
 * `audioRtpTs` falls 15-20s behind wall clock while video catches up only
 * from the GOP cache. The user sees a frozen viewport with no recovery.
 * The fix is an activity timer (`armRtpActivityWatchdog`) that resets on
 * every RTP packet and kills+restarts the session when no data arrives
 * within `RTP_ACTIVITY_TIMEOUT_MS` (~10s).
 *
 * The broker only had a FIRST-video watchdog (`armFirstVideoWatchdog`) that
 * cancels on the first packet and never re-arms — once streaming starts,
 * nothing detects a mid-stream stall.
 *
 * This suite locks in the rolling activity watchdog: arms when streaming
 * begins, resets on every video OR audio RTP packet, and on expiry tears
 * the reader down so `scheduleReconnect()` rebuilds the source.
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

function idrPacket(seq: number, ts: number): Buffer {
  return buildRtpPacket({
    seq,
    timestamp: ts,
    marker: true,
    payload: nalPayload(5, Buffer.alloc(64, 0xab)),
  })
}

/** Tracks the FIRST_VIDEO_TIMEOUT_MS constant (8s) so a test break is loud. */
const ACTIVITY_TIMEOUT_MS = 8_000
/** Tracks `StreamBroker.RTP_ACTIVITY_SWEEP_MS` — the sweep granularity. */
const StreamBrokerSweepMs = 1_000

function rtspSource(): StreamSource {
  return { type: 'push-rtp', url: '', videoCodec: 'h264' }
}

describe('StreamBroker source-RTP activity watchdog', () => {
  let broker: StreamBroker
  let logger: IScopedLogger

  beforeEach(() => {
    vi.useFakeTimers()
    logger = createMockLogger()
    broker = new StreamBroker('dev-127', logger)
  })

  afterEach(async () => {
    await broker.stop()
    vi.useRealTimers()
  })

  it('arms the activity watchdog after the first RTP packet', async () => {
    await broker.start(rtspSource())

    // No watchdog before the first packet — nothing to detect a stall on.
    expect(broker.getRtpActivityWatchdogStatus().armed).toBe(false)

    broker.pushVideoRtp(idrPacket(1000, 90000))
    expect(broker.getRtpActivityWatchdogStatus().armed).toBe(true)
  })

  it('does NOT fire while RTP keeps arriving within the timeout window', async () => {
    await broker.start(rtspSource())
    broker.pushVideoRtp(idrPacket(1000, 90000))

    // Advance below the timeout, push another packet, repeat — the watchdog
    // must keep resetting (armRtpActivityWatchdog behavior).
    for (let i = 1; i < 6; i++) {
      vi.advanceTimersByTime(ACTIVITY_TIMEOUT_MS - 1_000)
      broker.pushVideoRtp(idrPacket(1000 + i, 90000 + i * 3000))
    }

    const status = broker.getRtpActivityWatchdogStatus()
    expect(status.armed).toBe(true)
    expect(status.firedCount).toBe(0)
  })

  it('fires when no RTP arrives within the timeout window', async () => {
    await broker.start(rtspSource())
    broker.pushVideoRtp(idrPacket(1000, 90000))
    expect(broker.getRtpActivityWatchdogStatus().firedCount).toBe(0)

    vi.advanceTimersByTime(ACTIVITY_TIMEOUT_MS + 100)

    const status = broker.getRtpActivityWatchdogStatus()
    expect(status.firedCount).toBe(1)
    expect(status.armed).toBe(false)
    // Must surface a warn-level log so operators can correlate with viewer
    // freezes — "activity watchdog fired: stream inactivity" log expected.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/activity watchdog/i),
      expect.objectContaining({
        meta: expect.objectContaining({ timeoutMs: ACTIVITY_TIMEOUT_MS }),
      }),
    )
  })

  it('cancels the watchdog on broker stop so a torn-down broker cannot fire', async () => {
    await broker.start(rtspSource())
    broker.pushVideoRtp(idrPacket(1000, 90000))
    expect(broker.getRtpActivityWatchdogStatus().armed).toBe(true)

    await broker.stop()
    expect(broker.getRtpActivityWatchdogStatus().armed).toBe(false)

    vi.advanceTimersByTime(ACTIVITY_TIMEOUT_MS * 2)
    expect(broker.getRtpActivityWatchdogStatus().firedCount).toBe(0)
  })

  /**
   * Allocation outcome, not an implementation detail.
   *
   * The watchdog used to `clearTimeout` + `setTimeout` on EVERY RTP packet, and
   * the comment on it called that "negligible". Measured on the live hub it is
   * not: `stream-broker` runs at 95% of a core with ~68% of that in GC, and at
   * 30 cameras × 80-100 packets/s this path alone churned ~3 000 `Timeout`
   * objects — plus two libuv timer-heap operations each — every second.
   *
   * The arm count must therefore be O(1) in the number of packets, while the
   * stall verdict itself is unchanged (the surrounding tests in this file pin
   * that: still fires after a silent window, still does not fire while packets
   * keep arriving).
   */
  it('arms ONE timer for a whole packet burst — no per-packet timer churn', async () => {
    await broker.start(rtspSource())

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')

    const BURST = 500
    for (let i = 0; i < BURST; i++) {
      broker.pushVideoRtp(idrPacket(2000 + i, 90000 + i * 3000))
    }

    // Positive: the burst really did drive the watchdog.
    expect(broker.getRtpActivityWatchdogStatus().armed).toBe(true)

    // The outcome: 500 packets cost ONE watchdog timer, not 500. The sweep
    // interval is armed by packet #1; packets #2..#500 allocate no timer at all.
    expect(setIntervalSpy.mock.calls.length).toBe(1)
    expect(setTimeoutSpy.mock.calls.length).toBe(0)

    setIntervalSpy.mockRestore()
    setTimeoutSpy.mockRestore()

    // And the verdict still works after the burst: silence still trips it.
    vi.advanceTimersByTime(ACTIVITY_TIMEOUT_MS + StreamBrokerSweepMs)
    expect(broker.getRtpActivityWatchdogStatus().firedCount).toBe(1)
  })

  it('cancels the watchdog on suspend (idle teardown) so an evicted reader cannot fire', async () => {
    await broker.start(rtspSource())
    broker.pushVideoRtp(idrPacket(1000, 90000))
    expect(broker.getRtpActivityWatchdogStatus().armed).toBe(true)

    // Drop pre-buffer demand, attach+detach a subscriber, let the suspend
    // grace window elapse — same on-demand teardown as a WebRTC viewer
    // close, identical to the source-rtp-prebuffer suite.
    broker.setPreBufferEnabled(false)
    const unsub = broker.onVideoRtp(() => {})
    unsub()
    vi.advanceTimersByTime(5_000 + 1)
    expect(broker.suspended).toBe(true)
    expect(broker.getRtpActivityWatchdogStatus().armed).toBe(false)
  })
})
