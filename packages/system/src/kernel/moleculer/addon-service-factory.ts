import type { ServiceSchema, Context } from 'moleculer'
import type { ICamstackAddon, AddonDeclaration } from '@camstack/types'
import { deserializeTypedArrays } from './typed-array-serde.js'
import { capBareAction } from '../transport/cap-action-name.js'

/**
 * Validate that every capability declared in the addon manifest has a
 * provider registered via context.registerProvider() during initialize().
 *
 * Call after addon.initialize() to catch missing registrations at boot time
 * instead of at runtime when a consumer tries to use the capability.
 */
function validateProviderRegistrations(
  addonId: string,
  declaration: AddonDeclaration,
  providers: ReadonlyMap<string, unknown>,
  logger?: {
    warn: (msg: string) => void
    debug?: (msg: string) => void
    info?: (msg: string) => void
  },
): readonly string[] {
  const missing: string[] = []
  for (const cap of declaration.capabilities ?? []) {
    const capName = typeof cap === 'string' ? cap : cap.name
    const isOptional = typeof cap !== 'string' && 'optional' in cap && cap.optional === true
    if (!providers.has(capName)) {
      if (isOptional) {
        const emit = logger?.debug ?? logger?.info ?? logger?.warn
        if (emit)
          emit.call(
            logger,
            `Addon "${addonId}" skipped optional capability "${capName}" — no provider registered`,
          )
        continue
      }
      const msg = `Addon "${addonId}" declares capability "${capName}" but never called registerProvider("${capName}", ...) during initialize()`
      missing.push(capName)
      if (logger) logger.warn(msg)
    }
  }
  return missing
}

/**
 * Optional resolver that returns method names for a capability.
 * Used by the hub to resolve methods from CapabilityDefinitions (*.cap.ts)
 * when the package.json declaration doesn't include explicit methods.
 */
type MethodResolver = (capabilityName: string) => readonly string[]

interface CapabilityMethodDeclaration {
  readonly name: string
  readonly methods?: readonly string[]
}

function normalizeCapability(
  cap: string | CapabilityMethodDeclaration | { readonly name: string },
): CapabilityMethodDeclaration {
  if (typeof cap === 'string') return { name: cap, methods: [] }
  return {
    name: cap.name,
    methods: 'methods' in cap ? (cap as CapabilityMethodDeclaration).methods : [],
  }
}

/**
 * Wrap an ICamstackAddon as a Moleculer ServiceSchema.
 *
 * Methods for each capability are resolved in this order:
 * 1. `declaration.capabilities[].methods` from package.json
 * 2. `methodResolver(capName)` from CapabilityRegistry definitions
 * 3. Auto-discovery: enumerate own methods on the registered provider
 *
 * Additionally, the four two-level settings methods (`getGlobalSettings`,
 * `updateGlobalSettings`, `getDeviceSettings`, `updateDeviceSettings`)
 * are auto-exposed under a
 * `settings.*` namespace if the addon implements them. This replaces the
 * former `$addonHost` Moleculer service — the hub's `addon-settings`
 * singleton provider calls `broker.call('<addonId>.settings.<method>')`.
 */
