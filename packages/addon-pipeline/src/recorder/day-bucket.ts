/** Pure helpers to bucket recording segment starts into local calendar days. */

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Epoch (UTC ms) of the local midnight that starts the day containing `ms`.
 * `tzOffsetMinutes` is minutes to ADD to UTC to get local time — i.e. the client
 * sends `-new Date().getTimezoneOffset()`. Returning a UTC epoch (not a date
 * string) lets the viewer compare directly against the epoch it computes per
 * calendar cell, so markers line up regardless of timezone.
 */
export function localMidnightEpoch(ms: number, tzOffsetMinutes: number): number {
  const off = tzOffsetMinutes * 60_000
  const local = ms + off
  const intoDay = ((local % DAY_MS) + DAY_MS) % DAY_MS
  return local - intoDay - off
}

/**
 * Sorted, distinct local-midnight epochs for every segment start in [fromMs, toMs).
 */
export function distinctRecordingDays(
  startsMs: readonly number[],
  fromMs: number,
  toMs: number,
  tzOffsetMinutes: number,
): number[] {
  const days = new Set<number>()
  for (const s of startsMs) {
    if (s < fromMs || s >= toMs) continue
    days.add(localMidnightEpoch(s, tzOffsetMinutes))
  }
  return [...days].toSorted((a, b) => a - b)
}
