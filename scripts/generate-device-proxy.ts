#!/usr/bin/env tsx
/**
 * Codegen: DeviceProxy v2 — facade over existing cap-routers.
 *
 * Scans packages/types/src/capabilities/*.cap.ts for `scope: 'device'` caps.
 * Emits two artifacts into packages/types/src/generated/device-proxy.ts:
 *   1. `interface DeviceProxy` — optional property per device-scoped cap.
 *   2. `createDeviceProxy(api, binding)` — factory that dispatches each method
 *      through `api.<capCamel>.<method>.(query|mutate)` with `deviceId` +
 *      `nodeId` pre-bound from the binding entry.
 *
 * Phase 5 (bindings dedup): the generated `DeviceProxy` interface also
 * exposes a public read-only `binding: DeviceBinding | null` field so a
 * SystemMirror that owns the binding cache can let consumers read straight
 * off the proxy instead of refetching. Populated post-construction by
 * `System.getDevice()` — `createDeviceProxy()` itself stays pure.
 *
 * Run manually: npx tsx scripts/generate-device-proxy.ts
 */

import * as fs from 'node:fs'
import { writeIfChanged } from './codegen-write.ts'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAllCaps } from './lib/parse-cap.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CAPS_DIR = path.join(ROOT, 'packages/types/src/capabilities')
const OUTPUT = path.join(ROOT, 'packages/types/src/generated/device-proxy.ts')
const LOCAL_STATE_OUTPUT = path.join(ROOT, 'packages/types/src/generated/device-local-state.ts')

