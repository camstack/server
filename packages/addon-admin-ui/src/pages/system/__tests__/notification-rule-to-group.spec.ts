import type { NcRule } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { canConvertToGroup, planRuleGroup } from '../notification-rule-to-group'

type RuleSlice = Pick<NcRule, 'targets' | 'targetOverrides' | 'disabledTargetIds'>

const rule = (over: Partial<RuleSlice> = {}): RuleSlice => ({
  targets: [{ targetId: 'phone' }, { targetId: 'speaker' }],
  disabledTargetIds: [],
  ...over,
})

describe('converting a rule to a notifier group', () => {
  it('is offered for two or more notifiers, never for one, a group, or an unanswered target list', () => {
    const targets = [
      { id: 'phone', kind: 'ntfy' },
      { id: 'speaker', kind: 'alexa' },
      { id: 'family', kind: 'group' },
    ]
    expect(canConvertToGroup(rule(), targets)).toBe(true)
    expect(canConvertToGroup(rule({ targets: [{ targetId: 'phone' }] }), targets)).toBe(false)
    expect(
      canConvertToGroup(
        rule({ targets: [{ targetId: 'phone' }, { targetId: 'family' }] }),
        targets,
      ),
    ).toBe(false)
    expect(canConvertToGroup(rule(), undefined)).toBe(false)
  })

  it('makes one member per notifier, in the rule order', () => {
    expect(planRuleGroup(rule())).toEqual({
      members: [{ targetId: 'phone' }, { targetId: 'speaker' }],
      notCarried: [],
    })
  })

  it('carries a switched-off notifier, a schedule, and the fields a notifier does not get', () => {
    const schedule = { windows: [{ days: [1], startMinute: 0, endMinute: 60 }] }
    const plan = planRuleGroup(
      rule({
        disabledTargetIds: ['speaker'],
        targetOverrides: {
          phone: { schedule, actions: false },
          speaker: { attachment: 'none' },
        },
      }),
    )
    expect(plan.notCarried).toEqual([])
    expect(plan.members[0]).toEqual({
      targetId: 'phone',
      when: { kind: 'schedule', schedule },
      fields: ['title', 'body', 'attachments', 'priority', 'sound', 'clickUrl'],
    })
    expect(plan.members[1]).toEqual({
      targetId: 'speaker',
      enabled: false,
      fields: ['title', 'body', 'actions', 'priority', 'sound', 'clickUrl'],
    })
  })

  it('names every per-notifier setting a member cannot hold', () => {
    const plan = planRuleGroup(
      rule({
        targets: [{ targetId: 'phone', params: { sound: 'siren' } }, { targetId: 'speaker' }],
        targetOverrides: {
          phone: { template: { body: 'x' }, priority: 5 },
          speaker: { attachment: 'clip' },
        },
      }),
    )
    expect(plan.notCarried).toEqual([
      { targetId: 'phone', setting: 'template' },
      { targetId: 'phone', setting: 'priority' },
      { targetId: 'phone', setting: 'params' },
      { targetId: 'speaker', setting: 'attachment-kind' },
    ])
  })
})
