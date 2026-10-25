import type { IScopedLogger } from '@camstack/types'
import { mergeRanges } from './merge-ranges.js'
import { parseSegmentPath } from './segment-path.js'
import type { Accounting, FootagePile, Range, SegmentRow } from './types.js'

/**
 * In-memory footage index, keyed by deviceId → (relativePath → SegmentRow).
 * The framework `storage` cap's `list()` is the ground truth: `hydrateDevice`
 * rebuilds a camera's set from a `list()` result, and `addSegment`/`removeSegments`
 * keep it write-through on finalize/evict. Because every row is derived from a
 * segment path (which encodes start/dur/bytes), the index can never drift from
 * disk. No SQLite, no persistence of its own.
 *
 * ## THIS IS NOT THE ARCHIVE (D295)
 *
 * Since D287 boot loads the hour SUMMARY and replays nothing, so what this
 * index holds is the live tail plus the hours somebody hydrated on demand plus
 * whatever an operator rescanned. **The archive's authority is
 * `SegmentHourLedger`** — `census` for "how much exists in this scope",
 * `streamSegments` for a bounded oldest-first walk of it.
 *
 * Every public method below therefore declares a `@residency` verdict, and
 * `scripts/check-recorder-index-residency.ts` fails the build when a new one
 * does not, or when a new caller of an `archive-shaped` read appears without a
 * licence:
 *
 *  - `archive-shaped` — visits every row the index holds and used to mean
 *    "every row that exists". A caller that reasons about the ARCHIVE from one
 *    of these does a fraction of its job and reports success. On 2026-08-29 a
 *    drain took its work list from `segmentsOnLocation` and left 80.3 GB
 *    behind, reporting `done`.
 *  - `resident-scoped` — asks about the live tail or an explicitly hydrated
 *    window, and the caller gates on {@link RecordingIndex.hydrationOf}. These
 *    are correct and stay here.
 *  - `mutation` — writes.
 *
 * ## …AND IT IS BOUNDED (D524)
 *
 * "Not the archive" was a statement about what the index HAPPENS to hold. It
 * was not a bound: every hour any reader caused to be walked stayed for the
 * life of the process, and so did its walked marker, so a timeline dragged
 * across a retention window made the archive resident permanently. Measured
 * locally at the production shape, 1.6 M resident rows is **1039 MB** against a
 * 3072 MB old space.
 *
 * {@link RecordingIndex.armResidency} declares how much the index may hold
 * ({@link RecordingIndexBudget}) and it drops the least-recently-ASKED-ABOUT
 * (device, hour) buckets to stay inside it. A dropped hour loses its rows and
 * its walked marker in the same operation, so {@link RecordingIndex.hydrationOf}
 * answers `unknown` and the reader walks the directory again: **a dropped row
 * costs a `readdir`, never a segment.** The live tail is never a candidate.
 */
/** Whether the index has actually LOOKED at a span, not whether it found rows. */
export type HydrationState = 'unknown' | 'partial' | 'hydrated'

/** Hour bucket, the granularity the path convention (`.../YYYY/MM/DD/HH/`)
 *  already gives us — so "have I walked this?" costs one Set lookup. */
const HOUR_MS = 3_600_000

/** The hour buckets a half-open span touches. */
function* hourBuckets(fromMs: number, toMs: number): Generator<number> {
  const first = Math.floor(fromMs / HOUR_MS) * HOUR_MS
  for (let h = first; h < toMs; h += HOUR_MS) yield h
}

/** The hour bucket a segment belongs to — the same one its path encodes. */
function hourOf(startMs: number): number {
  return Math.floor(startMs / HOUR_MS) * HOUR_MS
}

/**
 * How much of the archive this index may hold, declared rather than discovered.
 *
 * ## The arithmetic that set it (2026-09-17)
 *
 * Measured locally on the production shape — 26 cameras x 2 profiles x 1.6 M
 * `.m4s` files, the archive size in `segment-hour-ledger.ts`'s header —
 * rebuilding exactly the structures this class holds (`byDevice` maps of
 * `SegmentRow`, plus the sorted views):
 *
 * | resident rows | heap held |
 * | --- | --- |
 * | 1 599 416 (whole archive) | **1039 MB**, 681 B/row |
 * | + all-profiles sorted views | 1054 MB |
 * | + per-profile sorted views | 1068 MB, 698 B/row |
 *
 * The recorder's whole old-space budget is 3072 MB. Before this, nothing said
 * how much of it the index could have: every hour a reader caused to be walked
 * stayed for the life of the process, and so did its walked marker. A timeline
 * dragged across a retention window is enough to make the whole archive
 * resident, permanently.
 *
 * 250 000 rows at the measured 698 B/row is ~166 MB — 5.4 % of old space. In
 * footage that is ~13 fleet-hours at 10 s segments (26 cameras x 2 profiles x
 * 360/hour = 18 720 rows an hour), or days of it when one camera is being
 * scrubbed. `residentHourBudget` bounds the walked map on its own, because an
 * hour walked and found EMPTY holds no rows and would otherwise never be a
 * candidate.
 */
export interface RecordingIndexBudget {
  /** Rows across every device. */
  readonly residentRowBudget: number
  /** Walked-hour markers across every device. */
  readonly residentHourBudget: number
  /** Evict down to this fraction of the budget, so a finalize a row over the
   *  line does not run an eviction pass per segment. */
  readonly evictToFraction: number
  /** Hours at the live edge that are never candidates: the writer is filling
   *  them and a `readdir` could not give them back intact. */
  readonly pinnedTailHours: number
}

/** The production bound. See {@link RecordingIndexBudget} for the measurement. */
export const DEFAULT_RECORDING_INDEX_BUDGET: RecordingIndexBudget = {
  residentRowBudget: 250_000,
  residentHourBudget: 20_000,
  evictToFraction: 0.8,
  pinnedTailHours: 2,
}

/** What {@link RecordingIndex.armResidency} needs to bound and to ANNOUNCE. */
export interface RecordingIndexResidencyDeps {
  readonly logger: IScopedLogger
  readonly now: () => number
  readonly budget: RecordingIndexBudget
}

/**
 * What the index holds and what it has let go of.
 *
 * `budget` is `null` on an index nobody armed — which never evicts, and says so
 * rather than leaving a caller to infer a bound from a number it cannot see.
 */
