/**
 * The STATE SUMMARY delivery of a system-event rule (D647): which rules may use
 * it, and how an editor presents its schedule. One module, read by the hub's
 * save guard, the notification centre's scheduler and both rule editors.
 *
 * A `device-events` or `system` rule may say `systemEventDelivery: { mode:
 * 'summary', schedule }`: it then sends nothing per event, and at the END of
 * each window of `schedule` it sends the current state of its kinds. The alarm
 * stays instant (an alarm summarised at 08:00 is an alarm nobody heard), and a
 * `mixed` rule is read-only (D637), so neither may carry it.
 *
 * Pure: no clock, no I/O.
 */
import type {
  NcDelivery,
  NcRuleActions,
  NcSchedule,
  NcScheduleWindow,
  NcSystemEventCondition,
  NcStateSummarySplit,
  NcSystemEventDelivery,
} from '../capabilities/notification-rules.cap.js'
import { isSystemDelivery } from './rule-kinds.js'
import { type NcSystemEventFamily, systemEventFamilyOf } from './system-event-families.js'

/** The families a rule may summarise. The alarm is not one of them. */
export const NC_SYSTEM_EVENT_SUMMARY_FAMILIES: readonly NcSystemEventFamily[] = [
  'device-events',
  'system',
]

/** The part of a rule the summary delivery is judged on. */
export interface NcSystemEventDeliverySubject {
  readonly delivery: NcDelivery
  readonly conditions: { readonly systemEvent?: NcSystemEventCondition }
  readonly systemEventDelivery?: NcSystemEventDelivery
  readonly schedule?: NcSchedule
  readonly actions?: NcRuleActions
}

export type NcSystemEventDeliveryProblem =
  | { readonly code: 'not-a-system-rule'; readonly delivery: NcDelivery }
  | {
      readonly code: 'family-not-summarisable'
      readonly family: NcSystemEventFamily | 'mixed'
    }
  | { readonly code: 'empty-schedule' }
  | { readonly code: 'degenerate-window'; readonly index: number }
  | { readonly code: 'schedule-beside-summary' }
  | { readonly code: 'actions-beside-summary' }

/** The summary's schedule, or `null` for any rule that is not a summary system rule. */
export function systemEventSummaryScheduleOf(
  rule: Pick<NcSystemEventDeliverySubject, 'delivery' | 'systemEventDelivery'>,
): NcSchedule | null {
  if (!isSystemDelivery(rule.delivery)) return null
  const delivery = rule.systemEventDelivery
  return delivery?.mode === 'summary' ? delivery.schedule : null
}

/**
 * How a summary rule's window is sent (D698): `section` = one notification per
 * section; absent (every rule before D698) and any non-summary rule = `rule`.
 * The ONE reader — the scheduler, the rule test, the preview and both editors.
 */
export function systemEventSummarySplitOf(
  rule: Pick<NcSystemEventDeliverySubject, 'systemEventDelivery'>,
): NcStateSummarySplit {
  const delivery = rule.systemEventDelivery
  return delivery?.mode === 'summary' ? (delivery.split ?? 'rule') : 'rule'
}

/** Absent and `instant` are the same answer: a notification per event. */
export function isSystemEventSummaryRule(
  rule: Pick<NcSystemEventDeliverySubject, 'delivery' | 'systemEventDelivery'>,
): boolean {
  return systemEventSummaryScheduleOf(rule) !== null
}

function actionsAreSet(actions: NcRuleActions | undefined): boolean {
  if (actions === undefined) return false
  return (
    (actions.onActivation?.length ?? 0) > 0 ||
    (actions.onDeactivation?.length ?? 0) > 0 ||
    (actions.onTrigger?.length ?? 0) > 0 ||
    (actions.onTriggerOff?.length ?? 0) > 0 ||
    (actions.buttons?.length ?? 0) > 0
  )
}

/**
 * Why the hub refuses this rule's delivery. Empty = accepted. An instant rule
 * (absent or `{ mode: 'instant' }`) is never refused here.
 *
 * Beside a summary, two fields are refused because they would do nothing:
 * the rule's own `schedule` (the summary's schedule is the send time; a second
 * active-hours gate would silently empty it) and `actions` (a summary is not a
 * match, so nothing would ever run them).
 */
export function systemEventDeliveryProblems(
  rule: NcSystemEventDeliverySubject,
): readonly NcSystemEventDeliveryProblem[] {
  if (rule.systemEventDelivery?.mode !== 'summary') return []
  if (!isSystemDelivery(rule.delivery)) {
    return [{ code: 'not-a-system-rule', delivery: rule.delivery }]
  }
  const problems: NcSystemEventDeliveryProblem[] = []
  const verdict = systemEventFamilyOf(rule.conditions.systemEvent?.kinds ?? [])
  const family = verdict.kind === 'family' ? verdict.family : 'mixed'
  if (family === 'mixed' || !NC_SYSTEM_EVENT_SUMMARY_FAMILIES.includes(family)) {
    problems.push({ code: 'family-not-summarisable', family })
  }
  // A schedule with no window never closes, so the summary would never be
  // sent. The Zod schema already requires one window; a payload built past it
  // (a typed caller, a stored row) is refused here too (review M2).
  const windows = rule.systemEventDelivery.schedule.windows
  if (windows.length === 0) problems.push({ code: 'empty-schedule' })
  // A window with no day, or one that starts and ends on the same minute, is
  // never active — so it never closes, and nothing is ever sent for it.
  windows.forEach((window, index) => {
    if (window.days.length === 0 || window.startMinute === window.endMinute) {
      problems.push({ code: 'degenerate-window', index })
    }
  })
  if (rule.schedule !== undefined) problems.push({ code: 'schedule-beside-summary' })
  if (actionsAreSet(rule.actions)) problems.push({ code: 'actions-beside-summary' })
  return problems
}

