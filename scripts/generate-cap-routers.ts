#!/usr/bin/env tsx
/**
 * Codegen: generate typed per-capability tRPC routers from .cap.ts definitions.
 *
 * Reads each capability definition at build time (via dynamic import) and generates
 * a file with individual, fully-typed router creator functions.
 *
 * Each capability method becomes its own tRPC procedure (query or mutation)
 * with .input() and .output() for full type inference — no generic `call` dispatcher.
 *
 * Usage:
 *   npx tsx scripts/generate-cap-routers.ts
 *
 * Output:
 *   server/backend/src/api/trpc/generated-cap-routers.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  emitsCollectionSelector,
  isObjectInput,
  isVoidInput,
  kebabToCamel,
  resolveMethodAuth,
} from '../packages/types/src/capabilities/cap-router-predicates.js'
import type {
  CapabilityDefinition,
  CapabilityMethodSchema,
} from '../packages/types/src/capabilities/capability-definition.js'
import { CALLER_STAMPED_CAPABILITIES } from '../packages/types/src/capabilities/caller-stamp.js'
import { writeIfChanged } from './codegen-write.ts'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')
const CAPS_DIR = path.join(ROOT, 'packages/types/src/capabilities')
const OUTPUT_FILE = path.join(ROOT, 'server/backend/src/api/trpc/generated-cap-routers.ts')

interface CapInfo {
  fileName: string // e.g., 'rtsp-restream.cap'
  exportName: string // e.g., 'rtspRestreamCapability'
  capName: string // e.g., 'rtsp-restream'
  camelName: string // e.g., 'rtspRestream'
  mode: 'singleton' | 'collection'
  scope: 'system' | 'device'
  /**
   * Does this cap's router carry the collection `addonId` selector? From the
   * SHARED `emitsCollectionSelector` (the effective MOUNT, not `mode`), so
   * this type-only file and the runtime builder cannot classify a cap
   * differently — a device-scoped wrapper collection (`videoclips`, D554)
   * resolves its providers from the DEVICE and must not advertise a selector
   * nothing reads.
   */
  emitsAddonIdSelector: boolean
  methods: MethodInfo[]
  /** Mirror of CapabilityDefinition.exposesDeviceSettings — drives inline
   *  merge of the three DeviceSettingsContribution actions into the
   *  generated router + Moleculer service + hub proxy. */
  exposesDeviceSettings: boolean
  /** Mirror of CapabilityDefinition.status — drives inline merge of
   *  DEVICE_STATUS_METHOD into the generated router so the auto-injected
   *  `getStatus` gets a typed route. */
  hasStatus: boolean
  /** Mirror of CapabilityDefinition.nodeIdMode. `'data'` skips the
   *  generic nodeId-routing layer; `'routing'` (default) keeps it. */
  nodeIdMode: 'routing' | 'data'
}

interface MethodInfo {
  name: string
  kind: 'query' | 'mutation' | 'subscription'
  auth: 'public' | 'protected' | 'admin' | 'superAdmin'
  /** Determined at codegen time by inspecting the Zod schema instance */
  isVoidInput: boolean
  /** True when input is z.object() — supports .extend() for nodeId injection */
  isObjectInput: boolean
  /**
   * Origin of this method's schema — drives how the generated router
   * references its input/output. Using a DIRECT reference to the source
   * constant (rather than spreading into `const m`) is the difference
   * between `input: unknown` and `input: { deviceId: number }` on the
   * inferred AppRouter type — spreading collapses the union inside
   * TypeScript's inference budget.
   */
  source: 'cap' | 'settings' | 'status'
  /** `optionalMethod()` — a COLLECTION source may not serve it. */
  providerOptional: boolean
}

/**
 * Emit the call into the provider.
 *
 * A `providerOptional` method — a COLLECTION cap's method a SOURCE may
 * legitimately not serve (`videoclips.readClipBytes`; the recorder's
 * `analytics` source is a time window with no file behind it) — is CHECKED
 * before it is called, and its absence is answered `NOT_IMPLEMENTED` naming
 * the capability and the method. That is the same answer
 * `device-collection-dispatch.ts`'s `callSource` already gives per source, so
 * the two routing layers say the same thing rather than one of them throwing
 * `p.readClipBytes is not a function` at a caller.
 */
