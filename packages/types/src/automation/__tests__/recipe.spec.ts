import { describe, expect, it } from 'vitest'
import type { AutomationRecipe } from '../recipe.js'
import {
  AutomationRecipeSchema,
  AutomationRunModeSchema,
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_LEAVES,
  validateRecipeBounds,
} from '../recipe.js'
import { type AutomationWhen, AutomationWhenSchema, countWhenLeaves, whenDepth } from '../when.js'

const IS_ARMED = {
  kind: 'device-is',
  deviceId: 1023,
  cap: 'alarm-panel',
  fieldPath: 'state',
  operator: 'eq',
  value: 'armed-away',
} as const

/** A nested ALL chain `depth` levels deep, ending in one state leaf. */
function nest(depth: number): AutomationWhen {
  let node: AutomationWhen = IS_ARMED
  for (let i = 1; i < depth; i += 1) node = { kind: 'all', children: [node] }
  return node
}

function leaves(n: number): AutomationWhen {
  return {
    kind: 'all',
    children: Array.from({ length: n }, () => ({ ...IS_ARMED, value: 'disarmed' })),
  }
}

/**
 * The acceptance test named by the design's mockup gate: ONE real automation
 * the operator would actually want, end to end. Every device id here is live on
 * the cluster (verified 2026-08-09): 1023 `Alarm` (alarm-panel), 1453 `Tapparella
 * hall` (cover), 1027 `doorbell` (device-status), 296 `Outdoor Temperature`.
 */
