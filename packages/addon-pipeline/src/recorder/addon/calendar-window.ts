/**
 * Which hours a calendar walk may visit — and the walks it REFUSES (D674).
 *
 * `CalendarIndex.rangesIn` used to build one entry per hour of whatever window
 * it was handed and scan each of them. Handed `[0, now)` it walked 497,408
 * hours from 1970-01-01, every ten minutes, for every camera, and cached each
 * empty answer: 11.9 M Map keys and the recorder's OOM of 2026-09-28. Nothing
 * about the method said a window could be too large.
 *
 * Two rules now bound every walk, and neither guesses:
 *
 *  1. CLAMP to what can hold footage. Below the camera's oldest ledger hour
 *     nothing can — that is a KNOWN "no", read from the durable hour ledger
 *     (D295/D418), not an inference from an empty directory. After the end of
 *     the current hour nothing can either. A clamp by a floor nobody could read
 *     is not a clamp: an unanswered ledger clamps nothing (D393).
 *  2. REFUSE what is still too wide after the clamp, with a typed error — never
 *     truncate. A truncated answer is indistinguishable from a complete one; a
 *     refusal surfaces as `read: 'unreadable'` and is logged by the provider.
 */
import type { SegmentHourLedger } from './segment-hour-ledger.js'

const HOUR_MS = 3_600_000

/**
 * The widest walk one call may make AFTER the clamp: a leap year of hours.
 *
 * Evidence, not taste. The widest in-repo caller is the viewer's month
 * calendar (~33 days); the rest ask a day or a clip window (liveness 24 h,
 * videoclips' since/until, a timelapse window, a timeline day). The one that
 * asked for more wanted a single number the ledger already holds (D674). The
 * archives it would still admit are past what this system keeps: the 28 TB
 * projection is ~47 k hour rows, ~2,000 hours (~82 days) per camera/profile
 * pair at ~24 pairs, and the live hub held 3.3 days. (The ledger's load CAP,
 * `SEGMENT_HOUR_SUMMARY_LIMIT` = 250,000 rows, is ~10 k hours per pair — a
 * bound on memory, not a claim about retention; the clamp only ever narrows a
 * walk further.) A walk this wide costs ~130 B of garbage per hour warm
 * (measured: ~65 MB for 497,408 hours), so ~1.1 MB at the cap.
 */
export const CALENDAR_MAX_WALK_HOURS = 366 * 24

/**
 * The floor the archive states for one camera.
 *
 * `known: false` = nobody could say, and the walk is then bounded by the cap
 * alone. That covers: no ledger on this node, a load that has not answered or
 * was cut at its row cap, and a camera ABSENT from a loaded ledger. Absence is
 * not a known "no": an hour the ledger has not adopted yet (a boot whose
 * declare failed, a write still in flight) is on disk and absent here, and a
 * clamp would hide it as a confident empty `read` (D393, D674 review M3).
 */
export type ArchiveFloor =
  | { readonly known: true; readonly oldestHourMs: number }
  | { readonly known: false }

export const UNKNOWN_ARCHIVE_FLOOR: ArchiveFloor = { known: false }

/** A walk the calendar will not make. Surfaces as `read: 'unreadable'`. */
export class CalendarWindowRefusedError extends Error {
  override readonly name = 'CalendarWindowRefusedError'

  constructor(
    readonly deviceId: number,
    readonly hours: number,
    readonly maxHours: number,
    readonly floorKnown: boolean,
  ) {
    super(
      `calendar: refused a ${String(hours)}-hour walk for device ${String(deviceId)} ` +
        `(cap ${String(maxHours)} h, archive floor ${floorKnown ? 'known' : 'UNKNOWN'}) — ` +
        'ask the archive (recordingArchive.getStorageUsage) for whole-archive facts',
    )
  }
}

/** The hours one walk will visit: `[firstHourMs, endMs)`, hour-aligned start. */
export interface CalendarWalk {
  readonly firstHourMs: number
  readonly endMs: number
  readonly hours: number
}

/**
 * Clamp `[fromMs, toMs)` to the hours that can hold footage and refuse it when
 * it is still wider than `maxHours`. `null` = nothing left to walk.
 *
 * The writer's current hour and the one it just left are never clamped away:
 * the ledger is write-behind, so a camera's first segments may be on disk (and
 * in the RAM index) a moment before the ledger holds their hour.
 */
export function calendarWalk(
  deviceId: number,
  fromMs: number,
  toMs: number,
  nowMs: number,
  floor: ArchiveFloor,
  maxHours: number = CALENDAR_MAX_WALK_HOURS,
): CalendarWalk | null {
  const currentHour = Math.floor(nowMs / HOUR_MS) * HOUR_MS
  const liveFloor = currentHour - HOUR_MS
  const floorHour = floor.known ? Math.min(floor.oldestHourMs, liveFloor) : Number.NEGATIVE_INFINITY
  const firstHourMs = Math.max(Math.floor(fromMs / HOUR_MS) * HOUR_MS, floorHour)
  const endMs = Math.min(toMs, currentHour + HOUR_MS)
  if (endMs <= firstHourMs || toMs <= fromMs) return null
  const hours = Math.ceil((endMs - firstHourMs) / HOUR_MS)
  if (hours > maxHours) {
    throw new CalendarWindowRefusedError(deviceId, hours, maxHours, floor.known)
  }
  return { firstHourMs, endMs, hours }
}

/** The slice of {@link SegmentHourLedger} a floor is read from. */
export type ArchiveFloorSource = Pick<
  SegmentHourLedger,
  'isComplete' | 'oldestHourByDevice' | 'retryLoadIfUnanswered'
>

/**
 * How long one fold of the ledger answers every camera's floor.
 *
 * The fold walks every hour row (and `snapshot()` copies them), so it is not
 * made per availability call — a grid of 16 cameras polls every 30 s. A floor
 * a minute old is harmless in both directions it can be wrong: retention moved
 * it LATER (the walk visits a few already-empty hours) or an adoption moved it
 * EARLIER (that hour appears on the next fold).
 */
export const ARCHIVE_FLOOR_TTL_MS = 60_000

/** One fold of the ledger: every camera's oldest hour, and when it was taken. */
interface FoldedFloors {
  readonly atMs: number
  readonly floors: ReadonlyMap<number, number>
}

/** Per-camera archive floors, one ledger fold per {@link ARCHIVE_FLOOR_TTL_MS}. */
export class ArchiveFloorReader {
  private folded: FoldedFloors | null = null

  constructor(
    private readonly source: () => ArchiveFloorSource | null,
    private readonly now: () => number = () => Date.now(),
  ) {}

  floorOf(deviceId: number): ArchiveFloor {
    const ledger = this.source()
    if (ledger === null) return UNKNOWN_ARCHIVE_FLOOR
    // Not answered (or cut at its row cap) is not empty (D393): no floor, and
    // nothing cached, so the first fold after a whole load is the first answer.
    // A failed boot load is retried from here, bounded, never awaited.
    if (!ledger.isComplete()) {
      ledger.retryLoadIfUnanswered()
      return UNKNOWN_ARCHIVE_FLOOR
    }
    const nowMs = this.now()
    if (this.folded === null || nowMs - this.folded.atMs >= ARCHIVE_FLOOR_TTL_MS) {
      this.folded = { atMs: nowMs, floors: ledger.oldestHourByDevice() }
    }
    const oldestHourMs = this.folded.floors.get(deviceId)
    return oldestHourMs === undefined ? UNKNOWN_ARCHIVE_FLOOR : { known: true, oldestHourMs }
  }
}
