#!/usr/bin/env tsx
/**
 * Codegen: runtime-state durability policy.
 *
 * Emits `packages/types/src/generated/runtime-state-durability.ts` — one entry
 * per cap declaring `runtimeState`, carrying the `durability` marker and the
 * cap's declared clock fields.
 *
 * WHY A GENERATED MAP AND NOT A KERNEL LIST: the decision about what a value
 * MEANS belongs to the capability that owns it (D4), but the component that
 * enforces it — `DeviceStateMirror`, in hub-main — must answer "is this cap
 * persistable?" for a cap name it receives over the wire, without importing 62
 * cap definitions into the process. The map is the projection: authored in the
 * `*.cap.ts`, consumed by name.
 *
 * Run manually: npx tsx scripts/generate-runtime-state-durability.ts
 */

import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeIfChanged } from './codegen-write.ts'
import { parseAllCaps } from './lib/parse-cap.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CAPS_DIR = path.join(ROOT, 'packages/types/src/capabilities')
const OUTPUT = path.join(ROOT, 'packages/types/src/generated/runtime-state-durability.ts')

function main(): void {
  const caps = parseAllCaps(CAPS_DIR)
    .filter((c) => c.hasRuntimeState)
    .slice()
    .sort((a, b) => a.capName.localeCompare(b.capName))

  const restored = caps.filter((c) => c.durability === 'restored')
  const session = caps.filter((c) => c.durability !== 'restored')

  const entries = caps
    .map((c) => {
      const volatile =
        c.volatileStateFields.length > 0
          ? `[${c.volatileStateFields.map((f) => `'${f}'`).join(', ')}]`
          : '[]'
      return `  '${c.capName}': { durability: '${c.durability ?? 'session'}', volatileFields: ${volatile} },`
    })
    .join('\n')

  const out = `// AUTO-GENERATED — do not edit manually.
// Regenerate with: npx tsx scripts/generate-runtime-state-durability.ts
/* eslint-disable */

import type { RuntimeStateDurability } from '../capabilities/capability-definition.js'

/** The persistence policy one capability declares for its runtime-state slice. */
export interface RuntimeStatePolicy {
  /** \`'restored'\` slices reach disk; \`'session'\` slices stay in the RAM mirror. */
  readonly durability: RuntimeStateDurability
  /**
   * Clock fields — persisted, but ignored by the equality test that decides
   * whether a write is worth a SQLite commit. Declared by the cap.
   */
  readonly volatileFields: readonly string[]
}

/**
 * Per-cap runtime-state policy, projected from every \`*.cap.ts\` that declares
 * \`runtimeState\`. ${caps.length} caps: ${restored.length} \`restored\`, ${session.length} \`session\`.
 *
 * A cap absent from this map has no runtime-state slice at all. A cap PRESENT
 * with \`durability: 'session'\` has one and has decided not to keep it.
 */
export const RUNTIME_STATE_POLICY: Readonly<Record<string, RuntimeStatePolicy>> = {
${entries}
}

/**
 * The policy for \`capName\`. An UNKNOWN cap resolves to \`'session'\` — an
 * addon-private slice the codegen has never seen is not persisted until its
 * capability says so, which is the safe direction: the cost of a lost session
 * value is a cold window, the cost of an unasked-for persist is a commit per
 * second on the fleet's busiest write path.
 */
export function runtimeStatePolicyFor(capName: string): RuntimeStatePolicy {
  return RUNTIME_STATE_POLICY[capName] ?? SESSION_ONLY_POLICY
}

/** Shared fallback instance — see {@link runtimeStatePolicyFor}. */
const SESSION_ONLY_POLICY: RuntimeStatePolicy = { durability: 'session', volatileFields: [] }

/** True when this cap's slice is written to disk. */
export function isRestoredCap(capName: string): boolean {
  return runtimeStatePolicyFor(capName).durability === 'restored'
}

/** Cap names whose slice survives a restart, sorted. */
export const RESTORED_CAP_NAMES: readonly string[] = [
${restored.map((c) => `  '${c.capName}',`).join('\n')}
]
`

  writeIfChanged(OUTPUT, out)
  // eslint-disable-next-line no-console
  console.log(
    `runtime-state durability → ${path.relative(ROOT, OUTPUT)} (${restored.length} restored / ${session.length} session)`,
  )
}

main()
