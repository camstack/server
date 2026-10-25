/**
 * WHEN a state summary is sent (D647): the END of a window of the rule's
 * `NcSchedule` — the same meaning the fixed-time digest gives a window close.
 *
 * ## Computed, not scanned (D647 review I4)
 *
 * The digest finds a close by walking back minute by minute through
 * `isScheduleActive`, which is fine once per window and not fine on every tick
 * of every rule: a weekly rule cost ≈ 400 ms per 30 s tick. Here the only
 * instants that CAN be a transition are generated directly — each window's
 * start and end minute, on each calendar day of the range, in the schedule's
 * timezone — and each candidate is then VERIFIED with `isScheduleActive`
 * (active the minute before, inactive at it). So the authority on what a
 * window means (midnight crossing, `invert`, overlapping windows, the IANA
 * timezone) is still `isScheduleActive`; the cost is O(windows × days), not
 * O(minutes). A candidate a DST gap moved is simply not verified.
 *
 * Pure. The decision for one rule at one moment:
 *
 *  - `idle`   — no window has closed since the floor;
 *  - `send`   — the last close after the floor is owed; `late` when the tick is
 *               past it by more than a tick (a restart, a stalled loop);
 *  - `missed` — it closed longer ago than the grace: skipped, stamped and
 *               logged by the caller, never silent.
 *
 * A window is owed by its CLOSE, whenever it opened: a rule armed in the middle
 * of a window is sent at that window's close (review M1).
 */
import { isScheduleActive, type NcSchedule } from '@camstack/types'
import type { ClosedWindow } from '../timelapse/window-bounds.js'
import { addDays, zonedDayOf, zonedInstant } from './zoned-clock.js'

/** How long after its close a window may still be sent. */
export const NC_STATE_SUMMARY_GRACE_MS = 3 * 3_600_000

/** The widest look back: a weekly schedule closes at least once in eight days. */
export const NC_STATE_SUMMARY_MAX_LOOKBACK_MS = 8 * 86_400_000

/** A close found by the tick right after it is on time; later than this is `late`. */
const ON_TIME_MS = 2 * 60_000
const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

export type NcStateSummaryDecision =
  | { readonly kind: 'idle' }
  | { readonly kind: 'send'; readonly window: ClosedWindow; readonly late: boolean }
  | { readonly kind: 'missed'; readonly window: ClosedWindow }

/** Is the schedule active at an instant — `isScheduleActive` unless a spec counts the calls. */
export type NcScheduleProbe = (schedule: NcSchedule, atMs: number) => boolean

export interface NcStateSummaryDecisionInput {
  readonly schedule: NcSchedule
  readonly nowMs: number
  /** No window closing at or before this is ever sent. */
  readonly floorMs: number
  readonly graceMs?: number
  readonly probe?: NcScheduleProbe
}

type TransitionKind = 'open' | 'close'

/**
 * Every verified transition of `kind` in `(fromMs, toMs]`, ascending.
 * Candidates are each window's start and end minute on each day of the range
 * (the day before `fromMs` included, for a window crossing midnight).
 */
function scheduleTransitions(
  schedule: NcSchedule,
  fromMs: number,
  toMs: number,
  kind: TransitionKind,
  probe: NcScheduleProbe = isScheduleActive,
): readonly number[] {
  if (toMs <= fromMs) return []
  const first = zonedDayOf(fromMs - DAY_MS, schedule.timezone)
  const days = Math.ceil((toMs - fromMs) / DAY_MS) + 2
  const minutes = new Set<number>()
  for (const window of schedule.windows) {
    minutes.add(window.startMinute)
    minutes.add(window.endMinute)
  }
  const found = new Set<number>()
  for (let offset = 0; offset <= days; offset += 1) {
    const day = addDays(first, offset)
    for (const minute of minutes) {
      const at = zonedInstant(day, minute, schedule.timezone)
      if (at <= fromMs || at > toMs || found.has(at)) continue
      const before = probe(schedule, at - MINUTE_MS)
      const after = probe(schedule, at)
      if (kind === 'close' ? before && !after : !before && after) found.add(at)
    }
  }
  return [...found].toSorted((a, b) => a - b)
}

/** The first window close after `afterMs`, within `horizonMs`, or `null`. */
export function nextStateSummaryClose(
  schedule: NcSchedule,
  afterMs: number,
  horizonMs: number = NC_STATE_SUMMARY_MAX_LOOKBACK_MS,
  probe?: NcScheduleProbe,
): number | null {
  return scheduleTransitions(schedule, afterMs, afterMs + horizonMs, 'close', probe)[0] ?? null
}

export function decideStateSummary(input: NcStateSummaryDecisionInput): NcStateSummaryDecision {
  const from = Math.max(input.floorMs, input.nowMs - NC_STATE_SUMMARY_MAX_LOOKBACK_MS)
  const closes = scheduleTransitions(input.schedule, from, input.nowMs, 'close', input.probe)
  const endMs = closes.at(-1)
  if (endMs === undefined) return { kind: 'idle' }
  // Where the window opened: informational (the log line, the row's data) —
  // the latest opening in the day before the close, or the close itself when
  // the window is longer than that.
  const opens = scheduleTransitions(input.schedule, endMs - DAY_MS, endMs, 'open', input.probe)
  const window: ClosedWindow = { startMs: opens.at(-1) ?? endMs, endMs }
  const overdueMs = input.nowMs - endMs
  if (overdueMs > (input.graceMs ?? NC_STATE_SUMMARY_GRACE_MS)) return { kind: 'missed', window }
  return { kind: 'send', window, late: overdueMs > ON_TIME_MS }
}
