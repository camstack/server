/**
 * Unit tests for the periodic footage-retention sweep (`RetentionSweeper`).
 *
 * Drives the class directly with a mock `prune` (stands in for the `recording`
 * cap's `pruneFootage`) and a fake config map, under fake timers — so every
 * behaviour (arm + run-immediately, prune only policy devices, skip no-policy
 * devices, single-flight, clear-on-teardown) is exercised without booting the
 * whole recorder addon.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RecordingConfig } from '@camstack/types'
import {
  RetentionSweeper,
  hasRetentionPolicy,
  type RetentionPruneResult,
  type RetentionSweeperDeps,
} from '../retention-sweep.js'

const INTERVAL_MS = 60 * 60_000

function makeLogger(): RetentionSweeperDeps['logger'] {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
}

/** Config with an actionable age policy. */
const AGE_POLICY: RecordingConfig = {
  enabled: true,
  bands: [],
  retention: { maxAgeDays: 7 },
}
/** Config with an actionable size policy. */
const SIZE_POLICY: RecordingConfig = {
  enabled: true,
  bands: [],
  retention: { maxSizeGb: 50 },
}
/** No retention block at all — must be skipped. */
const NO_POLICY: RecordingConfig = { enabled: true, bands: [] }
/** Retention present but both limits zero (inherit default) — must be skipped. */
const ZERO_POLICY: RecordingConfig = {
  enabled: true,
  bands: [],
  retention: { maxAgeDays: 0, maxSizeGb: 0 },
}

const NO_RECLAIM: RetentionPruneResult = { deletedBuckets: 0, reclaimedBytes: 0 }

describe('hasRetentionPolicy', () => {
  it('is true when an age or size limit is positive', () => {
    expect(hasRetentionPolicy(AGE_POLICY)).toBe(true)
    expect(hasRetentionPolicy(SIZE_POLICY)).toBe(true)
  })

  it('is false when retention is absent or both limits are zero', () => {
    expect(hasRetentionPolicy(NO_POLICY)).toBe(false)
    expect(hasRetentionPolicy(ZERO_POLICY)).toBe(false)
  })
})