function createAddonService(
  addon: ICamstackAddon,
  declaration: AddonDeclaration,
  options?: {
    readonly methodResolver?: MethodResolver
    /** Per-action Moleculer timeout override: (capName, methodName) → ms */
    readonly timeoutResolver?: (capName: string, methodName: string) => number | undefined
    readonly providers?: ReadonlyMap<string, unknown>
    /**
     * Custom action catalog declared via `onInitialize()`'s `customActions`
     * field. The service exposes them as `custom.<actionName>` moleculer
     * actions + advertises their names via metadata so the hub can proxy
     * dispatches into the worker when the addon runs forkable.
     */
    readonly customActions?: Readonly<Record<string, unknown>>
    readonly actionHandlers?: Readonly<
      Record<string, (input: unknown) => unknown | Promise<unknown>>
    >
  },
): ServiceSchema {
  const declaredCaps = (declaration.capabilities ?? []).map(normalizeCapability)
  const methodResolver = options?.methodResolver
  const timeoutResolver = options?.timeoutResolver
  const providers = options?.providers

  const actions: Record<string, { handler: (ctx: Context) => Promise<unknown>; timeout?: number }> =
    {}

  // Build the working set of caps to expose:
  //   1. Every capability declared in the addon's package.json manifest
  //      (carries any explicit `methods: [...]` override the operator
  //      pinned for that cap).
  //   2. PLUS every capability registered at runtime via
  //      `context.registerProvider()` or returned from `initialize()`
  //      that is NOT also declared. Without this, runtime-registered
  //      caps (e.g. device-manager registers `device-state` from its
  //      initialize() return list, pipeline-orchestrator registers
  //      `zones` and `zone-rules`, advanced-notifier registers
  //      `notification-output`, etc.) get NO Moleculer action exposed.
  //      Cross-process callers reaching them via brokerTransportLink
  //      then hang forever on `awaitServiceCandidates` because no
  //      service in the cluster advertises `*.<runtime-cap>.<method>`.
  //      The Reolink worker hitting `device-state.setCapSlice` was the
  //      first symptom of this gap (BaseDevice writer fires constantly);
  //      every other addon following the same pattern would hang on its
  //      first cross-process call to its runtime-registered cap.
  interface CapToExpose {
    readonly name: string
    readonly methods?: readonly string[]
  }
  const capsToExpose: CapToExpose[] = [...declaredCaps]
  if (providers) {
    const declaredNames = new Set(declaredCaps.map((c) => c.name))
    for (const capName of providers.keys()) {
      if (!declaredNames.has(capName)) capsToExpose.push({ name: capName })
    }
  }

  for (const cap of capsToExpose) {
    let methods: readonly string[] = cap.methods ?? []

    // If no methods in declaration, try the resolver (CapabilityDefinition)
    if (methods.length === 0 && methodResolver) {
      methods = methodResolver(cap.name)
    }

    // If still no methods, auto-discover from the registered provider
    if (methods.length === 0) {
      const provider = providers?.get(cap.name)
      if (provider && typeof provider === 'object') {
        methods = discoverProviderMethods(provider)
      }
    }

    for (const method of methods) {
      const actionName = capBareAction(cap.name, method)
      const timeoutMs = timeoutResolver?.(cap.name, method)
      const handler = async (ctx: Context) => {
        const provider = providers?.get(cap.name)
        if (!provider || typeof provider !== 'object') {
          throw new Error(`No provider registered for capability "${cap.name}"`)
        }
        const fn = (provider as Record<string, unknown>)[method]
        if (typeof fn !== 'function') {
          throw new Error(`Method "${method}" not found on provider "${cap.name}"`)
        }
        // Moleculer normalizes undefined params to {} — treat empty objects as undefined
        // so void-input methods don't receive a spurious empty object.
        const raw = deserializeTypedArrays(ctx.params)
        const params =
          raw !== null && typeof raw === 'object' && Object.keys(raw as object).length === 0
            ? undefined
            : raw
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- fn.call returns `any`; widened to `unknown` at action boundary
        return fn.call(provider, params)
      }
      actions[actionName] = timeoutMs !== undefined ? { timeout: timeoutMs, handler } : { handler }
    }
  }

  // ── Auto-expose three-level settings actions ──────────────────────
  //
  // Every addon that implements the settings methods on ICamstackAddon
  // gets them exposed under a `settings.*` namespace so the hub's
  // addon-settings singleton provider can call them on remote nodes via
  // `broker.call('<addonId>.settings.<method>', params, { nodeID })`.
  //
  // Replaces the former `$addonHost` Moleculer service.
  addSettingsActions(addon, actions)

  // ── Custom actions ────────────────────────────────────────────────
  //
  // Expose each custom action as `custom.<actionName>`. The hub owns the
  // `CustomActionRegistry` and validates input/output against the addon
  // module's static catalog (same as in-process addons). This moleculer
  // action is just the transport endpoint the hub's registry handler
  // calls via `broker.call('<addonId>.custom.<action>')`.
  const handlers = options?.actionHandlers
  const customActions = options?.customActions
  if (handlers && customActions) {
    for (const actionName of Object.keys(handlers)) {
      const handler = handlers[actionName]!
      const spec = customActions[actionName]
      actions[`custom.${actionName}`] = {
        handler: async (ctx: Context) => {
          const raw = deserializeTypedArrays(ctx.params)
          const params =
            raw !== null && typeof raw === 'object' && Object.keys(raw as object).length === 0
              ? undefined
              : raw
          // Re-validate here too so a direct broker.call (bypassing the
          // hub's registry) still enforces the zod contract. The hub
          // validates on the way in; this guards remote calls and tests.
          const specRec = spec as
            | { input?: { parse(v: unknown): unknown }; output?: { parse(v: unknown): unknown } }
            | undefined
          const parsedInput = specRec?.input?.parse(params) ?? params
          const result = await handler(parsedInput)
          return specRec?.output?.parse(result) ?? result
        },
      }
    }
  }

  // Metadata.capabilities drives the hub's CapabilityBridge — the bridge
  // walks every connected node's services, reads `metadata.capabilities`,
  // and registers a proxy on the hub registry for each one. If a runtime-
  // registered cap is missing here, cross-process consumers reach the
  // Moleculer action successfully (because we exposed it above) but the
  // hub's `requireSingleton(cap)` returns null — so the per-cap tRPC
  // router throws PRECONDITION_FAILED for any UI/API caller. Including
  // every cap with an exposed action keeps the bridge honest.
  const declaredCapNames = new Set(declaredCaps.map((c) => c.name))
  const metadataCaps = [
    ...(declaration.capabilities ?? []),
    ...capsToExpose.filter((c) => !declaredCapNames.has(c.name)).map((c) => ({ name: c.name })),
  ]

  return {
    name: declaration.id,
    metadata: {
      addonId: declaration.id,
      capabilities: metadataCaps,
    },
    actions,
  }
}