export interface ResidencyCensus {
  readonly residentRows: number
  readonly residentHours: number
  readonly evictedRows: number
  readonly evictedHours: number
  readonly evictionPasses: number
  readonly budget: RecordingIndexBudget | null
}

/** One (device, hour) bucket weighed for eviction. */
interface EvictionCandidate {
  readonly deviceId: number
  readonly hourStartMs: number
  readonly rows: number
  /** Last time anything asked about this hour. 0 = never, since it was walked. */
  readonly lastUse: number
}

/**
 * Sorted-view maintenance counters — the churn item this pins is invisible in
 * any functional read, so the numbers are the only witness. `fullRebuilds`
 * counts copy-and-sort materialisations of a view; `incrementalInserts` counts
 * ordered inserts into a live view. In steady state finalizes must drive the
 * SECOND counter: at ~3.4 finalizes/s a rebuild-per-finalize regime copies and
 * sorts the whole device archive several times a second forever (measured on
 * the live recorder: 458MB of `large_object_space` churn, 2.1GB RSS at 191s).
 */
export interface SortedViewStats {
  readonly fullRebuilds: number
  readonly incrementalInserts: number
}

/**
 * How much of a hydrate was rows the index ALREADY held.
 *
 * The saving this measures is invisible in every functional read — the index
 * answers identically either way — so the counters are the only witness that
 * the archive walk stopped allocating a second copy of every path string it
 * re-reports. See {@link RecordingIndex.rowFor} for what that cost.
 *
 * A full walk over an unchanged archive must be almost entirely `rowsReused`.
 * `rowsAllocated` climbing on a repeat walk means the reuse gate is missing the
 * held row — a regression, and 69 B per segment of permanent heap.
 */
export interface HydrateReuseStats {
  readonly rowsReused: number
  readonly rowsAllocated: number
}

/**
 * A census of the MATERIALISED sorted views — see
 * {@link RecordingIndex.sortedViewCensus} for why `large_object_space` is the
 * question this exists to answer.
 *
 * `largestDeviceId` is 0 when no view is materialised; every log line built
 * from this census carries it as `tags: { deviceId }`, because "which camera's
 * view is the big one" is the only form the question is ever asked in.
 */
export interface SortedViewCensus {
  /** Materialised `(device, profile-or-all)` views. */
  readonly views: number
  /** Row slots across every view — the array allocation is 8 B each. */
  readonly rowSlots: number
  readonly largestRows: number
  readonly largestDeviceId: number
}

/**
 * Index of the first element whose `startMs` is GREATER than `startMs` (upper
 * bound). Inserting there keeps equal-start rows in arrival order — exactly
 * what a stable full sort of the backing map (insertion-ordered) produces, so
 * an incrementally-maintained view is indistinguishable from a rebuilt one.
 */
function upperBoundByStart(rows: readonly SegmentRow[], startMs: number): number {
  let lo = 0
  let hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid]!.startMs <= startMs) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Index of the FIRST element whose `startMs` is at-or-after `startMs` (lower
 * bound). On a start-sorted view this is exactly where a linear
 * `find(s => s.startMs === x)` and a linear `find(s => s.startMs >= x)` would
 * have stopped — which is what makes the binary-search replacements of those
 * two scans row-for-row identical, duplicate starts included.
 */
function lowerBoundByStart(rows: readonly SegmentRow[], startMs: number): number {
  let lo = 0
  let hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid]!.startMs < startMs) lo = mid + 1
    else hi = mid
  }
  return lo
}

export class RecordingIndex {
  private readonly byDevice = new Map<number, Map<string, SegmentRow>>()
  /** Start-sorted views. Built lazily on first read (one copy+sort), then kept
   * LIVE by `addSegment`'s ordered insert — rows arrive roughly ascending, so
   * the insert is near-appending. Bulk mutations (hydrate, eviction, a re-set
   * of an existing path) still invalidate; the steady-state finalize never
   * does. Interactive locate/range calls reuse these instead of
   * filtering+sorting the complete archive on every seek and scrub miss. */
  private readonly sortedByDevice = new Map<number, Map<string, SegmentRow[]>>()
  private fullRebuilds = 0
  private incrementalInserts = 0
  /** See {@link HydrateReuseStats}. */
  private rowsReused = 0
  private rowsAllocated = 0
  /**
   * Hour buckets this device has been walked for → when anything last ASKED
   * about that hour ({@link useTick}, 0 = never since the walk). Empty =
   * nothing has been looked at, which is NOT the same as "there is nothing" —
   * see {@link hydrationOf}.
   *
   * The tick is the eviction order, and it lives here rather than in a side
   * map because an evicted hour must lose its marker in the SAME operation
   * that loses its rows: a walked marker outliving its rows would report
   * `hydrated` over an hour the index no longer holds, which is the one
   * failure a forgetting index must not have.
   *
   * There used to be an `ALL_HOURS` sentinel here for a device walked
   * end-to-end. It had no production caller (2026-08-30 census) and a bounded
   * index can never truthfully claim it, so it is gone.
   */
  private readonly walked = new Map<number, Map<number, number>>()
  /** Monotonic "somebody asked" counter. Only ever compared, never read out. */
  private useTick = 0
  /** `null` until {@link armResidency}. An unarmed index never evicts. */
  private residencyDeps: RecordingIndexResidencyDeps | null = null
  private evictedRows = 0
  private evictedHours = 0
  private evictionPasses = 0
  /** Hours dropped per device, for the life of the process. One number per
   *  camera — the input to {@link droppedDuringWalk}, nothing else. */
  private readonly evictedHoursByDevice = new Map<number, number>()
  /** {@link evictedHoursByDevice} as it stood when a whole-device walk began. */
  private readonly walkBaseline = new Map<number, number>()
  /**
   * Upper bound on the `durMs` of any row the index holds — the ONLY thing that
   * turns "walk the whole sorted view" into "walk backwards a bounded number of
   * rows".
   *
   * A start-sorted view answers "which row STARTS at/before X" by binary
   * search, but every backward question here ("which row still COVERS X",
   * "which footage ENDS at/before X") depends on `startMs + durMs`, which is
   * not sorted. This scalar closes that: a row at `startMs` can never end later
   * than `startMs + maxDurMs`, so once a candidate's ceiling can no longer beat
   * the best answer found, no earlier row can either — and the walk stops.
   *
   * Monotonically non-decreasing on purpose. It is only ever an OVER-estimate
   * (a longer walk, never a wrong answer); shrinking it on eviction would buy
   * nothing and could only make it wrong.
   */
  private maxDurMs = 0

