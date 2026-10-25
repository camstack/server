/**
 * Pure epoch→segment resolution for the recorder STILL data-plane
 * (`/addon/recorder/still/<deviceId>/<epochSec>`).
 *
 * The still route decodes ONE frame near a wall-clock instant from the recorded
 * LOW footage — used by the export dialog's start/end frame previews (a one-off
 * still, not frame-rate playback). This module owns only the DECISION (which
 * segment covers the instant + the seek offset from that segment's start); the
 * ffmpeg one-shot lives in `still-frame-service.ts` so this stays unit-testable
 * without a binary.
 */
/** One LOW segment as the recording index rows it: shaped so callers can pass
 *  `index.segmentsOverlapping(deviceId, 'low', …)` straight through, and the
 *  absolute file resolves from `locationId` without a cast. */
export interface LowSegmentRow {
  /** Path RELATIVE to the recordings root (the segment-path layout). */
  readonly path: string
  readonly startMs: number
  readonly durMs: number
  /** Storage location the segment lives on — resolves the absolute root. */
  readonly locationId: string
}

/** The segment covering an instant + the seek offset (seconds) from its start. */
export interface StillSource {
  readonly row: LowSegmentRow
  /** Seconds from `row.startMs` to the requested instant (input-seek offset). */
  readonly offsetSec: number
}

/**
 * Resolve the low segment covering `epochMs` and the seek offset from that
 * segment's start. Returns the LAST segment whose half-open span
 * `[startMs, startMs+durMs)` contains the instant (segments can overlap after a
 * restart; the newest wins). Null when no segment covers the instant.
 *
 * `segments` may be a CANDIDATE WINDOW rather than the device's whole archive —
 * the caller narrows it with an index search. The membership test below stays
 * regardless: narrowing may only remove rows that could not have won, never
 * decide which of the survivors does.
 */
export function resolveStillSource(
  segments: readonly LowSegmentRow[],
  epochMs: number,
): StillSource | null {
  let match: LowSegmentRow | null = null
  for (const s of segments) {
    if (epochMs >= s.startMs && epochMs < s.startMs + s.durMs) {
      if (match === null || s.startMs >= match.startMs) match = s
    }
  }
  if (match === null) return null
  const offsetSec = Math.max(0, (epochMs - match.startMs) / 1000)
  return { row: match, offsetSec }
}
