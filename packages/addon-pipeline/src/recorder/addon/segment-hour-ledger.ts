/**
 * SegmentHourLedger — the durable ACCOUNT of what the recorder's archive holds.
 *
 * `RecordingIndex` stays RAM: it is the read surface for playback, retention
 * and eviction, and a gate that consulted SQLite would fail when SQLite is slow
 * (D49). What this file owns is the durable answer to **how much** footage
 * exists, bucketed per hour and indexed, so "what is on this disk" is a
 * `SUM`/`MIN`/`MAX` rather than a recursive walk over ~1.6 M `.m4s` files.
 *
 * ## Two authorities, and which is which (D523)
 *
 * - **The DIRECTORY TREE is the authority for WHICH segments exist.** A segment
 *   file's NAME carries everything about it (`<startMs>-<durMs>-<bytes>.m4s`
 *   under `<dev>/<profile>/Y/M/D/H/`), so a `readdir` of one hour bucket is a
 *   complete, self-describing answer about that hour — and a directory cannot
 *   be SHORT about itself. Every caller that needs the actual file names lists
 *   the hour ({@link HourLister}).
 * - **This table is the authority for HOW MUCH exists.** Four aggregate columns
 *   per hour — `bytes`, `segments`, `minStartMs`, `maxStartMs` — because "the
 *   oldest segments across this location domain" is a global ordered aggregate
 *   no `readdir` can answer without reading everything (a recursive walk over
 *   258 449 files for ONE device measured 68 s).
 *
 * The table used to carry a `paths` column as well, and that column was the
 * failure: a row missing the segments a torn-down writer never persisted seeded
 * the RAM index as COMPLETE, and nothing ever listed the directory again. It is
 * gone (D523), and with it the two-tier mirror D287 built to keep it out of
 * boot and the gzip codec that made it smaller.
 *
 * ## Granularity
 *
 * One row per hour-directory (`<dev>/<profile>/Y/M/D/H`). The path convention
 * already buckets that way and ~1.6 M 10 s segments collapse to a few thousand
 * hour rows — which is also why the whole table now fits in the boot load with
 * no projection and no second tier: a row is ten scalars.
 *
 * ## Failure direction
 *
 * Empty or corrupt ledger → hydrate nothing, hours stay `unknown`, the window
 * walk fills the index from the array. A listing that FAILS decides nothing:
 * the hour is skipped and said out loud, never reported as an hour holding
 * nothing. Deletes are confirmed only by an explicit eviction or by a trusted
 * walk — D148: never cancel from the ledger alone.
 */

import type { IScopedLogger, SettingsStoreClient } from '@camstack/types'
import {
  declareDurableLegacyCollection,
  durableLegacyKind,
} from '../../durable/durable-legacy-kind-handle.js'
import { DurableLedger, type DurableLedgerSpec } from '../../durable/durable-ledger.js'
import type { RecordingIndex } from '../recording-index.js'
import { parseSegmentPath } from '../segment-path.js'
import type {
  Accounting,
  ArchiveCensus,
  ArchiveDeviceUsage,
  ArchiveScope,
  FootageArchive,
  OldestSegments,
  RelocatedSegment,
  SegmentRow,
} from '../types.js'

const HOUR_MS = 3_600_000

/** `Math.min` where a missing left operand means "nothing yet", not `NaN`. */
function minOf(a: number | null, b: number): number {
  return a === null ? b : Math.min(a, b)
}

/** `Math.max` with the same rule as {@link minOf}. */
function maxOf(a: number | null, b: number): number {
  return a === null ? b : Math.max(a, b)
}

/**
 * The compiled predicate half of an {@link ArchiveScope}.
 *
 * Named rather than inlined so {@link SegmentHourLedger.predicate} has ONE
 * return shape both the census and the stream spread into their filters — a
 * scope that narrows the census but not the stream would make "N of M" compare
 * two different archives.
 */
interface ArchivePredicate {
  readonly where: Record<string, unknown>
  readonly whereIn?: Record<string, unknown[]>
}

/** What the settings store's `query` answers with — named off the client so a
 *  change to the record shape lands here as a type error, not a cast. */
export type SettingsQueryRecords = Awaited<ReturnType<SettingsStoreClient['query']['query']>>

/**
 * A directory read of ONE hour bucket: the location-relative paths it holds
 * (`<dev>/<profile>/Y/M/D/H/<start>-<dur>-<bytes>.m4s`), oldest-first or not.
 *
 * This is the ledger's whole connection to the array, and it exists because the
 * table no longer names files (D523). Since the segment NAME carries start,
 * duration and bytes, a listing is a complete description of the hour — no file
 * is ever opened.
 *
 * `null` is "this directory could not be read", which every caller here turns
 * into "this hour takes no part in this pass", said out loud with the camera's
 * tag. It is deliberately distinct from `[]`, "the directory answered and holds
 * nothing" — reporting the first as the second is how a pass that could not
 * reach a disk deletes an operator's index of real footage (D148, D393).
 */
export type HourLister = (
  locationId: string,
  deviceId: number,
  profile: string,
  hourStartMs: number,
) => Promise<readonly string[] | null>

const macrotask = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve)
  })

/**
 * @durable class=mirror owner=recorder
 *   write="write-behind on every finalized segment (hour-row upsert, serialised per hour); the writer SEALS the hour it leaves (one write per hour); a listing of a closed hour re-derives the aggregate and seals; eviction and relocation shrink it"
 *   retention="a row goes when the walk or eviction confirms the hour is empty — never by age, never from the ledger alone (D148)"
 */
export const RECORDING_SEGMENT_HOURS_COLLECTION = 'recorder:segment-hours'

/**
 * The four aggregate columns are what this table IS (D523).
 *
 * They exist so "how much footage is on this disk" is a `SUM`/`MIN`/`MAX` over
 * ~19 k hour rows instead of a walk over ~7.1 M in-RAM segment rows, and they
 * are derived from segment NAMES — by {@link withSegmentPath} and nothing else.
 * {@link hourAggregate} is that step over a whole listing and
 * {@link appendSegmentPath} is that step over the one path that just arrived,
 * so there is no second derivation to drift.
 */
export const RECORDING_SEGMENT_HOURS_COLUMNS = [
  { name: 'key', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'deviceId', type: 'INTEGER' as const, notNull: true },
  { name: 'profile', type: 'TEXT' as const, notNull: true },
  { name: 'locationId', type: 'TEXT' as const, notNull: true },
  { name: 'hourStartMs', type: 'INTEGER' as const, notNull: true },
  { name: 'bytes', type: 'INTEGER' as const, notNull: true, defaultValue: 0 },
  { name: 'segments', type: 'INTEGER' as const, notNull: true, defaultValue: 0 },
  { name: 'minStartMs', type: 'INTEGER' as const, notNull: true, defaultValue: 0 },
  { name: 'maxStartMs', type: 'INTEGER' as const, notNull: true, defaultValue: 0 },
  /** {@link SegmentHourRow.sealed}, as 0/1. A row written before the column
   *  existed reads 0 — unsealed — which is the direction that costs one
   *  directory read, never a missing hour. */
  { name: 'sealed', type: 'INTEGER' as const, notNull: true, defaultValue: 0 },
] as const

export const RECORDING_SEGMENT_HOURS_INDEXES = [
  { name: 'idx_recorder_segment_hours_device', columns: ['deviceId'] as const },
  { name: 'idx_recorder_segment_hours_hour', columns: ['hourStartMs'] as const },
  /** The eviction read: one oldest-first stream across a SET of location ids.
   *  Location leads so `locationId IN (…)` is a range scan and `hourStartMs`
   *  supplies the order without a sort. */
  {
    name: 'idx_recorder_segment_hours_loc_hour',
    columns: ['locationId', 'hourStartMs'] as const,
  },
  /**
   * The accounting read: `SUM(bytes)`, `SUM(segments)`, `MIN(minStartMs)`,
   * `MAX(maxStartMs)` over `locationId IN (…)` — one row back, and with this
   * index not one table row read to produce it (D447).
   *
   * Since D523 dropped `paths` the table row is ten scalars, so the covering
   * index no longer saves ~30 KB of page per row; it still saves the row
   * fetch, and the accounting read is the one this hub runs on a schedule.
   */
  {
    name: 'idx_recorder_segment_hours_loc_accounting',
    columns: ['locationId', 'bytes', 'segments', 'minStartMs', 'maxStartMs'] as const,
  },
] as const

export interface SegmentHourRow {
  readonly key: string
  readonly deviceId: number
  readonly profile: string
  readonly locationId: string
  readonly hourStartMs: number
  /**
   * Has this row's aggregate been vouched for by a party that could know? (D451)
   *
   * `true` once the writer that owned the hour LEFT it — the next hour's first
   * finalize, or a graceful stop — with every finalize it handed this ledger
   * persisted; or once a listing of the CLOSED hour has re-derived it. `false`
   * is a legitimate, readable answer: "this is what had been accounted for when
   * the writer was last heard from". The adoption sweep lists an unsealed
   * closed hour once and seals it.
   *
   * Eviction and relocation CLEAR it: a row they shrank is again only as good
   * as the arithmetic that shrank it, and a listing re-derives it for free the
   * next time anything walks the hour.
   */
  readonly sealed: boolean
  /** Derived from the hour's segment names by {@link withSegmentPath}. Never
   *  set by a caller. */
  readonly bytes: number
  readonly segments: number
  readonly minStartMs: number
  readonly maxStartMs: number
}

/** What a disk listing's adoption into a closed hour did — the caller's log
 *  line. */
export interface WalkedHourOutcome {
  /** The ledger held no row for this hour before the walk. */
  readonly created: boolean
  /** Segments the array held that the row had not accounted for. Never
   *  negative: a listing that came back SHORTER is reported as `0` added and
   *  named in its own line. */
  readonly added: number
  /** This call is what sealed the row. */
  readonly sealedNow: boolean
}

/** The hour a (device, profile) writer was last seen appending to. */
interface WriterHour {
  readonly key: string
  readonly deviceId: number
  readonly profile: string
  readonly locationId: string
  readonly hourStartMs: number
  /**
   * `startMs` of the FIRST segment this process finalized into the hour — how
   * far into the hour this writer arrived. Taken from the segment's own name,
   * never from a clock: watcher latency, a saturated lane and a slow store all
   * delay the FINALIZE and none of them changes when the media began.
   */
  readonly entryMs: number
}

/**
 * How far into an hour a writer's first finalize may land and the writer still
 * be the party that KNOWS what the hour holds (D521).
 *
 * A seal is a claim of completeness. A writer that was running across the hour
 * boundary produces its first in-hour segment within ONE segment length of the
 * boundary — the segment that straddles it belongs to the previous hour by its
 * `startMs`. So the grace is one segment length at the longest anyone
 * configures here (60 s), plus 30 s for a keyframe-cut segment overrunning its
 * nominal `-segment_time` (ffmpeg cuts on the next GOP, never on the clock).
 *
 * It is a guess, and this is the shape of being wrong in each direction.
 * TIGHTER: a normal rollover stops sealing and every hour of the archive is
 * listed once by the adoption sweep — at ~1 ms per hour directory on this hub's
 * SATA SSD, affordable but pointless. LOOSER: a runner respawn inside the
 * window seals an hour it entered late, which is exactly the 2026-09-17 defect;
 * the observed hole there was ~29 minutes, so anything under a few minutes
 * would have caught it and 90 s is the smallest number that does not fire on a
 * legitimate rollover.
 */