/**
 * Auto-discover callable methods on a provider instance.
 * Excludes common lifecycle/internal methods.
 */
function discoverProviderMethods(provider: unknown): readonly string[] {
  if (!provider || typeof provider !== 'object') return []
  const skip = new Set(['constructor', 'initialize', 'shutdown', 'startSampling', 'stopSampling'])
  const methods: string[] = []

  // Own properties
  for (const key of Object.getOwnPropertyNames(provider)) {
    if (skip.has(key) || key.startsWith('_')) continue
    if (typeof (provider as Record<string, unknown>)[key] === 'function') {
      methods.push(key)
    }
  }

  // Prototype methods
  const proto = Object.getPrototypeOf(provider) as Record<string, unknown> | null
  if (proto && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (skip.has(key) || key.startsWith('_') || methods.includes(key)) continue
      if (typeof proto[key] === 'function') {
        methods.push(key)
      }
    }
  }

  return methods
}

// ── Settings actions — replaces `$addonHost` Moleculer service ──────

/** The four two-level settings method names on ICamstackAddon. */
const SETTINGS_GETTERS = ['getGlobalSettings', 'getDeviceSettings'] as const
const SETTINGS_UPDATERS = ['updateGlobalSettings', 'updateDeviceSettings'] as const

/**
 * Params shape for settings actions. Getters receive an empty object (or
 * `{ deviceId }` for device-level). Updaters receive `{ patch }` (or
 * `{ deviceId, patch }` for device-level).
 */
interface SettingsGetParams {
  readonly deviceId?: number
}
interface SettingsUpdateParams {
  readonly patch: Record<string, unknown>
  readonly deviceId?: number
}

/**
 * Add `settings.getGlobalSettings`, `settings.updateGlobalSettings`, etc.
 * to the actions map for any addon that implements the corresponding
 * method on `ICamstackAddon`.
 *
 * Getter actions return `ConfigUISchemaWithValues | null`.
 * Updater actions return `{ success: true }` or throw.
 */
function addSettingsActions(
  addon: ICamstackAddon,
  actions: Record<string, { handler: (ctx: Context) => Promise<unknown> }>,
): void {
  // Getters: getGlobalSettings, getDeviceSettings
  for (const methodName of SETTINGS_GETTERS) {
    const fn = addon[methodName]
    if (typeof fn !== 'function') continue

    actions[`settings.${methodName}`] = {
      handler: async (ctx: Context): Promise<unknown> => {
        const params = (ctx.params ?? {}) as SettingsGetParams
        if (methodName === 'getDeviceSettings') {
          const deviceId = params.deviceId
          if (typeof deviceId !== 'number')
            throw new Error(`settings.${methodName}: numeric deviceId is required`)
          const result: unknown = await addon.getDeviceSettings!(deviceId)
          return result ?? null
        }
        // `getGlobalSettings` optionally accepts a preview `overlay` that
        // the schema hydrator merges on top of the persisted store.
        // Override-mode UIs pass it so cascade selects re-derive options
        // without touching the store.
        const overlay = (params as { overlay?: Record<string, unknown> }).overlay
        const result: unknown = await (
          addon[methodName] as (o?: Record<string, unknown>) => Promise<unknown>
        )(overlay)
        return result ?? null
      },
    }
  }

  // Updaters: updateGlobalSettings, updateDeviceSettings
  for (const methodName of SETTINGS_UPDATERS) {
    const fn = addon[methodName]
    if (typeof fn !== 'function') continue

    actions[`settings.${methodName}`] = {
      handler: async (ctx: Context): Promise<unknown> => {
        const params = (ctx.params ?? {}) as SettingsUpdateParams
        const patch = params.patch ?? {}
        if (methodName === 'updateDeviceSettings') {
          const deviceId = params.deviceId
          if (typeof deviceId !== 'number')
            throw new Error(`settings.${methodName}: numeric deviceId is required`)
          await addon.updateDeviceSettings!(deviceId, patch)
          return { success: true as const }
        }
        await (addon[methodName] as (p: Record<string, unknown>) => Promise<void>)(patch)
        return { success: true as const }
      },
    }
  }
}

export { createAddonService, validateProviderRegistrations }
