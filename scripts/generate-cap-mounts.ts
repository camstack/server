#!/usr/bin/env tsx
/**
 * Codegen: emit `mountAllCaps(t, reg)` — the single auto-mount entrypoint
 * for every codegen'd `createCapRouter_<Cap>` factory in the AppRouter.
 *
 * Why this exists:
 *   Hand-mounting every cap in `server/backend/src/api/trpc/trpc.router.ts`
 *   re-introduced the same drift problem `generate-cap-routers.ts` already
 *   solved — every new cap had to be wired in two places (router + mount).
 *   The transport layer principle says: everything must be reachable
 *   cross-process via tRPC. The `localProviderLink` short-circuit covers
 *   the co-located fast path, but the tRPC route MUST exist as the
 *   fallback so a Moleculer mesh failure doesn't break addon-to-addon
 *   communication.
 *
 *   This script walks every `*.cap.ts` and emits a single
 *   `mountAllCaps(t, reg)` factory that returns a `Record<capName,
 *   capRouter>` object spreadable into the AppRouter. Override-by-spread
 *   is supported on the caller side: caps with service-backed providers
 *   (`system`, `nodes`, `integrations`, `addons`, `network-quality`,
 *   `toast`) override the auto-mount entry by listing themselves AFTER
 *   the spread.
 *
 *   `internal: true` caps are STILL mounted — the flag only excludes
 *   them from the SDK proxy + admin-ui hooks. Server-to-server
 *   cross-process callers still need the tRPC route.
 *
 * Skip list:
 *   Ten caps register providers with non-canonical (legacy) shapes —
 *   positional args or sync returns that pre-date the InferProvider
 *   model. They appear in `CapabilityProviderMap` typed as their legacy
 *   interface (`IAdminUI`, `ILogDestination`, …) instead of
 *   `InferProvider<typeof xCap>`. Auto-mounting them would type-error
 *   because the generated router's `getProvider` signature expects the
 *   inferred shape. They go in the skip-list until task #195 refactors
 *   each provider to the wrapped contract.
 *
 *   Future: detect drift between this skip-list and the legacy
 *   interfaces in `CapabilityProviderMap` (so a refactored cap
 *   automatically lights up).
 *
 * Output:
 *   server/backend/src/api/trpc/generated-cap-mounts.ts
 */

import * as fs from 'node:fs'
import { writeIfChanged } from './codegen-write.ts'
import * as path from 'node:path'
import type {
  CapabilityDefinition,
  CapabilityMethodSchema,
  CapabilityMountKind,
} from '../packages/types/src/capabilities/capability-definition.js'
import { resolveCapMount } from '../packages/types/src/capabilities/capability-definition.js'
import {
  emitsCollectionSelector,
  isArrayOutputSchema,
  kebabToCamel,
} from '../packages/types/src/capabilities/cap-router-predicates.js'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')
const CAPS_DIR = path.join(ROOT, 'packages/types/src/capabilities')
const OUTPUT_FILE = path.join(ROOT, 'server/backend/src/api/trpc/generated-cap-mounts.ts')
const GENERATED_ROUTERS_FILE = path.join(
  ROOT,
  'server/backend/src/api/trpc/generated-cap-routers.ts',
)

/**
 * Caps whose provider implementations predate the canonical
 * `(input: ZodSchema, output: ZodSchema, opts?) => method definition`
 * + `Promise<output>` provider contract. They're typed in
 * `CapabilityProviderMap` as legacy interfaces (`I<Name>`) instead of
 * `InferProvider<typeof xCap>`, so wiring them through the codegen'd
 * router's `getProvider(ctx) => InferProvider<...> | null` shape
 * fails type-checking.
 *
 * Each entry is tracked under task #195 (provider-shape unification).
 * When a cap migrates: drop it from this list, re-run codegen, the
 * drift guard verifies a mount line exists.
 */
const LEGACY_SHAPE_SKIP: ReadonlySet<string> = new Set<string>([
  'addon-routes', // IAddonRouteProvider: getRoutes sync + Fastify handler closures
  'auth-provider', // IAuthProvider: internal login/JWT adapter
  'log-destination', // ILogDestination: sync `write` on the per-log hot path
  // (restreamer / streaming-engine / webrtc caps were deleted in SP4)
])

