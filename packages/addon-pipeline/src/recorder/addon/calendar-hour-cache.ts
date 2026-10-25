/**
 * The calendar's EXACT rung — one hour's segments per (camera, profile, hour) —
 * as a bounded read-through cache (D674).
 *
 * ## What it replaced, and what that cost
 *
 * The rung used to be one flat `Map<string, HourSegment[]>` keyed
 * `"${deviceId}:${profile}:${hourMs}"`, plus a twin `segsReadAt` map with the
 * same keys, both unbounded and neither aged. Every hour anybody ASKED about got
 * a key in both — including the empty ones, because a missing hour directory
 * reads as `[]` and a complete `[]` was cached. One caller asked for every hour
 * since 1970 for every camera, every ten minutes: 11,937,796 keys
 * (= 24 camera/profile pairs × 497,408 hours), ~2.2 GB of heap and ~940 MB of
 * large-object space, 71 % of V8's hard 2^24-entry Map limit. The recorder died
 * of it on 2026-09-28 10:21.
 *
 * ## The shape now
 *
 *  - NESTED NUMERIC keys: device → profile → hour INDEX (hours since the
 *    epoch, ~490 k — a Smi, where `hourMs` would be a boxed HeapNumber).
 *    No composite string is ever built, and eviction of one camera's day is
 *    `profiles × 24` deletes, not a scan of every key in the process.
 *  - A BOUND, the same one the RAM index lives under
 *    ({@link DEFAULT_CALENDAR_HOUR_BUDGET}): hours and segments, least recently
 *    used first. The calendar is a read-through cache of the same disk the index
 *    reads, so it cannot be allowed more than the index is.
 *  - An EMPTY hour is a bounded negative-cache entry (one shared frozen array,
 *    counted apart as `emptyHours`), never a fresh `[]`, and it lives under the
 *    same bound — a gap the timeline polls is not re-read forever, and a walk
 *    over nothing cannot grow the cache past its budget.
 *  - The read stamp lives ON the cached hour (`readAtMs`), set only when the
 *    hour was CURRENT at read time. It dies with its hour (eviction,
 *    `invalidateDay`, `clear`), so there is no second map to leak, and an hour
 *    read mid-way keeps its stamp until it is read again after it closed — no
 *    matter which other hour of the pair was read in between (review M4: one
 *    slot per pair lost the stamp to the next hour's read).
 */
import type { HourSegment } from './calendar-scan.js'
import { DEFAULT_RECORDING_INDEX_BUDGET } from '../recording-index.js'

const HOUR_MS = 3_600_000
const HOURS_PER_DAY = 24

/** How much the exact rung may hold. */
export interface CalendarHourBudget {
  /** Cached hours (with footage AND empty) across every camera. */
  readonly hourBudget: number
  /** `HourSegment` objects across every cached hour. */
  readonly segmentBudget: number
  /** Evict down to this fraction, so one insert over the line does not run
   *  an eviction pass per hour. */
  readonly evictToFraction: number
}

/**
 * The production bound: the RAM index's own (`DEFAULT_RECORDING_INDEX_BUDGET`,
 * 250 000 rows / 20 000 walked hours, measured at 698 B/row). The calendar
 * holds a 3-scalar `HourSegment` per segment where the index holds a full row,
 * so the same counts are a SMALLER heap here — see
 * {@link CALENDAR_SEGMENT_APPROX_BYTES}.
 */
export const DEFAULT_CALENDAR_HOUR_BUDGET: CalendarHourBudget = {
  hourBudget: DEFAULT_RECORDING_INDEX_BUDGET.residentHourBudget,
  segmentBudget: DEFAULT_RECORDING_INDEX_BUDGET.residentRowBudget,
  evictToFraction: DEFAULT_RECORDING_INDEX_BUDGET.evictToFraction,
}

/**
 * Estimated retained bytes per cached HOUR, without pointer compression (the
 * hub's node is built without it: 8-byte slots). The {@link CachedHour} object
 * (header + 4 fields ≈ 56 B), its slot in the LRU `Set` (~24 B) and in the inner
 * hour `Map` (~24 B), rounded up for hash-table slack. An estimate for the
 * census, not a measurement.
 */
export const CALENDAR_HOUR_APPROX_BYTES = 128

/**
 * Estimated retained bytes per `HourSegment`: a 3-field JSObject (~48 B), a
 * boxed `startMs` (~16 B, epoch ms is not a Smi) and its array slot (8 B) —
 * the same arithmetic the 2026-09-28 heap findings used.
 */
export const CALENDAR_SEGMENT_APPROX_BYTES = 72

/** Estimated extra bytes for a stamped hour (a boxed `readAtMs`). */
export const CALENDAR_READ_AT_APPROX_BYTES = 16

/** What the exact rung reports to the recorder census. */
export interface CalendarHourCacheCensus {
  /** Hours cached WITH footage. */
  readonly hourKeys: number
  /** Hours cached as a known gap (the negative cache). */
  readonly emptyHours: number
  readonly hourSegments: number
  /** Cached hours carrying a while-current read stamp — each is re-read once
   *  after it closes, then carries none. */
  readonly segsReadAtKeys: number
  /** Hours dropped by the bound since boot. */
  readonly evictedHours: number
  readonly approxBytes: number
}

/** One cached hour. Its identity is the LRU key — no composite string. */
interface CachedHour {
  readonly deviceId: number
  readonly profile: string
  readonly hourIndex: number
  readonly segments: readonly HourSegment[]
  /** When it was read AS THE CURRENT HOUR; `null` = read after it closed. */
  readonly readAtMs: number | null
}