  /** Widen {@link maxDurMs} for a row entering the index. */
  private noteDuration(durMs: number): void {
    if (durMs > this.maxDurMs) this.maxDurMs = durMs
  }

  private mapFor(deviceId: number): Map<string, SegmentRow> {
    let m = this.byDevice.get(deviceId)
    if (!m) {
      m = new Map<string, SegmentRow>()
      this.byDevice.set(deviceId, m)
    }
    return m
  }

  private invalidateSorted(deviceId: number): void {
    this.sortedByDevice.delete(deviceId)
  }

  private sortedSegments(deviceId: number, profile?: string): readonly SegmentRow[] {
    let deviceCache = this.sortedByDevice.get(deviceId)
    if (!deviceCache) {
      deviceCache = new Map()
      this.sortedByDevice.set(deviceId, deviceCache)
    }
    const key = profile ?? ''
    const cached = deviceCache.get(key)
    if (cached) return cached
    const m = this.byDevice.get(deviceId)
    if (!m) return []
    this.fullRebuilds += 1
    const sorted = [...m.values()]
      .filter((s) => profile == null || s.profile === profile)
      .toSorted((a, b) => a.startMs - b.startMs)
    deviceCache.set(key, sorted)
    return sorted
  }

  /** See {@link SortedViewStats}. Telemetry + the guard the churn test asserts on. @residency resident-scoped */
  sortedViewStats(): SortedViewStats {
    return { fullRebuilds: this.fullRebuilds, incrementalInserts: this.incrementalInserts }
  }

  /** See {@link HydrateReuseStats}. Cumulative over the process. @residency resident-scoped */
  hydrateReuseStats(): HydrateReuseStats {
    return { rowsReused: this.rowsReused, rowsAllocated: this.rowsAllocated }
  }

  /**
   * How many materialised sorted views exist and how many row slots they hold.
   *
   * The question this answers: **what is in `large_object_space`?** Production
   * on 2026-08-29 read ~490 MB there, stable across four samples five minutes
   * apart — retained, not churn — against 110 MB on hub-main with a comparable
   * total heap. V8 only puts an object there when it does not fit a normal
   * page (~256 KB and up), and a sorted view is the recorder's obvious
   * candidate: one `SegmentRow[]` per (device, profile-or-all), materialised
   * on first read and then kept live. At ~296 k archive rows a single
   * all-profiles view is a contiguous array of hundreds of thousands of
   * pointers — megabytes, in one allocation, per device.
   *
   * Slots, not bytes: the array's own allocation is `rowSlots × 8 B` on a
   * 64-bit heap, and the rows it points at are counted once in `byDevice`
   * regardless. Reporting a byte estimate would be inventing precision this
   * cannot have; the slot count is the thing that is actually known and it is
   * what a reader needs to decide whether the views are the 490 MB.
   * @residency resident-scoped
   */
  sortedViewCensus(): SortedViewCensus {
    let views = 0
    let rowSlots = 0
    let largestRows = 0
    let largestDeviceId = 0
    for (const [deviceId, byKey] of this.sortedByDevice) {
      for (const rows of byKey.values()) {
        views += 1
        rowSlots += rows.length
        if (rows.length > largestRows) {
          largestRows = rows.length
          largestDeviceId = deviceId
        }
      }
    }
    return { views, rowSlots, largestRows, largestDeviceId }
  }

  /**
   * Ordered insert of ONE NEW row into every live view it belongs to (the
   * all-profiles view and its own profile's view). Views not yet materialised
   * stay unmaterialised — their first read pays the one build. PRECONDITION:
   * the row's path was NOT already in the device map; a replace must
   * invalidate instead, because the views hold the old row object.
   */
  private insertIntoSortedViews(s: SegmentRow): void {
    const deviceCache = this.sortedByDevice.get(s.deviceId)
    if (!deviceCache) return
    for (const [key, rows] of deviceCache) {
      if (key !== '' && key !== s.profile) continue
      rows.splice(upperBoundByStart(rows, s.startMs), 0, s)
      this.incrementalInserts += 1
    }
  }

  /**
   * The row to index for `path` at `locationId`, REUSING the held one when the
   * index already has it.
   *
   * ## Why a re-walk must not re-allocate (the second copy of every path)
   *
   * Every field of a `SegmentRow` except `locationId` is derived from `path`,
   * so a held row at the same location is not merely EQUAL to a rebuilt one —
   * it is the same fact. Rebuilding it allocates a second byte-identical path
   * string, and that second string does not stay a garbage-collectable
   * duplicate: `SegmentHourLedger`'s mirror still holds the FIRST one, because
   * `reconcileFromIndex` skips its `ledger.put` exactly when the contents
   * match. The archive walk (`roots.ts`) composes a fresh `${deviceId}/${entry}`
   * for every file it reads, so before this reuse existed the first walk after
   * every boot doubled the retained path strings of the whole archive,
   * permanently.
   *
   * Measured on the production shape (26 cameras x 2 profiles x 12 days of
   * 10 s segments = 5.39 M rows): 1218 MB held before the walk, 1591 MB after
   * — +373 MB, 69 B/row, one extra `SeqOneByteString` per segment.
   *
   * Interning the strings instead was measured and is WORSE (+597 MB): the
   * intern table costs more than the duplicate it removes. Not allocating is
   * the only cheap answer.
   *
   * `null` = not a segment path, or another device's.
   */
  private rowFor(
    held: Map<string, SegmentRow>,
    path: string,
    deviceId: number,
    locationId: string,
  ): SegmentRow | null {
    const prev = held.get(path)
    if (prev !== undefined && prev.locationId === locationId) {
      this.rowsReused += 1
      this.noteDuration(prev.durMs)
      return prev
    }
    const p = parseSegmentPath(path)
    if (!p || p.deviceId !== deviceId) return null
    this.rowsAllocated += 1
    this.noteDuration(p.durMs)
    return {
      deviceId: p.deviceId,
      profile: p.profile,
      startMs: p.startMs,
      durMs: p.durMs,
      bytes: p.bytes,
      path,
      locationId,
    }
  }

