/**
 * The calendar an operator navigates: which days have footage, and which hours
 * of a day — cached, because the disk answer is expensive exactly once.
 *
 * WHY A CACHE IS THE FEATURE, NOT AN OPTIMISATION
 * ───────────────────────────────────────────────
 * Measured on the live archive (device 104) **on the FUSE share that has since
 * been retired**: the 13 directory reads behind a month of the date selector
 * took **8,511 ms cold** under load (~650 ms each) and **14 ms warm**. On the
 * SATA SSD now serving `/recordings-2` an hour directory of 345–349 files
 * lists in ~1 ms (D523), so the cold figure is stale by orders of magnitude and
 * has NOT been re-taken for this ladder. Either way the ladder is the right
 * shape — 13 reads instead of walking 258,449 files — and what makes the answer
 * instant is that it is asked once.
 *
 * And it CAN be asked once: the past is immutable. A day that holds footage
 * keeps holding it until retention removes it, and retention already goes
 * through this process — so entries invalidate on eviction, never on a timer.
 * Only the current hour is volatile, and it is re-read on demand.
 *
 * What the cache may NOT do is hold an answer for every hour anybody names.
 * A walk is clamped to the archive's oldest ledger hour and refused above a cap
 * (`calendar-window.ts`), and the exact rung is bounded like the RAM index
 * (`calendar-hour-cache.ts`) — D674, after `[0, now)` walks cached 11.9 M empty
 * hours and took the recorder down.
 *
 * Reads never block on a cold scan for a range they did not ask for: `warm`
 * runs in the background at startup so the first screen is already answered.
 */
import type { IScopedLogger } from '@camstack/types'
import {
  availabilityProfile,
  hoursWithFootage,
  profileHasFootage,
  segmentsOfHour,
  type HourSegment,
  profilesWithFootage,
} from './calendar-scan.js'
import { mergeRanges } from '../merge-ranges.js'
import type { Range } from '../types.js'
import type { RecordingIndex } from '../recording-index.js'
import {
  CalendarHourCache,
  DEFAULT_CALENDAR_HOUR_BUDGET,
  type CalendarHourBudget,
  type CalendarHourCacheCensus,
} from './calendar-hour-cache.js'
import {
  CALENDAR_MAX_WALK_HOURS,
  UNKNOWN_ARCHIVE_FLOOR,
  calendarWalk,
  type ArchiveFloor,
  type CalendarWalk,
} from './calendar-window.js'

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/**
 * UTC ms → the UTC epoch of LOCAL midnight of the day it falls in.
 *
 * The cap returns local-midnight epochs, not date strings, so the shift has to
 * survive the round trip: add the offset to land in local time, floor to the
 * day, then subtract it to get back to a real instant.
 */
export function localDayStart(epochMs: number, tzOffsetMinutes: number): number {
  const off = tzOffsetMinutes * 60_000
  return Math.floor((epochMs + off) / DAY_MS) * DAY_MS - off
}

/** Midnight UTC of the day containing `epochMs`. */
function utcDayOf(epochMs: number): number {
  return Math.floor(epochMs / DAY_MS) * DAY_MS
}

export interface CalendarIndexDeps {
  /** Recordings roots to scan, in priority order. */
  readonly roots: () => readonly string[]
  readonly logger: IScopedLogger
  /** Injected for tests; defaults to the real directory scan. */
  readonly scanHours?: (
    root: string,
    deviceId: number,
    year: number,
    month: number,
    day: number,
    knownProfile?: string,
  ) => Promise<number[]>
  /** Injected for tests; defaults to the real directory scan. */
  readonly scanSegments?: (
    root: string,
    deviceId: number,
    profile: string,
    hourStartMs: number,
  ) => Promise<HourSegment[]>
  /** Injected for tests; defaults to the real profile pick. */
  readonly pickProfile?: (root: string, deviceId: number) => Promise<string | null>
  /** Injected for tests; defaults to the real per-profile footage check. */
  readonly hasProfile?: (root: string, deviceId: number, profile: string) => Promise<boolean>
  /** Injected for tests. */
  readonly now?: () => number
  /**
   * Exact segments of one hour from the in-memory {@link RecordingIndex},
   * or `null` when that hour has not been looked at yet.
   *
   * When this returns an array (including empty), {@link CalendarIndex} does
   * NOT readdir the recordings volume. That read is the 2026-08-22 lock:
   * the timeline's 3 s current-hour TTL queued behind FUSE and the scrub
   * feeder's 8 s `locateSegment` budget expired (`segment read timeout`).
   */
  readonly indexHour?: (
    deviceId: number,
    profile: string,
    hourStartMs: number,
  ) => readonly HourSegment[] | null
  /**
   * The camera's oldest ARCHIVED hour, from the durable hour ledger (D674).
   * A walk never visits an hour below it. Absent = no floor is known, and the
   * walk is bounded by {@link CalendarIndexDeps.maxWalkHours} alone.
   */
  readonly archiveFloor?: (deviceId: number) => ArchiveFloor
  /** Injected for tests; defaults to {@link CALENDAR_MAX_WALK_HOURS}. */
  readonly maxWalkHours?: number
  /** Injected for tests; defaults to {@link DEFAULT_CALENDAR_HOUR_BUDGET}. */
  readonly hourBudget?: CalendarHourBudget
}

