/**
 * The judgement of `check-composed-methods.ts` (D663), as a pure function over
 * capability definitions — so each rule is proven red on a fixture.
 *
 * For every `[name, answer]` of a definition's `composedMethods`:
 *   1. `name` is a key of the cap's own `methods` — a typo'd key is silently
 *      never read and the cap stays uncomposable with no error;
 *   2. an `{ kind: 'answer' }` value parses with THAT method's output schema —
 *      otherwise a composed device serves a shape the method never allowed.
 */
import type { CapabilityDefinition } from '../packages/types/src/capabilities/capability-definition.js'

/** What the guard reads of a definition — the three fields it judges. */
export type ComposedMethodsSubject = Pick<
  CapabilityDefinition,
  'name' | 'methods' | 'composedMethods'
>

/** One failure line per bad entry, `<cap>.composedMethods.<name>: <why>`. */
export function checkComposedMethods(defs: readonly ComposedMethodsSubject[]): string[] {
  const failures: string[] = []
  for (const def of defs) {
    for (const [name, answer] of Object.entries(def.composedMethods ?? {})) {
      const m = def.methods[name]
      if (m === undefined) {
        failures.push(
          `${def.name}.composedMethods.${name}: '${name}' is not a method of '${def.name}'`,
        )
        continue
      }
      if (answer.kind === 'answer') {
        const parsed = m.output.safeParse(answer.value)
        if (!parsed.success) {
          failures.push(
            `${def.name}.composedMethods.${name}: the 'answer' value fails ` +
              `${def.name}.methods.${name}.output.safeParse — ${parsed.error.message}`,
          )
        }
      }
    }
  }
  return failures
}
