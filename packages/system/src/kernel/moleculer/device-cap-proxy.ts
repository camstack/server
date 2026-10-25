// packages/kernel/src/moleculer/device-cap-proxy.ts
//
// Merged from device-manager-api.ts + native-cap-bridge.ts.
//
// Two concerns that were split across two files but share the same
// data (`workerNativeCaps`, `NATIVE_PROVIDER_SERVICE_INFIX`) and solve
// the same problem (routing per-device native capability calls between
// hub and forked workers):
//
//   - Worker side: `createBrokerDeviceManagerApi` builds the DeviceManagerApi
//     used by addon workers. `mountNativeCapService` registers the Moleculer
//     service that the hub calls into. `workerNativeCaps` is the shared store.
//
//   - Hub side: `buildNativeCapProxy` builds the broker.call-based proxy that
//     hub consumers use to reach a worker's native provider.
//
// Keeping them together eliminates the import cycle
// (native-cap-bridge → device-manager-api) and makes the data flow
// between the two sides readable in one place.

import { randomUUID } from 'node:crypto'
import type {
  AddonApi,
  CapabilityDefinition,
  DeviceConstructor,
  DeviceContext,
  DeviceManagerApi,
  DeviceProxy,
  ICameraDevice,
  IDevice,
  IEventBus,
  IKernelStreamProbe,
  InferNativeProvider,
  InferProvider,
  IScopedLogger,
} from '@camstack/types'
import {
  addonSliceHandleApi,
  BOOT_RECOVERY_BACKOFF_MS,
  createDeviceProxy,
  createEventBusSliceSource,
  DeviceType,
  deviceOpsCapability,
  collectZodSecretPaths,
  EventCategory,
  emitReadiness,
  expandCapMethods,
  sleep,
} from '@camstack/types/addon'
import type { ServiceBroker } from 'moleculer'
import {
  createChildrenBatchLoader,
  parseChildRows,
  parseChildrenByParent,
} from './children-batch-loader.js'
import type { CapabilityRegistry } from '../capability-registry.js'
import type { DeviceRegistry } from '../device-registry.js'
import { capServiceName } from '../transport/cap-action-name.js'
import { AccessoryShrinkGate, classifyAccessoryRead } from './accessory-prune-gate.js'
import { loadRuntimeStateOrRefuse, type RuntimeStateLoadPhase } from './runtime-state-load.js'

// Re-export NATIVE_PROVIDER_SERVICE_INFIX so existing importers of this module
// (packages/kernel/src/index.ts, packages/kernel/src/transport/cap-route-resolver.ts)
// continue to resolve without changes.
export { NATIVE_PROVIDER_SERVICE_INFIX } from '../transport/cap-action-name.js'

/**
 * Max number of accessory children spawned concurrently during a single
 * Phase 4b reconcile pass. A many-entity container (e.g. a ~200-entity Home
 * Assistant device) previously spawned its children strictly sequentially —
 * each child making several `device-manager` round-trips — which serialised
 * into minutes. Spawning with a bounded fan-out overlaps those round-trips
 * while keeping the in-flight count low enough to avoid swamping the
 * device-manager's settings write-lock. Id allocation stays correct under
 * concurrency: `device-manager.allocateDeviceId` serialises every
 * read-modify-write of the id counter behind its own write-lock, so distinct
 * stableIds always receive distinct ids regardless of fan-out.
 */
const ACCESSORY_SPAWN_CONCURRENCY = 12

/**
 * Run `worker` over every item with at most `limit` concurrent invocations.
 * Each item is processed independently — `worker` is responsible for its own
 * error handling (a rejected worker rejects the returned promise). Resolves
 * once every item has been processed. No external dependency: a small pool of
 * `limit` runners pulls from a shared cursor.
 */
async function runBounded<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const effectiveLimit = Math.max(1, Math.min(limit, items.length))
  let cursor = 0
  const runners: Promise<void>[] = []
  for (let i = 0; i < effectiveLimit; i++) {
    runners.push(
      (async () => {
        while (true) {
          const index = cursor
          cursor += 1
          if (index >= items.length) return
          await worker(items[index]!)
        }
      })(),
    )
  }
  await Promise.all(runners)
}

export interface WorkerDeviceManagerOptions {
  readonly api: AddonApi
  readonly addonId: string
  readonly nodeId: string
  readonly logger: IScopedLogger
  readonly eventBus: IEventBus
  readonly registry: DeviceRegistry
  readonly capabilityRegistry?: CapabilityRegistry
  readonly broker?: ServiceBroker
  /**
   * UDS-only forked child (Phase F1+F2): no `capabilityRegistry`, no
   * `broker`. `registerNativeCap` populates the per-process `workerNativeCaps`
   * map (read by the UDS dispatch in `addon-runner`) but mounts NO Moleculer
   * `<addon>.native-provider.*` service — the child has no broker.
   */
  readonly udsMode?: boolean
  readonly streamProbe?: IKernelStreamProbe
}

function toPlainRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    out[key] = Reflect.get(value, key)
  }
  return out
}

// ── Worker-side state ────────────────────────────────────────────────

/** Per-process worker native-cap store. capName → deviceId (numeric) → provider */
const workerNativeCaps = new Map<string, Map<number, unknown>>()

/**
 * Parallel addonId tracking for native caps. capName → deviceId → addonId.
 * Populated alongside `workerNativeCaps` so `getWorkerNativeCapSnapshot()`
 * can include the registering addonId in the handshake payload — used by
 * the hub's `HubNodeRegistry` to resolve cross-process proxy targets without
 * the pull-based discovery sweep.
 */
const workerNativeCapAddonIds = new Map<string, Map<number, string>>()

const mountedNativeCapServices = new Set<string>()

/**
 * Optional change listener fired whenever the worker native-cap set mutates
 * (a `registerNativeCap` adds a (cap, device) pair, or a device is cleared).
 *
 * WHY: device-scoped native caps register lazily as devices come online —
 * for async providers (e.g. Reolink Baichuan discovery) that can land WELL
 * AFTER the runner's `post-init` cap handshake. Without a notification the
 * UDS child never re-sends its descriptor set, so the hub's
 * `LocalChildRegistry` never learns the new (cap, deviceId) binding →
 * `CapRouteResolver.resolveChildId` returns null → cross-process callers
 * (e.g. the stream-broker pulling `stream-catalog`) fall through to the F0
 * Moleculer fallback and hang on service discovery forever. The runner
 * subscribes here and re-runs its `updateCaps` handshake (debounced) so a
 * late registration becomes routable promptly. Single listener — the runner
 * is the only subscriber.
 */
let onWorkerNativeCapsChanged: (() => void) | null = null

/** Subscribe to worker native-cap set changes. Pass null to clear. */
export function setWorkerNativeCapsChangeListener(listener: (() => void) | null): void {
  onWorkerNativeCapsChanged = listener
}

const nativeCapReadinessGeneration: string =
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 14)

// ── Worker-side: mount Moleculer service ─────────────────────────────

/**
 * Mount the Moleculer service exposing `<addonId>.native-provider.<capName>`
 * with per-method actions that dispatch to `workerNativeCaps`. Called
 * lazily on first `registerNativeCap` AND proactively at worker boot for
 * always-on caps (e.g. `device-ops`) so the INFO packet sent at TCP
 * connect already advertises the service.
 */
