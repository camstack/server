const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export interface RunTimeText {
  readonly justNow: string
  readonly minutesAgo: (count: number) => string
  readonly hoursAgo: (count: number) => string
  readonly daysAgo: (count: number) => string
}

/** Relative last-run label. `null` when the CCU recorded no run (including epoch 0). */
export function relativeRun(
  lastRunMs: number | null,
  now: number,
  text: RunTimeText,
): string | null {
  if (lastRunMs === null) return null
  const diff = now - lastRunMs
  if (diff < MINUTE_MS) return text.justNow
  if (diff < HOUR_MS) return text.minutesAgo(Math.max(1, Math.floor(diff / MINUTE_MS)))
  if (diff < DAY_MS) return text.hoursAgo(Math.max(1, Math.floor(diff / HOUR_MS)))
  return text.daysAgo(Math.max(1, Math.floor(diff / DAY_MS)))
}