export const WRITER_HOUR_ENTRY_GRACE_MS = 90_000

/**
 * A stretch of a (device, profile) writer's output that never reached this
 * ledger — the watcher's `rolledOff`, which is the moment the system KNOWS
 * finalizes were missed.
 *
 * `fromMs`/`toMs` bound the MEDIA the loss covers, not when it was noticed.
 */
export interface RefusedWriterSpan {
  readonly deviceId: number
  readonly profile: string
  readonly fromMs: number
  readonly toMs: number
  /** Segments the reporter knows it skipped — for the log line only. */
  readonly count: number
}

/**
 * Hours ONE reported loss may mark unsealed.
 *
 * A span is estimated (the reporter knows how many entries it rolled past, and
 * the playlist's own segment lengths), so it can be wrong; a wrong span that is
 * too WIDE costs one directory read per hour it names, and one that is too
 * narrow costs an aggregate left short. The bound keeps a nonsense span — a
 * clock jump, a malformed playlist — from marking a day of archive for
 * re-reading.
 */
export const REFUSED_SPAN_MAX_HOURS = 24

/** The listing-derived half of a {@link SegmentHourRow}. */
export interface HourAggregate {
  readonly bytes: number
  readonly segments: number
  readonly minStartMs: number
  readonly maxStartMs: number
}

/** The identity of the {@link hourAggregate} fold — an hour holding nothing. */
export const EMPTY_HOUR_AGGREGATE: HourAggregate = {
  bytes: 0,
  segments: 0,
  minStartMs: 0,
  maxStartMs: 0,
}

/**
 * ONE path folded into an aggregate — the whole derivation, expressed as its
 * single step.
 *
 * {@link hourAggregate} is this step over a whole listing, and {@link
 * SegmentHourLedger.recordSegment} is this step over the one path that just
 * arrived. That is not two implementations that happen to agree: the full
 * derivation is *defined* as this function repeated, so an append is the fold
 * resumed from the state the held row already carries.
 *
 * Why it had to become a step: `recordSegment` re-derived the whole hour on
 * every finalize. Σ1..360 ≈ 65 k path parses per camera-profile-hour at 10 s
 * segments, Σ1..1708 ≈ 1.46 M in the restart-storm hours of 2026-08-29, at
 * ~3.4 finalizes/s fleet-wide, forever.
 *
 * A path the parser refuses contributes nothing — it is not a segment, and
 * counting it would inflate a disk report. `segments === 0` is the first-path
 * sentinel for min/max, so an aggregate with no segments carries 0/0 rather
 * than a sentinel nobody can compare against.
 */
export function withSegmentPath(agg: HourAggregate, path: string): HourAggregate {
  const p = parseSegmentPath(path)
  if (p === null) return agg
  return {
    bytes: agg.bytes + p.bytes,
    segments: agg.segments + 1,
    minStartMs: agg.segments === 0 || p.startMs < agg.minStartMs ? p.startMs : agg.minStartMs,
    maxStartMs: agg.segments === 0 || p.startMs > agg.maxStartMs ? p.startMs : agg.maxStartMs,
  }
}

/**
 * Bytes / count / oldest / newest for one hour's LISTING — the sole FULL
 * derivation, and since D523 the only thing that can produce an EXACT row.
 *
 * Every field of a segment path encodes its own facts (`parseSegmentPath`), so
 * this is a derivation, not a measurement: it can never disagree with the
 * listing it was computed from.
 */
export function hourAggregate(paths: readonly string[]): HourAggregate {
  let agg = EMPTY_HOUR_AGGREGATE
  for (const path of paths) agg = withSegmentPath(agg, path)
  return agg
}

/** The identity half of a {@link SegmentHourRow} — everything a caller supplies
 *  that is not derived from segment names. */
export interface SegmentHourIdentity {
  readonly key: string
  readonly deviceId: number
  readonly profile: string
  readonly locationId: string
  readonly hourStartMs: number
}

/** The half of a {@link SegmentHourRow} a caller supplies, plus the LISTING the
 *  aggregate half is derived from. */
export interface SegmentHourRowBase extends SegmentHourIdentity {
  /** The hour's segment names. Folded into the aggregate and NOT stored — the
   *  directory keeps them (D523). */
  readonly paths: readonly string[]
  /** Absent ⇒ unsealed: the direction that costs one directory read. */
  readonly sealed?: boolean
}

/** Build the persisted row for an hour from a LISTING of it — the ONE
 *  constructor that can produce an exact aggregate. */
export function segmentHourRow(base: SegmentHourRowBase): SegmentHourRow {
  const { paths, sealed, ...identity } = base
  return { ...identity, sealed: sealed ?? false, ...hourAggregate(paths) }
}

/**
 * Build the persisted row for an hour from an aggregate somebody already folded
 * — a relocation moving one, or a listing that has already been reduced.
 *
 * `sealed` is a NAMED field and never a positional boolean, because
 * `scripts/check-seal-authority.ts` attributes every literal `sealed: true` in
 * the recorder to the method that wrote it. A seal smuggled in as a third
 * argument is a seal the guard cannot see.
 */
export function hourRowOf(identity: SegmentHourIdentity, row: SealedHourAggregate): SegmentHourRow {
  return { ...identity, ...row }
}

/** An aggregate plus the claim about whether it is complete. */
export interface SealedHourAggregate extends HourAggregate {
  readonly sealed: boolean
}

/**
 * The row an hour becomes when ONE more path joins it.
 *
 * Identical to `segmentHourRow({ …held, paths: [...everything, path] })` and
 * strictly cheaper: the aggregate half of `held` is already the fold over the
 * hour's names, so this resumes that fold instead of restarting it. The
 * equality is not an assumption — `segment-hour-append.spec.ts` pins it on
 * generated hours including out-of-order arrival, duplicate paths, unparseable
 * paths and storm-sized hours.
 */
export function appendSegmentPath(held: SegmentHourRow, path: string): SegmentHourRow {
  const { bytes, segments, minStartMs, maxStartMs } = withSegmentPath(held, path)
  return { ...held, bytes, segments, minStartMs, maxStartMs }
}

export interface SegmentHourLedgerDeps {
  readonly store: SettingsStoreClient
  readonly logger: IScopedLogger
  /**
   * How this ledger reads an hour DIRECTORY (D523). Absent ⇒ every surface that
   * needs actual file names answers empty and says so; the accounting surfaces,
   * which are the ones a node cannot do without, keep working.
   */
  readonly listHour?: HourLister
  /**
   * Is this location's volume the one we last wrote to? Answered by
   * `PlacementService`, whose marker probe is the only thing in the recorder
   * that can tell "the disk is mounted" from "the mountpoint directory exists".
   * Absent ⇒ every location is assumed usable, which is what the magnitude
   * guard below exists to survive.
   */
  readonly isLocationUsable?: (locationId: string) => boolean
  /** Injected by tests so anything clock-dependent is deterministic. */
  readonly now?: () => number
  /** Pacing knobs for the boot load. Production takes the defaults. */
  readonly loadPacing?: LedgerLoadPacing
}

/**
 * How the boot load is broken up so a large ledger cannot block the loop.
 *
 * Since D523 a row is ten scalars, so the RESPONSE is small by construction —
 * this is what keeps the PARSE off the critical path. At the 28 TB projection
 * the row set is ~47 k rows and the fold over them is the only synchronous work
 * left in the boot path.
 */
export interface LedgerLoadPacing {
  readonly chunkSize?: number
  readonly yieldBetween?: () => Promise<void>
  /** Overrides {@link SEGMENT_HOUR_SUMMARY_LIMIT}. Exists so the cap-hit
   *  branch — which drops part of the archive — is reachable in a test at a
   *  size a test can build. A cap nothing exercises is a cap nobody has. */
  readonly rowCap?: number
}

/**
 * Below this many held hours for a device, a walk may prune freely.
 *
 * The magnitude guard is a defence against a walk over a root that is not
 * there, and a handful of hours cannot tell that from ordinary retention. Eight
 * is small enough that a real archive is always covered and large enough that a
 * camera enabled an hour ago is never frozen.
 */
export const LEDGER_PRUNE_FLOOR_ROWS = 8

/**
 * The largest share of a device's held hours a single walk may delete.
 *
 * On 2026-08-19 the recorder respawned while `/recordings` was an empty tmpfs —
 * the UD disk had not mounted — and one walk took the ledger from 873 hours to
 * 32 (a 96% drop). The ledger is precisely what lets the NEXT boot skip a
 * ~400 s recursive walk, so a single bad walk taxed every boot after it. A
 * retention sweep does not delete half a camera's archive in one pass; a
 * `readdir` over an unmounted root deletes all of it.
 */
export const LEDGER_PRUNE_MAX_SHARE = 0.5

/**
 * The largest share of ONE hour's accounted segments a single listing may
 * erase (D523).
 *
 * The directory is the authority for WHICH segments exist, so a listing of a
 * closed hour replaces that hour's aggregate — including downwards, which is
 * what makes an over-counted row self-correcting. The guard is the same
 * argument {@link LEDGER_PRUNE_MAX_SHARE} makes one level up: a root that has
 * gone away, or a bucket half-deleted by a round that died, answers SHORT, and
 * a short answer that halves an hour is indistinguishable from one that is
 * simply right. Under the bar the listing wins; over it the row stands, the
 * hour stays unsealed, and the disagreement is named.
 */
export const HOUR_LISTING_MAX_SHRINK_SHARE = 0.5

/** Hour rows read per oldest-first probe page. One page normally covers any
 *  relief target — an hour of one camera-profile is hundreds of megabytes. */
export const OLDEST_HOUR_PAGE = 32

/** Backstop on the oldest-first probe. A bounded read must stay bounded even if
 *  a caller asks for a target no archive can cover. */
const OLDEST_MAX_PAGES = 16

/** Phase-one columns: everything the accumulation needs and nothing fat. */
const OLDEST_PROBE_COLUMNS = ['hourStartMs', 'bytes', 'locationId'] as const

/**
 * Hour rows per page of {@link SegmentHourLedger.streamSegments}.
 *
 * The stream is a DRAIN read — it walks a whole scope, not a bounded prefix —
 * so the page size bounds both the probe response and the number of hour
 * directories listed before the caller gets to act on any of them.
 */
export const ARCHIVE_HOUR_PAGE = 128

/**
 * Backstop on {@link SegmentHourLedger.streamSegments}.
 *
 * 47 k hour rows at the 28 TB projection is ~735 full pages, plus one
 * boundary re-read per page in the worst case. 20 000 is far above any real
 * archive and still a bound — and hitting it is SAID, because a stream that
 * stops early has under-reported the archive, which is the entire defect class
 * this surface exists to end.
 */
