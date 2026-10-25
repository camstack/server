import * as path from 'node:path'
import type { SettingsRead } from './settings-read-guard.js'
import * as fs from 'node:fs'
import type { ServiceBroker } from 'moleculer'
import type {
  InternalAddonContext,
  AddonDeclaration,
  AddonApi,
  IStorageProvider,
  SystemEvent,
  IScopedLogger,
  CapabilityDefinition,
  InferProvider,
  DeviceBinding,
  DeviceProxy,
  IClusterBroker,
  ReadinessScope,
  StorageLocationDeclaration,
} from '@camstack/types'
import {
  createDeviceProxy,
  addonSliceHandleApi,
  createEventBusSliceSource,
  createRecordsAccess,
  createSecretsAccess,
  DisposerChain,
  errMsg,
  EventCategory,
  scopeKey,
} from '@camstack/types/addon'
import { CapabilityHandle } from '../capability-handle.js'
import { recordsTransportOf } from './records-api-transport.js'
import { createBrokerDeviceManagerApi } from './device-cap-proxy.js'
import { DeviceRegistry } from '../device-registry.js'
import type { CapabilityRegistry } from '../capability-registry.js'
import {
  localProviderLink,
  brokerTransportLink,
  ipcParentLink,
  type LocalProviderResolver,
  type CapUsageObservation,
  type CapUsageObserverOptions,
} from './trpc-links.js'
import type { CapCallInput } from '../transport/index.js'
import type { LocalChildClient } from '../transport/local-child-client.js'
import { getCapUsageRegistry } from './cap-usage-registry.js'
import { createTRPCClient, TRPCClientError, type TRPCLink } from '@trpc/client'
import type { AnyRouter } from '@trpc/server'
import { createKernelHwAccel } from '../hwaccel/hwaccel-resolver.js'
import { createKernelInferenceEngine } from '../inference/inference-resolver.js'
import { createAddonDataPlaneFacility, type DataPlaneSink } from './addon-data-plane-facility.js'
import { createAddonPeerBytesFacility } from './addon-peer-bytes-facility.js'
import { AddonDepsManager } from '../deps/addon-deps-manager.js'
import {
  asBrokerLike,
  createBrokerEventBus,
  getBrokerEventBus,
  registerEventBusService,
  setNodeEventInterest,
  getMoleculerEventStats,
  subscribePassthrough,
  clusterEventTopic,
  EVENT_TOPIC_PREFIX,
} from './event-bus.js'
import type { MoleculerEventStats } from './event-bus.js'
import { createUdsEventBus } from '../transport/uds-event-bus.js'
import { createUdsLogger } from '../transport/uds-logger.js'
import {
  createRemoteLogger,
  createRunnerLogger,
  setHubConnected,
  __resetHubConnectedForTests,
  __createRemoteLoggerForTests,
} from './remote-logger.js'
import {
  getRegistries,
  withAddonScope,
  getCurrentAddonId,
  setPreferredProvider,
  ensureBindingSubscription,
  __resetBindingSubscriptionForTests,
} from './provider-registry.js'
import {
  getOrInitReadinessRegistry,
  getOrInitReadinessRegistryForClient,
} from './readiness-context.js'
import { buildCapabilitiesAccess } from './capabilities-access.js'
import {
  createRunnerAddonSettings,
  type RunnerAddonSettingsClient,
} from './runner-addon-settings.js'
import { createRunnerDeviceSettings } from './runner-device-settings.js'

/**
 * Runtime backing for an addon context — the single discriminator that
 * decides whether the context talks to its peers over a Moleculer broker
 * (hub / agent / in-process addons) or over the UDS `LocalChildClient`
 * (a forked, broker-less `addon-runner` child, Phase F1+F2).
 *
 * - `mode: 'broker'` — UNCHANGED behaviour. Logger/eventBus/readiness are
 *   broker-backed, the tRPC chain ends in `brokerTransportLink`, and
 *   `ctx.kernel.{streamProbe,hwaccel,cluster}` route through the broker.
 * - `mode: 'uds'` — broker-less child. Logger/eventBus/readiness ride the
 *   UDS channel, the tRPC chain is `[localProviderLink, ipcParentLink]`
 *   (no broker, so no `brokerTransportLink`), and `ctx.kernel.streamProbe`
 *   routes via `ctx.api.streamProbe.*` (the `$core-caps` bridge reached
 *   through the parent's `onUnownedCall`). `cluster.broker` is omitted —
 *   the documented contract for forked workers.
 */
type ContextRuntime =
  | { readonly mode: 'broker'; readonly broker: ServiceBroker }
  | { readonly mode: 'uds'; readonly client: LocalChildClient; readonly nodeId: string }

/** This runtime's node id, regardless of mode (broker.nodeID or the UDS child nodeId). */
function runtimeNodeId(runtime: ContextRuntime): string {
  return runtime.mode === 'broker' ? asBrokerLike(runtime.broker).nodeID : runtime.nodeId
}

/**
 * Adapt a Moleculer ServiceBroker to the camstack-types `IClusterBroker`
 * structural interface so addons can consume cluster-level RPC without
 * pulling a moleculer dependency. Method signatures differ slightly
 * (Moleculer's overloads are wider than the camstack contract), so we
 * forward through a thin object instead of casting at the boundary.
 */
function adaptBrokerToCluster(broker: ServiceBroker): IClusterBroker {
  const bkr = asBrokerLike(broker)
  return {
    get nodeID() {
      return bkr.nodeID
    },
    call: <TParams = unknown, TResult = unknown>(
      action: string,
      params?: TParams,
      opts?: { nodeID?: string; timeout?: number },
    ): Promise<TResult> => bkr.call(action, params as unknown, opts as unknown) as Promise<TResult>,
    waitForServices: (service, timeout) => bkr.waitForServices(service, timeout) as Promise<void>,
    localBus: {
      on: (event, handler) => {
        bkr.localBus.on(event, handler as (data: unknown) => void)
      },
    },
  }
}

