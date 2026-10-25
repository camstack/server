/**
 * The ghost-location reconcile — durable hour rows stamped with a `locationId`
 * the storage record no longer has.
 *
 * ## The fixture shape that matters
 *
 * The fake ledger is a real `Map` of hour rows keyed exactly as
 * `SegmentHourLedger` keys them, so **a forget and a repoint leave visibly
 * different state**: a forget removes the source key and adds nothing, a
 * repoint removes the source key and adds a key at the TARGET location. An
 * end-state check that could not tell those apart is how a "we never delete
 * footage that exists" disarm passes while the code deletes it.
 *
 * Since D523 the durable row names no file — it carries only the aggregate, and
 * the directory is the authority for WHICH segments exist. The fake therefore
 * keeps its own `pathsOf` mirror of what each key's directory holds, purely so
 * the tests can still say "every path is still indexed somewhere" about state
 * the production row no longer stores.
 *
 * Every test that asserts a forget also asserts the LISTING count, because the
 * safety property is not "it decided absent" — it is "it listed the hour
 * directory on every candidate root, and every one of them answered empty,
 * before it decided absent".
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi } from 'vitest'
import {
  GhostLocationSweeper,
  ghostProbeRoots,
  GHOST_PROBE_BATCH,
  type GhostLedger,
  type GhostLocationSweepDeps,
} from '../ghost-location-sweep.js'
import { type RecordingsLocation, recordingsLocationOfMode } from '../roots.js'
import { segmentHourKey, segmentHourRow, type SegmentHourRow } from '../segment-hour-ledger.js'
import { segmentRelPath } from '../../segment-path.js'
import type { SegmentRow } from '../../types.js'

const HOUR_MS = 3_600_000
/** 2026-08-15T04:00:00Z — inside the live ghost range. */
const GHOST_HOUR = Date.UTC(2026, 7, 15, 4, 0, 0)
/** Far enough past the ghost hour that nothing is in the live tail. */
const NOW = Date.UTC(2026, 7, 28, 12, 0, 0)
const GHOST_ID = 'recordings:high'

const RECORDINGS: RecordingsLocation = recordingsLocationOfMode(
  { id: 'recordings:default', type: 'recordings', root: '/recordings' },
  'active',
)
const RECORDINGS_LOW: RecordingsLocation = recordingsLocationOfMode(
  { id: 'recordingsLow:default', type: 'recordingsLow', root: '/recordings' },
  'active',
)
const LOW_SSD: RecordingsLocation = recordingsLocationOfMode(
  { id: 'recordingsLow:ssd', type: 'recordingsLow', root: '/mnt/disks/recordings-2' },
  'active',
)

/** realpath that is the identity — the fixture roots are already physical. */
const REALPATH = (p: string): string => p

/** `n` distinct physical roots, for the pacing bound. */
function manyRoots(count: number): readonly RecordingsLocation[] {
  return Array.from({ length: count }, (_, i) =>
    recordingsLocationOfMode(
      {
        id: `recordings:disk-${String(i).padStart(2, '0')}`,
        type: 'recordings',
        root: `/mnt/disks/rec-${String(i).padStart(2, '0')}`,
      },
      'active',
    ),
  )
}

function paths(deviceId: number, profile: string, count: number, hour = GHOST_HOUR): string[] {
  return Array.from({ length: count }, (_, i) =>
    segmentRelPath(deviceId, profile, hour + i * 10_000, 10_000, 1_000_000 + i),
  )
}

function ghostRow(
  deviceId: number,
  profile: string,
  segmentPaths: readonly string[],
  locationId = GHOST_ID,
  hour = GHOST_HOUR,
): SegmentHourRow {
  return segmentHourRow({
    key: segmentHourKey(deviceId, profile, locationId, hour),
    deviceId,
    profile,
    locationId,
    hourStartMs: hour,
    paths: segmentPaths,
  })
}

/**
 * A ledger whose state a test can read back. `forgetHour` and `repointSegments`
 * mutate the same map the real one does, so the two outcomes are
 * distinguishable by inspection and not only by which spy fired.
 */
