import { describe, expect, it } from 'vitest'
import { RecordingIndex } from '../recording-index.js'
import { parseSegmentPath, segmentRelPath } from '../segment-path.js'
import type { SegmentRow } from '../types.js'

const path = (startMs: number, bytes: number, profile = 'high'): string =>
  segmentRelPath(99, profile, startMs, 2000, bytes)
const row = (
  startMs: number,
  bytes: number,
  profile = 'high',
  locationId = 'recordings',
): SegmentRow => ({
  deviceId: 99,
  profile,
  startMs,
  durMs: 2000,
  bytes,
  path: path(startMs, bytes, profile),
  locationId,
})

describe('RecordingIndex (in-memory, from storage.list)', () => {
  it('hydrateDevice parses storage.list paths into rows; accounting sums bytes', () => {
    const idx = new RecordingIndex()
    idx.hydrateDevice(99, 'recordings', [
      path(1000, 100),
      path(3000, 200),
      'junk',
      '99/high/live.m3u8',
    ])
    expect(idx.accounting(99)).toEqual({ bytes: 300, count: 2, oldestMs: 1000, newestMs: 3000 })
  })

  it('addSegment is write-through and idempotent on path', () => {
    const idx = new RecordingIndex()
    idx.addSegment(row(1000, 100))
    idx.addSegment(row(1000, 100)) // same path
    expect(idx.accounting(99).count).toBe(1)
  })

  it('hydrateDevice replaces the device set for the given location (storage.list = truth for that location)', () => {
    const idx = new RecordingIndex()
    idx.addSegment(row(1000, 999)) // stale, on 'recordings'
    idx.hydrateDevice(99, 'recordings', [path(5000, 50), path(7000, 70)])
    expect(idx.accounting(99)).toEqual({ bytes: 120, count: 2, oldestMs: 5000, newestMs: 7000 })
  })

  it('ranges merges adjacent segments within tolerance', () => {
    const idx = new RecordingIndex()
    idx.addSegment(row(1000, 10))
    idx.addSegment(row(3000, 10))
    idx.addSegment(row(20000, 10))
    expect(idx.ranges(99, 'high', 0, 1_000_000, 500)).toEqual([
      { startMs: 1000, endMs: 5000 },
      { startMs: 20000, endMs: 22000 },
    ])
  })

  it('removeSegments deletes rows by path (used by evict)', () => {
    const idx = new RecordingIndex()
    const a = row(1000, 100)
    idx.addSegment(a)
    idx.addSegment(row(3000, 200))
    idx.removeSegments([a.path])
    expect(idx.accounting(99)).toEqual({ bytes: 200, count: 1, oldestMs: 3000, newestMs: 3000 })
  })

  it('segments(deviceId) returns rows sorted by start; accounting empty for unknown camera', () => {
    const idx = new RecordingIndex()
    idx.addSegment(row(3000, 1))
    idx.addSegment(row(1000, 1))
    expect(idx.segments(99).map((s) => s.startMs)).toEqual([1000, 3000])
    expect(idx.accounting(1234)).toEqual({ bytes: 0, count: 0, oldestMs: null, newestMs: null })
  })

  it('segmentsStartingIn slices one hour without the rest of the archive', () => {
    const idx = new RecordingIndex()
    const hour = 3_600_000
    idx.addSegment(row(1_000, 1))
    idx.addSegment(row(hour + 1_000, 1))
    idx.addSegment(row(2 * hour + 1_000, 1))
    expect(idx.segmentsStartingIn(99, 'high', hour, 2 * hour).map((s) => s.startMs)).toEqual([
      hour + 1_000,
    ])
  })

  it('invalidates sorted snapshots after finalize and eviction mutations', () => {
    const idx = new RecordingIndex()
    const later = row(3000, 1)
    idx.addSegment(later)
    expect(idx.segments(99).map((s) => s.startMs)).toEqual([3000])

    const earlier = row(1000, 1)
    idx.addSegment(earlier)
    expect(idx.segments(99).map((s) => s.startMs)).toEqual([1000, 3000])
    expect(idx.segmentAt(99, 'high', 1500)?.startMs).toBe(1000)

    idx.removeSegments([earlier.path])
    expect(idx.segments(99).map((s) => s.startMs)).toEqual([3000])
    expect(idx.segmentAt(99, 'high', 1500)).toBeNull()
  })

  it('ranges are clamped to the requested [fromMs,toMs] window', () => {
    const idx = new RecordingIndex()
    idx.addSegment(row(500, 10)) // starts before window, dur 2000 -> ends 2500
    idx.addSegment(row(9000, 10)) // ends 11000, after window end
    expect(idx.ranges(99, 'high', 1000, 10000, 500)).toEqual([
      { startMs: 1000, endMs: 2500 },
      { startMs: 9000, endMs: 10000 },
    ])
  })
})