const ARCHIVE_MAX_PAGES = 20_000

/** Phase-one columns of the stream: the cursor field. The primary key always
 *  comes back, and nothing else is needed to choose a page. */
const ARCHIVE_PROBE_COLUMNS = ['hourStartMs'] as const

/**
 * Hour directories listed back-to-back before the ledger yields.
 *
 * Contention, not syscall latency, is the ceiling here: a startup warm of ~66
 * back-to-back reads once turned a 0.2 s query into 38 s on this hub. A
 * `readdir` of a real hour on 101's own location measures ~1 ms for 345–349
 * files, so the pacing is about leaving the array available to the live writers
 * and the scrub feeder, not about the cost of any one call.
 */
export const LISTING_BATCH = 8

/** The scalars a census is made of. `segments` is the "M" of "N of M"; the two
 *  extremes are the retention floor, asked in the SAME statement so a caller can
 *  never pair a ledger count with a resident-index floor. */
const CENSUS_FIELDS = [
  { as: 'bytes', field: 'bytes', op: 'sum' },
  { as: 'segments', field: 'segments', op: 'sum' },
  { as: 'oldestMs', field: 'minStartMs', op: 'min' },
  { as: 'newestMs', field: 'maxStartMs', op: 'max' },
] as const

/** Summary rows folded into the mirror between yields. */
const LOAD_CHUNK = 5_000

/**
 * Cap on the boot load.
 *
 * Generous against the 28 TB projection (~47 k hour rows at today's mix, ~75 k
 * at a low-bitrate one) and still a bound. A load that HITS it is a load that
 * silently forgot part of the archive, so it is said out loud.
 */
export const SEGMENT_HOUR_SUMMARY_LIMIT = 250_000

/** Minimum spacing between ledger load attempts after a failure (D674). */
export const LEDGER_LOAD_RETRY_MS = 60_000

/** FAST load attempts, boot included (~10 minutes of a store that will not
 *  answer), before the retry drops to {@link LEDGER_LOAD_SLOW_RETRY_MS}. */
export const LEDGER_LOAD_MAX_ATTEMPTS = 10

/** Spacing of the retries after the fast ones — slower, never stopped. */
export const LEDGER_LOAD_SLOW_RETRY_MS = 10 * 60_000

/** The four scalars an accounting answer is made of, asked in one statement. */
const ACCOUNTING_FIELDS = [
  { as: 'bytes', field: 'bytes', op: 'sum' },
  { as: 'segments', field: 'segments', op: 'sum' },
  { as: 'oldestMs', field: 'minStartMs', op: 'min' },
  { as: 'newestMs', field: 'maxStartMs', op: 'max' },
] as const

const EMPTY_ACCOUNTING: Accounting = { bytes: 0, count: 0, oldestMs: null, newestMs: null }

export function hourStartMs(startMs: number): number {
  return Math.floor(startMs / HOUR_MS) * HOUR_MS
}

export function segmentHourKey(
  deviceId: number,
  profile: string,
  locationId: string,
  hour: number,
): string {
  return `${deviceId}|${profile}|${locationId}|${hour}`
}

function hourOf(row: SegmentRow): { readonly key: string; readonly hourStartMs: number } {
  const hour = hourStartMs(row.startMs)
  return { hourStartMs: hour, key: segmentHourKey(row.deviceId, row.profile, row.locationId, hour) }
}

/** The identity of one writer: a camera's profile. Location is not part of it —
 *  a relocated writer is the same writer on a new root. */
function writerKey(deviceId: number, profile: string): string {
  return `${deviceId}|${profile}`
}

/** One writer's hour, WITHOUT the location — the identity a loss is reported
 *  against by a party that only knows the camera, the profile and the clock. */
function writerHourKey(deviceId: number, profile: string, hour: number): string {
  return `${deviceId}|${profile}|${hour}`
}

/**
 * The `hourStartMs` of one probe record.
 *
 * `-1` for a record whose cursor column did not come back as a number: it
 * cannot move the cursor FORWARD, so a malformed row can only cost a repeated
 * page — never a skipped hour.
 */
function hourOfRecord(record: { readonly data: Record<string, unknown> }): number {
  const raw = record.data['hourStartMs']
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : -1
}

/** One listing turned into the segment rows a caller can act on — the only
 *  place a `SegmentRow` is built out of a directory read. */
function segmentRowsOf(
  locationId: string,
  paths: readonly string[],
): { readonly rows: readonly SegmentRow[]; readonly unparseable: number } {
  const rows: SegmentRow[] = []
  let unparseable = 0
  for (const path of paths) {
    const parsed = parseSegmentPath(path)
    if (parsed === null) {
      unparseable += 1
      continue
    }
    rows.push({
      deviceId: parsed.deviceId,
      profile: parsed.profile,
      startMs: parsed.startMs,
      durMs: parsed.durMs,
      bytes: parsed.bytes,
      path,
      locationId,
    })
  }
  return { rows, unparseable }
}

function rowToValue(row: SegmentHourRow): Record<string, unknown> {
  return {
    deviceId: row.deviceId,
    profile: row.profile,
    locationId: row.locationId,
    hourStartMs: row.hourStartMs,
    bytes: row.bytes,
    segments: row.segments,
    minStartMs: row.minStartMs,
    maxStartMs: row.maxStartMs,
    sealed: row.sealed ? 1 : 0,
  }
}

/** The stored 0/1 (or a boolean from a fake) as the flag. Anything else —
 *  including the absence a pre-D451 row shows — is unsealed. */
function sealedOf(raw: unknown): boolean {
  return raw === 1 || raw === true
}

function finiteOr0(raw: unknown): number {
  const n = Number(raw)
  return Number.isFinite(n) ? n : 0
}

/**
 * One persisted row.
 *
 * The identity half is validated: a row that cannot say which camera, profile,
 * location and hour it is about is DISCARDED, because a row keyed on garbage
 * would refuse the write path for an hour that is perfectly fine. The aggregate
 * half is taken as the database wrote it — a row that predates the aggregate
 * columns reports zeros, which UNDER-reports its disk (prunes less, never more)
 * until a listing of that hour re-derives it.
 */
function recordToRow(key: string, data: Record<string, unknown>): SegmentHourRow | null {
  const deviceId = Number(data['deviceId'])
  const profile = data['profile']
  const locationId = data['locationId']
  const hour = Number(data['hourStartMs'])
  if (
    !Number.isFinite(deviceId) ||
    deviceId <= 0 ||
    typeof profile !== 'string' ||
    profile.length === 0 ||
    typeof locationId !== 'string' ||
    locationId.length === 0 ||
    !Number.isFinite(hour)
  ) {
    return null
  }
  return {
    key,
    deviceId,
    profile,
    locationId,
    hourStartMs: hour,
    sealed: sealedOf(data['sealed']),
    bytes: finiteOr0(data['bytes']),
    segments: finiteOr0(data['segments']),
    minStartMs: finiteOr0(data['minStartMs']),
    maxStartMs: finiteOr0(data['maxStartMs']),
  }
}

const SPEC: DurableLedgerSpec<SegmentHourRow> = {
  collection: RECORDING_SEGMENT_HOURS_COLLECTION,
  columns: RECORDING_SEGMENT_HOURS_COLUMNS,
  indexes: RECORDING_SEGMENT_HOURS_INDEXES,
  writeMode: 'write-behind',
  loadLimit: 100_000,
  keyOf: (row) => row.key,
  toValue: rowToValue,
  fromRecord: recordToRow,
  deviceIdOf: (row) => row.deviceId,
}

/** What {@link SegmentHourLedger.memoryCensus} reports. */
export interface SegmentHourLedgerCensus {
  readonly lanes: number
  readonly writerHours: number
  readonly accountedHours: number
  readonly accountedPaths: number
  readonly refused: number
  readonly refusedWriterHours: number
}

export class SegmentHourLedger implements FootageArchive {
  private readonly ledger: DurableLedger<SegmentHourRow>
  private readonly logger: IScopedLogger
  /** Held for the ARCHIVE reads below, which are queries rather than mirror
   *  lookups. Every DECISION path (`recordSegment`, `dropSegments`, the prune
   *  refusals) still answers from the mirror alone — D49 is about gates, and an
   *  accounting number is not a gate. */
  private readonly store: SettingsStoreClient
  private readonly listHour: HourLister | null
  private readonly isLocationUsable: (locationId: string) => boolean
  private readonly now: () => number
  private readonly loadChunk: number
  private readonly yieldBetween: () => Promise<void>
  private readonly rowCap: number
  /**
   * One lane per hour key: every mutation of a row runs after the previous one
   * on the same key has finished. Two appends that both read the row and both
   * wrote it back used to keep only the second — the sparse rows D451 found.
   */
  private readonly lanes = new Map<string, Promise<unknown>>()
  /** Per (device, profile): the hour its writer last appended to. */
  private readonly writerHours = new Map<string, WriterHour>()
  /**
   * Segment paths THIS PROCESS has already accounted for, per hour key.
   *
   * The `paths` column used to make the write path idempotent for free: an
   * append checked `held.paths.includes(path)`. With the column gone the
   * aggregate cannot say whether it already counted a name, so the dedup lives
   * here — bounded to the hours this process actually writes (two per writer:
   * the current hour and the one it just left), dropped when the writer moves
   * on. A duplicate that survives a RESTART is not caught here and is not
   * silent either: the row is unsealed, and the first listing of the closed
   * hour re-derives the aggregate exactly ({@link adoptWalkedHour}).
   */
  private readonly accounted = new Map<string, Set<string>>()
  /** Hour keys a write was REFUSED for in this process — never sealed by it. */
  private readonly refused = new Set<string>()
  /**
   * `${deviceId}|${profile}|${hourStartMs}` a LOSS was reported for, location
   * left out on purpose: the party that sees the loss (the playlist watcher)
   * knows the camera and the profile and has no business knowing which disk
   * the recorder happens to be placing that hour on.
   */
  private readonly refusedWriterHours = new Set<string>()
  /**
   * Has a {@link load} ANSWERED — its query returned AND every row it returned
   * is staged? Before that the mirror is "not read yet" (or, mid-load, a
   * fraction), never "the archive is empty". `load` swallows its failure, so a
   * reader that must tell the two apart (the calendar's window floor, the
   * storage-usage rows a retention floor is read from — D674) asks here.
   */
  private loaded = false
  /** The last successful load returned {@link rowCap} rows: hours past the cap
   *  are UNKNOWN, so the mirror is an answer but not a WHOLE one. */
  private loadHitRowCap = false
  /** Load attempts made, boot included — the retry is bounded (D674). */
  private loadAttempts = 0
  private lastLoadAttemptMs: number | null = null
  private loadInFlight: Promise<readonly SegmentHourRow[]> | null = null
  private loadRetriesExhaustedReported = false

  /** Entry counts of the in-process maps, for the recorder census. */
  memoryCensus(): SegmentHourLedgerCensus {
    let accountedPaths = 0
    for (const paths of this.accounted.values()) accountedPaths += paths.size
    return {
      lanes: this.lanes.size,
      writerHours: this.writerHours.size,
      accountedHours: this.accounted.size,
      accountedPaths,
      refused: this.refused.size,
      refusedWriterHours: this.refusedWriterHours.size,
    }
  }