class FakeLedger implements GhostLedger {
  readonly rows = new Map<string, SegmentHourRow>()
  /** What each key's hour directory holds — the fixture's stand-in for the
   *  `paths` column D523 removed from the durable row. */
  readonly pathsOf = new Map<string, readonly string[]>()
  readonly forgotten: { deviceId: number; profile: string; locationId: string; hour: number }[] = []
  readonly repointed: { rows: readonly SegmentRow[]; to: string }[] = []
  /** Set to make `forgetHour` a silent no-op — the "durable refused" shape:
   *  the call is accepted, nothing is written, and the row is still held. */
  forgetRefuses = false
  /** Ordered log of every mutation, for the ordering assertions. */
  readonly writeLog: string[] = []

  constructor(
    rows: readonly SegmentHourRow[] = [],
    pathsByKey: readonly (readonly string[])[] = [],
  ) {
    rows.forEach((row, i) => {
      this.rows.set(row.key, row)
      this.pathsOf.set(row.key, pathsByKey[i] ?? [])
    })
  }

  snapshot(): readonly SegmentHourRow[] {
    return [...this.rows.values()]
  }

  knowsHour(deviceId: number, profile: string, locationId: string, hour: number): boolean {
    return this.rows.has(segmentHourKey(deviceId, profile, locationId, hour))
  }

  forgetHour(deviceId: number, profile: string, locationId: string, hour: number): Promise<number> {
    this.forgotten.push({ deviceId, profile, locationId, hour })
    if (this.forgetRefuses) return Promise.resolve(0)
    const key = segmentHourKey(deviceId, profile, locationId, hour)
    const held = this.rows.get(key)
    if (held === undefined) return Promise.resolve(0)
    this.rows.delete(key)
    this.pathsOf.delete(key)
    this.writeLog.push(`forget:${key}`)
    return Promise.resolve(held.segments)
  }

  repointSegments(rows: readonly SegmentRow[], toLocationId: string): Promise<void> {
    this.repointed.push({ rows: [...rows], to: toLocationId })
    const first = rows[0]
    if (first === undefined) return Promise.resolve()
    const hour = Math.floor(first.startMs / HOUR_MS) * HOUR_MS
    const sourceKey = segmentHourKey(first.deviceId, first.profile, first.locationId, hour)
    const targetKey = segmentHourKey(first.deviceId, first.profile, toLocationId, hour)
    // D291's ordering: the TARGET row is written first, then the source goes.
    const moved = rows.map((r) => r.path)
    this.rows.set(
      targetKey,
      segmentHourRow({
        key: targetKey,
        deviceId: first.deviceId,
        profile: first.profile,
        locationId: toLocationId,
        hourStartMs: hour,
        paths: moved,
      }),
    )
    this.pathsOf.set(targetKey, moved)
    this.writeLog.push(`put:${targetKey}`)
    this.rows.delete(sourceKey)
    this.pathsOf.delete(sourceKey)
    this.writeLog.push(`forget:${sourceKey}`)
    return Promise.resolve()
  }
}

/** What one root answers when asked what its copy of an hour holds. `null` is
 *  "could not decide"; a THROW is an I/O error. Neither is an absence. */
type HourListing = readonly string[] | null
type ListingFn = (
  locationId: string,
  deviceId: number,
  profile: string,
  hourStartMs: number,
) => HourListing

interface Harness {
  readonly sweeper: GhostLocationSweeper
  readonly ledger: FakeLedger
  readonly listHour: ReturnType<typeof vi.fn>
  readonly applyToIndex: ReturnType<typeof vi.fn>
  readonly forgetInIndex: ReturnType<typeof vi.fn>
  readonly pace: ReturnType<typeof vi.fn>
  readonly logger: {
    info: ReturnType<typeof vi.fn>
    warn: ReturnType<typeof vi.fn>
    debug: ReturnType<typeof vi.fn>
  }
}

interface HarnessOptions {
  readonly rows?: readonly SegmentHourRow[]
  readonly locations?: readonly RecordingsLocation[]
  /** What each root's copy of the hour DIRECTORY holds. Default: empty
   *  everywhere, which is the orphaned shape. Throw to make it an I/O error. */
  readonly listing?: ListingFn
  readonly maxHoursPerPass?: number
  readonly maxProbesPerPass?: number
  readonly ledger?: FakeLedger
}

