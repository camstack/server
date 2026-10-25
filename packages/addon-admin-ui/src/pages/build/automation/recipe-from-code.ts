/**
 * Reading the recipe back OUT of a saved block — and taking it away for good.
 *
 * `generateAutomationBlock` embeds the recipe in the file it emits, as
 * `const AUTOMATION_RECIPE = {…} as const`. That literal is the only thing that
 * makes a visually-authored automation re-openable before `CoreBlock.source`
 * ships, so this module is the other half of the generator and its round trip is
 * the contract: **generate → parse → deep-equal the original recipe.**
 *
 * Two rules hold it together:
 *
 *  - **Parsed, never evaluated.** The literal is `JSON.stringify` output, so it
 *    is JSON — a brace scan plus `JSON.parse` reads it exactly, and there is no
 *    `eval` / `new Function` / `vm` anywhere near it (which
 *    `scripts/check-no-dynamic-eval.ts` enforces repo-wide anyway).
 *  - **The schema is the gate.** A literal that parses but does not satisfy
 *    `AutomationRecipeSchema` is NOT a recipe: opening a half-understood tree in
 *    the editor and saving it would silently rewrite the operator's automation
 *    into whatever the editor managed to render. A refusal names the reason and
 *    the row stays a script.
 *
 * The presence of the declaration is also what makes a block an automation at
 * all — {@link looksLikeAutomation} is the list filter — which is why
 * {@link ejectRecipeFromCode} removes it rather than merely flagging something.
 * Ejection is one-way BECAUSE the recipe is gone afterwards; if it left the
 * literal behind, the next save from the visual editor would overwrite the code
 * the operator just took ownership of.
 */

import { type AutomationRecipe, AutomationRecipeSchema } from '@camstack/types'
import i18n from '../../../i18n/index'

/** The declaration the generator emits. Matched as a whole so a mention of
 *  `AUTOMATION_RECIPE` in a comment or a string cannot pass for one. */
const DECLARATION = 'const AUTOMATION_RECIPE ='

/** What replaces the recipe when a block is ejected. Deliberately explicit: the
 *  next person to open this file has to learn that it used to be generated. */
const EJECTED_NOTE = `// EJECTED from the visual automation editor — this file is now hand-owned.
// The recipe that produced it was removed with it, on purpose: while it was
// here the editor could re-open this block and overwrite everything below.`

export function looksLikeAutomation(code: string): boolean {
  return code.includes(DECLARATION)
}

/** A parse attempt. A failure carries the reason so the surface can say why a
 *  block that LOOKS like an automation is not being offered as one. */
export type RecipeParseResult =
  | { readonly ok: true; readonly recipe: AutomationRecipe }
  | { readonly ok: false; readonly reason: string }

interface LiteralSpan {
  /** Index of `const`, i.e. where the whole declaration starts. */
  readonly declStart: number
  /** Index just past the literal's closing brace. */
  readonly literalEnd: number
  readonly json: string
}

/**
 * Locate the JSON object literal after the declaration.
 *
 * A brace counter rather than a regex: the recipe nests, and `.*` across
 * newlines would swallow the rest of the file. Strings are tracked because a
 * `}` inside a device name would otherwise close the object early — the value
 * is `JSON.stringify` output, so `"` is the only quote that can open one.
 */
function findLiteral(code: string): LiteralSpan | null {
  const declStart = code.indexOf(DECLARATION)
  if (declStart < 0) return null
  const start = code.indexOf('{', declStart + DECLARATION.length)
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
      if (depth === 0) {
        return { declStart, literalEnd: i + 1, json: code.slice(start, i + 1) }
      }
    }
  }
  return null
}

/**
 * The recipe a generated block carries, or the reason it cannot be trusted.
 *
 * Both failure modes are reported rather than collapsed into `null`: "there is
 * no recipe here" and "there is one and it is not valid" send an operator to
 * completely different places.
 */
export function parseRecipeFromCode(code: string): RecipeParseResult {
  const span = findLiteral(code)
  if (span === null) {
    return { ok: false, reason: i18n.t('helpers.recipeFromCode.noLiteral') }
  }
  let raw: unknown
  try {
    raw = JSON.parse(span.json)
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: i18n.t('helpers.recipeFromCode.badJson', { detail }) }
  }
  const parsed = AutomationRecipeSchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return {
      ok: false,
      reason:
        first === undefined
          ? i18n.t('helpers.recipeFromCode.schemaMismatch')
          : i18n.t('helpers.recipeFromCode.schemaMismatchAt', {
              path: first.path.join('.'),
              message: first.message,
            }),
    }
  }
  return { ok: true, recipe: parsed.data }
}

/**
 * The same code with the recipe removed — what "Eject to code" stores.
 *
 * Returns the input unchanged when there was nothing to eject, so calling it
 * twice is harmless. The trailing `as const` is consumed with the literal: left
 * dangling it is a syntax error, and the block would then fail to compile on the
 * very save that was supposed to hand it over intact.
 */
export function ejectRecipeFromCode(code: string): string {
  const span = findLiteral(code)
  if (span === null) return code
  const after = code.slice(span.literalEnd)
  const asConst = /^\s*as\s+const/.exec(after)
  const cut = span.literalEnd + (asConst === null ? 0 : asConst[0].length)
  return `${code.slice(0, span.declStart)}${EJECTED_NOTE}${code.slice(cut)}`
}
