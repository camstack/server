import { describe, expect, it } from 'vitest'
import {
  NC_STATE_SUMMARY_SECTION_IDS,
  NcRuleInputSchema,
  NcRulePatchSchema,
  type NcSchedule,
  NcStateSummaryPreviewRowSchema,
  NcStateSummarySectionIdSchema,
} from '../../capabilities/notification-rules.cap.js'
import { isScheduleActive } from '../schedule.js'
import {
  isSystemEventSummaryRule,
  NC_SYSTEM_EVENT_SUMMARY_FAMILIES,
  scheduleForSendTimes,
  sendTimesOfSchedule,
  systemEventDeliveryProblems,
  systemEventSummaryScheduleOf,
  templateCarriesSummary,
} from '../system-event-summary.js'
import { NC_SYSTEM_EVENT_KIND_GROUP_SPECS } from '../system-event-families.js'

const EIGHT_AM: NcSchedule = {
  windows: [{ days: [1, 2, 3, 4, 5], startMinute: 479, endMinute: 480 }],
}

function rule(kinds: readonly string[], extra: Record<string, unknown> = {}) {
  return NcRuleInputSchema.parse({
    name: 'r',
    delivery: 'system-event',
    conditions: { systemEvent: { kinds } },
    targets: [{ targetId: 't1' }],
    ...extra,
  })
}

describe('systemEventDelivery on the rule schema', () => {
  it('absent means instant — no default is materialised, not even by a patch', () => {
    const parsed = rule(['device-battery-low'])
    expect(parsed.systemEventDelivery).toBeUndefined()
    expect(isSystemEventSummaryRule(parsed)).toBe(false)
    expect(NcRulePatchSchema.parse({ name: 'x' })).toEqual({ name: 'x' })
  })

  it('parses both modes and refuses a summary without a schedule', () => {
    expect(
      rule(['device-battery-low'], { systemEventDelivery: { mode: 'instant' } })
        .systemEventDelivery,
    ).toEqual({ mode: 'instant' })
    expect(
      rule(['device-battery-low'], { systemEventDelivery: { mode: 'summary', schedule: EIGHT_AM } })
        .systemEventDelivery,
    ).toEqual({ mode: 'summary', schedule: EIGHT_AM })
    expect(() =>
      rule(['device-battery-low'], { systemEventDelivery: { mode: 'summary' } }),
    ).toThrow()
  })
})

describe('systemEventDeliveryProblems — which rules may be a summary', () => {
  const summary = { systemEventDelivery: { mode: 'summary', schedule: EIGHT_AM } }

  it('is allowed on device-events and system rules', () => {
    expect(
      systemEventDeliveryProblems(rule(['device-battery-low', 'stream-offline'], summary)),
    ).toEqual([])
    expect(
      systemEventDeliveryProblems(rule(['addon-update-available', 'node-offline'], summary)),
    ).toEqual([])
    expect(NC_SYSTEM_EVENT_SUMMARY_FAMILIES).toEqual(['device-events', 'system'])
  })

  it('is refused on an alarm rule — the alarm stays instant', () => {
    expect(systemEventDeliveryProblems(rule(['alarm-triggered'], summary))).toEqual([
      { code: 'family-not-summarisable', family: 'alarm' },
    ])
  })

  it('is refused on a mixed rule and on a non-system rule', () => {
    expect(
      systemEventDeliveryProblems(rule(['device-battery-low', 'node-offline'], summary)),
    ).toEqual([{ code: 'family-not-summarisable', family: 'mixed' }])
    const detection = NcRuleInputSchema.parse({
      name: 'd',
      delivery: 'immediate',
      targets: [{ targetId: 't1' }],
      ...summary,
    })
    expect(systemEventDeliveryProblems(detection)).toEqual([
      { code: 'not-a-system-rule', delivery: 'immediate' },
    ])
  })

  it('refuses a second, active-hours schedule and actions beside a summary', () => {
    const problems = systemEventDeliveryProblems(
      rule(['device-battery-low'], {
        ...summary,
        schedule: EIGHT_AM,
        actions: { buttons: [{ id: 'b', label: 'x', sequenceId: 's' }] },
      }),
    )
    expect(problems.map((p) => p.code)).toEqual([
      'schedule-beside-summary',
      'actions-beside-summary',
    ])
  })

  it('says nothing about an instant rule, whatever it carries', () => {
    expect(systemEventDeliveryProblems(rule(['alarm-triggered']))).toEqual([])
    expect(
      systemEventDeliveryProblems(
        rule(['alarm-triggered'], { systemEventDelivery: { mode: 'instant' }, schedule: EIGHT_AM }),
      ),
    ).toEqual([])
  })

  it('systemEventSummaryScheduleOf answers only for a summary system rule', () => {
    expect(systemEventSummaryScheduleOf(rule(['device-battery-low'], summary))).toEqual(EIGHT_AM)
    expect(systemEventSummaryScheduleOf(rule(['device-battery-low']))).toBeNull()
  })
})