function harness(options: HarnessOptions = {}): Harness {
  const ledger = options.ledger ?? new FakeLedger(options.rows ?? [])
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  const listing: ListingFn = options.listing ?? ((): HourListing => [])
  const listHour = vi.fn((locationId: string, deviceId: number, profile: string, hour: number) =>
    Promise.resolve(listing(locationId, deviceId, profile, hour)),
  )
  const applyToIndex = vi.fn()
  const forgetInIndex = vi.fn((): readonly string[] => [])
  const pace = vi.fn(() => Promise.resolve())
  const deps: GhostLocationSweepDeps = {
    ledger,
    locations: () => options.locations ?? [RECORDINGS, RECORDINGS_LOW],
    listHour,
    applyToIndex,
    forgetInIndex,
    logger,
    now: () => NOW,
    pace,
    realpath: REALPATH,
    ...(options.maxHoursPerPass === undefined ? {} : { maxHoursPerPass: options.maxHoursPerPass }),
    ...(options.maxProbesPerPass === undefined
      ? {}
      : { maxProbesPerPass: options.maxProbesPerPass }),
  }
  return {
    sweeper: new GhostLocationSweeper(deps),
    ledger,
    listHour,
    applyToIndex,
    forgetInIndex,
    pace,
    logger,
  }
}

describe('ghostProbeRoots', () => {
  it('collapses aliases of ONE physical root into a single probe target', () => {
    const roots = ghostProbeRoots([RECORDINGS, RECORDINGS_LOW, LOW_SSD], REALPATH)
    expect(roots).toHaveLength(2)
    const shared = roots.find((r) => r.key === '/recordings')
    expect(shared?.aliases.map((a) => a.id).toSorted()).toEqual([
      'recordings:default',
      'recordingsLow:default',
    ])
  })

  it('is ordered by root key, so which root a repoint lands on is deterministic', () => {
    const a = ghostProbeRoots([LOW_SSD, RECORDINGS], REALPATH).map((r) => r.key)
    const b = ghostProbeRoots([RECORDINGS, LOW_SSD], REALPATH).map((r) => r.key)
    expect(a).toEqual(b)
  })
})

describe('GhostLocationSweeper — the pass refuses before it acts', () => {
  it('does NOTHING and says so when no location resolves', async () => {
    const h = harness({ rows: [ghostRow(104, 'high', paths(104, 'high', 3))], locations: [] })
    const result = await h.sweeper.sweep()

    expect(result.refused).toBe('no-resolvable-location')
    expect(h.listHour).not.toHaveBeenCalled()
    expect(h.ledger.forgotten).toHaveLength(0)
    expect(h.ledger.repointed).toHaveLength(0)
    expect(h.applyToIndex).not.toHaveBeenCalled()
    expect(h.forgetInIndex).not.toHaveBeenCalled()
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no recordings location resolves'),
      expect.anything(),
    )
  })

  it('never examines a row whose location DOES resolve', async () => {
    const healthy = ghostRow(104, 'high', paths(104, 'high', 5), 'recordings:default')
    const h = harness({ rows: [healthy] })
    const result = await h.sweeper.sweep()

    expect(result.ghostHours).toBe(0)
    expect(result.probes).toBe(0)
    expect(h.ledger.rows.has(healthy.key)).toBe(true)
  })

  it('refuses an hour whose row accounts for no segments — there is nothing to confirm', async () => {
    const h = harness({ rows: [ghostRow(104, 'high', [])] })
    const result = await h.sweeper.sweep()

    expect(result.skippedByReason['no-paths']).toBe(1)
    expect(result.hoursForgotten).toBe(0)
    expect(h.listHour).not.toHaveBeenCalled()
    expect(h.ledger.rows.size).toBe(1)
  })
})

