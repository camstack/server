/**
 * Supersedes `placement-repoint.spec.ts` (D383 — enabled locations ARE the
 * write set, all of them together; see
 * `docs/design/2026-08-30-enabled-locations-are-the-write-set.md`).
 *
 * The class "default"/"authority" location this file used to test is GONE:
 * `RecordingsLocation.isDefault`, `authorityLocations()`, the `defaultLocations`
 * stamp, `PlacementRepoint`/`PlacementDivergence` and the whole "a repoint
 * invalidates every assignment of its class" mechanic do not exist any more —
 * there is no second write authority left to repoint or diverge from. What
 * survives, and what this file covers instead:
 *
 *   (a) a stored assignment whose location LEAVES THE POOL — the operator
 *       disables it, or drains it read-only — is invalidated and re-resolved
 *       at the next attach, exactly like before, just without a "class
 *       authority" framing;
 *   (b) the CENSUS (`reportCensus`) that replaced the divergence report: one
 *       line per (class, location) always with its denominator, heartbeat
 *       included;
 *   (c) an ENABLED location holding zero assignments is warned about — an
 *       enabled disk nothing lands on is the failure this model exists to
 *       surface.
 *
 * `writePlacementPass`'s work-scoped MERGE (D299) is untouched by D383 — it
 * never depended on a class authority — so its coverage moves here verbatim
 * rather than being deleted for no reason.
 *
 * ## The fixture shape that matters
 *
 * Every case below distinguishes **"the camera moved"** from **"the camera was
 * never assigned"**: the store is seeded with a real assignment per camera, and
 * the assertions are on where each *named* camera lands — never on a count that
 * an empty store would also satisfy.
 */