  constructor(deps: SegmentHourLedgerDeps) {
    this.logger = deps.logger
    this.store = deps.store
    this.listHour = deps.listHour ?? null
    this.isLocationUsable = deps.isLocationUsable ?? ((): boolean => true)
    this.now = deps.now ?? ((): number => Date.now())
    this.loadChunk = deps.loadPacing?.chunkSize ?? LOAD_CHUNK
    this.yieldBetween = deps.loadPacing?.yieldBetween ?? macrotask
    this.rowCap = deps.loadPacing?.rowCap ?? SEGMENT_HOUR_SUMMARY_LIMIT
    this.ledger = new DurableLedger({
      spec: SPEC,
      kind: durableLegacyKind(SPEC, deps.store),
      logger: deps.logger,
    })
  }

  static declare(store: SettingsStoreClient): Promise<void> {
    return declareDurableLegacyCollection(store, SPEC)
  }

  declare(): Promise<void> {
    return declareDurableLegacyCollection(this.store, SPEC)
  }

  /**
   * Boot load — every hour row, in one query.
   *
   * Since D523 the whole row is ten scalars, so there is no second tier to
   * materialise and no projection to choose: the mirror this returns is the
   * ledger, entire. It keeps `DurableLedger.load`'s two rules — a failed read
   * RETURNS WHAT IS ALREADY MIRRORED rather than clearing it, and a malformed
   * row is skipped rather than repaired.
   *
   * It deliberately does NOT replay the archive into {@link RecordingIndex}: a
   * row says how MUCH an hour holds, never which files, so only a listing can
   * seed the index (D523).
   */
  async load(): Promise<readonly SegmentHourRow[]> {
    this.loadInFlight ??= this.loadOnce().finally(() => {
      this.loadInFlight = null
    })
    return this.loadInFlight
  }

  /**
   * Retry a load that has not answered — rate-limited, logged, never abandoned
   * (D674).
   *
   * A failed boot load used to last the runner's life: every reader then saw
   * only the rows written since boot, and `getStorageUsage` labelled them the
   * archive. Readers call this and never wait on it (it is fire-and-forget at
   * every call site); at most one attempt per {@link LEDGER_LOAD_RETRY_MS} for
   * the first {@link LEDGER_LOAD_MAX_ATTEMPTS}, then one per
   * {@link LEDGER_LOAD_SLOW_RETRY_MS}; the slowdown is said once.
   */
  retryLoadIfUnanswered(): void {
    if (this.loaded || this.loadInFlight !== null) return
    // Past the fast attempts the retry SLOWS, it never stops: a store that
    // comes back an hour later must not leave archive-wide answers refused —
    // and retention unswept — for the rest of the runner's life.
    const slow = this.loadAttempts >= LEDGER_LOAD_MAX_ATTEMPTS
    if (slow && !this.loadRetriesExhaustedReported) {
      this.loadRetriesExhaustedReported = true
      this.logger.warn(
        'recorder: segment-hour ledger still not loaded — retrying at the slow interval; archive-wide answers stay REFUSED until it loads',
        { meta: { attempts: this.loadAttempts, slowRetryMs: LEDGER_LOAD_SLOW_RETRY_MS } },
      )
    }
    const spacing = slow ? LEDGER_LOAD_SLOW_RETRY_MS : LEDGER_LOAD_RETRY_MS
    const now = this.now()
    if (this.lastLoadAttemptMs !== null && now - this.lastLoadAttemptMs < spacing) return
    // Each fast attempt is said; the slow ones are covered by the line above
    // and by the load's own failure warn — one per 10 min, not a flood.
    if (!slow) {
      this.logger.info('recorder: retrying the segment-hour ledger load', {
        meta: { attempt: this.loadAttempts + 1, fastAttempts: LEDGER_LOAD_MAX_ATTEMPTS },
      })
    }
    void this.load()
  }

  /**
   * Is the mirror a WHOLE answer about the archive: loaded, and not cut at the
   * row cap? The storage-usage rows and the calendar floor are only facts about
   * the archive when this is true.
   */
  isComplete(): boolean {
    return this.loaded && !this.loadHitRowCap
  }

  private async loadOnce(): Promise<readonly SegmentHourRow[]> {
    const startedMs = this.now()
    this.loadAttempts += 1
    this.lastLoadAttemptMs = startedMs
    let records: SettingsQueryRecords
    try {
      records = await this.store.query.query({
        collection: RECORDING_SEGMENT_HOURS_COLLECTION,
        // NEWEST first, explicitly: when the cap cuts, the hours the writers
        // are appending to are the ones held, and which rows went missing is
        // a stated rule rather than whatever order the store happened to use.
        filter: { limit: this.rowCap, orderBy: { field: 'hourStartMs', direction: 'desc' } },
      })
    } catch (err) {
      this.logger.warn(
        'recorder: segment-hour ledger load failed — keeping the hours already held',
        {
          meta: {
            collection: RECORDING_SEGMENT_HOURS_COLLECTION,
            held: this.ledger.size,
            attempt: this.loadAttempts,
            error: String(err),
          },
        },
      )
      return this.ledger.snapshot()
    }
    const queriedMs = this.now()

    let skipped = 0
    for (let i = 0; i < records.length; i += this.loadChunk) {
      const end = Math.min(i + this.loadChunk, records.length)
      for (let j = i; j < end; j += 1) {
        const record = records[j]!
        const row = recordToRow(record.id, record.data)
        if (row === null) {
          skipped += 1
          continue
        }
        // A row this process already holds was written by it, after (or
        // while) the store row was read: the held one is at least as fresh.
        // Only a RETRY can meet one — at boot the mirror is empty.
        if (!this.ledger.has(row.key)) this.ledger.stage(row)
      }
      if (end < records.length) await this.yieldBetween()
    }
    // Only now: a reader between two chunks saw a FRACTION of the rows (D674).
    this.loaded = true
    this.loadHitRowCap = records.length >= this.rowCap
    if (skipped > 0) {
      this.logger.warn('recorder: segment-hour rows skipped as malformed — they gate NOTHING', {
        meta: { collection: RECORDING_SEGMENT_HOURS_COLLECTION, skipped },
      })
    }
    if (records.length >= this.rowCap) {
      this.logger.warn(
        'recorder: segment-hour ledger load hit its row cap — hours past the cap are UNKNOWN to this process and will be walked from disk',
        { meta: { limit: this.rowCap, loaded: records.length } },
      )
    }

    this.logger.info('recorder: segment-hour ledger loaded', {
      meta: {
        hours: this.ledger.size,
        skipped,
        queryMs: queriedMs - startedMs,
        ms: this.now() - startedMs,
        collection: RECORDING_SEGMENT_HOURS_COLLECTION,
      },
    })
    return this.ledger.snapshot()
  }

  /** Every hour row held. Pure RAM. */
  snapshot(): readonly SegmentHourRow[] {
    return this.ledger.snapshot()
  }

  /** Whether a {@link load} has answered and staged every row it returned —
   *  see {@link loaded}. {@link isComplete} is the stronger question. */
  hasLoaded(): boolean {
    return this.loaded
  }

  /**
   * The OLDEST hour the archive holds per camera, across every profile and
   * every location — the floor below which no hour can hold footage (D674).
   *
   * Every row counts, including one whose segments were all dropped and that
   * the prune has not yet forgotten: an older floor only walks a few more
   * hours, while a floor that is too YOUNG hides footage. One fold, no I/O —
   * the same shape as {@link devicesWithFootage}. Meaningful only after
   * {@link isComplete}; even then a camera ABSENT from the map is unknown to
   * the calendar (an hour not adopted yet is on disk and absent here), never a
   * known "no footage" (D674).
   */
  oldestHourByDevice(): ReadonlyMap<number, number> {
    const out = new Map<number, number>()
    for (const row of this.ledger.snapshot()) {
      const held = out.get(row.deviceId)
      if (held === undefined || row.hourStartMs < held) out.set(row.deviceId, row.hourStartMs)
    }
    return out
  }

  /**
   * Which profiles each of these cameras has footage for IN THE ARCHIVE.
   *
   * The archive's answer to "what should placement plan for", and the reason it
   * is here rather than a `census` loop or an index read:
   *
   *   - `RecordingIndex.accountingByProfile` is the wrong authority. It holds
   *     the live tail plus whatever a reader hydrated, so a camera nobody has
   *     viewed since boot reports NO profiles — and the placement pass then
   *     never plans it (D295 §3a #9, D299).
   *   - `census({ deviceId, profiles: [p] })` is the right authority but the
   *     wrong shape for a 30 s tick: it is one SQL round trip per (camera,
   *     profile), so a 16-camera fleet pays 48 SERIAL trips over the UDS door
   *     every tick — the exact arithmetic that produced the `durationMs:
   *     240003` pass (see `PLACEMENT_STORE_TIMEOUT_MS`), and it grows with the
   *     fleet.
   *
   * So it is answered from the mirror: one fold, no query, no I/O.
   *
   * An EMPTY result for a device is a real answer — "the archive knows no hour
   * for this camera" — and it is also what a ledger whose load failed reports,
   * which is why the caller must treat an empty work set as "plan nothing",
   * never as "delete everything".
   */
  profilesWithFootage(deviceIds: ReadonlySet<number>): ReadonlyMap<number, ReadonlySet<string>> {
    const out = new Map<number, Set<string>>()
    for (const row of this.ledger.snapshot()) {
      if (!deviceIds.has(row.deviceId)) continue
      const held = out.get(row.deviceId)
      if (held) held.add(row.profile)
      else out.set(row.deviceId, new Set([row.profile]))
    }
    return out
  }

  /** Does the ledger hold a row for this hour at all? Pure RAM. */
  knowsHour(deviceId: number, profile: string, locationId: string, hour: number): boolean {
    return this.ledger.has(segmentHourKey(deviceId, profile, locationId, hour))
  }

  /** One held hour row, or `undefined`. Pure RAM — since D523 a row carries
   *  everything it has. */
  hourRow(
    deviceId: number,
    profile: string,
    locationId: string,
    hour: number,
  ): SegmentHourRow | undefined {
    return this.ledger.get(segmentHourKey(deviceId, profile, locationId, hour))
  }