describe('GhostLocationSweeper — forget requires EVERY root to answer EMPTY', () => {
  it('forgets an hour only after every candidate root listed it empty', async () => {
    const rowPaths = paths(104, 'high', 4)
    const h = harness({ rows: [ghostRow(104, 'high', rowPaths)] })
    const result = await h.sweeper.sweep()

    expect(result.hoursForgotten).toBe(1)
    expect(result.segmentsForgotten).toBe(4)
    // One listing per PHYSICAL root — the two fixture locations alias
    // /recordings, so the hour costs a single directory read (D523), where it
    // used to cost one `exists` per path.
    expect(result.probes).toBe(1)
    expect(h.listHour).toHaveBeenCalledTimes(1)
    expect(h.listHour).toHaveBeenCalledWith('recordings:default', 104, 'high', GHOST_HOUR)
    // The forget removed the source key and added NOTHING — the shape that
    // distinguishes it from a repoint.
    expect([...h.ledger.rows.keys()]).toEqual([])
    // The ghost row names no file, so the resident index is asked to EMPTY the
    // (device, ghost location, hour) rather than told which rows to remove.
    expect(h.forgetInIndex).toHaveBeenCalledWith(104, GHOST_ID, GHOST_HOUR)
    expect(h.applyToIndex).not.toHaveBeenCalled()
  })

  it('lists BOTH physical roots before forgetting', async () => {
    const h = harness({
      rows: [ghostRow(104, 'high', paths(104, 'high', 3))],
      locations: [RECORDINGS, RECORDINGS_LOW, LOW_SSD],
    })
    const result = await h.sweeper.sweep()

    expect(result.hoursForgotten).toBe(1)
    expect(result.probes).toBe(2)
    const probedRoots = new Set(h.listHour.mock.calls.map((c) => c[0]))
    expect(probedRoots.has('recordings:default')).toBe(true)
    expect(probedRoots.has('recordingsLow:ssd')).toBe(true)
  })

  it('forgets nothing when a listing THROWS — an I/O error is not an absence', async () => {
    const h = harness({
      rows: [ghostRow(104, 'high', paths(104, 'high', 5))],
      locations: [RECORDINGS, LOW_SSD],
      listing: (locationId): HourListing => {
        if (locationId === 'recordingsLow:ssd') throw new Error('EIO')
        return []
      },
    })
    const result = await h.sweeper.sweep()

    expect(result.hoursForgotten).toBe(0)
    expect(result.skippedByReason['probe-error']).toBe(1)
    expect(h.ledger.forgotten).toHaveLength(0)
    expect(h.forgetInIndex).not.toHaveBeenCalled()
    expect(h.ledger.rows.size).toBe(1)
  })

  it('forgets nothing when a root cannot say what it holds — an UNREAD hour is not an empty one', async () => {
    const h = harness({
      rows: [ghostRow(104, 'high', paths(104, 'high', 3))],
      locations: [RECORDINGS, LOW_SSD],
      listing: (locationId): HourListing => (locationId === 'recordingsLow:ssd' ? null : []),
    })
    const result = await h.sweeper.sweep()

    expect(result.skippedByReason['detail-unavailable']).toBe(1)
    expect(result.hoursForgotten).toBe(0)
    expect(h.ledger.forgotten).toHaveLength(0)
    expect(h.ledger.rows.size).toBe(1)
  })

  it('refuses when the FOUND listing names something it cannot parse into that hour', async () => {
    const foreign = segmentRelPath(104, 'high', GHOST_HOUR + 5 * HOUR_MS, 10_000, 42)
    const h = harness({
      rows: [ghostRow(104, 'high', paths(104, 'high', 2))],
      listing: (): HourListing => [...paths(104, 'high', 2), foreign],
    })
    const result = await h.sweeper.sweep()

    expect(result.skippedByReason['unparseable-paths']).toBe(1)
    expect(h.ledger.repointed).toHaveLength(0)
    expect(h.ledger.forgotten).toHaveLength(0)
    expect(h.ledger.rows.size).toBe(1)
  })

  it('leaves the hour standing when the durable forget did not land', async () => {
    const ledger = new FakeLedger([ghostRow(104, 'high', paths(104, 'high', 2))])
    ledger.forgetRefuses = true
    const h = harness({ ledger })
    const result = await h.sweeper.sweep()

    expect(h.ledger.forgotten).toHaveLength(1)
    expect(result.hoursForgotten).toBe(0)
    expect(result.skippedByReason['durable-refused']).toBe(1)
    // The read-back is what caught it: `knowsHour` is still true, so the RAM
    // index must not be told the row is gone.
    expect(h.ledger.knowsHour(104, 'high', GHOST_ID, GHOST_HOUR)).toBe(true)
    expect(h.forgetInIndex).not.toHaveBeenCalled()
  })

  it('writes the DURABLE forget before it empties the resident index', async () => {
    const order: string[] = []
    const ledger = new FakeLedger([ghostRow(104, 'high', paths(104, 'high', 2))])
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
    const sweeper = new GhostLocationSweeper({
      ledger: {
        snapshot: () => ledger.snapshot(),
        knowsHour: (...args) => ledger.knowsHour(...args),
        forgetHour: async (...args) => {
          order.push('durable')
          return ledger.forgetHour(...args)
        },
        repointSegments: (rows, to) => ledger.repointSegments(rows, to),
      },
      locations: () => [RECORDINGS, RECORDINGS_LOW],
      listHour: () => Promise.resolve([]),
      applyToIndex: () => {},
      forgetInIndex: (): readonly string[] => {
        order.push('index')
        return []
      },
      logger,
      now: () => NOW,
      pace: () => Promise.resolve(),
      realpath: REALPATH,
    })
    await sweeper.sweep()

    expect(order).toEqual(['durable', 'index'])
  })
})

