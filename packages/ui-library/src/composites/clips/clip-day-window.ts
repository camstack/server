/**
 * LOCAL calendar-day arithmetic for the clips browser.
 *
 * The browser no longer NAVIGATES days — it follows a band selected on the
 * recording timebar (D564) — but the local day survived the move as the unit
 * the COST is counted in: a Reolink search is clamped to one camera-local day
 * per call, so `clip-band.ts` counts a band's local days to decide whether it
 * may be asked for. The window builder this file used to own went with the day
 * picker; `recording-timeline-model.ts`'s `dayWindow(date, nowMs)` is the one
 * that builds windows now, and one directory holding two functions of that
 * name was the confusion worth deleting.
 *
 * Two properties are pinned by spec because both are invisible until they are
 * wrong:
 *
 *  - Deriving the day in UTC shifts every band by the browser's offset, and an
 *    operator in Berlin would see a 22:00 clip filed under the next day.
 *  - Walking days by adding 86 400 000 ms repeats or skips a calendar day
 *    across a DST change. The walk goes through `Date`'s own day arithmetic.
 *
 * A day id is `YYYY-MM-DD` — it orders lexicographically, which is what lets
 * the band's day walk terminate on a comparison rather than on a count.
 */

function pad2(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value)
}

/** Parse `YYYY-MM-DD` into its local-midnight `Date`. */
function startOfDay(dayId: string): Date {
  const [year, month, day] = dayId.split('-').map((part) => Number(part))
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1, 0, 0, 0, 0)
}

/** The LOCAL calendar day an instant falls in, as `YYYY-MM-DD`. */
export function toDayId(instant: Date): string {
  return `${String(instant.getFullYear())}-${pad2(instant.getMonth() + 1)}-${pad2(instant.getDate())}`
}

/** Walk `days` calendar days from `dayId` — DST-safe, because `Date` does it. */
export function shiftDay(dayId: string, days: number): string {
  const moved = startOfDay(dayId)
  moved.setDate(moved.getDate() + days)
  return toDayId(moved)
}

/**
 * The day, spelled out — the calendar half of a band's label.
 *
 * An empty list has to say WHICH period it is empty for; "no clips" with no
 * date beside it is the ambiguity this surface exists to remove. `formatBandLabel`
 * puts the times around it, and every state renders the result, not only the
 * populated one.
 */
export function formatDayLabel(dayId: string): string {
  const start = startOfDay(dayId)
  return start.toLocaleDateString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}
