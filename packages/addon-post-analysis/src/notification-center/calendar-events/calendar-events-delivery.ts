/**
 * Calendar-events digest → ordinary outbox rows.
 *
 * Files under `NC_SYSTEM_DEVICE_ID` (like state-summary): a calendar digest
 * spans no camera. Text is frozen at enqueue, in the hub language.
 */

import type { CalendarEvent, IScopedLogger, NcRuleTarget, NcTargetOverrides } from '@camstack/types'
import type { NcOutboxEnqueueInput, NcOutboxPayload } from '../outbox.js'
import { NC_SYSTEM_DEVICE_ID } from '../rule-engine.js'
import { renderTemplate } from '../render-template.js'
import { targetDelivery, targetsInSchedule } from '../target-settings.js'
import type { NcTextCatalog } from '../text-catalog.js'
import type { ClosedWindow } from '../timelapse/window-bounds.js'
import { formatCalendarEventsBody } from './calendar-events-body.js'
import type { NcCalendarEventsTemplate } from './calendar-events-rule.js'

export interface CalendarEventsDeliveryInput {
  readonly texts: NcTextCatalog
  readonly ruleId: string
  readonly ruleName: string
  readonly scheduleWindow: ClosedWindow
  readonly eventWindow: ClosedWindow
  readonly horizonDays: number
  readonly events: readonly CalendarEvent[]
  readonly calendarIds: readonly string[]
  readonly targets: readonly NcRuleTarget[]
  readonly disabledTargetIds?: readonly string[]
  readonly priority: number
  readonly template?: NcCalendarEventsTemplate
  /** Per-target settings (D1031); `logger` names a target skipped by its own schedule. */
  readonly targetOverrides?: NcTargetOverrides
  readonly logger?: IScopedLogger
}

function calendarEventsRecordId(ruleId: string, windowEndMs: number): string {
  return `calendar-events:${ruleId}:${windowEndMs}`
}

/** `YYYY-MM-DD HH:MM` in the host timezone. */
function clockOf(atMs: number): string {
  const d = new Date(atMs)
  const date = `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${date} ${time}`
}

function derivedBody(input: CalendarEventsDeliveryInput): string {
  // Fire-time "now" is the event window start the producer opened.
  return formatCalendarEventsBody(
    input.texts,
    input.events,
    input.eventWindow.startMs,
    input.horizonDays,
  )
}

function templateVars(input: CalendarEventsDeliveryInput): Record<string, string> {
  return {
    rule: input.ruleName,
    count: String(input.events.length),
    horizonDays: String(input.horizonDays),
    from: clockOf(input.eventWindow.startMs),
    to: clockOf(input.eventWindow.endMs),
    events: derivedBody(input),
    calendars: String(input.calendarIds.length),
  }
}

function stringParams(
  params: Readonly<Record<string, unknown>> | undefined,
): Record<string, string> | undefined {
  if (params === undefined) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string') out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * One outbox row per enabled target. Ready for `NcOutbox.enqueue`.
 */
export function buildCalendarEventsOutboxInputs(
  input: CalendarEventsDeliveryInput,
): readonly NcOutboxEnqueueInput[] {
  const vars = templateVars(input)
  const optedOut = new Set(input.disabledTargetIds ?? [])
  // A target's own texts replace the rule's for that target only (D1031).
  const textsFor = (
    template: NcCalendarEventsTemplate | undefined,
  ): { title: string; body: string } => ({
    title: input.texts.text({
      key: 'calendar-events.title',
      template: template?.title,
      vars,
    }),
    body: renderTemplate(template?.body, vars) ?? derivedBody(input),
  })
  const rule = {
    id: input.ruleId,
    name: input.ruleName,
    priority: input.priority,
    targetOverrides: input.targetOverrides,
  }
  const recordId = calendarEventsRecordId(input.ruleId, input.scheduleWindow.endMs)

  const enabled = input.targets.filter((t) => !optedOut.has(t.targetId))
  const scheduled =
    input.logger === undefined
      ? enabled
      : targetsInSchedule(
          input.logger,
          rule,
          enabled,
          input.scheduleWindow.endMs,
          NC_SYSTEM_DEVICE_ID,
        )
  return scheduled.map((target) => {
    const own = targetDelivery(rule, target)
    const { title, body } = textsFor(
      own.texts === undefined ? input.template : { ...input.template, ...own.texts },
    )
    const params = stringParams(own.params)
    const payload: NcOutboxPayload = {
      ruleName: input.ruleName,
      delivery: 'calendar-events',
      priority: own.priority,
      ...(own.settings !== undefined ? { targetSettings: own.settings } : {}),
      template: { title, body },
      media: 'none',
      ...(params !== undefined ? { params } : {}),
      subject: {
        deviceId: NC_SYSTEM_DEVICE_ID,
        className: 'calendar-events',
        zones: [],
        timestamp: input.scheduleWindow.endMs,
      },
    }
    return {
      ruleId: input.ruleId,
      targetId: target.targetId,
      deviceId: NC_SYSTEM_DEVICE_ID,
      recordKind: 'calendar-events' as const,
      recordId,
      payload,
    }
  })
}
