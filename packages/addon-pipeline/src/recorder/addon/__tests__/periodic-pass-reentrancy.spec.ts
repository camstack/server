/**
 * A periodic pass never runs twice at once, and SAYS when it drops a turn.
 *
 * `periodic-pass.ts` had no test of its own: the rule was covered only from one
 * level up, through `RecordingController`, by hanging `enabledDeviceIds()` and
 * waiting for the next reconcile fire. That coverage is real and still passes —
 * this adds the unit-level half, where a run that genuinely never finishes can
 * be injected instead of manufactured out of a dependency, and where the
 * `inFlightMs` on the line can be asserted exactly rather than as "a number".
 *
 * What it protects (measured 2026-08-13): passes awaiting a 60 s broker RPC
 * piled up, dozens of concurrent detach/attach attempts against an already
 * degraded broker, and the recorder went silent for 27 minutes while four
 * cameras recorded nothing.
 */
import type { IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startPeriodicPass } from '../periodic-pass.js'

interface Warn {
  readonly message: string
  readonly meta?: Record<string, unknown>
}

function makeLogger(warns: Warn[]): IScopedLogger {
  const sink = (message: string, opts?: { meta?: Record<string, unknown> }): void => {
    warns.push({ message, ...(opts?.meta ? { meta: opts.meta } : {}) })
  }
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(sink),
    error: vi.fn(),
  }
  return { ...logger, child: () => logger, withTags: () => logger } as unknown as IScopedLogger
}

describe('startPeriodicPass — one run at a time', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('skips the next fire while a run is in flight, and names the skip', async () => {
    const warns: Warn[] = []
    let clock = 1_000
    let release: () => void = () => {}
    const handle = startPeriodicPass({
      name: 'reconcile',
      intervalMs: 1_000,
      slowAfterMs: 60_000,
      now: () => clock,
      logger: makeLogger(warns),
      run: () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    })

    // Fire 1 starts and never settles.
    clock = 2_000
    await vi.advanceTimersByTimeAsync(1_000)
    expect(handle.isRunning()).toBe(true)

    // Fire 2 arrives on top of it.
    clock = 3_000
    await vi.advanceTimersByTimeAsync(1_000)

    const skipped = warns.find((w) => /still running/i.test(w.message))
    expect(skipped).toBeDefined()
    // The line carries how long the in-flight run has been going — without it,
    // "skipped" says nothing about whether the loop is wedged or merely busy.
    expect(skipped?.meta?.['inFlightMs']).toBe(1_000)
    expect(skipped?.meta?.['pass']).toBe('reconcile')

    release()
    await vi.advanceTimersByTimeAsync(0)
    handle.stop()
  })

  it('runs again once the previous one finished — a skip is not a stop', async () => {
    const warns: Warn[] = []
    let runs = 0
    const handle = startPeriodicPass({
      name: 'reconcile',
      intervalMs: 1_000,
      slowAfterMs: 60_000,
      logger: makeLogger(warns),
      run: async () => {
        runs++
      },
    })

    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(runs).toBe(2)
    expect(warns.filter((w) => /still running/i.test(w.message))).toHaveLength(0)
    handle.stop()
  })
})
