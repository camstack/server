/**
 * The save boundary of the editor for numbers tied to a quantity (D972).
 *
 * The rule itself — stamp the unit on a bare number, then run the server's
 * `normalizeRecipeUnits` — is the pure `prepareRecipeUnits` in `@camstack/types`,
 * shared with every other surface that saves a recipe. This file only supplies
 * the editor's resolver: the generated capability definitions.
 */
import {
  ALL_CAPABILITY_DEFINITIONS,
  type AutomationRecipe,
  type PreparedRecipe,
  type UnitResolver,
  capUnitResolver,
  prepareRecipeUnits as prepareRecipeUnitsWith,
} from '@camstack/types'

export type { PreparedRecipe }

let defaultResolver: UnitResolver | undefined

/** The resolver over the generated capability definitions, built once. */
export function defaultUnitResolver(): UnitResolver {
  defaultResolver ??= capUnitResolver(ALL_CAPABILITY_DEFINITIONS)
  return defaultResolver
}

/** The recipe as it is saved; `ok: false` names why it cannot be. */
export function prepareRecipeUnits(
  recipe: AutomationRecipe,
  resolver: UnitResolver = defaultUnitResolver(),
): PreparedRecipe {
  return prepareRecipeUnitsWith(recipe, resolver)
}
