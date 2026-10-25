/**
 * The rule → History handoff travels in the URL (`?tab=history&ruleId=…`), the
 * way every tab on the Notifications page already does. These pin both ends:
 * the link a rule row produces, and the filter the History tab opens with.
 */
import { describe, expect, it } from 'vitest'
import {
  HISTORY_RULE_PARAM,
  HISTORY_TAB_ID,
  historyRuleOptions,
  initialHistoryFilter,
  withHistoryRuleParam,
  withHistoryTabForRule,
} from '../notification-history.helpers'

describe('withHistoryTabForRule', () => {
  it('opens the History tab on that rule, keeping every other param', () => {
    const next = withHistoryTabForRule(new URLSearchParams('tab=rules&x=1'), 'r-42')
    expect(next.get('tab')).toBe(HISTORY_TAB_ID)
    expect(next.get(HISTORY_RULE_PARAM)).toBe('r-42')
    expect(next.get('x')).toBe('1')
  })
})

describe('initialHistoryFilter', () => {
  it('without a rule in the URL: every rule, the last 24 hours', () => {
    const f = initialHistoryFilter(new URLSearchParams(''))
    expect(f.ruleId).toBe('')
    expect(f.windowHours).toBe(24)
  })

  it('seeded from a rule: that rule, over everything the outbox keeps', () => {
    // A rule whose last run was 3 days ago must not open on an empty 24 h page.
    const f = initialHistoryFilter(new URLSearchParams(`${HISTORY_RULE_PARAM}=r-42`))
    expect(f.ruleId).toBe('r-42')
    expect(f.windowHours).toBe(0)
  })
})

describe('withHistoryRuleParam', () => {
  it('writes the chosen rule, and removes it for "All rules"', () => {
    expect(withHistoryRuleParam(new URLSearchParams('tab=history'), 'r1').get('ruleId')).toBe('r1')
    expect(
      withHistoryRuleParam(new URLSearchParams('tab=history&ruleId=r1'), '').has('ruleId'),
    ).toBe(false)
  })
})

describe('historyRuleOptions', () => {
  const rules = [{ id: 'r1', name: 'Front door' }]

  it('lists the rules after "All rules"', () => {
    expect(historyRuleOptions({ rules, answered: true, selected: '' })).toEqual([
      { value: '', label: 'All rules' },
      { value: 'r1', label: 'Front door' },
    ])
  })

  it('keeps a seeded rule the list does not hold selectable — deleted only once the list ANSWERED', () => {
    expect(historyRuleOptions({ rules, answered: true, selected: 'gone' }).at(-1)).toEqual({
      value: 'gone',
      label: 'Deleted rule (gone)',
    })
    expect(historyRuleOptions({ rules: [], answered: false, selected: 'r1' }).at(-1)).toEqual({
      value: 'r1',
      label: 'r1',
    })
  })
})