describe('RecordingIndex — location awareness', () => {
  /** Per-location BYTES, from the rows the index holds.
   *
   *  Deliberately computed here rather than asked of the index:
   *  `accountingForLocation` was removed because answering a location-keyed
   *  question from a device-keyed map is a walk over the whole archive, and the
   *  archive total now comes from the durable hour ledger's SQL aggregate. What
   *  these tests still pin is the index's LOCATION SCOPING — which rows a
   *  hydrate replaces and which it must leave alone. */
  const bytesOn = (idx: RecordingIndex, locationId: string): number =>
    idx.segmentsOnLocation(locationId).reduce((sum, s) => sum + s.bytes, 0)

  it('scoped replace preserves other locations', () => {
    const idx = new RecordingIndex()
    idx.hydrateDevice(99, 'recordings', [path(1000, 100, 'high')])
    idx.hydrateDevice(99, 'recordingsLow', [path(2000, 50, 'low')])
    idx.hydrateDevice(99, 'recordings', [path(5000, 300, 'high')]) // re-hydrate one location only
    expect(bytesOn(idx, 'recordings')).toBe(300)
    expect(bytesOn(idx, 'recordingsLow')).toBe(50)
    expect(idx.accounting(99).bytes).toBe(350)
  })

  it('segmentsOnLocation across devices, oldest-first', () => {
    const idx = new RecordingIndex()
    idx.hydrateDevice(99, 'recordings', [path(3000, 100, 'high')])
    idx.hydrateDevice(7, 'recordings', [segmentRelPath(7, 'high', 1000, 2000, 200)])
    expect(idx.segmentsOnLocation('recordings').map((s) => s.startMs)).toEqual([1000, 3000])
  })

  it('unknown location → no rows', () => {
    const idx = new RecordingIndex()
    idx.hydrateDevice(99, 'recordings', [path(1000, 100, 'high')])
    expect(idx.segmentsOnLocation('nope')).toEqual([])
  })

  it('addSegment write-through is visible per-location and survives re-hydration of a DIFFERENT location', () => {
    const idx = new RecordingIndex()
    // Steady state: a low-profile segment streamed in via addSegment on 'recordingsLow'.
    idx.addSegment(row(2000, 50, 'low', 'recordingsLow'))
    expect(idx.segmentsOnLocation('recordingsLow').map((s) => s.startMs)).toEqual([2000])
    expect(bytesOn(idx, 'recordingsLow')).toBe(50)
    // A periodic storage.list re-hydrate of the OTHER location must not touch the addSegment'd row.
    idx.hydrateDevice(99, 'recordings', [path(5000, 300, 'high')])
    expect(bytesOn(idx, 'recordingsLow')).toBe(50)
    expect(bytesOn(idx, 'recordings')).toBe(300)
  })
})