/**
 * Shared per-process live-device registry for forked addon workers.
 *
 * `[RTSP-FORK]` — every `AddonContext` created in this worker process
 * routes its `ctx.devices` through a `createBrokerDeviceManagerApi`
 * instance that pins its live `IDevice` instances into this single
 * registry. Hub-side persistence happens via `$hub.devices.*`. Module
 * scope is the right granularity here because Moleculer runs one
 * broker per process — every addon loaded into this child process
 * shares the same broker and therefore the same registry.
 */
const workerDeviceRegistry = new DeviceRegistry()

/**
 * Expose the per-process worker device registry so the process-runner can
 * mount the `device-ops-bridge` Moleculer service on top of the same live
 * IDevice instances that `createBrokerDeviceManagerApi` writes to.
 *
 * Hub-side contexts also share this module, but they pass their own
 * `opts.deviceRegistry` explicitly — nothing hub-side uses this accessor.
 */
export function getWorkerDeviceRegistry(): DeviceRegistry {
  return workerDeviceRegistry
}

/**
 * Options for enriching the addon context with infrastructure providers.
 * When the agent boots with core addons (storage, settings-store),
 * pass them here so deployed addons get full capabilities.
 */
interface AddonContextOptions {
  readonly storageProvider?: IStorageProvider
  readonly addonConfig?: Record<string, unknown>
  /** Custom logger factory — when set, overrides the default remote logger */
  readonly createLogger?: (addonId: string) => IScopedLogger
  /**
   * Hub `CapabilityRegistry`. When set, the `DeviceManagerApi` created
   * for this context wires `DeviceContext.registerNativeCap` through it
   * so device-driver addons can publish per-device native capability
   * providers. Forked-worker processes don't carry a CapabilityRegistry,
   * so this field is left undefined there — `registerNativeCap` becomes
   * unavailable on workers, which throw at runtime if called.
   */
  readonly capabilityRegistry?: CapabilityRegistry
  /**
   * UDS egress function for child→parent cap calls. When provided,
   * `ipcParentLink` is inserted between `localProviderLink` and
   * `brokerTransportLink` so addon-runner cap calls route over UDS
   * instead of through Moleculer when the parent owns the target cap.
   *
   * Returns `null` when the UDS channel is not yet connected (before
   * `LocalChildClient.start()` resolves), in which case `ipcParentLink`
   * no-ops and the call falls through to `brokerTransportLink`.
   *
   * Hub-side contexts omit this option; their link chain is unchanged.
   */
  readonly getParentCallOut?: () => ((input: CapCallInput) => Promise<unknown>) | null
  /**
   * Where this context's `ctx.dataPlane` publishes its live HTTP data-plane
   * endpoints. The forked addon-runner passes a sink writing into a per-addonId
   * map the hub pulls (`target: 'data-planes'`); the hub passes a sink writing
   * straight into its `DataPlaneRegistry` for co-located addons. Omitted → the
   * facility still serves locally but nothing advertises it (tests/isolation).
   */
  readonly dataPlaneSink?: DataPlaneSink
  /**
   * Per-addon storage-location declarations (one inner array per addon's
   * `camstack.addons[].storageLocations`). Surfaced on
   * `ctx.kernel.listStorageLocationDeclarations` so the storage-orchestrator
   * can seed the default locations (`addons-data:default`, …) on this node.
   *
   * The hub wires this from its AddonRegistry; agents/forked workers (which
   * build their context through this factory) MUST pass it too, or the
   * orchestrator seeds nothing and `sqlite-settings` aborts boot with
   * "No default storage location configured for type addons-data".
   */
  readonly listStorageLocationDeclarations?: () => StorageLocationDeclaration[][]
}

/**
 * Options for dispatching a remote native provider call. Injected into every
 * method input before the cap-router call so the server-side resolver can
 * route to the native (bypassing any wrapper) on the right node.
 */
interface RemoteNativeOptions {
  readonly nodeId: string
  readonly bypassWrapper: boolean
}

/**
 * Build a dynamic remote proxy for a capability's native provider. Each
 * method dispatches through the generated cap-router on the hub with
 * `nodeId` + `bypassWrapper: true` merged into the input object. The
 * cap-router codegen accepts extra input keys (see Phase 6 plan) so this
 * is forward-compat even before the server honours `bypassWrapper`.
 *
 * Irreducible bridge: `AddonApi` is a tRPC proxy — its dynamic shape
 * can't be type-checked against `cap.methods` at this layer. We cast at
 * the property-access boundary and validate structurally.
 */
