/**
 * The save boundary for numbers tied to a quantity (D972), as a pure function
 * over a {@link UnitResolver} — shared by every surface that saves a recipe
 * (the admin editor, the public MCP), so none of them carries its own copy.
 *
 * A recipe carries its numbers in their STORED unit plus the unit the person
 * picked (`leaf.unit`, `step.argUnits`). Two things must be true of what is
 * saved:
 *
 *  - a bare number on a quantity field is never saved silently — a leaf or arg
 *    that came without a picked unit is stamped with the unit it was always
 *    read in, so the saved recipe says it;
 *  - the recipe goes through {@link normalizeRecipeUnits}, the same function the
 *    server runs, so a unit that cannot belong to its field is refused here with
 *    the same message instead of at the hub.
 */
import { QuantityUnitError } from '../units/quantity-input.js'
import { baseUnitForQuantity, unitsForQuantity } from '../units/quantity-units.js'
import { type UnitResolver, normalizeRecipeUnits } from './normalize-units.js'
import type { AutomationAction, AutomationRecipe } from './recipe.js'
import type { AutomationWhen } from './when.js'

export type PreparedRecipe =
  | { readonly ok: true; readonly recipe: AutomationRecipe }
  | { readonly ok: false; readonly error: string }

function stampCondition(condition: AutomationWhen, resolver: UnitResolver): AutomationWhen {
  switch (condition.kind) {
    case 'device-is': {
      if (typeof condition.value !== 'number' || condition.unit !== undefined) return condition
      const quantity = resolver.fieldQuantity(condition.cap, condition.fieldPath)
      if (quantity === undefined || unitsForQuantity(quantity).length < 2) return condition
      const base = baseUnitForQuantity(quantity)
      return base === undefined ? condition : { ...condition, unit: base }
    }
    case 'not':
      return { ...condition, child: stampCondition(condition.child, resolver) }
    case 'all':
    case 'any':
      return {
        ...condition,
        children: condition.children.map((child) => stampCondition(child, resolver)),
      }
    default:
      return condition
  }
}

function stampAction(action: AutomationAction, resolver: UnitResolver): AutomationAction {
  if (action.kind !== 'cap' || action.args === undefined) return action
  const argUnits: Record<string, string> = { ...action.argUnits }
  for (const [arg, value] of Object.entries(action.args)) {
    if (typeof value !== 'number' || argUnits[arg] !== undefined) continue
    const meta = resolver.paramMeta(action.cap, action.method, arg)
    if (meta !== undefined && unitsForQuantity(meta.quantity).length > 1) argUnits[arg] = meta.unit
  }
  return Object.keys(argUnits).length === 0 ? action : { ...action, argUnits }
}

/**
 * The recipe as it is saved: every quantity number carries its unit, and the
 * whole recipe passes the server's unit check. `ok: false` names why it cannot
 * be saved.
 */
export function prepareRecipeUnits(
  recipe: AutomationRecipe,
  resolver: UnitResolver,
): PreparedRecipe {
  const stamped: AutomationRecipe = {
    ...recipe,
    when: stampCondition(recipe.when, resolver),
    actions: recipe.actions.map((action) => stampAction(action, resolver)),
  }
  try {
    return { ok: true, recipe: normalizeRecipeUnits(stamped, resolver).value }
  } catch (error: unknown) {
    if (error instanceof QuantityUnitError) return { ok: false, error: error.message }
    throw error
  }
}
