/**
 * A LAZY PUBLISHER'S COLD OPEN IS A SOURCE BEING BUILT, NOT ONE THAT FAILED.
 *
 * Measured on the wyze bridge (devices 3838/3836, 2026-08-20): a successful
 * open costs **12.4 s** — the bridge waits for the first keyframe with a 10 s
 * ceiling, on top of ~2 s of DTLS handshake. Three things on THIS side turned
 * that into much worse than 12.4 s, and each is its own defect:
 *
 *  (a) the broker saw the `lazy:` URL, went to `error` and RETURNED, so the
 *      re-dial rode the exponential backoff (1-2-4-8-16 s) — the publisher
 *      answered at ~12 s and the broker did not look again until 16;
 *  (b) `kickReconnect` fired only when the URL CHANGED, and the bridge
 *      re-publishes the same loopback port after recreating its P2P server, so
 *      that camera sat out the whole backoff for a source already up;
 *  (c) the first-video watchdog's 8 s deadline is SHORTER than the measured
 *      open, so a connection two seconds from delivering was torn down — and
 *      the bridge closes its P2P server 30 s after the last client, so the next
 *      dial repaid the entire cold open.
 */
import type { IScopedLogger, StreamSource } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamBroker } from '../stream-broker/stream-broker.js'

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

const SDP = 'v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\n'

function lazySource(): StreamSource {
  return {
    type: 'rfc4571',
    url: 'lazy:rfc4571:3838',
    videoCodec: 'h264',
    metadata: { sdp: SDP },
  }
}

function realSource(): StreamSource {
  return {
    type: 'rfc4571',
    url: 'tcp://127.0.0.1:51234',
    videoCodec: 'h264',
    metadata: { sdp: SDP },
  }
}

describe('lazy materialize — the wait is polled flat, not backed off', () => {
  let broker: StreamBroker

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-20T18:00:00Z'))
    broker = new StreamBroker('3838/native:main', createMockLogger())
    // Demand, so the broker actually dials rather than suspending.
    broker.onEncodedData(() => {})
  })

  afterEach(async () => {
    await broker.stop()
    vi.useRealTimers()
  })

  it('does not let a 12 s publisher be discovered on a 16 s backoff', async () => {
    const sources: StreamSource[] = []
    broker.setSourceProvider(() => {
      // The publisher materializes after 12 s of wall clock — the measured
      // wyze open. Before that, the lazy sentinel.
      const elapsed = Date.now() - new Date('2026-08-20T18:00:00Z').getTime()
      const src = elapsed >= 12_000 ? realSource() : lazySource()
      sources.push(src)
      return src
    })
    await broker.start(lazySource())

    // Walk to just past the publisher's answer. On the exponential backoff the
    // dials land at 1, 3, 7, 15 s and the broker would still be waiting here.
    await vi.advanceTimersByTimeAsync(13_500)

    expect(sources.some((s) => s.url.startsWith('tcp://'))).toBe(true)
  })

  it('falls back to the ordinary backoff once the materialize deadline passes', async () => {
    // A publisher that never answers is not slow, it is BROKEN, and polling it
    // at 1 Hz for ever is exactly the dial storm the backoff exists to prevent.
    let dials = 0
    broker.setSourceProvider(() => {
      dials++
      return lazySource()
    })
    await broker.start(lazySource())

    // Inside the deadline the poll is flat, so ~1 dial per second.
    await vi.advanceTimersByTimeAsync(15_000)
    const insideDeadline = dials
    expect(insideDeadline).toBeGreaterThan(8)

    // A minute past it, the retreat has taken over: far fewer dials than the
    // flat poll would have produced over the same span.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(dials - insideDeadline).toBeLessThan(15)
  })
})

describe('the first-video deadline behind a materialize', () => {
  let broker: StreamBroker

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-20T18:00:00Z'))
    broker = new StreamBroker('3838/native:main', createMockLogger())
    broker.onEncodedData(() => {})
  })

  afterEach(async () => {
    await broker.stop()
    vi.useRealTimers()
  })

  it('is the ordinary 8 s for a source that never went through a materialize', async () => {
    broker.setSourceProvider(() => realSource())
    await broker.start(realSource())
    expect(broker.getFirstVideoWatchdogStatus().timeoutMs).toBe(8_000)
  })

  it('is EXTENDED past the measured 12.4 s open once a materialize was requested', async () => {
    broker.setSourceProvider(() => lazySource())
    await broker.start(lazySource())
    await vi.advanceTimersByTimeAsync(100)

    const status = broker.getFirstVideoWatchdogStatus()
    expect(status.materializeRequestedAt).toBeGreaterThan(0)
    // Must clear the 12.4 s the bridge actually costs, with margin.
    expect(status.timeoutMs).toBeGreaterThan(12_400)
  })

  it('goes back to 8 s long after the materialize — the latch is not permanent', async () => {
    broker.setSourceProvider(() => lazySource())
    await broker.start(lazySource())
    await vi.advanceTimersByTimeAsync(100)
    expect(broker.getFirstVideoWatchdogStatus().timeoutMs).toBeGreaterThan(12_400)

    // 30 s on, this is not a cold open any more — it is a camera that is not
    // delivering, and it must be judged on the ordinary stall budget.
    await vi.advanceTimersByTimeAsync(31_000)
    expect(broker.getFirstVideoWatchdogStatus().timeoutMs).toBe(8_000)
  })
})

describe('kickReconnect — a re-publish is news even at an unchanged URL', () => {
  let broker: StreamBroker

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-20T18:00:00Z'))
    broker = new StreamBroker('3838/native:main', createMockLogger())
    broker.onEncodedData(() => {})
  })

  afterEach(async () => {
    await broker.stop()
    vi.useRealTimers()
  })

  it('re-dials on a kick instead of sitting out the remaining backoff', async () => {
    let dials = 0
    broker.setSourceProvider(() => {
      dials++
      return lazySource()
    })
    await broker.start(lazySource())
    // Let the backoff climb well past its floor.
    await vi.advanceTimersByTimeAsync(45_000)
    const before = dials

    // The publisher republishes — same port, same string.
    broker.kickReconnect()
    await vi.advanceTimersByTimeAsync(1_500)

    expect(dials).toBeGreaterThan(before)
  })

  it('THROTTLES a republish loop — a kick per floor delay, not a dial storm', async () => {
    broker.setSourceProvider(() => lazySource())
    await broker.start(lazySource())
    await vi.advanceTimersByTimeAsync(45_000)

    // 50 republishes inside one floor delay: only the first may act, or a
    // publisher in a republish loop turns the bounded retreat into a permanent
    // dial at the floor delay.
    for (let i = 0; i < 50; i++) broker.kickReconnect()

    let dials = 0
    broker.setSourceProvider(() => {
      dials++
      return lazySource()
    })
    await vi.advanceTimersByTimeAsync(1_200)
    expect(dials).toBeLessThanOrEqual(1)
  })
})
