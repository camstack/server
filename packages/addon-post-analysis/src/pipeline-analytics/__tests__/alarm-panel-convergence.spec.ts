import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { callDeferredRelease } from '../../__tests__/support/vitest-mock.js'
import {
  type AlarmPanelScheduler,
  type AlarmPanelTimer,
  startAlarmPanelConvergence,
} from '../alarm-panel-convergence.js'

/**
 * A scheduler a test drives by hand. `setInterval` is never involved, so a
 * ten-minute budget is exercised in microseconds and nothing is left running.
 */
interface ManualClock {
  readonly scheduler: AlarmPanelScheduler
  readonly tick: () => Promise<void>
  readonly cleared: () => boolean
  readonly intervalMs: () => number | null
}

function manualClock(): ManualClock {
  let fire: (() => void) | null = null
  let ms: number | null = null
  let cleared = false
  const scheduler: AlarmPanelScheduler = (fn, intervalMs): AlarmPanelTimer => {
    fire = fn
    ms = intervalMs
    return {
      clear: (): void => {
        cleared = true
      },
    }
  }
  return {
    scheduler,
    tick: async (): Promise<void> => {
      if (cleared) return
      fire?.()
      // Let the async attempt inside the tick settle.
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    },
    cleared: (): boolean => cleared,
    intervalMs: (): number | null => ms,
  }
}

function fakeLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: (): IScopedLogger => logger,
    withTags: (): IScopedLogger => logger,
  }
  return logger
}

describe('startAlarmPanelConvergence', () => {
  it('keeps retrying a declaration that THREW, and stops on the first success', async () => {
    // The live failure: `integrations.getByAddonId` is not routable yet because
    // the child forked before the parent registered the service. The boot pass
    // has already thrown; convergence has to carry it the rest of the way.
    const attempt = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(
        new Error(
          'parent could not route child unowned cap call "integrations.getByAddonId": ' +
            "Service 'integrations.integrations.getByAddonId' is not found.",
        ),
      )
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
    const clock = manualClock()
    const logger = fakeLogger()

    startAlarmPanelConvergence({ attempt, logger, scheduler: clock.scheduler, retryMs: 1_000 })

    expect(attempt).toHaveBeenCalledTimes(0)
    await clock.tick()
    await clock.tick()
    expect(clock.cleared()).toBe(false)
    await clock.tick()

    expect(attempt).toHaveBeenCalledTimes(3)
    expect(clock.cleared()).toBe(true)

    // And it stays stopped — no further passes once the panel is up.
    await clock.tick()
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(clock.intervalMs()).toBe(1_000)
  })

  it('never overlaps two passes', async () => {
    // `reconcile` creates devices; two concurrent creates for one stableId is
    // the collision the adopt guard exists to avoid.
    let release: ((landed: boolean) => void) | null = null
    const attempt = vi.fn<() => Promise<boolean>>(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        }),
    )
    const clock = manualClock()

    startAlarmPanelConvergence({ attempt, logger: fakeLogger(), scheduler: clock.scheduler })

    await clock.tick()
    await clock.tick()
    await clock.tick()
    expect(attempt).toHaveBeenCalledTimes(1)

    callDeferredRelease(release, true)
    await Promise.resolve()
    await Promise.resolve()
    expect(clock.cleared()).toBe(true)
  })

  it('gives up loudly after the attempt budget rather than timing forever', async () => {
    const attempt = vi.fn<() => Promise<boolean>>().mockResolvedValue(false)
    const clock = manualClock()
    const logger = fakeLogger()

    startAlarmPanelConvergence({
      attempt,
      logger,
      scheduler: clock.scheduler,
      maxAttempts: 3,
    })

    await clock.tick()
    await clock.tick()
    expect(clock.cleared()).toBe(false)
    await clock.tick()

    expect(attempt).toHaveBeenCalledTimes(3)
    expect(clock.cleared()).toBe(true)
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  it('stops on request', async () => {
    const attempt = vi.fn<() => Promise<boolean>>().mockResolvedValue(false)
    const clock = manualClock()

    const convergence = startAlarmPanelConvergence({
      attempt,
      logger: fakeLogger(),
      scheduler: clock.scheduler,
    })
    convergence.stop()
    convergence.stop()
    await clock.tick()

    expect(attempt).not.toHaveBeenCalled()
    expect(clock.cleared()).toBe(true)
  })
})
