/**
 * Reads the `AUTOMATION_RECIPE` literal `generateAutomationBlock` embeds in a
 * block's code — parsed as JSON, never evaluated — for code that runs where the
 * admin UI's reader does not (the hub re-expanding template instances, #527).
 *
 * A brace scan, not a regex: the recipe nests. Strings are tracked so a `}`
 * inside a device name cannot close the object early; the value is
 * `JSON.stringify` output, so `"` is the only quote that can open one.
 */
import { AutomationRecipeSchema, type AutomationRecipe } from './recipe.js'

/** The declaration the generator emits, matched whole. */
export const AUTOMATION_RECIPE_DECLARATION = 'const AUTOMATION_RECIPE ='

export type RecipeLiteralRead =
  | { readonly status: 'recipe'; readonly recipe: AutomationRecipe }
  /** The code carries no recipe: a hand-written script. */
  | { readonly status: 'none' }
  /** It carries one that is not JSON or not a recipe. */
  | { readonly status: 'invalid'; readonly detail: string }

/** The JSON text of the literal, or null when the code declares none. */
export function findRecipeLiteralJson(code: string): string | null {
  const declStart = code.indexOf(AUTOMATION_RECIPE_DECLARATION)
  if (declStart < 0) return null
  const start = code.indexOf('{', declStart + AUTOMATION_RECIPE_DECLARATION.length)
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < code.length; i += 1) {
    const ch = code.charAt(i)
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return code.slice(start, i + 1)
    }
  }
  return null
}

export function readRecipeLiteral(code: string): RecipeLiteralRead {
  const json = findRecipeLiteralJson(code)
  if (json === null) return { status: 'none' }
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (error: unknown) {
    return { status: 'invalid', detail: error instanceof Error ? error.message : String(error) }
  }
  const parsed = AutomationRecipeSchema.safeParse(raw)
  if (parsed.success) return { status: 'recipe', recipe: parsed.data }
  const first = parsed.error.issues[0]
  return {
    status: 'invalid',
    detail: first === undefined ? 'not a recipe' : `${first.path.join('.')}: ${first.message}`,
  }
}
