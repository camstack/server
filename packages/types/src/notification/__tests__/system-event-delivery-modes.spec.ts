import { describe, expect, it } from 'vitest'
import {
  NcRuleInputSchema,
  NcSystemEventDeliverySchema,
  type NcSchedule,
} from '../../capabilities/notification-rules.cap.js'
import { instantKindsOf, systemEventDeliveryAsModes } from '../system-event-classes.js'
import { systemEventDeliveryModesOf } from '../system-event-delivery-modes.js'
import {
  isScheduleOnlySystemRule,
  isSystemEventSummaryRule,
  systemEventDeliveryProblems,
  systemEventSummaryScheduleOf,
  systemEventSummarySplitOf,
} from '../system-event-summary.js'

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

const modes = (
  onActivation: boolean,
  onDeactivation: boolean,
  withSchedule = false,
): { systemEventDelivery: unknown } => ({
  systemEventDelivery: {
    mode: 'modes',
    onActivation,
    onDeactivation,
    ...(withSchedule ? { onSchedule: { schedule: EIGHT_AM, grouping: 'section' } } : {}),
  },
})

describe('systemEventDeliveryModesOf', () => {
  it('reads absent and instant as both edges, no summary (D906)', () => {
    const expected = { activation: true, deactivation: true, schedule: null }
    expect(systemEventDeliveryModesOf(rule(['device-offline']))).toEqual(expected)
    expect(
      systemEventDeliveryModesOf(
        rule(['device-offline'], { systemEventDelivery: { mode: 'instant' } }),
      ),
    ).toEqual(expected)
  })

  it('reads a legacy summary as schedule-only, split defaulting to rule', () => {
    const summary = rule(['device-battery-low'], {
      systemEventDelivery: { mode: 'summary', schedule: EIGHT_AM },
    })
    expect(systemEventDeliveryModesOf(summary)).toEqual({
      activation: false,
      deactivation: false,
      schedule: { schedule: EIGHT_AM, grouping: 'rule' },
    })
    expect(systemEventSummaryScheduleOf(summary)).toEqual(EIGHT_AM)
    expect(systemEventSummarySplitOf(summary)).toBe('rule')
    expect(isScheduleOnlySystemRule(summary)).toBe(true)
  })

  it('a modes rule with an instant mode and a schedule is a summary rule but not schedule-only', () => {
    const both = rule(['device-offline'], modes(true, false, true))
    expect(isSystemEventSummaryRule(both)).toBe(true)
    expect(isScheduleOnlySystemRule(both)).toBe(false)
    expect(systemEventSummarySplitOf(both)).toBe('section')
  })

  it('parses the modes variant and keeps the two legacy variants parseable', () => {
    expect(
      NcSystemEventDeliverySchema.safeParse({
        mode: 'modes',
        onActivation: true,
        onDeactivation: false,
      }).success,
    ).toBe(true)
    expect(NcSystemEventDeliverySchema.safeParse({ mode: 'instant' }).success).toBe(true)
    expect(
      NcSystemEventDeliverySchema.safeParse({ mode: 'modes', onActivation: true }).success,
    ).toBe(false)
  })
})

describe('instantKindsOf', () => {
  const kinds = ['device-offline', 'device-online', 'backup-completed']

  it('activation only drops the recovery edge and keeps single-edge kinds', () => {
    expect([...instantKindsOf(rule(kinds, modes(true, false)))].sort()).toEqual([
      'backup-completed',
      'device-offline',
    ])
  })

  it('deactivation only drops the bad edge and the single-edge kinds', () => {
    expect([...instantKindsOf(rule(kinds, modes(false, true)))]).toEqual(['device-online'])
  })

  it('deactivation derives the recovery edge from a bad kind alone', () => {
    expect([...instantKindsOf(rule(['device-offline'], modes(false, true)))]).toEqual([
      'device-online',
    ])
  })

  it('a schedule-only rule hears nothing at once', () => {
    expect(instantKindsOf(rule(kinds, modes(false, false, true))).size).toBe(0)
  })

  it('a legacy instant rule keeps every kind', () => {
    expect([...instantKindsOf(rule(kinds))].sort()).toEqual([
      'backup-completed',
      'device-offline',
      'device-online',
    ])
  })
})

describe('systemEventDeliveryAsModes', () => {
  it('maps instant with a recovery kind to deactivation on, and without to off', () => {
    expect(systemEventDeliveryAsModes(rule(['device-offline', 'device-online']))).toEqual({
      mode: 'modes',
      onActivation: true,
      onDeactivation: true,
    })
    expect(systemEventDeliveryAsModes(rule(['backup-completed']))).toEqual({
      mode: 'modes',
      onActivation: true,
      onDeactivation: false,
    })
  })

  it('keeps a summary schedule object identity and its split', () => {
    const summary = rule(['device-offline'], {
      systemEventDelivery: { mode: 'summary', schedule: EIGHT_AM, split: 'section' },
    })
    const out = systemEventDeliveryAsModes(summary)
    expect(out).toEqual({
      mode: 'modes',
      onActivation: false,
      onDeactivation: false,
      onSchedule: { schedule: EIGHT_AM, grouping: 'section' },
    })
  })
})

describe('systemEventDeliveryProblems for modes', () => {
  it('refuses a rule with every mode off', () => {
    expect(systemEventDeliveryProblems(rule(['device-offline'], modes(false, false)))).toEqual([
      { code: 'no-mode' },
    ])
  })

  it('refuses deactivation alone when no selected kind ever clears', () => {
    expect(systemEventDeliveryProblems(rule(['backup-completed'], modes(false, true)))).toEqual([
      { code: 'no-instant-kind' },
    ])
    expect(systemEventDeliveryProblems(rule(['device-offline'], modes(false, true)))).toEqual([])
  })

  it('accepts a new rule: activation only', () => {
    expect(systemEventDeliveryProblems(rule(['backup-completed'], modes(true, false)))).toEqual([])
  })

  it('refuses a schedule on an alarm family rule, instant mode or not', () => {
    const problems = systemEventDeliveryProblems(
      rule(['alarm-triggered'], modes(true, false, true)),
    )
    expect(problems.map((p) => p.code)).toEqual(['family-not-summarisable'])
  })

  it('allows the active-hours schedule and actions beside an instant mode, refuses them schedule-only', () => {
    expect(
      systemEventDeliveryProblems(
        rule(['device-offline'], { ...modes(true, false, true), schedule: EIGHT_AM }),
      ),
    ).toEqual([])
    const only = systemEventDeliveryProblems(
      rule(['device-battery-low'], { ...modes(false, false, true), schedule: EIGHT_AM }),
    )
    expect(only).toEqual([{ code: 'schedule-beside-summary' }])
  })
})
