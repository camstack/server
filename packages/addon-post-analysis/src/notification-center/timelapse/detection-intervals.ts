/**
 * What the timelapse is allowed to call "something happened in this second".
 *
 * Pure — no clock, no I/O, no store.
 *
 * WHY THIS FILE EXISTS. The dense plan used to be built from the persisted
 * track store alone, and on the night of 2026-08-13 that store held ZERO tracks
 * for camera 101 over a ten-hour window in which two people walked past the
 * front door. The tracks were not missing from the pipeline — they were
 * DELIBERATELY never persisted:
 *
 *  - the confirmation gate retracts a birth it judges a false positive
 *    (`birth suppressed — track record retracted`; 101's 23:31 person lost to
 *    `bestIncompatibleClass=animal 0.6187`),
 *  - stationary promotion drops a parked object ("a parked object is not a
 *    highlight"), which cost camera 102 a 290 s vehicle the same night,
 *  - zero-media suppression cascades away a sub-1.5 s track with no thumbnail.
 *
 * Roughly 150 birth suppressions and 100 stationary promotions per ten hours,
 * cluster-wide. Every one of those gates is RIGHT for the question they were
 * built for — "is this worth notifying about?" — and WRONG for the question a
 * timelapse asks, which is only "was anything moving here, so slow down".
 *
 * The `object-events` rows survive all three gates: they are written per frame
 * from the emitter and nothing retracts them. So the honest input is the UNION:
 * the persisted tracks (authoritative when they exist) plus intervals
 * reconstructed from the events of the tracks that never landed.
 *
 * ONE ARRAY, TWO DERIVATIONS — the contract `detection-counts.ts` depends on.
 * The merge output feeds `planDenseRanges` AND `countDetections`, so the
 * sentence "2 persone" and the stretches the video actually slows down can
 * never come from different reads. That is also why the merge counts SUBJECTS
 * and not rows: one track is one detection however many frames it emitted.
 */

import type { TimelapseTrackInterval } from './dense-ranges.js'

/**
 * The slice of an `ObjectEvent` this merge reads.
 *
 * `trackId` is optional because the cap schema makes it optional (a native /
 * camera-side detection may carry none) — not because it is usually absent.
 */
export interface TimelapseDetectionEvent {
  readonly timestamp: number
  readonly className?: string
  readonly trackId?: string
}

/**
 * How far apart two same-class TRACK-LESS rows are still one subject.
 *
 * Only reached when the emitter wrote no `trackId`, so there is nothing to tie
 * rows together with and a threshold is the only available answer. Ten seconds:
 * long enough to hold one pass together, short enough that two cars a minute
 * apart stay two cars. With a `trackId` present this constant is never
 * consulted — the tracker's own identity always wins.
 */
export const TRACKLESS_EVENT_GAP_MS = 10_000

export interface DetectionIntervalInput {
  /** Persisted tracks for the window. Authoritative for their own ids. */
  readonly tracks: readonly TimelapseTrackInterval[]
  /** Object-event rows for the SAME window, in any order. */
  readonly events: readonly TimelapseDetectionEvent[]
  /** Override for {@link TRACKLESS_EVENT_GAP_MS}. */
  readonly tracklessGapMs?: number
}

/** A group being folded — mutable on purpose, local to one call. */
interface Group {
  trackId?: string
  firstSeen: number
  lastSeen: number
  /** Class → row count, insertion-ordered so a tie resolves to the earliest. */
  readonly classCounts: Map<string, number>
}

function newGroup(event: TimelapseDetectionEvent): Group {
  const classCounts = new Map<string, number>()
  if (event.className !== undefined) classCounts.set(event.className, 1)
  return {
    ...(event.trackId !== undefined ? { trackId: event.trackId } : {}),
    firstSeen: event.timestamp,
    lastSeen: event.timestamp,
    classCounts,
  }
}

function absorb(group: Group, event: TimelapseDetectionEvent): void {
  if (event.timestamp < group.firstSeen) group.firstSeen = event.timestamp
  if (event.timestamp > group.lastSeen) group.lastSeen = event.timestamp
  if (event.className === undefined) return
  group.classCounts.set(event.className, (group.classCounts.get(event.className) ?? 0) + 1)
}

/** The class most rows agreed on; ties go to whichever appeared first, so the
 *  same window always produces the same sentence. */
function dominantClass(group: Group): string | undefined {
  let best: string | undefined
  let bestCount = 0
  for (const [className, count] of group.classCounts) {
    if (count > bestCount) {
      best = className
      bestCount = count
    }
  }
  return best
}

function toInterval(group: Group): TimelapseTrackInterval {
  const className = dominantClass(group)
  return {
    ...(group.trackId !== undefined ? { trackId: group.trackId } : {}),
    firstSeen: group.firstSeen,
    lastSeen: group.lastSeen,
    ...(className !== undefined ? { className } : {}),
  }
}

/**
 * Fold persisted tracks and object events into one subject-per-entry array.
 *
 * @returns intervals sorted by `firstSeen` ascending. A persisted track is
 *   returned unchanged and its own events are discarded: the store knows when
 *   the track really began, the events only know when the emitter chose to
 *   write one, and widening a persisted interval from event timestamps would
 *   move a range boundary for no operator-visible gain.
 */
export function mergeDetectionIntervals(
  input: DetectionIntervalInput,
): readonly TimelapseTrackInterval[] {
  const gapMs = Math.max(0, input.tracklessGapMs ?? TRACKLESS_EVENT_GAP_MS)
  const persistedIds = new Set<string>()
  for (const track of input.tracks) {
    if (track.trackId !== undefined) persistedIds.add(track.trackId)
  }

  // Ascending, so the track-less gap test only ever looks backwards and a class
  // tie resolves to the row that really came first.
  const ordered = input.events.toSorted((a, b) => a.timestamp - b.timestamp)
  const byTrackId = new Map<string, Group>()
  const trackless: Group[] = []
  const openByClass = new Map<string, Group>()

  for (const event of ordered) {
    const trackId = event.trackId
    if (trackId !== undefined) {
      // The store already answered for this id — its events add nothing, and
      // counting them would report one subject twice.
      if (persistedIds.has(trackId)) continue
      const existing = byTrackId.get(trackId)
      if (existing === undefined) byTrackId.set(trackId, newGroup(event))
      else absorb(existing, event)
      continue
    }
    // No id to group by: same class, close enough in time, same subject.
    const key = event.className ?? ''
    const open = openByClass.get(key)
    if (open !== undefined && event.timestamp - open.lastSeen <= gapMs) {
      absorb(open, event)
      continue
    }
    const group = newGroup(event)
    trackless.push(group)
    openByClass.set(key, group)
  }

  const merged = [
    ...input.tracks,
    ...[...byTrackId.values()].map(toInterval),
    ...trackless.map(toInterval),
  ]
  return merged.toSorted((a, b) => a.firstSeen - b.firstSeen)
}
