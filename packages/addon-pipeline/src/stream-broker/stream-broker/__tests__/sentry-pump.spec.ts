/**
 * The pump: one encode, then a 1 fps re-emit of the SAME bytes until real media
 * arrives.
 *
 * The two rules with a cost behind them:
 *
 *  - **The picture is fetched and encoded ONCE.** Re-fetching per tick would
 *    put a snapshot round-trip and a fork+exec on every second of every
 *    sleeping camera's wake — and frames would cross a process boundary at
 *    frame-rate, which is exactly what D9/D18 forbid.
 *  - **A preparation that lands LATE lands nowhere.** The encode is async; if
 *    the camera woke while it was running, the pump has already been stopped
 *    and the frame must be dropped rather than started on top of live media.
 */
import type { IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SentryPump, type SentryFrame } from '../sentry-pump.js'

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

const FRAME: SentryFrame = { annexB: Buffer.from([0, 0, 0, 1, 0x67]), codec: 'h264' }

interface Harness {
  readonly pump: SentryPump
  readonly emitted: SentryFrame[]
  readonly prepared: string[]
}

function harness(prepare: (url: string) => Promise<SentryFrame | null>): Harness {
  const emitted: SentryFrame[] = []
  const prepared: string[] = []
  const pump = new SentryPump({
    prepare: async (input) => {
      prepared.push(input.sourceUrl)
      return await prepare(input.sourceUrl)
    },
    emit: (frame) => emitted.push(frame),
    logger: createMockLogger(),
    deviceId: 3838,
  })
  return { pump, emitted, prepared }
}

describe('SentryPump', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits the prepared frame as soon as it is ready', async () => {
    const h = harness(async () => FRAME)
    h.pump.start('lazy:rfc4571:3838')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.emitted).toEqual([FRAME])
  })

  it('re-emits the SAME buffer at 1 fps without preparing again', async () => {
    const h = harness(async () => FRAME)
    h.pump.start('lazy:rfc4571:3838')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(4_000)

    expect(h.emitted.length).toBe(5)
    expect(h.emitted.every((f) => f.annexB === FRAME.annexB)).toBe(true)
    expect(h.prepared).toEqual(['lazy:rfc4571:3838'])
  })

  it('stop() ends the re-emit', async () => {
    const h = harness(async () => FRAME)
    h.pump.start('lazy:rfc4571:3838')
    await vi.advanceTimersByTimeAsync(2_500)
    const atStop = h.emitted.length
    h.pump.stop('first real packet')

    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.emitted.length).toBe(atStop)
    expect(h.pump.running).toBe(false)
  })

  it('drops a preparation that lands AFTER the stop — never over live media', async () => {
    let release: (frame: SentryFrame) => void = () => {}
    const h = harness(
      async () =>
        await new Promise<SentryFrame>((resolve) => {
          release = resolve
        }),
    )
    h.pump.start('lazy:rfc4571:3838')
    // The camera woke while the encode was still running.
    h.pump.stop('first real packet')
    release(FRAME)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(h.emitted).toEqual([])
  })

  it('a second start() while running is a no-op — one encode per wake', async () => {
    const h = harness(async () => FRAME)
    h.pump.start('lazy:rfc4571:3838')
    h.pump.start('lazy:rfc4571:3838')
    await vi.advanceTimersByTimeAsync(0)
    h.pump.start('lazy:rfc4571:3838')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(h.prepared.length).toBe(1)
  })

  it('a REFUSED preparation emits nothing and leaves no timer', async () => {
    const h = harness(async () => null)
    h.pump.start('lazy:rfc4571:3838')
    await vi.advanceTimersByTimeAsync(10_000)

    expect(h.emitted).toEqual([])
    expect(h.pump.running).toBe(false)
  })

  it('a preparation that THROWS is reported, not swallowed, and stops the pump', async () => {
    const logger = createMockLogger()
    const pump = new SentryPump({
      prepare: async () => {
        throw new Error('ffmpeg exited 1')
      },
      emit: () => {
        throw new Error('must not emit')
      },
      logger,
      deviceId: 3838,
    })
    pump.start('lazy:rfc4571:3838')
    await vi.advanceTimersByTimeAsync(10)

    expect(logger.warn).toHaveBeenCalled()
    expect(pump.running).toBe(false)
  })

  it('tags every line it logs with the numeric deviceId', async () => {
    const logger = createMockLogger()
    const pump = new SentryPump({
      prepare: async () => FRAME,
      emit: () => {},
      logger,
      deviceId: 3838,
    })
    pump.start('lazy:rfc4571:3838')
    await vi.advanceTimersByTimeAsync(0)
    pump.stop('first real packet')

    const calls = [
      ...vi.mocked(logger.info).mock.calls,
      ...vi.mocked(logger.debug).mock.calls,
      ...vi.mocked(logger.warn).mock.calls,
    ]
    expect(calls.length).toBeGreaterThan(0)
    for (const [, options] of calls) {
      expect(options?.tags).toMatchObject({ deviceId: 3838 })
    }
  })
})