describe('send times ⇄ schedule windows ("send at 08:00" is a window that ENDS at 08:00)', () => {
  it('a send time becomes a one-minute window closing at that minute', () => {
    const schedule = scheduleForSendTimes([{ days: [1, 2, 3, 4, 5], minute: 480 }], 'Europe/Rome')
    expect(schedule).toEqual({
      windows: [{ days: [1, 2, 3, 4, 5], startMinute: 479, endMinute: 480 }],
      timezone: 'Europe/Rome',
    })
    expect(sendTimesOfSchedule(schedule)).toEqual([{ days: [1, 2, 3, 4, 5], minute: 480 }])
  })

  it('midnight: the window starts the day BEFORE and still closes on the chosen day', () => {
    const schedule = scheduleForSendTimes([{ days: [1], minute: 0 }], 'UTC')
    expect(schedule.windows).toEqual([{ days: [0], startMinute: 1439, endMinute: 0 }])
    // Sunday 23:59 UTC is inside, Monday 00:00 UTC is the close.
    const sunday2359 = Date.UTC(2026, 8, 27, 23, 59)
    const monday0000 = Date.UTC(2026, 8, 28, 0, 0)
    expect(isScheduleActive(schedule, sunday2359)).toBe(true)
    expect(isScheduleActive(schedule, monday0000)).toBe(false)
    expect(sendTimesOfSchedule(schedule)).toEqual([{ days: [1], minute: 0 }])
  })

  it('a schedule that is not a list of send times reads as null (the editor shows it raw)', () => {
    expect(
      sendTimesOfSchedule({ windows: [{ days: [1], startMinute: 480, endMinute: 1080 }] }),
    ).toBeNull()
    expect(
      sendTimesOfSchedule({
        windows: [{ days: [1], startMinute: 479, endMinute: 480 }],
        invert: true,
      }),
    ).toBeNull()
  })
})

describe('an EMPTY schedule is refused (review M2)', () => {
  it('a summary whose schedule has no window can never be sent', () => {
    const base = rule(['device-battery-low'])
    expect(
      systemEventDeliveryProblems({
        ...base,
        systemEventDelivery: { mode: 'summary', schedule: { windows: [] } },
      }),
    ).toEqual([{ code: 'empty-schedule' }])
  })
})

describe('a DEGENERATE window is refused (review round 2, M2)', () => {
  it('no day, or start === end, never closes', () => {
    const base = rule(['device-battery-low'])
    const withWindows = (windows: { days: number[]; startMinute: number; endMinute: number }[]) =>
      systemEventDeliveryProblems({
        ...base,
        systemEventDelivery: { mode: 'summary', schedule: { windows } },
      })
    expect(withWindows([{ days: [], startMinute: 479, endMinute: 480 }])).toEqual([
      { code: 'degenerate-window', index: 0 },
    ])
    expect(
      withWindows([
        { days: [1], startMinute: 479, endMinute: 480 },
        { days: [1], startMinute: 600, endMinute: 600 },
      ]),
    ).toEqual([{ code: 'degenerate-window', index: 1 }])
    expect(withWindows([{ days: [1], startMinute: 479, endMinute: 480 }])).toEqual([])
  })
})

describe('preview row section is the section-id enum (D698 LOW-6)', () => {
  const row = { title: 'Battery', text: '• sensor — 8 %', count: 1 }

  it('accepts a known section and an absent one (combined rule split)', () => {
    expect(NcStateSummaryPreviewRowSchema.parse({ ...row, section: 'battery' }).section).toBe(
      'battery',
    )
    expect(NcStateSummaryPreviewRowSchema.parse(row).section).toBeUndefined()
  })

  it('refuses an unknown section string — disarm: z.string() lets it through', () => {
    expect(
      NcStateSummaryPreviewRowSchema.safeParse({ ...row, section: 'backups-exports' }).success,
    ).toBe(false)
    expect(
      NcStateSummaryPreviewRowSchema.safeParse({ ...row, section: 'not-a-section' }).success,
    ).toBe(false)
  })

  it('the section-id enum is exactly the nine state-summary sections (D934 dropped tanks)', () => {
    expect([...NC_STATE_SUMMARY_SECTION_IDS]).toEqual([
      'device-state',
      'streams',
      'battery',
      'consumables',
      'detection-blind',
      'nodes',
      'addons',
      'addon-updates',
      'updates',
    ])
    expect(NcStateSummarySectionIdSchema.safeParse('tanks').success).toBe(false)
  })
})

describe('D708 — addons stopped and addon updates are two sections', () => {
  it('every section id is a kind group, and the two addon groups split the addon kinds', () => {
    const groups = new Map(NC_SYSTEM_EVENT_KIND_GROUP_SPECS.map((g) => [g.id, g.kinds]))
    for (const id of NC_STATE_SUMMARY_SECTION_IDS) expect(groups.has(id), id).toBe(true)
    expect(groups.get('addons')).toEqual(['addon-crash-loop'])
    expect(groups.get('addon-updates')).toEqual(['addon-update-available', 'addon-updated'])
    expect(groups.get('updates')).toEqual([
      'server-update-available',
      'node-updating',
      'server-updated',
      'wrapper-update-available',
    ])
  })

  it('D723 — a plain restart is a node fact, an update-driven one sits beside the update', () => {
    const groups = new Map(NC_SYSTEM_EVENT_KIND_GROUP_SPECS.map((g) => [g.id, g.kinds]))
    expect(groups.get('nodes')).toContain('node-restarting')
    expect(groups.get('nodes')).not.toContain('node-updating')
    expect(groups.get('updates')).toContain('node-updating')
    expect(groups.get('updates')).not.toContain('node-restarting')
  })

  it('a body naming only {{summaryAddonUpdates}} carries the summary — disarm: drop it from the regex', () => {
    expect(templateCarriesSummary('Updates: {{summaryAddonUpdates}}')).toBe(true)
    expect(templateCarriesSummary('Stopped: {{ summaryAddons }}')).toBe(true)
    expect(templateCarriesSummary('{{rule}}')).toBe(false)
  })
})