  /**
   * A LISTING of a CLOSED hour is adopted as that hour's account, and SEALS it.
   *
   * The directory is the authority for which segments exist (D523), so a
   * listing of an hour that is OVER is the one complete answer there is — it
   * replaces the row's aggregate rather than merging with it, which is what
   * makes an hour that was over-counted (a duplicate finalize across a restart)
   * or under-counted (a writer torn down mid-hour) self-correcting. The caller
   * guarantees the hour is CLOSED: a live hour's directory races its writer, so
   * a listing of it is a lower bound.
   *
   * A listing that would erase more than {@link HOUR_LISTING_MAX_SHRINK_SHARE}
   * of what the row accounts for is REFUSED and named. That is the one thing a
   * listing cannot be trusted about: a root that has gone away and a bucket a
   * dead round half-deleted both answer short, and neither is distinguishable
   * from an hour that is simply smaller than the row thought.
   *
   * @seal-authority closed-hour-listing — a directory read of an hour that is
   * OVER is the one complete answer there is; the caller guarantees the hour is
   * closed (D451, D521, D523).
   */
  async adoptWalkedHour(
    deviceId: number,
    profile: string,
    locationId: string,
    hour: number,
    paths: readonly string[],
  ): Promise<WalkedHourOutcome | null> {
    const key = segmentHourKey(deviceId, profile, locationId, hour)
    const identity: SegmentHourIdentity = {
      key,
      deviceId,
      profile,
      locationId,
      hourStartMs: hour,
    }
    const walked = hourAggregate(paths)
    return this.serialized(key, async () => {
      const held = this.ledger.get(key)
      if (held === undefined) {
        if (walked.segments === 0) return { created: false, added: 0, sealedNow: false }
        await this.ledger.put(hourRowOf(identity, { ...walked, sealed: true }))
        this.logger.info(
          'recorder: adopted a closed hour the disk listing rebuilt and the ledger never held',
          {
            tags: { deviceId },
            meta: {
              profile,
              locationId,
              hourStartMs: hour,
              segments: walked.segments,
              bytes: walked.bytes,
            },
          },
        )
        return { created: true, added: walked.segments, sealedNow: true }
      }
      const shrink = held.segments - walked.segments
      if (shrink > 0 && shrink > held.segments * HOUR_LISTING_MAX_SHRINK_SHARE) {
        this.logger.warn(
          'recorder: hour listing REFUSED — it accounts for less than half of what this hour row holds, which is what an unmounted root looks like; the row stands and stays unsealed',
          {
            tags: { deviceId },
            meta: {
              profile,
              locationId,
              hourStartMs: hour,
              held: held.segments,
              listed: walked.segments,
              maxShare: HOUR_LISTING_MAX_SHRINK_SHARE,
            },
          },
        )
        return { created: false, added: 0, sealedNow: false }
      }
      const added = Math.max(0, walked.segments - held.segments)
      if (added === 0 && shrink === 0 && held.sealed) {
        return { created: false, added: 0, sealedNow: false }
      }
      if (shrink > 0) {
        this.logger.info(
          'recorder: hour listing accounts for FEWER segments than the row did — the directory decides',
          {
            tags: { deviceId },
            meta: {
              profile,
              locationId,
              hourStartMs: hour,
              held: held.segments,
              listed: walked.segments,
            },
          },
        )
      }
      await this.ledger.put(hourRowOf(identity, { ...walked, sealed: true }))
      return { created: false, added, sealedNow: !held.sealed }
    })
  }

  /**
   * The writer of `(deviceId, profile)` stopped gracefully: seal the hour it
   * was appending to. One write, and only if the row has every finalize this
   * ledger was handed for it.
   */
  async sealWriter(deviceId: number, profile: string): Promise<void> {
    const last = this.writerHours.get(writerKey(deviceId, profile))
    if (last === undefined) return
    await this.sealHour(last)
  }

  /**
   * Every mutation queued so far has landed — including the seals a rollover
   * fires without waiting. Awaited at shutdown so the hour a writer just
   * closed is sealed before the process is gone.
   */
  async flush(): Promise<void> {
    while (this.lanes.size > 0) await Promise.all([...this.lanes.values()])
  }

  /**
   * A finalize this ledger was NEVER handed — the fire-and-forget lane refused
   * it. The hour's row is short by that segment and this process is the only
   * party that knows, so the hour must not be sealed by it; a listing corrects
   * it instead, which is exactly what an unsealed row is for.
   */
  markRefused(row: SegmentRow): void {
    this.refused.add(hourOf(row).key)
  }

  /**
   * Segments a writer produced that never reached {@link recordSegment} — the
   * watcher's `rolledOff`, the one moment the system KNOWS work was skipped.
   *
   * Every hour the loss spans is refused the seal, whatever else this process
   * believes about them: the ownership grace answers "was I here", and this
   * answers "did I get everything while I was". Camera 101's respawned writer
   * passed the first question for the hour it entered at the top and still held
   * a row short by 175 segments.
   *
   * Returns how many hours were marked, so the caller's line reports what its
   * report bought rather than that it was made.
   */
  markHoursRefused(span: RefusedWriterSpan): number {
    if (!Number.isFinite(span.fromMs) || !Number.isFinite(span.toMs)) return 0
    const first = hourStartMs(Math.min(span.fromMs, span.toMs))
    const last = hourStartMs(Math.max(span.fromMs, span.toMs))
    let marked = 0
    for (let hour = first; hour <= last && marked < REFUSED_SPAN_MAX_HOURS; hour += HOUR_MS) {
      this.refusedWriterHours.add(writerHourKey(span.deviceId, span.profile, hour))
      marked += 1
    }
    if (marked === 0) return 0
    this.logger.warn(
      'recorder: segments this writer produced never reached the hour ledger — these hours stay UNSEALED and a listing corrects them',
      {
        tags: { deviceId: span.deviceId },
        meta: {
          profile: span.profile,
          fromMs: first,
          toMs: last,
          hours: marked,
          segments: span.count,
          boundHours: REFUSED_SPAN_MAX_HOURS,
        },
      },
    )
    return marked
  }

  /** One write: the row as held, flagged sealed. Serialised on its key so it
   *  cannot land over an append that read the row before it.
   *
   *  @seal-authority writer-owned-hour — the writer that LEAVES the hour, and
   *  only when it entered within {@link WRITER_HOUR_ENTRY_GRACE_MS} of the
   *  hour's start and no loss was reported against it (D521). */
  private async sealHour(target: WriterHour): Promise<void> {
    await this.serialized(target.key, async () => {
      const enteredAfterMs = target.entryMs - target.hourStartMs
      if (enteredAfterMs > WRITER_HOUR_ENTRY_GRACE_MS) {
        // D521: a seal is a claim of COMPLETENESS. This writer arrived after
        // the hour began, so whatever stands in the row for the part it was
        // not there for came from a process that is gone — and on 2026-09-17 a
        // respawned writer sealed away 29 minutes of camera 101 exactly here.
        this.logger.warn(
          'recorder: hour left unsealed — this writer entered it late, so it cannot claim the hour is complete',
          {
            tags: { deviceId: target.deviceId },
            meta: {
              profile: target.profile,
              locationId: target.locationId,
              hourStartMs: target.hourStartMs,
              enteredAfterMs,
              graceMs: WRITER_HOUR_ENTRY_GRACE_MS,
            },
          },
        )
        this.accounted.delete(target.key)
        return
      }
      if (
        this.refused.has(target.key) ||
        this.refusedWriterHours.has(
          writerHourKey(target.deviceId, target.profile, target.hourStartMs),
        )
      ) {
        this.logger.warn(
          'recorder: hour left unsealed — a ledger write for it was refused, so its row is short and a listing must correct it',
          {
            tags: { deviceId: target.deviceId },
            meta: {
              profile: target.profile,
              locationId: target.locationId,
              hourStartMs: target.hourStartMs,
            },
          },
        )
        this.accounted.delete(target.key)
        return
      }
      const held = this.ledger.get(target.key)
      this.accounted.delete(target.key)
      if (held === undefined || held.sealed) return
      await this.ledger.put({ ...held, sealed: true })
    })
  }

  /**
   * Remember which hour this writer is on — and how far into it this process
   * ARRIVED ({@link WriterHour.entryMs}, the first finalize's own start) —
   * and when it MOVES FORWARD, seal the hour it left. Backwards is a late
   * finalize (a recovered orphan, a replay) into an hour already accounted for,
   * and seals nothing.
   *
   * The entry stamp is kept from the FIRST finalize into the hour and never
   * refreshed: the question the seal has to answer is "was this writer here
   * when the hour began", and the last segment of the hour cannot answer it.
   */
  private noteWriter(next: WriterHour): void {
    const id = writerKey(next.deviceId, next.profile)
    const last = this.writerHours.get(id)
    if (last !== undefined && last.key === next.key) return
    if (last === undefined || next.hourStartMs > last.hourStartMs) {
      this.writerHours.set(id, next)
    }
    if (last !== undefined && next.hourStartMs > last.hourStartMs) {
      void this.sealHour(last)
    }
  }

