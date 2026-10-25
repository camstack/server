import { describe, it, expect, vi } from 'vitest'
import { DeviceRestoreRetryScheduler } from '../device-restore-retry.js'
import type { PermanentRestoreFailure } from '../device-restore-retry.js'
import type { SavedDevice } from '../device-management.js'
import type { IScopedLogger } from '../../interfaces/logging.js'
import { DeviceType } from '../device-type.js'

/**
 * A failed device restore is "not yet", never "never" — until the bound
 * says otherwise (D347).
 *
 * On 2026-09-04 a migration held the hub's device-manager while two
 * provider runners restarted; every concurrent restore dial timed out at
 * the transport's 60 s default and NOTHING ever revisited them — 27
 * healthy cameras answered "binding not yet in LocalChildRegistry" for
 * 20 minutes until manual provider restarts. The scheduler under test is
 * the revisit: bounded rounds with growing delays, a capped retry lane
 * width (the failures are evidence of congestion — no re-stampede), and
 * a terminal, VISIBLE failure once the bound is spent (D6 discipline).
 */

function stubLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function row(id: number, parentDeviceId: number | null = null): SavedDevice {
  return {
    id,
    stableId: `cam-${id}`,
    type: DeviceType.Camera,
    name: `cam ${id}`,
    parentDeviceId,
    config: {},
  } as unknown as SavedDevice
}

const tick = (ms = 1): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('DeviceRestoreRetryScheduler — bounded retry, not-yet vs never', () => {
  it('a device that lost a race restores on the next round and is never marked failed', async () => {
    let calls = 0
    const permanent: PermanentRestoreFailure[] = []
    const scheduler = new DeviceRestoreRetryScheduler({
      logger: stubLogger(),
      delaysMs: [1, 1, 1],
      attempt: async () => {
        calls += 1
        // First retry succeeds — the initial failure was a race, not a
        // dead camera.
      },
      onPermanentFailure: (f) => permanent.push(f),
    })

    const terminal = await scheduler.run([{ saved: row(1), error: 'UDS request timed out' }])

    expect(calls).toBe(1)
    expect(terminal).toEqual([])
    expect(permanent).toEqual([])
  })

  it('a device that never answers gets exactly the bounded attempts, then a terminal failure with its reason', async () => {
    let calls = 0
    const permanent: PermanentRestoreFailure[] = []
    const scheduler = new DeviceRestoreRetryScheduler({
      logger: stubLogger(),
      delaysMs: [1, 1, 1],
      attempt: async () => {
        calls += 1
        throw new Error(`attempt ${calls + 1} refused`)
      },
      onPermanentFailure: (f) => permanent.push(f),
      now: () => 12345,
    })

    const terminal = await scheduler.run([{ saved: row(7), error: 'initial timeout' }])

    // 3 retry rounds — never an infinite loop.
    expect(calls).toBe(3)
    expect(terminal).toHaveLength(1)
    expect(permanent).toHaveLength(1)
    expect(permanent[0]).toMatchObject({
      deviceId: 7,
      stableId: 'cam-7',
      // 1 initial + 3 retries.
      attempts: 4,
      lastError: 'attempt 4 refused',
      failedAt: 12345,
    })
  })

  it('retry width is capped — a failed batch never re-stampedes full-width', async () => {
    let inFlight = 0
    let peak = 0
    const scheduler = new DeviceRestoreRetryScheduler({
      logger: stubLogger(),
      delaysMs: [1],
      concurrency: 2,
      attempt: async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await tick(5)
        inFlight -= 1
      },
      onPermanentFailure: () => {},
    })

    await scheduler.run(
      [1, 2, 3, 4, 5, 6, 7, 8].map((id) => ({
        saved: row(id),
        error: 'timeout',
      })),
    )

    expect(peak).toBe(2)
  })

  it('within a round, hub-adopted children are attempted only after every parent settled', async () => {
    const order: number[] = []
    const restored = new Set<number>()
    const permanent: PermanentRestoreFailure[] = []
    const scheduler = new DeviceRestoreRetryScheduler({
      logger: stubLogger(),
      delaysMs: [1],
      attempt: async (saved) => {
        order.push(saved.id)
        if (saved.parentDeviceId !== null && !restored.has(saved.parentDeviceId)) {
          throw new Error(`parent ${saved.parentDeviceId} not restored`)
        }
        // Parent is slow — a child racing it in the same round would fail.
        await tick(5)
        restored.add(saved.id)
      },
      onPermanentFailure: (f) => permanent.push(f),
    })

    await scheduler.run([
      { saved: row(9, 1), error: 'parent device 1 not restored' },
      { saved: row(1), error: 'timeout' },
    ])

    expect(order).toEqual([1, 9])
    expect(permanent).toEqual([])
  })

  it('cancel() stops the rounds and marks NOTHING as permanently failed — shutdown is not "never"', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('still failing')
    })
    const permanent: PermanentRestoreFailure[] = []
    const scheduler = new DeviceRestoreRetryScheduler({
      logger: stubLogger(),
      delaysMs: [50, 50],
      attempt,
      onPermanentFailure: (f) => permanent.push(f),
    })

    const run = scheduler.run([{ saved: row(3), error: 'timeout' }])
    scheduler.cancel()
    const terminal = await run

    expect(attempt).not.toHaveBeenCalled()
    expect(terminal).toEqual([])
    expect(permanent).toEqual([])
  })
})
