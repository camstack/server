/**
 * The ledger↔disk reconcile — one `readdir` per claimed HOUR, compared against
 * what that hour's durable ROW accounts for.
 *
 * ## The fixture shape that matters
 *
 * Since D523 the durable row names no file: it says how MUCH an hour holds, and
 * the directory says WHICH segments exist. So the fake disk is a
 * `Map<hourDir, Set<fileName>>` and the fake ledger is a
 * `Map<hourKey, SegmentHourRow>` built from a SEPARATE list of paths — the two
 * can disagree in both directions at once, which is the production shape
 * (11 074 hours of account the disk does not hold, and hours holding footage
 * nothing accounted for). A fixture where the ledger is derived from the disk
 * cannot fail the way production failed.
 *
 * The fake ledger's `adoptWalkedHour` is a faithful copy of the real one,
 * INCLUDING its refusal of a listing that would erase more than
 * `HOUR_LISTING_MAX_SHRINK_SHARE` of the row — because how this pass reacts to
 * that silent refusal is one of the properties pinned here.
 *
 * ## What every assertion here is about
 *
 * The unit is the **syscall shape**, never wall clock: how many `listHour`
 * calls were made, against which hour directories, in which order relative to
 * the anchor read and the durable write. "It found the ghosts" is not the
 * property — "it found them with one call per hour, and only after the volume
 * marker agreed twice" is.
 */
import { describe, expect, it, vi } from 'vitest'
import { segmentRelPath } from '../../segment-path.js'
import type { ArchiveCensus, ArchiveScope, SegmentRow } from '../../types.js'
import {
  type LedgerWalkLedger,
  type LedgerWalkReconcileDeps,
  LedgerWalkReconciler,
  type LedgerWalkReport,
  WALK_HOUR_BATCH,
  WALK_ORPHAN_SAMPLE,
} from '../ledger-walk-reconcile.js'
import type { RecordingsLocation } from '../roots.js'
import { hourDirRelPath, recordingsLocationOfMode } from '../roots.js'
import type { SegmentHourRow, WalkedHourOutcome } from '../segment-hour-ledger.js'
import {
  HOUR_LISTING_MAX_SHRINK_SHARE,
  hourAggregate,
  hourRowOf,
  hourStartMs,
  segmentHourKey,
  segmentHourRow,
} from '../segment-hour-ledger.js'

const HOUR_MS = 3_600_000
/** 2026-08-29T09:00:00Z — the first whole hour the production hole swallowed. */
const HOLE_HOUR = Date.UTC(2026, 7, 29, 9, 0, 0)
/** Well past the hole, so nothing under test is in the live tail. */
const NOW = Date.UTC(2026, 7, 30, 12, 0, 0)
const LOCATION_ID = 'recordingsLow:default'
const ROOT = '/recordings'
const VOLUME = 'vol-usb-a'

const LOCATION_BASE = { id: LOCATION_ID, type: 'recordingsLow', root: ROOT } as const

/** The live source, frozen by the operator: `disabled`, so the walk is licensed. */
const FROZEN: RecordingsLocation = recordingsLocationOfMode(LOCATION_BASE, 'disabled')
/** The same disk, still a write target. */
const WRITABLE: RecordingsLocation = recordingsLocationOfMode(LOCATION_BASE, 'active')
/** Frozen the other way — an operator who set `readonly` instead of disabling. */
const READ_ONLY: RecordingsLocation = recordingsLocationOfMode(LOCATION_BASE, 'readonly')

function seg(deviceId: number, hour: number, i: number, profile = 'low'): string {
  return segmentRelPath(deviceId, profile, hour + i * 10_000, 10_000, 1_000_000 + i)
}