function seed(): RecordingIndex {
  const idx = new RecordingIndex()
  idx.addSegment({
    deviceId: 99,
    profile: 'mid',
    startMs: 1000,
    durMs: 4000,
    bytes: 100,
    path: '99/mid/x/1000-4000-100.m4s',
    locationId: 'L1',
  })
  idx.addSegment({
    deviceId: 99,
    profile: 'mid',
    startMs: 5000,
    durMs: 4000,
    bytes: 100,
    path: '99/mid/x/5000-4000-100.m4s',
    locationId: 'L1',
  })
  idx.addSegment({
    deviceId: 99,
    profile: 'mid',
    startMs: 20000,
    durMs: 4000,
    bytes: 100,
    path: '99/mid/x/20000-4000-100.m4s',
    locationId: 'L1',
  })
  return idx
}

describe('RecordingIndex.segmentAt', () => {
  it('returns the segment containing the epoch', () => {
    expect(seed().segmentAt(99, 'mid', 6000)?.startMs).toBe(5000)
  })
  it('returns null when epoch falls in a gap', () => {
    expect(seed().segmentAt(99, 'mid', 12000)).toBeNull()
  })
  it('returns null for an unknown device/profile', () => {
    expect(seed().segmentAt(99, 'low', 6000)).toBeNull()
  })
})

describe('RecordingIndex.nearestCoveredEdge', () => {
  it('snaps a gap epoch to the start of the next covered segment', () => {
    expect(seed().nearestCoveredEdge(99, 'mid', 12000)).toBe(20000)
  })
  it('returns the epoch unchanged when already covered', () => {
    expect(seed().nearestCoveredEdge(99, 'mid', 6000)).toBe(6000)
  })
  it('returns null when there is no footage at all', () => {
    expect(new RecordingIndex().nearestCoveredEdge(99, 'mid', 6000)).toBeNull()
  })
  it('returns null when the epoch is past all footage (forward-only, no backward snap)', () => {
    expect(seed().nearestCoveredEdge(99, 'mid', 999999)).toBeNull()
  })
})

describe('RecordingIndex.coveredEdgeBefore', () => {
  it('returns the end of the last footage before a gap epoch (crack hop)', () => {
    // Gap [9000, 20000): the nearest footage behind ends at 9000.
    expect(seed().coveredEdgeBefore(99, 'mid', 12000)).toBe(9000)
  })
  it('returns the end of ALL footage for an epoch past the recording', () => {
    expect(seed().coveredEdgeBefore(99, 'mid', 999999)).toBe(24000)
  })
  it('returns null when nothing ends at or before the epoch', () => {
    expect(seed().coveredEdgeBefore(99, 'mid', 500)).toBeNull()
  })
  it('returns null when there is no footage at all', () => {
    expect(new RecordingIndex().coveredEdgeBefore(99, 'mid', 6000)).toBeNull()
  })
})

