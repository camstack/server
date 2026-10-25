#!/usr/bin/env tsx
/**
 * Guard: `generated/cap-status-types.ts` must import capability schemas as `import type`, NEVER as a
 * value import.
 *
 * Those schemas (`<Pascal>StatusSchema` / `<name>Capability`) are used ONLY inside
 * `z.infer<typeof X>` (type positions) to build the `CapStatusTypeMap` type. The only RUNTIME export
 * of the file is `CAP_NAMES_WITH_STATUS` — a plain array of string literals that references no schema.
 *
 * A VALUE import here (`import { XStatusSchema } from '../capabilities/x.cap.js'`) drags EVERY status
 * cap-def zod schema into every runtime that touches the `@camstack/types` barrel (the barrel value-
 * exports `CAP_NAMES_WITH_STATUS` from this file), bloating each addon runner's heap for zero runtime
 * need. `generate-cap-status-types.ts` emits `import type` — this guard fails the build if that
 * regresses (hand-edit or codegen drift).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = path.join(ROOT, 'packages/types/src/generated/cap-status-types.ts')

const lines = readFileSync(TARGET, 'utf8').split('\n')
const violations: { line: number; content: string }[] = []

lines.forEach((raw, i) => {
  const line = raw.trim()
  // A VALUE import (no `type` keyword) of a capability module.
  if (/^import\s+\{[^}]*\}\s+from\s+['"]\.\.\/capabilities\/[^'"]+['"]/.test(line)) {
    violations.push({ line: i + 1, content: line })
  }
})

if (violations.length === 0) {
  // eslint-disable-next-line no-console
  console.log(
    '  \x1b[32m✔\x1b[0m cap-status-types import guard passed — all cap imports are type-only',
  )
  process.exit(0)
}

// eslint-disable-next-line no-console
console.error(
  '\n\x1b[31m✘ cap-status-types must import capability schemas as `import type`:\x1b[0m',
)
// eslint-disable-next-line no-console
console.error(
  '  These schemas are used only in `z.infer<typeof X>` (types). A value import bloats every addon\n' +
    '  runner with the full status cap-def graph. Fix generate-cap-status-types.ts to emit `import type`.\n',
)
for (const v of violations) {
  // eslint-disable-next-line no-console
  console.error(`    cap-status-types.ts:${v.line}  \x1b[2m${v.content}\x1b[0m`)
}
process.exit(1)