export function describeSystemEventDeliveryProblem(problem: NcSystemEventDeliveryProblem): string {
  switch (problem.code) {
    case 'not-a-system-rule':
      return `a '${problem.delivery}' rule has no summary delivery — only device-events and system rules do`
    case 'family-not-summarisable':
      return problem.family === 'alarm'
        ? 'an alarm rule cannot be a scheduled summary — the alarm stays instant'
        : `a ${problem.family} rule cannot be a scheduled summary — only device-events and system rules`
    case 'degenerate-window':
      return `send time ${String(problem.index + 1)} has no day, or starts and ends on the same minute — it never closes, so nothing would be sent`
    case 'empty-schedule':
      return 'a summary rule needs at least one send time — its schedule has no window'
    case 'schedule-beside-summary':
      return 'a summary rule is sent on its summary schedule — remove the active-hours schedule'
    case 'actions-beside-summary':
      return 'a summary rule never matches an event, so its actions would never run — remove them'
  }
}

// ── "Send at HH:MM on days …" ⇄ schedule windows ────────────────────

/** One send time as an editor presents it: the days it is sent on, and the minute. */
export interface NcSummarySendTime {
  readonly days: readonly number[]
  /** Minute of the day, 0–1439. */
  readonly minute: number
}

const DAY_MINUTES = 1440

/**
 * A send time is a ONE-MINUTE window that closes at that minute: the summary is
 * sent when a window ends. Midnight starts the window at 23:59 of the day
 * BEFORE, because a window's `days` are the days it STARTS on.
 */
export function scheduleForSendTimes(
  times: readonly NcSummarySendTime[],
  timezone?: string,
): NcSchedule {
  const windows: NcScheduleWindow[] = times.map((time) => {
    const startMinute = (time.minute + DAY_MINUTES - 1) % DAY_MINUTES
    const days = time.minute === 0 ? time.days.map((day) => (day + 6) % 7) : [...time.days]
    return { days: days.toSorted((a, b) => a - b), startMinute, endMinute: time.minute }
  })
  return { windows, ...(timezone !== undefined ? { timezone } : {}) }
}

/**
 * The send times a schedule stands for, or `null` when it is not a list of
 * one-minute windows (an inverted or a longer window): the editor then shows
 * the raw windows and says the summary is sent when each one ENDS.
 */
export function sendTimesOfSchedule(schedule: NcSchedule): readonly NcSummarySendTime[] | null {
  if (schedule.invert === true) return null
  const times: NcSummarySendTime[] = []
  for (const window of schedule.windows) {
    if ((window.endMinute - window.startMinute + DAY_MINUTES) % DAY_MINUTES !== 1) return null
    const days = window.endMinute === 0 ? window.days.map((day) => (day + 1) % 7) : window.days
    times.push({ days: days.toSorted((a, b) => a - b), minute: window.endMinute })
  }
  return times
}

/**
 * Punctual times for a `mode: 'times'` editor.
 *
 * Exact one-minute windows win. Otherwise each window's END is the fire time
 * (summary delivery fires when a window closes) — so a legacy 17:00→18:00 band
 * authored as a range still opens as a single "At 18:00" row instead of two
 * clocks. `null` only when inverted (cannot map to punctual rows).
 */
export function sendTimesForEditor(schedule: NcSchedule): {
  readonly times: readonly NcSummarySendTime[]
  /** True when at least one window was longer than one minute. */
  readonly approximated: boolean
} | null {
  const exact = sendTimesOfSchedule(schedule)
  if (exact !== null) return { times: exact, approximated: false }
  if (schedule.invert === true) return null
  const times: NcSummarySendTime[] = []
  for (const window of schedule.windows) {
    const days = window.endMinute === 0 ? window.days.map((day) => (day + 1) % 7) : window.days
    times.push({ days: days.toSorted((a, b) => a - b), minute: window.endMinute })
  }
  return { times, approximated: times.length > 0 }
}

// ── The body of a summary rule ───────────────────────────────────────

const SUMMARY_CONTENT_VAR =
  /\{\{\s*summary(?:Text|Devices|Streams|Battery|Consumables|Tanks|Detection|Nodes|Addons|AddonUpdates|Updates)\s*\}\}/

/**
 * Does a custom BODY carry the summary's content (`{{summaryText}}` or a
 * section variable)? A body that does not would send a summary with nothing
 * in it; the hub then appends `{{summaryText}}` and the admin warns (review
 * M3). An absent or blank body uses the hub's own wording, which does.
 */
export function templateCarriesSummary(body: string | undefined): boolean {
  if (body === undefined || body.trim().length === 0) return true
  return SUMMARY_CONTENT_VAR.test(body)
}