describe('RetentionSweeper', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('arms the timer: runs immediately, then again on the interval', async () => {
    const prune = vi.fn(async (): Promise<RetentionPruneResult> => NO_RECLAIM)
    const sweeper = new RetentionSweeper({
      prune,
      readConfigs: async () => new Map([[7, AGE_POLICY]]),
      logger: makeLogger(),
      intervalMs: INTERVAL_MS,
    })

    sweeper.start()
    // Immediate run.
    await vi.advanceTimersByTimeAsync(0)
    expect(prune).toHaveBeenCalledTimes(1)
    expect(prune).toHaveBeenCalledWith(7)

    // One interval → a second sweep.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(prune).toHaveBeenCalledTimes(2)

    sweeper.stop()
  })

  it('prunes only devices with a retention policy, skipping the rest', async () => {
    const prune = vi.fn(async (): Promise<RetentionPruneResult> => NO_RECLAIM)
    const sweeper = new RetentionSweeper({
      prune,
      readConfigs: async () =>
        new Map([
          [1, AGE_POLICY],
          [2, NO_POLICY],
          [3, SIZE_POLICY],
          [4, ZERO_POLICY],
        ]),
      logger: makeLogger(),
      intervalMs: INTERVAL_MS,
    })

    sweeper.start()
    await vi.advanceTimersByTimeAsync(0)

    const pruned = prune.mock.calls
      .flatMap((c) => {
        const id = c.at(0)
        return id === undefined ? [] : [id]
      })
      .sort()
    expect(pruned).toEqual([1, 3])
    expect(prune).not.toHaveBeenCalledWith(2)
    expect(prune).not.toHaveBeenCalledWith(4)

    sweeper.stop()
  })

  it('single-flights: a slow sweep is not re-entered by the next tick', async () => {
    // A prune that never resolves keeps the first sweep in flight across ticks.
    let resolvePrune: (v: RetentionPruneResult) => void = () => {}
    const prune = vi.fn(
      (): Promise<RetentionPruneResult> =>
        new Promise<RetentionPruneResult>((resolve) => {
          resolvePrune = resolve
        }),
    )
    const debug = vi.fn()
    const sweeper = new RetentionSweeper({
      prune,
      readConfigs: async () => new Map([[9, AGE_POLICY]]),
      logger: { info: vi.fn(), warn: vi.fn(), debug },
      intervalMs: INTERVAL_MS,
    })

    sweeper.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(prune).toHaveBeenCalledTimes(1)

    // Next tick fires while the first sweep is still awaiting prune → skipped.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(prune).toHaveBeenCalledTimes(1)
    expect(debug).toHaveBeenCalled()

    // Let the in-flight sweep finish; a later tick can then run again.
    resolvePrune(NO_RECLAIM)
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(prune).toHaveBeenCalledTimes(2)

    sweeper.stop()
  })

  it('clears the timer on teardown — no sweeps after stop()', async () => {
    const prune = vi.fn(async (): Promise<RetentionPruneResult> => NO_RECLAIM)
    const sweeper = new RetentionSweeper({
      prune,
      readConfigs: async () => new Map([[1, AGE_POLICY]]),
      logger: makeLogger(),
      intervalMs: INTERVAL_MS,
    })

    sweeper.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(prune).toHaveBeenCalledTimes(1)

    sweeper.stop()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5)
    expect(prune).toHaveBeenCalledTimes(1)
  })

  it('is best-effort: one device prune failure does not abort the others', async () => {
    const prune = vi.fn(async (deviceId: number): Promise<RetentionPruneResult> => {
      if (deviceId === 1) throw new Error('prune boom')
      return NO_RECLAIM
    })
    const warn = vi.fn()
    const sweeper = new RetentionSweeper({
      prune,
      readConfigs: async () =>
        new Map([
          [1, AGE_POLICY],
          [2, SIZE_POLICY],
        ]),
      logger: { info: vi.fn(), warn, debug: vi.fn() },
      intervalMs: INTERVAL_MS,
    })

    sweeper.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(prune).toHaveBeenCalledWith(1)
    expect(prune).toHaveBeenCalledWith(2)
    expect(warn).toHaveBeenCalled()

    sweeper.stop()
  })

  it('a config-read failure aborts the pass without throwing', async () => {
    const prune = vi.fn(async (): Promise<RetentionPruneResult> => NO_RECLAIM)
    const warn = vi.fn()
    const sweeper = new RetentionSweeper({
      prune,
      readConfigs: async () => {
        throw new Error('store unavailable')
      },
      logger: { info: vi.fn(), warn, debug: vi.fn() },
      intervalMs: INTERVAL_MS,
    })

    sweeper.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(prune).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()

    sweeper.stop()
  })
})

/**
 * The sweep that follows a staging recovery prunes six weeks of footage that
 * has only just become visible, and it takes minutes (D160). Reporting only the
 * result made that indistinguishable from a hang.
 */
describe('RetentionSweeper — phase reporting', () => {
  it('names the devices it is about to prune BEFORE pruning any of them', async () => {
    const logger = makeLogger()
    const order: string[] = []
    const sweeper = new RetentionSweeper({
      prune: async (deviceId): Promise<RetentionPruneResult> => {
        order.push(`prune:${deviceId}`)
        return { deletedBuckets: 2, reclaimedBytes: 20 }
      },
      readConfigs: async () =>
        new Map([
          [104, AGE_POLICY],
          [101, NO_POLICY],
        ]),
      logger,
      intervalMs: INTERVAL_MS,
    })

    await sweeper.sweep()

    const infos = vi.mocked(logger.info).mock.calls
    expect(infos[0]![0]).toBe('recorder: retention sweep starting')
    expect(infos[0]![1]).toMatchObject({ meta: { devices: [104], skipped: 1 } })
    expect(order).toEqual(['prune:104'])
  })

  it('reports each device it pruned, tagged, with what it reclaimed', async () => {
    const logger = makeLogger()
    const sweeper = new RetentionSweeper({
      prune: async (): Promise<RetentionPruneResult> => ({
        deletedBuckets: 8_856,
        reclaimedBytes: 179_000_000_000,
      }),
      readConfigs: async () => new Map([[104, AGE_POLICY]]),
      logger,
      intervalMs: INTERVAL_MS,
    })

    await sweeper.sweep()

    const perDevice = vi
      .mocked(logger.info)
      .mock.calls.find((c) => c[0] === 'recorder: retention prune complete for device')
    expect(perDevice).toBeDefined()
    expect(perDevice![1]).toMatchObject({
      tags: { deviceId: 104 },
      meta: { deletedBuckets: 8_856, reclaimedBytes: 179_000_000_000 },
    })
  })
})
