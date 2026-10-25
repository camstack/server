/**
 * Attribution for the core-router degradation guard.
 *
 * The guard in `generate-api-types.ts` refuses to write when a checker-
 * expanded core router contains `input: any` / `output: any`. It has always
 * been RIGHT to refuse — but it reported counts only ("output: any → 6"),
 * and a count says nothing about which procedure lost its type. Recovering
 * that on 2026-08-15 meant copying the generator and instrumenting it by
 * hand. This module does it once, in the guard, for free.
 *
 * The matched substring is deliberately identical to the guard's original
 * (`input: any` / `output: any`) — this attributes the existing failures, it
 * does not widen or narrow what counts as one.
 */

export type DegradedField = 'input' | 'output'

export interface DegradedProcedure {
  readonly router: string
  readonly method: string
  readonly field: DegradedField
}

const NEEDLES: readonly DegradedField[] = ['input', 'output']

/**
 * The nearest procedure header at or before `index`. A core-router expansion
 * is one flat string of `name: import("@trpc/server").TRPC…Procedure<{ … }>`
 * entries, so the owning procedure is simply the last header that starts
 * before the offending field.
 */
const PROCEDURE_HEADER = /(\w+): import\("@trpc\/server"\)\.TRPC\w*Procedure</g

function owningMethod(text: string, index: number): string {
  const before = text.slice(0, index)
  let name = '<unknown>'
  PROCEDURE_HEADER.lastIndex = 0
  for (const match of before.matchAll(PROCEDURE_HEADER)) {
    name = match[1] ?? name
  }
  return name
}

/**
 * Every `(router, method, field)` whose expansion degraded to `any`.
 *
 * A router's expansion can repeat the same procedure object (tRPC router
 * types are intersections), so identical triples are reported once.
 */
export function findDegradedProcedures(
  coreTexts: ReadonlyMap<string, string>,
): readonly DegradedProcedure[] {
  const seen = new Set<string>()
  const degraded: DegradedProcedure[] = []
  for (const [router, text] of coreTexts) {
    for (const field of NEEDLES) {
      const needle = `${field}: any`
      let index = text.indexOf(needle)
      while (index !== -1) {
        const method = owningMethod(text, index)
        const key = `${router}.${method}.${field}`
        if (!seen.has(key)) {
          seen.add(key)
          degraded.push({ router, method, field })
        }
        index = text.indexOf(needle, index + needle.length)
      }
    }
  }
  return degraded
}