  /**
   * Replace a device's segments FOR ONE LOCATION from a `storage.list` result (paths relative to that
   * location root). Rows on other locations are preserved. Non-segment paths and other devices are ignored.
   *
   * Deliberately NOT delete-all-then-reinsert: the archive walk re-reports rows
   * this index already holds, with freshly built path strings, and dropping the
   * held rows first would make those fresh strings the permanent ones — a
   * second copy of the whole archive's paths. See {@link RecordingIndex.rowFor}
   * for the measurement (`retainedPathStrings`, which this used to point at,
   * never existed — a leftover that read as a verification, removed 2026-09-17).
   * @residency mutation
   */
  hydrateDevice(deviceId: number, locationId: string, relPaths: readonly string[]): void {
    const m = this.mapFor(deviceId)
    const seen = new Set<string>()
    for (const path of relPaths) {
      const row = this.rowFor(m, path, deviceId, locationId)
      if (row === null) continue
      if (row.path !== path || m.get(path) !== row) m.set(path, row)
      seen.add(path)
    }
    for (const [path, existing] of m) {
      if (existing.locationId === locationId && !seen.has(path)) m.delete(path)
    }
    this.invalidateSorted(deviceId)
    this.enforceResidency()
  }

  /**
   * Whether the index has WALKED `[fromMs, toMs)` for a device.
   *
   * The distinction this exists for: an hour that was walked and held nothing is
   * a real gap in the footage; an hour that was never walked is not, and must
   * not be reported as one. Hydration takes minutes over a >1M-file archive, so
   * for most of that time the honest answer is `unknown`.
   * @residency resident-scoped
   */
  hydrationOf(deviceId: number, fromMs: number, toMs: number): HydrationState {
    const w = this.walked.get(deviceId)
    if (w === undefined) return 'unknown'
    let seen = 0
    let total = 0
    for (const h of hourBuckets(fromMs, toMs)) {
      total++
      if (w.has(h)) seen++
    }
    if (total === 0 || seen === total) return 'hydrated'
    return seen === 0 ? 'unknown' : 'partial'
  }

  /** Record that `[fromMs, toMs)` has been walked, whatever it contained. @residency mutation */
  markHydrated(deviceId: number, fromMs: number, toMs: number): void {
    let w = this.walked.get(deviceId)
    if (w === undefined) {
      w = new Map<number, number>()
      this.walked.set(deviceId, w)
    }
    const tick = ++this.useTick
    for (const h of hourBuckets(fromMs, toMs)) w.set(h, tick)
  }

  /**
   * Bound this index, and give it somewhere to SAY what it dropped.
   *
   * Called once, from the recorder addon's initialize — `ctx.logger` does not
   * exist when the field is constructed. Until it runs the index never evicts,
   * which is honest for the pre-init window (it holds nothing) and is the one
   * state in which {@link ResidencyCensus.budget} is `null`.
   * @residency mutation
   */
  armResidency(deps: RecordingIndexResidencyDeps): void {
    this.residencyDeps = deps
    this.enforceResidency()
  }

  /**
   * A whole-device walk is starting: remember how much this index had already
   * forgotten about that camera, so {@link droppedDuringWalk} can say whether
   * the walk's result is a COMPLETE view of what it read.
   * @residency mutation
   */
  beginWalk(deviceId: number): void {
    this.walkBaseline.set(deviceId, this.evictedHoursByDevice.get(deviceId) ?? 0)
  }

  /**
   * Did this index drop anything for `deviceId` since {@link beginWalk}?
   *
   * The one question a PRUNE has to ask. An hour the index dropped is
   * indistinguishable, from the outside, from an hour disk no longer has — so
   * a consumer that deletes durable state on the index's silence must refuse
   * when the answer is `true`. `false` when nobody called `beginWalk`: an
   * unarmed index never drops, and a caller that never announced a walk is
   * asking about one that did not happen.
   * @residency resident-scoped
   */
  droppedDuringWalk(deviceId: number): boolean {
    const baseline = this.walkBaseline.get(deviceId)
    if (baseline === undefined) return false
    return (this.evictedHoursByDevice.get(deviceId) ?? 0) > baseline
  }

  /** What is held, what was let go, and under which bound. @residency resident-scoped */
  residency(): ResidencyCensus {
    return {
      residentRows: this.residentRowCount(),
      residentHours: this.residentHourCount(),
      evictedRows: this.evictedRows,
      evictedHours: this.evictedHours,
      evictionPasses: this.evictionPasses,
      budget: this.residencyDeps?.budget ?? null,
    }
  }

  private residentRowCount(): number {
    let n = 0
    for (const m of this.byDevice.values()) n += m.size
    return n
  }

  private residentHourCount(): number {
    let n = 0
    for (const w of this.walked.values()) n += w.size
    return n
  }

  /**
   * Note that something ASKED about `[fromMs, toMs)` — the only input to the
   * eviction order.
   *
   * Walks whichever side is smaller: a read whose span is wider than the
   * device's whole walked map (a month-wide `ranges`, an availability sweep)
   * would otherwise iterate one hour at a time across the span.
   */
  private touch(deviceId: number, fromMs: number, toMs: number): void {
    const w = this.walked.get(deviceId)
    if (w === undefined || w.size === 0) return
    const tick = ++this.useTick
    const spanHours = Math.ceil(Math.max(0, toMs - fromMs) / HOUR_MS)
    if (spanHours > w.size) {
      for (const h of w.keys()) if (h < toMs && h + HOUR_MS > fromMs) w.set(h, tick)
      return
    }
    for (const h of hourBuckets(fromMs, toMs)) if (w.has(h)) w.set(h, tick)
  }

