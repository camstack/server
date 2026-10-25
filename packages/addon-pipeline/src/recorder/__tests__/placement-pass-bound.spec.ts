/**
 * What the 30 s placement pass may cost, and what a failed store read may do.
 *
 * MEASURED on the live hub (2026-08-25): the placement pass is a SERIAL chain of
 * addon-store round trips to `hub/sqlite-settings`, and not one of them was
 * bounded. Every one therefore fell through to `DEFAULT_UDS_REQUEST_TIMEOUT_MS`
 * (60 s), so a degraded settings door cost the pass an exact multiple of a
 * minute:
 *
 *   - `trackedDeviceIds` → `enabledDeviceIds()`   → 60 s
 *   - `recompute`        → `readPlacementState`   → 60 s
 *   - `writeAssignments` → `state.get()`          → 60 s   ← re-read of the blob
 *                                                            `recompute` had
 *                                                            JUST read
 *   - `writeAssignments` → `state.set()`          → 60 s
 *
 * 4 × 60 s = 240 s, against a 30 s budget — and the recorder logged exactly
 * `durationMs: 240003` (08-18) and `240102` (08-19), plus `181056` (08-25,
 * three of the four). `startPeriodicPass` SKIPS a fire while a run is in
 * flight, so those four minutes did not merely make one pass late: they
 * CANCELLED the seven placement ticks behind it.
 *
 * So this file pins three things:
 *   1. every store op the pass makes is bounded well under the pass budget;
 *   2. the plan write reuses the blob the plan was read from — the fourth round
 *      trip does not exist;
 *   3. a plan read that FAILS plans NOTHING (D49). It used to fall through to
 *      `current = {}`, which reads every assignment as `unassigned`, throws away
 *      the stickiness that keeps a camera on its disk, and rewrites the whole
 *      plan on the evidence that the store was briefly unreachable.
 */
import { createDurableState, type IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecordingOpsLogSink } from '../addon/ops-log-store.js'
import {
  PLACEMENT_STORE_TIMEOUT_MS,
  PlacementService,
  type PlacementServiceDeps,
} from '../addon/placement-service.js'
import {
  EMPTY_PLACEMENT,
  RECORDING_PLACEMENT_KEY,
  type RecordingPlacementBlob,
  RecordingPlacementBlobSchema,
  type RecordingPlacementState,
} from '../addon/placement-store.js'
import { type RecordingsLocation, recordingsLocationOfMode } from '../addon/roots.js'

const GB = 1_000_000_000

const SSD: RecordingsLocation = recordingsLocationOfMode(
  { id: 'recordings:default', type: 'recordings', root: '/mnt/ssd' },
  'active',
)
const NAS: RecordingsLocation = recordingsLocationOfMode(
  { id: 'recordings:nas', type: 'recordings', root: '/mnt/nas' },
  'active',
)

function makeLogger(): IScopedLogger {
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
    withTags: vi.fn(),
  }
  logger.child.mockReturnValue(logger)
  logger.withTags.mockReturnValue(logger)
  return logger as unknown as IScopedLogger
}

/** A store whose every round trip is observable, and stoppable. */
interface CountingStore {
  readonly state: RecordingPlacementState
  readonly reads: () => number
  readonly writes: () => number
  /** Written blob, or null when nothing has been persisted. */
  readonly persisted: () => RecordingPlacementBlob | null
  /** Make every subsequent read hang for ever (a frozen settings door). */
  freezeReads: () => void
  /** Make every subsequent read reject (the door answered with an error). */
  failReads: () => void
}

function makeCountingStore(seed: Readonly<Record<string, string>> = {}): CountingStore {
  const blob: Record<string, unknown> = {
    [RECORDING_PLACEMENT_KEY]: {
      assignments: { ...seed },
      volumeIds: {},
    },
  }
  let reads = 0
  let writes = 0
  let mode: 'ok' | 'freeze' | 'fail' = 'ok'

  const state = createDurableState<RecordingPlacementBlob>({
    key: RECORDING_PLACEMENT_KEY,
    schema: RecordingPlacementBlobSchema,
    fallback: EMPTY_PLACEMENT,
    read: async () => {
      reads += 1
      if (mode === 'freeze') return new Promise<Record<string, unknown>>(() => {})
      if (mode === 'fail') throw new Error('UDS request timed out after 60000ms')
      return { ...blob }
    },
    write: async (patch) => {
      writes += 1
      Object.assign(blob, patch)
    },
  })

  return {
    state,
    reads: () => reads,
    writes: () => writes,
    persisted: () => {
      const raw = blob[RECORDING_PLACEMENT_KEY]
      const parsed = RecordingPlacementBlobSchema.safeParse(raw)
      return parsed.success ? parsed.data : null
    },
    freezeReads: () => {
      mode = 'freeze'
    },
    failReads: () => {
      mode = 'fail'
    },
  }
}

