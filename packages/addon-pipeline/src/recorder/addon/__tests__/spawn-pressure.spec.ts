/**
 * Under fork pressure the recorder REDUCES concurrency — it does not
 * serialise, and it does not insist.
 *
 * ⛔ Sequential attach is not the answer: deliberately overlapped
 * boot attach so one unpublished camera could not stall the fleet (the first
 * pin landed at t0+223 s before it). The bounded parallelism stays; what
 * changes is that its bound now MOVES — down on EAGAIN, back up once the host
 * stops complaining.
 */
import { describe, expect, it, vi } from 'vitest'
import { ReadinessRestore } from '../readiness-restore.js'
import { PRESSURE_RECOVERY_MS, SpawnPressureGovernor } from '../spawn-pressure.js'

function makeLogger(): {
  readonly info: ReturnType<typeof vi.fn>
  readonly warn: ReturnType<typeof vi.fn>
  readonly error: ReturnType<typeof vi.fn>
  readonly debug: ReturnType<typeof vi.fn>
} {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

describe('SpawnPressureGovernor', () => {
  it('halves the limit on pressure and never goes below one', () => {
    let now = 0
    const logger = makeLogger()
    const governor = new SpawnPressureGovernor({
      maxConcurrency: 8,
      now: () => now,
      logger: logger as never,
    })
    expect(governor.concurrency).toBe(8)

    governor.report(101)
    expect(governor.concurrency).toBe(4)
    governor.report(101)
    expect(governor.concurrency).toBe(2)
    governor.report(101)
    expect(governor.concurrency).toBe(1)
    governor.report(101)
    expect(governor.concurrency).toBe(1)
    // Named per camera, like every other device line.
    expect(logger.warn).toHaveBeenCalledWith(
      'recorder: spawn pressure — reducing attach concurrency',
      expect.objectContaining({ tags: { deviceId: 101 } }),
    )
  })

  it('recovers one step per quiet interval, back to the full bound', () => {
    let now = 0
    const governor = new SpawnPressureGovernor({ maxConcurrency: 8, now: () => now })
    governor.report(101)
    governor.report(101)
    expect(governor.concurrency).toBe(2)

    // Still inside the quiet window — nothing moves.
    now += PRESSURE_RECOVERY_MS - 1
    expect(governor.concurrency).toBe(2)

    now += 1
    expect(governor.concurrency).toBe(3)
    now += PRESSURE_RECOVERY_MS
    expect(governor.concurrency).toBe(4)
    for (let i = 0; i < 10; i++) now += PRESSURE_RECOVERY_MS
    expect(governor.concurrency).toBe(8)
    // …and stops there: recovery restores the bound, it never raises it.
    now += PRESSURE_RECOVERY_MS * 10
    expect(governor.concurrency).toBe(8)
  })

  it('a fresh report during recovery halves the CURRENT limit, not the max', () => {
    let now = 0
    const governor = new SpawnPressureGovernor({ maxConcurrency: 8, now: () => now })
    governor.report(101)
    expect(governor.concurrency).toBe(4)
    now += PRESSURE_RECOVERY_MS
    expect(governor.concurrency).toBe(5)
    governor.report(101)
    expect(governor.concurrency).toBe(2)
  })
})

describe('ReadinessRestore with a governed bound', () => {
  it('reads the concurrency on every drain, so pressure shrinks the NEXT drain', async () => {
    let now = 0
    const governor = new SpawnPressureGovernor({ maxConcurrency: 4, now: () => now })
    let peak = 0
    let inFlight = 0
    const restore = new ReadinessRestore<number, true>({
      subscribeReady: () => () => undefined,
      concurrency: () => governor.concurrency,
      attempt: async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 1))
        inFlight--
      },
    })

    await restore.start([1, 2, 3, 4, 5, 6, 7, 8].map((id) => [id, true] as const))
    expect(peak).toBe(4)

    governor.report(101)
    governor.report(101)
    peak = 0
    await restore.start([9, 10, 11, 12, 13, 14, 15, 16].map((id) => [id, true] as const))
    expect(peak).toBe(1)
  })
})
