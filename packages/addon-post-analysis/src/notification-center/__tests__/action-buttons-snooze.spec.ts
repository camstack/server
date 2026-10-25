/**
 * The "not now" buttons a notification carries.
 *
 * Two refusals carry the weight, and both are neutralisation-checked below by
 * a CONTROL that must still produce buttons:
 *
 *  - an ALARM rule gets none, so the surface never offers a silence the gate
 *    would then refuse;
 *  - `snoozeOptions: []` gets none, which is the operator's explicit override.
 */

import type { NcRule } from '@camstack/types'
import { NC_DEFAULT_SNOOZE_MINUTES } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildSnoozeButtons, type SnoozeButtonRule, snoozeChoices } from '../action-buttons.js'

const mintUrl = (i: { actionId: string; minutes: number }): string =>
  `https://h.example/nc-action/${i.actionId}?m=${i.minutes}`

const label = (minutes: number): string => `Silenzia ${minutes}m`

function rule(
  over: Partial<Pick<NcRule, 'conditions' | 'actions' | 'snoozeOptions'>> = {},
): SnoozeButtonRule {
  return { conditions: {}, ...over }
}

describe('which durations are offered', () => {
  it('uses the defaults when the rule says nothing', () => {
    const out = buildSnoozeButtons({ rule: rule(), mintUrl, label })
    expect(out.map((b) => b.label)).toEqual(NC_DEFAULT_SNOOZE_MINUTES.map((m) => `Silenzia ${m}m`))
  })

  it('uses the rule’s own list when it has one', () => {
    const out = buildSnoozeButtons({ rule: rule({ snoozeOptions: [5, 120] }), mintUrl, label })
    expect(out.map((b) => b.id)).toEqual(['snooze-5', 'snooze-120'])
  })

  it('sorts, de-duplicates and drops the unusable', () => {
    expect(snoozeChoices([60, 10, 10, 0, 99_999, 30])).toEqual([10, 30, 60])
  })

  it('never carries more than four', () => {
    expect(snoozeChoices([1, 2, 3, 4, 5, 6])).toEqual([1, 2, 3, 4])
  })
})

describe('the buttons themselves', () => {
  it('are BACKGROUND calls — a dismissal must not open a browser', () => {
    const out = buildSnoozeButtons({ rule: rule({ snoozeOptions: [30] }), mintUrl, label })
    expect(out[0]?.mode).toBe('background')
    expect(out[0]?.icon).toBe('silence')
    expect(out[0]?.url).toContain('snooze-30')
  })

  it('carry an id that names the choice, so the audit line can say which', () => {
    const out = buildSnoozeButtons({ rule: rule({ snoozeOptions: [10, 60] }), mintUrl, label })
    expect(out.map((b) => b.id)).toEqual(['snooze-10', 'snooze-60'])
  })
})

describe('the two refusals', () => {
  it('an EMPTY list means no buttons — never "fall back to the defaults"', () => {
    expect(buildSnoozeButtons({ rule: rule({ snoozeOptions: [] }), mintUrl, label })).toEqual([])
  })

  it('an ALARM rule gets none', () => {
    expect(
      buildSnoozeButtons({
        rule: rule({ conditions: { systemEvent: { kinds: ['alarm-triggered'] } } }),
        mintUrl,
        label,
      }),
    ).toEqual([])
  })

  it('a rule that ARMS the panel gets none either', () => {
    expect(
      buildSnoozeButtons({
        rule: rule({
          actions: {
            onTrigger: [
              {
                kind: 'do',
                action: { kind: 'cap', deviceId: 900, cap: 'alarm-panel', method: 'trigger' },
              },
            ],
          },
        }),
        mintUrl,
        label,
      }),
    ).toEqual([])
  })

  it('CONTROL — a rule that is neither still gets its buttons', () => {
    // Neutralisation guard: without this, a builder that returned `[]`
    // unconditionally would pass every assertion above.
    expect(
      buildSnoozeButtons({
        rule: rule({ conditions: { systemEvent: { kinds: ['device-offline'] } } }),
        mintUrl,
        label,
      }).length,
    ).toBeGreaterThan(0)
  })
})