/**
 * Gap below which two segments are ONE range.
 *
 * Adjacent segments are written back-to-back but their recorded durations
 * under-cover the span to the next start by a few ms of rounding, so a
 * tolerance of 0 splits continuous footage into one range PER SEGMENT —
 * hundreds an hour. Measured on a real day: 88 gaps over a second, of which ~80
 * are that 1–2 s jitter. The ones that matter survive: 15 s, 23 s, and 1,011 s.
 */
const RANGE_MERGE_GAP_MS = 5_000

/**
 * Prefer the RAM index for one hour of the timeline.
 *
 * A hydrated hour is closed: the walk (or a targeted `hydrateWindow`) already
 * looked, so an empty array is a real gap, not "unknown". Write-through
 * `addSegment` rows ride along once that hour is walked — they do NOT by
 * themselves make the hour known. A recorder that just respawned at 11:04
 * has only the post-restart finalizes in RAM; treating those as the whole
 * hour would hide the 11:00–11:04 footage until the next walk (the 2026-08-22
 * deploy gap). Unknown hours still fall through to one directory read.
 */
export function hourSegmentsFromIndex(
  index: RecordingIndex,
  deviceId: number,
  profile: string,
  hourStartMs: number,
): HourSegment[] | null {
  const hour = Math.floor(hourStartMs / HOUR_MS) * HOUR_MS
  const hourEnd = hour + HOUR_MS
  if (index.hydrationOf(deviceId, hour, hourEnd) !== 'hydrated') return null
  const rows: HourSegment[] = []
  for (const s of index.segmentsStartingIn(deviceId, profile, hour, hourEnd)) {
    rows.push({ startMs: s.startMs, durMs: s.durMs, bytes: s.bytes })
  }
  return rows
}

/**
 * How long the CURRENT hour's answer may be reused.
 *
 * Not caching it at all was the first instinct — it is still being written, so
 * a cached answer could hide a segment that just landed. But the timeline polls,
 * and re-reading the live hour on every poll made a query that is normally 65 ms
 * spike to 2,405 ms whenever that read met a contended moment on the array
 * (measured: 65, 65, 65, 2405, 226).
 *
 * Segments land every 8–12 s, so three seconds of staleness at the live edge
 * cannot hide a whole one — and the live view owns "now" regardless. Past hours
 * stay cached until eviction or the rung's bound (D674) drops them; only this
 * one expires — and it is read once more after it closes, so its last minutes
 * are never served from a stamp taken while it was still being written.
 */
const CURRENT_HOUR_TTL_MS = 3_000

/**
 * How quiet the disk must be before background work takes another read.
 *
 * Background reads do not block the event loop — they are async I/O — they
 * block the ARRAY: a real request's own read queues behind them. Measured, when
 * a startup warm was still running: a directory query that costs 0.2 s took
 * **38 s**.
 *
 * That startup warm is gone (it bet on what would be asked, and the cache
 * already covers the second query). What remains is `warmAdjacent`, which is a
 * prediction from an ACTION the operator took — and it still yields.
 */
const BACKGROUND_QUIET_MS = 300

/** How often the warm re-checks whether the foreground has gone quiet. */
const BACKGROUND_POLL_MS = 100

/**
 * Directory reads in flight for one query.
 *
 * A day is 24 independent reads and a month ~32; issued one after another they
 * measured seconds, because each pays the array's full latency. Bounded,
 * because an unbounded fan-out across devices and days becomes exactly the
 * contention it is meant to avoid — that is what the startup warm did.
 */
