#!/usr/bin/env tsx
/**
 * The helper kinds are exactly the aggregators (D1004, D944).
 *
 * A helper is a computed value over other devices (group, statistic, integral,
 * threshold, arithmetic, expression, derivative). A device type that merely
 * wants a better look or a few bound commands (a washer, a heater, a media
 * player) is a naked composed device grown through Customize, never a helper
 * template. This guard fails when `helpers/spec.ts` declares a helper kind that
 * is not in the aggregator list below; adding an aggregator is a deliberate
 * edit of BOTH this list and the ADR.
 * Textual: reads the `kind: z.literal('…')` members of the spec file.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SPEC_FILE = 'packages/types/src/composition/helpers/spec.ts'

export const AGGREGATOR_KINDS: readonly string[] = [
  'group',
  'statistic',
  'integral',
  'threshold',
  'arithmetic',
  'expression',
  'derivative',
]

const KIND_RE = /kind:\s*z\.literal\(\s*['"]([^'"]+)['"]\s*\)/g

export function helperKindsOf(content: string): string[] {
  return [...content.matchAll(KIND_RE)].map((m) => m[1] ?? '')
}

export interface HelperKindFindings {
  /** Declared but not an aggregator. */
  readonly extra: readonly string[]
  /** An aggregator the spec no longer declares (the list here is stale). */
  readonly missing: readonly string[]
}

export function checkHelperKinds(content: string): HelperKindFindings {
  const declared = new Set(helperKindsOf(content))
  return {
    extra: [...declared].filter((k) => !AGGREGATOR_KINDS.includes(k)),
    missing: AGGREGATOR_KINDS.filter((k) => !declared.has(k)),
  }
}

function main(): void {
  const { extra, missing } = checkHelperKinds(readFileSync(path.join(ROOT, SPEC_FILE), 'utf-8'))
  if (extra.length === 0 && missing.length === 0) {
    console.log(
      `check-helper-kinds-are-aggregators: ${AGGREGATOR_KINDS.length} kinds, all aggregators`,
    )
    return
  }
  for (const k of extra) {
    console.error(
      `check-helper-kinds-are-aggregators: ${SPEC_FILE} declares helper kind '${k}', which is not an aggregator. ` +
        'A device type is a naked composed device grown through Customize (D1004), not a helper template.',
    )
  }
  for (const k of missing) {
    console.error(
      `check-helper-kinds-are-aggregators: aggregator '${k}' is gone from ${SPEC_FILE}; update the list here and the ADR.`,
    )
  }
  process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
}
