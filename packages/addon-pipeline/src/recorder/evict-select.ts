import type {
  ArchiveCensus,
  ArchiveEvictionPlan,
  EvictLimits,
  FootageArchive,
  SegmentRow,
} from './types.js'

const DAY_MS = 24 * 60 * 60 * 1000
const GB = 1_000_000_000

/**
 * Victims one retention pass may choose.
 *
 * The retention sweep is periodic, so a bounded pass that says how much it left
 * behind is strictly better than an unbounded one that materialises a whole
 * device's archive to delete it in one go — 145 664 segments on one location of
 * the live hub today, and the whole point of D287 is that nothing here may be
 * proportional to the archive. What this pass does not reach, the next tick
 * does, oldest-first from the same cursor position.
 */
export const PRUNE_MAX_SEGMENTS_PER_PASS = 20_000

/**
 * Choose retention victims for ONE camera from the ARCHIVE, oldest-first.
 *
 * ## Why this replaced the array version
 *
 * `selectEvictions(index.segments(deviceId), limits)` read the RAM index, and
 * since D287 that index holds the live tail plus whatever an operator happened
 * to look at. A policy prune over it selects a fraction of what has expired,
 * deletes exactly that, and returns a floor computed from the same fraction —
 * an under-prune that looks identical to a correct one. §P4 of the
 * memory/CPU plan named this before it could fire (no device declares a
 * retention policy yet); the same defect DID fire on the relocate mover the
 * same week.
 *
 * ## Why one pass and why it may stop early
 *
 * Rows arrive oldest-first, so every age-expired row is at the front, and the
 * size pass's "bytes still standing" only ever DECREASES as it selects. The
 * first row that is neither expired nor needed for the size cap therefore
 * proves no later row can be either — the walk stops there. A whole-archive
 * read is not merely avoided, it is unreachable.
 *
 * ## What an unanswerable census does
 *
 * Nothing (D49). The size limit is a comparison against the device's TOTAL
 * bytes; without that total the honest answer is to skip the size half and say
 * so, because the failure mode of guessing is a DELETE. The age half needs no
 * total and still runs.
 */
export async function selectEvictionsFromArchive(
  archive: FootageArchive,
  deviceId: number,
  limits: EvictLimits,
): Promise<ArchiveEvictionPlan> {
  const maxAgeDays = limits.maxAgeDays
  const maxSizeGb = limits.maxSizeGb
  const cutoff =
    maxAgeDays !== undefined && maxAgeDays !== null && maxAgeDays > 0
      ? limits.nowMs - maxAgeDays * DAY_MS
      : null
  const cap = maxSizeGb !== undefined && maxSizeGb !== null && maxSizeGb > 0 ? maxSizeGb * GB : null
  const census: ArchiveCensus | null = await archive.census({ deviceId })
  if (cutoff === null && cap === null) {
    return {
      victims: [],
      archiveSegments: census?.segments ?? null,
      seen: 0,
      bounded: false,
      sizeLimitApplied: false,
    }
  }
  // The size half compares against what the DEVICE holds. `null` census =>
  // that comparison cannot be made, so it is not made.
  const sizeLimitApplied = cap !== null && census !== null
  let standing = census?.bytes ?? 0

  const victims: SegmentRow[] = []
  let seen = 0
  let bounded = false
  outer: for await (const page of archive.streamSegments({ deviceId })) {
    for (const row of page) {
      seen += 1
      // Strict-less-than: a segment starting exactly at `cutoff` is "not yet
      // expired" — the boundary rule the array version carried, kept verbatim.
      const expired = cutoff !== null && row.startMs < cutoff
      const overCap = sizeLimitApplied && cap !== null && standing > cap
      if (!expired && !overCap) break outer
      victims.push(row)
      standing -= row.bytes
      if (victims.length >= PRUNE_MAX_SEGMENTS_PER_PASS) {
        bounded = true
        break outer
      }
    }
  }
  return {
    victims,
    archiveSegments: census?.segments ?? null,
    seen,
    bounded,
    sizeLimitApplied,
  }
}

/**
 * Pick the oldest segments whose cumulative bytes reach `targetBytes` (free ≈ targetBytes).
 * Oldest-first, no pinning. Returns all segments if the target exceeds the total; empty for a non-positive target.
 *
 * Selection is segment-granular: the actual reclaimable bytes may EXCEED `targetBytes` by up to
 * the size of the last selected segment (a 1-byte target still evicts one whole segment). Callers
 * sizing a reclaim share (e.g. StoragePressureManager) should expect this overshoot.
 *
 * The input here is ALREADY BOUNDED — `SegmentHourLedger.oldestSegments` reads
 * only enough hours to cover the target — so the copy-and-sort is over a
 * handful of hours, never over an archive. That is the difference between this
 * and the whole-device `selectEvictions` that used to sit beside it.
 */
export function selectEvictionsByBytes(
  segments: readonly SegmentRow[],
  targetBytes: number,
): SegmentRow[] {
  if (targetBytes <= 0) return []
  const oldestFirst = [...segments].toSorted((a, b) => a.startMs - b.startMs)
  const out: SegmentRow[] = []
  let freed = 0
  for (const s of oldestFirst) {
    if (freed >= targetBytes) break
    out.push(s)
    freed += s.bytes
  }
  return out
}