const READ_CONCURRENCY = 8

/** `Promise.all` with a ceiling on how many run at once. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      const item = items[i]
      if (item === undefined) return
      out[i] = await fn(item)
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * What {@link CalendarIndex.memoryCensus} reports: the day rung's counts, the
 * exact rung's (see {@link CalendarHourCacheCensus}), and an `approxBytes` for
 * the whole calendar — the figure that says whether this is where the heap went.
 */
export interface CalendarIndexCensus extends CalendarHourCacheCensus {
  readonly devices: number
  readonly days: number
  readonly inFlight: number
}

/** Estimated bytes per cached UTC day on the day rung (map slot + a short
 *  array of hour numbers). */
const DAY_RUNG_APPROX_BYTES = 96

/** Hours (UTC, 0–23) known to hold footage for one UTC day. */
type DayHours = readonly number[]

/** One hour's answer, and whether every root was actually read. */
interface HourScan {
  readonly segments: readonly HourSegment[]
  readonly complete: boolean
}

export class CalendarIndex {
  /** `deviceId` → (UTC day ms → hours). Absent = never scanned. */
  private readonly byDevice = new Map<number, Map<number, DayHours>>()
  /** Scans in flight, so a burst of queries costs one walk. */
  private readonly inFlight = new Map<string, Promise<DayHours>>()
  /** The exact rung: device → profile → hour → segments, bounded (D674). */
  private readonly hours: CalendarHourCache
  /** Hour scans in flight, keyed like the rung — so a burst costs one read. */
  private readonly segsInFlight = new Map<number, Map<string, Map<number, Promise<HourScan>>>>()
  private segsInFlightCount = 0
  /** The profile availability reads from, resolved once per device. */
  private readonly profileFor = new Map<number, string>()
  private readonly profilesFor = new Map<number, readonly string[]>()
  private readonly profilesInFlight = new Map<number, Promise<readonly string[]>>()
  /** `deviceId:profile` → whether the device records that profile, resolved
   *  once. Same stability trade as {@link profileFor}: a config change that
   *  adds a profile mid-session is picked up on restart, not on a timer. */
  private readonly recordsProfile = new Map<string, boolean>()
  private readonly recordsInFlight = new Map<string, Promise<boolean>>()
  /** When the last FOREGROUND scan ran, so background work can yield to it. */
  private lastForegroundAt = 0
  private readonly profileInFlight = new Map<number, Promise<string | null>>()

  constructor(private readonly deps: CalendarIndexDeps) {
    this.hours = new CalendarHourCache(deps.hourBudget ?? DEFAULT_CALENDAR_HOUR_BUDGET)
  }

  /**
   * Entry counts and an estimated byte total for the recorder census. The
   * exact rung is bounded (D674); `evictedHours` says whether the bound bites.
   */
  memoryCensus(): CalendarIndexCensus {
    let days = 0
    for (const perDay of this.byDevice.values()) days += perDay.size
    const hours = this.hours.census()
    return {
      devices: this.byDevice.size,
      days,
      ...hours,
      approxBytes: hours.approxBytes + days * DAY_RUNG_APPROX_BYTES,
      inFlight: this.inFlight.size + this.segsInFlightCount,
    }
  }

