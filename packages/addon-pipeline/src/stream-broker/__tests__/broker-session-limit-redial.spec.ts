import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IScopedLogger, StreamSource } from '@camstack/types'
import { StreamBroker } from '../stream-broker/stream-broker'

/**
 * A source may declare the longest session its peer keeps open
 * (`StreamSource.maxSessionMs`). A Home Hub cuts every child's session after
 * 28 min 07 s; the cut landed mid-recording and cost a ~108 s gap each time.
 * The broker owns the behaviour for ANY source that declares a limit: a planned
 * re-dial before it, announced through `onSourceRestart` so consumers roll over
 * at once. A source that declares none is never re-dialed on a timer.
 */

function mockLogger(): IScopedLogger {
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

const LIMIT_MS = 60_000

function pushSource(maxSessionMs?: number): StreamSource {
  return {
    type: 'push-rtp',
    url: '',
    videoCodec: 'h264',
    ...(maxSessionMs !== undefined ? { maxSessionMs } : {}),
  }
}

describe('StreamBroker planned re-dial before a declared session limit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-dials a source with a declared limit before it elapses, and notifies consumers', async () => {
    const broker = new StreamBroker('3628/main', mockLogger())
    const restarts: string[] = []
    broker.onSourceRestart((reason) => restarts.push(reason))
    broker.onEncodedData(() => {})
    await broker.start(pushSource(LIMIT_MS))
    expect(restarts).toEqual([])

    await vi.advanceTimersByTimeAsync(LIMIT_MS - 1_000)
    expect(restarts).toEqual([])

    await vi.advanceTimersByTimeAsync(2_000)
    expect(restarts.length).toBe(1)

    // The next session gets its own limit.
    await vi.advanceTimersByTimeAsync(LIMIT_MS + 1_000)
    expect(restarts.length).toBe(2)
    await broker.stop()
  })

  it('tells observers the url is unchanged and the dial was not a publisher kick', async () => {
    const broker = new StreamBroker('3628/main', mockLogger())
    const infos: Array<{ urlChanged: boolean; kicked: boolean }> = []
    broker.onSourceRestart((_reason, info) => infos.push(info))
    broker.onEncodedData(() => {})
    await broker.start(pushSource(LIMIT_MS))
    await vi.advanceTimersByTimeAsync(LIMIT_MS + 1_000)
    expect(infos).toEqual([{ urlChanged: false, kicked: false }])
    await broker.stop()
  })

  it('never re-dials a source that declares no limit', async () => {
    const broker = new StreamBroker('3629/main', mockLogger())
    const restarts: string[] = []
    broker.onSourceRestart((reason) => restarts.push(reason))
    broker.onEncodedData(() => {})
    await broker.start(pushSource())

    await vi.advanceTimersByTimeAsync(24 * 3_600_000)
    expect(restarts).toEqual([])
    await broker.stop()
  })

  it('does not re-dial when nobody is attached, and stop() cancels the timer', async () => {
    const idle = new StreamBroker('3630/main', mockLogger())
    const idleRestarts: string[] = []
    idle.onSourceRestart((reason) => idleRestarts.push(reason))
    await idle.start(pushSource(LIMIT_MS))
    await vi.advanceTimersByTimeAsync(LIMIT_MS * 3)
    expect(idleRestarts).toEqual([])
    await idle.stop()

    const stopped = new StreamBroker('3631/main', mockLogger())
    const stoppedRestarts: string[] = []
    stopped.onSourceRestart((reason) => stoppedRestarts.push(reason))
    stopped.onEncodedData(() => {})
    await stopped.start(pushSource(LIMIT_MS))
    await stopped.stop()
    await vi.advanceTimersByTimeAsync(LIMIT_MS * 3)
    expect(stoppedRestarts).toEqual([])
  })
})