function rowOf(path: string, locationId = LOCATION_ID): SegmentRow {
  const m = /^(\d+)\/([^/]+)\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/(\d+)-(\d+)-(\d+)\.m4s$/.exec(path)
  if (m === null) throw new Error(`fixture: unparseable ${path}`)
  return {
    deviceId: Number(m[1]),
    profile: m[2]!,
    startMs: Number(m[3]),
    durMs: Number(m[4]),
    bytes: Number(m[5]),
    path,
    locationId,
  }
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function keyOfPath(path: string): string {
  const row = rowOf(path)
  return segmentHourKey(row.deviceId, row.profile, row.locationId, hourStartMs(row.startMs))
}

/**
 * The DURABLE half a test can read back — hour ROWS, keyed exactly as
 * `SegmentHourLedger` keys them, so an adoption or a forget leaves visibly
 * different state than a no-op.
 *
 * It is seeded from a list of paths only because a path is the most readable
 * way for a test to SAY "this hour accounts for these twelve segments". The
 * paths are folded into the aggregate and thrown away, exactly as the real
 * ledger throws them away (D523).
 */
class FakeLedger {
  readonly rows = new Map<string, SegmentHourRow>()
  /** Every `adoptWalkedHour`, as `<key>|<listed count>`. */
  readonly adopted: string[] = []
  /** Every `forgetHour`, as the hour key. */
  readonly forgotten: string[] = []
  /**
   * `adoptWalkedHour` accepts the call, writes nothing and reports nothing —
   * the shape a caller that ASSUMED the write landed would turn into telling
   * the resident index a row is gone that the archive still holds.
   */
  adoptIsSilentNoOp = false

  constructor(paths: readonly string[]) {
    const byHour = new Map<string, string[]>()
    for (const path of paths) {
      const key = keyOfPath(path)
      const held = byHour.get(key)
      if (held) held.push(path)
      else byHour.set(key, [path])
    }
    for (const [key, held] of byHour) {
      const first = rowOf(held[0]!)
      this.rows.set(
        key,
        segmentHourRow({
          key,
          deviceId: first.deviceId,
          profile: first.profile,
          locationId: first.locationId,
          hourStartMs: hourStartMs(first.startMs),
          paths: held,
          sealed: true,
        }),
      )
    }
  }

  snapshot(): readonly SegmentHourRow[] {
    return [...this.rows.values()]
  }

  knowsHour(deviceId: number, profile: string, locationId: string, hour: number): boolean {
    return this.rows.has(segmentHourKey(deviceId, profile, locationId, hour))
  }

  hourRow(
    deviceId: number,
    profile: string,
    locationId: string,
    hour: number,
  ): SegmentHourRow | undefined {
    return this.rows.get(segmentHourKey(deviceId, profile, locationId, hour))
  }

  /**
   * The real `adoptWalkedHour`, refusal and all: the listing REPLACES the row's
   * aggregate and seals it, unless it would erase more than
   * {@link HOUR_LISTING_MAX_SHRINK_SHARE} of what the row accounts for — which
   * is what an unmounted root answers — in which case the row stands and the
   * refusal is SILENT.
   */
  adoptWalkedHour(
    deviceId: number,
    profile: string,
    locationId: string,
    hour: number,
    paths: readonly string[],
  ): Promise<WalkedHourOutcome | null> {
    const key = segmentHourKey(deviceId, profile, locationId, hour)
    this.adopted.push(`${key}|${paths.length}`)
    const refused: WalkedHourOutcome = { created: false, added: 0, sealedNow: false }
    if (this.adoptIsSilentNoOp) return Promise.resolve(refused)
    const walked = hourAggregate(paths)
    const held = this.rows.get(key)
    if (held === undefined) {
      if (walked.segments === 0) return Promise.resolve(refused)
      this.rows.set(
        key,
        hourRowOf(
          { key, deviceId, profile, locationId, hourStartMs: hour },
          { ...walked, sealed: true },
        ),
      )
      return Promise.resolve({ created: true, added: walked.segments, sealedNow: true })
    }
    const shrink = held.segments - walked.segments
    if (shrink > 0 && shrink > held.segments * HOUR_LISTING_MAX_SHRINK_SHARE)
      return Promise.resolve(refused)
    this.rows.set(
      key,
      hourRowOf(
        { key, deviceId, profile, locationId, hourStartMs: hour },
        { ...walked, sealed: true },
      ),
    )
    return Promise.resolve({
      created: false,
      added: Math.max(0, walked.segments - held.segments),
      sealedNow: !held.sealed,
    })
  }

  forgetHour(deviceId: number, profile: string, locationId: string, hour: number): Promise<number> {
    const key = segmentHourKey(deviceId, profile, locationId, hour)
    this.forgotten.push(key)
    const held = this.rows.get(key)
    if (held === undefined) return Promise.resolve(0)
    this.rows.delete(key)
    return Promise.resolve(held.segments)
  }

  /** Segments still accounted for, across every hour row — the end state a
   *  forget or an adoption is visible in. */
  claimedSegments(): number {
    return this.snapshot().reduce((sum, row) => sum + row.segments, 0)
  }

  /** The hour keys still held, sorted — so "which hours survived" is assertable
   *  without any row naming a file. */
  claimedHours(): readonly string[] {
    return [...this.rows.keys()].toSorted()
  }
}

interface HarnessOptions {
  /** Paths whose aggregate the durable ledger CLAIMS. */
  readonly claims: readonly string[]
  /** Paths actually on disk. Hour directories are derived from these. */
  readonly onDisk?: readonly string[]
  /** Hour directories that exist but are EMPTY (distinct from absent). */
  readonly emptyDirs?: readonly string[]
  readonly location?: RecordingsLocation
  /** `null` = no marker (the mount is gone). A function is read per call. */
  readonly anchor?: string | null | (() => string | null)
  readonly anchorThrows?: boolean
  readonly listThrowsFor?: (relDir: string) => boolean
  readonly censusFails?: boolean
  readonly noLedger?: boolean
  readonly maxHours?: number
}

interface HarnessLogSpies {
  readonly info: ReturnType<typeof vi.fn>
  readonly warn: ReturnType<typeof vi.fn>
  readonly debug: ReturnType<typeof vi.fn>
}

interface Harness {
  readonly reconciler: LedgerWalkReconciler
  readonly ledger: FakeLedger
  readonly listHour: ReturnType<typeof vi.fn>
  readonly anchorOf: ReturnType<typeof vi.fn>
  readonly applyToIndex: ReturnType<typeof vi.fn>
  readonly streamSegments: ReturnType<typeof vi.fn>
  readonly pace: ReturnType<typeof vi.fn>
  readonly logger: HarnessLogSpies
  /** Every `listHour` call, as `<root>|<relDir>`. */
  readonly listed: string[]
  /** Ordered log of the syscalls that matter, for ordering assertions. */
  readonly trace: string[]
}

function harness(options: HarnessOptions): Harness {
  const ledger = new FakeLedger(options.claims)
  const disk = new Map<string, Set<string>>()
  for (const dir of options.emptyDirs ?? []) disk.set(dir, new Set<string>())
  for (const path of options.onDisk ?? []) {
    const row = rowOf(path)
    const dir = hourDirRelPath(row.deviceId, row.profile, hourStartMs(row.startMs))
    const held = disk.get(dir)
    if (held) held.add(baseName(path))
    else disk.set(dir, new Set([baseName(path)]))
  }
  const listed: string[] = []
  const trace: string[] = []
  const listHour = vi.fn(async (root: string, relDir: string) => {
    await Promise.resolve()
    listed.push(`${root}|${relDir}`)
    trace.push(`list:${relDir}`)
    if (options.listThrowsFor?.(relDir) === true) throw new Error('EIO: the array said no')
    const held = disk.get(relDir)
    return held === undefined ? null : [...held].toSorted()
  })
  const anchorOf = vi.fn(async (root: string) => {
    await Promise.resolve()
    trace.push(`anchor:${root}`)
    if (options.anchorThrows === true) throw new Error('EIO: the root said no')
    const anchor = options.anchor === undefined ? VOLUME : options.anchor
    return typeof anchor === 'function' ? anchor() : anchor
  })
  const applyToIndex = vi.fn(
    (_deviceId: number, _locationId: string, _hour: number, paths: readonly string[]) => {
      trace.push(`index:${paths.length}`)
      return []
    },
  )
  const pace = vi.fn(async () => {
    await Promise.resolve()
    trace.push('pace')
  })
  const logger: HarnessLogSpies = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  // The archive half is derived from the SAME hour rows — never a second source
  // of truth for what is claimed.
  const census = vi.fn((scope: ArchiveScope): Promise<ArchiveCensus | null> => {
    if (options.censusFails === true) return Promise.resolve(null)
    const rows = ledger.snapshot().filter((row) => inScope(row, scope))
    return Promise.resolve({
      segments: rows.reduce((sum, row) => sum + row.segments, 0),
      bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
      oldestMs: rows.length === 0 ? null : Math.min(...rows.map((r) => r.minStartMs)),
      newestMs: rows.length === 0 ? null : Math.max(...rows.map((r) => r.maxStartMs)),
    })
  })
  // Present because `LedgerWalkLedger` is a `FootageArchive`, and pinned UNUSED:
  // since D523 the claim set comes from the RAM snapshot, never a paged query.
  const streamSegments = vi.fn(async function* (): AsyncGenerator<readonly SegmentRow[]> {
    await Promise.resolve()
    yield []
  })
  const tracedLedger: LedgerWalkLedger = {
    census: (scope) => census(scope),
    streamSegments: () => streamSegments(),
    snapshot: () => ledger.snapshot(),
    adoptWalkedHour: (d, p, l, h, paths) => {
      trace.push(`adopt:${paths.length}`)
      return ledger.adoptWalkedHour(d, p, l, h, paths)
    },
    forgetHour: (d, p, l, h) => {
      trace.push('forget')
      return ledger.forgetHour(d, p, l, h)
    },
    knowsHour: (d, p, l, h) => ledger.knowsHour(d, p, l, h),
    hourRow: (d, p, l, h) => ledger.hourRow(d, p, l, h),
  }
  const deps: LedgerWalkReconcileDeps = {
    ledger: () => (options.noLedger === true ? null : tracedLedger),
    locations: () => [options.location ?? FROZEN],
    listHour,
    anchorOf,
    applyToIndex,
    logger,
    now: () => NOW,
    pace,
    ...(options.maxHours !== undefined ? { maxHours: options.maxHours } : {}),
  }
  return {
    reconciler: new LedgerWalkReconciler(deps),
    ledger,
    listHour,
    anchorOf,
    applyToIndex,
    streamSegments,
    pace,
    logger,
    listed,
    trace,
  }
}

function inScope(row: SegmentHourRow, scope: ArchiveScope): boolean {
  if (scope.locationId !== undefined && row.locationId !== scope.locationId) return false
  if (scope.deviceId !== undefined && row.deviceId !== scope.deviceId) return false
  const profiles = scope.profiles ?? []
  return profiles.length === 0 || profiles.includes(row.profile)
}

/** The production shape, at fixture scale: whole hours claimed and absent. */
function wholeHourClaims(
  devices: readonly number[],
  hours: readonly number[],
  per: number,
): readonly string[] {
  const out: string[] = []
  for (const device of devices) {
    for (const hour of hours) {
      for (let i = 0; i < per; i += 1) out.push(seg(device, hour, i))
    }
  }
  return out
}

describe('ledger walk reconcile — the cost is one readdir per HOUR', () => {
  it('lists each claimed hour exactly once, never once per file', async () => {
    // 3 cameras x 4 hours x 20 segments = 240 accounted segments, all present.
    const devices = [101, 102, 1441]
    const hours = [HOLE_HOUR, HOLE_HOUR + HOUR_MS, HOLE_HOUR + 2 * HOUR_MS, HOLE_HOUR + 3 * HOUR_MS]
    const claims = wholeHourClaims(devices, hours, 20)
    const h = harness({ claims, onDisk: claims })

    const report = await h.reconciler.run({ locationId: LOCATION_ID })

    expect(report.segmentsClaimed).toBe(240)
    // 12 hour directories, 240 files. One call per DIRECTORY.
    expect(h.listHour).toHaveBeenCalledTimes(12)
    expect(report.listings).toBe(12)
    expect(new Set(h.listed).size).toBe(12)
    expect(report.ghostSegments).toBe(0)
    expect(report.orphanFiles).toBe(0)
  })

  it('reports N against the archive M, so a short walk is visible', async () => {
    const claims = wholeHourClaims([101], [HOLE_HOUR, HOLE_HOUR + HOUR_MS], 10)
    const h = harness({ claims, onDisk: claims })
    const report = await h.reconciler.run({ locationId: LOCATION_ID })
    expect(report.archiveSegments).toBe(20)
    expect(report.segmentsClaimed).toBe(20)
    expect(report.hoursClaimed).toBe(2)
    expect(report.bounded).toBe(false)
  })

  it('the production shape: 55 whole (device, hour) groups cost 55 listings, not 11 074 stats', async () => {
    // 13 cameras, 4 whole hours of `low` — 52 groups, plus 3 more on a fifth
    // hour, is the 55 the drain's warnings aggregated to. Scaled to 24
    // segments each so the fixture stays a fixture.
    const devices = [104, 107, 101, 102, 108, 1438, 1441, 3836, 4001, 4002, 4003, 4004, 4005]
    const hours = [HOLE_HOUR, HOLE_HOUR + HOUR_MS, HOLE_HOUR + 2 * HOUR_MS, HOLE_HOUR + 3 * HOUR_MS]
    const claims = [
      ...wholeHourClaims(devices, hours, 24),
      ...wholeHourClaims([104, 592, 101], [HOLE_HOUR + 4 * HOUR_MS], 24),
    ]
    // NOTHING is on disk: every hour directory is absent, which is the shape.
    const h = harness({ claims, onDisk: [] })

    const report = await h.reconciler.run({ locationId: LOCATION_ID, apply: true })

    expect(report.hoursClaimed).toBe(55)
    expect(report.listings).toBe(55)
    expect(report.hoursMissing).toBe(55)
    expect(report.ghostHoursWhole).toBe(55)
    expect(report.ghostSegments).toBe(55 * 24)
    expect(report.forgottenSegments).toBe(55 * 24)
    // The whole point: no per-file syscall anywhere.
    expect(h.listHour.mock.calls.length).toBeLessThan(report.ghostSegments / 10)
    expect(h.ledger.claimedSegments()).toBe(0)
    expect(h.ledger.claimedHours()).toEqual([])
  })

  it('paces every WALK_HOUR_BATCH listings', async () => {
    const hours = Array.from({ length: WALK_HOUR_BATCH * 3 }, (_, i) => HOLE_HOUR + i * HOUR_MS)
    const claims = wholeHourClaims([101], hours, 2)
    const h = harness({ claims, onDisk: claims })
    await h.reconciler.run({ locationId: LOCATION_ID })
    expect(h.pace).toHaveBeenCalledTimes(3)
  })
})

describe('ledger walk reconcile — a walk needs no forget budget', () => {
  it('forgets EVERY confirmed-empty hour in one pass, past any 25 % share', async () => {
    // 400 segments accounted for over 20 hours; 19 of those hours hold nothing
    // at all — 380 of 400, or 95 %, far past D318's `max(64, 25 %)` mover bound.
    // A `readdir` of an hour that is OVER is complete evidence, so there is no
    // budget to spend here and none is applied.
    const hours = Array.from({ length: 20 }, (_, i) => HOLE_HOUR + i * HOUR_MS)
    const claims = wholeHourClaims([102], hours, 20)
    const survivingHour = hours[0]!
    const survivors = claims.filter((path) => hourStartMs(rowOf(path).startMs) === survivingHour)
    const h = harness({ claims, onDisk: survivors })

    const report = await h.reconciler.run({ locationId: LOCATION_ID, apply: true })

    expect(report.ghostSegments).toBe(380)
    expect(report.ghostHoursWhole).toBe(19)
    expect(report.forgottenSegments).toBe(380)
    expect(h.ledger.claimedSegments()).toBe(20)
    expect(h.ledger.claimedHours()).toEqual([keyOfPath(survivors[0]!)])
  })

  it('forgets nothing on a source that is still a write target, and does not even list', async () => {
    const claims = wholeHourClaims([102], [HOLE_HOUR], 10)
    const h = harness({ claims, onDisk: [], location: WRITABLE })

    const report = await h.reconciler.run({ locationId: LOCATION_ID, apply: true })

    expect(report.refused).toBe('source-writable')
    expect(h.listHour).not.toHaveBeenCalled()
    expect(h.ledger.claimedSegments()).toBe(10)
    expect(
      h.logger.warn.mock.calls.some(([message]) => String(message).includes('write target')),
    ).toBe(true)
  })

  it('accepts a readonly source — the mode a drain already implies', async () => {
    const claims = wholeHourClaims([102], [HOLE_HOUR], 10)
    const h = harness({ claims, onDisk: [], location: READ_ONLY })
    const report = await h.reconciler.run({ locationId: LOCATION_ID, apply: true })
    expect(report.refused).toBeNull()
    expect(report.forgottenSegments).toBe(10)
  })

  it('refuses a location the storage record does not know', async () => {
    const h = harness({ claims: wholeHourClaims([102], [HOLE_HOUR], 4) })
    const report = await h.reconciler.run({ locationId: 'recordings:gone', apply: true })
    expect(report.refused).toBe('location-unknown')
    expect(h.listHour).not.toHaveBeenCalled()
  })

  it('refuses a node with no durable ledger', async () => {
    const claims = wholeHourClaims([102], [HOLE_HOUR], 4)
    const h = harness({ claims, onDisk: [], noLedger: true })
    const report = await h.reconciler.run({ locationId: LOCATION_ID, apply: true })
    expect(report.refused).toBe('no-ledger')
    expect(h.listHour).not.toHaveBeenCalled()
  })

  it('refuses when the archive cannot say what the location holds', async () => {
    const claims = wholeHourClaims([102], [HOLE_HOUR], 4)
    const h = harness({ claims, onDisk: [], censusFails: true })
    const report = await h.reconciler.run({ locationId: LOCATION_ID, apply: true })
    expect(report.refused).toBe('archive-unreadable')
    expect(report.archiveSegments).toBeNull()
    expect(h.listHour).not.toHaveBeenCalled()
  })
})

describe('ledger walk reconcile — a missing HOUR is not a missing MOUNT', () => {
  it('forgets a whole absent hour while the volume marker is there', async () => {
    const claims = wholeHourClaims([102], [HOLE_HOUR], 12)
    const h = harness({ claims, onDisk: [] })
    const report = await h.reconciler.run({ locationId: LOCATION_ID, apply: true })
    expect(report.hoursMissing).toBe(1)
    expect(report.ghostHoursWhole).toBe(1)
    expect(report.forgottenSegments).toBe(12)
    // A CONFIRMED-empty directory is the one case that forgets a whole row —
    // `adoptWalkedHour` refuses an empty listing on purpose, so the repair that
    // empties an hour can only be `forgetHour`.
    expect(h.ledger.forgotten).toEqual([keyOfPath(seg(102, HOLE_HOUR, 0))])
    expect(h.ledger.adopted).toEqual([])
  })

  it('forgets NOTHING when the root carries no volume marker — the unplugged-disk shape', async () => {
    const claims = wholeHourClaims([102], [HOLE_HOUR], 12)
    const h = harness({ claims, onDisk: [], anchor: null })

    const report = await h.reconciler.run({ locationId: LOCATION_ID, apply: true })

    expect(report.refused).toBe('anchor-absent')
    expect(report.forgottenSegments).toBe(0)
    expect(h.ledger.claimedSegments()).toBe(12)
    // It never even listed: the precondition is checked before the walk.
    expect(h.listHour).not.toHaveBeenCalled()
  })

  it('forgets NOTHING when the marker read throws — an error is not an absence', async () => {
    const claims = wholeHourClaims([102], [HOLE_HOUR], 12)
    const h = harness({ claims, onDisk: [], anchorThrows: true })
    const report = await h.reconciler.run({ locationId: LOCATION_ID, apply: true })
    expect(report.refused).toBe('anchor-unreadable')
    expect(h.ledger.claimedSegments()).toBe(12)
  })

  it('re-reads the marker before EVERY hour it would forget, and stops when it moves', async () => {
    const hours = [HOLE_HOUR, HOLE_HOUR + HOUR_MS, HOLE_HOUR + 2 * HOUR_MS]
    const claims = wholeHourClaims([102], hours, 6)
    let reads = 0
    const h = harness({
      claims,
      onDisk: [],
      // Start read + first hour agree; the disk moves before the second hour.
      anchor: () => {
        reads += 1
        return reads <= 2 ? VOLUME : 'vol-usb-b'
      },
    })

    const report = await h.reconciler.run({ locationId: LOCATION_ID, apply: true })

    expect(report.refused).toBe('anchor-moved')
    // One hour forgotten, then it stopped — the rest is still accounted for.
    expect(report.forgottenSegments).toBe(6)
    expect(h.ledger.claimedSegments()).toBe(12)
    // Anchor read: once at the start, once per would-forget hour.
    expect(h.anchorOf).toHaveBeenCalledTimes(3)
    // And the anchor is read BEFORE the durable write, never after.
    const firstForget = h.trace.indexOf('forget')
    const anchorBefore = h.trace.lastIndexOf(`anchor:${ROOT}`, firstForget)
    expect(anchorBefore).toBeGreaterThan(-1)
    expect(anchorBefore).toBeLessThan(firstForget)
  })

  it('does not re-read the marker for an hour that has nothing to forget', async () => {
    const claims = wholeHourClaims([102], [HOLE_HOUR, HOLE_HOUR + HOUR_MS], 6)
    const h = harness({ claims, onDisk: claims })
    await h.reconciler.run({ locationId: LOCATION_ID, apply: true })
    expect(h.anchorOf).toHaveBeenCalledTimes(1)
  })

  it('an EMPTY hour directory and an ABSENT one are both ghosts, but only one is `hoursMissing`', async () => {
    const dir = hourDirRelPath(102, 'low', HOLE_HOUR)
    const claims = [
      ...wholeHourClaims([102], [HOLE_HOUR], 4),
      ...wholeHourClaims([102], [HOLE_HOUR + HOUR_MS], 4),
    ]
    const h = harness({ claims, onDisk: [], emptyDirs: [dir] })
    const report = await h.reconciler.run({ locationId: LOCATION_ID, apply: true })
    expect(report.ghostSegments).toBe(8)
    expect(report.ghostHoursWhole).toBe(2)
    expect(report.hoursMissing).toBe(1)
  })
})

describe('ledger walk reconcile — dry run is the default', () => {
  it('reports every ghost and changes NOTHING when nothing armed it', async () => {
    const claims = wholeHourClaims([101, 102], [HOLE_HOUR, HOLE_HOUR + HOUR_MS], 10)
    const survivors = claims.filter((_, i) => i % 2 === 0)
    const h = harness({ claims, onDisk: survivors })

    const report = await h.reconciler.run({ locationId: LOCATION_ID })

    expect(report.applied).toBe(false)
    expect(report.ghostSegments).toBe(20)
    expect(report.ghostBytes).toBeGreaterThan(0)
    expect(report.forgottenSegments).toBe(0)
    expect(report.forgottenBytes).toBe(0)
    // Not one durable write, and not one touch of the resident index.
    expect(h.ledger.adopted).toEqual([])
    expect(h.ledger.forgotten).toEqual([])
    expect(h.applyToIndex).not.toHaveBeenCalled()
    expect(h.ledger.claimedSegments()).toBe(40)
  })

  it('a dry run still checks the anchor, so it cannot report a vanished mount as ghosts', async () => {
    const claims = wholeHourClaims([102], [HOLE_HOUR], 12)
    const h = harness({ claims, onDisk: [], anchor: null })
    const report = await h.reconciler.run({ locationId: LOCATION_ID })
    expect(report.refused).toBe('anchor-absent')
    expect(report.ghostSegments).toBe(0)
  })

  it('the armed run reports the same ghost count the dry run did', async () => {
    const claims = wholeHourClaims([101, 102], [HOLE_HOUR, HOLE_HOUR + HOUR_MS], 10)
    const survivors = claims.filter((_, i) => i % 2 === 0)
    const dry = await harness({ claims, onDisk: survivors }).reconciler.run({
      locationId: LOCATION_ID,
    })
    const armed = await harness({ claims, onDisk: survivors }).reconciler.run({
      locationId: LOCATION_ID,
      apply: true,
    })
    expect(armed.ghostSegments).toBe(dry.ghostSegments)
    expect(armed.ghostBytes).toBe(dry.ghostBytes)
    expect(armed.forgottenSegments).toBe(dry.ghostSegments)
  })
})

describe('ledger walk reconcile — the other direction', () => {
  it('reports an hour holding more than its row accounts for, and never deletes a file', async () => {
    const claims = wholeHourClaims([102], [HOLE_HOUR], 6)
    const strays = [seg(102, HOLE_HOUR, 90), seg(102, HOLE_HOUR, 91)]
    const onDisk = [...claims, ...strays]
    const h = harness({ claims, onDisk })

    const report = await h.reconciler.run({ locationId: LOCATION_ID, apply: true })

    expect(report.orphanFiles).toBe(2)
    // The row names no file, so the pass cannot say WHICH of the eight is the
    // orphan: the sample is a bounded lead drawn from the hour's listing, and
    // the operator goes and looks. It is a lead, not a delete list — nothing
    // here ever removes a file.
    expect(report.orphanSample).toEqual([...onDisk].toSorted())
    expect(report.ghostSegments).toBe(0)
    expect(report.forgottenSegments).toBe(0)
    expect(h.ledger.forgotten).toEqual([])
    // The repair is in the ACCOUNT, not on the disk: the row now accounts for
    // what the directory actually holds.
    expect(h.ledger.claimedSegments()).toBe(8)
    const orphanWarn = h.logger.warn.mock.calls.find(([message]) =>
      String(message).includes('more segments than its durable row accounts for'),
    )
    expect(orphanWarn).toBeDefined()
    expect(orphanWarn?.[1]).toMatchObject({ tags: { deviceId: 102 } })
  })

  it('bounds the orphan sample, and still counts them all', async () => {
    const claims = wholeHourClaims([102], [HOLE_HOUR], 1)
    const strays = Array.from({ length: WALK_ORPHAN_SAMPLE + 25 }, (_, i) =>
      seg(102, HOLE_HOUR, 200 + i),
    )
    const h = harness({ claims, onDisk: [...claims, ...strays] })
    const report = await h.reconciler.run({ locationId: LOCATION_ID })
    expect(report.orphanFiles).toBe(WALK_ORPHAN_SAMPLE + 25)
    expect(report.orphanSample.length).toBe(WALK_ORPHAN_SAMPLE)
  })

  it('ignores non-segment files in an hour directory — they are not orphans', async () => {
    const claims = wholeHourClaims([102], [HOLE_HOUR], 4)
    const dir = hourDirRelPath(102, 'low', HOLE_HOUR)
    const h = harness({ claims, onDisk: claims })
    // The fixture disk cannot hold a non-.m4s name through `onDisk`; inject it.
    h.listHour.mockImplementationOnce(async (_root: string, relDir: string) => {
      await Promise.resolve()
      expect(relDir).toBe(dir)
      return [...claims.map(baseName), 'init.mp4', '.nfs00001'].toSorted()
    })
    const report = await h.reconciler.run({ locationId: LOCATION_ID })
    expect(report.orphanFiles).toBe(0)
    expect(report.ghostSegments).toBe(0)
  })
})

describe('ledger walk reconcile — every refusal is counted, never silent', () => {
  it('skips an hour whose listing FAILED, and forgets nothing from it', async () => {
    // A listing that THREW is not a listing that came back empty: it decides
    // nothing (D49), so the hour is left exactly as it was found.
    const doomed = hourDirRelPath(102, 'low', HOLE_HOUR)
    const claims = wholeHourClaims([102], [HOLE_HOUR, HOLE_HOUR + HOUR_MS], 5)
    const h = harness({
      claims,
      onDisk: [],
      listThrowsFor: (relDir) => relDir === doomed,
    })

    const report = await h.reconciler.run({ locationId: LOCATION_ID, apply: true })

    expect(report.skippedByReason['listing-error']).toBe(1)
    expect(report.hoursSkipped).toBe(1)
    expect(report.forgottenSegments).toBe(5)
    // The failed hour's account stands whole.
    expect(h.ledger.claimedSegments()).toBe(5)
    expect(h.ledger.claimedHours()).toEqual([keyOfPath(seg(102, HOLE_HOUR, 0))])
  })

  it('skips an hour whose directory holds a name that does not parse as a segment', async () => {
    // Since D523 the ledger row names no file, so the only paths in play are the
    // ones the LISTING hands back. A `.m4s` whose name does not parse means this
    // directory is not the shape the walk believes it is reading, and an hour
    // understood in part is repaired from not at all.
    const claims = wholeHourClaims([102], [HOLE_HOUR, HOLE_HOUR + HOUR_MS], 4)
    const doomed = hourDirRelPath(102, 'low', HOLE_HOUR)
    const h = harness({ claims, onDisk: [] })
    h.listHour.mockImplementationOnce(async (_root: string, relDir: string) => {
      await Promise.resolve()
      expect(relDir).toBe(doomed)
      return ['not-a-segment.m4s']
    })

    const report = await h.reconciler.run({ locationId: LOCATION_ID, apply: true })

    expect(report.skippedByReason['path-mismatch']).toBe(1)
    expect(report.forgottenSegments).toBe(4)
    expect(h.ledger.claimedHours()).toEqual([keyOfPath(seg(102, HOLE_HOUR, 0))])
  })

  it('skips an hour whose directory holds a segment stamped in ANOTHER hour', async () => {
    // A name is its own timestamp, so a file filed under 09 but stamped 14 says
    // one of the two is wrong — and folding it into THIS hour's aggregate would
    // make the repair the walk is about to write a lie.
    const claims = wholeHourClaims([102], [HOLE_HOUR, HOLE_HOUR + HOUR_MS], 4)
    const doomed = hourDirRelPath(102, 'low', HOLE_HOUR)
    const foreign = baseName(seg(102, HOLE_HOUR + 5 * HOUR_MS, 0))
    const h = harness({ claims, onDisk: [] })
    h.listHour.mockImplementationOnce(async (_root: string, relDir: string) => {
      await Promise.resolve()
      expect(relDir).toBe(doomed)
      return [foreign]
    })

    const report = await h.reconciler.run({ locationId: LOCATION_ID, apply: true })

    expect(report.skippedByReason['path-mismatch']).toBe(1)
    expect(report.forgottenSegments).toBe(4)
    expect(h.ledger.claimedHours()).toEqual([keyOfPath(seg(102, HOLE_HOUR, 0))])
  })

  it('does not count an adoption the ledger REFUSED for shrinking the row by more than half', async () => {
    // `adoptWalkedHour`'s own guard: a listing that would erase more than
    // HOUR_LISTING_MAX_SHRINK_SHARE of the row is what an unmounted root and a
    // half-deleted bucket both look like, so the row stands — silently. A
    // caller that counted that as done would go on to tell the RESIDENT index
    // rows are gone that the archive still holds. The read-back is what stops
    // it: `durable-refused`, index untouched.
    const claims = wholeHourClaims([102], [HOLE_HOUR], 8)
    const survivors = claims.slice(0, 3)
    expect(8 - survivors.length).toBeGreaterThan(8 * HOUR_LISTING_MAX_SHRINK_SHARE)
    const h = harness({ claims, onDisk: survivors })

    const report = await h.reconciler.run({ locationId: LOCATION_ID, apply: true })

    expect(report.ghostSegments).toBe(5)
    expect(report.forgottenSegments).toBe(0)
    expect(report.skippedByReason['durable-refused']).toBe(1)
    expect(h.applyToIndex).not.toHaveBeenCalled()
    expect(h.ledger.claimedSegments()).toBe(8)
  })

  it('adopts a listing that shrinks the row by no MORE than half', async () => {
    // The other side of the same guard, so the refusal above is pinned as a
    // BOUND and not as "the walk never repairs a partial hour".
    const claims = wholeHourClaims([102], [HOLE_HOUR], 8)
    const survivors = claims.slice(0, 4)
    const h = harness({ claims, onDisk: survivors })

    const report = await h.reconciler.run({ locationId: LOCATION_ID, apply: true })

    expect(report.ghostSegments).toBe(4)
    expect(report.forgottenSegments).toBe(4)
    expect(report.skippedByReason['durable-refused']).toBe(0)
    // The row is repaired, not forgotten: the hour still holds four segments.
    expect(h.ledger.claimedSegments()).toBe(4)
    expect(h.ledger.forgotten).toEqual([])
  })

  it('does not count a durable write it could not READ BACK as landed', async () => {
    // The durable half accepts the call and writes nothing. Nothing in the
    // return value says so, and this pass may not ASSUME: it re-reads the row
    // and finds it unchanged.
    const claims = wholeHourClaims([102], [HOLE_HOUR], 8)
    const h = harness({ claims, onDisk: claims.slice(0, 5) })
    h.ledger.adoptIsSilentNoOp = true

    const report = await h.reconciler.run({ locationId: LOCATION_ID, apply: true })

    expect(report.ghostSegments).toBe(3)
    expect(report.forgottenSegments).toBe(0)
    expect(report.skippedByReason['durable-refused']).toBe(1)
    expect(h.applyToIndex).not.toHaveBeenCalled()
    expect(h.ledger.claimedSegments()).toBe(8)
  })

  it('resets the RESIDENT index to the listing, and only after the durable write', async () => {
    // Without this the account leaves the archive and the RAM index keeps
    // offering a segment nothing can serve until the runner restarts. The ORDER
    // is the invariant (D291/D296) — durable first, RAM second, so a refused
    // durable write leaves `RecordingIndex` untouched.
    const claims = wholeHourClaims([102], [HOLE_HOUR], 6)
    const h = harness({ claims, onDisk: [] })

    await h.reconciler.run({ locationId: LOCATION_ID, apply: true })

    expect(h.applyToIndex).toHaveBeenCalledTimes(1)
    // The hour held nothing, so the index's view of it becomes exactly nothing.
    expect(h.applyToIndex.mock.calls[0]).toEqual([102, LOCATION_ID, HOLE_HOUR, []])
    expect(h.trace.indexOf('forget')).toBeLessThan(h.trace.indexOf('index:0'))
  })

  it('resets the resident index to the surviving names, not to nothing', async () => {
    const claims = wholeHourClaims([102], [HOLE_HOUR], 8)
    const survivors = claims.slice(0, 5)
    const h = harness({ claims, onDisk: survivors })

    await h.reconciler.run({ locationId: LOCATION_ID, apply: true })

    expect(h.applyToIndex.mock.calls[0]).toEqual([
      102,
      LOCATION_ID,
      HOLE_HOUR,
      [...survivors].toSorted(),
    ])
    expect(h.trace.indexOf('adopt:5')).toBeLessThan(h.trace.indexOf('index:5'))
  })

  it('leaves the resident index alone on a DRY run, even though the ghosts are real', async () => {
    const claims = wholeHourClaims([102], [HOLE_HOUR], 6)
    const h = harness({ claims, onDisk: [] })
    const report = await h.reconciler.run({ locationId: LOCATION_ID })
    expect(report.ghostSegments).toBe(6)
    expect(h.applyToIndex).not.toHaveBeenCalled()
  })

  it('never touches the live tail', async () => {
    const liveHour = hourStartMs(NOW)
    const claims = [
      ...wholeHourClaims([102], [liveHour], 4),
      ...wholeHourClaims([102], [liveHour - HOUR_MS], 4),
      ...wholeHourClaims([102], [HOLE_HOUR], 4),
    ]
    const h = harness({ claims, onDisk: [] })

    const report = await h.reconciler.run({ locationId: LOCATION_ID, apply: true })

    expect(report.skippedByReason['live-tail']).toBe(2)
    expect(report.listings).toBe(1)
    expect(report.forgottenSegments).toBe(4)
    expect(h.ledger.claimedSegments()).toBe(8)
  })

  it('stops at its hour bound and says so, leaving the rest for the next run', async () => {
    const hours = Array.from({ length: 10 }, (_, i) => HOLE_HOUR + i * HOUR_MS)
    const claims = wholeHourClaims([102], hours, 3)
    const h = harness({ claims, onDisk: [], maxHours: 4 })

    const report = await h.reconciler.run({ locationId: LOCATION_ID, apply: true })

    expect(report.bounded).toBe(true)
    expect(report.hoursClaimed).toBe(4)
    expect(report.listings).toBe(4)
    expect(report.forgottenSegments).toBe(12)
    // Resumable by construction: what it forgot is no longer claimed.
    expect(h.ledger.claimedSegments()).toBe(18)
  })
})

describe('ledger walk reconcile — it reports per camera', () => {
  it('attributes ghosts, orphans and listings to the camera that owns them', async () => {
    // Counts, not names: an hour can be short OR long against its row, and the
    // two directions belong to different cameras here so each is legible.
    const claims = [
      ...wholeHourClaims([101], [HOLE_HOUR], 10),
      ...wholeHourClaims([102], [HOLE_HOUR], 10),
    ]
    const onDisk = [
      ...wholeHourClaims([101], [HOLE_HOUR], 10),
      seg(101, HOLE_HOUR, 80),
      seg(101, HOLE_HOUR, 81),
      ...wholeHourClaims([102], [HOLE_HOUR], 6),
    ]
    const h = harness({ claims, onDisk })

    const report = await h.reconciler.run({ locationId: LOCATION_ID })

    expect(report.byDevice).toEqual([
      {
        deviceId: 101,
        hoursWalked: 1,
        hoursMissing: 0,
        ghostSegments: 0,
        ghostBytes: 0,
        forgottenSegments: 0,
        orphanFiles: 2,
      },
      {
        deviceId: 102,
        hoursWalked: 1,
        hoursMissing: 0,
        ghostSegments: 4,
        ghostBytes: expect.any(Number) as number,
        forgottenSegments: 0,
        orphanFiles: 0,
      },
    ])
  })

  it('every device-scoped line carries tags.deviceId', async () => {
    const claims = wholeHourClaims([102], [HOLE_HOUR], 6)
    const h = harness({ claims, onDisk: [] })
    await h.reconciler.run({ locationId: LOCATION_ID, apply: true })
    const deviceLines = [...h.logger.warn.mock.calls, ...h.logger.info.mock.calls].filter(
      ([, ctx]) => (ctx as { meta?: { profile?: string } })?.meta?.profile !== undefined,
    )
    expect(deviceLines.length).toBeGreaterThan(0)
    for (const [, ctx] of deviceLines) {
      expect(ctx).toMatchObject({ tags: { deviceId: 102 } })
    }
    const summary = h.logger.info.mock.calls.find(([message]) =>
      String(message).includes('camera summary'),
    )
    expect(summary?.[1]).toMatchObject({ tags: { deviceId: 102 } })
  })

  it('says out loud that an hour row accounts for what the directory does not hold', async () => {
    const claims = wholeHourClaims([102], [HOLE_HOUR], 6)
    const h = harness({ claims, onDisk: [] })
    await h.reconciler.run({ locationId: LOCATION_ID })
    const line = h.logger.warn.mock.calls.find(([message]) =>
      String(message).includes('the directory does not hold'),
    )
    expect(line).toBeDefined()
    expect(line?.[1]).toMatchObject({
      tags: { deviceId: 102 },
      meta: { accounted: 6, listed: 0, ghosts: 6, wholeHour: true, apply: false },
    })
  })
})

describe('ledger walk reconcile — the walk is scoped, never a blind tree walk', () => {
  it('lists only hours the LEDGER accounts for, and only for the requested device', async () => {
    const claims = [
      ...wholeHourClaims([101], [HOLE_HOUR], 4),
      ...wholeHourClaims([102], [HOLE_HOUR, HOLE_HOUR + HOUR_MS], 4),
    ]
    const h = harness({ claims, onDisk: claims })

    const report = await h.reconciler.run({ locationId: LOCATION_ID, deviceId: 102 })

    expect(report.listings).toBe(2)
    expect(h.listed).toEqual([
      `${ROOT}|${hourDirRelPath(102, 'low', HOLE_HOUR)}`,
      `${ROOT}|${hourDirRelPath(102, 'low', HOLE_HOUR + HOUR_MS)}`,
    ])
  })

  it('takes its claim set from the RAM snapshot, never from a paged archive query', async () => {
    // Since D523 an hour row is ten scalars, so the whole claim set is already
    // in RAM. That is not only cheaper — the pass MUTATES what it walks, which
    // is exactly the shape that makes an `offset`-paged read skip half a scope
    // once rows start disappearing under it. A snapshot taken once cannot skip.
    const hours = Array.from({ length: 9 }, (_, i) => HOLE_HOUR + i * HOUR_MS)
    const claims = wholeHourClaims([102], hours, 3)
    const h = harness({ claims, onDisk: [] })

    const report = await h.reconciler.run({ locationId: LOCATION_ID, apply: true })

    expect(h.streamSegments).not.toHaveBeenCalled()
    expect(report.hoursClaimed).toBe(9)
    expect(report.listings).toBe(9)
    // Every hour was reached even though each one was forgotten as it went.
    expect(report.forgottenSegments).toBe(27)
    expect(h.ledger.claimedHours()).toEqual([])
  })
})

/** A tiny helper so the shape assertions above read as one thing. */
export type { LedgerWalkReport }