describe('RecordingIndex — knowing what it has NOT looked at', () => {
  /**
   * The index is hydrated by walking the archive, and that walk takes MINUTES
   * (>1M files). Until it finishes, an empty answer for a window is
   * indistinguishable from "this camera has no footage then" — so the server
   * reports no footage, the timeline draws a gap, and the operator concludes
   * their recordings are gone. Measured after a deploy: a camera-day held 7
   * segments and grew by 2 per 20 s, the rate of NEW writes, not of the archive.
   *
   * The index must therefore be able to say "I have not looked yet", per HOUR —
   * the granularity the path convention already gives us.
   */
  const HOUR = 3_600_000
  const at = (hourMs: number): SegmentRow => ({
    deviceId: 1,
    profile: 'low',
    startMs: hourMs,
    durMs: 8000,
    bytes: 50_000,
    path: `1/low/2026/07/29/00/${hourMs}-8000-50000.m4s`,
    locationId: 'loc-a',
  })

  it('reports a window as UNKNOWN before anything hydrated it', () => {
    const idx = new RecordingIndex()
    expect(idx.hydrationOf(1, 0, HOUR)).toBe('unknown')
  })

  it('reports a hydrated but empty hour as KNOWN-EMPTY, not unknown', () => {
    // This is the distinction the whole phase exists for: an hour we walked and
    // found nothing in is a real gap; an hour we never walked is not.
    const idx = new RecordingIndex()
    idx.markHydrated(1, 0, HOUR)
    expect(idx.hydrationOf(1, 0, HOUR)).toBe('hydrated')
    expect(idx.segments(1)).toHaveLength(0)
  })

  it('reports PARTIAL when only some hours of the window were walked', () => {
    const idx = new RecordingIndex()
    idx.markHydrated(1, 0, HOUR)
    expect(idx.hydrationOf(1, 0, 3 * HOUR)).toBe('partial')
  })

  it('adds rows for one hour without dropping other hours', () => {
    // Window hydration must MERGE. `hydrateDevice` replaces a whole location,
    // which is right for the full walk and catastrophic for an incremental one:
    // hydrating hour 5 would erase hours 0–4.
    const idx = new RecordingIndex()
    idx.addSegment(at(0))
    idx.hydrateHour(1, 'loc-a', 5 * HOUR, [at(5 * HOUR).path])
    expect(idx.segments(1).map((s) => s.startMs)).toEqual([0, 5 * HOUR])
  })

  // `markHydratedAll` was deleted on 2026-09-17 (D524): it had no production
  // caller, and a BOUNDED index can never truthfully claim a whole device. The
  // honest claim is per hour, and it is the one every reader gates on.
  it('a span is hydrated only for the hours somebody actually walked', () => {
    const idx = new RecordingIndex()
    idx.hydrateDevice(1, 'loc-a', [at(0).path])
    expect(idx.hydrationOf(1, 0, 24 * HOUR)).toBe('unknown')
    for (let h = 0; h < 24; h++) idx.markHydrated(1, h * HOUR, (h + 1) * HOUR)
    expect(idx.hydrationOf(1, 0, 24 * HOUR)).toBe('hydrated')
  })
})

describe('RecordingIndex bucket census (D160)', () => {
  const seg = (deviceId: number, profile: string, startMs: number): string =>
    segmentRelPath(deviceId, profile, startMs, 10_000, 1000)

  const rowOf = (deviceId: number, profile: string, startMs: number): SegmentRow => ({
    deviceId,
    profile,
    startMs,
    durMs: 10_000,
    bytes: 1000,
    path: seg(deviceId, profile, startMs),
    locationId: 'loc-a',
  })

  it('hasSegment answers per device without copying the archive', () => {
    const index = new RecordingIndex()
    const r = rowOf(7, 'low', Date.UTC(2026, 7, 14, 9))
    index.addSegment(r)
    expect(index.hasSegment(7, r.path)).toBe(true)
    expect(index.hasSegment(8, r.path)).toBe(false)
    index.removeSegments([r.path])
    expect(index.hasSegment(7, r.path)).toBe(false)
  })
})

/**
 * Finalize-time churn (2026-08-18). The sorted view used to be INVALIDATED on
 * every `addSegment` and rebuilt with a full `[...m.values()]` copy + sort on
 * the next read. At 34 profile-writers on 10s segments that is ~3.4 full
 * copy-and-sorts of a 138k-row device index per second, forever — measured on
 * the live recorder as 458MB of `large_object_space` churn and a 2.1GB RSS at
 * 191s of uptime. Rows arrive in roughly ascending start order, so a finalize
 * must be an ORDERED INSERT into the live views instead, and the sorted-view
 * CONTRACT must be indistinguishable from a fresh rebuild.
 */