function buildRemoteNativeProvider<TCap extends CapabilityDefinition>(
  api: AddonApi,
  cap: TCap,
  options: RemoteNativeOptions,
): InferProvider<TCap> {
  const capNameCamel = kebabToCamel(cap.name)
  const provider: Record<string, (input: unknown) => unknown> = {}
  for (const [methodName, methodSchema] of Object.entries(cap.methods)) {
    const callKind = methodSchema.kind === 'mutation' ? 'mutate' : 'query'
    provider[methodName] = async (input: unknown): Promise<unknown> => {
      const mergedInput = {
        ...(typeof input === 'object' && input !== null ? input : {}),
        nodeId: options.nodeId,
        bypassWrapper: options.bypassWrapper,
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
      const capRouter = (api as any)[capNameCamel]
      if (!capRouter) throw new Error(`AddonApi has no cap router '${capNameCamel}'`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
      const leaf = (capRouter as any)[methodName]
      if (!leaf) throw new Error(`cap '${cap.name}' has no method '${methodName}'`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
      const callable = (leaf as any)[callKind]
      if (typeof callable !== 'function') {
        throw new Error(`cap method '${cap.name}.${methodName}' not callable via .${callKind}()`)
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      return await callable(mergedInput)
    }
  }
  return provider as InferProvider<TCap>
}

function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

/**
 * Native-provider proxy for a UDS runner: every cap method dispatches
 * `native: true` over the child→parent channel, carrying `deviceId` both
 * out-of-band (for routing) and inside the args (where the provider reads it).
 *
 * Built from `cap.methods` rather than as a `Proxy` so an unknown method name
 * is a local `undefined` — a wrapper that probes for an optional method sees
 * the same shape it sees on the hub instead of a round-trip that fails.
 *
 * Irreducible bridge: the returned object is assembled by name at runtime, so
 * it is validated structurally against `InferProvider<TCap>` at this one seam
 * (same boundary `buildRemoteNativeProvider` casts at).
 */
function buildUdsNativeProvider<TCap extends CapabilityDefinition>(
  callOut: (method: string, args: unknown) => Promise<unknown>,
  cap: TCap,
  deviceId: number,
): InferProvider<TCap> {
  const provider: Record<string, (input: unknown) => Promise<unknown>> = {}
  for (const methodName of Object.keys(cap.methods)) {
    provider[methodName] = async (input: unknown): Promise<unknown> => {
      const args =
        typeof input === 'object' && input !== null && !Array.isArray(input)
          ? { ...(input as Record<string, unknown>), deviceId }
          : { deviceId }
      return await callOut(methodName, args)
    }
  }
  return provider as InferProvider<TCap>
}

/**
 * Broker-mode entry point — UNCHANGED public signature. The hub
 * (`addon-registry.service.ts`), the agent (`agent-bootstrap.ts`), and
 * every broker-mode test call this with a positional `ServiceBroker`.
 */
async function createAddonContext(
  broker: ServiceBroker,
  declaration: AddonDeclaration,
  dataDir: string,
  options?: AddonContextOptions,
): Promise<InternalAddonContext> {
  // TODO: moleculer's ServiceBroker has no upstream types — refine when
  // we wrap broker access behind a typed helper. Pre-existing waiver.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  return buildAddonContext({ mode: 'broker', broker }, declaration, dataDir, options)
}

/**
 * UDS-mode entry point — for a broker-less forked `addon-runner` child
 * (Phase F1+F2). Logger/eventBus/readiness ride the UDS channel; the tRPC
 * link chain is `[localProviderLink, ipcParentLink]` (no broker, so no
 * `brokerTransportLink`). `getParentCallOut` is implied by the client and
 * wired automatically — callers MUST NOT pass it in `options`.
 */
async function createUdsAddonContext(
  client: LocalChildClient,
  nodeId: string,
  declaration: AddonDeclaration,
  dataDir: string,
  options?: AddonContextOptions,
): Promise<InternalAddonContext> {
  return buildAddonContext({ mode: 'uds', client, nodeId }, declaration, dataDir, options)
}

async function buildAddonContext(
  runtime: ContextRuntime,
  declaration: AddonDeclaration,
  dataDir: string,
  options?: AddonContextOptions,
): Promise<InternalAddonContext> {
  const nodeId = runtimeNodeId(runtime)
  const addonId = declaration.id
  // Node-local data ROOT — the single source of truth for every internal
  // per-node working directory (addons-data, models, logs, data). NEVER the
  // hub-singleton `storage` cap (which would return the hub's path to every
  // node). `dataDir` is the node root the kernel was booted with; the operator
  // override is `CAMSTACK_DATA`. See the per-node-data-root design.
  const nodeDataDir = process.env['CAMSTACK_DATA'] ?? dataDir
  const addonDataDir = path.resolve(nodeDataDir, 'addons-data', addonId)
  fs.mkdirSync(addonDataDir, { recursive: true })

  // Wire the one-shot binding-changed subscription on the first context
  // created against this broker. Idempotent — subsequent calls are no-ops.
  // UDS-mode children have no broker; binding-change events arrive via the
  // UDS event bus and the per-context subscription below.
  if (runtime.mode === 'broker') {
    ensureBindingSubscription(runtime.broker)
  }

  // Per-node registries — isolated per nodeID so tests with multiple
  // brokers in the same process don't leak providers across nodes.
  const regs = getRegistries(nodeId)

  // Local provider resolver for the broker-api-proxy local-first check.
  const workerResolver: LocalProviderResolver = {
    // The node this addon runs on — lets localProviderLink defer a call pinned
    // to a DIFFERENT node instead of short-circuiting to a co-located provider
    // (e.g. a hub orchestrator pinning `model-convert` to an agent while the
    // hub also hosts that any-node cap).
    localNodeId: nodeId,
    getByName(capabilityName: string): unknown | null {
      const preferred = regs.preferred.get(capabilityName)
      if (preferred) {
        const byAddon = regs.byAddonId.get(capabilityName)
        const provider = byAddon?.get(preferred)
        if (provider) return provider
      }
      const providers = regs.providers.get(capabilityName)
      return (providers && providers.length > 0 ? providers[0] : undefined) ?? null
    },
  }

  // Build `ctx.api` — real tRPC client with local-first resolution.
  //
  // Link chain: localProviderLink → brokerTransportLink
  //
  // The localProviderLink intercepts calls to capabilities that have a
  // provider registered in this process (zero serialization). Unresolved
  // calls pass through to `brokerTransportLink`, which maps each tRPC
  // `op.path` to a Moleculer `<addonId>.<capName>.<method>` action and
  // dispatches via `broker.call(...)`.
  //
  // Both links share a `CapUsageObserverOptions`. Read what that DOES, not what
  // it sounds like: `getCapUsageRegistry()` is a per-process module singleton,
  // and in a forked runner this process is not hub-main — which is where the
  // reader (`nodes.getCapUsageGraph`) lives. So these observations stay in the
  // runner and nothing ever reads them. `localProviderLink` also only fires on
  // a CO-LOCATED provider, and `ipcParentLink` — the link every cross-process
  // call actually takes — has no observer at all.
  //
  // The traffic this graph exists to show is therefore recorded on the CALLEE
  // side instead, by the parent that owns the UDS connection and already knows
  // the caller: `LocalChildRegistry`'s `cap-call-out` handler, wired via
  // `LocalChildRegistryOptions.capUsageObserver` (which also lists the blind
  // spots that remain). This wiring is kept because it is the correct hook if
  // per-process usage is ever aggregated; today it is a local counter.
  const usageRegistry = getCapUsageRegistry()
  const observerOpts: CapUsageObserverOptions = {
    callerAddonId: addonId,
    providerAddonIdForCap: (capName: string): string | null => {
      // First match in the local registry; cross-process providers
      // resolve to the addon that registered the cap when known.
      const providers = regs.providers.get(capName)
      if (providers && providers.length > 0) {
        const byAddonId = regs.byAddonId.get(capName)
        if (byAddonId) {
          for (const [id] of byAddonId) return id
        }
      }
      return null
    },
    observer: (obs: CapUsageObservation): void => usageRegistry.recordCall(obs),
  }
  // Link chain by mode:
  //   broker: [localProviderLink, (ipcParentLink?), brokerTransportLink]
  //           — UNCHANGED; unresolved caps fall through to Moleculer.
  //   uds:    [localProviderLink, ipcParentLink(client.callOut)]
  //           — NO brokerTransportLink (the child has no broker). Caps no
  //             local sibling owns go child→parent over UDS via
  //             `ipcParentLink`, where the parent's `onUnownedCall`
  //             (resolver-first + broker-fallback for `$core-caps` /
  //             `$stream-probe` / core services) routes them (F0).
  const links: Array<TRPCLink<AnyRouter>> = [localProviderLink(workerResolver, observerOpts)]
  if (runtime.mode === 'uds') {
    const udsClient = runtime.client
    links.push(ipcParentLink(() => (input: CapCallInput) => udsClient.callOut(input)))
  } else {
    const parentCallOutGetter = options?.getParentCallOut
    if (parentCallOutGetter !== undefined) {
      links.push(ipcParentLink(parentCallOutGetter))
    }
    links.push(brokerTransportLink(runtime.broker, undefined, observerOpts))
  }
  const client: unknown = createTRPCClient({ links })
  const api = client as AddonApi

  // Build the logger + event bus once so the outer ctx and the
  // worker-side device manager share the same instances — no duplicate
  // broker subscriptions, no split event streams. UDS-mode children route
  // both over the `LocalChildClient` channel instead of the broker.
  const scopedLogger =
    options?.createLogger?.(addonId) ??
    (runtime.mode === 'broker'
      ? createRemoteLogger(runtime.broker, addonId)
      : createUdsLogger(runtime.client, addonId, nodeId))
  const scopedEventBus =
    runtime.mode === 'broker'
      ? createBrokerEventBus(runtime.broker, addonId)
      : createUdsEventBus(runtime.client, addonId)
  // One source for every DeviceProxy this context mints. `live.onEvent` is a
  // hub-main tRPC subscription and never reports UDS interest; the bus does.
  // Documented type boundary: AddonApi is the generated tRPC client; the
  // slice source only needs deviceState get/setCapSlice (same as
  // createLazyTrpcSource in generate-device-proxy.ts).
  const deviceSliceSource = createEventBusSliceSource({
    eventBus: scopedEventBus,
    api: addonSliceHandleApi(api),
  })

  // Per-context disposer chain backing `ctx.addDisposer(...)`. Drained
  // by the worker host (process-runner / group-runner) before the addon
  // is reloaded or the process is killed. Errors logged but never abort
  // sibling disposers — partial cleanup beats half-stopped state.
  const workerDisposerChain = new DisposerChain({
    onError: (err, index) => {
      scopedLogger.error(`Disposer #${index} threw during teardown`, {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    },
  })
  registerWorkerDisposerChain(nodeId, addonId, workerDisposerChain)

  // Client-side per-context binding cache. Invalidated by
  // `device.bindings-changed` events so cache stays fresh cluster-wide.
  // Keyed by numeric deviceId — events emitted by worker-side
  // `registerNativeCap` carry the numeric id in both `source.id` and
  // `data.deviceId`. Non-numeric payloads are a defensive fallback.
  const bindingCache = new Map<number, DeviceBinding>()
  scopedEventBus.subscribe({ category: EventCategory.DeviceBindingsChanged }, (e: SystemEvent) => {
    const data = (e.data ?? {}) as { deviceId?: unknown }
    if (typeof data.deviceId === 'number') {
      bindingCache.delete(data.deviceId)
      return
    }
    // Defensive fallback: clear the whole cache if a non-numeric
    // deviceId ever slips through.
    bindingCache.clear()
  })

  // Build a generic `ctx.settings` view backed by the `settings-store` cap.
  // The cap scopes every collection by the calling addon's ID, so the view
  // stores one JSON blob per addon under `addon-settings/root`, plus one
  // per device in the shared per-device store (D870). Section accessors delegate
  // through the same cap via `sections/<name>`.
  //
  // Routing: the cap is registered as an in-memory singleton on the hub.
  // Hub-local callers resolve it via `workerResolver`. Forked workers
  // reach it via the tRPC `settingsStore.*` procedures on `ctx.api` —
  // those links route through `brokerTransportLink` to the hub's cap
  // router, so writes from a worker hit the same SQLite store the hub
  // reads. The previous code silently no-op'd on workers (data loss
  // for every forkable addon's settings); now we always use the tRPC
  // `settingsStore` proxy regardless of where we're running.
  const settingsApi = Reflect.get(api as object, 'settingsStore') as
    | {
        get: { query: (i: unknown) => Promise<unknown> }
        set: { mutate: (i: unknown) => Promise<unknown> }
      }
    | undefined
  /**
   * Read a settings blob, distinguishing a MISS from a FAILURE.
   *
   * Collapsing the two is a data-loss bug, not a style choice: every mutation
   * is read-modify-write, so a failed read that answers "empty" makes the write
   * persist the patch ALONE and destroy every field the patch does not mention.
   * That is what emptied the recording configuration on 2026-07-31 when the UDS
   * transport stalled — `{"enabled": false, "bands": []}`, two and a half hours
   * of footage never written, and nothing that looked like a fault.
   *
   * No `settingsStore` router at all is a read that could not happen, so it is
   * a FAILURE too (D651 fix round 4): `missing` here told `readStoredGlobalKey`
   * "nobody wrote this key" about a store nobody reached.
   */
  const readBlobResult = async (
    coll: string,
    key: string,
    namespace?: string,
  ): Promise<SettingsRead> => {
    if (!settingsApi) return { kind: 'failed', error: 'settings store not wired' }
    try {
      const v = await settingsApi.get.query(
        namespace !== undefined ? { namespace, collection: coll, key } : { collection: coll, key },
      )
      return v && typeof v === 'object'
        ? { kind: 'value', value: v as Record<string, unknown> }
        : { kind: 'missing' }
    } catch (err) {
      return { kind: 'failed', error: errMsg(err) }
    }
  }

  /**
   * Soft read for CONSUMERS: a failure reads as empty so a boot path degrades
   * to defaults instead of throwing. The degradation is never SILENT — a
   * consumer that got `{}` because the store did not answer looks identical to
   * one whose store is genuinely empty, and downstream that difference decides
   * whether an addon runs on the operator's configuration or on its
   * constructor defaults.
   *
   * "Safe because the result is never written back" is what this docblock used
   * to claim, and it was a leftover that read as verification.
   * `BaseAddon.resolveConfig` reads THIS function through
   * `ctx.settings.readAddonStore()`; the defaults it falls back to then become
   * the values the addon's next `updateGlobalSettings` patch carries into the
   * store. That is how the Home Assistant export lost its membership on
   * 2026-08-24 — see `brokerRefreshPatch` in the ha-export addon for the other
   * half of that story. The line below is the only warning that this window is
   * open at all.
   */
  const readBlob = async (
    coll: string,
    key: string,
    namespace?: string,
  ): Promise<Record<string, unknown>> => {
    const r = await readBlobResult(coll, key, namespace)
    if (r.kind === 'failed') {
      scopedLogger.error(
        `settings read FAILED (${coll}/${key}) — answering empty, this caller now sees DEFAULTS`,
        { meta: { addonId, collection: coll, key, namespace, error: r.error } },
      )
      return {}
    }
    return r.kind === 'value' ? r.value : {}
  }

  const writeBlob = async (
    coll: string,
    key: string,
    value: Record<string, unknown>,
    namespace?: string,
  ): Promise<void> => {
    if (!settingsApi) return
    try {
      await settingsApi.set.mutate(
        namespace !== undefined
          ? { namespace, collection: coll, key, value }
          : { collection: coll, key, value },
      )
    } catch (err) {
      // Settings writes from a forked runner are best-effort persistence:
      // the settings-store is hub-resident, so any failure (hub down, Moleculer
      // timeout, UDS transport error) is a transient infrastructure issue —
      // not a bug in the addon's logic. Crashing the runner or propagating
      // a rejected promise to fire-and-forget callers (`void writeAddonStore(...)`)
      // creates an unhandledRejection that terminates the process (pre-fix) or
      // floods logs with misleading CRASH markers.
      //
      // `TRPCClientError` covers transport failures (UDS channel error,
      // "discovery deadline exceeded", "parent could not route"). Non-transport
      // errors (e.g. validation errors from the server) use the same client
      // error class in tRPC v11, so we log ALL write failures here and absorb
      // them — the caller can keep running with in-memory/default state and the
      // value will be persisted on the next successful write (e.g. after hub
      // reconnect triggers `onHubReachable`).
      const isTrpcError = err instanceof TRPCClientError
      scopedLogger.warn(
        `settings write failed (${coll}/${key}) — ${isTrpcError ? 'transport error' : 'store error'}`,
        {
          meta: { collection: coll, key, error: errMsg(err) },
        },
      )
    }
  }
  const deviceSettingsClient: RunnerAddonSettingsClient | undefined = Reflect.get(
    api as object,
    'settingsStore',
  )
  const settingsView = {
    // Addon-level settings and sections: the ONE store every process shares
    // (D870) - the same modules hub-main's view uses, over this runner's client.
    ...createRunnerAddonSettings(deviceSettingsClient, addonId),
    // Per-device settings: the same.
    ...createRunnerDeviceSettings(deviceSettingsClient, addonId),
    // Runtime state lives in a separate `device-runtime-state`
    // collection — never the per-device settings rows — so
    // the addon's config schema (host, password, …) and the runtime
    // signals (battery, sleeping, …) round-trip through orthogonal
    // keyspaces. Replace semantics: `DeviceRuntimeState` always
    // hands over the FULL persistent slice, the kernel just stores
    // the latest blob.
    async readDeviceRuntimeState(deviceId: number): Promise<Record<string, unknown>> {
      return readBlob('device-runtime-state', String(deviceId))
    },
    async writeDeviceRuntimeState(deviceId: number, data: Record<string, unknown>): Promise<void> {
      await writeBlob('device-runtime-state', String(deviceId), data)
    },
    async clearDeviceRuntimeState(deviceId: number): Promise<void> {
      await writeBlob('device-runtime-state', String(deviceId), {})
    },
  }

  // Mode-aware readiness registry getter. Broker mode hydrates via
  // `$readiness.getSnapshot` + `$node.connected`/`$services.changed`; UDS
  // mode hydrates via `client.requestReadinessSnapshot()` on connect. Both
  // ingest live `system.ready-state` deltas through `scopedEventBus`, so
  // `awaitReady`/`acquireCapability`/`onReadyState` semantics are identical.
  const readinessRegistry = (): import('@camstack/types').ReadinessRegistry =>
    runtime.mode === 'broker'
      ? getOrInitReadinessRegistry(runtime.broker, scopedEventBus, scopedLogger)
      : getOrInitReadinessRegistryForClient(runtime.client, scopedEventBus, scopedLogger, nodeId)

  // Per-addon handle cache keyed by "${capName}::${scopeKey(scope)}".
  // Same instance is returned for repeated useCapability/acquireCapability calls.
  const capHandleCache = new Map<string, CapabilityHandle<unknown>>()

  function getOrCreateHandle<T>(
    capName: string,
    scope: ReadinessScope,
    timeoutMs: number,
  ): CapabilityHandle<T> {
    const key = `${capName}::${scopeKey(scope)}`
    const existing = capHandleCache.get(key)
    if (existing) return existing as CapabilityHandle<T>
    const registry = readinessRegistry()
    const handle = new CapabilityHandle<T>(capName, scope, registry, timeoutMs)
    capHandleCache.set(key, handle as CapabilityHandle<unknown>)
    return handle
  }

  // HTTP data-plane facility (`ctx.dataPlane`). Binds a localhost listener in
  // this process on first `serve()`; the hub reverse-proxies to it. Endpoints are
  // published through the sink (forked runner → hub pull, or hub-direct registry).
  const dataPlaneFacility = createAddonDataPlaneFacility({
    addonId,
    logger: scopedLogger,
    ...(options?.dataPlaneSink !== undefined ? { sink: options.dataPlaneSink } : {}),
  })
  workerDisposerChain.add(() => dataPlaneFacility.dispose())

  // Addon→addon byte transport (`ctx.peerBytes`, D613). One lazy loopback
  // listener per process, bound on the first `offer()`. `nodeId` is this
  // runner's (`<hostNode>/<runnerId>`); the facility keeps only the HOST part,
  // which is the only thing loopback reachability is a fact about.
  const peerBytesFacility = createAddonPeerBytesFacility({
    addonId,
    logger: scopedLogger,
    nodeId,
  })
  workerDisposerChain.add(() => peerBytesFacility.dispose())

  // This addon's keychain values (D787). The input carries NO identity: the
  // parent (or, on an agent, the agent and then `$hub-cap-fwd`) stamps who
  // is calling from the connection the call arrived on.
  const secrets = createSecretsAccess({
    owner: addonId,
    transport: {
      put: (input) => api.keychain.put.mutate({ ref: input.ref, value: input.value }),
      resolve: (input) => api.keychain.resolve.query({ refs: [...input.refs] }),
      delete: (input) => api.keychain.delete.mutate({ refs: [...input.refs] }),
      getState: () => api.keychain.getState.query({}),
    },
    eventBus: scopedEventBus,
  })

  const context: InternalAddonContext = {
    id: addonId,
    logger: scopedLogger,
    eventBus: scopedEventBus,
    addonConfig: options?.addonConfig ?? {},
    dataDir: addonDataDir,
    nodeDataDir,
    dataPlane: dataPlaneFacility.dataPlane,
    peerBytes: peerBytesFacility.peerBytes,
    api,
    deps: new AddonDepsManager(addonDataDir, scopedLogger),
    settings: settingsView,
    // This addon's keychain values (D787). The input carries NO identity: the
    // parent (or, on an agent, the agent and then `$hub-cap-fwd`) stamps who
    // is calling from the connection the call arrived on.
    secrets,
    // This addon's record kinds (D881). Same identity model as `secrets`: the
    // calls carry no owner, the transport stamps who is calling.
    records: createRecordsAccess({
      owner: addonId,
      transport: recordsTransportOf(api),
      secrets,
      logger: scopedLogger,
    }),
    kernel: (() => {
      // stream-probe routing differs by mode:
      //   broker: direct `broker.call('$stream-probe.*')` — same ffprobe
      //           cache on the hub, hub-hosted.
      //   uds:    route through `ctx.api.streamProbe.*` (mutations on the
      //           `streamProbe` core-cap router). The child has no broker;
      //           the call rides `ipcParentLink` → the parent's
      //           `onUnownedCall` → `$core-caps.stream-probe.*` over the
      //           hub broker. Same ffprobe cache, same hub-side service.
      // Providers that call `ctx.kernel.streamProbe.probe(url)` don't need
      // to know where they run. The same instance is mirrored onto every
      // `DeviceContext` via `DeviceManagerApi.streamProbe`.
      const streamProbe: import('@camstack/types').IKernelStreamProbe =
        runtime.mode === 'broker'
          ? {
              probe: (url, probeOptions) =>
                asBrokerLike(runtime.broker).call('$stream-probe.probe', {
                  url,
                  force: probeOptions?.force ?? false,
                }),
              probeField: (key, value) =>
                asBrokerLike(runtime.broker).call('$stream-probe.probeField', {
                  key,
                  value,
                }),
            }
          : {
              probe: (url, probeOptions) =>
                api.streamProbe.probe.mutate({ url, force: probeOptions?.force ?? false }),
              probeField: (key, value) => api.streamProbe.probeField.mutate({ key, value }),
            }
      // Local in-process hwaccel. Each node (hub + forked worker +
      // remote agent) has its own instance that probes the host it
      // runs on, so `ctx.kernel.hwaccel.resolve()` always returns the
      // correct backend list for the caller's hardware. Cross-node
      // hwaccel queries for the admin UI go through the `platform-probe`
      // cap (node-pinned), not a bespoke Moleculer service.
      const hwaccel = createKernelHwAccel({ logger: scopedLogger })
      // Local in-process inference-hardware resolver — same model as hwaccel.
      // Each node resolves its OWN accelerators, so the detection-pipeline never
      // adopts a remote node's runtime from the `platform-probe` singleton.
      const inferenceEngine = createKernelInferenceEngine()
      return {
        localNodeId: nodeId,
        storage: options?.storageProvider ?? undefined,
        // The orchestrator (storage-orchestrator, pipeline-orchestrator …)
        // pattern queries `ctx.kernel.capabilityRegistry.getCollection(…)`
        // to discover sibling providers. Mirror the server/backend
        // contract so agent + forked-worker contexts behave the same as
        // hub contexts.
        capabilityRegistry: options?.capabilityRegistry,
        // Storage-location declarations for this node's storage-orchestrator
        // first-boot seeding. Omitted on hub contexts (the server wires its
        // own); agents/workers pass it from their AddonLoader.
        ...(options?.listStorageLocationDeclarations
          ? { listStorageLocationDeclarations: options.listStorageLocationDeclarations }
          : {}),
        readinessRegistry: readinessRegistry(),
        // Expose the per-process device registry so worker-side providers
        // (e.g. provider-reolink running in its own addon-runner) can
        // route cap events to their own live IDevice instances. Without this,
        // `BaseDeviceProvider.ownsDevice` and any addon-side
        // `deviceRegistry.getById` lookup would always return null on
        // workers — silently dropping push-stream demand events and the
        // online/offline transitions that depend on `ownsDevice`.
        //
        // Worker registries only ever hold devices owned by addons in
        // THIS process, which is exactly the visibility a provider needs
        // to dispatch cluster-wide cap events back to its local devices.
        deviceRegistry: workerDeviceRegistry,
        devices: createBrokerDeviceManagerApi({
          api,
          addonId,
          nodeId,
          logger: scopedLogger,
          eventBus: scopedEventBus,
          registry: workerDeviceRegistry,
          capabilityRegistry: options?.capabilityRegistry,
          streamProbe,
          // Native-cap registration sink for `registerNativeCap`:
          //   hub:    capabilityRegistry (direct registration)
          //   broker: the broker (mounts the `<addon>.native-provider.*`
          //           Moleculer service + populates `workerNativeCaps`)
          //   uds:    `udsMode` (populates `workerNativeCaps` ONLY — the
          //           UDS dispatch in addon-runner reads that map; there is
          //           no Moleculer service to mount).
          ...(options?.capabilityRegistry
            ? {}
            : runtime.mode === 'broker'
              ? // TODO: same upstream moleculer typing issue as above. Pre-existing waiver.
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                { broker: runtime.broker }
              : { udsMode: true }),
        }),
        // `cluster.broker` is broker-mode only. The documented contract is
        // that forked (UDS) workers do NOT see `ctx.kernel.cluster.broker`
        // — they reach the cluster through `ctx.api` over UDS.
        ...(runtime.mode === 'broker'
          ? { cluster: { broker: adaptBrokerToCluster(runtime.broker) } }
          : {}),
        streamProbe,
        hwaccel,
        inferenceEngine,
      }
    })(),
    registerProvider(capabilityName: string, provider: unknown): void {
      const existing = regs.providers.get(capabilityName) ?? []
      if (!existing.includes(provider)) existing.push(provider)
      regs.providers.set(capabilityName, existing)

      const byAddon = regs.byAddonId.get(capabilityName) ?? new Map<string, unknown>()
      const scopedAddonId = getCurrentAddonId()
      if (scopedAddonId) {
        byAddon.set(scopedAddonId, provider)
      } else {
        byAddon.set(addonId, provider)
      }
      regs.byAddonId.set(capabilityName, byAddon)
    },
    resolveProvider<T = unknown>(capabilityName: string): T | null {
      const preferred = regs.preferred.get(capabilityName)
      if (preferred) {
        const byAddon = regs.byAddonId.get(capabilityName)
        const provider = byAddon?.get(preferred)
        if (provider) return provider as T
      }
      const providers = regs.providers.get(capabilityName)
      return (
        ((providers && providers.length > 0 ? providers[0] : undefined) as T | undefined) ?? null
      )
    },
    getNativeProvider<TCap extends CapabilityDefinition>(
      cap: TCap,
      deviceId: number,
    ): InferProvider<TCap> | null {
      // Hub path: the CapabilityRegistry is the single source of truth for
      // native providers. It tracks in-process registrations (set by
      // `DeviceContext.registerNativeCap` on the hub) AND, via
      // `setNativeFallback`, dispatches to forked-worker natives published
      // over the standard `<addonId>.native-provider.<capName>` Moleculer
      // surface. A null result means no addon has published the cap for
      // this device — wrappers use that signal to fall back to their own
      // strategy (e.g. snapshot's ffmpeg frame grab) instead of calling a
      // phantom service.
      if (options?.capabilityRegistry) {
        return options.capabilityRegistry.getNativeProvider<InferProvider<TCap>>(cap.name, deviceId)
      }

      // UDS runner path: ask the PARENT for the native, out of band.
      //
      // Not `ctx.api.<cap>.<method>`, and this is the whole point. That route
      // resolves by cap NAME, and a wrapper shares its name with its natives:
      // `localProviderLink` would answer from this runner's own provider
      // without the call ever reaching the socket, and the parent's
      // `resolveChildId` would send it back here if it did. Either way a
      // wrapper asking for its native calls ITSELF — the second entry joins the
      // first's single flight and waits for a promise only it can settle. The
      // `native: true` hint routes through the parent's one native authority
      // instead (`CapabilityRegistry.getNativeProvider`), which covers
      // in-process natives, hub-local vendor children and remote agents.
      //
      // Non-null by construction, like the broker path below: absence shows up
      // as a rejection ("no native provider for capability …"), which is what
      // wrappers already match on before falling through to their own strategy.
      if (runtime.mode === 'uds') {
        const udsClient = runtime.client
        return buildUdsNativeProvider<TCap>(
          (method, args) =>
            udsClient.callOut({ capName: cap.name, method, args, deviceId, native: true }),
          cap,
          deviceId,
        )
      }

      // Worker path: no local CapabilityRegistry (the worker's context is
      // built without one). A worker addon that wants to reach a native
      // provider on the hub dispatches through the tRPC cap-router with
      // `bypassWrapper: true`. This builds the same proxy shape as the hub
      // path; calls surface real errors from the router if the native is
      // not registered — worker consumers can propagate or handle them.
      return buildRemoteNativeProvider<TCap>(api, cap, { nodeId: 'hub', bypassWrapper: true })
    },
    fetchDevice: async (deviceId: number): Promise<DeviceProxy> => {
      const cached = bindingCache.get(deviceId)
      if (cached) return createDeviceProxy(api, cached, { stateSource: deviceSliceSource })
      const binding = await api.deviceManager.getBindings.query({ deviceId })
      bindingCache.set(deviceId, binding)
      return createDeviceProxy(api, binding, { stateSource: deviceSliceSource })
    },
    useCapability<T = unknown>(capName: string, scope: ReadinessScope = { type: 'global' }) {
      // Default `timeoutMs = Infinity` — `handle.call(fn)` blocks until
      // the cap is ready. Cameras / dispatchers should NEVER fall back
      // to a placeholder engine because a cap took longer than 15s.
      return getOrCreateHandle<T>(capName, scope, Number.POSITIVE_INFINITY)
    },
    async acquireCapability<T = unknown>(
      capName: string,
      scope: ReadinessScope = { type: 'global' },
      opts: { timeoutMs?: number } = {},
    ) {
      // Default `Infinity` (wait forever). Pass an explicit finite
      // `timeoutMs` only when the caller has a real deadline. The
      // ReadinessRegistry honours `Infinity` natively (no setTimeout).
      const timeoutMs = opts.timeoutMs ?? Number.POSITIVE_INFINITY
      const handle = getOrCreateHandle<T>(capName, scope, timeoutMs)
      await handle.awaitReady(timeoutMs)
      return handle
    },
    onCapabilityStateChange(
      capName: string,
      scope: ReadinessScope,
      handler: (state: 'ready' | 'down') => void,
    ) {
      const registry = readinessRegistry()
      return registry.onReadyState(capName, scope, (t) => {
        handler(t.state === 'ready' ? 'ready' : 'down')
      })
    },
    addDisposer(fn: () => void | Promise<void>) {
      return workerDisposerChain.add(fn)
    },
    /**
     * Cluster-wide capability accessor for forked workers + remote agents.
     *
     * `getCollection*` merges:
     *   1. The worker's local registry (`regs.providers`) — providers this
     *      addon (or co-tenant addons in the same process) registered locally.
     *   2. Every Moleculer service in the cluster whose metadata advertises
     *      the capability (hub-in-process providers + sibling workers +
     *      remote agents). For each remote entry we return a transparent
     *      Proxy that dispatches `provider.method(args)` to
     *      `broker.call(<serviceName>.<capName>.<method>, args, {nodeID})`.
     *
     * Same surface as the hub-side `CapabilitiesAccess` (see
     * AddonRegistryService) so addons can use `ctx.capabilities` uniformly
     * regardless of placement. `hub-only` orchestrators that need to
     * enumerate a collection (mesh, network-access, auth, …) now work
     * correctly even when running in their own forked addon-runner — they
     * read the cluster view here.
     */
    capabilities: buildCapabilitiesAccess(
      runtime.mode === 'broker' ? runtime.broker : undefined,
      regs,
    ),
  }
  return context
}

// =============================================================================
// Worker disposer chain registry
//
// Per-worker map keyed by `<brokerNodeId>::<addonId>` storing the
// DisposerChain that backs `ctx.addDisposer(...)` for each worker-side
// AddonContext. The worker host (process-runner / group-runner) calls
// `drainWorkerDisposerChain(broker.nodeID, addonId)` before the addon
// is reloaded or before the process is killed, so cleanup callbacks
// run inside the same process that registered them.
// =============================================================================

const workerDisposerChains = new Map<string, DisposerChain>()

function disposerChainKey(nodeId: string, addonId: string): string {
  return `${nodeId}::${addonId}`
}

function registerWorkerDisposerChain(nodeId: string, addonId: string, chain: DisposerChain): void {
  workerDisposerChains.set(disposerChainKey(nodeId, addonId), chain)
}

/**
 * Drain (and forget) the disposer chain for a worker-side addon. Idempotent:
 * subsequent calls are no-ops. Called by process-runner / group-runner
 * before reload or graceful shutdown so resources clean up before the
 * next addon instance loads.
 */
async function drainWorkerDisposerChain(nodeId: string, addonId: string): Promise<void> {
  const key = disposerChainKey(nodeId, addonId)
  const chain = workerDisposerChains.get(key)
  if (chain == null) return
  workerDisposerChains.delete(key)
  await chain.dispose()
}

export {
  createAddonContext,
  createUdsAddonContext,
  setHubConnected,
  adaptBrokerToCluster,
  drainWorkerDisposerChain,
  registerEventBusService,
  setNodeEventInterest,
  getMoleculerEventStats,
  subscribePassthrough,
  clusterEventTopic,
  EVENT_TOPIC_PREFIX,
  getBrokerEventBus,
  // Re-exported from extracted modules so existing import paths keep resolving.
  withAddonScope,
  setPreferredProvider,
  createRunnerLogger,
  __resetHubConnectedForTests,
  __resetBindingSubscriptionForTests,
  __createRemoteLoggerForTests,
}
export type { AddonContextOptions, MoleculerEventStats }