function callProviderMethod(capName: string, method: MethodInfo, arg: string): string[] {
  const cast =
    '        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument'
  if (!method.providerOptional) {
    return [cast, `        return p.${method.name}(${arg} as any)`]
  }
  return [
    `        const fn = p.${method.name}`,
    `        if (typeof fn !== 'function') {`,
    `          throw new TRPCError({`,
    `            code: 'NOT_IMPLEMENTED',`,
    `            message: 'Capability "${capName}" provider does not implement "${method.name}"',`,
    `          })`,
    `        }`,
    cast,
    `        return fn.call(p, ${arg} as any)`,
  ]
}

function kebabToPascal(str: string): string {
  const camel = kebabToCamel(str)
  return camel.charAt(0).toUpperCase() + camel.slice(1)
}

const AUTH_PROCEDURE_MAP: Record<string, string> = {
  public: 'publicProcedure',
  protected: 'protectedProcedure',
  admin: 'adminProcedure',
  superAdmin: 'superAdminProcedure',
}

async function loadCapabilities(): Promise<CapInfo[]> {
  const files = fs.readdirSync(CAPS_DIR).filter((f) => f.endsWith('.cap.ts'))
  const caps: CapInfo[] = []

  for (const file of files) {
    const filePath = path.join(CAPS_DIR, file)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- dynamic import at codegen time
    const mod: Record<string, unknown> = await import(filePath)

    // Find the exported capability definition (ends with 'Capability')
    const exportName = Object.keys(mod).find((k) => k.endsWith('Capability'))
    if (!exportName) continue

    const capDef = mod[exportName] as CapabilityDefinition
    // Expand the cap def so every consumer sees the same effective surface:
    // when `exposesDeviceSettings: true`, the three contribution methods
    // (getDeviceSettingsContribution / getDeviceLiveContribution /
    // applyDeviceSettingsPatch) are folded into the methods map. The Moleculer
    // service factory + hub proxy use the same expansion — the tRPC router
    // matches so browser callers can reach these procedures as regular
    // cap methods, not an implicit in-process-only surface.
    const { expandCapMethods, DEVICE_SETTINGS_CONTRIBUTION_METHODS, DEVICE_STATUS_METHOD } =
      await import('@camstack/types')
    const effectiveMethods = expandCapMethods(capDef)
    if (Object.keys(effectiveMethods).length === 0) continue

    const settingsMethodNames = new Set(Object.keys(DEVICE_SETTINGS_CONTRIBUTION_METHODS))
    const statusMethodNames = new Set(Object.keys(DEVICE_STATUS_METHOD))

    const methods: MethodInfo[] = Object.entries(effectiveMethods).map(([name, schema]) => {
      const methodSchema = schema as CapabilityMethodSchema
      const inp = methodSchema.input as Record<string, unknown>
      const isVoid = isVoidInput(inp)
      const isObject = isObjectInput(inp)
      const source: 'cap' | 'settings' | 'status' = statusMethodNames.has(name)
        ? 'status'
        : settingsMethodNames.has(name)
          ? 'settings'
          : 'cap'
      return {
        name,
        kind: methodSchema.kind ?? 'query',
        // Task 7.5c floor: an `internal: true` cap's un-annotated method
        // resolves to `'admin'`, not `'protected'` — mirrors the runtime
        // builder (`cap-router-builder.ts`) via the SAME shared function so
        // the generated (type-only) router and the live runtime can never
        // disagree on which auth tier a method actually got.
        auth: resolveMethodAuth(capDef, methodSchema),
        isVoidInput: isVoid,
        isObjectInput: isObject,
        source,
        providerOptional: methodSchema.providerOptional === true,
      }
    })

    caps.push({
      fileName: file.replace('.ts', ''),
      exportName,
      capName: capDef.name,
      camelName: kebabToCamel(capDef.name),
      mode: capDef.mode,
      scope: capDef.scope,
      emitsAddonIdSelector: emitsCollectionSelector(capDef),
      exposesDeviceSettings: capDef.exposesDeviceSettings === true,
      hasStatus: capDef.status != null,
      nodeIdMode: capDef.nodeIdMode === 'data' ? 'data' : 'routing',
      methods,
    })
  }

  // Deduplicate by capName — prefer the file whose name matches the capability
  const deduped = new Map<string, CapInfo>()
  for (const cap of caps) {
    const existing = deduped.get(cap.capName)
    if (!existing) {
      deduped.set(cap.capName, cap)
    } else {
      // Prefer the file that matches the capability name (e.g., advanced-notifier.cap for advanced-notifier)
      const capFileName = `${cap.capName}.cap`
      if (cap.fileName === capFileName) {
        deduped.set(cap.capName, cap)
      }
    }
  }

  return [...deduped.values()].sort((a, b) => a.capName.localeCompare(b.capName))
}

