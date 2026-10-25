/**
 * The 2026-09-07 hub, through the real `PlacementService` (D387).
 *
 * The operator added a second `recordings` location — a fresh, empty 4 TB disk
 * — next to a 1.9 TB one that was 89% full and held all 19 recordings
 * assignments. The census announced the new disk with `assignments: 0` and
 * "this location is ENABLED but holds no assignment", and then the fleet sat
 * there for 20 minutes: no move, no second census, `recording.getPlacement`
 * still reporting 19 of 19 on the full disk.
 *
 * The cause is in the planner and it is reproduced here through the SERVICE,
 * with the capacities the live disks actually reported to `statfs`, because
 * the numbers are half the bug: `dailyBytes` is a MEASURED rate and it is 0
 * for every camera the RAM index has not accounted for (D287). One measured
 * camera made every unmeasured one weightless, Phase C reached for a
 * zero-byte demand, moving 0 bytes improved nothing, and the strict-
 * improvement check broke the loop on its first iteration — every tick,
 * forever, in silence.
 */
import { type CamProfile, createDurableState, type IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { RecordingOpsLogSink } from '../addon/ops-log-store.js'
import { PlacementService } from '../addon/placement-service.js'
import {
  EMPTY_PLACEMENT,
  RECORDING_PLACEMENT_KEY,
  type RecordingPlacementBlob,
  RecordingPlacementBlobSchema,
  type RecordingPlacementState,
} from '../addon/placement-store.js'
import { type RecordingsLocation, recordingsLocationOfMode } from '../addon/roots.js'

/** `recordings:default` — 1.9 TB, 89% full. ~24 GB of headroom past its floor. */
const NEARLY_FULL: RecordingsLocation = recordingsLocationOfMode(
  { id: 'recordings:default', type: 'recordings', root: '/recordings' },
  'active',
)
/** `recordings:recordings-high-4tb` — the fresh disk, `statfs` verbatim. */
const FRESH_4TB: RecordingsLocation = recordingsLocationOfMode(
  { id: 'recordings:recordings-high-4tb', type: 'recordings', root: '/recordings-2' },
  'active',
)

const NEARLY_FULL_TOTAL = 2_000_000_000_000
const NEARLY_FULL_FREE = 210_000_000_000
/** `blocks=976277703 bavail=957576201 bsize=4096`, measured in the container. */
const FRESH_TOTAL = 976_277_703 * 4096
const FRESH_FREE = 957_576_201 * 4096

const DEVICE_IDS = [
  601, 602, 603, 604, 605, 606, 607, 608, 609, 610, 611, 612, 613, 614, 101, 616, 102, 618, 619,
] as const

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
  // Documented type boundary: the service calls only these six.
  return logger as unknown as IScopedLogger
}

function makeState(seed: Readonly<Record<string, string>>): RecordingPlacementState {
  const blob: Record<string, unknown> = {
    [RECORDING_PLACEMENT_KEY]: { ...EMPTY_PLACEMENT, assignments: { ...seed } },
  }
  return createDurableState<RecordingPlacementBlob>({
    key: RECORDING_PLACEMENT_KEY,
    schema: RecordingPlacementBlobSchema,
    fallback: EMPTY_PLACEMENT,
    read: async () => ({ ...blob }),
    write: async (patch) => {
      Object.assign(blob, patch)
    },
  })
}

const NO_OPS: RecordingOpsLogSink = { append: async () => undefined, list: async () => [] }

/**
 * The live cluster: both disks enabled, every recordings assignment on the
 * full one, and exactly ONE camera with a measured daily rate.
 */
function makeService(measured: ReadonlySet<number>): {
  readonly service: PlacementService
  readonly state: RecordingPlacementState
} {
  const seed: Record<string, string> = {}
  for (const id of DEVICE_IDS) seed[`${String(id)}:high`] = NEARLY_FULL.id
  const state = makeState(seed)
  const service = new PlacementService({
    logger: makeLogger(),
    locations: () => [NEARLY_FULL, FRESH_4TB],
    state,
    opsLog: NO_OPS,
    capacityFor: async (location) =>
      location.id === NEARLY_FULL.id
        ? { availableBytes: NEARLY_FULL_FREE, totalBytes: NEARLY_FULL_TOTAL }
        : { availableBytes: FRESH_FREE, totalBytes: FRESH_TOTAL },
    usedOnLocation: async () => 0,
    dailyBytesFor: (deviceId) => (measured.has(deviceId) ? 30_000_000_000 : 0),
  })
  return { service, state }
}

const WORK: ReadonlyArray<{ deviceId: number; profile: CamProfile }> = DEVICE_IDS.map((id) => ({
  deviceId: id,
  profile: 'high',
}))

describe('a second, empty recordings disk actually takes work (D387)', () => {
  it('moves assignments onto the fresh disk when one camera has a measured rate', async () => {
    const { service } = makeService(new Set([601]))

    const plan = await service.recompute(WORK)

    const onFresh = [...plan.assignments.values()].filter((id) => id === FRESH_4TB.id)
    expect(plan.changes.length).toBeGreaterThan(0)
    expect(onFresh.length).toBeGreaterThan(0)
  })

  it('moves assignments when NOTHING has been measured at all', async () => {
    const { service } = makeService(new Set())

    const plan = await service.recompute(WORK)

    expect(
      [...plan.assignments.values()].filter((id) => id === FRESH_4TB.id).length,
    ).toBeGreaterThan(0)
  })

  it('PERSISTS the moves — the next pass plans from what this one wrote', async () => {
    const { service } = makeService(new Set([601]))
    const first = await service.recompute(WORK)
    const second = await service.recompute(WORK)

    // Stickiness: the second pass converges rather than churning the fleet a
    // second time. What matters is that the fresh disk KEEPS what it took.
    const freshAfter = [...second.assignments.values()].filter((id) => id === FRESH_4TB.id)
    expect(freshAfter.length).toBeGreaterThan(0)
    expect(second.changes.length).toBeLessThan(first.changes.length)
  })

  it('leaves the near-full disk under the hysteresis band once it has settled', async () => {
    const { service } = makeService(new Set([601]))
    await service.recompute(WORK)
    await service.recompute(WORK)
    const third = await service.recompute(WORK)

    expect(third.changes).toEqual([])
  })
})
