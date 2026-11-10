/**
 * D1032 — a rule's per-target settings are the BASE rule of the rules engine:
 * every delivery a rule makes (an event row, a summary, a timelapse, a calendar
 * digest) reads them through the one layer, `target-settings.ts`.
 *
 * Each path is pinned with the same four questions:
 *  1. a target's priority replaces the rule's, for that target only;
 *  2. a target's own text replaces the rule's, for that target only;
 *  3. a target outside its own schedule gets no row, and the skip is logged;
 *  4. the picture kind / buttons it asked for ride on the row for the dispatcher.
 * A rule with no override freezes exactly what it did before.
 */
import type { IScopedLogger, NcTargetOverrides } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { buildCalendarEventsOutboxInputs } from '../calendar-events/calendar-events-delivery.js'
import { deliverableNotification } from '../deliverable-fields.js'
import type { NcNotificationInput } from '../dispatcher.js'
import type { NcOutboxEnqueueInput } from '../outbox.js'
import { buildSummaryOutboxInputs } from '../summary/summary-delivery.js'
import { NcTextCatalog } from '../text-catalog.js'
import { buildTimelapseOutboxInputs } from '../timelapse/timelapse-delivery.js'
import { footageCoverage } from '../timelapse/footage-coverage.js'

/** Monday 2026-09-21 14:18 UTC, inside AFTERNOON and outside MORNING_ONLY. */
const AT = 1_790_000_300_000
const WINDOW = { startMs: AT - 3_600_000, endMs: AT }
const MONDAY = 1
const MORNING_ONLY = {
  windows: [{ days: [MONDAY], startMinute: 6 * 60, endMinute: 9 * 60 }],
  timezone: 'UTC',
}

const TARGETS = [{ targetId: 'phone' }, { targetId: 'echo' }]

const OVERRIDES: NcTargetOverrides = {
  echo: {
    priority: 5,
    template: { title: 'Short line' },
    attachment: 'none',
    actions: false,
  },
}

function silentWithSpy(): { logger: IScopedLogger; info: ReturnType<typeof vi.fn> } {
  const logger = makeSilentLogger()
  const info = vi.fn()
  return { logger: { ...logger, info }, info }
}

interface Path {
  readonly name: string
  readonly build: (extra: {
    targetOverrides?: NcTargetOverrides
    logger?: IScopedLogger
  }) => readonly NcOutboxEnqueueInput[]
}

const PATHS: readonly Path[] = [
  {
    name: 'summary',
    build: (extra) =>
      buildSummaryOutboxInputs({
        texts: new NcTextCatalog(),
        ruleId: 'r',
        ruleName: 'Night',
        window: WINDOW,
        deviceIds: [1],
        primaryDeviceId: 1,
        targets: TARGETS,
        priority: 2,
        template: { title: 'Rule title', body: 'Rule body' },
        tileCount: 1,
        cameraCount: 1,
        matchedCount: 1,
        generatedAt: AT,
        ...extra,
      }),
  },
  {
    name: 'timelapse',
    build: (extra) =>
      buildTimelapseOutboxInputs({
        texts: new NcTextCatalog(),
        ruleId: 'r',
        ruleName: 'Night',
        deviceId: 1,
        window: WINDOW,
        targets: TARGETS,
        priority: 2,
        template: { title: 'Rule title', body: 'Rule body' },
        coverage: footageCoverage(
          [{ startMs: WINDOW.startMs, endMs: WINDOW.endMs }],
          WINDOW.startMs,
          WINDOW.endMs,
        ),
        exportId: 'e',
        denseRanges: 1,
        generatedAt: AT,
        ...extra,
      }),
  },
  {
    name: 'calendar-events',
    build: (extra) =>
      buildCalendarEventsOutboxInputs({
        texts: new NcTextCatalog(),
        ruleId: 'r',
        ruleName: 'Agenda',
        scheduleWindow: WINDOW,
        eventWindow: WINDOW,
        horizonDays: 1,
        events: [],
        calendarIds: [],
        targets: TARGETS,
        priority: 2,
        template: { title: 'Rule title', body: 'Rule body' },
        ...extra,
      }),
  },
]

function rowFor(rows: readonly NcOutboxEnqueueInput[], targetId: string): NcOutboxEnqueueInput {
  const row = rows.find((candidate) => candidate.targetId === targetId)
  if (row === undefined) throw new Error(`no row for ${targetId}`)
  return row
}

describe.each(PATHS)('per-target settings on the $name path', ({ build }) => {
  it('freezes the target priority, text and settings for that target only', () => {
    const rows = build({ targetOverrides: OVERRIDES })
    const echo = rowFor(rows, 'echo').payload
    const phone = rowFor(rows, 'phone').payload
    expect(echo.priority).toBe(5)
    expect(echo.template?.title).toBe('Short line')
    expect(echo.template?.body).toContain('Rule body')
    expect(echo.targetSettings).toEqual({ attachment: 'none', actions: false })
    expect(phone.priority).toBe(2)
    expect(phone.template?.title).toBe('Rule title')
    expect(phone.targetSettings).toBeUndefined()
  })

  it('skips a target outside its own schedule, and says why', () => {
    const { logger, info } = silentWithSpy()
    const rows = build({
      targetOverrides: { echo: { schedule: MORNING_ONLY } },
      logger,
    })
    expect(rows.map((row) => row.targetId)).toEqual(['phone'])
    expect(info).toHaveBeenCalledWith(
      'notification target skipped: outside its own schedule',
      expect.objectContaining({ meta: expect.objectContaining({ targetId: 'echo' }) }),
    )
  })

  it('a rule with no override freezes what it froze before', () => {
    const rows = build({})
    expect(rows.map((row) => row.targetId)).toEqual(['phone', 'echo'])
    expect(rows.every((row) => row.payload.priority === 2)).toBe(true)
    expect(rows.every((row) => row.payload.targetSettings === undefined)).toBe(true)
  })
})

describe('the dispatcher applies the target settings at send', () => {
  function built(): NcNotificationInput {
    return {
      body: 'b',
      title: 't',
      priority: 3,
      attachments: [
        { mediaType: 'image', url: 'https://hub.example/a.jpg' },
        { mediaType: 'video', url: 'https://hub.example/a.mp4' },
      ],
      actions: [{ id: 'open', label: 'Open', url: 'https://hub.example/x' }],
    }
  }

  it('narrows the produced media to the kind the target asked for', () => {
    const out = deliverableNotification(built(), undefined, { attachment: 'clip' })
    expect(out.notification.attachments?.map((a) => a.mediaType)).toEqual(['video'])
    expect(out.narrowed).toEqual(['attachments'])
  })

  it('none keeps no picture, and no-buttons keeps no action', () => {
    const out = deliverableNotification(built(), undefined, { attachment: 'none', actions: false })
    expect(out.notification.attachments).toBeUndefined()
    expect(out.notification.actions).toBeUndefined()
    expect(out.narrowed).toEqual(['attachments', 'actions'])
  })

  it('no settings is the notification as built', () => {
    const out = deliverableNotification(built(), undefined)
    expect(out.notification.attachments).toHaveLength(2)
    expect(out.narrowed).toEqual([])
  })
})
