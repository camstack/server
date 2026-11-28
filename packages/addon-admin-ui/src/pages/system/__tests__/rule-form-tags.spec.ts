/**
 * Rule tags (D1054) through the admin editor: load → form → save keeps them,
 * an edit of another field never drops them, and an emptied list is SENT as
 * `[]` — the hub's merge would otherwise keep the stored tags. The rules list
 * reads them through the same accessors `TaggedDataTable` uses for Build.
 */
import type { NcRule } from '@dominevo/types'
import { NC_CONDITION_CATALOG } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import {
  buildRuleInput,
  emptyRuleForm,
  NC_RULE_TABS,
  ruleToForm,
} from '../notification-rules.helpers'
import { unifiedRuleSearchText, unifiedRuleTags } from '../unified-rules-model'

function rule(extra: Partial<NcRule> = {}): NcRule {
  return {
    id: 'r1',
    name: 'Front door',
    enabled: true,
    disabledTargetIds: [],
    delivery: 'immediate',
    conditions: { classes: ['person'] },
    targets: [{ targetId: 't1' }],
    media: { attach: 'best' },
    throttle: { cooldownSec: 60, scope: 'rule-device' },
    priority: 3,
    createdBy: 'admin',
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  }
}

describe('rule tags — editor round trip', () => {
  it('keeps the tags through load → form → save', () => {
    const form = ruleToForm(rule({ tags: ['Garden', 'Night'] }))
    expect(buildRuleInput(form, undefined, NC_CONDITION_CATALOG).tags).toEqual(['Garden', 'Night'])
  })

  it('an edit of another field keeps the tags', () => {
    const form = { ...ruleToForm(rule({ tags: ['Garden'] })), name: 'Back door', priority: 5 }
    const input = buildRuleInput(form, undefined, NC_CONDITION_CATALOG)
    expect(input).toMatchObject({ name: 'Back door', priority: 5, tags: ['Garden'] })
  })

  it('a rule without tags, and an emptied list, save as []', () => {
    expect(buildRuleInput(ruleToForm(rule()), undefined, NC_CONDITION_CATALOG).tags).toEqual([])
    const emptied = { ...ruleToForm(rule({ tags: ['Garden'] })), tags: [] }
    expect(buildRuleInput(emptied, undefined, NC_CONDITION_CATALOG).tags).toEqual([])
    expect(emptyRuleForm().tags).toEqual([])
  })

  it('the Rule tab authors the tags', () => {
    expect(NC_RULE_TABS.find((tab) => tab.key === 'rule')?.fields).toContain('tags')
  })
})

describe('rule tags — list accessors', () => {
  it('an event row exposes its tags and its name as search text', () => {
    const event = {
      family: 'event',
      kind: 'detection',
      id: 'r1',
      name: 'Front door',
      enabled: true,
      rule: rule({ tags: ['Garden'] }),
    } as const
    expect(unifiedRuleTags(event)).toEqual(['Garden'])
    expect(unifiedRuleSearchText(event)).toEqual(['Front door'])
  })
})