const NIGHT_CLOSE_AND_ARM: AutomationRecipe = {
  when: {
    kind: 'all',
    children: [
      { kind: 'schedule', cron: '30 23 * * *' },
      { kind: 'not', child: IS_ARMED },
      {
        kind: 'any',
        children: [
          {
            kind: 'device-is',
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
        kind: 'device-is',
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

describe('when tree shape', () => {
  it('measures depth with the root container counting as level 1', () => {
    expect(whenDepth(nest(1))).toBe(1)
    expect(whenDepth(nest(3))).toBe(3)
  })

  it('counts only leaves, not containers', () => {
    expect(countWhenLeaves(leaves(5))).toBe(5)
    expect(countWhenLeaves({ kind: 'not', child: IS_ARMED })).toBe(1)
  })
})

describe('bounds — what the mockup gate exists to validate', () => {
  it('accepts a tree at exactly the depth limit', () => {
    expect(
      validateRecipeBounds({ ...NIGHT_CLOSE_AND_ARM, when: nest(MAX_CONDITION_DEPTH) }),
    ).toBeNull()
  })

  it('refuses one level past the depth limit, naming the bound and offering the De Morgan rewrite', () => {
    const err = validateRecipeBounds({
      ...NIGHT_CLOSE_AND_ARM,
      when: nest(MAX_CONDITION_DEPTH + 1),
    })
    expect(err).toContain('levels deep')
    expect(err).toContain(String(MAX_CONDITION_DEPTH))
    expect(err).toContain('all of')
  })

  it('accepts exactly the leaf limit and refuses one more', () => {
    expect(
      validateRecipeBounds({ ...NIGHT_CLOSE_AND_ARM, when: leaves(MAX_CONDITION_LEAVES) }),
    ).toBeNull()
    expect(
      validateRecipeBounds({ ...NIGHT_CLOSE_AND_ARM, when: leaves(MAX_CONDITION_LEAVES + 1) }),
    ).toContain('rows')
  })

  it('refuses an empty container — a group is made from existing rows, never left empty', () => {
    expect(
      validateRecipeBounds({ ...NIGHT_CLOSE_AND_ARM, when: { kind: 'any', children: [] } }),
    ).toContain('empty')
  })

  it('refuses a recipe with no action', () => {
    expect(validateRecipeBounds({ ...NIGHT_CLOSE_AND_ARM, actions: [] })).toContain('action')
  })
})

describe('the real automation — Notte: chiudi e arma', () => {
  it('parses against the schema', () => {
    expect(() => AutomationRecipeSchema.parse(NIGHT_CLOSE_AND_ARM)).not.toThrow()
  })

  it('is within bounds, and reports how much of each budget it used', () => {
    expect(validateRecipeBounds(NIGHT_CLOSE_AND_ARM)).toBeNull()
    expect(whenDepth(NIGHT_CLOSE_AND_ARM.when)).toBe(3)
    expect(countWhenLeaves(NIGHT_CLOSE_AND_ARM.when)).toBe(5)
  })

  it('rejects an expression leaf whose identifier has no binding', () => {
    const bad: AutomationRecipe = {
      ...NIGHT_CLOSE_AND_ARM,
      when: { kind: 'expression', expr: 'unbound > 1', bindings: {} },
    }
    expect(() => AutomationRecipeSchema.parse(bad)).toThrow()
  })
})

describe('detection and interval leaves', () => {
  it('accepts a detection leaf and refuses empty subjects / devices and a score outside 0..1', () => {
    const ok = {
      kind: 'detection',
      subjects: [{ macro: 'animal' }],
      deviceIds: [7],
      zones: ['yard'],
      minScore: 0.6,
    }
    expect(AutomationWhenSchema.safeParse(ok).success).toBe(true)
    expect(AutomationWhenSchema.safeParse({ ...ok, subjects: [] }).success).toBe(false)
    expect(AutomationWhenSchema.safeParse({ ...ok, deviceIds: [] }).success).toBe(false)
    expect(AutomationWhenSchema.safeParse({ ...ok, minScore: 1.2 }).success).toBe(false)
  })

  it('bounds an interval to 1..1440 whole minutes', () => {
    expect(AutomationWhenSchema.safeParse({ kind: 'interval', minutes: 1 }).success).toBe(true)
    expect(AutomationWhenSchema.safeParse({ kind: 'interval', minutes: 1440 }).success).toBe(true)
    expect(AutomationWhenSchema.safeParse({ kind: 'interval', minutes: 0 }).success).toBe(false)
    expect(AutomationWhenSchema.safeParse({ kind: 'interval', minutes: 1441 }).success).toBe(false)
  })
})

describe('run mode and trace retention', () => {
  it('is a discriminated union with bounded members', () => {
    for (const ok of [
      { mode: 'single' },
      { mode: 'restart' },
      { mode: 'queued', max: 10 },
      { mode: 'parallel', max: 1 },
      { mode: 'cooldown', minutes: 1440 },
    ]) {
      expect(AutomationRunModeSchema.safeParse(ok).success).toBe(true)
    }
    for (const bad of [
      { mode: 'queued', max: 0 },
      { mode: 'parallel', max: 11 },
      { mode: 'cooldown', minutes: 0 },
      { mode: 'cooldown', minutes: 1441 },
      { mode: 'queued' },
      { mode: 'nope' },
    ]) {
      expect(AutomationRunModeSchema.safeParse(bad).success).toBe(false)
    }
  })

  it('lives on the recipe, not on an action, and keepTraces is bounded', () => {
    const base = { when: { kind: 'manual' }, actions: [{ kind: 'wait', seconds: 1 }] }
    expect(
      AutomationRecipeSchema.safeParse({
        ...base,
        runMode: { mode: 'cooldown', minutes: 30 },
        keepTraces: 20,
      }).success,
    ).toBe(true)
    expect(AutomationRecipeSchema.safeParse({ ...base, keepTraces: 101 }).success).toBe(false)
    expect(AutomationRecipeSchema.safeParse({ ...base, keepTraces: 0 }).success).toBe(false)
  })
})

describe('the picked unit survives the recipe schema', () => {
  it('keeps `unit` on a device-is leaf and `argUnits` on a cap step', () => {
    const recipe: AutomationRecipe = {
      when: {
        kind: 'all',
        children: [
          { kind: 'manual' },
          {
            kind: 'device-is',
            deviceId: 7,
            cap: 'pet-feeder',
            fieldPath: 'bowlFood',
            operator: 'lt',
            value: 0.01,
            unit: 'g',
          },
        ],
      },
      actions: [
        {
          kind: 'cap',
          deviceId: 7,
          cap: 'pet-feeder',
          method: 'feed',
          args: { grams: 100 },
          argUnits: { grams: 'kg' },
        },
      ],
    }
    expect(AutomationRecipeSchema.parse(recipe)).toEqual(recipe)
  })
})

export { NIGHT_CLOSE_AND_ARM }