interface CapInfo {
  readonly fileName: string
  readonly exportName: string
  readonly capName: string
  readonly camelName: string
  readonly mode: 'singleton' | 'collection' | 'per-node'
  readonly scope: 'system' | 'device'
  readonly internal: boolean
  /**
   * The EFFECTIVE mount kind, from the shared `resolveCapMount` — never
   * re-derived here. The two classifications (this type-only file and the
   * runtime builder) used to branch on `deviceNative` / `mode` separately,
   * which is how a device-scoped WRAPPER could read `getSingleton` in both
   * places and agree while both were wrong.
   */
  readonly mountKind: CapabilityMountKind
  /**
   * Names of non-subscription methods whose OUTPUT Zod schema is an
   * array (`z.array(...)`, optionally `.readonly()`). For `collection`
   * caps these methods are aggregated across every enabled provider via
   * `concatCollection` when the caller omits `addonId` — the generic
   * "union of every provider's contribution" behaviour that previously
   * lived in hand-written `trpc.router.ts` overrides + bespoke
   * orchestrator caps. Empty for non-collection caps.
   */
  readonly arrayOutputMethods: readonly string[]
  /**
   * From the SHARED `emitsCollectionSelector` — the one predicate this file
   * and `generate-cap-routers.ts` both read, so the mount line and the router
   * signature can never disagree about whether a cap takes an `addonId`.
   */
  readonly emitsCollectionSelector: boolean
}

// `kebabToCamel` + `isArrayOutputSchema` are imported from the shared
// `cap-router-predicates` module (the single source shared with the runtime
// builder) — see the import at the top of this file.

async function loadCapabilities(): Promise<readonly CapInfo[]> {
  const files = fs.readdirSync(CAPS_DIR).filter((f) => f.endsWith('.cap.ts'))
  const caps: CapInfo[] = []

  for (const file of files) {
    const filePath = path.join(CAPS_DIR, file)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- dynamic import at codegen time
    const mod: Record<string, unknown> = await import(filePath)

    const exportName = Object.keys(mod).find((k) => k.endsWith('Capability'))
    if (!exportName) continue

    const capDef = mod[exportName] as CapabilityDefinition
    // Effective methods include the auto-injected `getStatus` (when
    // `status: {...}` is set) and the three contribution methods (when
    // `exposesDeviceSettings: true`). Caps with zero declared methods
    // can still have a generated router if any of these flags trigger.
    const { expandCapMethods } = await import('@camstack/types')
    const effectiveMethods = expandCapMethods(capDef)
    if (Object.keys(effectiveMethods).length === 0) continue

    // Array-output methods only matter for `collection` caps — that's
    // the only mode where the auto-mount fans a method across multiple
    // providers. Subscriptions are excluded (no aggregate semantics).
    const arrayOutputMethods: string[] =
      capDef.mode === 'collection'
        ? Object.entries(effectiveMethods)
            .filter(([, schema]) => {
              const m = schema as CapabilityMethodSchema
              return m.kind !== 'subscription' && isArrayOutputSchema(m.output)
            })
            .map(([name]) => name)
        : []

    caps.push({
      fileName: file.replace('.ts', ''),
      exportName,
      capName: capDef.name,
      camelName: kebabToCamel(capDef.name),
      mode: capDef.mode,
      scope: capDef.scope,
      internal: capDef.internal === true,
      mountKind: resolveCapMount(capDef).kind,
      arrayOutputMethods,
      emitsCollectionSelector: emitsCollectionSelector(capDef),
    })
  }

  // Deduplicate by capName (prefer file matching the cap name).
  const deduped = new Map<string, CapInfo>()
  for (const cap of caps) {
    const existing = deduped.get(cap.capName)
    if (!existing) {
      deduped.set(cap.capName, cap)
      continue
    }
    if (cap.fileName === `${cap.capName}.cap`) {
      deduped.set(cap.capName, cap)
    }
  }

  return [...deduped.values()].sort((a, b) => a.capName.localeCompare(b.capName))
}

// Mount decision is data-driven and SHARED: `emitMountLine` branches on
// `cap.mountKind`, which is `resolveCapMount(def)` — the same function the
// runtime builder reads. No hand-curated allowlist, and no second
// classification that can drift from the one that runs.

interface MountPlan {
  readonly mounted: readonly CapInfo[]
  readonly skipped: readonly { readonly cap: CapInfo; readonly reason: string }[]
}

function planMounts(caps: readonly CapInfo[], generatedRouters: ReadonlySet<string>): MountPlan {
  const mounted: CapInfo[] = []
  const skipped: { cap: CapInfo; reason: string }[] = []

  for (const cap of caps) {
    if (!generatedRouters.has(cap.camelName)) {
      skipped.push({
        cap,
        reason: 'no generated router (zero methods or skipped by router codegen)',
      })
      continue
    }
    if (LEGACY_SHAPE_SKIP.has(cap.capName)) {
      skipped.push({ cap, reason: 'legacy provider shape (task #195)' })
      continue
    }
    mounted.push(cap)
  }

  return { mounted, skipped }
}

