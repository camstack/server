/**
 * The save boundary of the editor for numbers tied to a quantity (D972).
 *
 * The editor holds a number in its STORED unit plus the unit the person picked
 * (`leaf.unit`, `step.argUnits`). Two things must be true of what it saves:
 *
 *  - a bare number on a quantity field is never saved silently — a leaf or arg
 *    that came without a picked unit (a recipe saved before the unit existed,
 *    or typed by hand in code) is stamped with the unit it was always read in,
 *    so the saved recipe says it;
 *  - the recipe goes through `normalizeRecipeUnits`, the same function the
 *    server runs, so a unit that cannot belong to its field is refused here
 *    with the same message instead of at the hub.
 */
import {
  ALL_CAPABILITY_DEFINITIONS,
  type AutomationAction,
  type AutomationCondition,
  type AutomationRecipe,
  QuantityUnitError,
  type UnitResolver,
  baseUnitForQuantity,
  capUnitResolver,
  normalizeRecipeUnits,
  unitsForQuantity,
} from '@camstack/types'

let defaultResolver: UnitResolver | undefined

/** The resolver over the generated capability definitions, built once. */
export function defaultUnitResolver(): UnitResolver {
  defaultResolver ??= capUnitResolver(ALL_CAPABILITY_DEFINITIONS)
  return defaultResolver
}

export type PreparedRecipe =
  | { readonly ok: true; readonly recipe: AutomationRecipe }
  | { readonly ok: false; readonly error: string }

function stampCondition(
  condition: AutomationCondition,
  resolver: UnitResolver,
): AutomationCondition {
  switch (condition.kind) {
    case 'condition': {
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
  resolver: UnitResolver = defaultUnitResolver(),
): PreparedRecipe {
  const stamped: AutomationRecipe = {
    ...recipe,
    ...(recipe.conditions === undefined
      ? {}
      : { conditions: stampCondition(recipe.conditions, resolver) }),
    actions: recipe.actions.map((action) => stampAction(action, resolver)),
  }
  try {
    return { ok: true, recipe: normalizeRecipeUnits(stamped, resolver).value }
  } catch (error: unknown) {
    if (error instanceof QuantityUnitError) return { ok: false, error: error.message }
    throw error
  }
}