export function mountNativeCapService<TCap extends CapabilityDefinition>(
  broker: ServiceBroker,
  addonId: string,
  cap: TCap,
): void {
  const serviceName = capServiceName(addonId, cap.name, true)
  if (mountedNativeCapServices.has(serviceName)) return
  // Expand the declared `cap.methods` with the auto-injected surface —
  // `getStatus` (when the cap has a `status` block) and the three
  // device-settings methods (when `exposesDeviceSettings`). Iterating
  // bare `cap.methods` here was the cause of cross-process `getStatus`
  // hanging forever: the action was never mounted, so the hub-side
  // `buildNativeCapProxy` retried "service not found" indefinitely via
  // `callWithServiceDiscoveryRetry`. The cap def stays the single
  // source of truth — same expansion the codegen routers + the
  // `CapabilityBridge` proxy use.
  const expandedMethods: Record<string, unknown> | undefined = expandCapMethods(cap)
  if (
    expandedMethods === undefined ||
    Object.keys(expandedMethods).length === 0 ||
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    typeof broker.createService !== 'function'
  ) {
    mountedNativeCapServices.add(serviceName)
    return
  }
  const actions: Record<
    string,
    {
      handler: (ctx: { params?: unknown }) => Promise<unknown>
    }
  > = {}
  for (const methodName of Object.keys(expandedMethods)) {
    const handler = async (ctx: { params?: unknown }): Promise<unknown> => {
      const input = (ctx.params ?? {}) as { deviceId?: number }
      const deviceId = input.deviceId
      if (typeof deviceId !== 'number' || !Number.isFinite(deviceId)) {
        throw new Error(
          `native-provider: call to '${cap.name}.${methodName}' missing numeric 'deviceId' in input`,
        )
      }
      const provider = workerNativeCaps.get(cap.name)?.get(deviceId) as
        | Record<string, unknown>
        | undefined
      if (!provider) {
        throw new Error(`native-provider: no provider for '${cap.name}' on device '${deviceId}'`)
      }
      const fn = provider[methodName]
      if (typeof fn !== 'function') {
        throw new Error(`native-provider: method '${methodName}' not found on '${cap.name}'`)
      }
      return (fn as (i: unknown) => unknown).call(provider, input)
    }
    // Bare method action — `buildNativeCapProxy` calls
    // `${addonId}.native-provider.${capName}.${method}` (the legacy
    // path retained for cross-process native-cap dispatch).
    actions[methodName] = { handler }
    // Bridge-discoverable aliased action — `CapabilityBridge` builds
    // forwarding paths as `${service.name}.${capName}.${method}` for
    // any service whose metadata.capabilities advertises the cap. We
    // expose the same handler under that prefix so the cap router
    // (`findCallFn`) can resolve cross-process native caps via the
    // standard path used by every other cap.
    actions[`${cap.name}.${methodName}`] = { handler }
  }
  // Discovery action — returns the deviceIds this worker hosts for this
  // cap. Hub-side device-manager calls this on `$node.connected` to
  // rebuild `remoteNativeCaps` after worker restart, when the original
  // `DeviceBindingsChanged` broadcasts may have been lost mid-handshake.
  actions['$listDeviceIds'] = {
    handler: async (): Promise<readonly number[]> => {
      const perCap = workerNativeCaps.get(cap.name)
      if (!perCap) return []
      return [...perCap.keys()]
    },
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    broker.createService({
      name: serviceName,
      metadata: {
        // Use a synthetic addonId so the `CapabilityBridge`'s
        // already-discovered dedup (`nodeAddons[nodeId].has(addonId)`)
        // doesn't skip this service in favour of the main addon
        // service. The hub-side proxy only looks at the cap name +
        // nodeId — never the addonId — so a synthetic value is safe.
        addonId: `${addonId}::native-${cap.name}`,
        nativeProviderCap: cap.name,
        // Advertise the cap so the bridge installs a callFn under
        // `nodeCallFns['<nodeId>::<capName>']`. Without this the
        // cap-router's `findCallFn` returns null and singleton-style
        // resolution throws "not available on node" even though the
        // worker-registered native provider exists. Methods reach the
        // aliased actions above.
        capabilities: [{ name: cap.name }],
      },
      actions,
    })
    mountedNativeCapServices.add(serviceName)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('already')) {
      mountedNativeCapServices.add(serviceName)
      return
    }
    throw err
  }
}

export function getWorkerNativeCap(capName: string, deviceId: number): unknown | null {
  return workerNativeCaps.get(capName)?.get(deviceId) ?? null
}

export function clearWorkerNativeCapsForDevice(deviceId: number): void {
  for (const perCap of workerNativeCaps.values()) perCap.delete(deviceId)
  for (const perCap of workerNativeCapAddonIds.values()) perCap.delete(deviceId)
  // A removed device retracts its native-cap bindings — notify so the runner
  // re-sends the (now smaller) descriptor set to the parent registry.
  onWorkerNativeCapsChanged?.()
}

export function getWorkerNativeCapNames(): readonly string[] {
  return [...workerNativeCaps.keys()]
}

/**
 * Snapshot of every device-scoped native cap this worker hosts, with the
 * device ids and registering addonId for each. Used by the D3 registration
 * handshake (`process-runner`/`group-runner` → `$hub.registerNode`'s
 * `nativeCaps` field) so the hub's `HubNodeRegistry` learns device-scoped
 * native caps (including addonId) without the pull-based discovery sweep.
 *
 * Groups by `(capName, addonId)` because different addons in the same group
 * may register the same cap for different devices — each such pair becomes
 * its own entry so the hub can build the correct Moleculer proxy target.
 */
export function getWorkerNativeCapSnapshot(): ReadonlyArray<{
  readonly capName: string
  readonly addonId: string
  readonly deviceIds: readonly number[]
}> {
  // Build a `(capName, addonId) → deviceIds[]` map so that multiple addons
  // in the same group-runner process that register the same cap for different
  // devices each get their own entry (correct proxy routing on the hub side).
  const grouped = new Map<string, { capName: string; addonId: string; deviceIds: number[] }>()
  for (const [capName, devMap] of workerNativeCaps) {
    const addonIdMap = workerNativeCapAddonIds.get(capName)
    for (const deviceId of devMap.keys()) {
      const addonId = addonIdMap?.get(deviceId) ?? ''
      const key = `${capName}::${addonId}`
      const existing = grouped.get(key)
      if (existing) {
        existing.deviceIds.push(deviceId)
      } else {
        grouped.set(key, { capName, addonId, deviceIds: [deviceId] })
      }
    }
  }
  return [...grouped.values()]
}

export function getWorkerNativeCapsForDevice(deviceId: number): readonly string[] {
  const caps: string[] = []
  for (const [capName, perCap] of workerNativeCaps) {
    if (perCap.has(deviceId)) caps.push(capName)
  }
  return caps
}

/**
 * Read-only accessor for UDS dispatch — returns the provider registered for a
 * given (capName, deviceId) pair, or `undefined` when none is registered.
 * Returns the provider as an opaque `object`; `createChildCapDispatch` resolves
 * its methods structurally via a type guard, so no cast is needed.
 */
export function getWorkerNativeCapProvider(capName: string, deviceId: number): object | undefined {
  const raw: unknown = workerNativeCaps.get(capName)?.get(deviceId)
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined
  return raw
}

// ── Hub-side: proxy factory ──────────────────────────────────────────

const BACKOFF_INITIAL_MS = 100
const BACKOFF_MAX_MS = 10_000

async function callWithServiceDiscoveryRetry(
  broker: ServiceBroker,
  actionName: string,
  input: unknown,
): Promise<unknown> {
  let delay = BACKOFF_INITIAL_MS
  let attempt = 0
  for (;;) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      return await broker.call(actionName, input)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('is not found')) throw err
      attempt++
      if (attempt === 1) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        broker.logger.warn(
          `native-cap-bridge: service not found for "${actionName}", retrying with exponential backoff…`,
        )
      }
      await sleep(delay)
      delay = Math.min(delay * 2, BACKOFF_MAX_MS)
    }
  }
}

/**
 * Hub-side proxy factory. Returns an object whose method access dispatches
 * via `broker.call('<addonId>.native-provider.<capName>.<method>', input)`.
 * Calls are wrapped in exponential-backoff retry to absorb the race between
 * worker `broker.createService` and the hub's Moleculer registry INFO packet.
 */
export function buildNativeCapProxy(
  broker: ServiceBroker,
  addonId: string,
  capName: string,
  deviceId: number,
): Record<string, (input: unknown) => Promise<unknown>> {
  const actionPrefix = capServiceName(addonId, capName, true)
  const target: Record<string, (input: unknown) => Promise<unknown>> = {}
  return new Proxy(target, {
    get(_target, property): ((input: unknown) => Promise<unknown>) | undefined {
      if (typeof property !== 'string') return undefined
      return (input: unknown): Promise<unknown> => {
        const mergedInput =
          typeof input === 'object' && input !== null
            ? { ...(input as Record<string, unknown>), deviceId }
            : { deviceId }
        return callWithServiceDiscoveryRetry(broker, `${actionPrefix}.${property}`, mergedInput)
      }
    },
  })
}

// ── Worker-side: DeviceManagerApi ───────────────────────────────────

function deviceHasStreamSources(
  device: IDevice,
): device is IDevice & Pick<ICameraDevice, 'getStreamSources'> {
  return typeof Reflect.get(device, 'getStreamSources') === 'function'
}

export function buildDeviceOpsProvider(device: IDevice): InferProvider<typeof deviceOpsCapability> {
  const assertMatch = (incoming: number): void => {
    if (incoming !== device.id) {
      throw new Error(`device-ops: deviceId mismatch — expected '${device.id}', got '${incoming}'`)
    }
  }
  return {
    getStreamSources: async (input: { deviceId: number }) => {
      assertMatch(input.deviceId)
      if (!deviceHasStreamSources(device)) return []
      return [...(await device.getStreamSources())]
    },
    getConfigEntries: async (input: { deviceId: number }) => {
      assertMatch(input.deviceId)
      return device.config.entries().map((e) => ({ key: e.key, value: e.value }))
    },
    setConfig: async (input: { deviceId: number; values: Record<string, unknown> }) => {
      assertMatch(input.deviceId)
      await device.applySettingsPatch(input.values)
    },
    runAction: async (input: { deviceId: number; action: string; input: unknown }) => {
      assertMatch(input.deviceId)
      return device.runDeviceAction(input.action, input.input)
    },
    removeDevice: async (input: { deviceId: number }) => {
      assertMatch(input.deviceId)
      await device.removeDevice()
    },
    getSettingsSchema: async (input: { deviceId: number }) => {
      assertMatch(input.deviceId)
      return device.getSettingsUISchema()
    },
    getRawState: async (input: { deviceId: number }) => {
      assertMatch(input.deviceId)
      if (typeof device.getRawState !== 'function') return null
      return (await device.getRawState()) ?? null
    },
  }
}

