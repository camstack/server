#!/usr/bin/env tsx
/**
 * The generated device-local-state table is schema-free (D1073, amends D28).
 *
 * `BaseDevice.state` builds a slice proxy per cap, and the proxy reads only the
 * cap NAME. The table it looks them up in used to hold the cap DEFINITIONS, so
 * `base-device.ts` (inlined into every device provider) referenced every
 * device-native cap and with it ~400 KB of Zod schemas. The table is now plain
 * names (`DEVICE_LOCAL_STATE_CAP_NAMES`), and this guard keeps it that way:
 * `packages/types/src/generated/device-local-state.ts` may carry type-only imports
 * of the cap modules and no value import.
 *
 * Run: npx tsx scripts/check-device-local-state-schema-free.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GUARDED = ['packages/types/src/generated/device-local-state.ts'] as const

/** Value imports (not `import type`) of a cap definition module, from source text. */
export function valueImportsOfCapModules(src: string): readonly string[] {
  const out: string[] = []
  for (const m of src.matchAll(/^import\s+(?!type\b)[^'"]*from\s+['"]([^'"]+)['"]/gm)) {
    const spec = m[1] ?? ''
    if (/\.cap(\.js)?$/.test(spec) || spec.endsWith('/generated/capability-router-map.js')) {
      out.push(spec)
    }
  }
  return out
}

export function violations(root: string): readonly string[] {
  const found: string[] = []
  for (const rel of GUARDED) {
    const src = fs.readFileSync(path.join(root, rel), 'utf-8')
    for (const spec of valueImportsOfCapModules(src)) {
      found.push(`${rel} imports ${spec} for a value`)
    }
  }
  return found
}

function main(): void {
  const found = violations(ROOT)
  if (found.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `✗ device-local-state schema-free guard (D1073): the cap-name table must not pull a cap definition.\n` +
        `  BaseDevice.state needs cap NAMES only; a value import of a *.cap module puts every device-native\n` +
        `  schema (~400 KB) into each device provider. Generate names, not definitions (scripts/generate-device-proxy.ts).`,
    )
    for (const f of found) {
      // eslint-disable-next-line no-console
      console.error(`  - ${f}`)
    }
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log('✔ device-local-state schema-free guard')
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