/**
 * True when this cap's mount line is the COLLECTION resolver.
 *
 * `resolveCapMount` is the authority — except for a cap that declares
 * `mount: { kind: 'skip' }`. The runtime builder never mounts those at all
 * (`isBuilderMounted`), while this file still emits a line for every cap with
 * a generated router, and that line's VALUE is never called. Keeping their
 * mode-derived shape leaves four inert lines (`log-channels`, `login-method`,
 * `load-contribution`, `failure-contribution`) exactly as they are, so the
 * mount fix does not drag an unrelated inventory change along with it.
 */
function emitsCollectionMount(cap: CapInfo): boolean {
  return cap.emitsCollectionSelector
}

function emitMountLine(cap: CapInfo): string {
  const factory = `createCapRouter_${cap.camelName}`
  const capLiteral = `'${cap.capName}'`
  const key = cap.camelName
  // Use the inferred provider type as the registry call generic so the
  // codegen'd router's `getProvider(ctx) => InferProvider<typeof xCap>`
  // signature lines up without leaning on `CapabilityProviderMap` —
  // that map still types a handful of caps (decoder, pipeline-*,
  // addon-pages-source) with their legacy `I<X>` interface, and some
  // caps (smtp-provider, sso-bridge, user-passkeys) are missing from
  // it entirely. Going through the generic accessor sidesteps both.
  const inferredType = `InferProvider<typeof ${cap.exportName}>`

  if (cap.mountKind === 'device-native' || cap.mountKind === 'device-scoped') {
    // A per-device cap whose MODE is `collection` has several providers per
    // device — sources listed beside each other — and resolving one of them is
    // the defect `device-collection-dispatch.ts` was written to end: on a
    // collection cap `getProviderForDevice` answers with whichever addon
    // registered FIRST.
    //
    // `cap-router-runtime.ts` has branched on this since that module landed.
    // This generator never did, so every mount it emitted handed `videoclips`
    // to `requireDeviceScoped` and the runtime's branch was unreachable. The
    // operator's onboard clips paid for it: the same file answered "an
    // analytics visit has no file behind it" (the recorder) and then "was not
    // minted by the HomeKit source" (export-hap) depending on which addon had
    // been deployed last — two different wrong answers to one request, which
    // is what first-wins resolution looks like (measured 2026-09-21).
    if (cap.mode === 'collection') {
      return (
        `    ${key}: ${factory}(\n` +
        `      (_ctx) => requireDeviceCollection(reg, ${capLiteral}) as ${inferredType} | null,\n` +
        `      remoteCapProxy,\n` +
        `    ),`
      )
    }
    // Per-device mount — `device-native` (the provider IS the device) and
    // `device-scoped` (a device-scoped WRAPPER, resolved per device through
    // the D13 `getProviderForDevice`) share the one dispatcher.
    // `requireDeviceScoped` constrains its name arg
    // to `keyof CapabilityProviderMap`. A per-device cap that is NOT in the
    // map receives a cast (the cast was already present in the old allowlist
    // path and is preserved here for new caps).
    return (
      `    ${key}: ${factory}(\n` +
      `      (_ctx) => requireDeviceScoped(reg, ${capLiteral}) as ${inferredType} | null,\n` +
      `      remoteCapProxy,\n` +
      `    ),`
    )
  }

  if (emitsCollectionMount(cap)) {
    // Collection resolver with an optional `addonId` selector.
    //
    //  • `addonId` present → resolve THAT addon's provider directly via
    //    `getProviderByAddonId` (or `null` if it isn't registered here).
    //    This deliberately bypasses the enabled/disabled filter:
    //    `getCollectionEntries` drops disabled providers, so resolving a
    //    specific addonId through it would return `null` for a disabled
    //    provider — and `resolveProvider` then falls back to the default
    //    provider over the remote proxy, silently returning a DIFFERENT
    //    addon's data. An explicit addonId query must always hit that
    //    exact provider regardless of its collection enabled-state.
    //
    //  • `addonId` absent → for caps that declare array-output methods,
    //    return an AGGREGATE provider: every array-output method is
    //    `concatCollection`-fanned across all ENABLED providers and the
    //    results flattened; non-array methods fall through to the first
    //    provider. `getCollectionEntries` already filters disabled
    //    providers out, so the aggregate is exactly the enabled-only
    //    union. Caps with no array-output methods keep the prior
    //    first-provider behaviour.
    //
    // This generic aggregate replaces the hand-written `concatCollection`
    // overrides in trpc.router.ts. Routing beyond addonId / array union
    // (per-input-key dispatch, "first that supports") still belongs in
    // hand-written overrides (e.g. snapshotProvider).
    if (cap.arrayOutputMethods.length === 0) {
      return (
        `    ${key}: ${factory}(\n` +
        `      (_ctx, addonId) => {\n` +
        `        if (!reg) return null\n` +
        `        if (addonId !== undefined) {\n` +
        `          return reg.getProviderByAddonId<${inferredType}>(${capLiteral}, addonId)\n` +
        `        }\n` +
        `        const entries = reg.getCollectionEntries<${inferredType}>(${capLiteral})\n` +
        `        return entries[0]?.[1] ?? null\n` +
        `      },\n` +
        `      remoteCapProxy,\n` +
        `    ),`
      )
    }
    const aggregateEntries = cap.arrayOutputMethods
      .map((m) => `          ${m}: concatCollection(providers, '${m}') as ${inferredType}['${m}'],`)
      .join('\n')
    return (
      `    ${key}: ${factory}(\n` +
      `      (_ctx, addonId) => {\n` +
      `        if (!reg) return null\n` +
      `        if (addonId !== undefined) {\n` +
      `          return reg.getProviderByAddonId<${inferredType}>(${capLiteral}, addonId)\n` +
      `        }\n` +
      `        const entries = reg.getCollectionEntries<${inferredType}>(${capLiteral})\n` +
      `        if (entries.length === 0) return null\n` +
      `        const providers = entries.map(([, p]) => p)\n` +
      `        const first = providers[0]!\n` +
      `        return {\n` +
      `          ...first,\n` +
      aggregateEntries +
      '\n' +
      `        }\n` +
      `      },\n` +
      `      remoteCapProxy,\n` +
      `    ),`
    )
  }

  // Singleton (default) — also covers `mode: 'per-node'` placeholder.
  // Use the generic `getSingleton<T>` overload to sidestep the
  // `keyof CapabilityProviderMap` constraint on `requireSingleton`.
  return (
    `    ${key}: ${factory}(\n` +
    `      (_ctx) => reg?.getSingleton<${inferredType}>(${capLiteral}) ?? null,\n` +
    `      remoteCapProxy,\n` +
    `    ),`
  )
}

