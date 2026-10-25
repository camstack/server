/**
 * A failed acquire used to kill a camera's detection permanently.
 *
 * `startGuardedSessionDecode` returns its teardown SYNCHRONOUSLY, and the
 * caller stores it as `attachment.detectionUnsubscribe`. When the background
 * acquire then resolved `null` (or threw), the old code simply `return`ed: the
 * handle stayed non-null, the pump never started, so `onEnded` —
 * `handleDetectionDecodeEnded`, the whole re-dial/detach recovery — could
 * never fire. Phase stayed `active`, zero frames arrived, forever.
 *
 * The motion path was hardened against exactly this shape (see
 * MOTION_FRESHNESS_WINDOW_MS, whose comment names "a failed
 * acquireSessionDecodeRestreamFrom acquire never retries, leaving the handle
 * permanently non-null with zero frames arriving"). The detection path was not.
 *
 * Observed live on 2026-07-30 right after a deploy:
 *   [hub/pipeline-runner] [Camera front door] WARN
 *   session-decode: guarded start failed {error="stream-broker.getStream…"}
 *
 * The inference timeout added the same day does NOT cover this: there no
 * frames arrive at all, so the queue stays empty and the stall detector is
 * silent by design.
 */

import type { IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startGuardedSessionDecode, type GuardedPumpHooks } from '../guarded-session-decode.js'
import { LiveDecodeWorkerAdmission } from '../live-worker-admission.js'

function makeLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const FAST_RETRIES = [10, 20, 40] as const

