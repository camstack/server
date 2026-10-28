import { describe, expect, it } from 'vitest'
import type { AutomationCondition, AutomationRecipe } from '../recipe.js'
import {
  AutomationRecipeSchema,
  AutomationTriggerSchema,
  conditionDepth,
  countConditionLeaves,
  MAX_CONDITION_LEAVES,
  validateRecipeBounds,
} from '../recipe.js'

describe('stationary trigger', () => {
  const ok = { kind: 'stationary', deviceIds: [7], phase: 'appeared' }

  it('accepts the trigger and refuses no device, an unknown phase and empty filters', () => {
    expect(AutomationTriggerSchema.safeParse(ok).success).toBe(true)
    expect(
      AutomationTriggerSchema.safeParse({
        ...ok,
        phase: 'departed',
        classes: ['vehicle'],
        zones: ['drive'],
      }).success,
    ).toBe(true)
    expect(AutomationTriggerSchema.safeParse({ ...ok, deviceIds: [] }).success).toBe(false)
    expect(AutomationTriggerSchema.safeParse({ ...ok, phase: 'moved' }).success).toBe(false)
    expect(AutomationTriggerSchema.safeParse({ ...ok, phase: undefined }).success).toBe(false)
    expect(AutomationTriggerSchema.safeParse({ ...ok, classes: [] }).success).toBe(false)
    expect(AutomationTriggerSchema.safeParse({ ...ok, zones: [] }).success).toBe(false)
  })
})

describe('stationary-present condition', () => {
  const present: AutomationCondition = {
    kind: 'stationary-present',
    deviceId: 7,
    classes: ['vehicle'],
    zones: ['drive'],
  }
  const wrap = (conditions: AutomationCondition): AutomationRecipe => ({
    triggers: [{ kind: 'manual' }],
    conditions,
    actions: [{ kind: 'wait', seconds: 1 }],
  })

  it('is accepted by the recipe schema, counted as one leaf and one level', () => {
    const recipe = wrap({ kind: 'all', children: [present, present] })
    expect(AutomationRecipeSchema.safeParse(recipe).success).toBe(true)
    expect(countConditionLeaves(present)).toBe(1)
    expect(countConditionLeaves({ kind: 'all', children: [present, present] })).toBe(2)
    expect(conditionDepth(present)).toBe(1)
    expect(conditionDepth({ kind: 'not', child: present })).toBe(2)
    expect(validateRecipeBounds(recipe)).toBeNull()
  })

  it('shares the leaf budget with the other leaves', () => {
    const many: AutomationCondition = {
      kind: 'all',
      children: Array.from({ length: MAX_CONDITION_LEAVES + 1 }, () => present),
    }
    expect(validateRecipeBounds(wrap(many))).toContain('leaves')
  })

  it('refuses a leaf with no device or an empty filter', () => {
    const parses = (leaf: object): boolean =>
      AutomationRecipeSchema.safeParse({
        triggers: [{ kind: 'manual' }],
        conditions: { kind: 'stationary-present', ...leaf },
        actions: [{ kind: 'wait', seconds: 1 }],
      }).success
    expect(parses({ deviceId: 7 })).toBe(true)
    expect(parses({})).toBe(false)
    expect(parses({ deviceId: 7, classes: [] })).toBe(false)
    expect(parses({ deviceId: 7, zones: [] })).toBe(false)
  })
})
