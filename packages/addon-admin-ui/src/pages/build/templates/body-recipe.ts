/**
 * The body of an automation template, seen as a recipe so the automation
 * editor's own WHEN and THEN editors can edit it (#527).
 *
 * A body is JSON that is NOT yet a valid recipe — a device leaf with no device,
 * a command with no target, a choose with no branch — which is exactly what the
 * editors already show for a half-built automation. The guard below checks only
 * the SHAPE those editors walk (a `when` tree and a list of steps, each with a
 * `kind`); `AutomationRecipeSchema` judges the finished expansion, never the
 * body. A body that is not even that shape is shown as JSON instead.
 */
import type { AutomationRecipe } from '@camstack/types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasKind(value: unknown): boolean {
  return isRecord(value) && typeof value['kind'] === 'string'
}

/**
 * Documented type boundary: the body has the shape of a recipe's skeleton, its
 * fields may still be blank. Narrowing is the claim "the editors can open this".
 */
function isEditableBody(
  body: Record<string, unknown>,
): body is Record<string, unknown> & AutomationRecipe {
  const actions = body['actions']
  return hasKind(body['when']) && Array.isArray(actions) && actions.every(hasKind)
}

/** The recipe the editors work on, or null when the body cannot be opened in them. */
export function recipeOfBody(body: Record<string, unknown>): AutomationRecipe | null {
  return isEditableBody(body) ? body : null
}

/** The body an edited recipe writes back. */
export function bodyOfRecipe(recipe: AutomationRecipe): Record<string, unknown> {
  return { ...recipe }
}