describe('RecordingIndex — finalize inserts incrementally, never copy-and-sort', () => {
  const mk = (
    deviceId: number,
    profile: string,
    startMs: number,
    locationId = 'loc-a',
  ): SegmentRow => ({
    deviceId,
    profile,
    startMs,
    durMs: 10_000,
    bytes: 1000,
    path: segmentRelPath(deviceId, profile, startMs, 10_000, 1000),
    locationId,
  })

  it('a finalize on a WARM view is an insert, not a rebuild', () => {
    const idx = new RecordingIndex()
    for (let i = 0; i < 100; i++) idx.addSegment(mk(5, 'high', 1_000_000 + i * 10_000))
    // Warm both view keys interactive callers use: all-profiles and per-profile.
    expect(idx.segments(5)).toHaveLength(100)
    expect(idx.segments(5, 'high')).toHaveLength(100)
    const warm = idx.sortedViewStats()

    // The steady state: finalized segments streaming in while playback reads.
    for (let i = 100; i < 200; i++) {
      idx.addSegment(mk(5, 'high', 1_000_000 + i * 10_000))
      expect(idx.segmentAt(5, 'high', 1_000_000 + i * 10_000 + 500)?.startMs).toBe(
        1_000_000 + i * 10_000,
      )
    }
    const after = idx.sortedViewStats()
    // Not ONE full rebuild was paid for 100 finalizes with interleaved reads.
    expect(after.fullRebuilds).toBe(warm.fullRebuilds)
    expect(after.incrementalInserts).toBeGreaterThanOrEqual(100)
    // And the view is still exactly the sorted archive.
    expect(idx.segments(5, 'high')).toHaveLength(200)
    expect(idx.segments(5, 'high').map((s) => s.startMs)).toEqual(
      idx
        .segments(5, 'high')
        .map((s) => s.startMs)
        .toSorted((a, b) => a - b),
    )
  })

  it('out-of-order and duplicate-start arrivals keep the view identical to a fresh rebuild', () => {
    // Rows arrive ROUGHLY ascending — a writer restart or a staging recovery
    // interleaves older rows. Randomized equivalence: every public read on the
    // incrementally-maintained index must equal the same read on a fresh index
    // built from scratch (which always full-sorts).
    let lcgState = 42
    const rand = (): number => {
      // Deterministic LCG so a failure reproduces.
      lcgState = (lcgState * 1103515245 + 12345) % 2147483648
      return lcgState / 2147483648
    }
    const idx = new RecordingIndex()
    const rows: SegmentRow[] = []
    const profiles = ['high', 'low']
    let clock = 1_000_000
    for (let i = 0; i < 400; i++) {
      clock += Math.floor(rand() * 20_000)
      const jitterBack = rand() < 0.15 ? Math.floor(rand() * 120_000) : 0
      const r = mk(9, profiles[Math.floor(rand() * profiles.length)]!, clock - jitterBack)
      rows.push(r)
      idx.addSegment(r)
      if (rand() < 0.3) {
        // Interleaved reads keep the views warm so inserts hit live arrays.
        idx.segmentAt(9, 'high', clock - Math.floor(rand() * 50_000))
        idx.nearestCoveredEdge(9, 'low', clock - Math.floor(rand() * 50_000))
      }
      if (rand() < 0.05 && rows.length > 10) {
        const victim = rows.splice(Math.floor(rand() * rows.length), 1)[0]!
        idx.removeSegments([victim.path])
      }
    }
    const fresh = new RecordingIndex()
    for (const r of rows) fresh.addSegment(r)

    for (const profile of [...profiles, undefined]) {
      expect(idx.segments(9, profile)).toEqual(fresh.segments(9, profile))
    }
    for (let probe = 1_000_000; probe < clock + 30_000; probe += 7_777) {
      expect(idx.segmentAt(9, 'high', probe)).toEqual(fresh.segmentAt(9, 'high', probe))
      expect(idx.nearestCoveredEdge(9, 'low', probe)).toBe(
        fresh.nearestCoveredEdge(9, 'low', probe),
      )
      expect(idx.coveredEdgeBefore(9, 'high', probe)).toBe(
        fresh.coveredEdgeBefore(9, 'high', probe),
      )
    }
    expect(idx.ranges(9, 'high', 1_000_000, clock, 500)).toEqual(
      fresh.ranges(9, 'high', 1_000_000, clock, 500),
    )
  })

  it('re-announcing an existing path (idempotent finalize) never duplicates a row in the view', () => {
    const idx = new RecordingIndex()
    const r = mk(5, 'high', 1_000_000)
    idx.addSegment(r)
    expect(idx.segments(5, 'high')).toHaveLength(1) // warm the view
    idx.addSegment(r) // the watcher replays an entry after a playlist reset
    expect(idx.segments(5, 'high')).toHaveLength(1)
    // Same path re-announced on a DIFFERENT location (relocate edge): the view
    // must serve the new row, not the stale one.
    const moved: SegmentRow = { ...r, locationId: 'loc-b' }
    idx.addSegment(moved)
    expect(idx.segments(5, 'high')).toHaveLength(1)
    expect(idx.segments(5, 'high')[0]?.locationId).toBe('loc-b')
  })

  it('MEASURED: streaming finalizes cost orders of magnitude less than rebuild-per-finalize', () => {
    // The claim item 2 makes is a performance claim, so it is measured, not
    // asserted. Base archive ~20k rows; 200 finalizes with an interleaved read
    // each (the scrub/locate pattern that re-materialised the cache every time).
    const BASE = 20_000
    const ADDS = 200
    const base: SegmentRow[] = []
    for (let i = 0; i < BASE; i++) base.push(mk(3, 'high', 1_000_000 + i * 10_000))

    const idx = new RecordingIndex()
    for (const r of base) idx.addSegment(r)
    expect(idx.segments(3, 'high')).toHaveLength(BASE) // warm

    const t0 = performance.now()
    for (let i = 0; i < ADDS; i++) {
      idx.addSegment(mk(3, 'high', 1_000_000 + (BASE + i) * 10_000))
      idx.segmentAt(3, 'high', 1_000_000 + (BASE + i) * 10_000 + 500)
    }
    const incrementalMs = performance.now() - t0

    // The removed behaviour, reproduced verbatim: every finalize invalidates,
    // every read pays [...values] copy + filter + toSorted over the archive.
    const m = new Map<string, SegmentRow>()
    for (const r of base) m.set(r.path, r)
    const t1 = performance.now()
    for (let i = 0; i < ADDS; i++) {
      const r = mk(3, 'high', 1_000_000 + (BASE + i) * 10_000)
      m.set(r.path, r)
      const sorted = [...m.values()]
        .filter((s) => s.profile === 'high')
        .toSorted((a, b) => a.startMs - b.startMs)
      if (sorted.length === 0) throw new Error('unreachable')
    }
    const rebuildMs = performance.now() - t1

    // Measured on 2026-08-18 (Apple Silicon dev machine): incremental=0.3ms
    // vs rebuild-per-finalize=118.4ms — ~400x. The 5x bound below is the
    // deliberately loose CI floor for an asymptotic difference.
    expect(
      incrementalMs * 5,
      `incremental=${incrementalMs.toFixed(1)}ms rebuild-per-finalize=${rebuildMs.toFixed(1)}ms over ${ADDS} finalizes on a ${BASE}-row archive`,
    ).toBeLessThan(rebuildMs)
  })
})