describe('GhostLocationSweeper — an hour that still EXISTS is REPOINTED, never deleted', () => {
  /**
   * The DESTRUCTIVE negatives, asserted first and alone.
   *
   * Its sibling below asserts `hoursRepointed === 1`, which goes red for two
   * completely different reasons: the pass did nothing, or the pass DELETED
   * the index of footage that exists. Only the second is a data-loss bug, and
   * a disarm that reports "expected 0 to be 1" cannot tell you which one
   * happened. This test says nothing about repointing at all — it only says
   * the paths are still indexed somewhere and nothing was forgotten.
   */
  it('DELETES NOTHING when the directory is non-empty — every path is still indexed afterwards', async () => {
    const rowPaths = paths(102, 'high', 6)
    const h = harness({
      rows: [ghostRow(102, 'high', rowPaths)],
      listing: (locationId): HourListing => (locationId === 'recordings:default' ? rowPaths : []),
    })
    await h.sweeper.sweep()

    expect(h.ledger.forgotten).toEqual([])
    expect(h.forgetInIndex).not.toHaveBeenCalled()
    const stillIndexed = [...h.ledger.pathsOf.values()].flat().toSorted()
    expect(stillIndexed).toEqual(rowPaths.toSorted())
  })

  it('repoints the hour to the location whose directory holds it', async () => {
    const rowPaths = paths(102, 'high', 6)
    const source = ghostRow(102, 'high', rowPaths)
    const h = harness({
      rows: [source],
      listing: (locationId): HourListing => (locationId === 'recordings:default' ? rowPaths : []),
    })
    const result = await h.sweeper.sweep()

    expect(result.hoursRepointed).toBe(1)
    expect(result.segmentsRepointed).toBe(6)
    expect(result.hoursForgotten).toBe(0)
    // The load-bearing negative: nothing was forgotten.
    expect(h.ledger.forgotten).toHaveLength(0)
    // …and the durable state is a REPOINT, not a delete — the target key holds
    // every segment the found directory listed.
    const targetKey = segmentHourKey(102, 'high', 'recordings:default', GHOST_HOUR)
    expect(h.ledger.rows.has(source.key)).toBe(false)
    expect(h.ledger.rows.get(targetKey)?.segments).toBe(6)
    expect(h.ledger.pathsOf.get(targetKey)?.toSorted()).toEqual(rowPaths.toSorted())
    expect(h.applyToIndex).toHaveBeenCalledWith(expect.anything(), 'recordings:default')
  })

  it('moves what the LISTING names, never what the ghost row claimed', async () => {
    // The row's aggregate was accounted for by a writer that is long gone; the
    // directory has since been partly evicted and has a name the row never
    // knew. Since D523 the directory is the authority for WHICH segments
    // exist — the row is only the authority for how much it thought it had.
    const rowPaths = paths(619, 'high', 6)
    const unknownToTheRow = segmentRelPath(619, 'high', GHOST_HOUR + 1_800_000, 10_000, 77)
    const onDisk = [...rowPaths.slice(0, 3), unknownToTheRow]
    const h = harness({
      rows: [ghostRow(619, 'high', rowPaths)],
      listing: (locationId): HourListing => (locationId === 'recordings:default' ? onDisk : []),
    })
    const result = await h.sweeper.sweep()

    expect(result.hoursRepointed).toBe(1)
    expect(result.segmentsRepointed).toBe(4)
    expect(h.ledger.repointed[0]?.rows.map((r) => r.path).toSorted()).toEqual(onDisk.toSorted())
    // The tuple fields still come from the LEDGER ROW, so the repoint buckets
    // under the key the source row is actually filed at.
    expect(h.ledger.repointed[0]?.rows.every((r) => r.locationId === GHOST_ID)).toBe(true)
  })

  it('lists EVERY root even after a hit — "found at exactly one root" is a claim about all of them', async () => {
    const rowPaths = paths(102, 'mid', 40)
    const h = harness({
      rows: [ghostRow(102, 'mid', rowPaths)],
      locations: [RECORDINGS, LOW_SSD],
      // The hit is on the root probed FIRST (roots are ordered by key, and
      // '/mnt/disks/recordings-2' sorts before '/recordings'), so a loop that
      // stopped at the hit would show up as one listing instead of two.
      listing: (locationId): HourListing => (locationId === 'recordingsLow:ssd' ? rowPaths : []),
    })
    const result = await h.sweeper.sweep()

    expect(result.hoursRepointed).toBe(1)
    // Two physical roots, two listings: short-circuiting on the first hit would
    // give up the multi-root refusal below.
    expect(result.probes).toBe(2)
    expect(h.ledger.repointed[0]?.to).toBe('recordingsLow:ssd')
  })

  it('repoints even when only ONE segment survives — a partly-evicted hour is still mis-pointed', async () => {
    const rowPaths = paths(618, 'high', 8)
    const survivor = rowPaths[7]
    const h = harness({
      rows: [ghostRow(618, 'high', rowPaths)],
      listing: (locationId): HourListing =>
        locationId === 'recordings:default' && survivor !== undefined ? [survivor] : [],
    })
    const result = await h.sweeper.sweep()

    expect(result.hoursRepointed).toBe(1)
    expect(result.hoursForgotten).toBe(0)
    expect(h.ledger.forgotten).toHaveLength(0)
    const targetKey = segmentHourKey(618, 'high', 'recordings:default', GHOST_HOUR)
    expect(h.ledger.rows.get(targetKey)?.segments).toBe(1)
  })

  it('picks the alias that matches the PROFILE when two locations share a root', async () => {
    const lowPaths = paths(592, 'low', 2)
    const h = harness({
      rows: [ghostRow(592, 'low', lowPaths, 'recordingsLow:archived')],
      listing: (): HourListing => lowPaths,
    })
    const result = await h.sweeper.sweep()

    expect(result.hoursRepointed).toBe(1)
    expect(h.ledger.repointed[0]?.to).toBe('recordingsLow:default')
    // The listing was asked of that same alias, not of the `recordings` one.
    expect(h.listHour).toHaveBeenCalledWith('recordingsLow:default', 592, 'low', GHOST_HOUR)
  })

  it('refuses when the hour is on more than one PHYSICAL root — repointing would be a guess', async () => {
    const rowPaths = paths(1441, 'high', 3)
    const h = harness({
      rows: [ghostRow(1441, 'high', rowPaths)],
      locations: [RECORDINGS, LOW_SSD],
      listing: (): HourListing => rowPaths,
    })
    const result = await h.sweeper.sweep()

    expect(result.skippedByReason['found-at-multiple-roots']).toBe(1)
    expect(h.ledger.repointed).toHaveLength(0)
    expect(h.ledger.forgotten).toHaveLength(0)
    expect(h.applyToIndex).not.toHaveBeenCalled()
    expect(h.forgetInIndex).not.toHaveBeenCalled()
  })

  it('writes the DURABLE row before it touches the resident index', async () => {
    const order: string[] = []
    const rowPaths = paths(101, 'high', 2)
    const ledger = new FakeLedger([ghostRow(101, 'high', rowPaths)])
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
    const sweeper = new GhostLocationSweeper({
      ledger: {
        snapshot: () => ledger.snapshot(),
        knowsHour: (...args) => ledger.knowsHour(...args),
        forgetHour: (...args) => ledger.forgetHour(...args),
        repointSegments: async (rows, to) => {
          order.push('durable')
          return ledger.repointSegments(rows, to)
        },
      },
      locations: () => [RECORDINGS, RECORDINGS_LOW],
      listHour: () => Promise.resolve(rowPaths),
      applyToIndex: () => {
        order.push('index')
      },
      forgetInIndex: (): readonly string[] => [],
      logger,
      now: () => NOW,
      pace: () => Promise.resolve(),
      realpath: REALPATH,
    })
    await sweeper.sweep()

    expect(order).toEqual(['durable', 'index'])
  })
})