/**
 * The secret paths a live device's config schema declares (D783). A device
 * whose `config` carries no readable schema (a test double) declares none —
 * the hub's keyword backstop still applies to it.
 */
function declaredSecretConfigPaths(device: { readonly config?: unknown }): string[] {
  const schema = (device.config as { schema?: unknown } | undefined)?.schema
  if (schema === undefined || schema === null || typeof schema !== 'object') return []
  return [...collectZodSecretPaths(schema as Parameters<typeof collectZodSecretPaths>[0])]
}

function callDeviceManager(api: AddonApi, method: string, input: unknown): Promise<unknown> {
  const leaf = Reflect.get(Reflect.get(api, 'deviceManager'), method) as {
    mutate?: (i: unknown) => Promise<unknown>
    query?: (i: unknown) => Promise<unknown>
  }
  return (leaf.mutate ?? leaf.query)!(input)
}

export function createBrokerDeviceManagerApi(opts: WorkerDeviceManagerOptions): DeviceManagerApi {
  const { api, addonId, nodeId, eventBus, registry } = opts
  // Documented type boundary: AddonApi is the generated tRPC client; the
  // slice source only needs deviceState get/setCapSlice.
  const deviceSliceSource = createEventBusSliceSource({
    eventBus,
    api: addonSliceHandleApi(api),
  })

  let selfApi: DeviceManagerApi

  // ONE loader per addon process. Every device's accessory reconcile asks it
  // for its own children; it coalesces whatever is in flight into a single
  // `getChildrenBatch`. See `children-batch-loader.ts` for the measurement
  // this removes (1 024 calls in a 120-second boot) and for how it degrades
  // against a hub that predates the batch method.
  const childrenLoader = createChildrenBatchLoader({
    logger: opts.logger,
    fetchBatch: async (parentDeviceIds) => {
      const answer = await callDeviceManager(api, 'getChildrenBatch', { parentDeviceIds })
      const parsed = parseChildrenByParent(answer)
      if (parsed === null) {
        throw new Error('getChildrenBatch returned a shape this kernel cannot read')
      }
      return parsed
    },
    fetchOne: async (parentDeviceId) => {
      const answer = await callDeviceManager(api, 'getChildren', { parentDeviceId })
      const parsed = parseChildRows(answer)
      if (parsed === null) {
        throw new Error('getChildren returned a shape this kernel cannot read')
      }
      return parsed
    },
  })

  // Per-device reconstruction closures, captured at creation time (both the
  // standalone `create()` path and the accessory-child `spawnAccessoryChild()`
  // path register one). `applyDerivedSpec` uses them to rebuild a live instance
  // when its mapping-derived config drifts (e.g. an upstream device's class
  // changed). The closure builds a fresh DeviceContext from the supplied config
  // + the persisted meta, so the provider's factory re-derives the right class.
  // Generic + addon-agnostic: keyed purely by deviceId; no container knowledge.
  //
  // Two phases (D677): the closure LOADS (runtime state + meta) and answers a
  // synchronous constructor. A load that fails throws before anything is torn
  // down, so a refused rebuild leaves the live instance standing instead of a
  // decommissioned device, or one rebuilt from an empty state.
  const deviceRebuildFactories = new Map<
    number,
    (mergedConfig: Record<string, unknown>) => Promise<() => IDevice>
  >()

  /** `loadRuntimeState` that refuses the build instead of answering `{}` (D677). */
  const loadRuntimeStateFor = (
    deviceId: number,
    stableId: string,
    phase: RuntimeStateLoadPhase,
  ): Promise<Record<string, unknown>> =>
    loadRuntimeStateOrRefuse(
      () => callDeviceManager(api, 'loadRuntimeState', { deviceId }),
      opts.logger,
      { deviceId, stableId, phase },
    )

  const buildContext = (
    stableId: string,
    id: number,
    parentDeviceId: number | null = null,
    initialRuntimeState: Record<string, unknown> = {},
    persistedConfig: Record<string, unknown> = {},
    deviceMeta: import('@camstack/types').DeviceMeta | null = null,
  ): DeviceContext => {
    // Per-context runtime-state reference — set by `BaseDevice`
    // constructor via `bindRuntimeState`. Used inside
    // `registerNativeCap` below to attach each cap's runtime-state
    // schema to the device's `runtimeState` instance.
    let runtimeStateRef: import('@camstack/types').IDeviceRuntimeState | null = null
    return {
      id,
      stableId,
      parentDeviceId,
      // `containerDeviceId` scopes the device hierarchy for log filtering: an
      // accessory child carries its PARENT's id; a top-level Container carries
      // its OWN id. Filtering logs by `containerDeviceId = <containerId>` then
      // returns the whole subtree (container + every child) in one query —
      // generic across all providers, derived purely from the existing
      // `parentDeviceId` / `DeviceType.Container` structure.
      logger: ((): import('@camstack/types').IScopedLogger => {
        const base = opts.logger.child(stableId)
        const containerDeviceId =
          parentDeviceId ?? (deviceMeta?.type === DeviceType.Container ? id : null)
        return base.withTags(
          containerDeviceId !== null ? { deviceId: id, containerDeviceId } : { deviceId: id },
        )
      })(),
      api,
      eventBus,
      streamProbe: opts.streamProbe,
      bindRuntimeState: (state) => {
        runtimeStateRef = state
      },
      persistConfig: async (
        data: unknown,
        options?: import('@camstack/types').DevicePersistConfigOptions,
      ) => {
        const dataRecord = toPlainRecord(data)
        if (!dataRecord) {
          throw new Error(
            `worker-device-manager: persistConfig expected a plain object, got ${data === null ? 'null' : typeof data}`,
          )
        }
        await callDeviceManager(api, 'persistConfig', {
          deviceId: id,
          data: dataRecord,
          ...(options?.secretConfigPaths !== undefined
            ? { secretConfigPaths: [...options.secretConfigPaths] }
            : {}),
        })
      },
      // Runtime-state writes go through `BaseDevice.runtimeState`,
      // which resolves a `DeviceProxy` for self via `fetchDevice(id)`
      // (below) and dispatches `device-state.setCapSlice` with the
      // deviceId pre-bound. No persister proxy needed on the worker
      // context.
      initialRuntimeState,
      persistedConfig,
      // BaseDevice constructor REQUIRES this. The kernel proxy
      // pre-loads via `loadMeta` before instantiation. The synthesised
      // placeholder below covers internal callers (e.g. `register`'s
      // ctxForDevice that builds a context for cap installation only)
      // that don't go through the full `create()` flow — for those the
      // device class never runs its own constructor through this ctx,
      // so we don't need a real type. Production CREATE paths always
      // pass the loaded blob.
      //
      // The placeholder type is `generic`, NEVER `camera`: a failed
      // `loadMeta` (contended boot, slow store) used to construct the
      // device as a camera, and `registerDevice` then persisted that
      // guess — self-sealing, since every later boot re-read it (live,
      // 2026-08-15: the Notification Center's alarm panel appeared in the
      // viewer's camera list as a camera named "Alarm"). A non-camera
      // placeholder cannot leak into a camera surface while it waits for
      // the real meta.
      deviceMeta: deviceMeta ?? {
        id,
        stableId,
        addonId,
        type: DeviceType.Generic,
        name: stableId,
        location: null,
        disabled: false,
        parentDeviceId,
        metadata: null,
      },
      // fetchDevice — same shape as AddonContext.fetchDevice. Used by
      // BaseDevice's runtime-state writer; addons consuming a device's
      // own surface (e.g. a driver invoking its own ptz cap from a
      // detection callback) can also fetch through here. Cached at the
      // call site if the caller wants to reuse — this factory builds a
      // fresh proxy per call (the binding lookup is cheap, and it lets
      // late-arriving wrapper toggles be picked up on next fetch).
      fetchDevice: async (deviceId: number): Promise<DeviceProxy> => {
        const binding = await api.deviceManager.getBindings.query({ deviceId })
        return createDeviceProxy(api, binding, { stateSource: deviceSliceSource })
      },
      get devices(): DeviceManagerApi {
        return selfApi
      },
      registerNativeCap<TCap extends CapabilityDefinition>(
        cap: TCap,
        // Native providers implement the device-scoped runtime surface only —
        // `systemOnly` methods (served by the cap's system/wrapper provider) are
        // optional here, matching the DeviceContext contract.
        provider: InferNativeProvider<TCap>,
      ): void {
        // Auto-install the cap's runtime-state schema onto the
        // device's `runtimeState` (if the cap declares one). Hits
        // through `runtimeStateRef` set during the BaseDevice
        // constructor — works even before `registry.register` runs.
        if (cap.runtimeState && runtimeStateRef) {
          try {
            runtimeStateRef.installCapSchema(cap.name, cap.runtimeState)
          } catch (err) {
            opts.logger.warn('failed to install cap runtime-state schema', {
              tags: { deviceId: id, addonId },
              meta: { capName: cap.name, error: err instanceof Error ? err.message : String(err) },
            })
          }
        }
        // Default `getStatus` — when a cap declares both `status` AND
        // `runtimeState` but the provider didn't supply its own
        // `getStatus`, install one that reads straight from the
        // device's runtime-state slice. Providers that DO implement
        // `getStatus` (custom logic, derived fields) keep theirs.
        // Eliminates the most common boilerplate path: any cap whose
        // status-shape exactly matches its runtime-state shape no
        // longer needs `createRuntimeStateBridge`. Mirrors the
        // CLAUDE.md follow-up "codegen-driven `getStatus` default"
        // — same effect, implemented at the registration site
        // instead of via codegen output.
        const finalProvider = ((): InferNativeProvider<TCap> => {
          if (!cap.status || !cap.runtimeState || !runtimeStateRef) return provider
          if (typeof Reflect.get(provider, 'getStatus') === 'function') return provider
          const rsRef = runtimeStateRef
          const defaultGetStatus = async ({
            deviceId: dId,
          }: {
            deviceId?: number
          }): Promise<unknown | null> => {
            if (typeof dId === 'number' && dId !== id) return null
            return rsRef.getCapState(cap.name) ?? null
          }
          return { ...provider, getStatus: defaultGetStatus }
        })()
        if (opts.capabilityRegistry) {
          opts.capabilityRegistry.registerNativeProvider(
            cap.name,
            id,
            addonId,
            finalProvider as unknown,
          )
        } else if (opts.broker || opts.udsMode) {
          // Worker path (broker-mode or UDS-mode): record the provider in the
          // per-process `workerNativeCaps` map. The UDS dispatch in
          // `addon-runner` resolves device-scoped caps through
          // `getWorkerNativeCapProvider`, and `getWorkerNativeCapSnapshot`
          // feeds the registration handshake / UDS `updateCaps`.
          let perCap = workerNativeCaps.get(cap.name)
          if (!perCap) {
            perCap = new Map()
            workerNativeCaps.set(cap.name, perCap)
          }
          perCap.set(id, finalProvider as unknown)
          // Track addonId alongside the provider so the handshake snapshot
          // (`getWorkerNativeCapSnapshot`) can include it — the hub needs it
          // to build the correct proxy target on the hub side.
          let perAddonId = workerNativeCapAddonIds.get(cap.name)
          if (!perAddonId) {
            perAddonId = new Map()
            workerNativeCapAddonIds.set(cap.name, perAddonId)
          }
          perAddonId.set(id, addonId)
          // Broker-mode ONLY mounts the `<addon>.native-provider.<cap>`
          // Moleculer service. A UDS-only child has no broker — the parent
          // dispatches device-scoped native caps over UDS (`callCapOnChild`
          // → `getWorkerNativeCapProvider`), so no Moleculer service exists.
          if (opts.broker) {
            mountNativeCapService(opts.broker, addonId, cap)
          }
          // Notify the runner that the native-cap set grew so it re-sends the
          // UDS `updateCaps` handshake — otherwise a cap registered after the
          // runner's `post-init` handshake (async device discovery) never
          // reaches the hub's `LocalChildRegistry` and stays unroutable.
          onWorkerNativeCapsChanged?.()
        } else {
          throw new Error(
            `DeviceContext.registerNativeCap('${cap.name}') called on '${stableId}' but ` +
              `none of capabilityRegistry / broker / udsMode was provided.`,
          )
        }
        eventBus.emit({
          id: randomUUID(),
          timestamp: new Date(),
          source: { type: 'device', id },
          category: EventCategory.DeviceBindingsChanged,
          data: { deviceId: id, capName: cap.name, reason: 'native-registered', addonId, nodeId },
        })
        emitReadiness(eventBus, {
          capName: cap.name,
          scope: { type: 'device', deviceId: id },
          state: 'ready',
          generation: nativeCapReadinessGeneration,
          sourceNodeId: nodeId,
        })
      },
      // D663 (Kernel ruling): the mirror of `registerNativeCap`, in the same
      // three branches. It removes ONLY the entry THIS addon registered — the
      // composer ungrafting an added cap must never take down the native that
      // appeared on the same (device, cap) since. The events are decommission's.
      unregisterNativeCap(capName: string): void {
        const worker =
          opts.capabilityRegistry === undefined &&
          (opts.broker !== undefined || opts.udsMode === true)
        if (!opts.capabilityRegistry && !worker) {
          throw new Error(
            `DeviceContext.unregisterNativeCap('${capName}') called on '${stableId}' but ` +
              `none of capabilityRegistry / broker / udsMode was provided.`,
          )
        }
        const holder = opts.capabilityRegistry
          ? opts.capabilityRegistry.getNativeAddonId(capName, id)
          : (workerNativeCapAddonIds.get(capName)?.get(id) ?? null)
        // A worker process that holds NOTHING for (cap, device) may be retracting
        // a binding a PREVIOUS incarnation of this addon left on the hub (a
        // respawn, D5): the events alone retract it, and the hub drops only an
        // entry this addon registered. A hub-local registry has no previous
        // incarnation — a restart of the hub wiped it.
        const staleRetract = worker && holder === null
        if (holder !== addonId && !staleRetract) {
          opts.logger.debug(
            'unregisterNativeCap: the cap is not registered by this addon — no-op',
            {
              tags: { deviceId: id, addonId },
              meta: { capName },
            },
          )
          return
        }
        if (staleRetract) {
          opts.logger.info(
            'unregisterNativeCap: retracting a binding this process never registered (a previous incarnation of the addon)',
            { tags: { deviceId: id, addonId }, meta: { capName } },
          )
        } else if (opts.capabilityRegistry) {
          opts.capabilityRegistry.unregisterNativeProvider(capName, id)
        } else {
          workerNativeCaps.get(capName)?.delete(id)
          workerNativeCapAddonIds.get(capName)?.delete(id)
          // The runner re-sends `updateCaps`, so the hub's `LocalChildRegistry`
          // stops routing this (cap, device) to this child.
          onWorkerNativeCapsChanged?.()
        }
        eventBus.emit({
          id: randomUUID(),
          timestamp: new Date(),
          source: { type: 'device', id },
          category: EventCategory.DeviceBindingsChanged,
          data: { deviceId: id, capName, reason: 'native-unregistered', addonId, nodeId },
        })
        emitReadiness(eventBus, {
          capName,
          scope: { type: 'device', deviceId: id },
          state: 'down',
          generation: nativeCapReadinessGeneration,
          sourceNodeId: nodeId,
        })
      },
    }
  }

  /**
   * Spawn one accessory child device declared by a parent's
   * `getAccessoryChildren()`. Mirrors the standard `create()` flow
   * but uses the parent's stableId as a stable prefix and the
   * spec's factory closure as the constructor (which closes over
   * the parent reference). Idempotent on restore: if the child's
   * row already exists, `persistInitialConfig` is skipped (config
   * arg empty) and the child self-hydrates from `loadConfig`.
   */
  const spawnAccessoryChild = async (
    parent: IDevice,
    spec: import('@camstack/types').AccessoryChildSpec,
  ): Promise<IDevice> => {
    const childStableId = `${parent.stableId}-${spec.stableIdSuffix}`
    const id = await deviceApi.allocateDeviceId(childStableId)
    // Idempotency guard: reconcile may fire multiple times within a
    // single addon-worker lifetime (e.g. `feature-probe` slice writes
    // re-trigger Phase 4b — see runReconcile). The first run registers
    // the accessory in the local kernel `registry`; subsequent runs
    // would re-instantiate the same class with the same allocated id,
    // and `registry.register` throws "already registered" — leaving
    // the new instance half-constructed (caps not registered, slices
    // not seeded, no firmware refresh wired). Detect the existing
    // entry by id+stableId and short-circuit so the slot stays bound
    // to the first instance the kernel saw.
    const existing = registry.getById(id)
    if (existing && existing.stableId === childStableId) {
      return existing
    }
    const empty: Record<string, unknown> = {}
    // Pre-write meta + config only when the row is brand new. The
    // existence check is "does the persisted meta carry a name
    // different from the placeholder (= stableId)?" — set on first
    // setName call.
    const existingMeta = (await callDeviceManager(api, 'loadMeta', { deviceId: id }).catch(
      () => null,
    )) as import('@camstack/types').DeviceMeta | null
    const isFirstSpawn = !existingMeta || existingMeta.name === childStableId
    // Collapse the per-child meta pre-seed into ONE `applyInitialMeta` call
    // (was up to 6 individual setter round-trips — the dominant cost when
    // reconciling a many-entity container). Two field groups, same gating
    // semantics as before:
    //
    //  - FIRST-SPAWN-ONLY operator-editable fields (name, location): a
    //    restore must NOT clobber a name/location the operator changed after
    //    first spawn, so these are only included when the row is brand new
    //    (no existing meta, or its name still equals the placeholder
    //    childStableId).
    //  - EVERY-SPAWN spec-derived fields (type, integrationId, linkDeviceId,
    //    role): computed by the provider's getAccessoryChildren() from the
    //    upstream mapping and NOT operator-editable. Re-applied on every spawn
    //    (incl. restore) so the meta reflects the current spec (e.g. a restored
    //    sensor gets its role back after a reboot). Idempotent.
    //
    // Always stamp the parent link. This is the STRUCTURAL marker that "this
    // child is an accessory managed by the parent's getAccessoryChildren() spec
    // list" — the orphan reconciliation below prunes by THIS link, never by an
    // addon-specific stableId naming convention. Hub-adopted standalone children
    // (cameras under an NVR/Hub) are adopted independently and never pass through
    // this path, so they never carry a linkDeviceId and are never pruned.
    //
    // This runs BEFORE the child constructor below so ctx.deviceMeta already
    // carries the correct values when the constructor reads it.
    const linkDeviceId = spec.meta.linkDeviceId ?? parent.id
    const initialMeta: import('@camstack/types').DeviceManagerApplyInitialMetaInput = {
      deviceId: id,
      linkDeviceId,
      ...(isFirstSpawn && spec.meta.name !== undefined ? { name: spec.meta.name } : {}),
      ...(isFirstSpawn && spec.meta.location !== undefined ? { location: spec.meta.location } : {}),
      ...(spec.meta.type !== undefined ? { type: spec.meta.type } : {}),
      ...(spec.meta.integrationId !== undefined ? { integrationId: spec.meta.integrationId } : {}),
      ...(spec.meta.role !== undefined ? { role: spec.meta.role } : {}),
    }
    await callDeviceManager(api, 'applyInitialMeta', initialMeta).catch((err: unknown) => {
      opts.logger.warn('spawnAccessoryChild: applyInitialMeta pre-seed failed', {
        tags: { stableId: childStableId, deviceId: id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    })
    // persistConfig writes the per-device config blob (keyed by numeric id),
    // SEPARATE from the meta row — first-spawn-only here; the self-heal below
    // covers a restored child whose config row was lost.
    if (isFirstSpawn && Object.keys(spec.config).length > 0) {
      await callDeviceManager(api, 'persistConfig', { deviceId: id, data: spec.config }).catch(
        () => {
          /* best-effort */
        },
      )
    }
    // Always reload the latest blob — for restore paths the meta +
    // config may already carry operator-edited values that the spec
    // shouldn't overwrite.
    const [initialRuntimeState, loadedConfig, deviceMeta] = await Promise.all([
      loadRuntimeStateFor(id, childStableId, 'accessory-child'),
      callDeviceManager(api, 'loadConfig', { deviceId: id }).catch(() => empty) as Promise<
        Record<string, unknown>
      >,
      callDeviceManager(api, 'loadMeta', { deviceId: id }).catch(() => null) as Promise<
        import('@camstack/types').DeviceMeta | null
      >,
    ])
    // Self-heal a restored accessory child whose CONFIG row was lost. Such a child
    // is `isFirstSpawn=false` (its META still carries a real name), so the
    // first-spawn persist above was skipped — it would construct from an EMPTY blob
    // and its `schema.parse({})` would throw, failing the spawn permanently. An
    // accessory's config is a pure PROJECTION of the parent's getAccessoryChildren()
    // spec, so re-deriving it is always correct; we only do it when the loaded blob
    // is genuinely empty, so an operator-edited (non-empty) config is never clobbered.
    let persistedConfig = loadedConfig
    if (
      !isFirstSpawn &&
      Object.keys(loadedConfig).length === 0 &&
      Object.keys(spec.config).length > 0
    ) {
      await callDeviceManager(api, 'persistConfig', { deviceId: id, data: spec.config }).catch(
        () => {
          /* best-effort */
        },
      )
      persistedConfig = spec.config
    }
    const childCtx = buildContext(
      childStableId,
      id,
      parent.id,
      initialRuntimeState,
      persistedConfig,
      deviceMeta,
    )
    const child = spec.factory(childCtx)
    await deviceApi.register(child)
    // Capture how to rebuild this child from a (possibly changed) config so
    // `applyDerivedSpec` can re-derive its class via the same provider factory,
    // preserving operator meta (name/location loaded from the persisted row).
    deviceRebuildFactories.set(id, async (mergedConfig) => {
      const [rt, meta] = await Promise.all([
        loadRuntimeStateFor(id, childStableId, 'rebuild'),
        callDeviceManager(api, 'loadMeta', { deviceId: id }).catch(() => null) as Promise<
          import('@camstack/types').DeviceMeta | null
        >,
      ])
      return () => spec.factory(buildContext(childStableId, id, parent.id, rt, mergedConfig, meta))
    })
    return child
  }

  // Per-device retry timer for the initial probe. When `runProbe()`
  // fails (timeout / throw), the kernel falls back to a slow exponential
  // backoff: re-runs `runProbeAndReconcile` at the listed intervals
  // until the `feature-probe` slice is populated OR the device is
  // decommissioned. Cleared from `decommission()` to avoid the timer
  // firing against a removed device's runtimeState.
  //
  // The schedule is the SHARED boot-recovery one. It used to start at five
  // minutes, which assumed the probe failed because the device was unreachable
  // — but on the measured boot of 2026-08-15 fifteen devices failed because the
  // HUB was starved, and every one of them stayed unprobed for five minutes
  // after a condition that was gone in seconds. Two cheap attempts first, then
  // the same battery-cam tail. See `BOOT_RECOVERY_BACKOFF_MS`.
  const PROBE_RETRY_BACKOFF_MS = BOOT_RECOVERY_BACKOFF_MS
  const probeRetryTimers = new Map<number, ReturnType<typeof setTimeout>>()
  const cancelProbeRetry = (deviceId: number): void => {
    const timer = probeRetryTimers.get(deviceId)
    if (timer) {
      clearTimeout(timer)
      probeRetryTimers.delete(deviceId)
    }
  }

  const deviceApi: DeviceManagerApi = {
    allocateDeviceId: async (stableId: string): Promise<number> => {
      const result = (await callDeviceManager(api, 'allocateDeviceId', { addonId, stableId })) as {
        id: number
      }
      return result.id
    },

    create: async <T extends IDevice>(
      stableId: string,
      DeviceClass: DeviceConstructor<T>,
      config: Record<string, unknown>,
      parentDeviceId: number | null = null,
      initialMeta: import('@camstack/types').InitialDeviceMeta | undefined = undefined,
    ): Promise<T> => {
      const id = await deviceApi.allocateDeviceId(stableId)
      // Pre-persist operator-supplied meta (name / location) AND
      // config BEFORE constructing the device. Both surfaces are
      // pure read-from-DB inside `BaseDevice` — the constructor
      // never receives them as args, only via `ctx.deviceMeta` and
      // `ctx.persistedConfig`. Pre-persist is mandatory on the
      // CREATE path; the placeholder meta seeded by `allocateDeviceId`
      // carries `name = stableId` which is not what the operator
      // typed in the form.
      //
      // RESTORE paths pass `initialMeta = undefined` and `config = {}`
      // — the persisted DB row is the canonical source and
      // `loadMeta` / `loadConfig` return it verbatim.
      if (initialMeta) {
        if (initialMeta.name !== undefined) {
          await callDeviceManager(api, 'setName', { deviceId: id, name: initialMeta.name }).catch(
            (err: unknown) => {
              opts.logger.warn('create: setName pre-seed failed', {
                tags: { stableId, deviceId: id },
                meta: { error: err instanceof Error ? err.message : String(err) },
              })
            },
          )
        }
        if (initialMeta.location !== undefined) {
          await callDeviceManager(api, 'setLocation', {
            deviceId: id,
            location: initialMeta.location,
          }).catch(() => {
            /* best-effort */
          })
        }
        if (initialMeta.type !== undefined) {
          await callDeviceManager(api, 'setType', { deviceId: id, type: initialMeta.type }).catch(
            (err: unknown) => {
              opts.logger.warn('create: setType pre-seed failed', {
                tags: { stableId, deviceId: id },
                meta: { error: err instanceof Error ? err.message : String(err) },
              })
            },
          )
        }
        if (initialMeta.integrationId !== undefined) {
          await callDeviceManager(api, 'setIntegrationId', {
            deviceId: id,
            integrationId: initialMeta.integrationId,
          }).catch((err: unknown) => {
            opts.logger.warn('create: setIntegrationId pre-seed failed', {
              tags: { stableId, deviceId: id },
              meta: { error: err instanceof Error ? err.message : String(err) },
            })
          })
        }
        if (initialMeta.linkDeviceId !== undefined) {
          await callDeviceManager(api, 'setLinkDeviceId', {
            deviceId: id,
            linkDeviceId: initialMeta.linkDeviceId,
          }).catch((err: unknown) => {
            opts.logger.warn('create: setLinkDeviceId pre-seed failed', {
              tags: { stableId, deviceId: id },
              meta: { error: err instanceof Error ? err.message : String(err) },
            })
          })
        }
        if (initialMeta.role !== undefined) {
          await callDeviceManager(api, 'setRole', { deviceId: id, role: initialMeta.role }).catch(
            (err: unknown) => {
              opts.logger.warn('create: setRole pre-seed failed', {
                tags: { stableId, deviceId: id },
                meta: { error: err instanceof Error ? err.message : String(err) },
              })
            },
          )
        }
        if (initialMeta.childLayout !== undefined) {
          await callDeviceManager(api, 'setChildLayout', {
            deviceId: id,
            childLayout: initialMeta.childLayout,
          }).catch((err: unknown) => {
            opts.logger.warn('create: setChildLayout pre-seed failed', {
              tags: { stableId, deviceId: id },
              meta: { error: err instanceof Error ? err.message : String(err) },
            })
          })
        }
        if (initialMeta.display !== undefined) {
          await callDeviceManager(api, 'setDisplay', {
            deviceId: id,
            display: initialMeta.display,
          }).catch((err: unknown) => {
            opts.logger.warn('create: setDisplay pre-seed failed', {
              tags: { stableId, deviceId: id },
              meta: { error: err instanceof Error ? err.message : String(err) },
            })
          })
        }
      }
      if (Object.keys(config).length > 0) {
        await callDeviceManager(api, 'persistConfig', { deviceId: id, data: config }).catch(
          (err: unknown) => {
            opts.logger.warn(
              'create: persistConfig pre-seed failed — device will start with schema defaults',
              {
                tags: { stableId, deviceId: id },
                meta: { error: err instanceof Error ? err.message : String(err) },
              },
            )
          },
        )
      }
      // Hydrate runtime state + persisted config + meta from disk so
      // the BaseDevice constructor wakes up with all three populated.
      const empty: Record<string, unknown> = {}
      const [initialRuntimeState, persistedConfig, deviceMeta] = await Promise.all([
        loadRuntimeStateFor(id, stableId, 'create'),
        callDeviceManager(api, 'loadConfig', { deviceId: id }).catch(() => empty) as Promise<
          Record<string, unknown>
        >,
        callDeviceManager(api, 'loadMeta', { deviceId: id }).catch(() => null) as Promise<
          import('@camstack/types').DeviceMeta | null
        >,
      ])
      const childCtx = buildContext(
        stableId,
        id,
        parentDeviceId,
        initialRuntimeState,
        persistedConfig,
        deviceMeta,
      )
      const device = new DeviceClass(childCtx)
      await deviceApi.register(device)
      // Capture the rebuild closure for `applyDerivedSpec` (standalone path):
      // re-derive from the supplied config + persisted meta via the same class.
      deviceRebuildFactories.set(id, async (mergedConfig) => {
        const [rt, meta] = await Promise.all([
          loadRuntimeStateFor(id, stableId, 'rebuild'),
          callDeviceManager(api, 'loadMeta', { deviceId: id }).catch(() => null) as Promise<
            import('@camstack/types').DeviceMeta | null
          >,
        ])
        return () =>
          new DeviceClass(buildContext(stableId, id, parentDeviceId, rt, mergedConfig, meta))
      })
      return device
    },

    // EMPTY runtime state, synchronously. For a caller that builds no device
    // from it — the composer graft registers method-serving natives only and
    // never hydrates or writes a slice through the context — and for addons
    // compiled before `loadContext`. A caller that BUILDS a device uses
    // `loadContext` (D677).
    createContext: (
      stableId: string,
      id: number,
      parentDeviceId: number | null = null,
      persistedConfig: Record<string, unknown> = {},
    ) => buildContext(stableId, id, parentDeviceId, {}, persistedConfig),

    // `createContext` for a device the caller will BUILD: hydrated from the
    // stored runtime state like `create()`, refused when the load does not
    // answer (D677).
    loadContext: async (
      stableId: string,
      id: number,
      parentDeviceId: number | null = null,
      persistedConfig: Record<string, unknown> = {},
    ) =>
      buildContext(
        stableId,
        id,
        parentDeviceId,
        await loadRuntimeStateFor(id, stableId, 'context'),
        persistedConfig,
      ),

    loadConfig: async (deviceId: number): Promise<Record<string, unknown>> => {
      const empty: Record<string, unknown> = {}
      return callDeviceManager(api, 'loadConfig', { deviceId }).catch(() => empty) as Promise<
        Record<string, unknown>
      >
    },

    persistInitialConfig: async (
      stableId: string,
      config: Record<string, unknown>,
    ): Promise<number> => {
      const id = await deviceApi.allocateDeviceId(stableId)
      await callDeviceManager(api, 'persistConfig', { deviceId: id, data: config })
      return id
    },

    setName: async (deviceId: number, name: string): Promise<void> => {
      await callDeviceManager(api, 'setName', { deviceId, name })
    },

    setLocation: async (deviceId: number, location: string | null): Promise<void> => {
      await callDeviceManager(api, 'setLocation', { deviceId, location })
    },

    setDisabled: async (deviceId: number, disabled: boolean): Promise<void> => {
      await callDeviceManager(api, 'setDisabled', { deviceId, disabled })
    },

    register: async (device: IDevice): Promise<void> => {
      registry.register(addonId, device)
      const ctxForDevice = buildContext(device.stableId, device.id, device.parentDeviceId)
      ctxForDevice.registerNativeCap(
        deviceOpsCapability,
        buildDeviceOpsProvider(device) as InferProvider<typeof deviceOpsCapability>,
      )
      try {
        // Config is no longer threaded through `registerDevice` —
        // the kernel's `create()` shortcut pre-persists via
        // `persistConfig` BEFORE construction so the DB row is the
        // canonical source. Same for meta: `setName/setLocation`
        // are called pre-construct from `initialMeta`. `register`
        // now only writes the immutable identity fields (id /
        // stableId / type / features / parentDeviceId) — `name` is
        // included for back-compat with the registerDevice action's
        // existing payload but the device-manager addon ignores it
        // when the meta row already has a non-stableId value.
        await callDeviceManager(api, 'registerDevice', {
          addonId,
          stableId: device.stableId,
          id: device.id,
          type: device.type,
          name: device.name,
          parentDeviceId: device.parentDeviceId,
          features: [...device.features],
          config: {},
          // D783 — the paths this device's own schema declares secret, so
          // the hub can withhold them from non-admins at any depth.
          secretConfigPaths: declaredSecretConfigPaths(device),
        })
      } catch (err) {
        registry.remove(device.id)
        opts.capabilityRegistry?.unregisterNativeProvider('device-ops', device.id)
        if (!opts.capabilityRegistry) {
          workerNativeCaps.get('device-ops')?.delete(device.id)
        }
        throw err
      }

      // Post-register lifecycle phases (3 → 4 → 5). Each phase is
      // best-effort: a failing `onProbe`, accessory-spawn, or
      // `onActivate` is logged + swallowed because the device IS
      // already registered. Drivers that need stricter guarantees
      // handle their own retry / shutdown logic.
      const lifecycleHost = device as IDevice & {
        onProbe?: () => Promise<void>
        onActivate?: () => Promise<void>
        getAccessoryChildren?: () => import('@camstack/types').AccessoryChildrenAnswer
        _kernelReprobe?: () => Promise<void>
      }

      // Encapsulate phase 4 (reconcile) separately from phase 3 (probe)
      // so the slice subscription installed below can re-run reconcile
      // on late-arriving probe completions WITHOUT also re-running the
      // probe (which would loop: probe writes slice → subscription →
      // probe again).
      // D49 — a shrink of this parent's accessory set is deleted only after a
      // second agreeing SUCCESSFUL read on a later probe (accessory-prune-gate.ts).
      const shrinkGate = new AccessoryShrinkGate()
      const runReconcile = async (): Promise<void> => {
        // Phase 4a — refresh the meta `features` array on the
        // device-manager. The probe may have changed `device.features`;
        // the initial `registerDevice` call wrote a snapshot before
        // probe ran. This call re-publishes so cross-process consumers
        // see the post-probe truth.
        try {
          await callDeviceManager(api, 'registerDevice', {
            addonId,
            stableId: device.stableId,
            id: device.id,
            type: device.type,
            name: device.name,
            parentDeviceId: device.parentDeviceId,
            features: [...device.features],
            config: {},
            // D783 — the paths this device's own schema declares secret, so
            // the hub can withhold them from non-admins at any depth.
            secretConfigPaths: declaredSecretConfigPaths(device),
          })
        } catch (err) {
          opts.logger.debug('post-probe features meta refresh failed (non-fatal)', {
            tags: { deviceId: device.id, addonId },
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        }

        // Phase 4b — accessory reconciliation. Drivers' `getAccessoryChildren()`
        // reads from the (now-populated) feature-probe slice, so the
        // returned spec list reflects what the firmware actually advertises.
        if (typeof lifecycleHost.getAccessoryChildren !== 'function') return
        const probedAt =
          device.runtimeState?.getCapState<{ lastProbedAt?: number }>('feature-probe')
            ?.lastProbedAt ?? 0
        const read = classifyAccessoryRead(lifecycleHost.getAccessoryChildren(), {
          online: device.online,
          probedAt,
        })
        const specs = read.children
        const expected = new Set(specs.map((s) => `${device.stableId}-${s.stableIdSuffix}`))

        // Spawn missing children with bounded concurrency. spawnAccessoryChild
        // is idempotent on restore — when a row with the same stableId already
        // exists, the kernel reuses the persisted id + config. The per-spec
        // try/catch keeps one child's failure from aborting the others
        // (unchanged from the previous sequential loop); `runBounded` awaits the
        // whole batch so EVERY spawn completes before the orphan-prune step
        // below runs.
        await runBounded(specs, ACCESSORY_SPAWN_CONCURRENCY, async (spec) => {
          try {
            await spawnAccessoryChild(device, spec)
          } catch (err) {
            opts.logger.warn('Failed to spawn accessory child', {
              tags: { parentDeviceId: device.id, parentStableId: device.stableId },
              meta: {
                stableIdSuffix: spec.stableIdSuffix,
                error: err instanceof Error ? err.message : String(err),
              },
            })
          }
        })

        // Remove orphan ACCESSORY children no longer in the parent's spec
        // list. CRITICAL: this must NOT touch non-accessory children — hubs /
        // NVRs adopt cameras as first-class child devices. Managed accessories
        // are identified STRUCTURALLY by the parent soft-link: every child
        // spawned via `getAccessoryChildren()` / `spawnAccessoryChild` carries
        // `linkDeviceId === parent.id`; a hub-adopted standalone child has no
        // link and is left alone.
        //
        // THE PRUNE CONTRACT (D49, accessory-prune-gate.ts): a child is
        // deleted ONLY as the result of a SUCCESSFUL read — the provider
        // positively reports "connected, here is the complete list". Missing
        // credentials, a disconnected parent, a failed / partial read, a boot
        // before the first connect = unknown = nothing is deleted. And a
        // shrink needs a second agreeing successful read on a LATER probe.
        // Dreame without credentials answered only its core child and 97
        // accessories were deleted (new ids, bindings and history lost); a
        // device-54 probe timeout once rotated accessory ids the same way.
        if (read.kind === 'unknown') {
          opts.logger.info('Accessory orphan reconciliation skipped — child list unknown', {
            tags: { deviceId: device.id, parentStableId: device.stableId },
            meta: { reason: read.reason, probedAt },
          })
          return
        }
        try {
          // NOT one RPC per device: the loader coalesces every reconcile in
          // flight into one `getChildrenBatch`. Measured 1 024 calls for 919
          // rows on a 120-second boot before it existed.
          const currentChildren = await childrenLoader.load(device.id)
          // Only children THIS parent manages via its spec list
          // (linkDeviceId === parent.id) and that it no longer lists.
          const missing = currentChildren.filter(
            (child) => child.linkDeviceId === device.id && !expected.has(child.stableId),
          )
          const decision = shrinkGate.decide(
            missing.map((child) => child.id),
            probedAt,
          )
          if (decision.deferred.length > 0) {
            opts.logger.info(
              'Accessory children missing from a complete read — kept until a later probe agrees',
              {
                tags: { deviceId: device.id, parentStableId: device.stableId },
                meta: { childDeviceIds: [...decision.deferred], probedAt },
              },
            )
          }
          const confirmed = new Set(decision.prune)
          for (const child of missing) {
            if (!confirmed.has(child.id)) continue
            const live = registry.getById(child.id)
            try {
              if (live) {
                await deviceApi.remove(child.id)
              } else {
                await callDeviceManager(api, 'removeDevice', { deviceId: child.id })
              }
              opts.logger.info('Removed orphan accessory child no longer in parent specs', {
                tags: {
                  deviceId: child.id,
                  parentDeviceId: device.id,
                  parentStableId: device.stableId,
                },
                meta: {
                  childDeviceId: child.id,
                  childStableId: child.stableId,
                  childName: child.name,
                },
              })
            } catch (err) {
              opts.logger.warn('Failed to remove orphan accessory child', {
                tags: {
                  deviceId: child.id,
                  parentDeviceId: device.id,
                  parentStableId: device.stableId,
                  childDeviceId: child.id,
                },
                meta: { error: err instanceof Error ? err.message : String(err) },
              })
            }
          }
        } catch (err) {
          opts.logger.debug('Accessory orphan reconciliation skipped', {
            tags: { parentDeviceId: device.id },
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        }
      }

      // Phase 3 — driver-side probe (optional). Drivers populate
      // `runtimeState['feature-probe']` here. Wrapped in a hard
      // timeout: a hung lib call (camera offline mid-probe, dead
      // socket the driver doesn't classify as throwable) must NOT
      // block downstream device restores. The slice stays unseeded
      // and `getAccessoryChildren()` returns []. The slice subscription
      // installed below will re-run reconcile when the late-arriving
      // probe finally writes the slice — even if it lands SECONDS after
      // the initial `register()` returned.
      const PROBE_TIMEOUT_MS = 30_000
      const runProbe = async (): Promise<void> => {
        if (typeof lifecycleHost.onProbe !== 'function') return
        try {
          await Promise.race([
            lifecycleHost.onProbe(),
            new Promise<void>((_, reject) =>
              setTimeout(
                () => reject(new Error(`onProbe timeout after ${PROBE_TIMEOUT_MS}ms`)),
                PROBE_TIMEOUT_MS,
              ),
            ),
          ])
        } catch (err) {
          opts.logger.warn(
            'device.onProbe() threw or timed out — continuing with stale flags (slice subscription will reconcile if probe lands later)',
            {
              tags: { deviceId: device.id, addonId },
              meta: { error: err instanceof Error ? err.message : String(err) },
            },
          )
        }
      }

      const runProbeAndReconcile = async (): Promise<void> => {
        await runProbe()
        await runReconcile()
      }

      // Wire the kernel-injected callback so `device.reprobe()` triggers
      // the same orchestration. Drivers call this when device-side state
      // changes (battery wake, firmware update).
      lifecycleHost._kernelReprobe = runProbeAndReconcile

      // Read `lastProbedAt` to detect "probe never landed" — the slice
      // is the canonical signal regardless of why probe failed (timeout,
      // throw, or driver explicitly skipped). Used both here for the
      // retry scheduler and below for the slice subscription's "did
      // we already reconcile this generation" guard.
      const probeRtState = device.runtimeState
      const readProbedAt = (): number =>
        probeRtState?.getCapState<{ lastProbedAt?: number }>('feature-probe')?.lastProbedAt ?? 0

      // Fire `DeviceReady` exactly once on the device's FIRST successful
      // feature-probe — the `lastProbedAt` 0→>0 transition. After this the
      // device's exported shape (its persisted `DeviceFeature` set) is
      // stable, so export adapters (Alexa / HAP) can advertise it without
      // re-advertising a partial mid-probe shape. Telemetry-grade (D8):
      // consumers ALSO gate on the device record's `probed` flag. The
      // boolean latch guards against re-emission from the inline path AND
      // the slice subscription below (a late-arriving probe write).
      let deviceReadyEmitted = false
      const emitDeviceReadyOnce = (): void => {
        if (deviceReadyEmitted) return
        deviceReadyEmitted = true
        eventBus.emit({
          id: randomUUID(),
          timestamp: new Date(),
          source: { type: 'device', id: device.id },
          category: EventCategory.DeviceReady,
          data: { deviceId: device.id },
        })
      }

      // Snapshot the pre-probe value so the inline probe's own 0→>0
      // transition is detected (the slice subscription is installed AFTER
      // the inline probe and seeds its baseline post-probe, so it would
      // otherwise miss this first landing). A device with nothing to probe
      // marks itself probed in BaseDevice's default `onProbe` (so `lastProbedAt`
      // becomes >0 here), which is what drives the DeviceReady latch + skips the
      // "did-not-complete" retry chain below.
      const probedAtBeforeInline = readProbedAt()

      // Run phases 3 + 4 inline.
      await runProbeAndReconcile()

      if (probedAtBeforeInline === 0 && readProbedAt() > 0) emitDeviceReadyOnce()

      // If the initial probe failed (slice empty), schedule a backoff
      // retry chain. Each attempt re-runs the FULL probe + reconcile
      // pass; on success the slice subscription downstream cancels the
      // chain. On exhaustion, the device stays unprobed until manual
      // reprobe or addon restart — the orphan-removal gate (added in
      // a prior commit) ensures persisted accessories aren't deleted
      // while we wait.
      let retryAttempt = 0
      const scheduleProbeRetry = (): void => {
        if (retryAttempt >= PROBE_RETRY_BACKOFF_MS.length) {
          opts.logger.info('Probe retry chain exhausted', {
            tags: { deviceId: device.id, addonId },
            meta: { totalAttempts: PROBE_RETRY_BACKOFF_MS.length },
          })
          return
        }
        const delay = PROBE_RETRY_BACKOFF_MS[retryAttempt]!
        const attemptNum = retryAttempt + 1
        retryAttempt += 1
        const timer = setTimeout(() => {
          probeRetryTimers.delete(device.id)
          // Race-guard: the slice may have been populated between the
          // schedule and the fire (e.g. an `adoptApi` path on Reolink
          // that calls `probeAndPersistFeatures` directly). Skip the
          // retry in that case — the subscription already drove
          // reconcile.
          if (readProbedAt() > 0) return
          opts.logger.info('Initial probe retry — re-running runProbeAndReconcile', {
            tags: { deviceId: device.id, addonId },
            meta: {
              attempt: attemptNum,
              totalAttempts: PROBE_RETRY_BACKOFF_MS.length,
              delayMs: delay,
            },
          })
          void runProbeAndReconcile()
            .then(() => {
              if (readProbedAt() === 0) scheduleProbeRetry()
            })
            .catch((err: unknown) => {
              opts.logger.warn('Probe retry threw', {
                tags: { deviceId: device.id, addonId },
                meta: {
                  attempt: attemptNum,
                  error: err instanceof Error ? err.message : String(err),
                },
              })
              scheduleProbeRetry()
            })
        }, delay)
        if (typeof timer.unref === 'function') timer.unref()
        probeRetryTimers.set(device.id, timer)
      }
      if (readProbedAt() === 0) {
        opts.logger.info('Initial probe did not complete — scheduling retry chain', {
          tags: { deviceId: device.id, addonId },
          meta: {
            firstRetryMs: PROBE_RETRY_BACKOFF_MS[0],
            totalAttempts: PROBE_RETRY_BACKOFF_MS.length,
          },
        })
        scheduleProbeRetry()
      }

      // Subscribe to feature-probe slice changes. When a late-arriving
      // probe write lands (driver finally got the lib response after our
      // timeout), or when something else writes the slice (manual
      // setCapState from a battery-cam wake event, …), re-run reconcile.
      // Reconcile is idempotent + side-effect-only on missing/orphan
      // children, so safe to call repeatedly. Skips probe re-execution
      // to avoid a write→subscribe→write loop.
      const RECONCILE_DEBOUNCE_MS = 500
      let reconcileTimer: ReturnType<typeof setTimeout> | null = null
      let lastReconciledLastProbedAt = 0
      const runtimeState = probeRtState
      if (runtimeState) {
        const initial = runtimeState.getCapState<{ lastProbedAt?: number }>('feature-probe')
        lastReconciledLastProbedAt = initial?.lastProbedAt ?? 0
        runtimeState.subscribeCap('feature-probe', (slice) => {
          const ts = (slice as { lastProbedAt?: number } | undefined)?.lastProbedAt ?? 0
          // Skip if the timestamp didn't advance — duplicate fires from
          // identical writes, or the inline reconcile we just ran.
          if (ts <= lastReconciledLastProbedAt) return
          // First successful probe landed AFTER the inline pass (late
          // probe): fire `DeviceReady` on the 0→>0 transition. The latch
          // ensures it's emitted at most once per device, never on a
          // subsequent re-probe.
          if (lastReconciledLastProbedAt === 0 && ts > 0) emitDeviceReadyOnce()
          lastReconciledLastProbedAt = ts
          // Cancel any pending probe-retry — the slice was populated by
          // an out-of-band path (driver `adoptApi`, manual reprobe, …),
          // so the next scheduled retry would run a redundant probe.
          cancelProbeRetry(device.id)
          if (reconcileTimer) clearTimeout(reconcileTimer)
          reconcileTimer = setTimeout(() => {
            reconcileTimer = null
            opts.logger.info('feature-probe slice updated — re-running accessory reconcile', {
              tags: { deviceId: device.id, addonId },
              meta: { lastProbedAt: ts },
            })
            void runReconcile().catch((err: unknown) => {
              opts.logger.warn('post-slice-update reconcile failed', {
                tags: { deviceId: device.id, addonId },
                meta: { error: err instanceof Error ? err.message : String(err) },
              })
            })
          }, RECONCILE_DEBOUNCE_MS)
        })
      }

      // Phase 5 — `onActivate()` is the post-probe, post-accessory
      // hook. Drivers do "device is now alive" work here: streaming
      // publish, snapshot tabs, watchdogs. Same timeout policy as
      // onProbe — a hung publishToBroker on a flaky camera must not
      // block restore for downstream devices.
      const ACTIVATE_TIMEOUT_MS = 20_000
      if (typeof lifecycleHost.onActivate === 'function') {
        try {
          await Promise.race([
            lifecycleHost.onActivate(),
            new Promise<void>((_, reject) =>
              setTimeout(
                () => reject(new Error(`onActivate timeout after ${ACTIVATE_TIMEOUT_MS}ms`)),
                ACTIVATE_TIMEOUT_MS,
              ),
            ),
          ])
        } catch (err) {
          opts.logger.warn(
            'device.onActivate() threw or timed out — registration is already complete',
            {
              tags: { deviceId: device.id, addonId },
              meta: { error: err instanceof Error ? err.message : String(err) },
            },
          )
        }
      }
    },

    /**
     * In-memory teardown — fires `removeDevice()` lifecycle, drops
     * native caps, removes from registry. Cascades through children.
     * Does NOT touch persisted state. Used both by `remove()` (which
     * follows up with the device-manager call) and by addon shutdown
     * paths that want the next boot to rehydrate the same devices.
     */
    decommission: async (deviceId: number): Promise<void> => {
      const device = registry.getById(deviceId)
      // Always cancel any pending probe-retry — even on the
      // "already decommissioned" idempotent path, a leftover timer
      // from a prior register cycle would fire against a removed
      // device's runtimeState.
      cancelProbeRetry(deviceId)
      if (!device) {
        // Idempotent — already decommissioned (or never registered in
        // this worker). Caller may invoke decommission as part of a
        // bulk shutdown loop where some entries already exited.
        return
      }
      const children = registry.getChildren(deviceId)
      for (const child of children) {
        await deviceApi.decommission(child.id)
      }
      const capsToUnregister = opts.capabilityRegistry
        ? [...opts.capabilityRegistry.getNativeCapsForDevice(deviceId)]
        : [...getWorkerNativeCapsForDevice(deviceId)]
      opts.capabilityRegistry?.unregisterAllNativeForDevice(deviceId)
      if (!opts.capabilityRegistry) clearWorkerNativeCapsForDevice(deviceId)
      for (const capName of capsToUnregister) {
        eventBus.emit({
          id: randomUUID(),
          timestamp: new Date(),
          source: { type: 'device', id: deviceId },
          category: EventCategory.DeviceBindingsChanged,
          data: { deviceId, capName, reason: 'native-unregistered', addonId, nodeId },
        })
        emitReadiness(eventBus, {
          capName,
          scope: { type: 'device', deviceId },
          state: 'down',
          generation: nativeCapReadinessGeneration,
          sourceNodeId: nodeId,
        })
      }
      await device.removeDevice().catch((err: unknown) => {
        opts.logger.warn('removeDevice() lifecycle threw during decommission', {
          tags: { deviceId, addonId },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
      registry.remove(deviceId)
    },

    applyDerivedSpec: async (
      deviceId: number,
      derived: {
        type?: import('@camstack/types').DeviceType
        role?: string
        config?: Record<string, unknown>
      },
    ): Promise<void> => {
      // Meta-only fields propagate via the existing idempotent setters.
      if (derived.type !== undefined) {
        await callDeviceManager(api, 'setType', { deviceId, type: derived.type }).catch(
          (err: unknown) => {
            opts.logger.warn('applyDerivedSpec: setType failed', {
              tags: { deviceId, addonId },
              meta: { error: err instanceof Error ? err.message : String(err) },
            })
          },
        )
      }
      if (derived.role !== undefined) {
        await callDeviceManager(api, 'setRole', { deviceId, role: derived.role }).catch(
          (err: unknown) => {
            opts.logger.warn('applyDerivedSpec: setRole failed', {
              tags: { deviceId, addonId },
              meta: { error: err instanceof Error ? err.message : String(err) },
            })
          },
        )
      }
      if (derived.config === undefined) return

      // Merge the patch over the persisted blob; only rebuild on a real change.
      const current = (await callDeviceManager(api, 'loadConfig', { deviceId }).catch(
        () => ({}),
      )) as Record<string, unknown>
      const merged: Record<string, unknown> = { ...current, ...derived.config }
      if (JSON.stringify(current) === JSON.stringify(merged)) return

      await callDeviceManager(api, 'persistConfig', { deviceId, data: merged })

      // Rebuild the live instance via its captured reconstruction factory so a
      // config that maps to a different class yields the new class. decommission
      // keeps the meta/config rows (name/location/id preserved); the factory
      // reconstructs from the merged config + persisted meta. Devices without a
      // registered factory (no live rebuild path) get the config persisted only.
      const rebuild = deviceRebuildFactories.get(deviceId)
      if (!rebuild) return
      // Load BEFORE tearing down: a refused load (D677) leaves the live
      // instance standing, running on the config it had.
      const construct = await rebuild(merged)
      await deviceApi.decommission(deviceId)
      await deviceApi.register(construct())
    },

    remove: async (deviceId: number): Promise<void> => {
      deviceRebuildFactories.delete(deviceId)
      const device = registry.getById(deviceId)
      if (!device) {
        // Allow remove on persisted-only orphans (no live IDevice in
        // this worker registry) — the device-manager call below still
        // cleans up the index/meta/config rows.
        await callDeviceManager(api, 'removeDevice', { deviceId })
        return
      }
      await deviceApi.decommission(deviceId)
      await callDeviceManager(api, 'removeDevice', { deviceId })
    },

    getAll: async (): Promise<ReadonlyArray<IDevice>> => {
      return registry.getAllForAddon(addonId)
    },

    getChildren: async (parentDeviceId: number): Promise<ReadonlyArray<IDevice>> => {
      return registry.getChildren(parentDeviceId)
    },
  }

  selfApi = deviceApi
  return deviceApi
}
