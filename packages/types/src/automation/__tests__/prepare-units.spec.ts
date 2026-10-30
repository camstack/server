/**
 * The shared save boundary for quantity numbers (D972): the pure function the
 * admin editor and the public MCP both call. A bare number on a quantity field
 * is stamped with the unit it was always read in; a wrong-dimension unit is
 * refused with a reason.
 */
import { describe, expect, it } from 'vitest'
import { ALL_CAPABILITY_DEFINITIONS } from '../../generated/capability-router-map.js'
import { capUnitResolver } from '../normalize-units.js'
import { prepareRecipeUnits } from '../prepare-units.js'
import type { AutomationRecipe } from '../recipe.js'

const resolver = capUnitResolver(ALL_CAPABILITY_DEFINITIONS)

const leaf = (extra: object) => ({
  kind: 'condition' as const,
  deviceId: 201,
  cap: 'pet-feeder',
  fieldPath: 'bowlFood',
  operator: 'lt' as const,
  value: 0.05,
  ...extra,
})

const feed = (extra: object) => ({
  kind: 'cap' as const,
  deviceId: 201,
  cap: 'pet-feeder',
  method: 'feed',
  args: { grams: 30 },
  ...extra,
})

function recipe(
  conditions: AutomationRecipe['conditions'],
  actions: AutomationRecipe['actions'],
): AutomationRecipe {
  return { triggers: [{ kind: 'interval', minutes: 60 }], conditions, actions }
}

describe('prepareRecipeUnits (shared save boundary)', () => {
  it('stamps the base unit on a bare number that has a unit choice', () => {
    const prepared = prepareRecipeUnits(recipe(leaf({}), [feed({})]), resolver)
    if (!prepared.ok) throw new Error(prepared.error)
    expect(prepared.recipe.conditions).toMatchObject({
      value: 0.05,
      unit: 'kg',
    })
    expect(prepared.recipe.actions[0]).toMatchObject({
      args: { grams: 30 },
      argUnits: { grams: 'g' },
    })
  })

  it('converts the { value, unit } write form and records the picked unit', () => {
    const prepared = prepareRecipeUnits(
      recipe(leaf({ value: { value: 50, unit: 'g' } }), [feed({})]),
      resolver,
    )
    if (!prepared.ok) throw new Error(prepared.error)
    expect(prepared.recipe.conditions).toMatchObject({
      value: 0.05,
      unit: 'g',
    })
  })

  it('refuses a unit of another dimension with the reason', () => {
    const prepared = prepareRecipeUnits(
      recipe(leaf({ value: 0.05, unit: 'm' }), [feed({})]),
      resolver,
    )
    expect(prepared.ok).toBe(false)
    if (!prepared.ok) expect(prepared.error).toMatch(/cross-dimension/)
  })
})