function generateRouterCreator(cap: CapInfo): string[] {
  const lines: string[] = []
  const funcName = `createCapRouter_${cap.camelName}`
  const pascal = kebabToPascal(cap.capName)

  lines.push(
    `// ── ${cap.capName} (${cap.mode}) ──${'─'.repeat(Math.max(0, 50 - cap.capName.length))}`,
  )
  lines.push('')
  lines.push(`type ${pascal}Provider = InferProvider<typeof ${cap.exportName}>`)
  lines.push('')
  // `nodeIdMode: 'data'` forwards `nodeId` as DATA to the local
  // provider — no in-router routing — so `createRemoteProxy` is unused
  // and marked with a leading underscore to keep `noUnusedParameters` quiet.
  // Same when the cap has only subscription methods, or only methods
  // with non-object (raw scalar/array) inputs — both bypass
  // `resolveProvider` and never reference `createRemoteProxy`.
  const usesResolveProvider = cap.methods.some((m) => {
    if (m.kind === 'subscription') return false
    return m.isVoidInput || m.isObjectInput
  })
  const remoteProxyUnused = cap.nodeIdMode === 'data' || !usesResolveProvider
  // Collection caps gain an orthogonal `addonId` selector: the router
  // accepts an optional `addonId` per method and forwards it to
  // `getProvider(ctx, addonId)` so the mount closure can pick WHICH
  // provider within the local collection answers. `nodeId` routing is
  // untouched — `addonId` is resolved against the LOCAL collection only.
  const isCollection = cap.emitsAddonIdSelector
  lines.push(`export function ${funcName}(`)
  lines.push(
    isCollection
      ? `  getProvider: (ctx: TrpcContext, addonId?: string) => ${pascal}Provider | null,`
      : `  getProvider: (ctx: TrpcContext) => ${pascal}Provider | null,`,
  )
  lines.push(
    `  ${remoteProxyUnused ? '_createRemoteProxy' : 'createRemoteProxy'}?: (capName: string, nodeId: string) => ${pascal}Provider | null,`,
  )
  lines.push(`) {`)
  // NO intermediate `const m` spread — that collapsed TypeScript
  // inference into `input: unknown; output: unknown` for every inlined
  // procedure in AppRouter. Direct references per method keep the
  // schema objects' Zod inference intact.
  lines.push(`  return trpcRouter({`)

  // Resolve the method-schema object reference for a given method.
  // Direct reference (e.g. `snapshotCapability.methods.getSnapshot` or
  // `DEVICE_STATUS_METHOD.getStatus`) preserves TS inference; a spread
  // intersection would collapse it.
  const schemaRef = (m: MethodInfo) => {
    if (m.source === 'status') return `DEVICE_STATUS_METHOD.${m.name}`
    if (m.source === 'settings') return `DEVICE_SETTINGS_CONTRIBUTION_METHODS.${m.name}`
    return `${cap.exportName}.methods.${m.name}`
  }

  for (const method of cap.methods) {
    const procedure = AUTH_PROCEDURE_MAP[method.auth] ?? 'protectedProcedure'
    const schema = schemaRef(method)

    if (method.kind === 'subscription') {
      // Subscriptions don't support nodeId routing (they require a persistent connection)
      lines.push(`    ${method.name}: ${procedure}`)
      lines.push(`      .input(${schema}.input)`)
      lines.push(`      .subscription(({ input, ctx }) => {`)
      lines.push(`        const p = requireCapProvider('${cap.capName}', () => getProvider(ctx))`)
      lines.push(`        return iterableSubscription<unknown>((push) => {`)
      lines.push(`          return p.${method.name}(input, push) ?? (() => {})`)
      lines.push(`        })`)
      lines.push(`      }),`)
    } else {
      const procType = method.kind === 'query' ? 'query' : 'mutation'

      if (method.isVoidInput) {
        // Void-input methods: input becomes { nodeId? } (optional).
        //
        // For `nodeIdMode: 'data'` caps the cap-router never routes by
        // `nodeId` — the hub provider is the sole host. A void-input
        // method carries no data either, so it resolves the local hub
        // provider directly and ignores any stray `nodeId`. This also
        // keeps `createRemoteProxy` genuinely unused for these caps so
        // it can be safely underscore-prefixed.
        // Collection caps also accept an optional `addonId` to select
        // a specific provider within the local collection.
        const localGetter = isCollection
          ? '() => getProvider(ctx, input?.addonId)'
          : '() => getProvider(ctx)'
        lines.push(`    ${method.name}: ${procedure}`)
        lines.push(
          isCollection
            ? `      .input(z.object({ nodeId: z.string().optional(), addonId: z.string().optional() }).optional())`
            : `      .input(z.object({ nodeId: z.string().optional() }).optional())`,
        )
        lines.push(`      .output(${schema}.output)`)
        lines.push(`      .${procType}(async ({ input, ctx }) => {`)
        if (cap.nodeIdMode === 'data') {
          lines.push(`        void input`)
          lines.push(`        const p = requireCapProvider('${cap.capName}', ${localGetter})`)
        } else {
          lines.push(
            `        const p = resolveProvider('${cap.capName}', input?.nodeId, ${localGetter}, createRemoteProxy)`,
          )
        }
        if (method.providerOptional) {
          // The same check `callProviderMethod` emits — a no-input optional
          // method (`log-destination.describeRead`) is just as absent.
          lines.push(`        const fn = p.${method.name}`)
          lines.push(`        if (typeof fn !== 'function') {`)
          lines.push(`          throw new TRPCError({`)
          lines.push(`            code: 'NOT_IMPLEMENTED',`)
          lines.push(
            `            message: 'Capability "${cap.capName}" provider does not implement "${method.name}"',`,
          )
          lines.push(`          })`)
          lines.push(`        }`)
          lines.push(`        return fn.call(p)`)
        } else {
          lines.push(`        return p.${method.name}()`)
        }
        lines.push(`      }),`)
      } else if (method.isObjectInput) {
        // Object-input methods: use .loose() to accept nodeId without stripping extra keys.
        //
        // Caps with `nodeIdMode: 'data'` (e.g. `addon-settings`) carry
        // `nodeId` as DATA — the provider dispatches internally. The
        // cap router must forward `nodeId` intact instead of stripping
        // it for generic routing.
        const passthrough = cap.nodeIdMode === 'data'
        const stampedCap = CALLER_STAMPED_CAPABILITIES.includes(cap.capName)
        lines.push(`    ${method.name}: ${procedure}`)
        lines.push(`      .input(${schema}.input.loose())`)
        lines.push(`      .output(${schema}.output)`)
        lines.push(`      .${procType}(async ({ input, ctx }) => {`)
        const routedInput = stampedCap ? 'parsedInput' : 'input'
        if (stampedCap) {
          lines.push(
            `        const parsedInput = ctx.req !== undefined ? withoutCallerStamp(input) : input`,
          )
        }
        if (passthrough) {
          lines.push(
            `        const p = requireCapProvider('${cap.capName}', () => getProvider(ctx))`,
          )
          lines.push(
            `        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument`,
          )
          lines.push(`        return p.${method.name}(${routedInput} as any)`)
        } else if (isCollection) {
          // Collection cap: strip BOTH `nodeId` (node routing) and
          // `addonId` (local collection selector) — they're router-level
          // selectors only and must not reach the provider method.
          // NOTE: `addonId` cannot cross node boundaries — a nodeId-routed
          // call to a remote collection cap still hits the remote's
          // provider[0]. Documented out-of-scope limitation.
          lines.push(
            `        const { nodeId, addonId, ...methodInput } = ${routedInput} as { nodeId?: string; addonId?: string } & Record<string, unknown>`,
          )
          lines.push(
            `        const p = resolveProvider('${cap.capName}', nodeId, () => getProvider(ctx, addonId), createRemoteProxy)`,
          )
          lines.push(...callProviderMethod(cap.capName, method, 'methodInput'))
        } else {
          lines.push(
            `        const { nodeId, ...methodInput } = ${routedInput} as { nodeId?: string } & Record<string, unknown>`,
          )
          lines.push(
            `        const p = resolveProvider('${cap.capName}', nodeId, () => getProvider(ctx), createRemoteProxy)`,
          )
          lines.push(...callProviderMethod(cap.capName, method, 'methodInput'))
        }
        lines.push(`      }),`)
      } else {
        // Non-object input (z.record, z.string, z.array, etc.) — no nodeId injection,
        // always routes to local provider. Node routing for these methods must use
        // the capability-level proxy directly.
        lines.push(`    ${method.name}: ${procedure}`)
        lines.push(`      .input(${schema}.input)`)
        lines.push(`      .output(${schema}.output)`)
        lines.push(`      .${procType}(async ({ input, ctx }) => {`)
        lines.push(`        const p = requireCapProvider('${cap.capName}', () => getProvider(ctx))`)
        lines.push(`        return p.${method.name}(input)`)
        lines.push(`      }),`)
      }
    }
  }

  lines.push(`  })`)
  lines.push(`}`)
  lines.push('')

  return lines
}