import { createDurableState, type IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { RecordingOpsLogAppendInput, RecordingOpsLogSink } from '../addon/ops-log-store.js'
import { PLACEMENT_CENSUS_REPORT_MS, PlacementService } from '../addon/placement-service.js'
import {
  EMPTY_PLACEMENT,
  RECORDING_PLACEMENT_KEY,
  type RecordingPlacementBlob,
  RecordingPlacementBlobSchema,
  type RecordingPlacementState,
} from '../addon/placement-store.js'
import { type RecordingsLocation, recordingsLocationOfMode } from '../addon/roots.js'

const GB = 1_000_000_000

const HDD: RecordingsLocation = recordingsLocationOfMode(
  { id: 'recordingsLow:default', type: 'recordingsLow', root: '/mnt/hdd' },
  'active',
)
const SSD: RecordingsLocation = recordingsLocationOfMode(
  { id: 'recordingsLow:ssd', type: 'recordingsLow', root: '/mnt/ssd' },
  'active',
)
const HIGH: RecordingsLocation = recordingsLocationOfMode(
  { id: 'recordings:default', type: 'recordings', root: '/mnt/hdd-high' },
  'active',
)

interface LogLine {
  readonly level: 'warn' | 'info' | 'error'
  readonly message: string
  readonly deviceId: number | null
  readonly meta: Readonly<Record<string, unknown>>
}

interface Harness {
  readonly service: PlacementService
  readonly lines: LogLine[]
  readonly rows: RecordingOpsLogAppendInput[]
  readonly stored: () => RecordingPlacementBlob | null
  /** Mutable so a test can disable/drain a location between attaches — the
   *  operator action (a) exists to cover. */
  locations: readonly RecordingsLocation[]
}

interface LogPayload {
  readonly tags?: { readonly deviceId?: number }
  readonly meta?: Readonly<Record<string, unknown>>
}

function makeHarness(
  initialLocations: readonly RecordingsLocation[],
  seed: Readonly<Record<string, string>>,
  clock: { now: number } = { now: 1_000 },
  writesFail = false,
): Harness {
  const lines: LogLine[] = []
  const record =
    (level: 'warn' | 'info' | 'error') =>
    (message: string, payload?: LogPayload): void => {
      lines.push({
        level,
        message,
        deviceId: payload?.tags?.deviceId ?? null,
        meta: payload?.meta ?? {},
      })
    }
  const logger = {
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }

  const blob: Record<string, unknown> = {
    [RECORDING_PLACEMENT_KEY]: {
      assignments: { ...seed },
      volumeIds: {},
    },
  }
  const state: RecordingPlacementState = createDurableState<RecordingPlacementBlob>({
    key: RECORDING_PLACEMENT_KEY,
    schema: RecordingPlacementBlobSchema,
    fallback: EMPTY_PLACEMENT,
    read: async () => ({ ...blob }),
    write: async (patch) => {
      if (writesFail) throw new Error('UDS request timed out after 60000ms')
      Object.assign(blob, patch)
    },
  })

  const rows: RecordingOpsLogAppendInput[] = []
  const opsLog: RecordingOpsLogSink = {
    append: async (input) => {
      rows.push(input)
    },
    list: async () => [],
  }

  const markers = new Map<string, { locationId: string; volumeId: string }>()
  const harness: Harness = {
    locations: initialLocations,
    lines,
    rows,
    service: undefined as unknown as PlacementService,
    stored: () => {
      const parsed = RecordingPlacementBlobSchema.safeParse(blob[RECORDING_PLACEMENT_KEY])
      return parsed.success ? parsed.data : null
    },
  }
  // `service` reads `harness.locations` through this closure on every call, so
  // reassigning the field is how a test simulates the operator flipping a flag.
  Object.assign(harness, {
    service: new PlacementService({
      logger: logger as unknown as IScopedLogger,
      locations: () => harness.locations,
      state,
      opsLog,
      probe: {
        readMarker: async (root) => markers.get(root) ?? null,
        writeMarker: async (root, marker) => {
          markers.set(root, marker)
        },
        newVolumeId: () => `vol-${markers.size.toString()}`,
      },
      capacityFor: async () => ({ availableBytes: 1000 * GB, totalBytes: 1000 * GB }),
      usedOnLocation: async () => 0,
      dailyBytesFor: () => 10 * GB,
      now: () => clock.now,
    }),
  })
  return harness
}

/** Four cameras with a real `low` assignment each — every one of them a named
 *  camera the assertions below check by id, never by count. */
function seededFleet(): Readonly<Record<string, string>> {
  const seed: Record<string, string> = {}
  for (const deviceId of [1439, 3839, 101, 102]) {
    seed[`${deviceId.toString()}:low`] = HDD.id
  }
  return seed
}

describe('a stored assignment is invalidated when its location leaves the pool (D383)', () => {
  it('re-resolves at the next attach once the operator disables the location', async () => {
    const h = makeHarness([HIGH, SSD, HDD], seededFleet())

    // 3839 is ASSIGNED to HDD. This is the case the fixture exists to
    // distinguish from "3839 was never assigned".
    expect(h.stored()?.assignments['3839:low']).toBe(HDD.id)
    const before = await h.service.place(3839, 'low')
    expect(before.id).toBe(HDD.id)

    h.locations = [HIGH, SSD, recordingsLocationOfMode(HDD, 'readonly')]
    h.service.onLocationsChanged()
    const after = await h.service.place(3839, 'low')

    // HDD dropped out of the pool, so the only writable `recordingsLow`
    // location left is SSD.
    expect(after.id).toBe(SSD.id)
    const line = h.lines.find((l) => l.message.includes('stored assignment INVALIDATED'))
    expect(line).toBeDefined()
    expect(line?.deviceId).toBe(3839)
    expect(line?.meta['profile']).toBe('low')
    expect(line?.meta['assignedLocationId']).toBe(HDD.id)
    expect(line?.meta['poolLocationIds']).toEqual([HIGH.id, SSD.id])
  })

  it('re-resolves at the next attach once the operator drains the location read-only', async () => {
    const h = makeHarness([HIGH, SSD, HDD], seededFleet())

    h.locations = [HIGH, SSD, recordingsLocationOfMode(HDD, 'readonly')]
    h.service.onLocationsChanged()
    const after = await h.service.place(1439, 'low')

    expect(after.id).toBe(SSD.id)
    const line = h.lines.find((l) => l.message.includes('stored assignment INVALIDATED'))
    expect(line?.deviceId).toBe(1439)
    expect(line?.meta['assignedLocationId']).toBe(HDD.id)
  })

  it('honours the stored assignment verbatim while the location is still in the pool', async () => {
    const h = makeHarness([HIGH, SSD, HDD], seededFleet())

    const placed = await h.service.place(102, 'low')

    expect(placed.id).toBe(HDD.id)
    expect(h.lines.some((l) => l.message.includes('INVALIDATED'))).toBe(false)
  })
})

describe('a work-scoped pass MERGES into the fleet-wide record (D299)', () => {
  // One `recordingsLow` location, so the planner has no balancing choice to
  // make and every assertion below is about the MERGE, never about placement.
  const ONE_CLASS = [HIGH, SSD] as const

  it('keeps the assignment of a camera the pass did not plan', async () => {
    // The write used to REPLACE the record with `plan.assignments`. Since D287
    // a camera with no resident rows contributes no demand, so it is not in
    // `work` — and was deleted from the durable blob on the next tick that
    // changed anything. `trackedDeviceIds` also narrows to the ACTIVE cameras
    // when the settings door times out, which would have dropped every idle one.
    const h = makeHarness([...ONE_CLASS], {
      '101:low': SSD.id,
      '1439:low': SSD.id,
      '3839:high': HIGH.id,
    })

    // A pass that plans ONE camera, and moves it (so the write happens at all).
    await h.service.recompute([{ deviceId: 102, profile: 'low' }])

    expect(h.stored()?.assignments['1439:low']).toBe(SSD.id)
    expect(h.stored()?.assignments['3839:high']).toBe(HIGH.id)
    expect(h.stored()?.assignments['101:low']).toBe(SSD.id)
  })

  it('still applies what it DID plan', async () => {
    const h = makeHarness([...ONE_CLASS], { '101:low': SSD.id, '1439:low': SSD.id })

    await h.service.recompute([{ deviceId: 102, profile: 'low' }])

    expect(h.stored()?.assignments['102:low']).toBe(SSD.id)
  })
})

describe('the census reports which locations the fleet writes to, with its denominator', () => {
  it('lines up assignments per location against how many share its class', async () => {
    const NAS: RecordingsLocation = recordingsLocationOfMode(
      { id: 'recordingsLow:nas', type: 'recordingsLow', root: '/mnt/nas' },
      'active',
    )
    const h = makeHarness([HIGH, SSD, HDD, NAS], {
      '101:high': HIGH.id,
      '3839:low': SSD.id,
      '1439:low': HDD.id,
    })

    // A no-op pass on an already-settled plan: nothing moves, so the census
    // reports exactly the seeded distribution.
    await h.service.recompute([{ deviceId: 101, profile: 'high' }])

    const line = h.lines.find((l) => l.message.includes('census — which locations'))
    expect(line).toBeDefined()
    expect(line?.meta['locations']).toEqual([
      { locationId: HIGH.id, type: 'recordings', assignments: 1, ofClass: 1 },
      { locationId: HDD.id, type: 'recordingsLow', assignments: 1, ofClass: 2 },
      { locationId: NAS.id, type: 'recordingsLow', assignments: 0, ofClass: 2 },
      { locationId: SSD.id, type: 'recordingsLow', assignments: 1, ofClass: 2 },
    ])
  })

  it('warns about an enabled location that holds no assignment at all', async () => {
    const NAS: RecordingsLocation = recordingsLocationOfMode(
      { id: 'recordingsLow:nas', type: 'recordingsLow', root: '/mnt/nas' },
      'active',
    )
    // `101:high` keeps HIGH from being ITS class's own zero-assignment case —
    // this test is about NAS specifically, not "every location with no work".
    const h = makeHarness([HIGH, SSD, HDD, NAS], { ...seededFleet(), '101:high': HIGH.id })

    await h.service.recompute([{ deviceId: 101, profile: 'high' }])

    const warning = h.lines.find(
      (l) =>
        l.message.includes('ENABLED but holds no assignment') && l.meta['locationId'] === NAS.id,
    )
    expect(warning).toBeDefined()
    expect(warning?.meta['type']).toBe('recordingsLow')
  })

  it('does not repeat an unchanged census on the next 30 s tick', async () => {
    const clock = { now: 1_000 }
    const h = makeHarness([HIGH, SSD, HDD], seededFleet(), clock)

    await h.service.recompute([{ deviceId: 101, profile: 'low' }])
    const first = h.lines.filter((l) => l.message.includes('census —')).length
    clock.now += 30_000
    await h.service.recompute([{ deviceId: 101, profile: 'low' }])

    expect(h.lines.filter((l) => l.message.includes('census —')).length).toBe(first)
  })

  it('re-announces the census once the heartbeat interval has passed, unchanged or not', async () => {
    const clock = { now: 1_000 }
    const h = makeHarness([HIGH, SSD, HDD], seededFleet(), clock)

    await h.service.recompute([{ deviceId: 101, profile: 'low' }])
    const first = h.lines.filter((l) => l.message.includes('census —')).length
    clock.now += PLACEMENT_CENSUS_REPORT_MS
    await h.service.recompute([{ deviceId: 101, profile: 'low' }])

    expect(h.lines.filter((l) => l.message.includes('census —')).length).toBeGreaterThan(first)
  })
})

/** Guards the guard: a fixture whose seed is empty would satisfy several of the
 *  assertions above for the wrong reason. */
describe('the fixture distinguishes "assigned" from "never assigned"', () => {
  it('seeds a real assignment for every camera it asserts on', () => {
    const seed = seededFleet()
    expect(Object.keys(seed).toSorted()).toEqual(['101:low', '102:low', '1439:low', '3839:low'])
    for (const locationId of Object.values(seed)) expect(locationId).toBe(HDD.id)
  })
})