/** Every empty hour shares this one array: a gap costs a slot, not an object. */
const EMPTY_HOUR: readonly HourSegment[] = Object.freeze([])

/** Hours since the epoch — a Smi, where `hourMs` would be a HeapNumber. */
export function hourIndexOf(epochMs: number): number {
  return Math.floor(epochMs / HOUR_MS)
}

export class CalendarHourCache {
  private readonly byDevice = new Map<number, Map<string, Map<number, CachedHour>>>()
  /** Least recently used first — `Set` iteration order is insertion order. */
  private readonly lru = new Set<CachedHour>()
  private segmentCount = 0
  private emptyCount = 0
  private stampedCount = 0
  private evictedCount = 0

  constructor(private readonly budget: CalendarHourBudget = DEFAULT_CALENDAR_HOUR_BUDGET) {}

  /** The cached segments of one hour, or `undefined` when not cached. */
  get(deviceId: number, profile: string, hourMs: number): readonly HourSegment[] | undefined {
    const entry = this.entryOf(deviceId, profile, hourMs)
    if (entry === undefined) return undefined
    this.lru.delete(entry)
    this.lru.add(entry)
    return entry.segments
  }

  /** When this hour was read AS THE CURRENT HOUR, or `undefined`. */
  readAtOf(deviceId: number, profile: string, hourMs: number): number | undefined {
    return this.entryOf(deviceId, profile, hourMs)?.readAtMs ?? undefined
  }

  /**
   * Store one COMPLETE scan. `currentReadAtMs` is set only when the hour was
   * the current one at store time; a later store of the closed hour passes
   * `null` and so drops the stamp with the entry it replaces.
   */
  set(
    deviceId: number,
    profile: string,
    hourMs: number,
    segments: readonly HourSegment[],
    currentReadAtMs: number | null,
  ): void {
    const hourIndex = hourIndexOf(hourMs)
    this.remove(deviceId, profile, hourIndex)
    const entry: CachedHour = {
      deviceId,
      profile,
      hourIndex,
      segments: segments.length === 0 ? EMPTY_HOUR : segments,
      readAtMs: currentReadAtMs,
    }
    this.profileMap(deviceId, profile).set(hourIndex, entry)
    this.lru.add(entry)
    if (entry.segments.length === 0) this.emptyCount += 1
    else this.segmentCount += entry.segments.length
    if (entry.readAtMs !== null) this.stampedCount += 1
    this.enforceBudget()
  }

  /**
   * Drop one camera's UTC day, every profile — what eviction changed. The read
   * stamps go with their hours; there is no second map to sweep.
   */
  invalidateDay(deviceId: number, utcDayMs: number): void {
    const firstHour = hourIndexOf(utcDayMs)
    const profiles = this.byDevice.get(deviceId)
    if (profiles === undefined) return
    for (const profile of [...profiles.keys()]) {
      for (let h = 0; h < HOURS_PER_DAY; h++) this.remove(deviceId, profile, firstHour + h)
    }
  }

  /** Full reset — a relocation re-pointed rows across locations. */
  clear(): void {
    this.byDevice.clear()
    this.lru.clear()
    this.segmentCount = 0
    this.emptyCount = 0
    this.stampedCount = 0
  }

  census(): CalendarHourCacheCensus {
    const hours = this.lru.size
    return {
      hourKeys: hours - this.emptyCount,
      emptyHours: this.emptyCount,
      hourSegments: this.segmentCount,
      segsReadAtKeys: this.stampedCount,
      evictedHours: this.evictedCount,
      approxBytes:
        hours * CALENDAR_HOUR_APPROX_BYTES +
        this.segmentCount * CALENDAR_SEGMENT_APPROX_BYTES +
        this.stampedCount * CALENDAR_READ_AT_APPROX_BYTES,
    }
  }

  private entryOf(deviceId: number, profile: string, hourMs: number): CachedHour | undefined {
    return this.byDevice.get(deviceId)?.get(profile)?.get(hourIndexOf(hourMs))
  }

  private profileMap(deviceId: number, profile: string): Map<number, CachedHour> {
    let profiles = this.byDevice.get(deviceId)
    if (profiles === undefined) {
      profiles = new Map<string, Map<number, CachedHour>>()
      this.byDevice.set(deviceId, profiles)
    }
    let hours = profiles.get(profile)
    if (hours === undefined) {
      hours = new Map<number, CachedHour>()
      profiles.set(profile, hours)
    }
    return hours
  }

  /** Remove one hour and its stamp; prune empty parents. */
  private remove(deviceId: number, profile: string, hourIndex: number): void {
    const profiles = this.byDevice.get(deviceId)
    const hours = profiles?.get(profile)
    const entry = hours?.get(hourIndex)
    if (profiles === undefined || hours === undefined || entry === undefined) return
    hours.delete(hourIndex)
    if (hours.size === 0) profiles.delete(profile)
    if (profiles.size === 0) this.byDevice.delete(deviceId)
    this.lru.delete(entry)
    if (entry.segments.length === 0) this.emptyCount -= 1
    else this.segmentCount -= entry.segments.length
    if (entry.readAtMs !== null) this.stampedCount -= 1
  }

  private enforceBudget(): void {
    const { hourBudget, segmentBudget, evictToFraction } = this.budget
    if (this.lru.size <= hourBudget && this.segmentCount <= segmentBudget) return
    const hourTarget = Math.floor(hourBudget * evictToFraction)
    const segmentTarget = Math.floor(segmentBudget * evictToFraction)
    for (const entry of this.lru) {
      if (this.lru.size <= hourTarget && this.segmentCount <= segmentTarget) return
      this.remove(entry.deviceId, entry.profile, entry.hourIndex)
      this.evictedCount += 1
    }
  }
}