describe('GhostLocationSweeper — bounded and paced', () => {
  it('examines at most `maxHoursPerPass` and DEFERS the rest', async () => {
    const rows = Array.from({ length: 9 }, (_, i) =>
      ghostRow(
        104,
        'high',
        paths(104, 'high', 2, GHOST_HOUR + i * HOUR_MS),
        GHOST_ID,
        GHOST_HOUR + i * HOUR_MS,
      ),
    )
    const h = harness({ rows, maxHoursPerPass: 3 })
    const result = await h.sweeper.sweep()

    expect(result.ghostHours).toBe(9)
    expect(result.hoursExamined).toBe(3)
    expect(result.hoursDeferred).toBe(6)
    expect(result.hoursForgotten).toBe(3)
  })

  it('takes the OLDEST ghost hours first, so a bounded pass converges', async () => {
    const hours = [GHOST_HOUR + 5 * HOUR_MS, GHOST_HOUR, GHOST_HOUR + 2 * HOUR_MS]
    const rows = hours.map((hour) =>
      ghostRow(104, 'high', paths(104, 'high', 1, hour), GHOST_ID, hour),
    )
    const h = harness({ rows, maxHoursPerPass: 1 })
    await h.sweeper.sweep()

    expect(h.ledger.forgotten[0]?.hour).toBe(GHOST_HOUR)
  })

  it('leaves an hour UNDECIDED rather than half-listed when the budget runs out', async () => {
    const h = harness({
      rows: [ghostRow(104, 'high', paths(104, 'high', 10))],
      // Three physical roots, room for one listing: the hour cannot be proved
      // absent, so it is refused rather than forgotten on partial evidence.
      locations: [RECORDINGS, LOW_SSD, ...manyRoots(1)],
      maxProbesPerPass: 1,
    })
    const result = await h.sweeper.sweep()

    expect(result.skippedByReason['probe-budget']).toBe(1)
    expect(result.hoursForgotten).toBe(0)
    expect(h.ledger.forgotten).toHaveLength(0)
    expect(h.ledger.rows.size).toBe(1)
  })

  it('never touches an hour inside the live tail', async () => {
    const liveHour = Math.floor(NOW / HOUR_MS) * HOUR_MS
    const h = harness({
      rows: [ghostRow(104, 'high', paths(104, 'high', 2, liveHour), GHOST_ID, liveHour)],
    })
    const result = await h.sweeper.sweep()

    expect(result.skippedByReason['live-tail']).toBe(1)
    expect(h.listHour).not.toHaveBeenCalled()
    expect(h.ledger.rows.size).toBe(1)
  })

  it('paces itself — one brake per listing batch', async () => {
    // The brake is per LISTING, and since D523 an hour costs one listing per
    // physical root, so the batch is only reached on a fleet with that many
    // roots. Two batches' worth of roots, two brakes.
    const h = harness({
      rows: [ghostRow(104, 'high', paths(104, 'high', 4))],
      locations: manyRoots(GHOST_PROBE_BATCH * 2),
    })
    const result = await h.sweeper.sweep()

    expect(result.probes).toBe(GHOST_PROBE_BATCH * 2)
    expect(h.pace).toHaveBeenCalledTimes(2)
  })
})