async function main(): Promise<void> {
  const allCaps = parseAllCaps(CAPS_DIR)
  // Device-scoped caps: all methods exposed on the proxy (existing
  // behaviour, binding-conditional). System caps: filter to methods
  // with `deviceId` in input — those are the per-device slices of
  // cluster-wide singletons. Discard system caps that have no
  // device-bound methods (they don't need a proxy entry at all).
  const deviceCaps = allCaps
    .filter((c) => c.scope === 'device')
    .slice()
    .sort((a, b) => a.propertyName.localeCompare(b.propertyName))
  const systemCapsWithDeviceMethods = allCaps
    // `internal: true` caps are never mounted on the public AppRouter,
    // so a `device.<cap>.<method>()` call would fail at dispatch time.
    // Mirror the same filter `generate-system-proxy.ts` applies for
    // cluster-wide methods.
    .filter((c) => c.scope === 'system' && !c.internal && c.methods.some((m) => m.deviceBound))
    .map((c) => ({
      ...c,
      methods: c.methods.filter((m) => m.deviceBound),
    }))
    .sort((a, b) => a.propertyName.localeCompare(b.propertyName))
  const caps = [...deviceCaps, ...systemCapsWithDeviceMethods]

  console.log(`Found ${deviceCaps.length} device-scoped caps:`)
  for (const c of deviceCaps) {
    const rt = c.hasRuntimeState ? ' +runtimeState' : ''
    console.log(
      `  ${c.propertyName} (${c.capName})${rt} [${c.methods.map((m) => `${m.name}(${m.kind})`).join(', ')}]`,
    )
  }
  console.log(
    `\nFound ${systemCapsWithDeviceMethods.length} system caps with device-bound methods:`,
  )
  for (const c of systemCapsWithDeviceMethods) {
    console.log(
      `  ${c.propertyName} (${c.capName}) [${c.methods.map((m) => `${m.name}(${m.kind})`).join(', ')}]`,
    )
  }

  const stateCaps = deviceCaps.filter((c) => c.hasRuntimeState)
  console.log(`\nReactive state slots: ${stateCaps.length}`)

  const imports = caps
    .map((c) => `import type { ${c.exportName} } from '../capabilities/${c.fileName}'`)
    .join('\n')

  const deviceProxyFields = deviceCaps
    .map((c) => `  readonly ${c.propertyName}?: InferDeviceProxyCap<typeof ${c.exportName}>`)
    .join('\n')
  const systemProxyFields = systemCapsWithDeviceMethods
    .map((c) => {
      const union = c.methods.map((m) => `'${m.name}'`).join(' | ')
      return `  readonly ${c.propertyName}: Pick<InferDeviceProxyCap<typeof ${c.exportName}>, ${union}>`
    })
    .join('\n')
  const proxyFields = [deviceProxyFields, systemProxyFields].filter(Boolean).join('\n')

  const stateFieldDecls = stateCaps
    .map(
      (c) => `  readonly ${c.propertyName}: SliceHandle<InferRuntimeState<typeof ${c.exportName}>>`,
    )
    .join('\n')

  const stateFactoryEntries = stateCaps
    .map(
      (c) =>
        `      ${c.propertyName}: createSliceHandle<InferRuntimeState<typeof ${c.exportName}>>(stateSource, binding.deviceId, '${c.capName}'),`,
    )
    .join('\n')

  const factoryBlocks = caps
    .map((c) => {
      const isSystem = c.scope === 'system'
      const methodEntries = c.methods
        .map((m) => {
          const helper = isSystem ? 'dispatchSystem' : 'dispatch'
          const args = isSystem
            ? `'${c.propertyName}', '${m.name}', '${m.kind}'`
            : `'${c.capName}', '${c.propertyName}', '${m.name}', '${m.kind}'`
          if (m.kind === 'subscription') {
            return `    ${m.name}: (input?: unknown, push?: unknown) => ${helper}(${args}, input, push),`
          }
          return `    ${m.name}: (input?: unknown) => ${helper}(${args}, input),`
        })
        .join('\n')

      if (methodEntries.length === 0) {
        return `  const ${c.propertyName}Interface = {}`
      }
      return `  const ${c.propertyName}Interface = {
${methodEntries}
  }`
    })
    .join('\n\n')

  // Device-scoped caps are binding-conditional (omit when unbound so UI
  // gates like `dev.deviceAdminLink !== undefined` stay honest). System
  // caps with device-bound methods stay always-present — they are not
  // registered per-device in `binding.entries`.
  const deviceReturnFields = deviceCaps
    .map(
      (c) =>
        `    ...(bound('${c.capName}') ? { ${c.propertyName}: ${c.propertyName}Interface } : {}),`,
    )
    .join('\n')
  const systemReturnFields = systemCapsWithDeviceMethods
    .map((c) => `    ${c.propertyName}: ${c.propertyName}Interface,`)
    .join('\n')
  const returnFields = [deviceReturnFields, systemReturnFields].filter(Boolean).join('\n')

  const output = `// AUTO-GENERATED — do not edit manually.
// Regenerate with: npx tsx scripts/generate-device-proxy.ts
/* eslint-disable */

import type { InferDeviceProxyCap, InferRuntimeState } from '../capabilities/capability-definition.js'
import type { DeviceBinding } from '../device/device-binding.js'
import { createSliceHandle, createLazyTrpcSource, type SliceHandle, type SliceHandleSource } from '../device/device-state-handle.js'
import { addonSliceHandleApi } from '../helpers/addon-slice-handle.js'
import { invokeTrpcLeaf, type TrpcDispatchKind } from '../helpers/trpc-leaf.js'
import type { AddonApi } from './addon-api.js'
${imports}

/**
 * Reactive read handle bag for device runtime state. Each entry mirrors the
 * cap's \`runtimeState\` schema and stays live via the \`device-state\` cap's
 * \`onChanged\` event. See \`device-state-handle.ts\` for the contract.
 */
export interface DeviceProxyState {
${stateFieldDecls}
}

/**
 * Unified per-device proxy interface. Each optional property is present at
 * runtime only when the device's binding includes that capability.
 *
 * The optional \`binding\` field is populated post-construction by callers
 * that own a binding cache (e.g. the SDK's \`System\` mirror). Consumers
 * that need the full per-device binding map can read it from there
 * without paying for a second \`getBindings\` round-trip — see Phase 5
 * dedup notes in \`scripts/generate-device-proxy.ts\`.
 */
export interface DeviceProxy {
  readonly deviceId: number
  /** Reactive runtime state, one slot per cap that declares \`runtimeState\`. */
  readonly state: DeviceProxyState
  /** Resolved binding entry list (or null if the proxy was constructed
   *  without a cache-aware caller — defaults to null since
   *  \`createDeviceProxy\` itself does not own the binding). */
  readonly binding: DeviceBinding | null
${proxyFields}
}

/**
 * Build a DeviceProxy that pre-binds deviceId + nodeId on every method call
 * and dispatches through the existing cap-router tRPC procedures.
 *
 * Optional \`opts.stateSource\` lets a SystemManager pass a shared mirror
 * source so every device proxy reads from the same in-memory map and
 * shares the warm-boot/push-event update loop. When omitted, a per-proxy
 * lazy tRPC source is created — the path used by \`ctx.fetchDevice\` and
 * \`BackendClient.fetchDevice\` for one-off reads.
 *
 * The returned proxy's \`binding\` field is set to the input \`binding\`
 * by default — callers that want to expose a different value (e.g. the
 * SDK's \`System\` patches it from a shared cache) can overwrite the
 * field on the returned object.
 */
export function createDeviceProxy(
  api: AddonApi,
  binding: DeviceBinding,
  opts?: { stateSource?: SliceHandleSource },
): DeviceProxy {
  // Default lazy source: builds its own cache + bridge on first watch().
  // The SystemManager passes a shared mirror source instead.
  const stateSource: SliceHandleSource = opts?.stateSource
    ?? createLazyTrpcSource(addonSliceHandleApi(api))

  // ── Dispatch helpers ────────────────────────────────────────────────
  //
  // Every per-cap method below collapses to a single \`dispatch(...)\` /
  // \`dispatchSystem(...)\` call. The helpers handle three concerns
  // uniformly so the per-method code reads as a one-line declaration of
  // intent (cap + method + kind) rather than 25 lines of plumbing.
  type Kind = TrpcDispatchKind

  /** Merge \`{deviceId, nodeId?}\` into the caller-supplied input. */
  function mergeInput(input: unknown, nodeId: string | undefined): Record<string, unknown> {
    const base = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
    return nodeId !== undefined
      ? { ...base, deviceId: binding.deviceId, nodeId }
      : { ...base, deviceId: binding.deviceId }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function callLeaf(capProp: string, method: string, kind: Kind, merged: unknown, push: unknown): any {
    return invokeTrpcLeaf(api, capProp, method, kind, merged, push)
  }

  /**
   * Device-scoped cap dispatch. Looks up the binding entry for \`capName\`
   * to pin the call to the worker that owns the per-device provider; when
   * no entry exists (cluster-wide singletons like \`zones\` /
   * \`zone-rules\` / \`audio-metrics\` that don't register per-device
   * natives), nodeId is omitted and the cap-router's \`resolveProvider\`
   * falls through to the local provider — a Moleculer bridge proxy when
   * the actual singleton lives in a worker.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function dispatch(capName: string, capProp: string, method: string, kind: Kind, input?: unknown, push?: unknown): any {
    const entry = binding.entries.find((e) => e.capName === capName)
    return callLeaf(capProp, method, kind, mergeInput(input, entry?.providerNodeId), push)
  }

  /**
   * System-cap dispatch. No binding gate — system caps are cluster-wide
   * singletons; the nodeId is left absent so caps that load-balance (e.g.
   * \`pipeline-runner\`) can resolve their own target node.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function dispatchSystem(capProp: string, method: string, kind: Kind, input?: unknown, push?: unknown): any {
    return callLeaf(capProp, method, kind, mergeInput(input, undefined), push)
  }

  /** True when this device's binding lists the cap — gates device-scoped handles. */
  function bound(capName: string): boolean {
    return binding.entries.some((e) => e.capName === capName)
  }

${factoryBlocks}

  return {
    deviceId: binding.deviceId,
    binding,
    state: {
${stateFactoryEntries}
    },
${returnFields}
  }
}
`
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
  writeIfChanged(OUTPUT, output)
  console.log(`\nGenerated: ${OUTPUT}`)

  // ── Server-side write proxy: DeviceLocalState ──────────────────────
  //
  // Companion file to the cross-process DeviceProxyState above. This one
  // is for IN-PROCESS drivers (anything extending BaseDevice) — each
  // entry is the cap's full `runtimeState` shape with field-level
  // read/write semantics (BaseDevice.state[capName] returns a Proxy
  // built from `sliceProxy(<capDef>)`). Adding a new cap with
  // `runtimeState:` automatically gives every BaseDevice subclass a
  // typed `this.state.<newCap>` accessor — drivers don't have to
  // declare anything.
  const localStateImports = stateCaps
    .map((c) => `import { ${c.exportName} } from '../capabilities/${c.fileName}'`)
    .join('\n')
  const localStateFieldDecls = stateCaps
    .map((c) => `  ${c.propertyName}: InferRuntimeState<typeof ${c.exportName}>`)
    .join('\n')
  const localStateRegistry = stateCaps
    .map((c) => `  ${c.propertyName}: ${c.exportName},`)
    .join('\n')
  const capNameMapEntries = stateCaps
    .map((c) => `  '${c.capName}': InferRuntimeState<typeof ${c.exportName}>`)
    .join('\n')

  const localStateOutput = `// AUTO-GENERATED — do not edit manually.
// Regenerate with: npx tsx scripts/generate-device-proxy.ts
/* eslint-disable */

import type { CapabilityDefinition, InferRuntimeState } from '../capabilities/capability-definition.js'
${localStateImports}

/**
 * Server-side, write-capable per-cap state shape for any device that
 * extends \`BaseDevice\`. One entry per cap with \`runtimeState:\` declared.
 *
 * Drivers access via \`this.state.<capName>.<field>\` — both reads and
 * writes route through the device's runtime-state slice (validate,
 * persist, fire \`<cap>.onChanged\`). No string keys, no manual generic.
 *
 * Adding a new cap with \`runtimeState:\` auto-extends this interface —
 * regenerate with \`npm run codegen\`.
 */
export interface DeviceLocalState {
${localStateFieldDecls}
}

/**
 * Runtime registry: cap-property-name → cap definition. \`BaseDevice\`'s
 * \`state\` getter looks up the cap definition here to construct a
 * \`sliceProxy()\` lazily on first access. Generated alongside the type
 * so type and runtime registry can never drift apart.
 */
export const DEVICE_LOCAL_STATE_CAPS: Record<keyof DeviceLocalState, CapabilityDefinition> = {
${localStateRegistry}
}

/**
 * Cap-name keyed runtime-state map (kebab-case keys, e.g. \`'battery'\`,
 * \`'device-discovery'\`). Companion to \`DeviceLocalState\` (which uses
 * camelCase property keys). Consumed by the
 * \`IDeviceRuntimeState.getCapState\` overload so callers passing a
 * cap-name literal get the typed slice back without an explicit
 * generic argument:
 *
 *   const slice = this.runtimeState.getCapState('battery')
 *   //    ^^^^^ inferred as InferRuntimeState<typeof batteryCapability>
 *
 * Eliminates the \`as\`-cast at every \`getCapState<X>('cap-name')\` site.
 */
export interface CapNameToRuntimeStateMap {
${capNameMapEntries}
}
`
  writeIfChanged(LOCAL_STATE_OUTPUT, localStateOutput)
  console.log(`Generated: ${LOCAL_STATE_OUTPUT}`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
