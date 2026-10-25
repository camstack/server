/**
 * Calendar-events producer — at a closed schedule window, list upcoming
 * events for the selected calendars and enqueue one outbox row per target.
 */

import type { CalendarEvent, IScopedLogger } from '@camstack/types'
import type { NcOutbox } from '../outbox.js'
import type { NcTextCatalog } from '../text-catalog.js'
import type { ClosedWindow } from '../timelapse/window-bounds.js'
import { findLastClosedWindow } from '../timelapse/window-bounds.js'
import { buildCalendarEventsOutboxInputs } from './calendar-events-delivery.js'
import type { NcCalendarEventsRule } from './calendar-events-rule.js'
import { expandCalendarScope } from './calendar-events-selection.js'
import type { NcCalendarEventsStore } from './calendar-events-store.js'
import { calendarEventsWindow } from './calendar-events-window.js'

/** How far back a closed schedule window may still be owed. */
const CALENDAR_EVENTS_LOOKBACK_MS = 36 * 60 * 60 * 1000

export interface CalendarEventsListPort {
  listCalendars: () => Promise<readonly { readonly id: string }[]>
  listEvents: (input: {
    readonly calendarIds: readonly string[]
    readonly startMs: number
    readonly endMs: number
  }) => Promise<readonly CalendarEvent[]>
}

export interface NcCalendarEventsProducerDeps {
  readonly store: NcCalendarEventsStore
  readonly outbox: NcOutbox
  readonly calendars: CalendarEventsListPort
  readonly texts: NcTextCatalog
  readonly logger: IScopedLogger
  readonly now?: () => number
}

export interface NcCalendarEventsTickReport {
  readonly examined: number
  readonly sent: number
  readonly empty: number
  readonly skipped: number
  readonly failed: number
}

export class NcCalendarEventsProducer {
  private inFlight = false
  private readonly now: () => number

  constructor(private readonly deps: NcCalendarEventsProducerDeps) {
    this.now = deps.now ?? ((): number => Date.now())
  }

  async tick(): Promise<NcCalendarEventsTickReport> {
    if (this.inFlight) {
      return { examined: 0, sent: 0, empty: 0, skipped: 0, failed: 0 }
    }
    this.inFlight = true
    const report = { examined: 0, sent: 0, empty: 0, skipped: 0, failed: 0 }
    try {
      const rules = this.deps.store.listEnabled()
      for (const rule of rules) {
        report.examined += 1
        try {
          const outcome = await this.runRule(rule)
          if (outcome === 'sent') report.sent += 1
          else if (outcome === 'empty') report.empty += 1
          else report.skipped += 1
        } catch (err) {
          report.failed += 1
          this.deps.logger.warn('calendar-events rule failed', {
            meta: {
              ruleId: rule.id,
              error: err instanceof Error ? err.message : String(err),
            },
          })
        }
      }
      return report
    } finally {
      this.inFlight = false
    }
  }

  private async runRule(rule: NcCalendarEventsRule): Promise<'sent' | 'empty' | 'skipped'> {
    const nowMs = this.now()
    const scheduleWindow = findLastClosedWindow({
      schedule: rule.schedule,
      nowMs,
      lookbackMs: CALENDAR_EVENTS_LOOKBACK_MS,
    })
    if (scheduleWindow === null) return 'skipped'
    if ((rule.generatedAt ?? 0) >= scheduleWindow.endMs) return 'skipped'

    const known = await this.deps.calendars.listCalendars()
    const calendarIds = expandCalendarScope(
      { calendars: rule.calendars, calendarsExclude: rule.calendarsExclude },
      known.map((c) => c.id),
    )
    if (calendarIds.length === 0) {
      this.deps.logger.info('calendar-events: no calendars in scope', {
        meta: { ruleId: rule.id },
      })
      if (!rule.deliverEmpty) {
        await this.deps.store.markGenerated(rule.id, scheduleWindow.endMs)
        return 'empty'
      }
    }

    const eventWindow = calendarEventsWindow(nowMs, rule.horizonDays)
    const events =
      calendarIds.length === 0
        ? []
        : await this.deps.calendars.listEvents({
            calendarIds,
            startMs: eventWindow.startMs,
            endMs: eventWindow.endMs,
          })

    if (events.length === 0 && !rule.deliverEmpty) {
      this.deps.logger.info('calendar-events: empty horizon, not delivering', {
        meta: { ruleId: rule.id, horizonDays: eventWindow.horizonDays },
      })
      await this.deps.store.markGenerated(rule.id, scheduleWindow.endMs)
      return 'empty'
    }

    const sorted = [...events].toSorted((a, b) => a.startMs - b.startMs)
    await this.enqueue(rule, scheduleWindow, eventWindow, calendarIds, sorted)
    await this.deps.store.markGenerated(rule.id, scheduleWindow.endMs)
    return 'sent'
  }

  private async enqueue(
    rule: NcCalendarEventsRule,
    scheduleWindow: ClosedWindow,
    eventWindow: { readonly startMs: number; readonly endMs: number; readonly horizonDays: number },
    calendarIds: readonly string[],
    events: readonly CalendarEvent[],
  ): Promise<void> {
    const inputs = buildCalendarEventsOutboxInputs({
      texts: this.deps.texts,
      ruleId: rule.id,
      ruleName: rule.name,
      scheduleWindow,
      eventWindow: { startMs: eventWindow.startMs, endMs: eventWindow.endMs },
      horizonDays: eventWindow.horizonDays,
      events,
      calendarIds,
      targets: rule.targets,
      priority: rule.priority,
      ...(rule.template !== undefined ? { template: rule.template } : {}),
    })
    // `NcOutbox.enqueue` takes a BATCH — a single row is not iterable, and the
    // per-row loop here threw `inputs is not iterable` on every tick of rule
    // `9193e1f0-…` (AbfallNavi + the Example family) from 2026-10-05 14:42 onward.
    await this.deps.outbox.enqueue(inputs)
    this.deps.logger.info('calendar-events delivered', {
      meta: {
        ruleId: rule.id,
        events: events.length,
        targets: inputs.length,
        windowEndMs: scheduleWindow.endMs,
      },
    })
  }
}