/**
 * The archive walk re-indexes rows the index ALREADY holds, and it builds a
 * fresh path string for every file it sees (`roots.ts` composes
 * `${deviceId}/${entry}` per `readdir` entry). Those strings are byte-identical
 * to the ones already indexed — but they are different objects, and the
 * segment-hour ledger's mirror still holds the originals: `reconcileFromIndex`
 * skips its `ledger.put` precisely when the contents match. So after the first
 * walk EVERY path in the archive is retained twice, permanently.
 *
 * Measured on the production shape (26 cameras x 2 profiles x 12 days of 10 s
 * segments = 5.39 M rows): 1218 MB before the walk, 1591 MB after — +373 MB,
 * 69 B/row, which is exactly one extra `SeqOneByteString` per segment.
 *
 * The invariant that prevents it: re-hydrating a row the index already holds at
 * the same location REUSES the held row object. Reusing the row reuses its
 * `path` string (and a `Map.set` on an equal key keeps the original key), so
 * the walk's copy becomes garbage instead of a second permanent retention.
 */
describe('RecordingIndex — a re-walk must not re-allocate what it already holds', () => {
  it('hydrateDevice reuses the held row when the walk re-reports an identical path', () => {
    const idx = new RecordingIndex()
    idx.hydrateDevice(99, 'recordings', [path(1000, 100), path(3000, 200)])
    const before = idx.segments(99)

    // The walk's strings: same bytes, freshly built, exactly like roots.ts.
    const rewalked = [path(1000, 100), path(3000, 200)].map((p) => p.split('').join(''))
    idx.hydrateDevice(99, 'recordings', rewalked)

    const after = idx.segments(99)
    expect(after).toHaveLength(2)
    expect(after[0]).toBe(before[0])
    expect(after[1]).toBe(before[1])
  })

  it('hydrateHour reuses the held row when the walk re-reports an identical path', () => {
    const idx = new RecordingIndex()
    idx.hydrateHour(99, 'recordings', 0, [path(1000, 100)])
    const before = idx.segments(99)[0]
    idx.hydrateHour(99, 'recordings', 0, [path(1000, 100).split('').join('')])
    expect(idx.segments(99)[0]).toBe(before)
  })

  it('still replaces a row whose location changed, and still drops what the walk no longer sees', () => {
    const idx = new RecordingIndex()
    idx.hydrateDevice(99, 'recordings', [path(1000, 100), path(3000, 200)])
    // relocated: same path, different location -> a NEW row, not the held one
    const held = idx.segments(99)[0]
    idx.hydrateDevice(99, 'recordings-nas', [path(1000, 100)])
    idx.hydrateDevice(99, 'recordings', [path(3000, 200)])
    const rows = idx.segments(99)
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.startMs === 1000)?.locationId).toBe('recordings-nas')
    expect(rows.find((r) => r.startMs === 1000)).not.toBe(held)
    expect(rows.find((r) => r.startMs === 3000)?.locationId).toBe('recordings')
  })

  it('hydrateDevice on a location still leaves other locations alone', () => {
    const idx = new RecordingIndex()
    idx.hydrateDevice(99, 'a', [path(1000, 100)])
    idx.hydrateDevice(99, 'b', [path(3000, 200)])
    idx.hydrateDevice(99, 'a', [path(5000, 300)])
    expect(idx.segments(99).map((r) => r.startMs)).toEqual([3000, 5000])
  })
})

