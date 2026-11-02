#!/usr/bin/env tsx
/**
 * Cap mount agreement guard — the type-only codegen mount and the runtime
 * builder must tell the same story about every cap.
 *
 * ## The failure this catches
 *
 * `integration-instances` was made public and admin-gated (the `internal: true`
 * flag removed) but kept `mount: { kind: 'skip' }`. `generated-cap-mounts.ts`
 * still carried a line for it, so the AppRouter TYPE had the route and every
 * client compiled, while the runtime builder (`buildCapRouters`) skips any cap
 * whose `resolveCapMount(def).kind` is `skip`: the live route answered
 * NOT_FOUND. Nothing compared the two.
 *
 * ## What it checks (both read `resolveCapMount`, never a copy of it)
 *
 * 1. A cap that resolves to `skip` must be `internal: true`. `skip` means "no
 *    tRPC route"; a public cap (it has generated hooks) without a route is the
 *    defect above. The codegen emits an inert line for the internal ones.
 * 2. A cap the runtime builder mounts must have a line in
 *    `generated-cap-mounts.ts`, or the client type lacks a route that exists.
 *
 * Usage: tsx scripts/check-cap-mount-codegen-agrees.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { ALL_CAPABILITY_DEFINITIONS } from '../packages/types/src/generated/capability-router-map.js'
import {
  type CapabilityDefinition,
  resolveCapMount,
} from '../packages/types/src/capabilities/capability-definition.js'
import { builderMountedCapNames } from '../packages/system/src/kernel/cap-router-builder.js'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')
const GENERATED_MOUNTS = 'server/backend/src/api/trpc/generated-cap-mounts.ts'

/** The camelCase keys the codegen'd `mountAllCaps` returns. */
export function generatedMountKeys(source: string): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const m of source.matchAll(/^\s{4}(\w+): createCapRouter_\w+\(/gm)) {
    if (m[1] !== undefined) keys.add(m[1])
  }
  return keys
}

export function findMountDisagreements(
  defs: readonly CapabilityDefinition[],
  generatedKeys: ReadonlySet<string>,
  builderNames: readonly string[],
): readonly string[] {
  const failures: string[] = []
  for (const def of defs) {
    if (resolveCapMount(def).kind === 'skip' && def.internal !== true) {
      failures.push(
        `'${def.name}' is public (not internal) but resolves to mount 'skip': the runtime ` +
          `builder never mounts it, so its route answers NOT_FOUND while the generated type ` +
          `has it. Remove the \`mount\` hint ` +
          `or mark the cap \`internal: true\`.`,
      )
    }
  }
  for (const name of builderNames) {
    if (!generatedKeys.has(name)) {
      failures.push(
        `'${name}' is mounted by the runtime builder but has no line in ${GENERATED_MOUNTS}. ` +
          `Run \`npm run codegen\`.`,
      )
    }
  }
  return failures
}

function main(): void {
  const source = fs.readFileSync(path.join(ROOT, GENERATED_MOUNTS), 'utf8')
  const failures = findMountDisagreements(
    ALL_CAPABILITY_DEFINITIONS,
    generatedMountKeys(source),
    builderMountedCapNames(),
  )
  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error('check-cap-mount-codegen-agrees: FAILED\n')
    for (const f of failures) {
      // eslint-disable-next-line no-console
      console.error(`  - ${f}`)
    }
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log(
    `check-cap-mount-codegen-agrees: OK — ${builderMountedCapNames().length} runtime-mounted cap(s) all in the generated mounts.`,
  )
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1])))
  main()