  /**
   * Drop the least-recently-asked-about hours until the index is back inside
   * its budget.
   *
   * ## What a dropped hour costs, and why that is safe
   *
   * The directory is the authority for which segments exist — every row here
   * is derived from a path the walk read, and `hydrateHour` /
   * `hydrateWindowFromStorage` rebuild it from one shallow `readdir` (or one
   * ledger point read). So a drop costs a re-read, never a segment. The
   * property that makes it costs-a-read rather than loses-a-segment is that
   * the walked marker goes with the rows: `hydrationOf` then answers `unknown`
   * and the reader walks. A marker left behind would answer `hydrated` over an
   * hour holding nothing, which is exactly the silent gap this class spent
   * D295 learning not to report.
   *
   * ## What is never a candidate
   *
   * The live tail ({@link RecordingIndexBudget.pinnedTailHours}). Those hours
   * are write-through from the writer (`addSegment`), not walked, and a
   * `readdir` of an hour a writer is still filling cannot give back what it
   * had — D445's lost tail, from the other direction.
   */
  private enforceResidency(): void {
    const deps = this.residencyDeps
    if (deps === null) return
    const { budget } = deps
    let rows = this.residentRowCount()
    let hours = this.residentHourCount()
    if (rows <= budget.residentRowBudget && hours <= budget.residentHourBudget) return

    const rowTarget = Math.floor(budget.residentRowBudget * budget.evictToFraction)
    const hourTarget = Math.floor(budget.residentHourBudget * budget.evictToFraction)
    const pinnedFrom = hourOf(deps.now()) - Math.max(0, budget.pinnedTailHours - 1) * HOUR_MS

    const counts = this.hourHistogram()
    const candidates: EvictionCandidate[] = []
    for (const [deviceId, byHour] of counts) {
      const walkedHours = this.walked.get(deviceId)
      for (const [hourStartMs, count] of byHour) {
        if (hourStartMs >= pinnedFrom) continue
        candidates.push({
          deviceId,
          hourStartMs,
          rows: count,
          lastUse: walkedHours?.get(hourStartMs) ?? 0,
        })
      }
    }
    // Coldest first; among equally cold hours the oldest footage goes first.
    candidates.sort((a, b) => a.lastUse - b.lastUse || a.hourStartMs - b.hourStartMs)

    const victims = new Map<number, Set<number>>()
    let droppedRows = 0
    let droppedHours = 0
    for (const c of candidates) {
      if (rows <= rowTarget && hours <= hourTarget) break
      let forDevice = victims.get(c.deviceId)
      if (!forDevice) {
        forDevice = new Set<number>()
        victims.set(c.deviceId, forDevice)
      }
      forDevice.add(c.hourStartMs)
      rows -= c.rows
      droppedRows += c.rows
      if (this.walked.get(c.deviceId)?.has(c.hourStartMs) === true) {
        hours -= 1
        droppedHours += 1
      }
    }
    if (victims.size === 0) return

    this.evictionPasses += 1
    this.evictedRows += droppedRows
    this.evictedHours += droppedHours
    for (const [deviceId, hoursToDrop] of victims) {
      this.dropHours(deviceId, hoursToDrop, rows, budget, deps.logger)
    }
  }

  /** `deviceId → hourStartMs → resident rows`, including hours walked and found
   *  empty (count 0) — those hold no rows and would otherwise never be dropped,
   *  leaving the walked map to grow without bound on its own. */
  private hourHistogram(): Map<number, Map<number, number>> {
    const out = new Map<number, Map<number, number>>()
    for (const [deviceId, m] of this.byDevice) {
      const byHour = new Map<number, number>()
      for (const s of m.values()) {
        const h = hourOf(s.startMs)
        byHour.set(h, (byHour.get(h) ?? 0) + 1)
      }
      out.set(deviceId, byHour)
    }
    for (const [deviceId, w] of this.walked) {
      let byHour = out.get(deviceId)
      if (!byHour) {
        byHour = new Map<number, number>()
        out.set(deviceId, byHour)
      }
      for (const h of w.keys()) if (!byHour.has(h)) byHour.set(h, 0)
    }
    return out
  }

  /** Delete one device's victim hours — rows and walked markers together — and
   *  say so. A structure that silently forgets is how this class of bug hides. */
  private dropHours(
    deviceId: number,
    hoursToDrop: ReadonlySet<number>,
    residentRowsAfter: number,
    budget: RecordingIndexBudget,
    logger: IScopedLogger,
  ): void {
    const m = this.byDevice.get(deviceId)
    let droppedRows = 0
    if (m) {
      for (const [path, s] of m) {
        if (!hoursToDrop.has(hourOf(s.startMs))) continue
        m.delete(path)
        droppedRows += 1
      }
      if (m.size === 0) this.byDevice.delete(deviceId)
    }
    const w = this.walked.get(deviceId)
    if (w) {
      for (const h of hoursToDrop) w.delete(h)
      if (w.size === 0) this.walked.delete(deviceId)
    }
    this.invalidateSorted(deviceId)
    this.evictedHoursByDevice.set(
      deviceId,
      (this.evictedHoursByDevice.get(deviceId) ?? 0) + hoursToDrop.size,
    )
    let oldestHourMs = Infinity
    let newestHourMs = -Infinity
    for (const h of hoursToDrop) {
      if (h < oldestHourMs) oldestHourMs = h
      if (h > newestHourMs) newestHourMs = h
    }
    logger.info('recorder: index dropped resident hours — over the residency budget', {
      tags: { deviceId },
      meta: {
        hours: hoursToDrop.size,
        rows: droppedRows,
        oldestHourMs,
        newestHourMs,
        residentRowsAfter,
        rowBudget: budget.residentRowBudget,
        hourBudget: budget.residentHourBudget,
        // What a reader pays to get them back: one shallow readdir per hour,
        // or one ledger point read. Never a segment.
        costOfRecovery: 'readdir-per-hour',
      },
    })
  }

  /**
   * Merge one hour's segments for a location, and mark that hour walked.
   *
   * MERGES, unlike {@link hydrateDevice}, which replaces a whole location —
   * right for the full walk, catastrophic for an incremental one, where
   * hydrating hour 5 would erase hours 0–4.
   * @residency mutation
   */
  hydrateHour(
    deviceId: number,
    locationId: string,
    hourStartMs: number,
    relPaths: readonly string[],
  ): void {
    const m = this.mapFor(deviceId)
    let changed = false
    for (const path of relPaths) {
      const row = this.rowFor(m, path, deviceId, locationId)
      if (row === null) continue
      if (m.get(path) === row) continue
      m.set(path, row)
      changed = true
    }
    // An hour re-walked to the same rows is the common case on the incremental
    // path; rebuilding the sorted views for it would copy-and-sort the device's
    // whole archive for no change at all.
    if (changed) this.invalidateSorted(deviceId)
    this.markHydrated(deviceId, hourStartMs, hourStartMs + HOUR_MS)
    this.enforceResidency()
  }