async function generate(): Promise<void> {
  const caps = await loadCapabilities()

  console.log(`Found ${caps.length} capabilities with methods:`)
  for (const cap of caps) {
    const methodSummary = cap.methods.map((m) => `${m.name}(${m.kind}/${m.auth})`).join(', ')
    console.log(`  ${cap.capName} [${cap.mode}]: ${methodSummary}`)
  }

  // Collect unique auth procedures needed
  const authProcedures = new Set<string>(['protectedProcedure'])
  for (const cap of caps) {
    for (const method of cap.methods) {
      authProcedures.add(AUTH_PROCEDURE_MAP[method.auth] ?? 'protectedProcedure')
    }
  }
  const hasSubscriptions = caps.some((c) => c.methods.some((m) => m.kind === 'subscription'))
  const middlewareImports = [...authProcedures].sort()
  if (hasSubscriptions) {
    middlewareImports.push('iterableSubscription')
  }

  const lines: string[] = [
    '// AUTO-GENERATED by scripts/generate-cap-routers.ts — DO NOT EDIT',
    '// Re-run: npx tsx scripts/generate-cap-routers.ts',
    '//',
    `// Capabilities: ${caps.length}`,
    '/* eslint-disable */',
    '',
    "import { TRPCError } from '@trpc/server'",
    "import { CapRouteError } from '@camstack/system'",
    "import { z } from 'zod'",
    `import { ${middlewareImports.join(', ')}, trpcRouter } from './trpc.middleware.js'`,
    `import type { InferProvider } from '@camstack/types'`,
    ...(caps.some((c) => c.exposesDeviceSettings)
      ? [`import { DEVICE_SETTINGS_CONTRIBUTION_METHODS } from '@camstack/types'`]
      : []),
    ...(caps.some((c) => c.hasStatus)
      ? [`import { DEVICE_STATUS_METHOD } from '@camstack/types'`]
      : []),
    ...(caps.some((c) => CALLER_STAMPED_CAPABILITIES.includes(c.capName))
      ? [`import { withoutCallerStamp } from '@camstack/types'`]
      : []),
    `import type { TrpcContext } from './trpc.context.js'`,
    '',
  ]

  for (const cap of caps) {
    lines.push(`import { ${cap.exportName} } from '@camstack/types'`)
  }

  lines.push('')

  // Provider accessor helper
  lines.push('// ── Provider Accessor ───────────────────────────────────────────────')
  lines.push('')
  lines.push(
    'export function requireCapProvider<T>(name: string, getProvider: () => T | null): T {',
  )
  lines.push('  const p = getProvider()')
  lines.push('  if (p === null || p === undefined) {')
  lines.push('    throw new TRPCError({')
  lines.push("      code: 'PRECONDITION_FAILED',")
  lines.push(`      message: \`Capability "\${name}" provider not available\`,`)
  lines.push('      cause: new CapRouteError(name, undefined, {')
  lines.push("        reason: 'no-provider',")
  lines.push(
    "        rejected: [{ kind: 'hub-in-process', why: 'no provider bound for this cap' }],",
  )
  lines.push('      }),')
  lines.push('    })')
  lines.push('  }')
  lines.push('  return p')
  lines.push('}')
  lines.push('')

  // resolveProvider helper — routes to local or remote provider via nodeId
  lines.push('// ── Node Routing ────────────────────────────────────────────────────')
  lines.push('')
  lines.push('type ProxyFactory<T> = ((capName: string, nodeId: string) => T | null) | undefined')
  lines.push('')
  lines.push('function resolveProvider<T>(')
  lines.push('  capName: string,')
  lines.push('  nodeId: string | undefined,')
  lines.push('  getLocal: () => T | null,')
  lines.push('  createProxy: ProxyFactory<T>,')
  lines.push('): T {')
  lines.push('  // No nodeId — try local hub provider first; if the cap lives')
  lines.push('  // in a forked hub worker (hub/pipeline, hub/stream-broker)')
  lines.push('  // getLocal() returns null on the hub root, so fall through to')
  lines.push("  // createProxy('hub', ...) which leverages moleculer findCallFn")
  lines.push('  // prefix lookup to route to the matching subnode.')
  lines.push("  if (!nodeId || nodeId === 'hub') {")
  lines.push('    const local = getLocal()')
  lines.push('    if (local !== null && local !== undefined) return local')
  lines.push('    if (createProxy) {')
  lines.push("      const proxy = createProxy(capName, 'hub')")
  lines.push('      if (proxy) return proxy')
  lines.push('    }')
  lines.push('    throw new TRPCError({')
  lines.push("      code: 'PRECONDITION_FAILED',")
  lines.push(`      message: \`Capability "\${capName}" provider not available\`,`)
  lines.push('      cause: new CapRouteError(capName, undefined, {')
  lines.push("        reason: 'no-provider',")
  lines.push(
    "        rejected: [{ kind: 'hub-in-process', why: 'no provider bound for this cap/device' }],",
  )
  lines.push('      }),')
  lines.push('    })')
  lines.push('  }')
  lines.push('')
  lines.push('  if (!createProxy) {')
  lines.push('    throw new TRPCError({')
  lines.push("      code: 'BAD_REQUEST',")
  lines.push(`      message: \`Node routing not available for "\${capName}"\`,`)
  lines.push('    })')
  lines.push('  }')
  lines.push('  const proxy = createProxy(capName, nodeId)')
  lines.push('  if (!proxy) {')
  lines.push('    throw new TRPCError({')
  lines.push("      code: 'PRECONDITION_FAILED',")
  lines.push(`      message: \`Capability "\${capName}" not available on node "\${nodeId}"\`,`)
  lines.push('      cause: new CapRouteError(capName, undefined, {')
  lines.push("        reason: 'no-provider',")
  lines.push('        nodeId,')
  lines.push(
    '        rejected: [{ kind: \'remote-moleculer\', why: `cap not available on node "${nodeId}"` }],',
  )
  lines.push('      }),')
  lines.push('    })')
  lines.push('  }')
  lines.push('  return proxy')
  lines.push('}')
  lines.push('')

  // Generate router creators
  lines.push('// ── Router Creators ─────────────────────────────────────────────────')
  lines.push('')

  for (const cap of caps) {
    lines.push(...generateRouterCreator(cap))
  }

  // Generate the combined type
  lines.push('// ── Combined Router Map Type ────────────────────────────────────────')
  lines.push('')
  lines.push('/** Typed map of all auto-generated capability routers. */')
  lines.push('export interface GeneratedCapabilityRouterMap {')
  for (const cap of caps) {
    lines.push(`  readonly ${cap.camelName}: ReturnType<typeof createCapRouter_${cap.camelName}>`)
  }
  lines.push('}')
  lines.push('')

  const output = lines.join('\n')

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true })
  writeIfChanged(OUTPUT_FILE, output)
  console.log(`\nWritten to: ${path.relative(ROOT, OUTPUT_FILE)}`)
  console.log(`  ${caps.length} router creators + GeneratedCapabilityRouterMap type`)
}

generate().catch((err: unknown) => {
  console.error('Codegen failed:', err)
  process.exit(1)
})