/**
 * `parseSegmentPath` hands back a SHARED profile string for the three names the
 * recorder writes, because the regex group is otherwise a fresh string per
 * segment held for the segment's whole life (80.7 MB / 3.53 M rows — see
 * `segment-path.ts`). The risk that buys is renaming: the property that keeps
 * it safe is that anything outside the canonical set passes through untouched.
 */
describe('parseSegmentPath — a shared profile name must never become a renamed one', () => {
  it('round-trips the canonical profiles', () => {
    for (const profile of ['high', 'mid', 'low']) {
      const parsed = parseSegmentPath(segmentRelPath(7, profile, 1000, 2000, 30))
      expect(parsed?.profile).toBe(profile)
    }
  })

  it('passes an unrecognised profile through verbatim', () => {
    for (const profile of ['HIGH', 'high2', 'thumb', 'hig', 'highest']) {
      const parsed = parseSegmentPath(segmentRelPath(7, profile, 1000, 2000, 30))
      expect(parsed?.profile).toBe(profile)
    }
  })

  it('indexes an unrecognised profile as its own profile, not as a canonical one', () => {
    const idx = new RecordingIndex()
    idx.hydrateDevice(99, 'recordings', [
      segmentRelPath(99, 'high', 1000, 2000, 10),
      segmentRelPath(99, 'highest', 3000, 2000, 20),
    ])
    expect(idx.segments(99, 'high').map((r) => r.startMs)).toEqual([1000])
    expect(idx.segments(99, 'highest').map((r) => r.startMs)).toEqual([3000])
  })
})

