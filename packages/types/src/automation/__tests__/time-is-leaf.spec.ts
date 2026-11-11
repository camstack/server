/**
 * The `time-is` state leaf: schema refusals, the gate "event AND only between
 * 22:00 and 06:00 on weekdays", the unknown case (no site), and the boundary
 * the generated block arms a timer for.
 */
import { describe, expect, it } from 'vitest'
import { zoneOnlySite, type TimeSite } from '../../time/time-spec.js'
import { ConditionMirror, evaluateWhenTree, nextTimeBoundaryInMs } from '../condition-eval.js'
import { AutomationWhenSchema, type AutomationWhen } from '../when.js'

const ROME: TimeSite = { lat: 41.9028, lon: 12.4964, timeZone: 'Europe/Rome' }
const at = (iso: string): number => Date.parse(iso)
const mirror = new ConditionMirror([])

const nightWeekdays = {
  kind: 'time-is',
  between: { from: { kind: 'clock', hh: 22, mm: 0 }, to: { kind: 'clock', hh: 6, mm: 0 } },
  days: ['mon', 'tue', 'wed', 'thu', 'fri'],
} as const satisfies AutomationWhen
const button = { kind: 'device-event', category: 'button.pressed' } as const

describe('time-is schema', () => {
  it('accepts a window, days, or both', () => {
    expect(AutomationWhenSchema.safeParse(nightWeekdays).success).toBe(true)
    expect(AutomationWhenSchema.safeParse({ kind: 'time-is', days: ['sat'] }).success).toBe(true)
  })

  it('refuses neither field, empty days, and a one-date spec', () => {
    expect(AutomationWhenSchema.safeParse({ kind: 'time-is' }).success).toBe(false)
    expect(AutomationWhenSchema.safeParse({ kind: 'time-is', days: [] }).success).toBe(false)
    const dated = {
      kind: 'time-is',
      between: {
        from: { kind: 'date', local: '2026-01-01T10:00' },
        to: { kind: 'clock', hh: 6, mm: 0 },
      },
    }
    const refused = AutomationWhenSchema.safeParse(dated)
    expect(refused.success).toBe(false)
    expect(JSON.stringify(refused.error?.issues)).toContain('one-date')
  })
})

describe('time-is evaluation', () => {
  const gate: AutomationWhen = { kind: 'all', children: [button, nightWeekdays] }

  it('passes at 23:00 on a Tuesday and fails at 23:00 on a Saturday', () => {
    const tue = evaluateWhenTree(gate, mirror, at('2026-01-13T22:00:00Z'), {
      firedPath: 'when.0',
      site: ROME,
    })
    expect(tue.pass).toBe(true)
    expect(tue.nodes.find((n) => n.path === 'when.1')).toMatchObject({
      kind: 'time-is',
      outcome: 'pass',
    })
    const sat = evaluateWhenTree(gate, mirror, at('2026-01-17T22:00:00Z'), {
      firedPath: 'when.0',
      site: ROME,
    })
    expect(sat.pass).toBe(false)
    expect(sat.unknown).toBe(false)
  })

  it('reports the soonest boundary as timeDueInMs', () => {
    const now = at('2026-01-13T22:00:00Z') // Tue 23:00; the window ends Wed 06:00 = 05:00Z
    const r = evaluateWhenTree(nightWeekdays, mirror, now, { site: ROME })
    expect(r.timeDueInMs).toBe(at('2026-01-14T05:00:00Z') - now)
  })

  it('is unknown without a site, and a not over it is flagged', () => {
    const r = evaluateWhenTree(
      { kind: 'not', child: nightWeekdays },
      mirror,
      at('2026-01-13T22:00:00Z'),
    )
    expect(r.pass).toBe(true)
    expect(r.unknown).toBe(true)
    expect(r.timeDueInMs).toBeUndefined()
  })

  it('is unknown for a sun window on a zone-only site', () => {
    const sun: AutomationWhen = {
      kind: 'time-is',
      between: {
        from: { kind: 'sun', event: 'sunset', offsetMin: 0 },
        to: { kind: 'clock', hh: 6, mm: 0 },
      },
    }
    const r = evaluateWhenTree(sun, mirror, at('2026-01-13T22:00:00Z'), {
      site: zoneOnlySite('Europe/Rome'),
    })
    expect(r).toMatchObject({ pass: false, unknown: true })
  })

  it('nextTimeBoundaryInMs sees a leaf the short-circuit skipped', () => {
    const now = at('2026-01-13T22:00:00Z')
    const tree: AutomationWhen = { kind: 'all', children: [button, nightWeekdays] }
    // the button did not fire: `all` stops at when.0 and never evaluates the time leaf
    const r = evaluateWhenTree(tree, mirror, now, { site: ROME })
    expect(r.nodes.find((n) => n.path === 'when.1')?.outcome).toBe('not-evaluated')
    expect(r.timeDueInMs).toBeUndefined()
    expect(nextTimeBoundaryInMs(tree, now, ROME)).toBe(at('2026-01-14T05:00:00Z') - now)
    expect(nextTimeBoundaryInMs(tree, now, undefined)).toBeUndefined()
    expect(nextTimeBoundaryInMs(button, now, ROME)).toBeUndefined()
  })
})

describe('time-is in a step guard', () => {
  it('judges with the site handed in, and is unknown without one', async () => {
    const { evaluateStepCondition } = await import('../step-condition.js')
    const fetchers = {
      fetchSlice: async () => ({}),
      fetchStableIds: async () => new Map<string, number>(),
    }
    const now = (): number => at('2026-01-13T22:00:00Z')
    expect(
      (await evaluateStepCondition(nightWeekdays, fetchers, now, undefined, ROME)).result,
    ).toBe('true')
    expect((await evaluateStepCondition(nightWeekdays, fetchers, now)).result).toBe('unknown')
  })
})
