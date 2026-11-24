/**
 * Schedule-window evaluation for the notification-rule vocabulary.
 *
 * Hoisted out of the notification-centre's rule engine when a SECOND
 * consumer appeared (the OSD manager gates an overlay on the same
 * `NcSchedule`). Addons never import each other, so the alternative was a
 * copy — and this repo has already recorded what a second copy of a
 * vocabulary costs (`condition-taxonomy.ts`): two implementations, free to
 * drift, with nothing that fails when they do.
 *
 * The stored shape (`windows[{days 0-6, startMinute, endMinute}]`, `timezone`,
 * `invert`) is unchanged; each window is read as a `TimeWindow` and judged by
 * the one evaluator, `judgeTimeWindow`.
 *
 * Pure: no clock of its own, `atMs` is always supplied by the caller.
 */
import type { NcSchedule, NcScheduleWindow } from '../capabilities/notification-rules.cap.js'
import { hostTimeZone, isWithinClockRange } from '../time/clock-range.js'
import { isKnownTimeZone, zoneOnlySite } from '../time/time-spec.js'

/** An absent or unknown IANA name reads the host zone. */
function scheduleZone(timezone: string | undefined): string {
  return timezone !== undefined && isKnownTimeZone(timezone) ? timezone : hostTimeZone()
}

/**
 * A window with no listed day, or whose start equals its end, is EMPTY in this
 * vocabulary (it never matches); the shared model would read equal ends as a
 * whole day, so such a window is not handed to it.
 */
function isEmptyWindow(w: NcScheduleWindow): boolean {
  return w.days.length === 0 || w.startMinute === w.endMinute
}

/**
 * Is the schedule active at `atMs`? No schedule = always active. Windows
 * are OR'd; a window with `startMinute > endMinute` crosses midnight (it
 * starts on a listed day and spills into the next). `invert` flips the
 * result (active OUTSIDE the windows).
 */
export function isScheduleActive(schedule: NcSchedule | undefined, atMs: number): boolean {
  if (schedule === undefined) return true
  const site = zoneOnlySite(scheduleZone(schedule.timezone))
  const inside = schedule.windows.some(
    (w) => !isEmptyWindow(w) && isWithinClockRange(w.days, w.startMinute, w.endMinute, atMs, site),
  )
  return schedule.invert === true ? !inside : inside
}