describe('startGuardedSessionDecode — a failed acquire must be retried', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('retries when acquire resolves null, and starts the pump once it succeeds', async () => {
    const logger = makeLogger()
    const release = vi.fn().mockResolvedValue(undefined)
    const startPump = vi.fn(() => vi.fn())
    let attempts = 0
    const acquire = vi.fn(async () => {
      attempts++
      return attempts < 3 ? null : { source: 'S' as const, release }
    })

    startGuardedSessionDecode({ acquire, startPump, logger, acquireRetryDelaysMs: FAST_RETRIES })
    await vi.advanceTimersByTimeAsync(200)

    expect(attempts).toBeGreaterThanOrEqual(3)
    expect(startPump).toHaveBeenCalledTimes(1)
  })

  it('retries when acquire THROWS, not only when it returns null', async () => {
    const logger = makeLogger()
    const release = vi.fn().mockResolvedValue(undefined)
    const startPump = vi.fn(() => vi.fn())
    let attempts = 0
    const acquire = vi.fn(async () => {
      attempts++
      if (attempts < 2) throw new Error('stream-broker.getStreamWithCodec unavailable')
      return { source: 'S' as const, release }
    })

    startGuardedSessionDecode({ acquire, startPump, logger, acquireRetryDelaysMs: FAST_RETRIES })
    await vi.advanceTimersByTimeAsync(200)

    expect(startPump).toHaveBeenCalledTimes(1)
  })

  it('stops retrying once torn down, and never starts a pump after that', async () => {
    const logger = makeLogger()
    const startPump = vi.fn(() => vi.fn())
    const acquire = vi.fn(async () => null)

    const teardown = startGuardedSessionDecode({
      acquire,
      startPump,
      logger,
      acquireRetryDelaysMs: FAST_RETRIES,
    })
    await vi.advanceTimersByTimeAsync(50)
    const attemptsAtTeardown = acquire.mock.calls.length
    teardown()
    await vi.advanceTimersByTimeAsync(500)

    expect(acquire.mock.calls.length).toBe(attemptsAtTeardown)
    expect(startPump).not.toHaveBeenCalled()
  })

  it('releases a restream that arrives after teardown instead of leaking it', async () => {
    const logger = makeLogger()
    const release = vi.fn().mockResolvedValue(undefined)
    const startPump = vi.fn(() => vi.fn())
    let resolveAcquire!: (v: { source: 'S'; release: typeof release } | null) => void
    const acquire = () =>
      new Promise<{ source: 'S'; release: typeof release } | null>((r) => {
        resolveAcquire = r
      })

    const teardown = startGuardedSessionDecode({
      acquire,
      startPump,
      logger,
      acquireRetryDelaysMs: FAST_RETRIES,
    })
    teardown()
    resolveAcquire({ source: 'S', release })
    await vi.advanceTimersByTimeAsync(100)

    expect(startPump).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('says something on the first failure — a silent retry is the same outage, slower', async () => {
    const logger = makeLogger()
    const startPump = vi.fn(() => vi.fn())
    const acquire = vi.fn(async () => null)

    const teardown = startGuardedSessionDecode({
      acquire,
      startPump,
      logger,
      acquireRetryDelaysMs: FAST_RETRIES,
    })
    await vi.advanceTimersByTimeAsync(100)
    teardown()

    expect(logger.warn).toHaveBeenCalled()
  })
})

/**
 * The live-decode-worker ceiling. A refusal must behave like "no source yet":
 * temporary, logged, and retried on the ladder that already exists — never a
 * queue (a live decode session lasts as long as the motion does, so queuing one
 * means decoding a moment that has already passed) and never silence.
 */
describe('startGuardedSessionDecode — the node live-worker ceiling', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('never acquires a restream while refused, and starts once a slot frees', async () => {
    const logger = makeLogger()
    const release = vi.fn().mockResolvedValue(undefined)
    const startPump = vi.fn(() => vi.fn())
    const acquire = vi.fn(async () => ({ source: 'S' as const, release }))
    let admitted = false
    const admitWorker = vi.fn(() => (admitted ? { release: vi.fn() } : null))

    startGuardedSessionDecode({
      acquire,
      startPump,
      logger,
      admitWorker,
      acquireRetryDelaysMs: FAST_RETRIES,
    })
    await vi.advanceTimersByTimeAsync(100)
    // Refused: no broker restream was taken, and no worker was forked. Taking
    // the restream anyway would hold a refcount for a session that cannot run.
    expect(acquire).not.toHaveBeenCalled()
    expect(startPump).not.toHaveBeenCalled()
    expect(admitWorker.mock.calls.length).toBeGreaterThan(1) // kept retrying

    admitted = true
    await vi.advanceTimersByTimeAsync(200)
    expect(startPump).toHaveBeenCalledTimes(1)
  })

  it('returns the slot when the WORKER exits — not at the teardown request (D652)', async () => {
    const logger = makeLogger()
    const release = vi.fn().mockResolvedValue(undefined)
    const stopPump = vi.fn()
    const hookBag: GuardedPumpHooks[] = []
    const startPump = vi.fn((_source: 'S', h: GuardedPumpHooks) => {
      hookBag.push(h)
      return stopPump
    })
    const acquire = vi.fn(async () => ({ source: 'S' as const, release }))
    const releaseSlot = vi.fn()
    const admitWorker = vi.fn(() => ({ release: releaseSlot }))

    const teardown = startGuardedSessionDecode({
      acquire,
      startPump,
      logger,
      admitWorker,
      acquireRetryDelaysMs: FAST_RETRIES,
    })
    await vi.advanceTimersByTimeAsync(50)
    expect(startPump).toHaveBeenCalledTimes(1)

    teardown()
    // The worker is DRAINING: it still holds its decoder, GPU pool and hold,
    // so it still counts. The restream, which it no longer reads, goes now.
    expect(stopPump).toHaveBeenCalledWith('drain')
    expect(release).toHaveBeenCalledTimes(1)
    expect(releaseSlot).not.toHaveBeenCalled()

    // The process exits: now, and only now, the slot comes back. A slot that
    // never comes back leaks the budget until nothing is admitted again.
    const hooks = hookBag.at(0)
    if (hooks === undefined) throw new Error('expected pump hooks')
    hooks.onWorkerGone()
    expect(releaseSlot).toHaveBeenCalledTimes(1)
  })

  it('the ceiling counts a DRAINING worker: a re-attach waits for it to exit', async () => {
    const logger = makeLogger()
    const admission = new LiveDecodeWorkerAdmission({ limit: 1, logger })
    const acquire = vi.fn(async () => ({
      source: 'S' as const,
      release: vi.fn().mockResolvedValue(undefined),
    }))
    const gone: Array<() => void> = []
    const startPump = vi.fn((_source: 'S', h: GuardedPumpHooks) => {
      gone.push(h.onWorkerGone)
      return vi.fn()
    })
    const start = () =>
      startGuardedSessionDecode({
        acquire,
        startPump,
        logger,
        admitWorker: () => admission.admit(101, 'detect'),
        acquireRetryDelaysMs: FAST_RETRIES,
      })

    const first = start()
    await vi.advanceTimersByTimeAsync(50)
    expect(startPump).toHaveBeenCalledTimes(1)

    // Detach, then the camera is wanted again while the first worker drains.
    first()
    start()
    await vi.advanceTimersByTimeAsync(200)
    // Two workers for one camera would each hold a decoder and a hold; the
    // ceiling (1) must refuse the second until the first is really gone.
    expect(startPump).toHaveBeenCalledTimes(1)
    expect(admission.inFlight).toBe(1)

    gone[0]?.()
    await vi.advanceTimersByTimeAsync(200)
    expect(startPump).toHaveBeenCalledTimes(2)
    expect(admission.inFlight).toBe(1)
  })

  // The ONLY holder of a slot before a pump starts is the start loop itself;
  // a teardown during the acquire is seen by the loop's `aborted` check, which
  // returns the slot and the late restream.
  it('a teardown during the acquire: the start loop returns the slot, no pump starts', async () => {
    const logger = makeLogger()
    const releaseSlot = vi.fn()
    let resolveAcquire!: (v: { source: 'S'; release: () => Promise<void> } | null) => void
    const acquire = () =>
      new Promise<{ source: 'S'; release: () => Promise<void> } | null>((r) => {
        resolveAcquire = r
      })
    const startPump = vi.fn(() => vi.fn())
    const teardown = startGuardedSessionDecode({
      acquire,
      startPump,
      logger,
      admitWorker: () => ({ release: releaseSlot }),
      acquireRetryDelaysMs: FAST_RETRIES,
    })
    await vi.advanceTimersByTimeAsync(10)
    teardown()
    resolveAcquire({ source: 'S', release: vi.fn().mockResolvedValue(undefined) })
    await vi.advanceTimersByTimeAsync(10)
    expect(startPump).not.toHaveBeenCalled()
    expect(releaseSlot).toHaveBeenCalledTimes(1)
  })

  it('returns the slot when the acquire that follows admission fails', async () => {
    const logger = makeLogger()
    const startPump = vi.fn(() => vi.fn())
    const acquire = vi.fn(async () => null)
    const releaseSlot = vi.fn()
    const admitWorker = vi.fn(() => ({ release: releaseSlot }))

    const teardown = startGuardedSessionDecode({
      acquire,
      startPump,
      logger,
      admitWorker,
      acquireRetryDelaysMs: FAST_RETRIES,
    })
    await vi.advanceTimersByTimeAsync(100)
    teardown()
    // Every retry took a slot and must have given it back, or a camera whose
    // broker is not ready would eat the whole node budget.
    expect(admitWorker.mock.calls.length).toBeGreaterThan(1)
    expect(releaseSlot.mock.calls.length).toBe(admitWorker.mock.calls.length)
  })

  it('a startPump that THROWS returns the slot and the restream (I-B)', async () => {
    const logger = makeLogger()
    const releaseSlot = vi.fn()
    const restream = vi.fn().mockResolvedValue(undefined)
    const startPump = vi.fn(() => {
      throw new Error('fork failed')
    })
    const teardown = startGuardedSessionDecode({
      acquire: vi.fn(async () => ({ source: 'S' as const, release: restream })),
      startPump,
      logger,
      admitWorker: () => ({ release: releaseSlot }),
      acquireRetryDelaysMs: FAST_RETRIES,
    })
    await vi.advanceTimersByTimeAsync(50)
    expect(startPump).toHaveBeenCalledTimes(1)
    expect(releaseSlot).toHaveBeenCalledTimes(1)
    expect(restream).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      'session-decode: guarded start failed',
      expect.anything(),
    )
    // …and a later teardown does not release the restream a second time.
    teardown()
    expect(restream).toHaveBeenCalledTimes(1)
  })

  it('a teardown from INSIDE startPump is replayed on the pump, in its mode (M-A)', async () => {
    const logger = makeLogger()
    const stopPump = vi.fn()
    let teardown: ReturnType<typeof startGuardedSessionDecode> | null = null
    const startPump = vi.fn(() => {
      // A consumer that finished on its very first frames tears down while
      // the pump is still being built — `stopPump` is not assigned yet.
      teardown?.('immediate')
      return stopPump
    })
    teardown = startGuardedSessionDecode({
      acquire: vi.fn(async () => ({
        source: 'S' as const,
        release: vi.fn().mockResolvedValue(undefined),
      })),
      startPump,
      logger,
      acquireRetryDelaysMs: FAST_RETRIES,
    })
    await vi.advanceTimersByTimeAsync(50)
    expect(stopPump).toHaveBeenCalledExactlyOnceWith('immediate')
  })

  it('a refused start is WOKEN by a returned slot — it does not sit out the 2 s timer', async () => {
    const logger = makeLogger()
    const admission = new LiveDecodeWorkerAdmission({ limit: 1, logger })
    const gone: Array<() => void> = []
    const startPump = vi.fn((_source: 'S', h: GuardedPumpHooks) => {
      gone.push(h.onWorkerGone)
      return vi.fn()
    })
    const start = () =>
      startGuardedSessionDecode({
        acquire: vi.fn(async () => ({
          source: 'S' as const,
          release: vi.fn().mockResolvedValue(undefined),
        })),
        startPump,
        logger,
        admitWorker: () => admission.admit(101, 'detect'),
        slotWaiter: () => admission.slotWaiter(101),
        acquireRetryDelaysMs: [2_000],
      })
    const first = start()
    await vi.advanceTimersByTimeAsync(10)
    first()
    start() // refused: the first worker is still draining
    await vi.advanceTimersByTimeAsync(10)
    expect(startPump).toHaveBeenCalledTimes(1)

    gone[0]?.() // the draining worker exits
    await vi.advanceTimersByTimeAsync(10)
    // Far inside the 2 s backoff: the slot woke it.
    expect(startPump).toHaveBeenCalledTimes(2)
  })

  it('a start parked at the ceiling and then torn down leaves NO listener behind (item 2)', async () => {
    const logger = makeLogger()
    const admission = new LiveDecodeWorkerAdmission({ limit: 1, logger })
    const holder = admission.admit(1, 'detect') // the node is full
    const teardown = startGuardedSessionDecode({
      acquire: vi.fn(async () => null),
      startPump: vi.fn(() => vi.fn()),
      logger,
      admitWorker: () => admission.admit(101, 'detect'),
      slotWaiter: () => admission.slotWaiter(101),
      acquireRetryDelaysMs: [2_000],
    })
    await vi.advanceTimersByTimeAsync(10)
    expect(admission.slotWaiters).toBe(1)
    teardown()
    await vi.advanceTimersByTimeAsync(10)
    expect(admission.slotWaiters).toBe(0)
    holder?.release()
  })

  it('N parked starts + ONE freed slot: exactly one proceeds, FIFO, with no burst of WARNs (item 4)', async () => {
    const logger = makeLogger()
    const admission = new LiveDecodeWorkerAdmission({ limit: 1, logger })
    const holder = admission.admit(1, 'detect')
    const started: number[] = []
    let admitCalls = 0
    const startFor = (deviceId: number) =>
      startGuardedSessionDecode({
        acquire: vi.fn(async () => ({
          source: 'S' as const,
          release: vi.fn().mockResolvedValue(undefined),
        })),
        startPump: vi.fn(() => {
          started.push(deviceId)
          return vi.fn()
        }),
        logger,
        admitWorker: () => {
          admitCalls += 1
          return admission.admit(deviceId, 'detect')
        },
        slotWaiter: () => admission.slotWaiter(101),
        acquireRetryDelaysMs: [2_000],
      })
    for (const deviceId of [11, 12, 13, 14, 15]) {
      startFor(deviceId)
      await vi.advanceTimersByTimeAsync(1)
    }
    expect(admission.slotWaiters).toBe(5)
    const warnsBefore = vi.mocked(logger.warn).mock.calls.length
    expect(warnsBefore).toBe(5) // one per camera entering the refused state

    const admitsBefore = admitCalls
    holder?.release()
    await vi.advanceTimersByTimeAsync(10)
    expect(started).toEqual([11]) // the longest-parked, and only it
    // ONE start was woken and asked; the other four were not disturbed.
    expect(admitCalls - admitsBefore).toBe(1)
    expect(admission.slotWaiters).toBe(4)
    expect(vi.mocked(logger.warn).mock.calls.length).toBe(warnsBefore)

    // The fallback timer still retries the rest — at debug, not a WARN each.
    // The retry must HAPPEN: four parked starts, four more asks, none admitted.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(started).toEqual([11])
    expect(admitCalls - admitsBefore).toBe(1 + 4)
    expect(admission.slotWaiters).toBe(4)
    expect(vi.mocked(logger.warn).mock.calls.length).toBe(warnsBefore)
  })

  /**
   * Round 4. Two hand-off gaps in the wake, and the rule that a lost wake must
   * not stretch the fallback timer — which only a multi-step ladder can see.
   */
  it('a woken start torn down before it can ask passes the slot to the next parked start (M1.1)', async () => {
    const logger = makeLogger()
    const admission = new LiveDecodeWorkerAdmission({ limit: 1, logger })
    const holder = admission.admit(1, 'detect')
    const started: number[] = []
    const startFor = (deviceId: number) =>
      startGuardedSessionDecode({
        acquire: vi.fn(async () => ({
          source: 'S' as const,
          release: vi.fn().mockResolvedValue(undefined),
        })),
        startPump: vi.fn(() => {
          started.push(deviceId)
          return vi.fn()
        }),
        logger,
        admitWorker: () => admission.admit(deviceId, 'detect'),
        slotWaiter: () => admission.slotWaiter(deviceId),
        acquireRetryDelaysMs: [2_000],
      })
    const teardownA = startFor(11)
    await vi.advanceTimersByTimeAsync(1)
    startFor(12)
    await vi.advanceTimersByTimeAsync(1)
    expect(admission.slotWaiters).toBe(2)

    // The slot comes back and A is woken — then A is torn down in the SAME
    // tick, before its microtask runs. The wake must not die with it.
    holder?.release()
    teardownA()
    await vi.advanceTimersByTimeAsync(10)
    // Far inside B's 2 s fallback: B took the slot A could not use.
    expect(started).toEqual([12])
    expect(admission.inFlight).toBe(1)
    expect(admission.slotWaiters).toBe(0)
  })

  it('a woken start that is refused again keeps its FIFO place (M1.2)', async () => {
    const logger = makeLogger()
    const admission = new LiveDecodeWorkerAdmission({ limit: 1, logger })
    const holder = admission.admit(1, 'detect')
    const started: number[] = []
    const startFor = (deviceId: number) =>
      startGuardedSessionDecode({
        acquire: vi.fn(async () => ({
          source: 'S' as const,
          release: vi.fn().mockResolvedValue(undefined),
        })),
        startPump: vi.fn(() => {
          started.push(deviceId)
          return vi.fn()
        }),
        logger,
        admitWorker: () => admission.admit(deviceId, 'detect'),
        slotWaiter: () => admission.slotWaiter(deviceId),
        acquireRetryDelaysMs: [2_000],
      })
    startFor(11)
    await vi.advanceTimersByTimeAsync(1)
    startFor(12)
    await vi.advanceTimersByTimeAsync(1)

    // A is woken, but a start that was never parked takes the slot first.
    holder?.release()
    const thief = admission.admit(99, 'detect')
    await vi.advanceTimersByTimeAsync(10)
    expect(started).toEqual([])
    expect(admission.slotWaiters).toBe(2) // A re-parked …

    thief?.release()
    await vi.advanceTimersByTimeAsync(10)
    expect(started).toEqual([11]) // … at the FRONT: the slot is A's, not B's
  })

  it('a lost wake does not stretch the fallback timer — seen only on a multi-step ladder', async () => {
    const logger = makeLogger()
    const admission = new LiveDecodeWorkerAdmission({ limit: 1, logger })
    const holder = admission.admit(1, 'detect')
    let admitCalls = 0
    startGuardedSessionDecode({
      acquire: vi.fn(async () => ({
        source: 'S' as const,
        release: vi.fn().mockResolvedValue(undefined),
      })),
      startPump: vi.fn(() => vi.fn()),
      logger,
      admitWorker: () => {
        admitCalls += 1
        return admission.admit(11, 'detect')
      },
      slotWaiter: () => admission.slotWaiter(11),
      acquireRetryDelaysMs: [100, 1_000, 10_000],
    })
    await vi.advanceTimersByTimeAsync(1)
    expect(admitCalls).toBe(1) // refused at attempt 0: the 100 ms rung

    // t≈50: the slot comes back, the start is woken — and loses the slot to a
    // start that was never parked. It is refused again.
    await vi.advanceTimersByTimeAsync(50)
    holder?.release()
    const thief = admission.admit(99, 'detect')
    await vi.advanceTimersByTimeAsync(1)
    expect(admitCalls).toBe(2)

    // A wake is not an attempt: the next fallback is still the 100 ms rung.
    // Were it counted, the start would sit on the 1 000 ms rung instead.
    await vi.advanceTimersByTimeAsync(90)
    expect(admitCalls).toBe(2)
    await vi.advanceTimersByTimeAsync(20)
    expect(admitCalls).toBe(3)
    thief?.release()
  })

  it("a second teardown saying 'immediate' while the first drains reaches the pump (escalation)", async () => {
    const logger = makeLogger()
    const stopPump = vi.fn()
    const teardown = startGuardedSessionDecode({
      acquire: vi.fn(async () => ({
        source: 'S' as const,
        release: vi.fn().mockResolvedValue(undefined),
      })),
      startPump: vi.fn(() => stopPump),
      logger,
      acquireRetryDelaysMs: FAST_RETRIES,
    })
    await vi.advanceTimersByTimeAsync(50)
    teardown('drain')
    expect(stopPump).toHaveBeenLastCalledWith('drain')
    // Shutdown while the drain is in progress: the kill must not wait it out.
    teardown('immediate')
    expect(stopPump).toHaveBeenCalledTimes(2)
    expect(stopPump).toHaveBeenLastCalledWith('immediate')
    // …and a repeat, or a weaker mode, changes nothing.
    teardown('immediate')
    teardown('drain')
    expect(stopPump).toHaveBeenCalledTimes(2)
  })

  it('a teardown during a TIMER-ONLY backoff (no profile yet) still ends the loop: leave() runs', async () => {
    const logger = makeLogger()
    const leave = vi.fn()
    let admitted = false
    const teardown = startGuardedSessionDecode({
      acquire: vi.fn(async () => null), // admitted, then no broker profile
      startPump: vi.fn(() => vi.fn()),
      logger,
      admitWorker: () => (admitted ? { release: vi.fn() } : null),
      slotWaiter: () => ({ wait: vi.fn(), cancel: vi.fn(), leave }),
      acquireRetryDelaysMs: [2_000],
    })
    await vi.advanceTimersByTimeAsync(10) // refused: the waiter is taken
    admitted = true
    await vi.advanceTimersByTimeAsync(2_010) // fallback timer → admitted → acquire null → timer-only wait
    expect(leave).not.toHaveBeenCalled()
    teardown()
    await vi.advanceTimersByTimeAsync(10)
    // Before: the timer was cleared and the promise never resolved, so the
    // loop's `finally` never ran — the start's place and memory were kept forever.
    expect(leave).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('a start refused, torn down while parked, then wanted again is WARNED again (H1, D391)', async () => {
    const logger = makeLogger()
    const admission = new LiveDecodeWorkerAdmission({ limit: 1, logger })
    const holder = admission.admit(1, 'detect')
    const startFor = () =>
      startGuardedSessionDecode({
        acquire: vi.fn(async () => null),
        startPump: vi.fn(() => vi.fn()),
        logger,
        admitWorker: () => admission.admit(102, 'detect'),
        slotWaiter: () => admission.slotWaiter(102),
        acquireRetryDelaysMs: [2_000],
      })
    const refusalWarns = () =>
      vi.mocked(logger.warn).mock.calls.filter(([message]) => String(message).includes('REFUSED'))
        .length

    const first = startFor()
    await vi.advanceTimersByTimeAsync(10)
    expect(refusalWarns()).toBe(1)
    first() // motion cleared before the camera ever got a slot
    await vi.advanceTimersByTimeAsync(10)

    startFor() // the next motion episode, the node still full
    await vi.advanceTimersByTimeAsync(10)
    expect(refusalWarns()).toBe(2)
    holder?.release()
  })

  it('a teardown inside startPump followed by a THROW releases slot and restream exactly once (item 5)', async () => {
    const logger = makeLogger()
    const releaseSlot = vi.fn()
    const restream = vi.fn().mockResolvedValue(undefined)
    let teardown: ReturnType<typeof startGuardedSessionDecode> | null = null
    teardown = startGuardedSessionDecode({
      acquire: vi.fn(async () => ({ source: 'S' as const, release: restream })),
      startPump: vi.fn(() => {
        teardown?.() // releases the restream…
        throw new Error('fork failed') // …then the throw path reaches it again
      }),
      logger,
      admitWorker: () => ({ release: releaseSlot }),
      acquireRetryDelaysMs: FAST_RETRIES,
    })
    await vi.advanceTimersByTimeAsync(50)
    expect(restream).toHaveBeenCalledTimes(1)
    expect(releaseSlot).toHaveBeenCalledTimes(1)
  })
})
