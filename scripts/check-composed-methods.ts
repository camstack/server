#!/usr/bin/env tsx
/**
 * GUARD: `composedMethods` (D663) — every key a `*.cap.ts` declares must
 * actually be one of that cap's own methods, and every `{ kind: 'answer' }`
 * value must parse with THAT method's output schema.
 *
 * ## The failure this catches
 *
 * `composedMethods` is the only thing that lifts `has-commands`
 * (`validate-composition.ts`) for a cap with a served method — a composed
 * device serves the answer here until `forward` arrives (slice 3). A typo'd
 * method name is silently never read (the composer looks it up by the real
 * method name and finds nothing, so the cap stays uncomposable with no
 * error). A value that does not parse against the method's own output schema
 * is worse: it is served to a caller as if it were a real answer, and every
 * consumer of that method now has to handle a shape its Zod schema never
 * allowed.
 *
 * ## What it checks
 *
 * For every `CapabilityDefinition` in `ALL_CAPABILITY_DEFINITIONS`, for every
 * `[name, answer]` of `def.composedMethods`:
 *   1. `name` is a key of `def.methods`.
 *   2. When `answer.kind === 'answer'`, `def.methods[name].output.safeParse
 *      (answer.value)` succeeds.
 *
 * The judgement lives in `composed-methods-guard.ts` (spec:
 * `scripts/__tests__/check-composed-methods.spec.ts`).
 *
 * Usage: tsx scripts/check-composed-methods.ts
 */
import { ALL_CAPABILITY_DEFINITIONS } from '../packages/types/src/generated/capability-router-map.js'
import { checkComposedMethods } from './composed-methods-guard.ts'

function main(): void {
  const failures = checkComposedMethods(ALL_CAPABILITY_DEFINITIONS)

  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error('check-composed-methods: FAILED\n')
    for (const f of failures) {
      // eslint-disable-next-line no-console
      console.error(`  - ${f}`)
    }
    process.exitCode = 1
    return
  }

  const withComposed = ALL_CAPABILITY_DEFINITIONS.filter(
    (def) => def.composedMethods !== undefined && Object.keys(def.composedMethods).length > 0,
  )
  // eslint-disable-next-line no-console
  console.log(
    `check-composed-methods: OK — ${withComposed.length} cap(s) declare composedMethods ` +
      `(${withComposed.map((d) => d.name).join(', ')}).`,
  )
}

main()