function readGeneratedRouterNames(): ReadonlySet<string> {
  if (!fs.existsSync(GENERATED_ROUTERS_FILE)) {
    throw new Error(
      `generated-cap-routers.ts not found at ${GENERATED_ROUTERS_FILE}. ` +
        `Run scripts/generate-cap-routers.ts first.`,
    )
  }
  const src = fs.readFileSync(GENERATED_ROUTERS_FILE, 'utf-8')
  const names = new Set<string>()
  const re = /export function createCapRouter_(\w+)\(/g
  let match: RegExpExecArray | null
  while ((match = re.exec(src)) !== null) {
    names.add(match[1]!)
  }
  return names
}

async function generate(): Promise<void> {
  const caps = await loadCapabilities()
  const generatedRouterNames = readGeneratedRouterNames()
  const { mounted, skipped } = planMounts(caps, generatedRouterNames)

  const skippedFactoryNames = new Set(skipped.map((s) => s.cap.camelName))
  const requiredFactories = mounted.map((c) => `createCapRouter_${c.camelName}`)
  // Every mounted cap's exportName (e.g. `decoderCapability`) — needed
  // for the `InferProvider<typeof xCap>` cast at each call site.
  const requiredCapExports = mounted.map((c) => c.exportName).sort()

  const skippedComment = skipped
    .slice()
    .sort((a, b) => a.cap.capName.localeCompare(b.cap.capName))
    .map((s) => ` *   - ${s.cap.capName} — ${s.reason}`)
    .join('\n')

  const mountLines = mounted.map(emitMountLine).join('\n')

  const lines: string[] = [
    '// AUTO-GENERATED by scripts/generate-cap-mounts.ts — DO NOT EDIT',
    '// Re-run: npx tsx scripts/generate-cap-mounts.ts',
    '//',
    `// Mounted: ${mounted.length}    Skipped (legacy): ${skipped.length}`,
    '',
    '/**',
    " * Single auto-mount entrypoint for every codegen'd cap router.",
    ' * Spread the result into the AppRouter assembly:',
    ' *',
    ' *   const router = trpcRouter({',
    ' *     ...mountAllCaps(t, services),',
    ' *     // … manual overrides + non-cap core routers below',
    ' *   })',
    ' *',
    ' * Override-by-spread: a manual `<capName>: createCapRouter_X(...)`',
    ' * entry placed AFTER the spread overrides the auto-mount, which is',
    ' * how service-backed caps (`system`, `nodes`, `integrations`,',
    ' * `addons`, `network-quality`, `toast`) get their non-registry',
    ' * providers wired without dropping out of the auto-mount inventory.',
    ' *',
    ' * Skipped caps (provider has non-canonical legacy shape — task #195):',
    skippedComment.length > 0
      ? skippedComment
      : ' *   (none — every cap with a generated router is mounted)',
    ' */',
    '',
    `import type { CapabilityRegistry } from '@camstack/system'`,
    `import type { InferProvider } from '@camstack/types'`,
    `import {`,
    ...requiredCapExports.map((n) => `  ${n},`),
    `} from '@camstack/types'`,
    `import type { MoleculerService } from '../../core/moleculer/moleculer.service.js'`,
    ...(mounted.some((c) => emitsCollectionMount(c) && c.arrayOutputMethods.length > 0)
      ? [`import { concatCollection, requireDeviceScoped } from './cap-mount-helpers.js'`]
      : [`import { requireDeviceScoped } from './cap-mount-helpers.js'`]),
    // The per-device COLLECTION twin — see the branch that emits it.
    `import { requireDeviceCollection } from './device-collection-dispatch.js'`,
    `import {`,
    ...requiredFactories.map((n) => `  ${n},`),
    `} from './generated-cap-routers.js'`,
    '',
    '/**',
    ' * Names of caps whose mount entry is OMITTED here because their',
    ' * provider implementation does not match the canonical',
    ' * `InferProvider<typeof xCap>` contract. Exported so the drift guard',
    ' * in `scripts/codegen.ts` can verify the union of {mounted, skipped}',
    ' * covers every `createCapRouter_X` in `generated-cap-routers.ts`.',
    ' */',
    'export const LEGACY_SHAPE_SKIP: ReadonlySet<string> = new Set<string>([',
    ...[...skippedFactoryNames].sort().map((n) => `  '${n}',`),
    '])',
    '',
    'export interface MountAllCapsServices {',
    '  readonly capabilityRegistry: CapabilityRegistry | null',
    '  readonly moleculer: MoleculerService',
    '}',
    '',
    '/**',
    ' * Build the auto-mount map. `services` carries the registry handle',
    ' * + Moleculer service so the per-cap remote-proxy factory can route',
    ' * cross-process calls when the incoming request carries `nodeId`.',
    ' */',
    'export function mountAllCaps(services: MountAllCapsServices) {',
    '  const reg = services.capabilityRegistry',
    "  // Cross-process cap routing: when a request carries a non-'hub'",
    '  // `nodeId` (DeviceProxy injects `entry.providerNodeId` for native',
    '  // device caps on forked workers) the cap-router calls this factory',
    '  // to materialise a Moleculer-bridged proxy. The factory return',
    '  // type is parametric — the runtime Proxy is structurally',
    '  // compatible with every `InferProvider<typeof cap>` shape so a',
    '  // single generic helper covers every mount. This is the one type',
    '  // boundary: a single assertion to the unconstrained `T`, never a',
    '  // double cast through `unknown`.',
    '  const remoteCapProxy = <T>(capName: string, nodeId: string): T | null =>',
    '    services.moleculer.createCapabilityProxy(capName, nodeId) as T | null',
    '  return {',
    mountLines,
    '  } as const',
    '}',
    '',
  ]

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true })
  writeIfChanged(OUTPUT_FILE, lines.join('\n'))

  // eslint-disable-next-line no-console
  console.log(`Mounted ${mounted.length} caps, skipped ${skipped.length} legacy caps`)
  if (skipped.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`[generate-cap-mounts] Skipped (legacy shape, task #195):`)
    for (const { cap, reason } of skipped) {
      // eslint-disable-next-line no-console
      console.error(`  - ${cap.capName}: ${reason}`)
    }
  }
  // eslint-disable-next-line no-console
  console.log(`Written to: ${path.relative(ROOT, OUTPUT_FILE)}`)
}

generate().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('generate-cap-mounts failed:', err)
  process.exit(1)
})
