// ---------------------------------------------------------------------------
// recording-spans — turn the recording cap's per-profile availability ranges
// into a flat list of distinct playable time windows for the playback picker.
//
// `getAvailability` returns ranges PER profile (high/mid/low each cover roughly
// the same wall-clock spans), so the raw list has duplicates. The player builds
// one ABR master playlist per [from,to] window across all profiles, so the
// picker only needs the UNION of the time intervals.
// ---------------------------------------------------------------------------

export interface AvailabilityRange {
  readonly profile: string
  readonly startMs: number
  readonly endMs: number
}

export interface PlaybackSpan {
  readonly startMs: number
  readonly endMs: number
}

/**
 * Merge availability ranges (across every profile) into the union of distinct
 * time windows, ascending by start. Overlapping or touching intervals coalesce;
 * zero/negative-length inputs are dropped. Newest-first ordering is the caller's
 * concern (it reverses for display).
 */
export function mergeAvailabilitySpans(ranges: readonly AvailabilityRange[]): PlaybackSpan[] {
  const sorted = ranges
    .filter((r) => r.endMs > r.startMs)
    .map((r) => ({ startMs: r.startMs, endMs: r.endMs }))
    .toSorted((a, b) => a.startMs - b.startMs)
  const out: PlaybackSpan[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.startMs <= last.endMs) {
      if (r.endMs > last.endMs) out[out.length - 1] = { startMs: last.startMs, endMs: r.endMs }
    } else {
      out.push(r)
    }
  }
  return out
}

/**
 * Pick the right unit for a byte count and render it with a sensible number of
 * significant digits (binary prefixes, matching recording sizes elsewhere).
 * KB and up render one decimal under 100, none above; bytes never get a decimal.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`

  const units = ['KB', 'MB', 'GB', 'TB', 'PB'] as const
  let value = bytes / 1024
  let unit: (typeof units)[number] = 'KB'
  for (const u of units) {
    unit = u
    if (value < 1024) break
    value /= 1024
  }
  const rendered = value >= 100 ? Math.round(value).toString() : value.toFixed(1)
  return `${rendered} ${unit}`
}
