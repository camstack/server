/**
 * The audio-chunk plane's idle lease (D461).
 *
 * Until the relay was removed the plane's one subscriber was
 * `pipeline-orchestrator`, a hub process restarted alongside the broker, and
 * an abandoned subscription was a theoretical leak. D461 moved the poller into
 * `audio-analyzer`, which may sit on another node and may die without the
 * orchestrator's `detachDevice` ever landing.
 *
 * On THIS plane an orphan is not merely a queue nobody drains.
 * `subscriberCount` is what the broker's `hasDemand()` reads, so one orphan
 * pins the source dial and the decode session open for the broker's whole
 * life — a camera nobody is listening to, kept streaming by a dead process.
 * So the lease has to do two things, and this file pins both: RELEASE the
 * subscription, and TELL the broker, which is what re-evaluates demand.
 */
import type { DecodedAudioChunk, IScopedLogger, LogExtras } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AUDIO_SUBSCRIPTION_IDLE_MS, AudioChunkPlane } from '../stream-broker/audio-chunk-plane.js'

interface CapturedLine {
  readonly message: string
  readonly meta: Record<string, unknown>
}

/**
 * Logger that records the lines the lease is judged by. Written as a class so
 * it SATISFIES `IScopedLogger` rather than being cast into it — a cast here
 * would let the interface drift out from under the test silently.
 */
class RecordingLogger implements IScopedLogger {
  constructor(private readonly lines: CapturedLine[]) {}

  private record(message: string, extras?: LogExtras): void {
    const meta = extras?.meta
    this.lines.push({
      message,
      meta: typeof meta === 'object' && meta !== null ? { ...meta } : {},
    })
  }

  debug(message: string, extras?: LogExtras): void {
    this.record(message, extras)
  }
  info(message: string, extras?: LogExtras): void {
    this.record(message, extras)
  }
  warn(message: string, extras?: LogExtras): void {
    this.record(message, extras)
  }
  error(message: string, extras?: LogExtras): void {
    this.record(message, extras)
  }
  child(): IScopedLogger {
    return this
  }
  withTags(): IScopedLogger {
    return this
  }
}

function makeChunk(timestamp: number): DecodedAudioChunk {
  return {
    data: Buffer.from([timestamp & 0xff, 0, 0, 0]),
    sampleRate: 8000,
    channels: 1,
    timestamp,
  }
}

describe('AudioChunkPlane — the idle lease under a consumer that died (D461)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps a subscription that is still being drained, however long it runs', () => {
    vi.useFakeTimers()
    const plane = new AudioChunkPlane()
    const { subscriptionId } = plane.subscribe({ tag: 'audio-analyzer' })

    // Four full leases of healthy operation, each punctuated by a pull well
    // inside the lease. The classifier can legitimately hold a poll for tens
    // of seconds, so the bound is generous — but a consumer that pulls is
    // never reaped, no matter how long it has been attached.
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(AUDIO_SUBSCRIPTION_IDLE_MS - 1)
      plane.fanout(makeChunk(i))
      expect(plane.pull(subscriptionId, 8).length).toBeGreaterThan(0)
    }
    expect(plane.subscriberCount).toBe(1)
  })

  it('releases a subscription nobody has drained for the lease, and NAMES it', () => {
    vi.useFakeTimers()
    const lines: CapturedLine[] = []
    const plane = new AudioChunkPlane(new RecordingLogger(lines))
    plane.subscribe({ tag: 'audio-analyzer' })

    vi.advanceTimersByTime(AUDIO_SUBSCRIPTION_IDLE_MS + 1)
    expect(plane.reapIdle().length).toBe(1)
    expect(plane.subscriberCount).toBe(0)

    // D427: the decision is never silent. The line has to carry enough to act
    // on — WHICH consumer, and how long it had been gone — or an operator sees
    // audio stop and has nothing to correlate it with.
    const reaped = lines.find((l) => l.message.includes('REAPED'))
    expect(reaped).toBeDefined()
    expect(reaped?.meta['tag']).toBe('audio-analyzer')
    expect(reaped?.meta['idleMs']).toBeGreaterThanOrEqual(AUDIO_SUBSCRIPTION_IDLE_MS)
  })

  it('tells the broker it reaped, because an audio subscription is DEMAND', () => {
    vi.useFakeTimers()
    const onReaped = vi.fn()
    const plane = new AudioChunkPlane(undefined, onReaped)
    plane.subscribe({ tag: 'audio-analyzer' })

    // The sweep rides `fanout` — the plane has no clock of its own, and the
    // moment a dead consumer costs anything is the moment there is a chunk to
    // put in its queue.
    vi.advanceTimersByTime(AUDIO_SUBSCRIPTION_IDLE_MS + 1)
    plane.fanout(makeChunk(1))

    expect(plane.subscriberCount).toBe(0)
    // Dropping the orphan but leaving the broker's demand standing would have
    // fixed nothing: the source stays dialled and the decoder stays up.
    expect(onReaped).toHaveBeenCalledTimes(1)
  })

  it('does not call back when nothing was reaped', () => {
    vi.useFakeTimers()
    const onReaped = vi.fn()
    const plane = new AudioChunkPlane(undefined, onReaped)
    const { subscriptionId } = plane.subscribe({ tag: 'audio-analyzer' })

    vi.advanceTimersByTime(AUDIO_SUBSCRIPTION_IDLE_MS + 1)
    plane.pull(subscriptionId, 8)
    plane.fanout(makeChunk(1))

    expect(plane.subscriberCount).toBe(1)
    // A `checkDemand()` per chunk would be a suspend/resume evaluation at
    // audio rate for every camera on the node.
    expect(onReaped).not.toHaveBeenCalled()
  })

  it('seeds the lease at subscribe, so a consumer that never polls at all is reaped', () => {
    vi.useFakeTimers()
    const plane = new AudioChunkPlane()
    plane.subscribe({ tag: 'audio-analyzer' })

    // No pull has EVER happened here. Seeding `lastPulledAt` from the epoch
    // (or from nothing) would make this subscription either immortal or reaped
    // on the first sweep; it is measured from `subscribedAt`.
    vi.advanceTimersByTime(AUDIO_SUBSCRIPTION_IDLE_MS - 1)
    expect(plane.reapIdle().length).toBe(0)
    vi.advanceTimersByTime(2)
    expect(plane.reapIdle().length).toBe(1)
  })
})