  /**
   * Run `fn` after every mutation already queued on `key`.
   *
   * It was the lost-update guard: a row was read from the STORE, folded into
   * and written back with awaits in between, so two such runs on one key
   * interleaved and the second write carried a path set that never saw the
   * first — the sparse rows D451 found. Since D523 there is no store read on
   * any of these paths (the mirror holds the whole row) and `DurableLedger.put`
   * sets the mirror synchronously before it awaits the store, so every
   * get→fold→put here is synchronous up to the mirror and the interleaving
   * window is gone.
   *
   * What the lane still buys is the ORDER of the durable writes per hour key —
   * a rollover seal fired without an await must not land over an append that
   * was queued before it — and a handle for {@link flush} to wait on at
   * shutdown. A rejected step must not poison the lane: the next step still
   * runs.
   *
   * Note for anyone tempted to delete it: `segment-hour-seal.spec.ts` does NOT
   * catch its removal any more, and says so. Pinning durable write ORDER needs
   * a store whose latency a test can control, which `fakeSettingsStore` has no
   * way to express.
   */
  private serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(key) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    const settled = run.then(
      () => undefined,
      () => undefined,
    )
    this.lanes.set(key, settled)
    void settled.then(() => {
      if (this.lanes.get(key) === settled) this.lanes.delete(key)
    })
    return run
  }

  /**
   * List the hour directories of `rows`, paced, and expand them into segment
   * rows.
   *
   * The one place the ledger touches the array. An hour whose listing FAILED
   * takes no part in the caller's pass and is SAID — a branch that drops work
   * silently reads as "there was nothing there", which for a drain or a prune
   * is the difference between "moved everything" and "moved what it could see".
   */
  private async listHours(
    rows: readonly SegmentHourRow[],
    reason: string,
  ): Promise<readonly SegmentRow[]> {
    const out: SegmentRow[] = []
    if (rows.length === 0) return out
    const lister = this.listHour
    if (lister === null) {
      this.logger.warn(
        'recorder: no hour lister on this ledger — nothing that needs segment NAMES can run here',
        { meta: { hours: rows.length, reason } },
      )
      return out
    }
    let listed = 0
    for (const row of rows) {
      const paths = await lister(row.locationId, row.deviceId, row.profile, row.hourStartMs)
      if (paths === null) {
        this.logger.warn(
          'recorder: hour directory could not be listed — this hour takes NO part in this pass',
          {
            tags: { deviceId: row.deviceId },
            meta: {
              profile: row.profile,
              locationId: row.locationId,
              hourStartMs: row.hourStartMs,
              accounted: row.segments,
              reason,
            },
          },
        )
        continue
      }
      const { rows: segments, unparseable } = segmentRowsOf(row.locationId, paths)
      if (unparseable > 0) {
        this.logger.warn('recorder: hour directory holds names that are not segments', {
          tags: { deviceId: row.deviceId },
          meta: {
            profile: row.profile,
            locationId: row.locationId,
            hourStartMs: row.hourStartMs,
            unparseable,
            reason,
          },
        })
      }
      out.push(...segments)
      listed += 1
      if (listed % LISTING_BATCH === 0) await this.yieldBetween()
    }
    return out
  }

  // ── The archive READ surface: SQL, not the RAM index ────────────────────
  //
  // Both reads below answer a question the recorder used to put to
  // `RecordingIndex`, which could only answer it by visiting every row it held
  // — 7.1 M of them on the live hub, several times a minute, on the main
  // thread. The durable hour ledger already holds the same archive, bucketed
  // and indexed, so the sum is a sum and the oldest is a `LIMIT`.

  /**
   * Bytes / count / oldest / newest across a SET of storage locations, as ONE
   * `SUM`/`COUNT`/`MIN`/`MAX` over the hour rows.
   *
   * The set is the eviction DOMAIN — the location ids that alias one physical
   * root. It goes into a single statement as `locationId IN (…)`, never a loop
   * per location: two ids over one disk are one pool, and asking twice is how
   * an answer about a disk gets partitioned.
   */
  async accountingForLocations(locationIds: ReadonlySet<string>): Promise<Accounting> {
    const ids = [...locationIds]
    if (ids.length === 0) return EMPTY_ACCOUNTING
    const out = await this.store.aggregate.query({
      collection: RECORDING_SEGMENT_HOURS_COLLECTION,
      fields: ACCOUNTING_FIELDS,
      filter: { whereIn: { locationId: ids } },
    })
    const segments = out.values['segments']
    if (out.count === 0 || segments === null || segments === undefined) return EMPTY_ACCOUNTING
    return {
      bytes: out.values['bytes'] ?? 0,
      count: segments,
      oldestMs: out.values['oldestMs'] ?? null,
      newestMs: out.values['newestMs'] ?? null,
    }
  }

  /**
   * The OLDEST segments across a set of storage locations — enough of them to
   * cover `targetBytes`, and no more.
   *
   * ## The constraint this read exists to keep
   *
   * Locations aliasing one physical root must be reclaimed as ONE oldest-first
   * stream. That is not a property of the CALLER here, it is a property of the
   * STATEMENT: every id of the domain rides in a single
   * `locationId IN (…) ORDER BY hourStartMs ASC`. A query per location plus a
   * merge would be the age-partition data-loss bug rebuilt in a second place.
   *
   * ## Why two phases
   *
   * Phase one reads only the small columns and walks oldest-first until the
   * accumulated bytes cover the target — normally one page. Phase two LISTS the
   * hour directories phase one chose, which is the only thing that can name the
   * files eviction is about to delete (D523).
   *
   * `exhausted` means the stream ran out before the target was met — the
   * caller's stop condition, and the one thing a bounded read must still be
   * able to say truthfully.
   */
  async oldestSegments(
    locationIds: ReadonlySet<string>,
    targetBytes: number,
  ): Promise<OldestSegments> {
    return this.oldestSegmentsScoped(locationIds, null, targetBytes)
  }

  /**
   * {@link oldestSegments}, narrowed to a set of cameras.
   *
   * The disk-pressure evictor's dead-device tier needs the oldest footage OF
   * THE CAMERAS THAT NO LONGER EXIST, which is a different question from the
   * oldest footage on the disk: an orphan's newest hour has to be reachable
   * even when a live camera holds every one of the oldest ones. The narrowing
   * is a `deviceId IN (…)` on the same statement, so it stays ONE ordered,
   * bounded, paged read and never a per-device merge.
   *
   * The device set is the CALLER's business — this method neither knows nor
   * checks what makes a device evictable. Refuses an empty set rather than
   * compiling to "every camera", for the same reason
   * {@link SegmentHourLedger.predicate} refuses an empty scope.
   */
  async oldestSegmentsForDevices(
    locationIds: ReadonlySet<string>,
    deviceIds: ReadonlySet<number>,
    targetBytes: number,
  ): Promise<OldestSegments> {
    if (deviceIds.size === 0) return { rows: [], exhausted: true }
    return this.oldestSegmentsScoped(locationIds, [...deviceIds], targetBytes)
  }

  /**
   * Every camera the ledger holds an hour for on these locations.
   *
   * Answered from the mirror, exactly like {@link profilesWithFootage}, and for
   * the same reason: this is an O(writers × days) question and it must cost no
   * I/O. It runs on the disk-pressure path, where an I/O that fails would have
   * to be turned into a verdict.
   *
   * An EMPTY answer is "the mirror knows no hour here", which is also what a
   * ledger whose load failed reports — so the caller must treat it as "decide
   * nothing", never as "no camera owns this footage".
   */
  devicesWithFootage(locationIds: ReadonlySet<string>): ReadonlySet<number> {
    const out = new Set<number>()
    for (const row of this.ledger.snapshot()) {
      if (locationIds.has(row.locationId)) out.add(row.deviceId)
    }
    return out
  }

  /**
   * Bytes / segments / oldest / newest per CAMERA on these locations — the
   * per-camera half of the storage page, answered by the ARCHIVE (D418).
   *
   * ## Why the mirror fold and not `census({ deviceId })` per camera
   *
   * `census` is the right authority for a SCOPE, and it cannot express this
   * scope: {@link SegmentHourLedger.predicate} takes ONE `locationId`, so
   * "camera 101 across the three resolvable volumes" is three aggregates, and
   * `census({ deviceId })` alone would silently count footage stranded on a
   * location id that no longer resolves — bytes no volume row on the same page
   * accounts for. Per camera per volume that is `cameras × volumes` SQL
   * aggregates for one operator click, and it grows with the fleet.
   *
   * The mirror answers all of them in ONE pass with no I/O, exactly as
   * {@link devicesWithFootage} and {@link profilesWithFootage} already do, and
   * it is the same rows `accountingForLocations` sums in SQL — the mirror is
   * write-behind, so it is never BEHIND the store.
   *
   * ## What an empty answer means
   *
   * The same thing it means for {@link devicesWithFootage}: "the mirror knows
   * no hour here" — which is also what a ledger whose load failed reports. The
   * caller must not render that as "no camera has footage"; `getStorageUsage`
   * cross-checks the per-camera sum against the volume aggregate and SAYS so
   * when the two disagree.
   */
  usageByDevice(locationIds: ReadonlySet<string>): ReadonlyMap<number, ArchiveDeviceUsage> {
    const out = new Map<number, ArchiveDeviceUsage>()
    if (locationIds.size === 0) return out
    for (const row of this.ledger.snapshot()) {
      if (!locationIds.has(row.locationId)) continue
      // An hour whose segments were all dropped keeps its row until the prune
      // forgets it; its extremes are stale sentinels, so it contributes bytes
      // (zero) and nothing to the retention floor.
      const empty = row.segments === 0
      const prev = out.get(row.deviceId)
      out.set(row.deviceId, {
        bytes: (prev?.bytes ?? 0) + row.bytes,
        segments: (prev?.segments ?? 0) + row.segments,
        oldestMs: empty ? (prev?.oldestMs ?? null) : minOf(prev?.oldestMs ?? null, row.minStartMs),
        newestMs: empty ? (prev?.newestMs ?? null) : maxOf(prev?.newestMs ?? null, row.maxStartMs),
      })
    }
    return out
  }

  private async oldestSegmentsScoped(
    locationIds: ReadonlySet<string>,
    deviceIds: number[] | null,
    targetBytes: number,
  ): Promise<OldestSegments> {
    const ids = [...locationIds]
    if (ids.length === 0 || targetBytes <= 0) return { rows: [], exhausted: true }

    const chosen: string[] = []
    let covered = 0
    let offset = 0
    let exhausted = false
    for (let page = 0; page < OLDEST_MAX_PAGES && covered < targetBytes; page++) {
      const records = await this.store.query.query({
        collection: RECORDING_SEGMENT_HOURS_COLLECTION,
        columns: OLDEST_PROBE_COLUMNS,
        filter: {
          whereIn:
            deviceIds === null ? { locationId: ids } : { locationId: ids, deviceId: deviceIds },
          orderBy: { field: 'hourStartMs', direction: 'asc' },
          limit: OLDEST_HOUR_PAGE,
          offset,
        },
      })
      let met = false
      for (const record of records) {
        chosen.push(record.id)
        const bytes = record.data['bytes']
        covered += typeof bytes === 'number' ? bytes : 0
        // The page loop's condition stops PAGING; this stops CHOOSING. Without
        // it the whole 32-hour page is chosen even when the first hour already
        // covers the target, and phase two then LISTS 32 hour directories to
        // delete the two segments the target was worth.
        if (covered >= targetBytes) {
          met = true
          break
        }
      }
      // `exhausted` is "the stream ran out BEFORE the target was met", so a
      // coverage break can never set it — not even on a short final page,
      // where the target being met is precisely what the flag denies.
      if (met) break
      offset += records.length
      if (records.length < OLDEST_HOUR_PAGE) {
        exhausted = true
        break
      }
    }
    if (chosen.length === 0) return { rows: [], exhausted: true }

    const rows = await this.listHours(this.rowsOfKeys(chosen), 'oldest-segments')
    // Bounded: only the hours phase one chose. The hour rows arrived ordered,
    // so this orders WITHIN that batch — it is not an archive sort.
    return { rows: rows.toSorted((a, b) => a.startMs - b.startMs), exhausted }
  }

  /** Mirror rows for keys a probe named. A key the mirror does not hold is
   *  skipped: the probe and the mirror describe the same table, and an hour the
   *  mirror never loaded is one this process may not act on. */
  private rowsOfKeys(keys: readonly string[]): readonly SegmentHourRow[] {
    const out: SegmentHourRow[] = []
    for (const key of keys) {
      const row = this.ledger.get(key)
      if (row !== undefined) out.push(row)
    }
    return out
  }

  // ── The ARCHIVE surface for whole-scope operations (D295) ──────────────
  //
  // `accountingForLocations` and `oldestSegments` above answer BOUNDED
  // questions: a total, and a prefix long enough to cover a byte target. The
  // two below answer the UNBOUNDED one — "everything in this scope" — which is
  // what a drain, a retention prune and a footprint delete each need, and what
  // every one of them was getting from `RecordingIndex` instead.

  /**
   * The predicate half of an {@link ArchiveScope}, as one filter.
   *
   * REFUSES an empty scope rather than compiling to "the whole collection".
   * There is no read here that may be unscoped: an unscoped stream lists every
   * hour directory on the hub.
   */
  private static predicate(scope: ArchiveScope): ArchivePredicate {
    const where: Record<string, unknown> = {}
    if (scope.locationId !== undefined) where['locationId'] = scope.locationId
    if (scope.deviceId !== undefined) where['deviceId'] = scope.deviceId
    if (Object.keys(where).length === 0) {
      throw new Error(
        'recorder: an archive read must be scoped to a location or a device — an unscoped read is the whole collection',
      )
    }
    const profiles = scope.profiles ?? []
    return {
      where,
      ...(profiles.length > 0 ? { whereIn: { profile: [...profiles] } } : {}),
    }
  }

  /** Does this row fall inside `scope`? The mirror-side twin of
   *  {@link SegmentHourLedger.predicate}, for the passes that fold the mirror
   *  instead of querying. */
  private static inScope(row: SegmentHourRow, scope: ArchiveScope): boolean {
    if (scope.locationId !== undefined && row.locationId !== scope.locationId) return false
    if (scope.deviceId !== undefined && row.deviceId !== scope.deviceId) return false
    const profiles = scope.profiles ?? []
    return profiles.length === 0 || profiles.includes(row.profile)
  }

  /**
   * What the ARCHIVE holds in this scope — segments and bytes, as ONE
   * `SUM` over the hour rows.
   *
   * This is the **M** every whole-scope operation now reports itself against.
   * `null` is the honest answer to a failed read and is deliberately NOT
   * `{ segments: 0 }`: a caller that treats "I could not ask" as "there is
   * nothing" is the silence this whole surface exists to end.
   */
  async census(scope: ArchiveScope): Promise<ArchiveCensus | null> {
    try {
      const out = await this.store.aggregate.query({
        collection: RECORDING_SEGMENT_HOURS_COLLECTION,
        fields: CENSUS_FIELDS,
        filter: SegmentHourLedger.predicate(scope),
      })
      if (out.count === 0) return { segments: 0, bytes: 0, oldestMs: null, newestMs: null }
      return {
        segments: out.values['segments'] ?? 0,
        bytes: out.values['bytes'] ?? 0,
        oldestMs: out.values['oldestMs'] ?? null,
        newestMs: out.values['newestMs'] ?? null,
      }
    } catch (err) {
      this.logger.warn(
        'recorder: archive census failed — the caller cannot say how much of this scope it saw',
        {
          ...(scope.deviceId !== undefined ? { tags: { deviceId: scope.deviceId } } : {}),
          meta: {
            collection: RECORDING_SEGMENT_HOURS_COLLECTION,
            locationId: scope.locationId ?? '(any)',
            error: String(err),
          },
        },
      )
      return null
    }
  }

  /**
   * Every segment in `scope`, oldest-first, ONE PAGE at a time.
   *
   * ## Two phases, and which authority answers which
   *
   * Phase one asks the TABLE which hours the scope holds, oldest-first — the
   * ordered aggregate no directory read can answer. Phase two LISTS those hour
   * directories, which is the only authority for the file names the caller is
   * about to move or delete (D523). An hour whose listing fails is skipped and
   * said; the caller's own N-versus-M report is what makes the short walk
   * visible.
   *
   * ## Why a keyset cursor and not `offset`
   *
   * Both callers MUTATE the scope while they walk it: the drain re-points each
   * hour off the source location, the prune forgets each emptied hour. Under
   * `offset` paging that is the classic skip — page 2 at `offset: 64` starts 64
   * rows past a set that just lost its first 64, so half the archive is never
   * visited and the operation still reports `done`. That is the same shape as
   * the defect this surface replaces, rebuilt one layer down, so the cursor is
   * `hourStartMs >= cursor` and it advances by what was actually emitted.
   *
   * Rows already emitted at the cursor hour are remembered for that hour only
   * (an hour holds at most writers × profiles rows), so the memory here is the
   * page, never the archive.
   *
   * ## What a failed read does
   *
   * It ENDS the stream (D49: a fallible read destroys nothing). A stream that
   * swallowed the error and returned would be indistinguishable from a scope
   * that was genuinely empty.
   */
  async *streamSegments(scope: ArchiveScope): AsyncGenerator<readonly SegmentRow[]> {
    const predicate = SegmentHourLedger.predicate(scope)
    let cursor = 0
    let emittedAtCursor = new Set<string>()
    for (let page = 0; page < ARCHIVE_MAX_PAGES; page += 1) {
      let probe: SettingsQueryRecords
      try {
        probe = await this.store.query.query({
          collection: RECORDING_SEGMENT_HOURS_COLLECTION,
          columns: ARCHIVE_PROBE_COLUMNS,
          filter: {
            ...predicate,
            whereBetween: { hourStartMs: [cursor, Number.MAX_SAFE_INTEGER] },
            orderBy: { field: 'hourStartMs', direction: 'asc' },
            limit: ARCHIVE_HOUR_PAGE,
          },
        })
      } catch (err) {
        this.logger.warn(
          'recorder: archive stream stopped on a failed page — everything past this point is UNSEEN, not absent',
          {
            ...(scope.deviceId !== undefined ? { tags: { deviceId: scope.deviceId } } : {}),
            meta: {
              collection: RECORDING_SEGMENT_HOURS_COLLECTION,
              locationId: scope.locationId ?? '(any)',
              cursorHourMs: cursor,
              error: String(err),
            },
          },
        )
        return
      }
      if (probe.length === 0) return
      const fresh = probe.filter((record) => !emittedAtCursor.has(record.id))
      if (fresh.length === 0) {
        // Every row this page can see is already out. A SHORT page means there
        // is nothing beyond it, so the scope is finished. A FULL page means one
        // hour holds more rows than a page and the cursor cannot advance
        // without skipping rows it never emitted — so it stops and says so,
        // rather than jumping the hour and under-reporting the archive, which
        // is the exact failure this surface exists to end.
        if (probe.length < ARCHIVE_HOUR_PAGE) return
        this.logger.warn(
          'recorder: archive stream cannot advance — one hour holds more rows than a page, so the rest of this scope was NOT walked',
          {
            ...(scope.deviceId !== undefined ? { tags: { deviceId: scope.deviceId } } : {}),
            meta: {
              collection: RECORDING_SEGMENT_HOURS_COLLECTION,
              locationId: scope.locationId ?? '(any)',
              cursorHourMs: cursor,
              pageRows: ARCHIVE_HOUR_PAGE,
            },
          },
        )
        return
      }
      const nextCursor = fresh.reduce((max, record) => Math.max(max, hourOfRecord(record)), cursor)
      if (nextCursor !== cursor) emittedAtCursor = new Set<string>()
      for (const record of fresh) {
        if (hourOfRecord(record) === nextCursor) emittedAtCursor.add(record.id)
      }
      cursor = nextCursor
      const rows = await this.listHours(
        this.rowsOfKeys(fresh.map((record) => record.id)),
        'archive-stream',
      )
      // Within the page only — the pages themselves already arrive hour-ordered.
      if (rows.length > 0) yield rows.toSorted((a, b) => a.startMs - b.startMs)
      // A short page whose rows were ALL fresh has nothing beyond it: skip the
      // confirming round trip.
      if (probe.length < ARCHIVE_HOUR_PAGE && fresh.length === probe.length) return
    }
    this.logger.warn(
      'recorder: archive stream hit its page backstop — the rest of this scope was NOT walked',
      {
        ...(scope.deviceId !== undefined ? { tags: { deviceId: scope.deviceId } } : {}),
        meta: {
          collection: RECORDING_SEGMENT_HOURS_COLLECTION,
          locationId: scope.locationId ?? '(any)',
          maxPages: ARCHIVE_MAX_PAGES,
          cursorHourMs: cursor,
        },
      },
    )
  }

  /**
   * Forget every hour row in `scope` — the durable half of an operator's
   * "discard this location's footage".
   *
   * It exists because the files are already GONE by the time it runs: the
   * discard wipes the class subtrees first, so every hour directory in the
   * scope answers ENOENT and nothing that needs a listing can name a single
   * segment. The rows are forgotten by their own identity instead, and the
   * count returned is the SEGMENTS they accounted for, which is the number the
   * operator is shown.
   *
   * Never reachable except from that explicitly-armed action: this is the one
   * surface here that deletes durable rows with no evidence from the array at
   * all, because the operator's own instruction is the evidence.
   */
  /**
   * Forget ONE hour row outright, and answer the segments it accounted for.
   *
   * The caller must have TRUSTED evidence that the hour holds nothing — a
   * directory listing under a volume anchor that agreed twice (D49), or a
   * per-path confirmation against every root there is. This method makes no
   * such check itself and can make none: it is handed a verdict, not evidence.
   *
   * It exists because {@link adoptWalkedHour} deliberately refuses an EMPTY
   * listing — "the walk found nothing" is what an unmounted root looks like —
   * so the one repair a listing cannot express is the one that empties an hour.
   */
  async forgetHour(
    deviceId: number,
    profile: string,
    locationId: string,
    hour: number,
  ): Promise<number> {
    const key = segmentHourKey(deviceId, profile, locationId, hour)
    return this.serialized(key, async () => {
      const held = this.ledger.get(key)
      if (held === undefined) return 0
      await this.ledger.forget(key)
      this.accounted.delete(key)
      return held.segments
    })
  }

  async forgetScope(scope: ArchiveScope): Promise<number> {
    let forgotten = 0
    for (const row of this.ledger.snapshot()) {
      if (!SegmentHourLedger.inScope(row, scope)) continue
      await this.ledger.forget(row.key)
      forgotten += row.segments
    }
    return forgotten
  }

  /**
   * Write-behind: a just-finalized segment joins its hour row.
   *
   * THE hot path — every profile-writer lands here every `segmentSeconds`,
   * ~3.4 times a second fleet-wide. The append is {@link appendSegmentPath}:
   * one `parseSegmentPath` and four scalar updates, whatever the hour already
   * holds — and since D523 it needs no read of the store at all, because the
   * mirror carries the whole row.
   */
  async recordSegment(row: SegmentRow): Promise<void> {
    const { key, hourStartMs: hour } = hourOf(row)
    this.noteWriter({
      key,
      deviceId: row.deviceId,
      profile: row.profile,
      locationId: row.locationId,
      hourStartMs: hour,
      entryMs: row.startMs,
    })
    await this.serialized(key, async () => {
      const seen = this.accounted.get(key)
      if (seen !== undefined && seen.has(row.path)) return
      if (seen === undefined) this.accounted.set(key, new Set([row.path]))
      else seen.add(row.path)
      const held = this.ledger.get(key)
      if (held === undefined) {
        await this.ledger.put(
          segmentHourRow({
            key,
            deviceId: row.deviceId,
            profile: row.profile,
            locationId: row.locationId,
            hourStartMs: hour,
            paths: [row.path],
          }),
        )
        return
      }
      await this.ledger.put(appendSegmentPath(held, row.path))
    })
  }

  /**
   * Eviction confirmed these segments are gone from disk. Take them out of the
   * hour's account; forget the hour when nothing is left.
   *
   * The aggregate shrinks by exactly what was removed. `minStartMs` /
   * `maxStartMs` are NOT re-derived — they cannot be, without a listing — so a
   * partly-evicted hour keeps extremes that may be older or newer than what
   * survives. That error is bounded by the hour itself (both values always lie
   * inside `[hourStartMs, hourStartMs + 1h)`), and the row is UNSEALED so the
   * next listing of it re-derives both exactly.
   */
  async dropSegments(rows: readonly SegmentRow[]): Promise<void> {
    const doomed = new Map<string, { deviceId: number; bytes: number; segments: number }>()
    for (const row of rows) {
      const { key } = hourOf(row)
      const entry = doomed.get(key)
      if (entry === undefined) {
        doomed.set(key, { deviceId: row.deviceId, bytes: row.bytes, segments: 1 })
        continue
      }
      entry.bytes += row.bytes
      entry.segments += 1
    }
    for (const [key, dropped] of doomed) {
      await this.serialized(key, async () => {
        const held = this.ledger.get(key)
        if (held === undefined) return
        const segments = held.segments - dropped.segments
        if (segments <= 0) {
          await this.ledger.forget(key)
          this.accounted.delete(key)
          return
        }
        await this.ledger.put({
          ...held,
          sealed: false,
          segments,
          bytes: Math.max(0, held.bytes - dropped.bytes),
        })
      })
    }
  }

  /**
   * Move `rows` from the hour they are accounted under today to the SAME hour
   * at `toLocationId` — the DURABLE half of a relocation.
   *
   * Without this the mover re-points only `RecordingIndex`, which is RAM, and
   * the drained location keeps the bytes on every storage page for the life of
   * the hub. That is the shape of the 2 131 `recordings:high` ghost rows this
   * hub carried.
   *
   * **The ordering is the invariant, not an implementation detail.** The
   * destination row is written BEFORE the source row is shrunk, and the caller
   * has not yet deleted the source bytes — so the only state a crash can leave
   * is "accounted at BOTH locations, both of which hold the files", which a
   * listing of either hour resolves. The reverse order has a window in which
   * the segments are accounted NOWHERE.
   *
   * Both rows come out UNSEALED: each carries an aggregate that arithmetic
   * moved rather than a listing derived, and the next walk of either hour fixes
   * whatever the arithmetic rounded.
   */
  async repointSegments(rows: readonly RelocatedSegment[], toLocationId: string): Promise<void> {
    const byHour = new Map<
      string,
      {
        readonly row: RelocatedSegment
        bytes: number
        segments: number
        minStartMs: number
        maxStartMs: number
      }
    >()
    for (const row of rows) {
      if (row.locationId === toLocationId) continue
      const { key } = hourOf(row)
      const entry = byHour.get(key)
      if (entry === undefined) {
        byHour.set(key, {
          row,
          bytes: row.bytes,
          segments: 1,
          minStartMs: row.startMs,
          maxStartMs: row.startMs,
        })
        continue
      }
      entry.bytes += row.bytes
      entry.segments += 1
      entry.minStartMs = Math.min(entry.minStartMs, row.startMs)
      entry.maxStartMs = Math.max(entry.maxStartMs, row.startMs)
    }
    for (const [sourceKey, moved] of byHour) {
      const hour = hourStartMs(moved.row.startMs)
      const targetKey = segmentHourKey(moved.row.deviceId, moved.row.profile, toLocationId, hour)
      const target = this.ledger.get(targetKey)
      const targetIdentity: SegmentHourIdentity = {
        key: targetKey,
        deviceId: moved.row.deviceId,
        profile: moved.row.profile,
        locationId: toLocationId,
        hourStartMs: hour,
      }
      const targetEmpty = target === undefined || target.segments === 0
      await this.ledger.put(
        hourRowOf(targetIdentity, {
          sealed: false,
          bytes: (target?.bytes ?? 0) + moved.bytes,
          segments: (target?.segments ?? 0) + moved.segments,
          minStartMs: targetEmpty
            ? moved.minStartMs
            : Math.min(target.minStartMs, moved.minStartMs),
          maxStartMs: targetEmpty
            ? moved.maxStartMs
            : Math.max(target.maxStartMs, moved.maxStartMs),
        }),
      )
      const held = this.ledger.get(sourceKey)
      if (held === undefined) continue
      const segments = held.segments - moved.segments
      if (segments <= 0) {
        await this.ledger.forget(sourceKey)
        continue
      }
      await this.ledger.put({
        ...held,
        sealed: false,
        segments,
        bytes: Math.max(0, held.bytes - moved.bytes),
      })
    }
  }

  /**
   * After a disk walk of `deviceIds`, make the ledger match what the index now
   * holds — with two D148 exceptions:
   *
   *  - an hour the walk did not see is dropped ONLY if it is in the past;
   *    the current hour may still hold a live writer whose file the readdir
   *    raced;
   *  - the current hour takes the LARGER of the two accounts rather than the
   *    walk's, for the same race.
   *
   * Devices not in `deviceIds` are left untouched (a partial walk must not
   * prune cameras it did not look at).
   *
   * And a walk this ledger does not TRUST prunes nothing at all — see
   * {@link refusedPrunes}. What such a walk FOUND is still real, so its larger
   * account is taken; what it did not find decides nothing (D49).
   */
  async reconcileFromIndex(
    index: RecordingIndex,
    deviceIds: readonly number[],
    nowMs: number,
  ): Promise<void> {
    const walked = new Set(deviceIds)
    const currentHour = hourStartMs(nowMs)
    const fromIndex = new Map<string, SegmentHourRow>()
    for (const deviceId of deviceIds) {
      for (const seg of index.segments(deviceId)) {
        const { key, hourStartMs: hour } = hourOf(seg)
        const existing = fromIndex.get(key)
        if (existing === undefined) {
          fromIndex.set(
            key,
            segmentHourRow({
              key,
              deviceId: seg.deviceId,
              profile: seg.profile,
              locationId: seg.locationId,
              hourStartMs: hour,
              paths: [seg.path],
              // An operator-armed whole-device walk is the one complete read
              // of a closed hour; the current hour is filtered below.
              sealed: hour !== currentHour,
            }),
          )
        } else {
          // Same fold, same reason: a walked hour is accumulated one path at a
          // time, and re-deriving it per path made a whole-device walk O(N²)
          // in each hour it visited.
          fromIndex.set(key, appendSegmentPath(existing, seg.path))
        }
      }
    }

    const refused = this.refusedPrunes(walked, fromIndex)
    // An index that DROPPED hours during this walk is not a complete view of
    // what the walk read (D524): the rows it let go look exactly like footage
    // disk no longer has, and pruning on that silence deletes the durable row
    // for segments still on the array. Additive-only for that camera — what
    // the walk FOUND is still real.
    const trimmed = new Set<number>()
    for (const deviceId of walked) {
      if (!index.droppedDuringWalk(deviceId)) continue
      trimmed.add(deviceId)
      this.logger.warn(
        'recorder: ledger prune REFUSED — the RAM index dropped hours during this walk, so its silence is not evidence',
        { tags: { deviceId } },
      )
    }

    for (const row of this.ledger.snapshot()) {
      if (!walked.has(row.deviceId)) continue
      const disk = fromIndex.get(row.key)
      // The current hour is never pruned (a live writer's file races the
      // readdir), and neither is anything on a walk we do not trust.
      const additiveOnly =
        row.hourStartMs === currentHour ||
        trimmed.has(row.deviceId) ||
        refused.devices.has(row.deviceId) ||
        refused.locations.has(locationKey(row.deviceId, row.locationId))
      if (disk === undefined) {
        if (additiveOnly) continue
        await this.ledger.forget(row.key)
        continue
      }
      if (additiveOnly) {
        if (disk.segments > row.segments) await this.ledger.put(disk)
        continue
      }
      if (disk.segments !== row.segments || disk.bytes !== row.bytes) {
        await this.ledger.put(disk)
      }
    }

    for (const [key, disk] of fromIndex) {
      if (this.ledger.has(key)) continue
      await this.ledger.put(disk)
    }
  }

  /**
   * Which of this walk's deletions are REFUSED, and why.
   *
   * Two independent reasons, because the live fault of 2026-08-19 would have
   * escaped either one alone:
   *
   * - **the volume said no.** `PlacementService`'s marker probe knows the bytes
   *   under a root are not the bytes we wrote. A walk of such a root found
   *   nothing because nothing is mounted there, not because the footage is
   *   gone.
   * - **the magnitude said no.** At BOOT the probe has not run yet — it runs at
   *   the first writer attach — so on the morning the recorder respawned onto an
   *   empty tmpfs the volume was not flagged and the prune went through: 873
   *   hours to 32. A walk that deletes more than
   *   {@link LEDGER_PRUNE_MAX_SHARE} of a device's held hours is refused on its
   *   size alone.
   *
   * A refusal is one line per device (or per device+location), carrying the
   * delta, tagged with `deviceId` — a ledger that silently declined to prune and
   * a ledger with nothing to prune must never read the same.
   */
  private refusedPrunes(
    walked: ReadonlySet<number>,
    fromIndex: ReadonlyMap<string, SegmentHourRow>,
  ): { readonly devices: ReadonlySet<number>; readonly locations: ReadonlySet<string> } {
    const heldByDevice = new Map<number, number>()
    const unusable = new Map<string, { deviceId: number; locationId: string; held: number }>()
    for (const row of this.ledger.snapshot()) {
      if (!walked.has(row.deviceId)) continue
      heldByDevice.set(row.deviceId, (heldByDevice.get(row.deviceId) ?? 0) + 1)
      if (this.isLocationUsable(row.locationId)) continue
      const key = locationKey(row.deviceId, row.locationId)
      const seen = unusable.get(key)
      unusable.set(
        key,
        seen === undefined
          ? { deviceId: row.deviceId, locationId: row.locationId, held: 1 }
          : { ...seen, held: seen.held + 1 },
      )
    }

    const onDiskByDevice = new Map<number, number>()
    for (const row of fromIndex.values()) {
      onDiskByDevice.set(row.deviceId, (onDiskByDevice.get(row.deviceId) ?? 0) + 1)
    }

    const devices = new Set<number>()
    for (const [deviceId, held] of heldByDevice) {
      if (held < LEDGER_PRUNE_FLOOR_ROWS) continue
      const onDisk = onDiskByDevice.get(deviceId) ?? 0
      if (onDisk >= held * (1 - LEDGER_PRUNE_MAX_SHARE)) continue
      devices.add(deviceId)
      this.logger.warn(
        'recorder: segment-hour ledger prune REFUSED — this walk would delete most of the camera archive, which is what an unmounted root looks like; keeping the previous ledger',
        {
          tags: { deviceId },
          meta: { held, onDisk, dropped: held - onDisk, maxShare: LEDGER_PRUNE_MAX_SHARE },
        },
      )
    }

    const locations = new Set<string>()
    for (const [key, entry] of unusable) {
      if (devices.has(entry.deviceId)) continue
      locations.add(key)
      this.logger.warn(
        'recorder: segment-hour ledger prune REFUSED — the volume under this location failed its probe, so the walk found nothing because nothing is mounted there',
        {
          tags: { deviceId: entry.deviceId },
          meta: {
            locationId: entry.locationId,
            held: entry.held,
            onDisk: onDiskByDevice.get(entry.deviceId) ?? 0,
          },
        },
      )
    }

    return { devices, locations }
  }
}

function locationKey(deviceId: number, locationId: string): string {
  return `${deviceId}|${locationId}`
}
