#!/usr/bin/env tsx
/**
 * Cap vocabulary guard (D920) — the map of what every capability lets an
 * operator DO to a device and WATCH it for must be complete and true.
 *
 * Fails when a cap has no entry; when an operate method (not a read, not an
 * admin configuration method) has neither an action nor a
 * `notOperatorFacing` reason; when a declared cap event has no phrase and no
 * reason; when a phrase placeholder has no arg to fill it; when a label lacks
 * `en` or `it`; and when an offered value, fixed arg or state field disagrees
 * with the Zod schema it describes. The judge is `scripts/lib/cap-vocabulary-check.ts`.
 *
 * Usage: npx tsx scripts/check-cap-vocabulary.ts
 */
import { kebabToCamel } from '../packages/types/src/capabilities/cap-router-predicates.ts'
import type { CapabilityMethodAccess } from '../packages/types/src/capabilities/capability-definition.ts'
import { CAP_VOCABULARY_BY_NAME } from '../packages/types/src/device/cap-vocabulary/vocabulary.ts'
import { ICON_KEYS } from '../packages/types/src/device/icon-catalog.generated.ts'
import { EventCategory } from '../packages/types/src/enums/event-category.ts'
import { ALL_CAPABILITY_DEFINITIONS } from '../packages/types/src/generated/capability-router-map.ts'
import { METHOD_ACCESS_MAP } from '../packages/types/src/generated/method-access-map.ts'
import { checkCapVocabulary } from './lib/cap-vocabulary-check.ts'

function accessOf(cap: string, method: string): CapabilityMethodAccess | undefined {
  return METHOD_ACCESS_MAP[`${kebabToCamel(cap)}.${method}`]?.access
}

function main(): void {
  const result = checkCapVocabulary({
    defs: ALL_CAPABILITY_DEFINITIONS,
    vocabulary: CAP_VOCABULARY_BY_NAME,
    accessOf,
    iconKeys: new Set<string>(ICON_KEYS),
    eventCategories: new Set<string>(Object.values(EventCategory)),
  })
  const s = result.stats
  const summary =
    `${s.caps} caps (${s.deviceCaps} device, ${s.systemCaps} system) · ` +
    `${s.operateMethods} operate methods: ${s.operateMethods - s.excusedMethods} offered, ${s.excusedMethods} excused · ` +
    `${s.actions} actions · ${s.stateTriggers} state triggers · ` +
    `${s.eventTriggers} event triggers, ${s.excusedEvents} events excused`
  if (result.problems.length > 0) {
    process.stderr.write(`check-cap-vocabulary: ${result.problems.length} problem(s)\n`)
    for (const p of result.problems) process.stderr.write(`  - ${p}\n`)
    process.stderr.write(`${summary}\n`)
    process.exit(1)
  }
  process.stdout.write(`check-cap-vocabulary: OK — ${summary}\n`)
}

main()
