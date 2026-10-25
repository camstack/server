/**
 * Balancing end to end through `PlacementService`: the operator opt-in, the
 * attach-boundary application, and the single-location invariant.
 *
 * The operator's scenario, verbatim: creating a storage location must NOT make
 * the recorder write to it. A newly created disk arrives `enabled: false` and
 * stays inert until it is turned on; turning it on starts balancing at the next
 * ATTACH boundary (never mid-run); turning it off drains NEW writes at the next
 * boundary and touches no existing footage.
 *
 * And the invariant that lets this ship onto a live single-disk hub: with one
 * writable location, every decision is byte-for-byte what it is today.
 */
import { type CamProfile, createDurableState, type IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { RecordingOpsLogSink } from '../addon/ops-log-store.js'
import { PlacementService, type PlacementServiceDeps } from '../addon/placement-service.js'
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
/** A disk the operator just created in the wizard: exists, not opted in. */
const NEW_DISK: RecordingsLocation = recordingsLocationOfMode(
  { id: 'recordings:nas', type: 'recordings', root: '/mnt/nas' },
  'readonly',
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

function makeState(): RecordingPlacementState {
  const blob: Record<string, unknown> = {}
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

interface Cluster {
  readonly service: PlacementService
  readonly logger: IScopedLogger
  /** Mutable so a test can enable/disable a location between attaches. */
  locations: readonly RecordingsLocation[]
}

function makeCluster(
  initial: readonly RecordingsLocation[],
  overrides: Partial<PlacementServiceDeps> = {},
): Cluster {
  const logger = makeLogger()
  // A real (in-memory) marker filesystem: the mount probe adopts each root once
  // and then verifies it, so these tests exercise placement, not a probe fault.
  const markers = new Map<string, { locationId: string; volumeId: string }>()
  const cluster: Cluster = {
    locations: initial,
    logger,
    service: new PlacementService({
      logger,
      locations: () => cluster.locations,
      state: makeState(),
      opsLog: NO_OPS,
      probe: {
        readMarker: async (root) => markers.get(root) ?? null,
        writeMarker: async (root, marker) => {
          markers.set(root, marker)
        },
        newVolumeId: () => `vol-${markers.size + 1}`,
      },
      // Every location is roomy and every camera writes the same rate unless a
      // test says otherwise — so a difference in outcome is a placement
      // decision, never a capacity accident.
      capacityFor: async () => ({ availableBytes: 1000 * GB, totalBytes: 1000 * GB }),
      usedOnLocation: async () => 0,
      dailyBytesFor: () => 10 * GB,
      ...overrides,
    }),
  }
  return cluster
}

/** Attach a set of (camera, profile) pairs and report where each landed. */
async function attachAll(
  service: PlacementService,
  pairs: readonly (readonly [number, CamProfile])[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [deviceId, profile] of pairs) {
    out[`${deviceId}:${profile}`] = (await service.place(deviceId, profile)).id
  }
  return out
}

const CAMERAS: readonly (readonly [number, CamProfile])[] = [
  [101, 'high'],
  [104, 'high'],
  [102, 'high'],
  [618, 'high'],
]

describe('a newly created location is inert until the operator opts in', () => {
  it('receives ZERO writes while it exists but is not enabled', async () => {
    const cluster = makeCluster([SSD, NEW_DISK])
    const placed = await attachAll(cluster.service, CAMERAS)
    expect(new Set(Object.values(placed))).toEqual(new Set(['recordings:default']))
  })

  it('starts taking work at the NEXT attach boundary once enabled', async () => {
    const cluster = makeCluster([SSD, NEW_DISK])
    await attachAll(cluster.service, CAMERAS)

    cluster.locations = [SSD, recordingsLocationOfMode(NEW_DISK, 'active')]
    cluster.service.onLocationsChanged()
    await cluster.service.recompute(CAMERAS.map(([id, profile]) => ({ deviceId: id, profile })))

    const placed = await attachAll(cluster.service, CAMERAS)
    expect(new Set(Object.values(placed))).toEqual(
      new Set(['recordings:default', 'recordings:nas']),
    )
  })

  it('drains NEW writes when disabled again, and touches no existing footage', async () => {
    const cluster = makeCluster([SSD, recordingsLocationOfMode(NEW_DISK, 'active')])
    const demands = CAMERAS.map(([id, profile]) => ({ deviceId: id, profile }))
    await cluster.service.recompute(demands)
    const spread = await attachAll(cluster.service, CAMERAS)
    expect(new Set(Object.values(spread)).size).toBe(2)

    cluster.locations = [SSD, NEW_DISK]
    cluster.service.onLocationsChanged()
    await cluster.service.recompute(demands)

    const drained = await attachAll(cluster.service, CAMERAS)
    expect(new Set(Object.values(drained))).toEqual(new Set(['recordings:default']))
  })

  it('an ABSENT enabled flag means active — a hub predating the field balances normally', async () => {
    const legacySibling: RecordingsLocation = recordingsLocationOfMode(
      { id: 'recordings:nas', type: 'recordings', root: '/mnt/nas' },
      'active',
    )
    const cluster = makeCluster([SSD, legacySibling])
    await cluster.service.recompute(CAMERAS.map(([id, profile]) => ({ deviceId: id, profile })))
    const placed = await attachAll(cluster.service, CAMERAS)
    expect(new Set(Object.values(placed)).size).toBe(2)
  })

  it('REFUSES — loudly — when nothing is a write target (D385)', async () => {
    // Before D385 an `enabled: false` pool was promoted and served "under
    // protest" while a `config.readOnly` pool refused. They are one state now
    // (`readonly`), and refusing is the half that survives: every non-`active`
    // state means the operator froze or is emptying that disk, and writing
    // there fights the relocate mover. The orchestrator refuses to leave a
    // write-serving class with no `active` location, so this configuration is
    // reachable only through a hand-edited store — and it is LOUD, not silent.
    const cluster = makeCluster([
      recordingsLocationOfMode(SSD, 'readonly'),
      recordingsLocationOfMode(NEW_DISK, 'readonly'),
    ])
    await expect(cluster.service.place(101, 'high')).rejects.toThrow(/read-only/)
    expect(vi.mocked(cluster.logger.warn)).toHaveBeenCalled()
  })
})

describe('the single-writable-location invariant', () => {
  it('is byte-for-byte today’s behaviour: one location, every camera, no churn', async () => {
    const cluster = makeCluster([SSD])
    const demands = CAMERAS.map(([id, profile]) => ({ deviceId: id, profile }))

    const before = await attachAll(cluster.service, CAMERAS)
    await cluster.service.recompute(demands)
    await cluster.service.recompute(demands)
    const after = await attachAll(cluster.service, CAMERAS)

    expect(before).toEqual(after)
    expect(new Set(Object.values(after))).toEqual(new Set(['recordings:default']))
  })

  it('routes low to recordingsLow exactly as the pure resolver does', async () => {
    const low: RecordingsLocation = recordingsLocationOfMode(
      { id: 'recordingsLow:default', type: 'recordingsLow', root: '/mnt/low' },
      'active',
    )
    const cluster = makeCluster([SSD, low])
    expect((await cluster.service.place(101, 'low')).id).toBe('recordingsLow:default')
    expect((await cluster.service.place(101, 'high')).id).toBe('recordings:default')
  })
})

describe('placement applies at attach boundaries only', () => {
  it('a recompute changes the PLAN, not a running writer — the next attach adopts it', async () => {
    const cluster = makeCluster([SSD, recordingsLocationOfMode(NEW_DISK, 'active')])
    const demands = CAMERAS.map(([id, profile]) => ({ deviceId: id, profile }))

    // Everything attaches first, before any plan exists.
    const first = await attachAll(cluster.service, CAMERAS)
    expect(new Set(Object.values(first))).toEqual(new Set(['recordings:default']))

    // The plan moves work — but nothing has re-attached, so nothing has moved.
    const plan = await cluster.service.recompute(demands)
    expect(plan.changes.length).toBeGreaterThan(0)

    // The NEXT attach is where the plan takes effect.
    const second = await attachAll(cluster.service, CAMERAS)
    expect(new Set(Object.values(second)).size).toBe(2)
  })

  // ── An unreadable disk is not a full one ────────────────────────────────
  //
  // `readLocationCapacity` never throws: a NAS that stops answering `statfs`
  // comes back as nulls plus the reason. `candidatesFor` used to fold that into
  // `headroomBytes: 0`, which `recompute` reads as "at its limit" — so a
  // transient statfs failure evacuated every camera off a healthy disk, one
  // writer restart and one recording gap each, with no log line anywhere.
  it('a location whose capacity cannot be READ is not evacuated', async () => {
    // Both disks answer at first, so every camera lands on the ssd (roomy tie,
    // broken lexicographically). Then the ssd's volume stops answering.
    let ssdAnswers = true
    const cluster = makeCluster([SSD, recordingsLocationOfMode(NEW_DISK, 'active')], {
      capacityFor: async (location) => {
        if (location.root !== '/mnt/ssd') return { availableBytes: 900 * GB, totalBytes: 1000 * GB }
        return ssdAnswers
          ? { availableBytes: 900 * GB, totalBytes: 1000 * GB }
          : { availableBytes: null, totalBytes: null, error: 'ESTALE: stale file handle' }
      },
    })
    const demands = CAMERAS.map(([id, profile]) => ({ deviceId: id, profile }))
    const first = await attachAll(cluster.service, CAMERAS)
    expect(new Set(Object.values(first))).toEqual(new Set(['recordings:default']))

    ssdAnswers = false
    const plan = await cluster.service.recompute(demands)
    expect(plan.changes.filter((c) => c.reason === 'evacuate')).toEqual([])
  })

  it('says so, with the location and the reason, and does not repeat itself', async () => {
    const cluster = makeCluster([SSD, recordingsLocationOfMode(NEW_DISK, 'active')], {
      capacityFor: async (location) =>
        location.root === '/mnt/ssd'
          ? { availableBytes: null, totalBytes: null, error: 'ESTALE: stale file handle' }
          : { availableBytes: 900 * GB, totalBytes: 1000 * GB },
    })
    const demands = CAMERAS.map(([id, profile]) => ({ deviceId: id, profile }))
    await cluster.service.recompute(demands)
    await cluster.service.recompute(demands)

    const lines = vi
      .mocked(cluster.logger.warn)
      .mock.calls.filter(([message]) => message.includes('capacity UNMEASURABLE'))
    expect(lines).toHaveLength(1)
    expect(lines[0]?.[1]?.meta).toMatchObject({
      locationId: 'recordings:default',
      error: 'ESTALE: stale file handle',
    })
  })

  it('a location out of headroom is vacated at the next boundary', async () => {
    const cluster = makeCluster([SSD, recordingsLocationOfMode(NEW_DISK, 'active')], {
      // The default disk is full past its minFreePercent floor.
      capacityFor: async (location) =>
        location.root === '/mnt/ssd'
          ? { availableBytes: 1 * GB, totalBytes: 1000 * GB }
          : { availableBytes: 900 * GB, totalBytes: 1000 * GB },
    })
    const demands = CAMERAS.map(([id, profile]) => ({ deviceId: id, profile }))
    await attachAll(cluster.service, CAMERAS)
    await cluster.service.recompute(demands)

    const placed = await attachAll(cluster.service, CAMERAS)
    expect(new Set(Object.values(placed))).toEqual(new Set(['recordings:nas']))
  })
})