const NO_OPS: RecordingOpsLogSink = { append: async () => undefined, list: async () => [] }

function makeService(
  store: CountingStore,
  locations: readonly RecordingsLocation[],
  overrides: Partial<PlacementServiceDeps> = {},
): { service: PlacementService; logger: IScopedLogger } {
  const logger = makeLogger()
  const markers = new Map<string, { locationId: string; volumeId: string }>()
  return {
    logger,
    service: new PlacementService({
      logger,
      locations: () => locations,
      state: store.state,
      opsLog: NO_OPS,
      probe: {
        readMarker: async (root) => markers.get(root) ?? null,
        writeMarker: async (root, marker) => {
          markers.set(root, marker)
        },
        newVolumeId: () => `vol-${markers.size + 1}`,
      },
      capacityFor: async () => ({ availableBytes: 1000 * GB, totalBytes: 1000 * GB }),
      usedOnLocation: async () => 0,
      dailyBytesFor: () => 10 * GB,
      ...overrides,
    }),
  }
}

const WORK = [
  { deviceId: 101, profile: 'high' },
  { deviceId: 102, profile: 'high' },
] as const

describe('the placement pass costs a BOUND, not the UDS default', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('settles at its own bound when the settings door never answers', async () => {
    const store = makeCountingStore()
    store.freezeReads()
    const { service } = makeService(store, [SSD])

    const settled = vi.fn()
    void service.recompute([...WORK]).then(settled, settled)

    // One millisecond short of the bound: still waiting.
    await vi.advanceTimersByTimeAsync(PLACEMENT_STORE_TIMEOUT_MS - 1)
    expect(settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2)
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it('the bound leaves the whole pass inside its 30 s budget', () => {
    // Three store round trips (enumerate is bounded separately in the
    // controller) must not add up to the budget the pass is judged against.
    expect(PLACEMENT_STORE_TIMEOUT_MS * 3).toBeLessThan(30_000)
  })
})

describe('a plan read that fails changes NOTHING (D49)', () => {
  it('plans no move and persists nothing', async () => {
    const store = makeCountingStore({ '101:high': 'recordings:default' })
    const { service, logger } = makeService(store, [SSD, NAS])
    store.failReads()

    const plan = await service.recompute([...WORK])

    expect(plan.changes).toEqual([])
    expect(store.writes()).toBe(0)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('leaves the stored plan exactly as it was', async () => {
    const store = makeCountingStore({ '101:high': 'recordings:nas' })
    const { service } = makeService(store, [SSD, NAS])
    store.failReads()

    await service.recompute([...WORK])

    expect(store.persisted()?.assignments).toEqual({ '101:high': 'recordings:nas' })
  })
})

describe('the plan write reuses the blob the plan was read from', () => {
  it('costs ONE read and ONE write when the plan changes', async () => {
    const store = makeCountingStore()
    const { service } = makeService(store, [SSD])

    const plan = await service.recompute([...WORK])

    expect(plan.changes.length).toBeGreaterThan(0)
    expect(store.reads()).toBe(1)
    expect(store.writes()).toBe(1)
  })

  it('costs ONE read and NO write when nothing moved', async () => {
    const store = makeCountingStore({
      '101:high': 'recordings:default',
      '102:high': 'recordings:default',
    })
    const { service } = makeService(store, [SSD])

    const plan = await service.recompute([...WORK])

    expect(plan.changes).toEqual([])
    expect(store.reads()).toBe(1)
    expect(store.writes()).toBe(0)
  })

  // DELETED (D383): "a pass that moved nothing still writes ONCE when the
  // authority is not stamped yet" tested that a steady-state pass paid for
  // stamping `defaultLocations` on an old blob even with zero plan changes.
  // `defaultLocations` is dead — nothing reads or writes it any more — and the
  // write is now governed ONLY by `plan.changes.length`, which the two cases
  // above already cover. There is no third case left to distinguish.

  it('keeps the remembered volume ids across a plan write', async () => {
    const store = makeCountingStore()
    const { service } = makeService(store, [SSD])
    await service.place(101, 'high')
    const claimed = store.persisted()?.volumeIds ?? {}
    expect(Object.keys(claimed).length).toBeGreaterThan(0)

    await service.recompute([...WORK])

    expect(store.persisted()?.volumeIds).toEqual(claimed)
  })
})