  /**
   * Make one hour of ONE location exactly `relPaths` — merge what is there and
   * drop what is not.
   *
   * {@link hydrateHour} merges, which is right for a reader: a listing it took
   * of a live hour is a lower bound, and dropping on it would delete the index
   * of footage the readdir merely raced. This is for the one caller that has
   * TRUSTED evidence the hour is over and the volume it listed is the volume it
   * started on — the operator-armed ledger walk — where the directory is the
   * whole truth about the hour and an index row naming a file that is not in it
   * is a ghost (D523, D148's "trusted walk" arm).
   *
   * Scoped to the (device, location, hour) triple: a path filed under another
   * hour, or held for another location, is none of this call's business.
   * @residency mutation
   */
  resetHour(
    deviceId: number,
    locationId: string,
    hourStartMs: number,
    relPaths: readonly string[],
  ): readonly string[] {
    const m = this.mapFor(deviceId)
    const keep = new Set(relPaths)
    const dropped: string[] = []
    for (const [path, row] of m) {
      if (row.locationId !== locationId) continue
      if (Math.floor(row.startMs / HOUR_MS) * HOUR_MS !== hourStartMs) continue
      if (keep.has(path)) continue
      dropped.push(path)
    }
    for (const path of dropped) m.delete(path)
    if (dropped.length > 0) this.invalidateSorted(deviceId)
    this.hydrateHour(deviceId, locationId, hourStartMs, relPaths)
    // `hydrateHour` already enforces; stated again because the rule is
    // syntactic on purpose — every `mapFor` caller hands control to the bound
    // where a reader can see it, and `scripts/check-recorder-index-residency.ts`
    // fails the build otherwise. It caught this very method on the D524 rebase.
    this.enforceResidency()
    return dropped
  }

  /**
   * Insert/replace one finalized segment (idempotent by path).
   *
   * THE hot mutation: every profile-writer lands here every `segmentSeconds`,
   * ~3.4 times a second fleet-wide. A NEW path is an ordered insert into the
   * live sorted views (rows arrive roughly ascending, so it is near-appending
   * — O(log n) search + a short memmove). Only the rare RE-SET of an existing
   * path (watcher replay after a playlist reset, or a relocate that changes
   * `locationId`) invalidates: the views hold the old row object, and a
   * one-off rebuild is the simple correct answer for a case that is not hot.
   * @residency mutation
   */
  addSegment(s: SegmentRow): void {
    const m = this.mapFor(s.deviceId)
    this.noteDuration(s.durMs)
    const replacing = m.has(s.path)
    m.set(s.path, s)
    if (replacing) {
      this.invalidateSorted(s.deviceId)
      return
    }
    this.insertIntoSortedViews(s)
    this.enforceResidency()
  }

  /** Remove segments by relative path, routing each path to the correct device map via its encoded deviceId. @residency mutation */
  removeSegments(paths: readonly string[]): void {
    for (const p of paths) {
      const parsed = parseSegmentPath(p)
      if (!parsed) continue
      if (this.byDevice.get(parsed.deviceId)?.delete(p)) this.invalidateSorted(parsed.deviceId)
    }
  }

  /**
   * Rows for a device (optionally one profile), sorted by start.
   *
   * RESIDENT rows — never "this camera's footage". A retention prune fed from
   * here selects a fraction of what expired and returns a floor computed from
   * that same fraction, which is indistinguishable from a correct prune
   * (§P4). The archive answer is `SegmentHourLedger.streamSegments({ deviceId })`.
   * @residency archive-shaped
   */
  segments(deviceId: number, profile?: string): SegmentRow[] {
    return [...this.sortedSegments(deviceId, profile)]
  }