describe('GhostLocationSweeper — it is loud about what it did', () => {
  it('summarises per CAMERA with the deviceId tag, never a line per row', async () => {
    const h = harness({
      rows: [
        ghostRow(104, 'high', paths(104, 'high', 5)),
        ghostRow(104, 'mid', paths(104, 'mid', 5)),
        ghostRow(102, 'high', paths(102, 'high', 5)),
      ],
    })
    const result = await h.sweeper.sweep()

    expect(result.hoursForgotten).toBe(3)
    const perCamera = h.logger.info.mock.calls.filter(
      (call) => call[0] === 'recorder: ghost-location reconcile — camera summary',
    )
    expect(perCamera).toHaveLength(2)
    expect(perCamera.map((call) => call[1]?.tags?.deviceId).toSorted()).toEqual([102, 104])
    const tallied = perCamera.find((call) => call[1]?.tags?.deviceId === 104)
    expect(tallied?.[1]?.meta?.forgottenHours).toBe(2)
    expect(tallied?.[1]?.meta?.forgottenSegments).toBe(10)
  })

  it('names the ghost location ids and the skip reasons in the pass summary', async () => {
    const h = harness({
      rows: [ghostRow(592, 'high', paths(592, 'high', 2), 'recordings:gone')],
      listing: (): HourListing => null,
    })
    const result = await h.sweeper.sweep()

    expect(result.ghostLocations).toEqual(['recordings:gone'])
    const summary = h.logger.info.mock.calls.find(
      (call) => call[0] === 'recorder: ghost-location reconcile complete',
    )
    expect(summary?.[1]?.meta?.ghostLocations).toEqual(['recordings:gone'])
    expect(summary?.[1]?.meta?.skippedByReason?.['detail-unavailable']).toBe(1)
  })
})