  private nowMs(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /**
   * The hours a walk over `[fromMs, toMs)` may visit — clamped to the archive
   * floor and the live edge, REFUSED above the cap (see `calendar-window.ts`).
   * Throws {@link CalendarWindowRefusedError}; the provider turns that into
   * `read: 'unreadable'` and logs it.
   */
  private walkOf(deviceId: number, fromMs: number, toMs: number): CalendarWalk | null {
    return calendarWalk(
      deviceId,
      fromMs,
      toMs,
      this.nowMs(),
      this.deps.archiveFloor?.(deviceId) ?? UNKNOWN_ARCHIVE_FLOOR,
      this.deps.maxWalkHours ?? CALENDAR_MAX_WALK_HOURS,
    )
  }

  private mapFor(deviceId: number): Map<number, DayHours> {
    let m = this.byDevice.get(deviceId)
    if (!m) {
      m = new Map<number, DayHours>()
      this.byDevice.set(deviceId, m)
    }
    return m
  }

  /**
   * Hours of one UTC day that hold footage.
   *
   * Cached, EXCEPT the day containing "now": its last hour is still being
   * written, so a cached answer would hide footage that has just appeared.
   */
  async hoursOfUtcDay(deviceId: number, utcDayMs: number, background = false): Promise<DayHours> {
    if (!background) this.lastForegroundAt = this.deps.now?.() ?? Date.now()
    const day = utcDayOf(utcDayMs)
    const now = this.deps.now?.() ?? Date.now()
    const isToday = day === utcDayOf(now)
    const cached = this.mapFor(deviceId).get(day)
    if (cached !== undefined && !isToday) return cached

    const key = `${deviceId}:${day}`
    const running = this.inFlight.get(key)
    if (running) return running

    const scan = this.scanDay(deviceId, day)
    this.inFlight.set(key, scan)
    try {
      const hours = await scan
      this.mapFor(deviceId).set(day, hours)
      return hours
    } finally {
      if (this.inFlight.get(key) === scan) this.inFlight.delete(key)
    }
  }

  private async scanDay(deviceId: number, utcDayMs: number): Promise<DayHours> {
    const d = new Date(utcDayMs)
    const scan = this.deps.scanHours ?? hoursWithFootage
    // Resolved ONCE per device. Letting each day re-derive it added ~90 reads
    // to a month and left a fully warm date-selector query at 1,624 ms.
    const profile = (await this.availabilityProfileFor(deviceId)) ?? undefined
    const merged = new Set<number>()
    for (const root of this.deps.roots()) {
      try {
        const hours = await scan(
          root,
          deviceId,
          d.getUTCFullYear(),
          d.getUTCMonth() + 1,
          d.getUTCDate(),
          profile,
        )
        for (const h of hours) merged.add(h)
      } catch (err: unknown) {
        this.deps.logger.warn('calendar: day scan failed', {
          tags: { deviceId },
          meta: { root, utcDayMs, error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
    return [...merged].sort((a, b) => a - b)
  }

  /**
   * The operator's LOCAL days in `[fromMs, toMs)` that hold footage.
   *
   * Widened by a UTC day at each end: a local day at either edge is fed by a
   * UTC day outside the range (23:30Z on the 28th is the 29th in CEST).
   */
  async localDays(
    deviceId: number,
    fromMs: number,
    toMs: number,
    tzOffsetMinutes: number,
  ): Promise<number[]> {
    // The same floor and cap as the exact rung (D674): a day before the
    // archive's oldest hour cannot hold footage, and a day rung entry per day
    // since 1970 is the same mistake on a coarser grid.
    const walk = this.walkOf(deviceId, utcDayOf(fromMs) - DAY_MS, utcDayOf(toMs) + 2 * DAY_MS)
    if (walk === null) return []
    const first = utcDayOf(walk.firstHourMs)
    const last = utcDayOf(walk.endMs - 1)
    const wanted: number[] = []
    for (let day = first; day <= last; day += DAY_MS) wanted.push(day)

    // In bounded parallel, not one after another. A month is ~32 independent
    // directory reads and the array hides most of their latency when several
    // are in flight; sequentially the same query measured seconds. Bounded
    // because unbounded fan-out becomes the contention it is trying to avoid.
    const perDay = await mapBounded(wanted, READ_CONCURRENCY, async (day) => ({
      day,
      hours: await this.hoursOfUtcDay(deviceId, day),
    }))

    const days = new Set<number>()
    for (const { day, hours } of perDay) {
      for (const h of hours) {
        const at = day + h * HOUR_MS
        if (at < fromMs || at >= toMs) continue
        days.add(localDayStart(at, tzOffsetMinutes))
      }
    }
    return [...days].sort((a, b) => a - b)
  }

  /**
   * Drop what eviction changed. Retention is the ONLY thing that makes a past
   * day stop holding footage, and it runs in this process — which is why these
   * entries can be cached indefinitely rather than expired on a timer.
   */
  /** Full reset — a relocation re-pointed index rows across locations, so
   *  every cached day/hour derivation may now be stale. Cheap: the caches
   *  rebuild lazily on the next question. */
  invalidateAll(): void {
    this.byDevice.clear()
    this.hours.clear()
  }

  invalidate(deviceId: number, atMs: number): void {
    const day = utcDayOf(atMs)
    this.byDevice.get(deviceId)?.delete(day)
    // BOTH rungs. Dropping only the hour list would leave the exact ranges
    // showing footage the eviction just deleted — the timeline would draw a
    // bar over nothing, which is worse than the gap it replaced. The exact
    // rung is keyed device → profile → hour, so this is `profiles × 24`
    // deletes — it used to scan every key in the process (11.9 M on
    // 2026-09-28) once per evicted (device, day).
    this.hours.invalidateDay(deviceId, day)
  }

  /**
   * Scan a span in the background so the first screen is already answered.
   *
   * Startup runs this instead of waiting on the archive-wide walk: ~13 cold
   * directory reads per month against 258,449 files, and it answers the
   * question the operator actually asks first.
   *
   * Also used to warm the days ADJACENT to one being viewed — changing day is a
   * single click and the operator expects the summary to be there. That warm
   * belongs in the background: a cold read costs whatever the array charges
   * that day (see the header — the ~650 ms figure is from the retired FUSE
   * share), and doing it inline would only move the wait onto the click.
   */
  async warm(deviceId: number, fromMs: number, toMs: number): Promise<void> {
    for (let day = utcDayOf(fromMs); day <= utcDayOf(toMs); day += DAY_MS) {
      await this.awaitQuiet()
      await this.hoursOfUtcDay(deviceId, day, true)
    }
  }

  /**
   * Hold background work until the foreground has been quiet.
   *
   * This is the whole point of the background flag: warming must never be the
   * reason an operator's query waits on the array.
   */
  async awaitQuiet(): Promise<void> {
    for (;;) {
      const now = this.deps.now?.() ?? Date.now()
      if (now - this.lastForegroundAt >= BACKGROUND_QUIET_MS) return
      await new Promise((r) => setTimeout(r, BACKGROUND_POLL_MS))
    }
  }

  /** A day's exact ranges, taken as BACKGROUND work — yields to any query. */
  async warmDayRanges(deviceId: number, profile: string, utcDayMs: number): Promise<void> {
    const day = utcDayOf(utcDayMs)
    for (let h = 0; h < 24; h++) {
      await this.awaitQuiet()
      await this.segmentsOf(deviceId, profile, day + h * HOUR_MS, true)
    }
  }

  /**
   * The segments of one hour, exact, cached.
   *
   * As with days, the CURRENT hour is never cached: it is still being written.
   */
  async segmentsOf(
    deviceId: number,
    profile: string,
    hourStartMs: number,
    background = false,
  ): Promise<readonly HourSegment[]> {
    return (await this.segmentsOfChecked(deviceId, profile, hourStartMs, background)).segments
  }

  /**
   * `segmentsOf`, stating whether the answer is COMPLETE — every root's
   * directory was actually read. A root that throws yields a partial answer,
   * and a partial answer must never be cached (it would serve a root's missing
   * footage as "none" until eviction) nor claimed as looked-at on the wire:
   * the directory route's `hydrated` flag derives from this, so the client
   * retries instead of caching a gap.
   */
  async segmentsOfChecked(
    deviceId: number,
    profile: string,
    hourStartMs: number,
    background = false,
  ): Promise<HourScan> {
    if (!background) this.lastForegroundAt = this.nowMs()
    const hour = Math.floor(hourStartMs / HOUR_MS) * HOUR_MS
    const fromIndex = this.deps.indexHour?.(deviceId, profile, hour)
    if (fromIndex !== null && fromIndex !== undefined) {
      return { segments: fromIndex, complete: true }
    }
    const now = this.nowMs()
    const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS
    const isCurrentHour = hour === currentHour
    const cached = this.hours.get(deviceId, profile, hour)
    if (cached !== undefined) {
      // Cached ⟹ complete: a partial scan is never stored. An hour stored
      // while it was CURRENT still carries its read stamp: once it has closed
      // that answer may be missing its last minutes, so it is read once more.
      const readAt = this.hours.readAtOf(deviceId, profile, hour)
      if (!isCurrentHour && readAt === undefined) return { segments: cached, complete: true }
      if (isCurrentHour && now - (readAt ?? 0) < CURRENT_HOUR_TTL_MS) {
        return { segments: cached, complete: true }
      }
    }

    const running = this.inFlightScan(deviceId, profile, hour)
    if (running) return running

    const scan = (async (): Promise<HourScan> => {
      const read = this.deps.scanSegments ?? segmentsOfHour
      const merged: HourSegment[] = []
      let complete = true
      for (const root of this.deps.roots()) {
        try {
          merged.push(...(await read(root, deviceId, profile, hour)))
        } catch (err: unknown) {
          complete = false
          this.deps.logger.warn('calendar: hour scan failed', {
            tags: { deviceId },
            meta: { root, hour, error: err instanceof Error ? err.message : String(err) },
          })
        }
      }
      return { segments: merged.sort((a, b) => a.startMs - b.startMs), complete }
    })()
    this.trackScan(deviceId, profile, hour, scan)
    try {
      const { segments, complete } = await scan
      const storedAt = this.nowMs()
      const liveHour = Math.floor(storedAt / HOUR_MS) * HOUR_MS
      // A FUTURE hour is answered, never cached: it would be served empty
      // after it filled. Only the current hour carries a read stamp.
      if (complete && hour <= liveHour) {
        this.hours.set(deviceId, profile, hour, segments, hour === liveHour ? storedAt : null)
      }
      return { segments, complete }
    } finally {
      this.untrackScan(deviceId, profile, hour, scan)
    }
  }

  private inFlightScan(deviceId: number, profile: string, hour: number): Promise<HourScan> | null {
    return this.segsInFlight.get(deviceId)?.get(profile)?.get(hour) ?? null
  }

  private trackScan(
    deviceId: number,
    profile: string,
    hour: number,
    scan: Promise<HourScan>,
  ): void {
    let profiles = this.segsInFlight.get(deviceId)
    if (profiles === undefined) {
      profiles = new Map<string, Map<number, Promise<HourScan>>>()
      this.segsInFlight.set(deviceId, profiles)
    }
    let hours = profiles.get(profile)
    if (hours === undefined) {
      hours = new Map<number, Promise<HourScan>>()
      profiles.set(profile, hours)
    }
    hours.set(hour, scan)
    this.segsInFlightCount += 1
  }

  private untrackScan(
    deviceId: number,
    profile: string,
    hour: number,
    scan: Promise<HourScan>,
  ): void {
    const profiles = this.segsInFlight.get(deviceId)
    const hours = profiles?.get(profile)
    if (profiles === undefined || hours === undefined || hours.get(hour) !== scan) return
    hours.delete(hour)
    this.segsInFlightCount -= 1
    if (hours.size === 0) profiles.delete(profile)
    if (profiles.size === 0) this.segsInFlight.delete(deviceId)
  }

  /**
   * Exact availability ranges for a UTC day — what the progressive timeline
   * draws.
   *
   * ONE profile. The timeline is a single bar, so per-profile detail buys
   * nothing and triples the reads: measured 75 reads / 16,028 ms against 25
   * reads / 1,489 ms cold, 19 ms warm.
   *
   * Hour granularity cannot stand in for this: a real day holds a 1,011 s gap,
   * and the hour containing it would render solid.
   */
  async dayRanges(deviceId: number, profile: string, utcDayMs: number): Promise<Range[]> {
    const day = utcDayOf(utcDayMs)
    const hours = Array.from({ length: 24 }, (_, h) => day + h * HOUR_MS)
    const perHour = await mapBounded(hours, READ_CONCURRENCY, (hour) =>
      this.segmentsOf(deviceId, profile, hour),
    )
    return mergeRanges(perHour.flat(), RANGE_MERGE_GAP_MS)
  }

  /**
   * Exact ranges of `[fromMs, toMs)`, scanning ONLY the hours the window
   * overlaps.
   *
   * `dayRanges` always walks 24 hours. The theater asks for a lookback of a
   * couple of hours, then every 30 s poll (and every scrub that extends
   * lookback) called that full-day walk PLUS `warmAdjacent` (48 more hours)
   * on the same FUSE share the feeder was reading. 2026-08-22 15:50Z: locate
   * was 3 ms from RAM, the .m4s read hit `segment read timeout`.
   */
  async rangesIn(
    deviceId: number,
    profile: string,
    fromMs: number,
    toMs: number,
  ): Promise<Range[]> {
    if (toMs <= fromMs) return []
    // Clamped to the archive floor and the live edge, refused above the cap
    // (D674): `[0, now)` used to be 497,408 hours, each one scanned and cached.
    const walk = this.walkOf(deviceId, fromMs, toMs)
    if (walk === null) return []
    const hours: number[] = []
    for (let hour = walk.firstHourMs; hour < walk.endMs; hour += HOUR_MS) hours.push(hour)
    const perHour = await mapBounded(hours, READ_CONCURRENCY, (hour) =>
      this.segmentsOf(deviceId, profile, hour),
    )
    const ranges: Range[] = []
    for (const r of mergeRanges(perHour.flat(), RANGE_MERGE_GAP_MS)) {
      if (r.endMs <= fromMs || r.startMs >= toMs) continue
      ranges.push({
        startMs: Math.max(r.startMs, fromMs),
        endMs: Math.min(r.endMs, toMs),
      })
    }
    return ranges
  }

  /**
   * Warm the days either side of the one being viewed, in the BACKGROUND.
   *
   * Changing day is one click and the operator expects the timeline to be
   * there. At ~1.5 s for a cold day this belongs off the critical path — doing
   * it inline would only move the wait onto the day they are already looking at.
   */
  warmAdjacent(deviceId: number, profile: string, utcDayMs: number): void {
    const day = utcDayOf(utcDayMs)
    for (const d of [day - DAY_MS, day + DAY_MS]) {
      void this.warmDayRanges(deviceId, profile, d).catch(() => {
        // Warming is best-effort; a failure is retried when the day is opened.
      })
    }
  }

  /**
   * The lowest profile the device actually records to, resolved once.
   *
   * De-duplicated in flight, not merely cached: the day sweep now runs eight
   * reads at a time and they ALL ask for the profile before the first answer
   * lands, so a cache alone let the pick run eight times. Parallelism found it.
   */
  /**
   * Every profile this camera holds footage in, across every root — cached
   * like the pick, because it is the same shallow read (D433).
   *
   * {@link availabilityProfileFor} answers with ONE; this says what the one
   * was chosen FROM, so a caller cannot mistake the timeline's single bar for
   * the whole archive.
   */
  async profilesWithFootageFor(deviceId: number): Promise<readonly string[]> {
    const cached = this.profilesFor.get(deviceId)
    if (cached !== undefined) return cached
    const running = this.profilesInFlight.get(deviceId)
    if (running) return running
    const resolve = (async (): Promise<readonly string[]> => {
      const found = await profilesWithFootage(this.deps.roots(), deviceId)
      this.profilesFor.set(deviceId, found)
      return found
    })()
    this.profilesInFlight.set(deviceId, resolve)
    try {
      return await resolve
    } finally {
      if (this.profilesInFlight.get(deviceId) === resolve) this.profilesInFlight.delete(deviceId)
    }
  }

  async availabilityProfileFor(deviceId: number): Promise<string | null> {
    const cached = this.profileFor.get(deviceId)
    if (cached !== undefined) return cached
    const running = this.profileInFlight.get(deviceId)
    if (running) return running

    const resolve = (async (): Promise<string | null> => {
      for (const root of this.deps.roots()) {
        const pick = await (this.deps.pickProfile ?? availabilityProfile)(root, deviceId)
        if (pick !== null) {
          this.profileFor.set(deviceId, pick)
          return pick
        }
      }
      return null
    })()
    this.profileInFlight.set(deviceId, resolve)
    try {
      return await resolve
    } finally {
      if (this.profileInFlight.get(deviceId) === resolve) this.profileInFlight.delete(deviceId)
    }
  }

  /**
   * The profile the directory serves for a request: the one ASKED for when the
   * device records it, else the availability pick. The CSD1 payload states
   * which was served, so a fallback is visible to the client, never silent.
   */
  async servedProfileFor(deviceId: number, requested?: string): Promise<string | null> {
    if (requested === undefined || requested === '') {
      return this.availabilityProfileFor(deviceId)
    }
    const key = `${deviceId}:${requested}`
    const cached = this.recordsProfile.get(key)
    if (cached !== undefined) {
      return cached ? requested : this.availabilityProfileFor(deviceId)
    }
    const running = this.recordsInFlight.get(key)
    const records =
      running !== undefined
        ? await running
        : await (async () => {
            const probe = (async (): Promise<boolean> => {
              const check = this.deps.hasProfile ?? profileHasFootage
              for (const root of this.deps.roots()) {
                if (await check(root, deviceId, requested)) return true
              }
              return false
            })()
            this.recordsInFlight.set(key, probe)
            try {
              const r = await probe
              this.recordsProfile.set(key, r)
              return r
            } finally {
              if (this.recordsInFlight.get(key) === probe) this.recordsInFlight.delete(key)
            }
          })()
    return records ? requested : this.availabilityProfileFor(deviceId)
  }
}