  /**
   * Start-sorted rows whose `startMs` is in `[fromMs, toMs)`.
   * Slices the live view — does not copy the rest of the archive.
   * @residency resident-scoped
   */
  segmentsStartingIn(
    deviceId: number,
    profile: string,
    fromMs: number,
    toMs: number,
  ): readonly SegmentRow[] {
    this.touch(deviceId, fromMs, toMs)
    const segs = this.sortedSegments(deviceId, profile)
    let lo = 0
    let hi = segs.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (segs[mid]!.startMs < fromMs) lo = mid + 1
      else hi = mid
    }
    let end = lo
    while (end < segs.length && segs[end]!.startMs < toMs) end += 1
    return lo === 0 && end === segs.length ? segs : segs.slice(lo, end)
  }

  /**
   * The row whose `startMs` is EXACTLY `startMs`, or null.
   *
   * The point lookup every byte read is: `readSegmentBytes` / `readGopBytes` /
   * `readWindowBytes` all address a segment by its exact start, which is what
   * the playback manifest and the locate answer handed the client. It used to
   * be `segments(deviceId, profile).find(...)` — a full COPY of the
   * device-profile archive plus a linear scan, per scrub tick and per playback
   * fetch (~10 k rows copied to reach one of them on the live hub).
   *
   * Returns the FIRST row with that start, which is what `.find` returned on
   * the same start-sorted view: a restart can leave two rows sharing a start,
   * and the byte reader must keep resolving to the same one it always did.
   * @residency resident-scoped
   */
  segmentStartingAt(deviceId: number, profile: string, startMs: number): SegmentRow | null {
    this.touch(deviceId, startMs, startMs + 1)
    const segs = this.sortedSegments(deviceId, profile)
    const at = segs[lowerBoundByStart(segs, startMs)]
    return at !== undefined && at.startMs === startMs ? at : null
  }

  /**
   * Start-sorted rows whose SPAN `[startMs, startMs+durMs)` overlaps
   * `[fromMs, toMs)` — i.e. `startMs < toMs && startMs + durMs > fromMs`.
   *
   * The overlap-inclusive twin of {@link segmentsStartingIn}, and the reason it
   * cannot just slice from the `fromMs` lower bound: the segment an operator is
   * actually watching at `fromMs` STARTED before it. Dropping it truncates the
   * first segment of every playback window — silently, because the window still
   * renders, just short. The boundary convention is the caller's, preserved
   * from the whole-archive filter this replaces: a segment ending EXACTLY at
   * `fromMs` is excluded (`end > fromMs`), a segment starting exactly at `toMs`
   * is excluded (`start < toMs`), and a segment straddling `fromMs` is IN.
   *
   * The backward reach is {@link maxDurMs}, not "one element": with overlapping
   * rows (a restart re-recording an hour) more than one predecessor can still
   * cover `fromMs`, and the ceiling is the only bound that cannot miss one.
   * @residency resident-scoped
   */
  segmentsOverlapping(
    deviceId: number,
    profile: string,
    fromMs: number,
    toMs: number,
  ): readonly SegmentRow[] {
    this.touch(deviceId, fromMs - this.maxDurMs, toMs)
    const segs = this.sortedSegments(deviceId, profile)
    const end = lowerBoundByStart(segs, toMs)
    let head = lowerBoundByStart(segs, fromMs)
    const reach = fromMs - this.maxDurMs
    while (head > 0 && segs[head - 1]!.startMs > reach) head -= 1
    const out: SegmentRow[] = []
    for (let i = head; i < end; i++) {
      const s = segs[i]!
      if (s.startMs + s.durMs > fromMs) out.push(s)
    }
    return out
  }

  /** True when `relPath` is currently indexed for `deviceId`. O(1). @residency resident-scoped */
  hasSegment(deviceId: number, relPath: string): boolean {
    return this.byDevice.get(deviceId)?.has(relPath) === true
  }

  /** Aggregate accounting for a device across ALL its locations (use `accountingForLocation` for one location). @residency archive-shaped */
  accounting(deviceId: number): Accounting {
    const m = this.byDevice.get(deviceId)
    if (!m || m.size === 0) return { bytes: 0, count: 0, oldestMs: null, newestMs: null }
    let bytes = 0
    let oldestMs = Infinity
    let newestMs = -Infinity
    for (const s of m.values()) {
      bytes += s.bytes
      if (s.startMs < oldestMs) oldestMs = s.startMs
      if (s.startMs > newestMs) newestMs = s.startMs
    }
    return { bytes, count: m.size, oldestMs, newestMs }
  }

  /**
   * Per-PROFILE accounting for one device, in ONE pass — no sort, no cache
   * rebuild. The placement planner needs a bytes/day rate per (device, profile)
   * on every 30s tick; `segments(deviceId, profile)` would sort the device's
   * whole archive each time (the sorted cache is invalidated by every finalize),
   * which on a month of 10s segments is a sort of ~250k rows per camera per
   * tick. This walks the same rows once and accumulates.
   * @residency archive-shaped
   */
  accountingByProfile(deviceId: number): ReadonlyMap<string, Accounting> {
    const out = new Map<string, Accounting>()
    const m = this.byDevice.get(deviceId)
    if (!m) return out
    for (const s of m.values()) {
      const prev = out.get(s.profile)
      if (!prev) {
        out.set(s.profile, {
          bytes: s.bytes,
          count: 1,
          oldestMs: s.startMs,
          newestMs: s.startMs,
        })
        continue
      }
      out.set(s.profile, {
        bytes: prev.bytes + s.bytes,
        count: prev.count + 1,
        oldestMs: Math.min(prev.oldestMs ?? s.startMs, s.startMs),
        newestMs: Math.max(prev.newestMs ?? s.startMs, s.startMs),
      })
    }
    return out
  }

  /**
   * Every (device, profile, location) pile in ONE pass — bytes and file count,
   * no sort and no cache rebuild.
   *
   * This is the input to the operator-armed rebalance (D116): it asks "where is
   * each camera-profile's footage, and how much of it", which is exactly the
   * unit the placement plan assigns and the relocate mover moves. Building it
   * from `segmentsOnLocation` per location would sort the whole archive once
   * per location instead.
   * @residency archive-shaped
   */
  piles(): readonly FootagePile[] {
    const out = new Map<
      string,
      { deviceId: number; profile: string; locationId: string; bytes: number; files: number }
    >()
    for (const m of this.byDevice.values()) {
      for (const s of m.values()) {
        const key = `${s.deviceId}:${s.profile}:${s.locationId}`
        const prev = out.get(key)
        if (prev) {
          prev.bytes += s.bytes
          prev.files += 1
          continue
        }
        out.set(key, {
          deviceId: s.deviceId,
          profile: s.profile,
          locationId: s.locationId,
          bytes: s.bytes,
          files: 1,
        })
      }
    }
    return [...out.values()]
  }

  /**
   * Every RESIDENT segment on a storage location, across devices, oldest-first.
   *
   * ## The one that bit (D295)
   *
   * The relocate mover's work list. On 2026-08-29 a migration drained
   * `recordingsLow:default` from this call: the whole index held 29 218 row
   * slots across every location and profile, the ledger held **145 664
   * segments / 846 hours / 80.3 GB on that one location**, and the job moved
   * its short list, reported `done` and logged no discrepancy. The mover now
   * streams `SegmentHourLedger.streamSegments({ locationId })` and this call
   * survives only as the no-ledger fallback, which announces itself.
   * @residency archive-shaped
   */
  segmentsOnLocation(locationId: string): SegmentRow[] {
    const out: SegmentRow[] = []
    for (const m of this.byDevice.values()) {
      for (const s of m.values()) if (s.locationId === locationId) out.push(s)
    }
    return out.toSorted((a, b) => a.startMs - b.startMs)
  }

  /*
   * ## What is deliberately NOT here: per-LOCATION accounting
   *
   * `accountingForLocations` (a domain total) and `accountingForLocation` (one
   * location) both used to live here, and `segmentsOnLocations` returned the
   * whole domain copied into a new array and sorted. Every one of them had to
   * visit every row of every device, because a map keyed by device cannot
   * answer a question keyed by location any other way.
   *
   * On the live hub that was 7.1 M rows per call, and the storage-pressure
   * sweep asked twice a minute — ~15 M row visits/minute of uninterrupted main
   * thread, plus a 56 MB copy and a 7.1 M-element sort on every eviction round.
   * And because the answer had to be complete, the whole archive had to be
   * RESIDENT to be visited.
   *
   * A total is a `SUM` and the oldest is a `LIMIT`. Both now go to the durable
   * hour ledger (`SegmentHourLedger.accountingForLocations` /
   * `.oldestSegments`), which holds the same archive bucketed by hour and
   * indexed by `(locationId, hourStartMs)`. Do not reintroduce a location-keyed
   * read here: it can only ever be a scan.
   */

  /**
   * Binary-search a start-sorted slice for the segment containing `epochMs`,
   * then walk backwards under {@link maxDurMs} while an earlier row could still
   * cover it.
   *
   * ## Why the last row starting at-or-before the instant is not the answer
   *
   * It is the answer whenever it covers — and that case is unchanged, so the
   * row this returns is the row it always returned. But the view is sorted by
   * `startMs` and coverage is `startMs + durMs`, which is NOT sorted: a SHORT
   * segment starting inside a longer overlapping one (a restart re-recording an
   * hour) lands last and does not cover, while the long one enclosing it does.
   * Stopping there reported a gap over footage that is on disk — a hole in the
   * operator's timeline, and a `locateSegment` / `nearestCoveredEdge` answer
   * that snapped past playable video.
   *
   * The walk is bounded exactly as {@link segmentsOverlapping} and
   * {@link coveredEdgeBefore} bound theirs: once a candidate's ceiling
   * `startMs + maxDurMs` no longer reaches past `epochMs`, no earlier row's can
   * either — earlier rows start no later. The ceiling is checked AFTER the row
   * itself, so a stale-narrow ceiling could only lengthen the walk, never skip
   * a coverer.
   *
   * Boundary convention preserved verbatim: the window is `[startMs, startMs +
   * durMs)`. `epochMs === startMs` is covered; `epochMs === startMs + durMs` is
   * not. Among several covering rows the LATEST-starting one wins, which is
   * what the plain binary search returned.
   */
  private segmentAtIn(segs: readonly SegmentRow[], epochMs: number): SegmentRow | null {
    for (let i = upperBoundByStart(segs, epochMs) - 1; i >= 0; i--) {
      const s = segs[i]!
      if (epochMs < s.startMs + s.durMs) return s
      if (s.startMs + this.maxDurMs <= epochMs) break
    }
    return null
  }

  /** The segment whose [startMs, startMs+durMs) window contains `epochMs`, or null if `epochMs` falls in a gap / there is no footage. @residency resident-scoped */
  segmentAt(deviceId: number, profile: string, epochMs: number): SegmentRow | null {
    this.touch(deviceId, epochMs - this.maxDurMs, epochMs + 1)
    return this.segmentAtIn(this.sortedSegments(deviceId, profile), epochMs)
  }

  /**
   * If epochMs is covered, returns it unchanged. Otherwise returns the start of the
   * next covered segment forward. Returns null if there is no forward coverage
   * (epoch past all footage, or no footage at all). Only snaps forward — never backward.
   * @residency resident-scoped
   */
  nearestCoveredEdge(deviceId: number, profile: string, epochMs: number): number | null {
    this.touch(deviceId, epochMs - this.maxDurMs, epochMs + 1)
    const segs = this.sortedSegments(deviceId, profile)
    if (segs.length === 0) return null
    if (this.segmentAtIn(segs, epochMs) !== null) return epochMs
    // Lower bound == where the linear `find(s => s.startMs >= epochMs)` stopped.
    // It shares `locateSegment`'s gap branch with `coveredEdgeBefore`, so
    // leaving it a scan would keep the whole branch O(archive) per drag tick.
    const next = segs[lowerBoundByStart(segs, epochMs)]
    return next ? next.startMs : null
  }

  /**
   * The end of the newest footage for a (device, profile), or null when there
   * is none — "how far can an export reach?", asked once per render.
   *
   * NOT simply the last row's end: the view is sorted by START, and an earlier,
   * longer segment can end later. Walks backwards from the newest row only
   * while an earlier start could still, at {@link maxDurMs}, beat the best end
   * seen — which on a uniform-length archive is one comparison.
   * @residency resident-scoped
   */
  latestEnd(deviceId: number, profile: string): number | null {
    const segs = this.sortedSegments(deviceId, profile)
    let best: number | null = null
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i]!
      if (best !== null && s.startMs + this.maxDurMs <= best) break
      const end = s.startMs + s.durMs
      if (best === null || end > best) best = end
    }
    return best
  }

  /**
   * The exclusive END of the nearest footage ending at-or-before `epochMs`
   * (the backward covered edge), or null when no footage ends at or before it.
   * Backward counterpart of `nearestCoveredEdge`: consecutive segments leave
   * small cracks (`startMs + durMs` < next `startMs` by ~11-17 ms), so a
   * backward frame-step probing `startMs − 1` lands in a crack — this edge
   * lets the caller hop to the true previous segment.
   *
   * ## Why this is a search and not a scan
   *
   * Called on EVERY locate that lands in a gap — during a drag across sparse
   * footage, every tick — and it used to walk the device-profile's whole sorted
   * view to do it. Two bounds replace the walk, and the second is the one that
   * has to be right:
   *
   * 1. A row starting AFTER `epochMs` ends after it too (`durMs >= 0`), so
   *    nothing at-or-past the upper bound of `epochMs` can qualify.
   * 2. Below that bound the answer is NOT the predecessor. A row starting
   *    before the cursor can still COVER it (disqualified: its end is past
   *    `epochMs`), while an even earlier row ends cleanly before it and is the
   *    true edge. So the walk continues backwards, and only {@link maxDurMs}
   *    says when to stop: earlier rows start no later than this one, so none of
   *    them can end past `startMs + maxDurMs`.
   * @residency resident-scoped
   */
  coveredEdgeBefore(deviceId: number, profile: string, epochMs: number): number | null {
    this.touch(deviceId, epochMs - this.maxDurMs, epochMs + 1)
    const segs = this.sortedSegments(deviceId, profile)
    let best: number | null = null
    for (let i = upperBoundByStart(segs, epochMs) - 1; i >= 0; i--) {
      const s = segs[i]!
      if (best !== null && s.startMs + this.maxDurMs <= best) break
      const end = s.startMs + s.durMs
      if (end <= epochMs && (best === null || end > best)) best = end
    }
    return best
  }

  /** @residency resident-scoped */
  ranges(
    deviceId: number,
    profile: string,
    fromMs: number,
    toMs: number,
    gapToleranceMs: number,
  ): Range[] {
    this.touch(deviceId, fromMs, toMs)
    const overlapping = this.sortedSegments(deviceId, profile).filter(
      (s) => s.startMs + s.durMs > fromMs && s.startMs < toMs,
    )
    return mergeRanges(overlapping, gapToleranceMs).map((r) => ({
      startMs: Math.max(r.startMs, fromMs),
      endMs: Math.min(r.endMs, toMs),
    }))
  }
}