describe('the recorder addon arms the reconcile on the SLOWEST cadence it has', () => {
  // Anchored to THIS file, not process.cwd(): the suite must pass whether
  // vitest runs from the package dir (nx) or the repo root.
  const here = dirname(fileURLToPath(import.meta.url))
  const addon = readFileSync(resolve(here, '../index.ts'), 'utf8')
  const periodic = readFileSync(resolve(here, '../periodic-pass.ts'), 'utf8')

  const intervalOf = (name: string): number => {
    const match = new RegExp(`const ${name} = ([^\\n]+)`).exec(addon)
    const expr = match?.[1]
      ?.replace(/_/g, '')
      .replace(/\/\/.*$/, '')
      .trim()
    expect(expr).toBeDefined()
    // Only arithmetic over numeric literals — no identifiers, no calls.
    expect(expr).toMatch(/^[\d\s*+]+$/)
    return Number(
      expr
        ?.split('*')
        .map((part) => Number(part.trim()))
        .reduce((a, b) => a * b, 1),
    )
  }

  it('runs daily — slower than retention, redundancy and the export janitor', () => {
    const ghost = intervalOf('GHOST_LOCATION_SWEEP_INTERVAL_MS')
    expect(ghost).toBe(24 * 60 * 60_000)
    expect(ghost).toBeGreaterThan(intervalOf('RETENTION_SWEEP_INTERVAL_MS'))
    expect(ghost).toBeGreaterThan(intervalOf('REDUNDANCY_SWEEP_INTERVAL_MS'))
    expect(ghost).toBeGreaterThan(intervalOf('EXPORT_SWEEP_INTERVAL_MS'))
  })

  it('does NOT run at boot — the pass primitive it uses fires on the interval only', () => {
    expect(addon).toContain("name: 'ghost-location-reconcile'")
    expect(addon).toContain('GHOST_LOCATION_SWEEP_INTERVAL_MS')
    // The retention sweeper deliberately ticks immediately on `start()`; this
    // one must not, because boot is when the staging reconcile, the ledger load
    // and the first retention sweep are already contending for the array.
    const armed = periodic.slice(periodic.indexOf('export function startPeriodicPass'))
    expect(armed).toContain('setInterval(fire, deps.intervalMs)')
    expect(armed).not.toMatch(/^\s*fire\(\)$/m)
  })

  it('is stopped on shutdown, so a respawn never leaves a probe loop behind', () => {
    expect(addon).toContain('this.ghostLocationPass?.stop()')
  })
})
