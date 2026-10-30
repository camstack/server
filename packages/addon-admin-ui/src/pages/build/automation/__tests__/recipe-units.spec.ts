/**
 * The editor's save path for quantity numbers (D972): a recipe is saved through
 * `normalizeRecipeUnits`, with a unit on every quantity number — a bare number
 * on a quantity field is never saved silently.
 */
import type { AutomationRecipe } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { prepareRecipeUnits } from '../recipe-units'

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

const recipe = (conditions: AutomationRecipe['conditions'], actions: AutomationRecipe['actions']) =>
  ({
    triggers: [{ kind: 'interval', minutes: 60 }],
    conditions,
    actions,
  }) as AutomationRecipe

describe('prepareRecipeUnits', () => {
  it('stamps the base unit on a bare number that has a unit choice', () => {
    const prepared = prepareRecipeUnits(recipe(leaf({}), [feed({})]))
    if (!prepared.ok) throw new Error(prepared.error)
    expect(prepared.recipe.conditions).toMatchObject({ value: 0.05, unit: 'kg' })
    expect(prepared.recipe.actions[0]).toMatchObject({
      args: { grams: 30 },
      argUnits: { grams: 'g' },
    })
  })

  it('keeps a number and the unit the person picked, and never converts it again', () => {
    const prepared = prepareRecipeUnits(
      recipe(leaf({ value: 0.05, unit: 'g' }), [
        feed({ args: { grams: 56.699 }, argUnits: { grams: 'oz' } }),
      ]),
    )
    if (!prepared.ok) throw new Error(prepared.error)
    expect(prepared.recipe.conditions).toMatchObject({ value: 0.05, unit: 'g' })
    expect(prepared.recipe.actions[0]).toMatchObject({
      args: { grams: 56.699 },
      argUnits: { grams: 'oz' },
    })
  })

  it('converts the { value, unit } write form and records the picked unit', () => {
    const prepared = prepareRecipeUnits(
      recipe(leaf({ value: { value: 50, unit: 'g' } }), [feed({})]),
    )
    if (!prepared.ok) throw new Error(prepared.error)
    expect(prepared.recipe.conditions).toMatchObject({ value: 0.05, unit: 'g' })
  })

  it('refuses a unit of another dimension with the reason', () => {
    const prepared = prepareRecipeUnits(recipe(leaf({ value: 0.05, unit: 'm' }), [feed({})]))
    expect(prepared.ok).toBe(false)
    if (!prepared.ok) expect(prepared.error).toMatch(/cross-dimension/)
  })

  it('leaves a number on a field that is not a quantity alone', () => {
    const plain = leaf({ fieldPath: 'feeding', value: 1 })
    const prepared = prepareRecipeUnits(recipe(plain, [feed({ args: {} })]))
    if (!prepared.ok) throw new Error(prepared.error)
    expect(prepared.recipe.conditions).not.toHaveProperty('unit')
  })
})
