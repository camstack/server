#!/usr/bin/env tsx
/**
 * Codegen: SystemProxy — typed namespaces over every `scope: 'system'`
 * capability, restricted to methods that DO NOT take a `deviceId`.
 *
 * Mirrors `scripts/generate-device-proxy.ts` for device-scoped caps:
 *   1. Walks `packages/types/src/capabilities/*.cap.ts`.
 *   2. Filters to caps with `scope: 'system'`.
 *   3. For each cap, lists methods whose input schema does NOT contain
 *      `deviceId: z.number()` — those device-bound entries already
 *      surface on `DeviceProxy` and have no place on a cluster-wide
 *      facade.
 *   4. Emits `packages/types/src/generated/system-proxy.ts` with:
 *        - `interface SystemProxy { readonly <cap>: { method(input): Promise<output> } }`
 *        - `function createSystemProxy(api: AddonApi): SystemProxy`
 *
 * The generated proxy is consumed by the SDK's `System` class
 * (`packages/sdk/src/system.ts`) — every system-cap field on `System`
 * (e.g. `system.userManagement`, `system.storage`) is a thin getter
 * onto the corresponding `SystemProxy` namespace.
 *
 * Run manually: npx tsx scripts/generate-system-proxy.ts
 */

import * as fs from 'node:fs'
import { writeIfChanged } from './codegen-write.ts'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAllCaps, type CapInfo } from './lib/parse-cap.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CAPS_DIR = path.join(ROOT, 'packages/types/src/capabilities')
const OUTPUT = path.join(ROOT, 'packages/types/src/generated/system-proxy.ts')

interface SystemCap extends CapInfo {
  /** Methods with NO `deviceId` in the input schema — the SystemProxy surface. */
  readonly systemMethods: readonly { name: string; kind: 'query' | 'mutation' | 'subscription' }[]
}

function pickSystemCaps(all: readonly CapInfo[]): readonly SystemCap[] {
  const out: SystemCap[] = []
  for (const c of all) {
    if (c.scope !== 'system') continue
    // `internal: true` caps are server-internal contributions — never
    // mounted on the public AppRouter. Emitting a SystemProxy entry
    // would mint a `system.<cap>.<method>()` accessor that throws at
    // runtime ("api has no '<cap>.<method>'"). Skip them entirely.
    if (c.internal) continue
    const systemMethods = c.methods
      .filter((m) => !m.deviceBound)
      .map((m) => ({ name: m.name, kind: m.kind }))
    if (systemMethods.length === 0) continue
    out.push({ ...c, systemMethods })
  }
  return out.slice().sort((a, b) => a.propertyName.localeCompare(b.propertyName))
}

async function main(): Promise<void> {
  const allCaps = parseAllCaps(CAPS_DIR)
  const systemCaps = pickSystemCaps(allCaps)

  console.log(`Found ${systemCaps.length} system caps with cluster-wide (non-device) methods:`)
  for (const c of systemCaps) {
    console.log(
      `  ${c.propertyName} (${c.capName}) [${c.systemMethods.map((m) => `${m.name}(${m.kind})`).join(', ')}]`,
    )
  }

  const imports = systemCaps
    .map((c) => `import type { ${c.exportName} } from '../capabilities/${c.fileName}'`)
    .join('\n')

  // For each cap, the SystemProxy entry exposes only the system-method
  // subset of its `InferProvider<...>` shape. `Pick` narrows it cleanly
  // and matches the runtime emit (the dispatch table only wires those
  // method names).
  const proxyFields = systemCaps
    .map((c) => {
      const union = c.systemMethods.map((m) => `'${m.name}'`).join(' | ')
      return `  readonly ${c.propertyName}: Pick<InferProvider<typeof ${c.exportName}>, ${union}>`
    })
    .join('\n')

  const factoryBlocks = systemCaps
    .map((c) => {
      const methodEntries = c.systemMethods
        .map((m) => {
          if (m.kind === 'subscription') {
            return `    ${m.name}: (input?: unknown, push?: unknown) => dispatch('${c.propertyName}', '${m.name}', '${m.kind}', input, push),`
          }
          return `    ${m.name}: (input?: unknown) => dispatch('${c.propertyName}', '${m.name}', '${m.kind}', input),`
        })
        .join('\n')
      return `  const ${c.propertyName}Interface = {
${methodEntries}
  }`
    })
    .join('\n\n')

  const returnFields = systemCaps
    .map((c) => `    ${c.propertyName}: ${c.propertyName}Interface,`)
    .join('\n')

  const output = `// AUTO-GENERATED — do not edit manually.
// Regenerate with: npx tsx scripts/generate-system-proxy.ts
/* eslint-disable */

import type { InferProvider } from '../capabilities/capability-definition.js'
import { invokeTrpcLeaf, type TrpcDispatchKind } from '../helpers/trpc-leaf.js'
import type { AddonApi } from './addon-api.js'
${imports}

/**
 * Cluster-wide facade over every \`scope: 'system'\` capability. Each entry
 * is a typed namespace exposing only the cap's non-device-bound methods —
 * device-scoped slices already surface on \`DeviceProxy\`.
 *
 * Consumed by the SDK's \`System\` class as the source of truth for
 * \`system.<cap>.<method>(input)\` calls.
 */
export interface SystemProxy {
${proxyFields}
}

/**
 * Build a \`SystemProxy\` that dispatches every namespace method through
 * the existing system-cap tRPC procedures (\`api.<capProp>.<method>.{query,mutate,subscribe}\`).
 *
 * Pure function — no caching, no live state. The caller (typically
 * \`System\`) owns the \`AddonApi\` instance and disposes the proxy by
 * dropping the reference.
 */
export function createSystemProxy(api: AddonApi): SystemProxy {
  type Kind = TrpcDispatchKind

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function dispatch(capProp: string, method: string, kind: Kind, input?: unknown, push?: unknown): any {
    return invokeTrpcLeaf(api, capProp, method, kind, input, push)
  }

${factoryBlocks}

  return {
${returnFields}
  }
}
`

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
  writeIfChanged(OUTPUT, output)
  console.log(`\nGenerated: ${OUTPUT}`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
