import { describe, expect, it } from 'vitest'
import type { AutomationCondition, AutomationRecipe } from '../recipe.js'
import {
  AutomationRecipeSchema,
  conditionDepth,
  countConditionLeaves,
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_LEAVES,
  validateRecipeBounds,
} from '../recipe.js'

/** Build a nested ALL chain `depth` levels deep, ending in one leaf. */
function nest(depth: number): AutomationCondition {
  const leaf: AutomationCondition = {
    kind: 'condition',
    deviceId: 1023,
    cap: 'alarm-panel',
    fieldPath: 'state',
    operator: 'eq',
    value: 'armed-away',
  }
  let node: AutomationCondition = leaf
  for (let i = 1; i < depth; i += 1) node = { kind: 'all', children: [node] }
  return node
}

function leaves(n: number): AutomationCondition {
  return {
    kind: 'all',
    children: Array.from({ length: n }, () => ({
      kind: 'condition' as const,
      deviceId: 1023,
      cap: 'alarm-panel',
      fieldPath: 'state',
      operator: 'eq' as const,
      value: 'disarmed',
    })),
  }
}

/**
 * The acceptance test named by the design's mockup gate: ONE real automation
 * the operator would actually want, expressed end to end, is what validates the
 * bounds. Every device id here is live on the cluster (verified 2026-08-09):
 * 1023 `Alarm` (alarm-panel), 1453 `Tapparella hall` (cover), 1027 `doorbell`
 * (device-status), 296 `Outdoor Temperature` (numeric-sensor).
 */
const NIGHT_CLOSE_AND_ARM: AutomationRecipe = {
  triggers: [{ kind: 'schedule', cron: '30 23 * * *' }],
  conditions: {
    kind: 'all',
    children: [
      {
        kind: 'not',
        child: {
          kind: 'condition',
          deviceId: 1023,
          cap: 'alarm-panel',
          fieldPath: 'state',
          operator: 'eq',
          value: 'armed-away',
        },
      },
      {
        kind: 'any',
        children: [
          {
            kind: 'condition',
            deviceId: 1453,
            cap: 'cover',
            fieldPath: 'position',
            operator: 'gt',
            value: 0,
          },
          {
            kind: 'expression',
            expr: 'outdoor < 5',
            bindings: {
              outdoor: {
                kind: 'global',
                sourceStableId: 'ha:sensor.outdoor_temperature',
                cap: 'numeric-sensor',
                fieldPath: 'value',
              },
            },
          },
        ],
      },
      {
        kind: 'condition',
        deviceId: 1027,
        cap: 'device-status',
        fieldPath: 'online',
        operator: 'eq',
        value: true,
      },
    ],
  },
  actions: [
    { kind: 'cap', deviceId: 1453, cap: 'cover', method: 'close' },
    { kind: 'wait', seconds: 20 },
    { kind: 'cap', deviceId: 1023, cap: 'alarm-panel', method: 'arm', args: { mode: 'night' } },
  ],
}

describe('condition tree shape', () => {
  it('measures depth with the root container counting as level 1', () => {
    expect(conditionDepth(nest(1))).toBe(1)
    expect(conditionDepth(nest(3))).toBe(3)
  })

  it('counts only leaves, not containers', () => {
    expect(countConditionLeaves(leaves(5))).toBe(5)
  })

  it('counts a NOT as a container, not a leaf', () => {
    expect(
      countConditionLeaves({
        kind: 'not',
        child: {
          kind: 'condition',
          deviceId: 1,
          cap: 'c',
          fieldPath: 'f',
          operator: 'eq',
          value: true,
        },
      }),
    ).toBe(1)
  })
})

describe('bounds — what the mockup gate exists to validate', () => {
  it('accepts a tree at exactly the depth limit', () => {
    expect(
      validateRecipeBounds({ ...NIGHT_CLOSE_AND_ARM, conditions: nest(MAX_CONDITION_DEPTH) }),
    ).toBeNull()
  })

  it('refuses one level past the depth limit, naming the bound', () => {
    const err = validateRecipeBounds({
      ...NIGHT_CLOSE_AND_ARM,
      conditions: nest(MAX_CONDITION_DEPTH + 1),
    })
    expect(err).toContain('levels deep')
    expect(err).toContain(String(MAX_CONDITION_DEPTH))
    // The refusal must offer the De Morgan rewrite, not just say no.
    expect(err).toContain('all of')
  })

  it('accepts exactly the leaf limit and refuses one more', () => {
    expect(
      validateRecipeBounds({ ...NIGHT_CLOSE_AND_ARM, conditions: leaves(MAX_CONDITION_LEAVES) }),
    ).toBeNull()
    expect(
      validateRecipeBounds({
        ...NIGHT_CLOSE_AND_ARM,
        conditions: leaves(MAX_CONDITION_LEAVES + 1),
      }),
    ).toContain('leaves')
  })

  it('refuses a recipe with no trigger — the vertical axis is evaluation order', () => {
    expect(validateRecipeBounds({ ...NIGHT_CLOSE_AND_ARM, triggers: [] })).toContain('trigger')
  })

  it('refuses an empty container — a group is made from existing rows, never left empty', () => {
    expect(
      validateRecipeBounds({ ...NIGHT_CLOSE_AND_ARM, conditions: { kind: 'any', children: [] } }),
    ).toContain('empty')
  })
})

describe('the real automation — Notte: chiudi e arma', () => {
  it('parses against the schema', () => {
    expect(() => AutomationRecipeSchema.parse(NIGHT_CLOSE_AND_ARM)).not.toThrow()
  })

  it('is within bounds, and reports how much of each budget it used', () => {
    expect(validateRecipeBounds(NIGHT_CLOSE_AND_ARM)).toBeNull()
    // The finding the gate wanted: the FIRST real automation saturates the
    // depth budget (3 of 3) while using an eighth of the leaf budget (4 of 32).
    expect(conditionDepth(NIGHT_CLOSE_AND_ARM.conditions!)).toBe(MAX_CONDITION_DEPTH)
    expect(countConditionLeaves(NIGHT_CLOSE_AND_ARM.conditions!)).toBe(4)
  })

  it('rejects an expression leaf whose identifier has no binding', () => {
    const bad: AutomationRecipe = {
      ...NIGHT_CLOSE_AND_ARM,
      conditions: { kind: 'expression', expr: 'unbound > 1', bindings: {} },
    }
    expect(() => AutomationRecipeSchema.parse(bad)).toThrow()
  })
})

export { NIGHT_CLOSE_AND_ARM }