/**
 * `resetHour` — make ONE hour of ONE location exactly the listing (D523).
 *
 * `hydrateHour` merges, which is right for a reader whose listing of a live
 * hour is a lower bound: dropping on it would delete the index of footage the
 * `readdir` merely raced. The two operator-armed passes that hold TRUSTED
 * evidence need the other direction — `ledger-walk-reconcile` under its volume
 * anchor, and `location-discard-job` after the operator's own wipe — and they
 * get a NAMED method rather than a flag on the merging one.
 *
 * These cases run against the real index because both callers reach it through
 * a one-line wiring closure and hand it a spy in their own suites; without this
 * file the drop half of `resetHour` is exercised by nothing at all, which a
 * sabotage found.
 */
describe('RecordingIndex.resetHour — the directory is the authority for one hour', () => {
  const HOUR = 3_600_000
  const HOUR2 = 2 * HOUR
  const rel = (deviceId: number, profile: string, startMs: number, bytes: number): string =>
    segmentRelPath(deviceId, profile, startMs, 10_000, bytes)

  it('drops the rows the listing does not name, and keeps the ones it does', () => {
    const idx = new RecordingIndex()
    const kept = rel(7, 'high', HOUR, 10)
    const gone = rel(7, 'high', HOUR + 10_000, 20)
    idx.hydrateHour(7, 'recordings', HOUR, [kept, gone])
    expect(idx.segments(7)).toHaveLength(2)

    const dropped = idx.resetHour(7, 'recordings', HOUR, [kept])

    expect(dropped).toEqual([gone])
    expect(idx.segments(7).map((r) => r.path)).toEqual([kept])
  })

  it('adds what the listing names and the index never held', () => {
    const idx = new RecordingIndex()
    const held = rel(7, 'high', HOUR, 10)
    const fresh = rel(7, 'high', HOUR + 10_000, 20)
    idx.hydrateHour(7, 'recordings', HOUR, [held])

    expect(idx.resetHour(7, 'recordings', HOUR, [held, fresh])).toEqual([])
    expect(
      idx
        .segments(7)
        .map((r) => r.path)
        .toSorted(),
    ).toEqual([held, fresh].toSorted())
  })

  it('empties the hour when the listing is empty — the discard and the ghost forget', () => {
    const idx = new RecordingIndex()
    const one = rel(7, 'high', HOUR, 10)
    const two = rel(7, 'high', HOUR + 10_000, 20)
    idx.hydrateHour(7, 'recordings', HOUR, [one, two])

    expect(idx.resetHour(7, 'recordings', HOUR, []).toSorted()).toEqual([one, two].toSorted())
    expect(idx.segments(7)).toEqual([])
  })

  it('touches no OTHER hour, no other location and no other camera', () => {
    const idx = new RecordingIndex()
    const target = rel(7, 'high', HOUR, 10)
    const nextHour = rel(7, 'high', HOUR2, 11)
    const otherLocation = rel(7, 'low', HOUR + 20_000, 12)
    const otherDevice = rel(8, 'high', HOUR + 30_000, 13)
    idx.hydrateHour(7, 'recordings', HOUR, [target])
    idx.hydrateHour(7, 'recordings', HOUR2, [nextHour])
    idx.hydrateHour(7, 'recordingsLow', HOUR, [otherLocation])
    idx.hydrateHour(8, 'recordings', HOUR, [otherDevice])

    expect(idx.resetHour(7, 'recordings', HOUR, [])).toEqual([target])

    expect(
      idx
        .segments(7)
        .map((r) => r.path)
        .toSorted(),
    ).toEqual([nextHour, otherLocation].toSorted())
    expect(idx.segments(8).map((r) => r.path)).toEqual([otherDevice])
  })

  it('marks the hour walked, exactly as a merging hydrate does', () => {
    const idx = new RecordingIndex()
    expect(idx.hydrationOf(7, HOUR, HOUR + HOUR)).toBe('unknown')
    idx.resetHour(7, 'recordings', HOUR, [])
    // We LOOKED. An hour read and found empty is a known gap, not an unknown
    // one — the same claim `markHydrated` makes for a span with no directory.
    expect(idx.hydrationOf(7, HOUR, HOUR + HOUR)).toBe('hydrated')
  })
})
