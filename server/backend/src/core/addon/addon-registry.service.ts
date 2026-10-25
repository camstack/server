/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access -- pre-existing lint debt across this 2200-line orchestration class. The flagged sites (StorageService.setLocationManager / setSettingsBackend, LoggingService.addDestination, RouteRegistry, etc.) are typed as `unknown` by their owning services to break circular construction-order dependencies; runtime contracts are validated structurally. Tracked separately; do not amend in unrelated edits. */

import {
  describeAddonProcess,
  NEVER_LOADED_PROCESS,
  type AddonProcessView,
  type RunnerProcessRow,
} from './addon-process-view.js'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { DataPlaneSink, RegisteredChild } from '@camstack/system'
import {
  AddonDepsManager,
  AddonHealthMonitor,
  type AddonHealthSnapshot,
  AddonLoader,
  AddonRouteRegistry,
  type AddonSettingsView,
  adaptBrokerToCluster,
  addonSettingsCapability,
  brokerTransportLink,
  CapabilityHandle,
  CapabilityRegistry,
  CustomActionRegistry,
  canServeDataPlane,
  createAddonDataPlaneFacility,
  createAddonPeerBytesFacility,
  createAddonService,
  createBrokerDeviceManagerApi,
  createKernelHwAccel,
  DataPlaneRegistry,
  DeviceRegistry,
  describeProviderKindDrift,
  catalogNamespaceOf,
  deviceCapResolverLink,
  getCatalogRegistry,
  INFRA_CAPABILITIES,
  IntegrationRegistry,
  clusterAgentRecordKinds,
  clusterNodeHistoryRecordKind,
  integrationRegistryRecordKinds,
  type ISettingsStore,
  localProviderLink,
  partitionIsolatedBuiltinIds,
  runHubAddonBoot,
  scopeKey,
  validateProviderRegistrations,
  waitUntilReady,
  asBrokerLike,
} from '@camstack/system'
import type {
  AddonContext,
  AddonDeclaration,
  CapabilityDeclaration,
  CapabilityDefinition,
  DeviceMetaLike,
  ICamstackAddon,
  IStorageProvider as INewStorageProvider,
  InferProvider,
  InternalAddonContext,
  IScopedLogger,
  ISettingsBackend,
  ISettingsStoreProvider,
  ReadinessScope,
  RunnerAddonPlacement,
  RunnerPlan,
  SavedDevice,
  IKeychainProvider,
  IRecordsProvider,
  KeychainTransport,
  RecordsAccess,
  RecordsTransport,
  SecretsAccess,
} from '@camstack/types'
import {
  ALL_CAPABILITY_DEFINITIONS,
  createDeviceProxy,
  createRecordsAccess,
  createSecretsAccess,
  DisposerChain,
  EventCategory,
  errMsg,
  isAgentOnlyPlacement,
  isIsolatedBuiltin,
  normalizeAddonInitResult,
  resolveAddonPlacement,
  resolveRunnerId,
  SHARE_VIEW_KINDS,
} from '@camstack/types'
import { createTRPCClient } from '@trpc/client'
import { createHubAddonApi } from './hub-addon-api.js'
import { CapabilityService } from '../capability/capability.service'
import { ConfigService } from '../config/config.service'
import { EventBusService } from '../events/event-bus.service'
import { LoggingService } from '../logging/logging.service'
import { MoleculerService } from '../moleculer/moleculer.service'
import { StorageService } from '../storage/storage.service'
import { StreamProbeService } from '../streaming/stream-probe.service'
import { AddonCallGateway } from './addon-call-gateway.js'
import { overlayDeclaration } from './addon-row-manifest'
import { createAddonSettingsProvider } from './addon-settings-provider.js'
import { DeviceMetaMirror } from './device-meta-mirror.js'
import {
  childCatalogsFingerprint,
  summarizeChildCatalogs,
  toForkedCustomActionsSpec,
} from './forked-custom-actions.js'
import { createFilteredIntegrationRegistry } from './integration-visibility.js'
import type { ClusterNodeHistoryStore } from '../agent/cluster-node-history-store.js'
import { coreAuthRecordKinds } from '../auth/record-kinds.js'
import type { CredentialTokenService } from '../auth/credential-token.service.js'
import { materializeRoutePath } from './materialize-route-path.js'
import { resolveHubClosurePackageDir } from './package-dir-utils'
import { decidePrune, prunePlacementLeftovers } from './prune-misplaced-addons.js'
import { planRunnerConvergence, type RunnerProcessSnapshot } from './runner-convergence'
import { createRunnerSerializer, type RunnerSerializer } from './runner-serialization'
import { spawnPlanConcurrently } from './runner-spawn-fanout.js'
import { wireSettingsDoor } from './settings-door-wiring.js'

type AddonSource = 'core' | 'installed'

/**
 * The subset of an addon entry the on-disk-diff eviction decision reads.
 */
export interface EvictionCandidate {
  source: AddonSource
  packageName: string
}

/**
 * Decide whether an in-memory addon entry should be evicted because it is no
 * longer on disk (the uninstall path in `loadNewAddons`).
 *
 * A `@camstack/system` builtin is NEVER evicted here: the fresh loader scans
 * `addonsDir` only (no `['@camstack/system']` closure include), so builtins
 * are never in `onDiskIds`, and their lifecycle is the server closure
 * (single-copy model), not the data/addons uninstall path. Omitting this guard
 * let a deploy of an unrelated addon silently unregister loki-logging on the
 * live hub.
 */
export function shouldEvictMissingOnDisk(
  entry: EvictionCandidate,
  id: string,
  onDiskIds: ReadonlySet<string>,
): boolean {
  return (
    entry.source === 'installed' && entry.packageName !== '@camstack/system' && !onDiskIds.has(id)
  )
}

/**
 * The `data` an `addon.updated` lifecycle event carries.
 *
 * An index signature rather than a closed interface: the emitter takes
 * `Record<string, unknown>`, and a closed readonly shape is not assignable to
 * it. The two named members are what every consumer reads.
 */
export type AddonUpdatePayload = {
  readonly fromVersion?: string
  readonly toVersion: string
  readonly [key: string]: unknown
}

/**
 * The versions an `addon.updated` event states.
 *
 * `fromVersion === null` means the hub could not read what was installed
 * before — a first install, or a tree with no readable `package.json` — and
 * the key is then ABSENT, not present-and-empty. It used to arrive as the
 * literal `'0.0.0'`, which the notification centre printed verbatim: the
 * operator read "@camstack/addon-terminal 0.0.0 → latest" on his phone and
 * had no way to tell that neither number was real (2026-08-30). An absent key
 * the renderer leaves out is the honest form of "unknown"; a version-shaped
 * placeholder is a claim.
 *
 * `toVersion` is never optional — it is what separates a package update from a
 * settings save, which emits the same category carrying no versions at all
 * (`parseAddonUpdateComplete`).
 */
export function addonUpdatePayload(
  fromVersion: string | null,
  toVersion: string,
): AddonUpdatePayload {
  return {
    ...(fromVersion !== null ? { fromVersion } : {}),
    toVersion,
  }
}

function isAddonDeclaration(value: unknown): value is AddonDeclaration {
  if (typeof value !== 'object' || value === null) return false
  const id = Reflect.get(value, 'id')
  return typeof id === 'string' && id.length > 0
}

/**
 * Local narrowing of the Moleculer ServiceBroker surface we actually use.
 * See the `broker` getter docstring below for why this is necessary.
 */
interface BrokerLike {
  call<T = unknown>(
    action: string,
    params?: unknown,
    opts?: { nodeID?: string; timeout?: number },
  ): Promise<T>
  nodeID: string
  createService(schema: unknown): unknown
}

/**
 * Type predicate: true when an `ISettingsBackend` also satisfies the
 * sync `ISettingsStore` contract (system/addon/device key-value ops)
 * that ConfigManager expects. The default `SqliteSettingsBackend` in
 * `@camstack/system` implements both surfaces; forked addon backends may
 * not, in which case we skip the ConfigService wiring.
 */
function isSettingsStore(backend: ISettingsBackend): backend is ISettingsBackend & ISettingsStore {
  const required: readonly (keyof ISettingsStore)[] = [
    'getSystem',
    'setSystem',
    'getAllSystem',
    'getAllAddon',
    'setAllAddon',
    'getDeviceRuntimeState',
    'setDeviceRuntimeState',
    'clearDeviceRuntimeState',
  ]
  for (const key of required) {
    if (typeof Reflect.get(backend, key) !== 'function') return false
  }
  return true
}

/**
 * The bridge-dispatch contract on an `addon-routes` provider. The operator-
 * facing `IAddonRouteProvider` interface declares only `id` + `getRoutes`; the
 * UDS proxy (and `buildAddonRouteProvider`) also expose `invoke`, which the
 * forked-routes bridge calls per request. Narrowed via `isAddonRoutesInvoker`.
 */
interface AddonRoutesInvoker {
  invoke(
    input: import('@camstack/types').AddonRouteInvokeRequest,
  ): Promise<import('@camstack/types').AddonRouteReplyEnvelope>
}

/** Structural guard: true when an `addon-routes` provider also exposes `invoke`. */
function isAddonRoutesInvoker<T extends object>(provider: T): provider is T & AddonRoutesInvoker {
  return typeof Reflect.get(provider, 'invoke') === 'function'
}

/**
 * Window within which a second `restart:true` respawn of the SAME group runner
 * is coalesced to a no-op (a package reload loops `restartAddon` over every
 * group member — see `recentGroupRespawns`). Chosen comfortably longer than a
 * single group respawn (child fork + init) so all members of one reload pass
 * fall inside it, and short enough that a genuinely independent later restart
 * still respawns.
 */
const GROUP_RESPAWN_COALESCE_MS = 10_000

const ROUTE_METHODS: readonly import('@camstack/types').IAddonHttpRoute['method'][] = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
]
const ROUTE_ACCESS: readonly import('@camstack/types').RouteAccess[] = [
  'public',
  'authenticated',
  'admin',
]

function asRouteMethod(value: string): import('@camstack/types').IAddonHttpRoute['method'] {
  const upper = value.toUpperCase()
  for (const m of ROUTE_METHODS) if (m === upper) return m
  throw new Error(`addon-routes: unsupported HTTP method "${value}"`)
}

function asRouteAccess(value: unknown): import('@camstack/types').RouteAccess {
  if (typeof value === 'string') {
    for (const a of ROUTE_ACCESS) if (a === value) return a
  }
  // Default to the most restrictive sensible default the original mount used.
  return 'public'
}

/**
 * Parse the wire-boundary `unknown` returned by `callAddonOnChild(...,
 * {target:'routes'})` into typed route descriptors. The child sends route
 * descriptors WITHOUT handlers (functions don't cross MsgPack); only
 * `method`/`path`/`access`/`description` are present.
 */
interface ParsedRouteDescriptor {
  readonly method: import('@camstack/types').IAddonHttpRoute['method']
  readonly path: string
  readonly access: import('@camstack/types').RouteAccess
  readonly description?: string
  readonly rateLimit?: import('@camstack/types').RouteRateLimit
}

function parseSerializableRouteDescriptors(raw: unknown): readonly ParsedRouteDescriptor[] {
  if (!Array.isArray(raw)) {
    throw new Error('addon-routes: child returned a non-array route descriptor set')
  }
  return raw.map((entry: unknown): ParsedRouteDescriptor => {
    if (entry === null || typeof entry !== 'object') {
      throw new Error('addon-routes: route descriptor is not an object')
    }
    const method = Reflect.get(entry, 'method')
    const routePath = Reflect.get(entry, 'path')
    if (typeof method !== 'string' || typeof routePath !== 'string') {
      throw new Error('addon-routes: route descriptor missing method/path')
    }
    const description = Reflect.get(entry, 'description')
    // An unknown limit name is dropped, never widened into "no limit" silently
    // by a typo on the hub side: only names the hub implements are kept.
    const rateLimit = Reflect.get(entry, 'rateLimit') === 'auth' ? ('auth' as const) : undefined
    return {
      method: asRouteMethod(method),
      path: routePath,
      access: asRouteAccess(Reflect.get(entry, 'access')),
      ...(typeof description === 'string' ? { description } : {}),
      ...(rateLimit !== undefined ? { rateLimit } : {}),
    }
  })
}

/**
 * Parse the wire-boundary `unknown` from `callForked(..., {target:'data-planes'})`
 * into typed data-plane endpoint descriptors (`prefix/access/baseUrl/secret`).
 * Pure data — the addon's `ctx.dataPlane` facility produced them.
 */
export function parseDataPlaneEndpoints(
  raw: unknown,
): readonly import('@camstack/types').AddonDataPlaneEndpoint[] {
  if (!Array.isArray(raw)) {
    throw new Error('data-planes: child returned a non-array endpoint set')
  }
  return raw.map((entry: unknown): import('@camstack/types').AddonDataPlaneEndpoint => {
    if (entry === null || typeof entry !== 'object') {
      throw new Error('data-planes: endpoint descriptor is not an object')
    }
    const prefix = Reflect.get(entry, 'prefix')
    const baseUrl = Reflect.get(entry, 'baseUrl')
    const secret = Reflect.get(entry, 'secret')
    if (typeof prefix !== 'string' || typeof baseUrl !== 'string' || typeof secret !== 'string') {
      throw new Error('data-planes: endpoint descriptor missing prefix/baseUrl/secret')
    }
    const share = parseDataPlaneShare(Reflect.get(entry, 'share'))
    return {
      prefix,
      access: asRouteAccess(Reflect.get(entry, 'access')),
      baseUrl,
      secret,
      ...(share !== undefined ? { share } : {}),
    }
  })
}

/**
 * The share opt-in, or `undefined` when the plane declared none. An unknown
 * kind is refused loudly: admitting it silently would let a typo open a
 * plane to share tokens nobody scoped.
 */
function parseDataPlaneShare(
  value: unknown,
): readonly import('@camstack/types').ShareViewKind[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('data-planes: `share` is not an array')
  return value.map((kind: unknown): import('@camstack/types').ShareViewKind => {
    if (!isShareViewKind(kind)) throw new Error(`data-planes: unknown share kind ${String(kind)}`)
    return kind
  })
}

function isShareViewKind(value: unknown): value is import('@camstack/types').ShareViewKind {
  return typeof value === 'string' && (SHARE_VIEW_KINDS as readonly string[]).includes(value)
}

/** Outcome of {@link AddonRegistryService.restartPackage}. */
export interface PackageRestartResult {
  /** True only when every runner of the package came back. */
  readonly success: boolean
  /** Addon ids covered by a successful restart. */
  readonly restarted: readonly string[]
  /** One message per runner that did not come back. */
  readonly errors: readonly string[]
}

interface AddonEntry {
  readonly addon: ICamstackAddon
  initialized: boolean
  source: AddonSource
  /** npm package name from package.json (e.g. '@camstack/addon-detection-pipeline') */
  packageName: string
  /** npm package version from package.json */
  packageVersion: string
  /** Human-readable package name from camstack.displayName */
  packageDisplayName?: string
  /** Optional bundle metadata when the package ships multiple addon entries. */
  bundle?: { displayName: string; description?: string; icon?: string }
  /** Capabilities declared in package.json camstack.addons (source of truth) */
  declaredCapabilities: readonly CapabilityDeclaration[]
  /** Addon directory on disk */
  addonDir?: string
  /** Full package.json declaration (AddonDeclaration from @camstack/types) */
  declaration?: AddonDeclaration
}

// Phase 11 (settings redesign): `stripValue` helper and the legacy
// `getAddonConfigSchema / getAddonConfig / updateAddonConfig` adapter
// shim that consumed it were deleted. All settings flow through the
// new `getAddonSettings / getGlobalSettings / getDeviceSettings`
// endpoints on the `addon-settings` singleton capability.

/**
 * Capabilities whose provider OWNS its readiness protocol
 * (`autoEmitReadiness=false`): it registers before it can answer, and emits
 * `starting`/`ready`/`down` itself. The registration-time emit would flip
 * them `ready` early.
 *
 * - `platform-probe` registers synchronously from `onInitialize` while the
 *   REAL probe (hardware + embedded-Python EP scoring) still runs async;
 *   probe-gated consumers (detection-pipeline engine auto-pick) would read
 *   accelerator-blind results.
 * - `device-history` is `ready` when its STORE is open (`onHubReachable`),
 *   not when it registered; every producer that declares on `ready`
 *   (metrics-native, pipeline-analytics) declared into a closed store and
 *   logged a declare failure on each boot.
 *
 * Only single-provider caps belong here: the hook is per CAPABILITY, so a cap
 * other addons also provide (`device-removal-hook`) would lose its ready.
 */
const SELF_READYING_CAPABILITIES: ReadonlySet<string> = new Set([
  'platform-probe',
  'device-history',
])

/** Whether the `capability:provider-registered` hook may emit `ready` for a capability. */
export function shouldEmitProviderRegisteredReady(capability: string): boolean {
  return !SELF_READYING_CAPABILITIES.has(capability)
}

/**
 * Is this capability device-scoped?
 *
 * Read from the cap DEFINITIONS, never a list: the set changes with every cap
 * that lands, and a hand-written copy is the shape of bug that keeps a widget
 * invisible for a week. Built once — `ALL_CAPABILITY_DEFINITIONS` is a frozen
 * generated array.
 */
const DEVICE_SCOPED_CAP_NAMES: ReadonlySet<string> = new Set(
  ALL_CAPABILITY_DEFINITIONS.filter((def) => def.scope === 'device').map((def) => def.name),
)

function isDeviceScopedCapName(capName: string): boolean {
  return DEVICE_SCOPED_CAP_NAMES.has(capName)
}

export class AddonRegistryService {
  private readonly addonEntries = new Map<string, AddonEntry>()
  private readonly capabilityRegistry: CapabilityRegistry
  /** Single router for addon-level calls (routes / custom / settings). */
  private addonCallGateway!: AddonCallGateway
  // Task 7.1: hub-wide registry of addon custom actions. Populated on
  // each addon's initialize() (in-process path); Task 7.2 will dispatch
  // through this from the `api.addons.custom` tRPC procedure.
  private readonly customActionRegistry = new CustomActionRegistry()
  /**
   * Fingerprint of the custom-action catalogs each UDS child last DESCRIBED
   * (keyed by child id), and the addon ids registered from that description.
   * A re-register carrying the same catalogs is a no-op with no line; a child
   * whose new description drops an addon has that addon's actions withdrawn.
   * See {@link applyChildCustomActions}.
   */
  private readonly childCatalogFingerprints = new Map<string, string>()
  private readonly childCatalogAddons = new Map<string, ReadonlySet<string>>()
  /**
   * AddonIds whose group-runner disconnect is operator-initiated (update /
   * restart / uninstall). The Moleculer `$node.disconnected` handler skips
   * these so the AddonCard doesn't flash a spurious "Failed to load" health
   * banner during the kill→respawn window. The set is cleared as soon as
   * `restartAddon` completes (success or failure) or by a 90s safety timer.
   */
  private readonly restartingAddons = new Map<string, NodeJS.Timeout>()
  /**
   * `runnerId → last-respawn epoch-ms`, used ONLY to coalesce redundant group
   * respawns. A package reload loops `restartAddon` over EVERY addon in the
   * package (`tryReloadPackage`); for a co-location group that maps N members
   * onto ONE runner, the first member's restart already respawns the whole
   * group (all members reboot from fresh on-disk code), so the 2nd..Nth
   * restarts must NOT respawn again — that churns the runner N times and risks
   * tripping the crash circuit-breaker. Consulted by `ensureForkedRunner`; only
   * groups (roster > 1) are coalesced, so solo-addon restart stays byte-identical.
   */
  private readonly recentGroupRespawns = new Map<string, number>()
  private readonly logger: IScopedLogger
  private addonLoader!: AddonLoader
  private healthMonitor!: AddonHealthMonitor
  private addonRouteRegistry: AddonRouteRegistry | null = null
  private dataPlaneRegistry: DataPlaneRegistry | null = null

  // Broker-routed AddonApi proxy — every addon's `ctx.api` resolves
  // to this. Calls go through `broker.call('${addonId}.${capName}.${method}')`
  // which Moleculer routes to whichever process actually hosts the
  // capability (in-process services on the hub, forked workers, or
  // remote agents). The hub uses the exact same transport as agents
  // and forked workers — `ctx.api` is uniform across all deployment
  // shapes. Lazily constructed so tests that don't wire the broker
  // still instantiate the service.
  private brokerApi: import('@camstack/types').AddonApi | null = null
  /**
   * In-process tRPC client over the broker — same `AddonApi` shape every
   * addon sees via `ctx.api`. Exposed as public so the REPL service can
   * build a `SystemManager` from it without crossing the network boundary.
   */
  public getBrokerApi(): import('@camstack/types').AddonApi {
    if (!this.brokerApi) {
      this.brokerApi = this.buildBrokerApi(undefined)
    }
    return this.brokerApi
  }

  /**
   * The `ctx.api` of one in-process addon. Same chain as {@link getBrokerApi},
   * but its `localProviderLink` knows WHO is calling, so a caller-stamped cap
   * (`device-history`, keychain, records) can identify the addon. A shared
   * client cannot: `metrics-native` was refused `declareSeries` ("the caller
   * addon could not be identified") on every sample.
   */
  private getAddonApi(addonId: string): import('@camstack/types').AddonApi {
    const cached = this.addonApis.get(addonId)
    if (cached) return cached
    const api = this.buildBrokerApi(addonId)
    this.addonApis.set(addonId, api)
    return api
  }

  private readonly addonApis = new Map<string, import('@camstack/types').AddonApi>()

  private buildBrokerApi(callerAddonId: string | undefined): import('@camstack/types').AddonApi {
    const reg = this.capabilityRegistry
    const resolver = {
      getByName: (capName: string): unknown | null =>
        reg.getSingleton(capName) ?? (reg.getAllProviders(capName)[0] as unknown) ?? null,
    }
    // Device-scoped caps go through the hub's CapRouteResolver, which is
    // the only authority that can route `(cap, deviceId)` into a FORKED
    // child — and forked children are broker-less, so the Moleculer
    // lookup below cannot see them at all. Without this an in-process
    // addon asking `ptz.getOptions({deviceId})` got
    // `Service 'ptz.ptz.getOptions' is not found`, which is how the
    // autotrack builtin came up switched on and unable to move a camera
    // (2026-09-18).
    const links = [
      deviceCapResolverLink(
        (capName: string, method: string, input: unknown) =>
          this.moleculer.callCapabilityOnNode(this.moleculer.broker.nodeID, capName, method, input),
        isDeviceScopedCapName,
      ),
      brokerTransportLink(this.moleculer.broker),
    ]
    if (callerAddonId !== undefined) {
      return createHubAddonApi({ resolver, callerAddonId, links })
    }
    const client: unknown = createTRPCClient({ links: [localProviderLink(resolver), ...links] })
    return client as import('@camstack/types').AddonApi
  }

  // Common settings resolver (3-level: defaults → global → per-device).
  // Lazily constructed on first call to `getSettingsResolver()` so tests
  // that don't exercise the settings API can instantiate the service
  // without wiring ConfigService into the resolver.

  // Active capability providers (set by consumers when capabilities are wired)
  private activeStorageProvider: INewStorageProvider | null = null
  private activeSettingsBackend: ISettingsBackend | null = null
  private integrationRegistry: import('@camstack/system').IntegrationRegistry | null = null
  private clusterNodeHistoryStore: ClusterNodeHistoryStore | null = null
  private clusterAgentRecords: RecordsAccess | null = null
  private credentialTokenService: CredentialTokenService | null = null

  // Device architecture — in-memory registry of live IDevice instances.
  // Persistence is owned by the `device-manager` capability addon.
  private readonly deviceRegistry = new DeviceRegistry()

  /**
   * Typed accessor for the Moleculer broker. The Moleculer `index.d.ts`
   * chains through `eventemitter2`, whose package.json has no `types`
   * field; under `moduleResolution: node` typescript-eslint's parser
   * loses the type chain even though `tsc` accepts it via `skipLibCheck`.
   * Going through `this.moleculer.broker` directly produces "type cannot
   * be resolved" errors at every call site. The local `BrokerLike`
   * interface narrows down to the surface we actually use, and the
   * double-cast forces the parser to materialize types locally so
   * `this.broker.call(...)` / `this.broker.nodeID` lint clean.
   */
  private get broker(): BrokerLike {
    return asBrokerLike(this.moleculer.broker)
  }

  constructor(
    private readonly loggingService: LoggingService,
    private readonly eventBusService: EventBusService,
    private readonly configService: ConfigService,
    private readonly storageService: StorageService,
    private readonly capabilityService: CapabilityService,
    private readonly moleculer: MoleculerService,
    private readonly streamProbe: StreamProbeService,
  ) {
    this.logger = this.loggingService.createLogger('AddonRegistry')
    this.addonLoader = new AddonLoader(this.loggingService.createLogger('AddonLoader'))
    this.deviceMirror = new DeviceMetaMirror(
      async (deviceIds) =>
        this.getBrokerApi().deviceManager.listAll.query({
          projection: 'slim',
          ...(deviceIds === null ? {} : { deviceIds: [...deviceIds] }),
        }),
      {
        parentDeviceId: (deviceId) => this.deviceRegistry.getById(deviceId)?.parentDeviceId ?? null,
        type: (deviceId) => this.deviceRegistry.getById(deviceId)?.type ?? null,
        location: (deviceId) => this.deviceRegistry.getById(deviceId)?.location ?? null,
      },
      this.logger,
    )

    // Kernel-level addon health monitor — drives the 5-min boot grace
    // window + aggressive auto-retry loop (60s/120s/300s, never gives
    // up). Failures and recoveries are recorded by the load + init
    // paths; the monitor's tick loop calls `tryReloadPackage` to
    // reattempt failed addons. Operator visibility comes through
    // AddonLoadFailed / AddonLoadRecovered events consumed by
    // AlertCenter (see addon-health-monitor.ts spec).
    this.healthMonitor = new AddonHealthMonitor({
      eventBus: this.eventBusService as import('@camstack/types').IEventBus,
      logger: this.loggingService.createLogger('AddonHealthMonitor'),
      retryFn: (packageName) => this.tryReloadPackage(packageName),
    })

    // Create capability registry with config reader for singleton preferences
    this.capabilityRegistry = new CapabilityRegistry(
      this.loggingService.createLogger('CapabilityRegistry'),
      this.eventBusService,
    )
    // The preference readers answer "no preference" while the persisted
    // preferences cannot be read yet — before the settings door exists, or
    // while its one boot read is in flight (D675: `get` then THROWS rather
    // than answering "unset"). The default wins meanwhile, and
    // `wireSettingsDoor` re-applies the persisted choice
    // the moment the read settles.
    this.capabilityRegistry.setConfigReader((capability: string): string | undefined => {
      try {
        return this.configService.get<string>(`capabilities.singleton.${capability}`) ?? undefined
      } catch (err) {
        this.logger.debug('capability preference not readable yet — default applies until replay', {
          meta: { capability, error: errMsg(err) },
        })
        return undefined
      }
    })

    this.capabilityRegistry.setNodeConfigReader(
      (capability: string, nodeId: string): string | undefined => {
        try {
          return (
            this.configService.get<string>(`capabilities.singletonNode.${capability}.${nodeId}`) ??
            undefined
          )
        } catch (err) {
          this.logger.debug('capability preference not readable yet — default applies', {
            tags: { nodeId },
            meta: { capability, error: errMsg(err) },
          })
          return undefined
        }
      },
    )

    // Collection-provider enable/disable persistence. Reads the same
    // `capabilities.collection.<cap>` ConfigService key the `capabilities`
    // router writes (`JSON.stringify({ disabled: string[] })`), so a
    // collection provider an operator disabled survives a hub reboot.
    this.capabilityRegistry.setCollectionConfigReader(
      (capability: string): readonly string[] | undefined => {
        try {
          const raw = this.configService.get<string>(`capabilities.collection.${capability}`)
          if (!raw) return undefined
          const parsed: unknown = JSON.parse(raw)
          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            'disabled' in parsed &&
            Array.isArray((parsed as { disabled: unknown }).disabled)
          ) {
            const disabled = (parsed as { disabled: unknown[] }).disabled
            return disabled.filter((id): id is string => typeof id === 'string')
          }
          return undefined
        } catch (err) {
          this.logger.debug('collection preference not readable yet, or malformed', {
            meta: { capability, error: errMsg(err) },
          })
          return undefined
        }
      },
    )

    // Wire the registry into the CapabilityService so all server services can use it
    this.capabilityService.setRegistry(this.capabilityRegistry)

    // Register kernel-provided infrastructure capabilities so addons
    // can resolve them via the capability registry like any other cap.
    // These are kernel pseudo-caps (no tRPC methods, object-reference only),
    // so we declare them with empty method maps before registering providers.
    this.capabilityRegistry.declareCapability({
      name: 'device-registry',
      scope: 'system',
      mode: 'singleton',
      methods: {},
    })
    this.capabilityRegistry.declareCapability({
      name: 'cluster-broker',
      scope: 'system',
      mode: 'singleton',
      methods: {},
    })
    this.capabilityRegistry.registerProvider('device-registry', '$kernel', this.deviceRegistry)
    this.capabilityRegistry.registerProvider('cluster-broker', '$kernel', {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- moleculer types unresolvable; see `broker` getter docstring
      broker: this.moleculer.broker,
    })
  }

  async onModuleInit(): Promise<void> {
    // Register the addon-settings singleton provider — replaces the
    // former `$addonHost` Moleculer service. The provider resolves
    // addonId → local addon instance (hub) or remote Moleculer call.
    this.capabilityRegistry.declareCapability(addonSettingsCapability)
    // The SINGLE router for addon-level calls (routes / custom / settings).
    // It classifies in-process | hub-local-child (UDS) | remote-agent
    // (Moleculer) in ONE place — `resolveNode` reports only the BASE node
    // (the hub for every hub-local addon, forked or not); the gateway's
    // `isChildKnown` distinguishes a forked UDS child from an in-process
    // builtin. This is the fix for forked-addon settings: they were forced
    // down a dead `<addonId>.settings.*` Moleculer path because the old
    // `resolveNode` marked them non-local; now they route over UDS like
    // their routes + custom-actions already do.
    this.addonCallGateway = new AddonCallGateway({
      hubNodeId: this.broker.nodeID,
      resolveNode: (addonId) => {
        const entry = this.addonEntries.get(addonId)
        // Every addon in `addonEntries` is hub-local — report the hub node;
        // forked-vs-in-process is decided by `isChildKnown` in the gateway.
        return entry ? this.broker.nodeID : 'hub'
      },
      resolveChildId: (addonId) => this.childIdForAddon(addonId),
      getChildRegistry: () => this.moleculer.childRegistry,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- moleculer types unresolvable; see `broker` getter docstring
      broker: this.moleculer.broker,
    })
    // Hand the UDS registry a live addonId → runner-id resolver so its
    // active-singleton preference can select a grouped addon (whose child id
    // is its `execution.group`, not its own id). Identity for ungrouped addons.
    this.moleculer.setRunnerIdResolver((addonId) => this.childIdForAddon(addonId))
    const settingsProvider = createAddonSettingsProvider({
      getAddon: (addonId) => {
        const entry = this.addonEntries.get(addonId)
        return entry?.addon ?? null
      },
      gateway: this.addonCallGateway,
    })
    this.capabilityRegistry.registerProvider('addon-settings', '$hub', settingsProvider)

    // Wire capability consumer actions via EventBus
    this.wireCapabilityConsumers()

    // Wire the persisted device-parent mirror (F0.6) so the scope matcher's
    // parent→child accessory inheritance works for FORKED provider devices,
    // which never appear in the hub-local DeviceRegistry.
    this.wireDeviceParentMirror()

    // Subscribe to capability.binding-changed so hub-side capability
    // overrides take effect on the fly. The orchestrator addon emits
    // these when the operator swaps the addon implementing a cap on a
    // node; we only react when the target node is the hub's own nodeID.
    this.eventBusService.subscribe({ category: 'capability.binding-changed' }, (event) => {
      const data = (event.data ?? {}) as {
        nodeId?: string
        capName?: string
        addonId?: string | null
      }
      if (!data.capName) return
      const localNodeId = this.broker.nodeID
      if (data.nodeId && data.nodeId !== localNodeId) return
      this.capabilityRegistry.setSingletonActiveAddon(data.capName, data.addonId ?? null)
    })

    // 2. Load all addons from the addons directory (including core builtins).
    // Honors CAMSTACK_ADDONS_DIR (a `node_modules`-shaped dir on Docker/Electron
    // so forked ESM addon runners resolve @camstack/* via walk-up — see the
    // launcher). Defaults to `<dataDir>/addons` for dev.
    const dataDir = path.resolve(process.env.CAMSTACK_DATA ?? 'camstack-data')
    const addonsDir = process.env.CAMSTACK_ADDONS_DIR ?? path.resolve(dataDir, 'addons')

    // Single-copy model (2026-07-18 collapse): the framework BUILTINS
    // (`@camstack/system`: device-manager, snapshot, storage, settings, …) load
    // from the ACTIVE CLOSURE the hub itself runs from — resolved via the same
    // walk-up hub-main uses — NOT from a physical `/data/addons/@camstack/system`
    // copy. That copy drifted because no update channel refreshed it (the
    // recurring "+1 restart" / stale-builtin pain); there is now ONE copy and no
    // `syncSystemAddonsCopy` race. Non-framework addons still load from the
    // addons dir unchanged. The addons-dir `@camstack/system` copy (if present,
    // seeded by the image entrypoint) is SKIPPED to avoid a double-load.
    const closureSystemDir = resolveHubClosurePackageDir('@camstack/system')
    if (closureSystemDir) {
      try {
        await this.addonLoader.loadFromAddonDir(closureSystemDir)
      } catch (err) {
        this.logger.error('Failed to load @camstack/system builtins from the active closure', {
          meta: { closureSystemDir, error: err instanceof Error ? err.message : String(err) },
        })
      }
    } else {
      this.logger.warn(
        '@camstack/system not resolvable from the hub closure — builtins may be missing',
      )
    }

    await this.addonLoader.loadFromDirectory(addonsDir, ['@camstack/system'])

    // Hand pre-init load failures (broken package.json, missing
    // dist, import-time errors) to the health monitor so its retry
    // loop and post-grace alerting cover them. Failures during the
    // init phase below are recorded separately.
    for (const fail of this.addonLoader.listLoadFailures()) {
      this.healthMonitor.recordFailure(fail.packageName, fail.error, fail.addonId)
    }

    const loadedAddons = this.addonLoader.listAddons()

    // Self-heal a leftover from before the installer honoured placement:
    // `@camstack/addon-agent-ui` sat in /data/addons on the live hub dated
    // 2026-07-22, skipped by the loop below ever since, and therefore shown as
    // FAILED forever on a node where it cannot run. Fixing the installer was
    // necessary and not sufficient — nothing removed what was already there,
    // and a permanent red entry teaches people to ignore red entries.
    prunePlacementLeftovers(
      decidePrune(
        loadedAddons.map((a) => ({
          packageName: a.packageName,
          dir: path.join(addonsDir, a.packageName),
          placement: resolveAddonPlacement(a.declaration),
        })),
        'hub',
      ),
      path.join(addonsDir, '@camstack'),
      {
        info: (msg, meta) => this.logger.info(msg, { meta }),
        warn: (msg, meta) => this.logger.warn(msg, { meta }),
      },
    )

    for (const registered of loadedAddons) {
      // Skip agent-only addons — they never run on the hub, only on remote
      // agents that opt in via `execution.placement: 'agent-only'`.
      if (isAgentOnlyPlacement(registered.declaration)) {
        this.logger.info('Skipping agent-only addon on hub', {
          tags: { addonId: registered.declaration.id },
          meta: { packageName: registered.packageName },
        })
        continue
      }
      if (registered.declaration.capabilities) {
        for (const cap of registered.declaration.capabilities) {
          this.capabilityRegistry.declareFromManifest(cap, registered.declaration.id)
        }
      }
      // Create and store addon instance — cast from @camstack/types to server's
      // local ICamstackAddon (structurally compatible at runtime).
      // Wrap in try/catch so a single broken addon doesn't prevent the rest from loading.
      try {
        const addon = this.addonLoader.createInstance(registered.declaration.id)
        // Capabilities come from package.json declaration (source of truth),
        // merged with any declared in the addon class manifest.
        const declCaps = (registered.declaration.capabilities ?? []).map(
          (c: string | CapabilityDeclaration) =>
            typeof c === 'string' ? { name: c, mode: 'singleton' as const } : c,
        )
        this.addonEntries.set(registered.declaration.id, {
          addon,
          initialized: false,
          source: 'installed',
          packageName: registered.packageName,
          packageVersion: registered.packageVersion,
          packageDisplayName: registered.packageDisplayName,
          ...(registered.bundle !== undefined ? { bundle: registered.bundle } : {}),
          declaredCapabilities: declCaps,
          // @camstack/system builtins load from the active closure (single-copy
          // model), not the inert addons-dir copy — point their dir there so
          // any dir-derived path (data dir, markers) resolves to the real copy.
          addonDir:
            registered.packageName === '@camstack/system' && closureSystemDir
              ? closureSystemDir
              : path.join(addonsDir, registered.packageName),
          declaration: registered.declaration,
        })
        this.loadAddonCatalogs(
          registered.packageName,
          this.addonEntries.get(registered.declaration.id)?.addonDir,
        )
      } catch (err) {
        const msg = errMsg(err)
        this.logger.error('Failed to create instance of addon', {
          tags: { addonId: registered.declaration.id },
          meta: { error: msg },
        })
      }
    }

    this.logger.info('Loaded addons from directory', {
      meta: { count: loadedAddons.length, addonsDir },
    })
    // Platform probing is no longer orchestrated by the backend. The
    // `platform-probe` capability (shipped as a core builtin under
    // `@camstack/system/dist/builtins/platform-probe/` since Phase B of
    // the bundles refactor) exposes hardware + scored backends via
    // `ctx.api.platformProbe.*`; inference addons auto-configure
    // inside their own `onInitialize`.

    // 4. Initialize all installed addons in correct order (installed = active)
    const allIds = [...this.addonEntries.keys()]

    // Mark registry as ready BEFORE any addon initializes. Addons' onInitialize
    // may call ctx.api.<cap>.* which routes through localProviderLink; that
    // resolver depends on getAllProviders/getSingleton which gate on `_ready`.
    // Without this, Phase 1 and Phase 2 addons would all fall through to the
    // Moleculer broker transport and fail with "service not registered".
    this.capabilityRegistry.ready()

    // Native-cap cross-process bridge: when a hub consumer resolves a native
    // provider for a device whose IDevice lives in a forked worker, we
    // return a proxy that routes calls to the correct transport.
    //
    // G2 — single ownership authority: the CapRouteResolver is consulted FIRST
    // for hub-local native caps. If the resolver's snapshot identifies a
    // hub-local-uds route for (capName, deviceId), we build the proxy directly —
    // no `resolveNativeCapOwnerSync` consult needed for this branch. The resolver's
    // `hubLocalChildProvides(capName, deviceId)` is the canonical hub-local authority
    // (fed by the same LocalChildRegistry that owns UDS dispatch), so the old
    // `owner.nodeId.startsWith(hubNodeId + '/')` gate is replaced by the resolver's
    // own verdict.
    //
    // `resolveNativeCapOwnerSync` is only consulted for the REMOTE branch: when the
    // resolver throws no-provider for the hub node (no hub-local-uds child owns the cap),
    // the fallback queries `resolveNativeCapOwnerSync` to find a remote owner. That
    // method carries data (push-fed `remoteNativeCaps` from `DeviceBindingsChanged`
    // events) that the resolver's `NodeCapAuthority` doesn't see, so it stays as the
    // remote-branch source. If `resolveNativeCapOwnerSync` also returns null, the cap
    // genuinely has no cross-process provider and the fallback returns null — wrappers
    // cleanly fall through to their own secondary strategy.
    {
      const { buildNativeCapProxy } = await import('@camstack/system')
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- moleculer types unresolvable; see `broker` getter docstring
      const broker = this.moleculer.broker
      this.capabilityRegistry.setNativeFallback(
        (capName: string, deviceId: number): unknown | null => {
          const resolver = this.moleculer.capRouteResolver
          const hubNodeId = this.moleculer.nodeId

          // 1. Hub-local path: the resolver's hub-local-child authority is the
          //    single source of truth for whether a forked hub-local UDS child
          //    owns (capName, deviceId) — via hubLocalChildProvides +
          //    getHubLocalChildId (both deviceId-aware, M1).
          //
          //    We deliberately use `resolveHubLocalUdsRoute`, NOT
          //    `resolveCapRoute`: this fallback's contract is to reach the
          //    NATIVE provider in the forked vendor child. `resolveCapRoute`
          //    gives Priority 1 to `hub-in-process`, so a cap that ALSO has an
          //    in-hub provider for the same name (a wrapper — today `snapshot`)
          //    would classify as `hub-in-process` (the wrapper) and never reach
          //    the hub-local-uds native. That made the wrapper's
          //    `getNativeProvider` return null and silently fall through to its
          //    secondary strategy (e.g. snapshot's ffmpeg frame grab), so the
          //    vendor native snapshot was never invoked. `resolveHubLocalUdsRoute`
          //    skips the in-process branch and returns the native child route.
          if (resolver !== null) {
            const route = resolver.resolveHubLocalUdsRoute(capName, deviceId)
            if (route !== null) {
              const childId = route.childId
              const target: Record<string, (input: unknown) => Promise<unknown>> = {}
              return new Proxy(target, {
                get(_target, property): ((input: unknown) => Promise<unknown>) | undefined {
                  if (typeof property !== 'string') return undefined
                  return (input: unknown): Promise<unknown> => {
                    const mergedInput =
                      typeof input === 'object' && input !== null
                        ? { ...input, deviceId }
                        : { deviceId }
                    // Re-resolve at call time so a child that respawned under a
                    // new runner id is still reachable (route is cheap to build).
                    const r = resolver.resolveHubLocalUdsRoute(capName, deviceId) ?? {
                      kind: 'hub-local-uds' as const,
                      capName,
                      childId,
                    }
                    return resolver.dispatch(r, property, mergedInput)
                  }
                },
              })
            }
            // No hub-local child owns (capName, deviceId). Fall through to the
            // remote branch — resolveNativeCapOwnerSync is still consulted there
            // and may find a remote owner for this (capName, deviceId).
          }

          // 2. Remote path: resolver has no hub-local route for this (capName, deviceId).
          //    Consult resolveNativeCapOwnerSync — it includes push-fed remoteNativeCaps
          //    (DeviceBindingsChanged events from forked workers) that the resolver's
          //    NodeCapAuthority (backed by HubNodeRegistry) doesn't carry.
          const dm = this.capabilityRegistry.getSingleton<{
            resolveNativeCapOwnerSync?: (
              capName: string,
              deviceId: number,
            ) => { addonId: string; nodeId: string } | null
          }>('device-manager')
          const owner = dm?.resolveNativeCapOwnerSync?.(capName, deviceId) ?? null
          if (!owner) return null

          // Guard: skip hub-local owners here — they were already handled (or skipped
          // because the resolver was null / not initialised yet). Returning null avoids
          // building a Moleculer proxy that points at a UDS-only child.
          if (owner.nodeId.startsWith(`${hubNodeId}/`)) return null

          // Remote native cap → Moleculer with native-provider infix.
          // buildNativeCapProxy uses the action `${addonId}.native-provider.${cap}.${method}`.
          return buildNativeCapProxy(broker, owner.addonId, capName, deviceId)
        },
      )
    }

    // Runner spawn: every non-core, placement-eligible addon runs in its
    // OWN forked runner subprocess by default (base-layer D2/D9 — one
    // addon, one process). No shipped addon declares a shared
    // `execution.group`: Phase 5 dissolved the `pipeline` media group
    // once frames travel as shm `FrameHandle`s and audio over tRPC.
    // `buildAddonGroupPlan` keys the plan by runner id (the addon id);
    // cross-runner / cross-node cap calls travel over Moleculer TCP.
    // `resolveRunnerId` still collapses a shared `execution.group` if
    // one were declared — the mechanism stays available as an explicit
    // opt-in for future co-location needs.
    //
    // `placement: 'agent-only'` addons and `@camstack/system` builtins are
    // excluded from the plan (filtered inside `buildAddonGroupPlan`) — except
    // a builtin declaring `execution.isolate`, which is spawned in two
    // waves (infra isolates BEFORE in-process builtins, consumers AFTER —
    // see `partitionIsolatedBuiltinIds` and `runHubAddonBoot`).
    // A failed runner spawn is logged and the addon surfaces as
    // `addon.error` — there is NO in-process-on-the-hub fallback (it
    // would violate one-addon-one-process). Retry policy for a failed
    // spawn is governed by the kernel circuit-breaker.
    //
    // BOUNDED-PARALLEL (D171). Entries within a plan are independent by
    // construction — `buildAddonGroupPlan` keys by runner id and nothing reads
    // the iteration order — while each one costs a fork plus a full addon
    // bundle evaluated on the hub's event loop. Serially that was ~4 s of the
    // measured 10 s kernel boot and grew with every addon shipped. The ordering
    // that IS load-bearing is BETWEEN the waves in `runHubAddonBoot`, not
    // inside one.
    const spawnRunnerPlan = async (plan: RunnerPlan): Promise<void> => {
      await spawnPlanConcurrently(plan, async (runnerId, runnerAddons) => {
        try {
          await this.initializeAddonGroup(runnerId, runnerAddons)
          for (const { addonId } of runnerAddons) {
            this.wireCapabilities(addonId)
          }
        } catch (error: unknown) {
          const msg = errMsg(error)
          for (const { addonId } of runnerAddons) {
            this.emitAddonLifecycleEvent('addon.error', addonId, {
              error: msg,
              phase: 'init',
            })
          }
          this.logger.error('Runner spawn failed — addons on this runner will be skipped', {
            meta: { runnerId, addonIds: runnerAddons.map((a) => a.addonId), error: msg },
          })
        }
      })
    }

    // Isolated builtins split into two waves. Snapshot (D123) persists
    // behind `settings-store`, so it must boot AFTER the in-process door.
    // sqlite-settings IS that engine: spawn it with snapshot and every
    // in-process builtin initialises against a missing store (D44).
    // `partitionIsolatedBuiltinIds` is the only classification.
    const isolatedBuiltinIds = allIds.filter((id) => {
      const entry = this.addonEntries.get(id)
      return (
        entry?.packageName === '@camstack/system' &&
        entry.declaration !== undefined &&
        isIsolatedBuiltin(entry.declaration)
      )
    })
    const isolatedBuiltins = new Set(isolatedBuiltinIds)
    const { infra: isolatedInfraIds, consumers: isolatedConsumerIds } = partitionIsolatedBuiltinIds(
      isolatedBuiltinIds,
      (id) => {
        const entry = this.addonEntries.get(id)
        return entry?.declaredCapabilities ?? []
      },
    )
    // A core builtin is identified by `packageName === "@camstack/system"`,
    // NOT by the absence of an `execution` declaration — a builtin may
    // still declare `execution` (e.g. `platform-probe`); the package
    // boundary is the selection criterion. The ONE exception is
    // `execution.isolate`, which says "fork me": such a builtin must never
    // boot in-process here, not even when its runner spawn failed. A spawn
    // failure surfaces as `addon.error`; quietly running the addon on the hub
    // instead would defeat the isolation on exactly the day it is needed.
    const isCoreBuiltin = (id: string): boolean =>
      this.addonEntries.get(id)?.packageName === '@camstack/system' && !isolatedBuiltins.has(id)

    // Order is load-bearing (D234): forked addons `resolveConfig()` against
    // the settings door. Spawn them before the engine is in `getCollection`
    // and the door has booted and they initialise from constructor defaults
    // — cloudflare-tunnel then auto-starts a quick tunnel while notifications
    // still mint the named hostname (Cloudflare 530, 2026-08-25).
    // `runHubAddonBoot` is the only sequence; a timeout on the engine wait
    // must NOT throw (1.2.151 crash-looped the starter).
    await runHubAddonBoot({
      spawnIsolatedInfra: async () => {
        if (isolatedInfraIds.length === 0) return
        this.logger.info('Spawning isolated infrastructure builtins', {
          meta: { addonIds: isolatedInfraIds },
        })
        await spawnRunnerPlan(this.buildAddonGroupPlan(isolatedInfraIds))
      },
      waitForDataStoreProvider: async () => {
        if (isolatedInfraIds.length === 0) return
        try {
          await waitUntilReady(
            () => this.capabilityRegistry.getCollection('data-store-provider').length > 0,
            {
              timeoutMs: 30_000,
              intervalMs: 50,
              what: 'isolated data-store-provider engine',
            },
          )
        } catch (err: unknown) {
          this.logger.error('Isolated data-store-provider engine did not register in time', {
            meta: { error: errMsg(err), addonIds: isolatedInfraIds },
          })
        }
      },
      bootInProcessInfra: async () => {
        // Pass 1 — infrastructure builtins. A failed REQUIRED infra cap
        // aborts boot: nothing downstream can run without storage/settings.
        for (const infra of INFRA_CAPABILITIES) {
          const addonId = this.findAddonForCapability(infra.name, allIds)
          if (addonId) {
            const entry = this.addonEntries.get(addonId)
            // Only core builtins boot in-process here. A non-core addon that
            // happens to provide an infra cap (e.g. an alternate
            // storage-provider) lives in its own runner — never in-process.
            if (!entry || entry.initialized || !isCoreBuiltin(addonId)) continue
            try {
              await this.initializeAddon(addonId)
              this.wireCapabilities(addonId)
            } catch (error: unknown) {
              const msg = errMsg(error)
              this.emitAddonLifecycleEvent('addon.error', addonId, {
                error: msg,
                phase: 'init',
              })
              if (infra.required) {
                throw new Error(`Required infrastructure addon "${addonId}" failed: ${msg}`, {
                  cause: error,
                })
              }
              this.logger.warn('Optional infra addon failed -- continuing', {
                tags: { addonId },
                meta: { error: msg },
              })
            }
          } else if (infra.required) {
            throw new Error(`No addon provides required infrastructure capability "${infra.name}"`)
          }
        }
      },
      spawnForkedAddons: async () => {
        await spawnRunnerPlan(
          this.buildAddonGroupPlan(allIds.filter((id) => !isolatedBuiltins.has(id))),
        )
      },
      bootInProcessConsumers: async () => {
        // Pass 2 — remaining core builtins, in capability-dependency order.
        const bootOrder = this.capabilityRegistry.getBootOrder()
        const infraNames = new Set(INFRA_CAPABILITIES.map((c) => c.name))

        for (const capName of bootOrder) {
          if (infraNames.has(capName)) continue // Handled in pass 1

          for (const id of allIds) {
            const entry = this.addonEntries.get(id)
            if (!entry || entry.initialized || !isCoreBuiltin(id)) continue

            const provides = this.getAddonCapabilities(entry.addon)
            if (!provides.some((c) => c.name === capName)) continue

            try {
              await this.initializeAddon(id)
              this.wireCapabilities(id)
            } catch (error: unknown) {
              const msg = errMsg(error)
              this.emitAddonLifecycleEvent('addon.error', id, {
                error: msg,
                phase: 'init',
              })
              this.logger.error('Core builtin failed to initialize -- skipping', {
                tags: { addonId: id },
                meta: { error: msg },
              })
            }
          }
        }

        // Pass 3 — core builtins that declare no capabilities at all.
        for (const id of allIds) {
          const entry = this.addonEntries.get(id)
          if (entry && !entry.initialized && isCoreBuiltin(id)) {
            try {
              await this.initializeAddon(id)
              this.wireCapabilities(id)
            } catch (error: unknown) {
              const msg = errMsg(error)
              this.emitAddonLifecycleEvent('addon.error', id, {
                error: msg,
                phase: 'init',
              })
              this.logger.error('Core builtin failed to initialize -- skipping', {
                tags: { addonId: id },
                meta: { error: msg },
              })
            }
          }
        }
      },
      spawnIsolatedConsumers: async () => {
        if (isolatedConsumerIds.length === 0) return
        this.logger.info('Spawning isolated system builtins', {
          meta: { addonIds: isolatedConsumerIds },
        })
        await spawnRunnerPlan(this.buildAddonGroupPlan(isolatedConsumerIds))
      },
    })

    const initializedIds = [...this.addonEntries.entries()]
      .filter(([, e]) => e.initialized)
      .map(([id]) => id)

    this.logger.info('Addons initialized', {
      meta: { initializedCount: initializedIds.length, totalCount: this.addonEntries.size },
    })

    // Health snapshot: every addon entry that survived the loader is
    // either initialized (record success) or failed init (record
    // failure with the captured error). Pre-load failures were already
    // recorded above from `addonLoader.listLoadFailures()`.
    for (const [id, entry] of this.addonEntries.entries()) {
      if (entry.initialized) {
        this.healthMonitor.recordSuccess(entry.packageName, id)
      } else {
        // Init failed (caught by either Phase 1 or Phase 2 catch
        // blocks above). The catch handlers don't carry the error
        // forward to here, so we synthesize a generic one — the real
        // error is in the addon log. Operators see the alert + can
        // open the per-addon logs to investigate.
        this.healthMonitor.recordFailure(
          entry.packageName,
          new Error(`Addon "${id}" failed to initialize — see addon logs for details`),
          id,
        )
      }
    }

    // Start the kernel-level retry tick (30s). Fires immediately
    // on the first interval boundary; the 5-min boot grace window
    // suppresses alerts until the system has had time to stabilize.
    this.healthMonitor.start()

    // Group-runner / forked-addon crash detection (point 5 of the
    // operator's spec — "ogni fork/moleculer deve essere considerato" [every fork/moleculer must be taken into account]).
    // Moleculer's process-service.ts already handles respawn with
    // exponential backoff; we hook the broker's localBus events to
    // GIVE VISIBILITY of those crashes through the same monitor —
    // every crash records a failure, every reconnect records a
    // recovery. The respawn itself stays in process-service.ts.
    //
    // Runner node ids look like `hub/<runnerId>` where `runnerId` is the
    // addon id for a solo runner (the common case — one addon, one
    // process) or the co-location group name for a shared runner (e.g.
    // `hub/pipeline`). We map a disconnected/connected node back to the
    // underlying addons by walking `addonEntries` for any addon whose
    // resolved runner id matches the event's nodeId — every addon on
    // that runner gets a recordFailure / recordSuccess.
    type LocalBusEvent = { node: { id: string } }
    type LocalBus = { on: (event: string, handler: (payload: LocalBusEvent) => void) => void }
    const localBus = (this.moleculer.broker as { localBus?: LocalBus }).localBus
    if (localBus) {
      localBus.on('$node.disconnected', (payload) => {
        const nodeId = payload.node?.id
        if (!nodeId || nodeId === this.broker.nodeID) return
        for (const [id, entry] of this.addonEntries.entries()) {
          if (!entry.declaration) continue
          const runnerId = resolveRunnerId(entry.declaration, id)
          if (`${this.broker.nodeID}/${runnerId}` !== nodeId) continue
          // Skip operator-initiated restarts — `restartAddon` already
          // waits for caps to re-register and surfaces its own failure
          // path. Recording a transient failure here would flash the
          // "Failed to load" banner on AddonCard during a routine update.
          if (this.restartingAddons.has(id)) continue
          // Record one failure per addon on the disconnected runner.
          // The error message references the nodeId — the operator
          // can correlate with process-service.ts respawn logs.
          this.healthMonitor.recordFailure(
            entry.packageName,
            new Error(`Addon runner ${nodeId} disconnected`),
            id,
          )
        }
      })
      localBus.on('$node.connected', (payload) => {
        const nodeId = payload.node?.id
        if (!nodeId || nodeId === this.broker.nodeID) return
        for (const [id, entry] of this.addonEntries.entries()) {
          if (!entry.declaration) continue
          const runnerId = resolveRunnerId(entry.declaration, id)
          if (`${this.broker.nodeID}/${runnerId}` !== nodeId) continue
          this.healthMonitor.recordSuccess(entry.packageName, id)
        }
      })
    }

    this.eventBusService.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: { type: 'core', id: 'addon-registry' },
      category: EventCategory.SystemAddonsReady,
      data: { activeAddons: initializedIds },
    })
  }

  /**
   * Reload a single package — invoked by AddonHealthMonitor's retry
   * loop and by the operator-facing `addons.retryLoad` tRPC procedure.
   *
   * Two paths:
   *   1. Package not yet in the registry (e.g. import failed at boot
   *      time): re-walk the addons dir, pick up any new package, run
   *      `initializeAddon` for each contained addon.
   *   2. Package already in the registry but its addon entries failed
   *      init: call `restartAddon` for each addon in that package.
   *
   * On success the monitor automatically records the addon healthy
   * (no explicit recordSuccess needed — the `attemptRetry` no-throw
   * fast path handles it). On failure this method throws and the
   * monitor's catch path schedules the next retry.
   */
  async tryReloadPackage(packageName: string): Promise<void> {
    const dataDir = path.resolve(process.env.CAMSTACK_DATA ?? 'camstack-data')
    const addonsDir = process.env.CAMSTACK_ADDONS_DIR ?? path.resolve(dataDir, 'addons')
    const addonDir = path.join(addonsDir, packageName)

    if (!fs.existsSync(addonDir)) {
      throw new Error(`Package directory missing: ${addonDir}`)
    }

    // Branch 1: package known to the registry already → restart each
    // addon entry. `restartAddon` rebuilds AddonContext + runs init
    // again; on success the entry's `initialized` flag flips back to
    // true and the monitor's auto-resolve path records success.
    const knownAddonIds: string[] = []
    for (const [id, entry] of this.addonEntries.entries()) {
      if (entry.packageName === packageName) {
        knownAddonIds.push(id)
      }
    }

    if (knownAddonIds.length > 0) {
      const errors: string[] = []
      for (const id of knownAddonIds) {
        try {
          await this.restartAddon(id)
          this.healthMonitor.recordSuccess(packageName, id)
        } catch (err) {
          errors.push(`${id}: ${errMsg(err)}`)
          this.healthMonitor.recordFailure(packageName, err, id)
        }
      }
      if (errors.length > 0) {
        throw new Error(`tryReloadPackage failed for ${packageName}: ${errors.join('; ')}`)
      }
      return
    }

    // Branch 2: package not yet known → run loadNewAddons which
    // walks disk, instantiates new entries, and initializes them.
    // It records its own loaded/failed in the return; we re-throw
    // when our package is in the failed list so the monitor knows.
    const result = await this.loadNewAddons()
    if (result.failed.length > 0) {
      const failed = result.failed.join(', ')
      throw new Error(`loadNewAddons reported failures: ${failed}`)
    }
    if (result.loaded.length === 0) {
      throw new Error(
        `No new addons loaded for ${packageName} — package may still have a broken manifest`,
      )
    }
    // Match loaded addons to this package + record success.
    for (const id of result.loaded) {
      const entry = this.addonEntries.get(id)
      if (entry?.packageName === packageName) {
        this.healthMonitor.recordSuccess(packageName, id)
      }
    }
  }

  /** Health snapshot — exposed to the addons.list tRPC procedure. */
  getAddonHealthSnapshot(): readonly AddonHealthSnapshot[] {
    return this.healthMonitor.getHealthSnapshot()
  }

  /** Manual user-triggered retry (resets retry counter). */
  async retryAddonLoad(packageName: string): Promise<void> {
    return this.healthMonitor.retryNow(packageName)
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.info('Shutting down all addons…')
    this.healthMonitor.stop()
    await this.shutdownAll()
    this.logger.info('All addons shut down')
  }

  /** Set the AddonRouteRegistry for wiring addon-routes capabilities */
  setAddonRouteRegistry(registry: AddonRouteRegistry): void {
    this.addonRouteRegistry = registry
  }

  /** Set the DataPlaneRegistry the hub's `/addon/:id/*` dispatch reverse-proxies
   *  against (addon HTTP data-planes). */
  setDataPlaneRegistry(registry: DataPlaneRegistry): void {
    this.dataPlaneRegistry = registry
  }

  /**
   * Pull a forked addon's HTTP data-plane endpoints over UDS and register them so
   * the hub can reverse-proxy `/addon/<addonId>/<prefix>/*` to the addon's own
   * listener. Idempotent (replace-all); an addon with no data-plane registers an
   * empty set (cleared). Called off the capabilities-changed signal — a data-plane
   * isn't a cap, but the child is UDS-reachable and has served its endpoints by
   * the time any of its caps register.
   */
  /**
   * The UDS runner/child id an addon is reachable under. For a solo addon
   * (no `execution.group`) this is the addon id itself; for a grouped addon
   * it is the shared group name (`resolveRunnerId`). The single authority for
   * "which child hosts this addon" on the parent side — every gateway /
   * route-mount / data-plane-mount lookup routes through here so a grouped
   * addon (`execution.group`) is never misclassified as `in-process`.
   * Falls back to the addon id when the declaration is not yet known.
   */
  /** The runner id hosting an addon — its `execution.group`, or itself. */
  runnerIdFor(addonId: string): string {
    return this.childIdForAddon(addonId)
  }

  /**
   * A hub in-process keychain handle acting for `owner` — the door hub-main
   * code (the integration settings provider) uses to keep another addon's
   * values (D787). Never handed to an addon.
   */
  secretsForOwner(owner: string): SecretsAccess {
    return createSecretsAccess({
      owner,
      transport: this.inProcessKeychainTransport(owner),
      eventBus: this.eventBusService,
    })
  }

  /**
   * A hub in-process records handle acting for `owner` (D881): the provider is
   * reached straight, with the caller STATED - the one place a claim is trusted,
   * as for the keychain. Only a system builtin's `ctx.records.forOwner` ever
   * reaches a different owner.
   */
  private recordsForOwner(owner: string, secrets: SecretsAccess): RecordsAccess {
    return createRecordsAccess({
      owner,
      transport: this.inProcessRecordsTransport(owner),
      transportForOwner: (other) => this.inProcessRecordsTransport(other),
      secrets,
    })
  }

  private inProcessRecordsTransport(owner: string): RecordsTransport {
    const provider = (): IRecordsProvider => {
      const p = this.capabilityRegistry.getSingleton<IRecordsProvider>('records')
      if (p === null || p === undefined) throw new Error('records provider is not registered')
      return p
    }
    const as = <I extends object>(input: I): I & { readonly callerAddonId: string } =>
      Object.assign({}, input, { callerAddonId: owner })
    return {
      declareKinds: (input) => provider().declareKinds(as(input)),
      get: (input) => provider().get(as(input)),
      getMany: (input) => provider().getMany(as(input)),
      secretRefs: (input) => provider().secretRefs(as(input)),
      put: (input) => provider().put(as(input)),
      putMany: (input) => provider().putMany(as(input)),
      patch: (input) => provider().patch(as(input)),
      delete: (input) => provider().delete(as(input)),
      deleteMany: (input) => provider().deleteMany(as(input)),
      query: (input) => provider().query(as(input)),
      count: (input) => provider().count(as(input)),
      histogram: (input) => provider().histogram(as(input)),
      aggregate: (input) => provider().aggregate(as(input)),
      deleteWhere: (input) => provider().deleteWhere(as(input)),
      transact: (input) => provider().transact(as(input)),
      deleteDevice: (input) => provider().deleteDevice(as(input)),
      allocateId: (input) => provider().allocateId(as(input)),
    }
  }

  private childIdForAddon(addonId: string): string {
    const decl = this.addonEntries.get(addonId)?.declaration
    return decl ? resolveRunnerId(decl, addonId) : addonId
  }

  private async mountAddonDataPlanes(addonId: string): Promise<void> {
    const registry = this.dataPlaneRegistry
    if (!registry) return
    const entry = this.addonEntries.get(addonId)
    const childRegistry = this.moleculer.childRegistry
    // Forked addons only for now — co-located builtins would publish into the
    // registry directly via a hub-side sink (deferred; no builtin serves a
    // data-plane yet).
    //
    // Each of these three exits means "this addon CANNOT serve a data-plane
    // right now", and every one of them used to leave the previous registration
    // standing. The registry then held a `baseUrl` pointing at the port of a
    // process that no longer exists, and `/addon/:addonId/*` kept reverse-
    // proxying to it — a 502 per request until the replacement child finished
    // its handshake, or forever if the addon was removed. `unregisterAddon`
    // existed for exactly this and had no call site anywhere in the repo.
    //
    // Dropping is the safe direction: a data-plane that is absent from the
    // registry falls through to the control-route path, while a stale one
    // sends live traffic at a dead socket.
    if (
      !canServeDataPlane({
        hasEntry: entry !== undefined,
        isForked: entry !== undefined && this.isForkedAddonEntry(entry),
        childKnown:
          childRegistry !== null && childRegistry.isChildKnown(this.childIdForAddon(addonId)),
      })
    ) {
      registry.unregisterAddon(addonId)
      return
    }

    const raw = await this.addonCallGateway.callForked(addonId, { target: 'data-planes' })
    const endpoints = parseDataPlaneEndpoints(raw)
    registry.registerAddon(addonId, endpoints)
    if (endpoints.length > 0) {
      this.logger.info('Addon data-planes mounted (reverse-proxy)', {
        meta: { phase: 'v2', addonId, prefixes: endpoints.map((e) => e.prefix) },
      })
    }
  }

  /**
   * Called after app.init() when the tRPC router is available.
   * No-op now: addon `ctx.api` resolves to a broker-routed proxy, so
   * the direct tRPC caller is no longer constructed. Kept for backward
   * compat with `main.ts`'s bootstrap order.
   */
  async setAppRouter(_router: unknown): Promise<void> {
    this.logger.debug(
      'setAppRouter called — broker-routed addon API in use, no direct caller needed',
    )
  }

  /** Get the CapabilityRegistry for external consumers to register */
  getCapabilityRegistry(): CapabilityRegistry {
    return this.capabilityRegistry
  }

  /** Get the CustomActionRegistry — Task 7.2 will use this from the `api.addons.custom` tRPC procedure. */
  getCustomActionRegistry(): CustomActionRegistry {
    return this.customActionRegistry
  }

  getDeviceRegistry(): DeviceRegistry {
    return this.deviceRegistry
  }

  // ── Persisted device-parent mirror (F0.6) ─────────────────────────────────
  //
  // The scope matcher's parent→child accessory inheritance (`getDeviceAncestors`
  // in `trpc.context.ts`) needs a deviceId's ancestor chain on EVERY scoped
  // request. The hub `DeviceRegistry` only knows devices registered IN the hub
  // process, so it is EMPTY for every forked provider (reolink, hikvision, …):
  // a grant on a forked camera never reached its siren/floodlight/PIR children
  // (measured 0/6 providers inherited). The authoritative parentage lives in the
  // device-manager's PERSISTED meta, which `listAll` projects for the whole
  // fleet — forked devices included. This is a hub-process, SYNCHRONOUSLY
  // readable mirror of that parentage, refreshed OFF the request path on every
  // device-meta lifecycle event — never a per-call DB query.
  //
  // The mirror itself, and the rule that decides how much of the fleet one
  // event may re-read, live in `device-meta-mirror.ts` — with the 4 904-call /
  // 4 987 368-row boot census that made the rule necessary.
  private readonly deviceMirror: DeviceMetaMirror

  /** Persisted `DeviceType` string of a device, or null when unknown. Mirror
   *  first (covers forked devices), then the live hub registry. */
  getPersistedType = (deviceId: number): string | null => this.deviceMirror.typeOf(deviceId)

  /** Persisted operator `location` label of a device, or null when unset/unknown. */
  getPersistedLocation = (deviceId: number): string | null => this.deviceMirror.locationOf(deviceId)

  /**
   * The whole persisted fleet, slim — id + type + location + parentDeviceId.
   * Fuels the FLEET-wide selector expansion (response projection + `auth.me`
   * counts). Read synchronously off the mirror, never a per-call DB query.
   */
  getPersistedDeviceList = (): readonly DeviceMetaLike[] => this.deviceMirror.list()

  /**
   * Ancestor chain (parent, grandparent, …) of a device, bounded to 8 hops
   * (defence-in-depth against a corrupt registry cycle). Synchronous — it is
   * read on every scoped request. Backed by the persisted mirror so a grant on
   * a FORKED camera covers its accessory children. Empty for a top-level device
   * or one the hub has never heard of.
   */
  getPersistedAncestors = (deviceId: number): readonly number[] =>
    this.deviceMirror.ancestorsOf(deviceId)

  /**
   * Subscribe the mirror to every device-meta lifecycle event, and warm it once
   * the addon set (device-manager included) is up.
   *
   * The device events ask for a SCOPED refresh — the one device they name, or
   * nothing at all when they name a field the mirror does not hold.
   * `SystemAddonsReady` is the only fleet-wide read, and it is also the D8
   * reconcile: whatever a dropped event would have left stale, the warm
   * repairs.
   */
  private wireDeviceParentMirror(): void {
    for (const category of [
      EventCategory.DeviceMetaChanged,
      EventCategory.DeviceRegistered,
      EventCategory.DeviceUnregistered,
      EventCategory.DeviceProvisioned,
    ]) {
      this.eventBusService.subscribe({ category }, (event) => {
        this.deviceMirror.onDeviceEvent(event.data)
      })
    }
    this.eventBusService.subscribe({ category: EventCategory.SystemAddonsReady }, () => {
      void this.deviceMirror.refreshAll()
    })
  }

  /** Load persisted collection disabled-lists from settings-store into the registry */
  private loadCollectionPreferences(): void {
    // TODO: implement CapabilityRegistry.loadDisabledProviders() to restore persisted preferences
  }

  /** Durable cluster-node history (A1) — bind records kind after orphan declare. */
  setClusterNodeHistoryStore(store: ClusterNodeHistoryStore): void {
    this.clusterNodeHistoryStore = store
    this.bindClusterNodeHistoryRecordsKind()
  }

  private bindClusterNodeHistoryRecordsKind(): void {
    const clusterStore = this.clusterNodeHistoryStore
    const records = this.clusterAgentRecords
    if (clusterStore === null || records === null) return
    const kind = records.kind(clusterNodeHistoryRecordKind)
    clusterStore.bindRecordsKind(() => kind)
  }

  /** The unified token store (D892), bound to its `core-auth` records. */
  setCredentialTokenService(service: CredentialTokenService): void {
    this.credentialTokenService = service
  }

  private async wireHubMainOrphanRecords(store: ISettingsStoreProvider): Promise<void> {
    const recordsCap = this.capabilityRegistry.getSingleton<IRecordsProvider>('records')
    if (recordsCap === null || recordsCap === undefined) return

    const integrationRecords = this.recordsForOwner(
      'integration-registry',
      this.secretsForOwner('integration-registry'),
    )
    await integrationRecords.declare(integrationRegistryRecordKinds)
    this.integrationRegistry = new IntegrationRegistry(
      store,
      IntegrationRegistry.recordStoresOf(integrationRecords),
    )
    await this.integrationRegistry.initialize()
    this.logger.info('IntegrationRegistry initialized (records)', { meta: { phase: 'v2' } })

    const clusterRecords = this.recordsForOwner(
      'cluster-agent',
      this.secretsForOwner('cluster-agent'),
    )
    await clusterRecords.declare(clusterAgentRecordKinds)
    this.clusterAgentRecords = clusterRecords
    this.bindClusterNodeHistoryRecordsKind()

    const credentialTokens = this.credentialTokenService
    if (credentialTokens !== null) {
      const coreRecords = this.recordsForOwner('core-auth', this.secretsForOwner('core-auth'))
      // Every core-auth kind is declared, `share-view-tokens` included: its
      // pre-D895 rows stay on disk for the operator to drop, and nothing reads
      // them.
      await coreRecords.declare(coreAuthRecordKinds)
      const tokenKind = coreRecords.kind(coreAuthRecordKinds['credential-tokens'])
      credentialTokens.bindKind(() => tokenKind)
      // Dead rows (expired or revoked > 30 days) go at boot; the verifier
      // already refuses them, so this is housekeeping, never a gate.
      void credentialTokens.reap().catch((error: unknown) => {
        this.logger.warn('Token reap failed', {
          meta: { error: error instanceof Error ? error.message : String(error) },
        })
      })
    }
  }

  /**
   * Returns the IntegrationRegistry filtered to exclude orphaned integrations
   * (where the addon is not currently installed). Orphaned data stays in DB
   * and reconnects automatically when the addon is reinstalled.
   */
  getIntegrationRegistry(): import('@camstack/types').IIntegrationRegistry | null {
    if (!this.integrationRegistry) return null
    return this.createFilteredRegistry(this.integrationRegistry)
  }

  /**
   * Return the currently-active settings backend (the `settings-store`
   * capability provider). Null if no provider has been registered yet
   * (e.g. during early boot before builtins are loaded). Used by the
   * multi-level addon settings router to read/write addon-device
   * overrides directly.
   */
  getSettingsBackend(): ISettingsBackend | null {
    return this.activeSettingsBackend
  }

  /** Get the raw (unfiltered) registry — only for internal addon wiring */
  getRawIntegrationRegistry(): import('@camstack/types').IIntegrationRegistry | null {
    return this.integrationRegistry
  }

  /**
   * The installed-addon VIEW over the integration store. The rule it enforces
   * — a principal that cannot read an integration must not create one, and a
   * read that hides an existing row says so — lives in
   * `integration-visibility.ts`, on its own, with its own tests.
   */
  private createFilteredRegistry(
    raw: import('@camstack/types').IIntegrationRegistry,
  ): import('@camstack/types').IIntegrationRegistry {
    return createFilteredIntegrationRegistry({
      raw,
      // The LIVE map, not a snapshot: an addon registered after this wrapper
      // was built is installed, and a stale copy would refuse its first write.
      isAddonInstalled: (addonId) => this.addonEntries.has(addonId),
      logger: this.logger,
    })
  }

  // InferenceCapabilitiesService removed — now lives in pipeline-executor addon.
  // Use capabilityRegistry.getSingleton('pipeline-executor') instead.

  /** Log a standardized lifecycle line for addon start/restart */
  private logAddonLifecycle(
    event: 'started' | 'restarted',
    id: string,
    mode: 'in-process' | 'isolated',
  ): void {
    const entry = this.addonEntries.get(id)
    if (!entry) return
    const agentName = process.env.CAMSTACK_AGENT_NAME ?? 'hub'
    const platform = `${os.platform()}/${os.arch()}`
    const message = `Addon ${event} — v${entry.packageVersion} (${entry.packageName}), ${mode}, ${platform}, agent: ${agentName}`
    // Log under AddonRegistry scope
    this.logger.info(message, {
      tags: { addonId: id, agentId: agentName },
      meta: { phase: 'lifecycle' },
    })
    // Also log under the addon's own tagged logger so it appears in the per-addon
    // log viewer. No scope — brand bracket shows the addon id.
    const addonLogger = this.loggingService.createLogger()
    addonLogger.info(message, { tags: { addonId: id, agentId: agentName } })
  }

  // Platform probing and inference-config resolution have moved into the
  // `platform-probe` capability. Addons call `ctx.api.platformProbe.*`
  // during their own initialize(). The backend no longer loops addons
  // looking for `getModelRequirements` / `configure` — those hooks were
  // removed from the ICamstackAddon contract.

  /**
   * Loads a package's optional `i18n/<lang>.json` catalogs (D863). The
   * namespace is the package's short name (`@camstack/addon-provider-reolink`
   * -> `provider-reolink`): one package may host several addons, and the
   * catalog lives with the package. A broken file is logged and ignored.
   */
  private loadAddonCatalogs(packageName: string, addonDir: string | undefined): void {
    if (addonDir === undefined) return
    const ns = catalogNamespaceOf(packageName)
    const catalogs = getCatalogRegistry((message) => this.logger.warn(message, { meta: { ns } }))
    catalogs.clear(ns)
    catalogs.loadAddonDir(ns, addonDir)
  }

  registerAddon(
    addon: ICamstackAddon,
    source: AddonSource = 'installed',
    packageName?: string,
    packageVersion?: string,
  ): void {
    const manifest = addon.manifest
    if (!manifest) {
      throw new Error(
        'Cannot register addon without manifest — was it created via AddonLoader.createInstance()?',
      )
    }
    this.addonEntries.set(manifest.id, {
      addon,
      initialized: false,
      source,
      packageName: packageName ?? manifest.name ?? manifest.id,
      packageVersion: packageVersion ?? manifest.version ?? '0.0.0',
      declaredCapabilities: this.getAddonCapabilities(addon),
    })
  }

  async initializeAddon(id: string): Promise<void> {
    const entry = this.addonEntries.get(id)
    if (!entry) {
      throw new Error(`Addon "${id}" is not registered`)
    }

    if (!entry.addon?.manifest?.id) {
      throw new Error(`Addon "${id}" has no manifest.id — check the addon class default export`)
    }

    // Decide whether this addon should boot in its own forked runner
    // subprocess. The runner-spawn pass during initial boot already
    // spawned every eligible addon; `initializeAddon` is the per-addon
    // entry point reached by the hot-load / restart flows (and by the
    // Pass 1/2/3 in-process boot for `@camstack/system` builtins). Fork
    // only when the addon declares an `execution` block, ships an
    // on-disk `addonDir`, and is not `agent-only`; otherwise (only
    // `@camstack/system` builtins reach the in-process path below) it
    // boots in-process on the hub.
    if (this.isForkedAddonEntry(entry)) {
      // D5 + co-location: a forked addon ALWAYS boots in a runner — there is
      // NO in-process-on-the-hub fallback. `ensureForkedRunner` resolves the
      // addon's runner id (`resolveRunnerId`) and spawns/joins the FULL
      // co-located roster: a groupless addon gets its own runner (one addon,
      // one process — unchanged), while a `execution.group` member co-locates
      // with its siblings so cross-addon cap calls resolve in-process (zero
      // copy). Idempotent when a sibling already brought the group up. If the
      // spawn fails, the addon is `failed`, surfaced as `addon.error` +
      // recorded on the health monitor; it does not silently run on the hub.
      // (Task 7's circuit breaker governs the retry policy on top of this.)
      //
      // Provider registration for forkable addons is delegated to the
      // `CapabilityBridge` (see `MoleculerService.onProviderConnected`);
      // custom actions are (re-)registered inside `ensureForkedRunner`.
      try {
        await this.ensureForkedRunner(id, { restart: false })
      } catch (err) {
        const msg = errMsg(err)
        this.logger.error('Failed to spawn isolated runner for addon', {
          tags: { addonId: id },
          meta: { error: msg },
        })
        this.emitAddonLifecycleEvent('addon.error', id, {
          error: msg,
          action: 'initialize',
        })
        this.healthMonitor.recordFailure(entry.packageName, err, id)
        throw new Error(`Failed to spawn runner for addon "${id}": ${msg}`, { cause: err })
      }

      entry.initialized = true
      this.logger.info('Addon spawned as isolated process', { tags: { addonId: id } })
      this.emitAddonLifecycleEvent('addon.started', id)
      return
    }

    // In-process initialization — capture providers from initialize() return value
    const context = await this.createAddonContext(entry.addon)
    const capturedProviders = new Map<string, unknown>()
    // Device-manager needs privileged access to CapabilityRegistry — it
    // resolves native addon ids for getBindings, lists registered wrappers,
    // etc. Inject before initialize() runs so the addon's onInitialize can
    // rely on it.
    const initResult = normalizeAddonInitResult(await entry.addon.initialize(context))
    // NOTE: `postBrokerStart()` is deliberately NOT called here. It used to
    // fire right after `initialize()` and would emit readiness events whose
    // subscribers (remote workers) immediately called `ctx.api.<addon>.*` —
    // hitting "Service not found" because `broker.createService()` had not
    // been called yet. See below: postBrokerStart fires after the Moleculer
    // service mount so the advertised service is live before readiness.

    for (const reg of initResult?.providers ?? []) {
      const capName = reg.capability.name
      capturedProviders.set(capName, reg.provider)
      context.registerProvider(capName, reg.provider)
      // D4: wrapper behaviour is read from the cap DEFINITION. The runtime
      // ProviderRegistration.kind/defaultActive are deprecated hints — if an
      // addon still sets them and they disagree, warn (the cap def wins).
      const kindDrift = describeProviderKindDrift(capName, reg.capability, {
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- this IS the drift detector; it reads the deprecated hint on purpose
        kind: reg.kind,
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- this IS the drift detector; it reads the deprecated hint on purpose
        defaultActive: reg.defaultActive,
      })
      if (kindDrift) {
        this.logger.warn(kindDrift, {
          tags: { addonId: id },
          meta: { capability: capName },
        })
      }
      if (reg.capability.kind === 'wrapper') {
        this.capabilityRegistry.registerWrapper(capName, id, {
          defaultActive: reg.capability.defaultActive === true,
        })
      }
    }

    // Task 7.1: register system-level custom actions if the addon declares any.
    if (initResult?.customActions && initResult.actionHandlers) {
      const handlers = initResult.actionHandlers
      try {
        this.customActionRegistry.registerAddon(
          id,
          initResult.customActions,
          (action, input, caller) => {
            const fn = handlers[action]
            if (!fn) throw new Error(`addon '${id}' has no handler for custom action '${action}'`)
            return fn(input, caller)
          },
        )
      } catch (err) {
        this.logger.error('Failed to register custom actions for addon', {
          tags: { addonId: id },
          meta: { error: errMsg(err) },
        })
        throw err
      }
    }

    // Validate all declared capabilities have providers registered.
    // Include caps registered via `context.registerProvider()` side-effects
    // (e.g. sub-components of an addon calling ctx.registerProvider directly
    // without returning via ProviderRegistration[]), by reading back from the
    // CapabilityRegistry for this addonId. This keeps the validation accurate
    // without forcing addons into a single return-path pattern.
    if (entry.declaration) {
      for (const cap of entry.declaration.capabilities ?? []) {
        const capName = typeof cap === 'string' ? cap : cap.name
        if (capturedProviders.has(capName)) continue
        const provider = this.capabilityRegistry.getProviderByAddon(capName, id)
        if (provider) capturedProviders.set(capName, provider)
      }
      validateProviderRegistrations(id, entry.declaration, capturedProviders, this.logger)
    }

    await this.restoreAddonDevices(id, entry.addon)
    entry.initialized = true

    // Register as Moleculer service for remote discoverability
    if (entry.declaration) {
      try {
        // Resolve method names from CapabilityDefinitions registered in the registry
        const methodResolver = (capName: string): readonly string[] => {
          const def = this.capabilityRegistry.getDefinition(capName)
          if (!def?.methods) return []
          return Object.keys(def.methods)
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- createAddonService return type unresolvable due to upstream eventemitter2/moleculer type chain
        const schema = createAddonService(entry.addon, entry.declaration!, {
          methodResolver,
          providers: capturedProviders,
        })
        this.broker.createService(schema)
      } catch (err) {
        this.logger.warn('Failed to register Moleculer service', {
          tags: { addonId: id },
          meta: { error: errMsg(err) },
        })
      }
    }

    // Post-broker-start readiness — emitted AFTER the Moleculer service is
    // mounted so that any remote subscriber reacting to a `ready` event can
    // immediately call `ctx.api.<addon>.*` without hitting a phantom
    // service window. Hub addons with `autoEmitReadiness=true` emit here;
    // addons that manage their own readiness override `autoEmitReadiness`.
    entry.addon.postBrokerStart()

    this.logger.info('Addon initialized in-process', {
      tags: { addonId: id },
      meta: { packageName: entry.packageName },
    })
    this.logAddonLifecycle('started', id, 'in-process')
    this.emitAddonLifecycleEvent('addon.started', id)
  }

  /**
   * Restore persisted devices for an addon after it has been initialized.
   * Calls addon.restoreDevices() with the list of devices saved to the DB.
   * No-op if the addon does not implement restoreDevices() or stores are not available.
   */
  private async restoreAddonDevices(addonId: string, addon: ICamstackAddon): Promise<void> {
    if (typeof addon.restoreDevices !== 'function') return

    // Route through the device-persistence capability instead of
    // accessing DeviceStore/ConfigStore directly. This keeps
    // AddonRegistryService decoupled from the persistence layer —
    // the capability addon owns the stores.
    const api = this.getBrokerApi()
    try {
      const listResult: unknown = await (
        Reflect.get(Reflect.get(api, 'deviceManager') as object, 'listPersistedByAddon') as {
          query: (input: unknown) => Promise<unknown>
        }
      ).query({ addonId })

      const rows = Array.isArray(listResult)
        ? (listResult as Array<{
            id: number
            stableId: string
            type: string
            name: string
            location?: string | null
            disabled?: boolean
            parentDeviceId: number | null
          }>)
        : []
      if (rows.length === 0) return

      const savedDevices: SavedDevice[] = await Promise.all(
        rows.map(async (row) => {
          const configResult: unknown = await (
            Reflect.get(Reflect.get(api, 'deviceManager') as object, 'loadConfig') as {
              query: (input: unknown) => Promise<unknown>
            }
          ).query({ deviceId: row.id })

          return {
            id: row.id,
            stableId: row.stableId,
            type: row.type as import('@camstack/types').DeviceType,
            name: row.name,
            location: row.location ?? null,
            disabled: row.disabled ?? false,
            parentDeviceId: row.parentDeviceId,
            config: (configResult ?? {}) as Record<string, unknown>,
          }
        }),
      )

      await addon.restoreDevices!(savedDevices)
      this.logger.info('Restored devices for addon', {
        tags: { addonId },
        meta: { count: savedDevices.length },
      })
    } catch (err) {
      this.logger.error('restoreDevices failed for addon', {
        tags: { addonId },
        meta: { error: errMsg(err) },
      })
    }
  }

  /**
   * Refresh the package version for all addons from a given package.
   * Call this after an update to ensure the UI shows the new version.
   */
  refreshPackageVersion(packageName: string, newVersion: string): void {
    for (const [, entry] of this.addonEntries) {
      if (entry.packageName === packageName) {
        entry.packageVersion = newVersion
        this.logger.info('Updated addon packageVersion', {
          tags: { addonId: entry.addon.manifest!.id },
          meta: { newVersion },
        })
      }
    }
  }

  /** Emit addon.uninstalled lifecycle event for all addons belonging to a package */
  emitUninstallEvent(packageName: string): void {
    for (const [id, entry] of this.addonEntries) {
      if (entry.packageName === packageName) {
        this.emitAddonLifecycleEvent('addon.uninstalled', id)
      }
    }
    // Drop the package from the health monitor so its retry loop
    // doesn't keep trying to reload an addon the operator explicitly
    // removed. Matching `clearLoadFailures` purges any pre-init
    // failures still tracked by the addon-loader.
    this.healthMonitor.forget(packageName)
    this.addonLoader.clearLoadFailures(packageName)
  }

  /**
   * Emit `addon.updated` for every addon belonging to a package.
   *
   * The payload shape is {@link addonUpdatePayload} — an unknown predecessor
   * is an ABSENT key, never a placeholder.
   */
  emitUpdateEvent(packageName: string, fromVersion: string | null, toVersion: string): void {
    const payload = addonUpdatePayload(fromVersion, toVersion)
    for (const [id, entry] of this.addonEntries) {
      if (entry.packageName === packageName) {
        this.emitAddonLifecycleEvent('addon.updated', id, payload)
      }
    }
  }

  /** Addon ids this node has loaded from `packageName`. */
  listAddonIdsForPackage(packageName: string): string[] {
    const ids: string[] = []
    for (const [id, entry] of this.addonEntries) {
      if (entry.packageName === packageName) ids.push(id)
    }
    return ids
  }

  /**
   * Restart every addon a package declares, deduped by runner.
   *
   * A package is not an addon: `@camstack/addon-pipeline` declares six
   * (`pipeline-runner`, `detection-pipeline`, `motion-wasm`,
   * `audio-analyzer`, `stream-broker`, `recorder`), and NONE of them is
   * called `pipeline`. Deriving a single addon id from the package name
   * therefore restarts nothing for exactly the packages that matter most —
   * which is why the post-update confirmation had no idea whether the new
   * version actually came up.
   *
   * `restartAddon` respawns the WHOLE co-location runner (D2), so members
   * sharing a runner are collapsed into one restart.
   *
   * `success` is true only when every runner came back. The caller uses it
   * to decide whether to drop the rollback backup.
   */
  async restartPackage(packageName: string): Promise<PackageRestartResult> {
    const ids = this.listAddonIdsForPackage(packageName)
    if (ids.length === 0) {
      return {
        success: false,
        restarted: [],
        errors: [`No loaded addon belongs to package "${packageName}"`],
      }
    }

    const restarted: string[] = []
    const errors: string[] = []
    const doneRunners = new Set<string>()
    for (const addonId of ids) {
      const runnerId = this.childIdForAddon(addonId)
      if (doneRunners.has(runnerId)) {
        restarted.push(addonId)
        continue
      }
      doneRunners.add(runnerId)
      try {
        const res = await this.restartAddon(addonId)
        if (res.success) restarted.push(addonId)
        else errors.push(res.error ?? `restart of "${addonId}" reported failure`)
      } catch (err: unknown) {
        errors.push(`restart of "${addonId}" threw: ${errMsg(err)}`)
      }
    }
    return { success: errors.length === 0, restarted, errors }
  }

  /**
   * Restart an addon by ID.
   * Shuts down, unregisters capabilities, re-initializes, and re-wires.
   */
  async restartAddon(addonId: string): Promise<{ success: boolean; error?: string }> {
    const entry = this.addonEntries.get(addonId)
    if (!entry) {
      return { success: false, error: `Addon "${addonId}" not found` }
    }

    this.logger.info('Addon restarting...', { tags: { addonId }, meta: { phase: 'lifecycle' } })

    // Suppress the "Failed to load" health banner during operator-initiated
    // restarts. The Moleculer `$node.disconnected` handler skips entries
    // present in `restartingAddons`; a 90s safety timer clears the flag
    // even if the restart path throws before the finally block runs.
    // Suppress the banner for the restarted addon AND — for a co-location
    // group — every SIBLING sharing its runner. `ensureForkedRunner` respawns
    // the WHOLE group process, so all members briefly `$node.disconnect`; without
    // suppressing the siblings too, each would flash a spurious "Failed to load".
    const suppressed = new Set<string>([addonId])
    if (this.isForkedAddonEntry(entry)) {
      const runnerId = resolveRunnerId(entry.declaration, addonId)
      for (const { addonId: siblingId } of this.buildAddonGroupPlan([
        ...this.addonEntries.keys(),
      ]).get(runnerId) ?? []) {
        suppressed.add(siblingId)
      }
    }
    for (const id of suppressed) {
      const prior = this.restartingAddons.get(id)
      if (prior) clearTimeout(prior)
      const timer = setTimeout(() => {
        this.restartingAddons.delete(id)
      }, 90_000)
      this.restartingAddons.set(id, timer)
    }

    try {
      // Group-runner-hosted addon — converge the runner topology onto the
      // declared group, then respawn it. `ensureForkedRunner({ restart: true })`
      // both (a) adopts a NEW roster if `execution.group` changed since the
      // runner last spawned (stop stale solo runners → spawn the group; a plain
      // `$process.restart` would respawn the OLD roster forever), and (b) on the
      // common path respawns the group in place so the child reboots the WHOLE
      // roster from the freshly-swapped on-disk bundle. Updating ONE member of a
      // group therefore respawns the ENTIRE group — they share a process.
      if (this.isForkedAddonEntry(entry)) {
        // Snapshot which declared caps are ACTUALLY registered right now —
        // the post-restart wait below must only gate on these. Device-scoped
        // caps (vacuum-control, valve, humidifier, …) register only when a
        // device using them exists: waiting for a cap that was NOT registered
        // before the restart burns the full 120s timeout for nothing (live:
        // integrations.create held its mutation — and the creation modal —
        // for 2 minutes on the HA addon's 8 deviceless caps).
        const preRegistered = new Set(
          entry.declaredCapabilities
            .map((cap) => cap.name)
            .filter((name) => this.capabilityRegistry.getProviderByAddon(name, addonId) != null),
        )
        await this.ensureForkedRunner(addonId, { restart: true })

        // The respawn resolves as soon as the child is up, not when its
        // capabilities are re-registered. Callers (integrations.create, UI forms) may
        // immediately try to route to the provider and hit a transient null. Block here
        // until every declared capability is back on the registry so the restart is
        // observable-consistent from the caller's perspective.
        const declared = entry.declaredCapabilities
        if (declared.length > 0) {
          // Group-runner restarts pay a multi-step cost: child fork
          // (~1s) → addon init (Python pool warmup ~5-10s, or a CLI
          // subprocess probe for tailscale-ingress etc.) → capability
          // advertisement to hub via Moleculer service discovery
          // (~5s on cold start). Any fixed ceiling is wrong — a slow
          // restart that DID eventually succeed produces a misleading
          // "did not re-register in time" error. Wait indefinitely: if
          // the group-runner crashed for real, `$node.disconnected`
          // surfaces it through the health monitor; the operator can
          // always click Cancel on the UI mutation.
          // Wait for declared caps to re-register, but BOUNDED — and on timeout
          // do NOT throw. DEVICE-SCOPED caps (e.g. a camera provider's
          // `device-provider` / `snapshot-provider`) only ever register once
          // devices exist; on a hub with none they NEVER come back, so an
          // infinite wait hangs the whole update — and the lifecycle job that
          // drives it (apply task stuck at `applying`, framework-last blocked,
          // the job uncancellable). The on-disk swap + runner restart have
          // already succeeded here; any caps still pending re-register
          // asynchronously as their devices come online. We only WARN which
          // caps were still pending (the comment's original objection was a
          // *misleading error* on timeout — a warning avoids that while still
          // letting the update finalize).
          const REGISTER_WAIT_MS = 120_000
          // Gate ONLY on the caps that were registered BEFORE the restart —
          // those are the ones a caller could have been routing to. Caps that
          // were absent (device-scoped, no device yet) re-register
          // asynchronously whenever their devices appear; waiting for them
          // here held integrations.create (and its modal) for the full
          // timeout on every deviceless declared cap.
          const gated = declared.filter((cap) => preRegistered.has(cap.name))
          const skipped = declared.filter((cap) => !preRegistered.has(cap.name))
          if (skipped.length > 0) {
            this.logger.debug(
              `Addon "${addonId}" restart: not gating on ${skipped.length} cap(s) that were ` +
                `unregistered pre-restart (device-scoped, awaiting devices): ${skipped.map((c) => c.name).join(', ')}`,
              { tags: { addonId } },
            )
          }
          const waits = gated.map((cap) =>
            this.capabilityRegistry.waitForProvider(cap.name, addonId, REGISTER_WAIT_MS),
          )
          const settled = await Promise.all(waits)
          const missing = gated
            .map((cap, i) => (settled[i] == null ? cap.name : null))
            .filter((name): name is string => name !== null)
          if (missing.length > 0) {
            this.logger.warn(
              `Addon "${addonId}" restarted; ${missing.length} capability(ies) not yet re-registered ` +
                `(re-register asynchronously — e.g. device-scoped caps awaiting devices): ${missing.join(', ')}`,
              { tags: { addonId } },
            )
          }
        }

        // Custom actions are re-registered inside `ensureForkedRunner` for
        // every roster member (custom actions live in the hub-side
        // `CustomActionRegistry`, which the process spawn never touches — a
        // hot-update would otherwise silently drop them).

        this.logAddonLifecycle('restarted', addonId, 'isolated')
        this.emitAddonLifecycleEvent('addon.restarted', addonId)
        return { success: true }
      }

      // D5: a forked addon ALWAYS restarts via `$process.restart` above
      // (process restart — no in-process hot-reload of a live forked
      // addon). This branch is reached only by `@camstack/system` builtins
      // — they have no runner and legitimately reload in-process:
      // shutdown, unregister, re-initialize, re-wire.
      if (entry.initialized && entry.addon.shutdown) {
        await entry.addon.shutdown()
      }
      // Drain disposers registered via ctx.addDisposer(...)
      await this.drainDisposerChain(addonId)

      // Unregister all capabilities provided by this addon
      for (const cap of entry.declaredCapabilities) {
        this.capabilityRegistry.unregisterProvider(cap.name, addonId)
      }
      const manifestCaps = this.getAddonCapabilities(entry.addon)
      for (const cap of manifestCaps) {
        this.capabilityRegistry.unregisterProvider(cap.name, addonId)
      }
      this.capabilityRegistry.unregisterAllWrappersForAddon(addonId)

      // Task 7.1: drop any registered custom actions so re-initialization re-registers cleanly.
      this.customActionRegistry.unregisterAddon(addonId)

      // Destroy existing Moleculer service for this addon
      try {
        await (
          this.moleculer.broker as {
            destroyService(name: string): Promise<void>
          }
        ).destroyService(addonId)
      } catch {
        // Service may not exist if it was never registered
      }

      entry.initialized = false

      // Re-initialize and re-wire capabilities
      await this.initializeAddon(addonId)
      this.wireCapabilities(addonId)

      this.logAddonLifecycle('restarted', addonId, 'in-process')
      this.emitAddonLifecycleEvent('addon.restarted', addonId)
      return { success: true }
    } catch (err) {
      const msg = errMsg(err)
      this.logger.error('Failed to restart addon', { tags: { addonId }, meta: { error: msg } })
      this.emitAddonLifecycleEvent('addon.error', addonId, {
        error: msg,
        action: 'restart',
      })
      // Record the failure on the health monitor so the addon shows up
      // `failed` with its `lastError` instead of a stale `healthy`. The
      // in-process branch already unregistered every capability before
      // `initializeAddon` threw — without this the addon is invisible-
      // broken: caps gone, health green, nothing on the Addons page.
      // The "operator sees the error via the mutation result" assumption
      // only holds for a UI-clicked restart; a `camstack deploy` or a
      // `requiresRestart` auto-restart is fire-and-forget — the failure
      // would otherwise vanish. recordFailure also arms the retry loop.
      this.healthMonitor.recordFailure(entry.packageName, err, addonId)
      return { success: false, error: msg }
    } finally {
      // Clear the suppression flags (restarted addon + any group siblings)
      // regardless of success/failure — if the restart failed, the operator
      // sees the real error via the mutation result rather than a misleading
      // transient health blip.
      for (const id of suppressed) {
        const timer = this.restartingAddons.get(id)
        if (timer) clearTimeout(timer)
        this.restartingAddons.delete(id)
      }
    }
  }

  getAddon(id: string): ICamstackAddon | null {
    const entry = this.addonEntries.get(id)
    return entry?.addon ?? null
  }

  getAddonEntry(id: string): { addon: ICamstackAddon } | null {
    const entry = this.addonEntries.get(id)
    return entry ? { addon: entry.addon } : null
  }

  /**
   * Returns the on-disk package directory for the given addon ID.
   * Used by the /api/addon-assets route to serve static files (e.g. SVG icons).
   *
   * Falls back to a disk scan when the addon isn't in `addonEntries`
   * (typical for failed-to-load packages: dist/manifest still on disk
   * but the import threw, so the registry never recorded an entry).
   * Without this fallback the icon endpoint 404s and the operator
   * sees a broken-image placeholder for any failed addon.
   */
  getAddonPackageDir(id: string): string | null {
    const entry = this.addonEntries.get(id)
    if (entry?.addonDir) return entry.addonDir
    return this.findAddonDirOnDisk(id)
  }

  private findAddonDirOnDisk(addonId: string): string | null {
    const dataDir = path.resolve(process.env.CAMSTACK_DATA ?? 'camstack-data')
    const addonsDir = process.env.CAMSTACK_ADDONS_DIR ?? path.resolve(dataDir, 'addons')
    if (!fs.existsSync(addonsDir)) return null

    const visit = (pkgDir: string): string | null => {
      const pkgJsonPath = path.join(pkgDir, 'package.json')
      if (!fs.existsSync(pkgJsonPath)) return null
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as Record<string, unknown>
        const camstack = (pkg['camstack'] as { addons?: unknown[] } | undefined) ?? {}
        const addons = Array.isArray(camstack.addons)
          ? (camstack.addons as Record<string, unknown>[])
          : []
        if (addons.some((a) => a['id'] === addonId)) return pkgDir
      } catch {
        return null
      }
      return null
    }

    const entries = fs.readdirSync(addonsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dirName = entry.name
      if (dirName === 'node_modules' || dirName.startsWith('.')) continue
      const fullPath = path.join(addonsDir, dirName)
      if (dirName.startsWith('@')) {
        for (const sub of fs.readdirSync(fullPath, { withFileTypes: true })) {
          if (!sub.isDirectory()) continue
          const found = visit(path.join(fullPath, sub.name))
          if (found) return found
        }
      } else {
        const found = visit(fullPath)
        if (found) return found
      }
    }
    return null
  }

  /**
   * Resolve an addon's on-disk installation directory and the dist
   * sub-directory that contains its built entry. For singleton-package
   * addons the dist sub-directory is `dist/`; for bundled addons (where
   * one npm package ships multiple addon entries) it's `dist/<entryId>/`.
   *
   * Used by the static-file route handler that serves widget bundles
   * (`/api/addon-widgets/:addonId/*`) — post bundle merge, the addonId →
   * package-path mapping is no longer 1:1, so callers MUST go through
   * the registry instead of guessing `addons/@camstack/addon-<id>/dist/`.
   *
   * Returns null if the addonId is unknown or the entry's package.json
   * has no `entry` field. The returned `distDir` is an absolute path.
   */
  getAddonInstallPath(addonId: string): { addonDir: string; distDir: string } | null {
    const entry = this.addonEntries.get(addonId)
    if (!entry?.addonDir || !entry.declaration?.entry) return null
    const distSubdir = path.dirname(entry.declaration.entry)
    return {
      addonDir: entry.addonDir,
      distDir: path.resolve(entry.addonDir, distSubdir),
    }
  }

  /**
   * Build an AddonContext for a given addon — same as what initialize() receives.
   * Used by the benchmark system to create fresh addon instances with custom config.
   */
  async buildAddonContext(addonId: string): Promise<AddonContext | null> {
    const entry = this.addonEntries.get(addonId)
    if (!entry) return null
    return this.createAddonContext(entry.addon)
  }

  /**
   * True when the entry's manifest opted into protection (uninstall
   * disabled). The flag is per-addon (`camstack.addons[N].protected`)
   * but the kernel uninstall API operates on packages — so a package
   * is treated as protected if ANY of its addons declares the flag.
   * Computed at call time from the running registry; no hardcoded
   * package list to keep in sync.
   */
  isPackageProtected(packageName: string): boolean {
    for (const entry of this.addonEntries.values()) {
      if (entry.packageName !== packageName) continue
      if (entry.declaration?.protected === true) return true
    }
    return false
  }

  /**
   * True when the entry boots in its own forked runner. This MUST mirror
   * the fork authority `buildAddonGroupPlan`, which spawns a runner for
   * every addon that ships an on-disk `addonDir` + a manifest
   * `declaration`, is NOT a `@camstack/system` builtin, and is NOT
   * `agent-only`. The `execution` block is OPTIONAL — an addon with no
   * `execution` declaration still forks on its own dedicated runner
   * (`resolveRunnerId` falls back to the addon id). Requiring `execution`
   * here previously diverged from `buildAddonGroupPlan`: an addon like
   * `auth-oidc` (no `execution` block) was forked at boot yet classified
   * in-process by this predicate, so its route-mount took the co-located
   * path and received the async UDS cap proxy whose `getRoutes()` returns
   * a Promise (→ `getRoutes(...).map is not a function`). Only
   * `@camstack/system` builtins boot in-process on the hub — except one that
   * declares `execution.isolate`, which forks like anything else. Both
   * questions are answered by `runsInOwnRunner`, so the two can no longer
   * disagree. The type predicate narrows both `addonDir` and `declaration`
   * for callers.
   */
  private isForkedAddonEntry(
    entry: AddonEntry,
  ): entry is AddonEntry & { addonDir: string; declaration: AddonDeclaration } {
    return !!(entry.declaration && entry.addonDir && this.runsInOwnRunner(entry))
  }

  /** Per-entry helper used by `listAddons()` to mark a row removable / not. */
  private isRequiredEntry(entry: AddonEntry): boolean {
    if (entry.declaration?.protected === true) return true
    // Fall back to a sibling addon in the same package — the
    // protected-by-association rule above. Catches the case where the
    // SAME package ships an aggregator addon (protected: true) plus
    // a source addon (protected: false): both rows should render
    // as non-removable because uninstalling the package would tear
    // out both.
    return this.isPackageProtected(entry.packageName)
  }

  listAddons(): Array<{
    manifest: AddonDeclaration & {
      packageName: string
      packageVersion: string
      packageDisplayName?: string
      bundle?: { displayName: string; description?: string; icon?: string }
      protected?: boolean
      removable?: boolean
    }
    declaration?: AddonDeclaration
    source: AddonSource
    installSource?: 'npm' | 'local' | 'upload'
    process?: AddonProcessView
  }> {
    // The real process-service state of each addon's runner (D877) - the last
    // `refreshRunnerStates()` answer; `unknown` before the first one.
    const runnerStates = this.runnerStates
    const processFor = (id: string, entry: AddonEntry): AddonProcessView | undefined =>
      describeAddonProcess({
        forked: this.runsInOwnRunner(entry),
        initialized: entry.initialized === true,
        runnerId: entry.declaration ? resolveRunnerId(entry.declaration, id) : id,
        runners: runnerStates,
        hubPid: process.pid,
      })

    const live = Array.from(this.addonEntries.values())
      .filter((entry) => entry.addon?.manifest?.id)
      .map((entry) => {
        let installSource: 'npm' | 'local' | 'upload' | undefined
        if (entry.addonDir) {
          try {
            const markerPath = path.join(entry.addonDir, '.install-source')
            if (fs.existsSync(markerPath)) {
              const raw = fs.readFileSync(markerPath, 'utf-8').trim()
              // Normalize legacy 'workspace' → 'local'
              const normalized = raw === 'workspace' ? 'local' : raw
              if (normalized === 'npm' || normalized === 'local' || normalized === 'upload') {
                installSource = normalized
              }
            }
          } catch (err) {
            this.logger.debug('Failed to read install-source marker for addon', {
              meta: { error: errMsg(err) },
            })
          }
        }
        return {
          manifest: {
            // Overlay the fresh on-disk declaration (refreshed by
            // `loadNewAddons` on every `camstack deploy`) onto the live
            // instance manifest, so a redeployed addon's new capabilities /
            // brokerKind surface here without a full backend restart. See
            // `overlayDeclaration` — this is what keeps Home Assistant
            // (post broker rework: broker + device-adoption) visible in the
            // "+ New Integration" picker.
            ...overlayDeclaration(entry.addon.manifest!, entry.declaration),
            packageName: entry.packageName,
            packageVersion: entry.packageVersion,
            packageDisplayName: entry.packageDisplayName,
            ...(entry.bundle !== undefined ? { bundle: entry.bundle } : {}),
            protected: this.isRequiredEntry(entry) || undefined,
            removable: this.isRequiredEntry(entry) ? false : undefined,
          },
          declaration: entry.declaration,
          source: entry.source,
          installSource,
          process: processFor(entry.addon.manifest!.id, entry),
        }
      })

    // Surface packages that exist on disk but failed to load — typical
    // causes are dep-version mismatch, missing native binary, or a
    // corrupted dist. Without this, an operator sees "installed" via
    // the package manifest but can't find the row in the addons UI to
    // diagnose or uninstall, leaving the package stranded.
    const seenPackages = new Set(live.map((row) => row.manifest.packageName))
    const failed = this.scanFailedToLoadPackages(seenPackages)
    return [...live, ...failed]
  }

  /**
   * Walk `<dataDir>/addons/` for `package.json` files whose declared
   * `camstack.addons[]` entries don't appear in `addonEntries`. Returns
   * synthetic listing rows so the UI can show + delete them. The rows
   * carry a `process.state: 'failed'` flag so the AddonCard can render
   * the diagnostic state distinctly from a normal addon.
   */
  private scanFailedToLoadPackages(seenPackages: ReadonlySet<string>): Array<{
    manifest: AddonDeclaration & {
      packageName: string
      packageVersion: string
      packageDisplayName?: string
      protected?: boolean
      removable?: boolean
    }
    declaration?: AddonDeclaration
    source: AddonSource
    installSource?: 'npm' | 'local' | 'upload'
    process?: AddonProcessView
  }> {
    const dataDir = path.resolve(process.env.CAMSTACK_DATA ?? 'camstack-data')
    const addonsDir = process.env.CAMSTACK_ADDONS_DIR ?? path.resolve(dataDir, 'addons')
    if (!fs.existsSync(addonsDir)) return []

    type Row =
      ReturnType<AddonRegistryService['scanFailedToLoadPackages']> extends Array<infer R>
        ? R
        : never
    const out: Row[] = []
    const visit = (pkgDir: string): void => {
      const pkgJsonPath = path.join(pkgDir, 'package.json')
      if (!fs.existsSync(pkgJsonPath)) return
      let pkg: Record<string, unknown>
      try {
        pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as Record<string, unknown>
      } catch {
        return
      }
      const packageName = typeof pkg['name'] === 'string' ? pkg['name'] : ''
      const packageVersion = typeof pkg['version'] === 'string' ? pkg['version'] : '0.0.0'
      if (!packageName || seenPackages.has(packageName)) return
      const camstack = (pkg['camstack'] as { addons?: unknown[] } | undefined) ?? {}
      const addons = Array.isArray(camstack.addons)
        ? (camstack.addons as Record<string, unknown>[])
        : []
      if (addons.length === 0) return

      let installSource: 'npm' | 'local' | 'upload' | undefined
      try {
        const markerPath = path.join(pkgDir, '.install-source')
        if (fs.existsSync(markerPath)) {
          const raw = fs.readFileSync(markerPath, 'utf-8').trim()
          const normalized = raw === 'workspace' ? 'local' : raw
          if (normalized === 'npm' || normalized === 'local' || normalized === 'upload') {
            installSource = normalized
          }
        }
      } catch {
        /* non-critical */
      }

      // Manifest-driven protection — agree with the live-rows path.
      const isProtected = addons.some((a) => a['protected'] === true)
      const packageDisplayName = (camstack as { displayName?: string }).displayName
      // Bundle metadata — present when the package ships multiple addon
      // entries that should render as collapsible children in the UI.
      const bundleRaw = (
        camstack as { bundle?: { displayName?: string; description?: string; icon?: string } }
      ).bundle
      const bundle =
        bundleRaw && typeof bundleRaw.displayName === 'string'
          ? {
              displayName: bundleRaw.displayName,
              ...(bundleRaw.description !== undefined
                ? { description: bundleRaw.description }
                : {}),
              ...(bundleRaw.icon !== undefined ? { icon: bundleRaw.icon } : {}),
            }
          : undefined

      for (const rawDecl of addons) {
        if (!isAddonDeclaration(rawDecl)) continue
        const decl = rawDecl
        const id = decl.id
        const name = typeof decl.name === 'string' ? decl.name : id
        const manifest: Row['manifest'] = {
          ...decl,
          id,
          name,
          packageName,
          packageVersion,
          ...(packageDisplayName ? { packageDisplayName } : {}),
          ...(bundle !== undefined ? { bundle } : {}),
          protected: isProtected || undefined,
          removable: !isProtected,
        }
        out.push({
          manifest,
          declaration: decl,
          source: 'installed' as AddonSource,
          ...(installSource ? { installSource } : {}),
          process: NEVER_LOADED_PROCESS,
        })
      }
    }

    const entries = fs.readdirSync(addonsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dirName = entry.name
      if (dirName === 'node_modules' || dirName.startsWith('.')) continue
      const fullPath = path.join(addonsDir, dirName)
      // Scoped: walk one level deeper.
      if (dirName.startsWith('@')) {
        const scopedEntries = fs.readdirSync(fullPath, { withFileTypes: true })
        for (const sub of scopedEntries) {
          if (sub.isDirectory()) visit(path.join(fullPath, sub.name))
        }
      } else {
        visit(fullPath)
      }
    }
    return out
  }

  /**
   * List all addons including core builtins.
   * Each addon carries packageName/packageVersion from its package.json,
   * so the frontend can group by package automatically.
   */
  listAllAddons() {
    return this.listAddons()
  }

  /**
   * Phase 11 (settings redesign): `getAddonConfigSchema`,
   * `getAddonConfig`, and `updateAddonConfig` — the legacy adapter
   * shim that synthesised a plain `ConfigUISchema` view from the new
   * three-level methods — are gone. All settings traffic goes through
   * the six Phase 5 tRPC endpoints (`addons.getAddonSettings`,
   * `updateAddonSettings`, `getGlobalSettings`, `updateGlobalSettings`,
   * `getDeviceSettings`, `updateDeviceSettings`) which call the
   * addon's methods directly via the `addon-settings` singleton capability.
   */

  /**
   * Scan data/addons/ for new packages and initialize any addon not already registered.
   * Called after install/uninstall to hot-load new addons without server restart.
   */
  async loadNewAddons(): Promise<{ loaded: string[]; failed: string[] }> {
    const dataDir = path.resolve(process.env.CAMSTACK_DATA ?? 'camstack-data')
    const addonsDir = process.env.CAMSTACK_ADDONS_DIR ?? path.resolve(dataDir, 'addons')

    // Create a fresh loader to discover what's on disk (for diffing against existing)
    const freshLoader = new AddonLoader(this.loggingService.createLogger('AddonLoader'))
    await freshLoader.loadFromDirectory(addonsDir)

    const loaded: string[] = []
    const failed: string[] = []

    for (const registered of freshLoader.listAddons()) {
      // Already-registered addon: refresh the in-memory metadata (the
      // `packageVersion`/`packageDisplayName`/`declaration`/`bundle`
      // fields stored on the entry) from the fresh disk scan. Without
      // this step a hot-update via `installFromTgz` would leave
      // `entry.packageVersion` stale — the forked group-runner picks up
      // the new code on `restartAddon` but the UI + listAddons() keep
      // showing the OLD version. We deliberately keep `entry.addon`
      // (the running instance) and `entry.initialized` untouched so
      // `restartAddon` still shuts the live instance down cleanly.
      const existing = this.addonEntries.get(registered.declaration.id)
      // Another PACKAGE claiming a running addon's id (a package since folded
      // into the framework, still on disk) never relabels it: its declaration's
      // entry would then be resolved against the owner's dir. Same rule as
      // `AddonLoader.loadDeclaration` at boot.
      if (existing && existing.packageName !== registered.packageName) {
        this.logger.warn('loadNewAddons: skipped a package claiming a running addon id', {
          tags: { addonId: registered.declaration.id },
          meta: { skippedPackage: registered.packageName, ownerPackage: existing.packageName },
        })
        continue
      }
      if (existing) {
        existing.packageVersion = registered.packageVersion
        existing.packageName = registered.packageName
        existing.packageDisplayName = registered.packageDisplayName
        if (registered.bundle !== undefined) {
          existing.bundle = registered.bundle
        }
        existing.declaration = registered.declaration
        existing.declaredCapabilities = (registered.declaration.capabilities ?? []).map(
          (c: string | CapabilityDeclaration) =>
            typeof c === 'string' ? { name: c, mode: 'singleton' as const } : c,
        )
        continue
      }

      // Skip agent-only addons on the hub. Same rule as the boot loader
      // path above; without it, post-install reload would re-init
      // hub-side every agent-only provider (e.g. `hub-forwarder`),
      // and a hub-resident `hub-forwarder` creates a write→ingest→
      // write feedback loop because the hub IS the log-receiver.
      if (isAgentOnlyPlacement(registered.declaration)) {
        this.logger.debug('loadNewAddons: skipping agent-only addon on hub', {
          tags: { addonId: registered.declaration.id },
        })
        continue
      }

      if (registered.declaration.capabilities) {
        for (const cap of registered.declaration.capabilities) {
          this.capabilityRegistry.declareFromManifest(cap, registered.declaration.id)
        }
      }

      try {
        const addon = freshLoader.createInstance(registered.declaration.id)
        const declCaps = (registered.declaration.capabilities ?? []).map(
          (c: string | CapabilityDeclaration) =>
            typeof c === 'string' ? { name: c, mode: 'singleton' as const } : c,
        )

        this.addonEntries.set(registered.declaration.id, {
          addon,
          initialized: false,
          source: 'installed',
          packageName: registered.packageName,
          packageVersion: registered.packageVersion,
          packageDisplayName: registered.packageDisplayName,
          ...(registered.bundle !== undefined ? { bundle: registered.bundle } : {}),
          declaredCapabilities: declCaps,
          addonDir: path.join(addonsDir, registered.packageName),
          declaration: registered.declaration,
        })
        this.loadAddonCatalogs(registered.packageName, path.join(addonsDir, registered.packageName))

        // Initialize the new addon
        await this.initializeAddon(registered.declaration.id)
        this.wireCapabilities(registered.declaration.id)
        loaded.push(registered.declaration.id)
        this.logger.info('Hot-loaded addon', {
          tags: { addonId: registered.declaration.id },
          meta: { packageName: registered.packageName },
        })
        this.emitAddonLifecycleEvent('addon.installed', registered.declaration.id)
      } catch (err) {
        const msg = errMsg(err)
        const stack = err instanceof Error ? err.stack : undefined
        this.logger.error('Failed to hot-load addon', {
          tags: { addonId: registered.declaration.id },
          meta: stack ? { error: msg, stack } : { error: msg },
        })
        this.emitAddonLifecycleEvent('addon.crashed', registered.declaration.id, { error: msg })
        failed.push(registered.declaration.id)
      }
    }

    // Remove addons that are no longer on disk — the uninstall path.
    // D5: every non-core addon lives in its own runner subprocess. The
    // uninstall consolidation is "stop the runner"; the runner exits and
    // re-handshakes the hub WITHOUT the removed addon (D3 machinery).
    // `@camstack/system` builtins are excluded — see `shouldEvictMissingOnDisk`.
    const onDiskIds = new Set(
      freshLoader.listAddons().map((a: { declaration: { id: string } }) => a.declaration.id),
    )
    for (const [id, entry] of this.addonEntries) {
      if (shouldEvictMissingOnDisk(entry, id, onDiskIds)) {
        // Unregister capabilities before stopping the addon.
        for (const cap of entry.declaredCapabilities) {
          this.capabilityRegistry.unregisterProvider(cap.name, id)
        }
        const manifestCaps = this.getAddonCapabilities(entry.addon)
        for (const cap of manifestCaps) {
          this.capabilityRegistry.unregisterProvider(cap.name, id)
        }
        this.capabilityRegistry.unregisterAllWrappersForAddon(id)
        // Task 7.1: drop custom actions for removed addons.
        this.customActionRegistry.unregisterAddon(id)

        if (this.isForkedAddonEntry(entry) && entry.initialized) {
          // Forked addon — stop the runner subprocess. `$process.stop`
          // kills the child and force-evicts its Moleculer node, so the
          // hub's cap registry drops the gone provider with no per-
          // operation hub bookkeeping.
          try {
            await this.broker.call('$process.stop', { name: id })
          } catch (err) {
            this.logger.warn('Non-fatal: failed to stop runner for removed addon', {
              tags: { addonId: id },
              meta: { error: errMsg(err) },
            })
          }
        } else if (entry.initialized) {
          // Defensive fallback: a non-forked installed addon (every
          // non-`@camstack/system` addon forks, and builtins are excluded
          // above, so this is not normally reached). Shut it down in-process.
          try {
            await entry.addon.shutdown()
          } catch (err) {
            this.logger.debug('Non-fatal: shutdown error for removed addon', {
              tags: { addonId: id },
              meta: { error: errMsg(err) },
            })
          }
          await this.drainDisposerChain(id)
        }
        this.addonEntries.delete(id)
        // An addon that is gone from disk will never re-handshake, so nothing
        // else will ever refresh or drop its data-plane. Without this the
        // registry keeps proxying `/addon/<id>/*` at a dead port for the rest
        // of the process lifetime.
        this.dataPlaneRegistry?.unregisterAddon(id)
        this.logger.info('Removed addon (no longer on disk)', { tags: { addonId: id } })
      }
    }

    return { loaded, failed }
  }

  async shutdownAll(): Promise<void> {
    for (const [id, entry] of this.addonEntries) {
      if (entry.initialized) {
        const capabilities = this.getAddonCapabilities(entry.addon)
        for (const cap of capabilities) {
          this.capabilityRegistry.unregisterProvider(cap.name, id)
        }
        this.capabilityRegistry.unregisterAllWrappersForAddon(id)
        // Task 7.1: drop custom actions on full shutdown.
        this.customActionRegistry.unregisterAddon(id)
        await entry.addon.shutdown()
        await this.drainDisposerChain(id)
        entry.initialized = false
      }
    }
  }

  // --- Private helpers ---

  // registerConsumers() — DELETED. Consumer wiring now in wireCapabilityConsumers().

  /**
   * v2: wire capability consumer actions via EventBus.
   * Listens to 'capability:provider-registered' events from CapabilityRegistry
   * and dispatches setup actions (storage wiring, decoder↔broker, etc).
   *
   * Replaces the 11 registerConsumer callbacks from v1.
   */
  private wireCapabilityConsumers(): void {
    if (!this.capabilityRegistry) return

    // A forked runner's custom-action catalogs arrive in its register frame,
    // not as a capability event — a non-device runner's post-init register
    // carries the same caps as its pre-init one, so no `provider-registered`
    // event marks the moment the catalogs exist. See `applyChildCustomActions`.
    this.moleculer.onChildCustomActions((child) => this.applyChildCustomActions(child))

    this.eventBusService.subscribe({ category: 'capability:provider-registered' }, (event) => {
      const rawCapability = event.data['capability']
      const rawAddonId = event.data['addonId']
      if (typeof rawCapability !== 'string' || typeof rawAddonId !== 'string') return
      const capability = rawCapability
      const addonId = rawAddonId

      // Broadcast readiness on the hub-node scope so subprocess
      // brokers waiting on this cap (e.g. provider-rtsp's
      // `system.ready-state` listener for stream-broker, or
      // `runWorkerDeviceRestoreWithRetry` waiting on
      // device-manager) wake up. We emit ONLY `{ type: 'node',
      // nodeId: 'hub' }` — most consumer filters are scope-agnostic
      // (they match on capName + state), so emitting both `node` and
      // `global` causes duplicate fan-out (e.g. provider-rtsp's
      // `republishAll` running twice → repeated `dispatchCamera`
      // loops). The node-scoped emit is sufficient: the hydrate
      // path on subprocess brokers replays whichever records the
      // hub's `$readiness.getSnapshot` returns, scope and all.
      // Caps that OWN their readiness (platform-probe: registration
      // happens while its async probe still runs) are excluded —
      // this emit would flip them `ready` prematurely.
      if (shouldEmitProviderRegisteredReady(capability)) {
        try {
          this.moleculer.readinessRegistry.emitReady(capability, { type: 'node', nodeId: 'hub' })
        } catch (err) {
          this.logger.warn('emitReady failed', {
            meta: { capability, addonId, error: errMsg(err) },
          })
        }
      }

      switch (capability) {
        case 'storage': {
          // Storage-unification refactor (Task 8) — the consumer-
          // facing `storage` cap is now a singleton owned by the
          // `storage-orchestrator` builtin, exposing the codegen'd
          // async `IStorageCapProvider` surface. The legacy
          // synchronous `INewStorageProvider` (filesystem-only) used
          // by `StorageService.setNewStorageProvider` and the
          // `addons-data` dataDir resolution at boot is no longer
          // wired here — filesystem-storage now registers under
          // `storage-provider` (the upstream collection cap), and
          // legacy callers fall back to the deterministic
          // `camstack-data/addons-data/<addonId>` path. Task 17 will
          // migrate those callers off `INewStorageProvider`
          // entirely.
          break
        }

        case 'settings-store': {
          const provider = this.capabilityRegistry.getProviderByAddon('settings-store', addonId)
          if (!provider) return
          this.activeSettingsBackend = provider
          // ConfigManager needs the SYNC legacy surface (`getAllAddon`,
          // `setAddonDevice`, …), which is not part of the cap. Since D44 the
          // `settings-store` provider is the storage-orchestrator's
          // DISPATCHER, and a dispatcher has none of those methods — so this
          // predicate started returning false and ConfigManager was left
          // without a store. Nothing said so: `readAddonStore()` then answered
          // `{}` for every addon, device-manager restored ZERO devices, and no
          // camera published a stream. Fall back to the ENGINE behind the door
          // (`data-store-provider` — the SQLite backend does implement both
          // surfaces), the same move `storage-orchestrator` makes for its
          // location store. And if neither can serve it, SAY SO: this is the
          // branch whose silence cost an evening.
          const syncStore = isSettingsStore(provider)
            ? provider
            : this.capabilityRegistry
                .getCollection<ISettingsBackend>('data-store-provider')
                .find((engine) => isSettingsStore(engine))
          if (syncStore) {
            this.configService.setSettingsStore(syncStore)
          } else {
            // Isolated engine: the UDS proxy is not `ISettingsStore`. The
            // async door below is what `createSettingsView` uses instead.
            this.logger.info(
              'settings-store engine is isolated — ConfigManager uses the async door, not a sync ISettingsStore',
              { meta: { addonId, phase: 'v2' } },
            )
          }
          this.storageService.setSettingsBackend(provider)
          // The registry needs the DOOR's own shape, not `ISettingsBackend`.
          // `CapabilityProviderMap` still types this cap as the hand-written
          // interface, which has drifted from the cap definition it is meant
          // to describe — it never grew `deleteWhere` / `updateWhere`. The
          // same provider object satisfies both; reconciling the two types is
          // its own change (it makes `query` / `insert` non-generic for every
          // `ISettingsBackend` consumer in the backend).
          const store = this.capabilityRegistry.getProviderByAddon<ISettingsStoreProvider>(
            'settings-store',
            addonId,
          )
          if (!store) return
          void wireSettingsDoor(
            {
              configService: this.configService,
              registry: this.capabilityRegistry,
              logger: this.logger,
            },
            store,
          )
          void this.wireHubMainOrphanRecords(store).catch((err: unknown) => {
            this.logger.warn('hub-main records wiring failed (best-effort)', {
              meta: { error: errMsg(err) },
            })
            this.integrationRegistry = new IntegrationRegistry(store)
            void this.integrationRegistry.initialize().then(() => {
              this.logger.info('IntegrationRegistry initialized (legacy)', {
                meta: { phase: 'v2' },
              })
            })
          })
          this.loadCollectionPreferences()
          // DeviceStore/ConfigStore are owned by the `device-persistence`
          // capability addon — no longer created here. The addon boots
          // after `sqlite-settings` and extracts the DB handle via the
          // capability registry.
          this.logger.info('Settings backend wired', { meta: { phase: 'v2' } })
          break
        }

        case 'log-destination': {
          const provider = this.capabilityRegistry.getProviderByAddon('log-destination', addonId)
          if (!provider) return
          // Tagged with the providing addon so the fan-out can honour the
          // operator's Enable/Disable toggle for THIS destination.
          this.loggingService.addDestination(provider, { addonId })
          this.logger.info('Log destination added', { meta: { phase: 'v2' } })
          break
        }

        case 'restreamer':
        case 'webrtc':
        case 'decoder':
        case 'stream-broker':
          // No wiring needed — consumers read from capabilityRegistry on demand.
          break

        case 'addon-routes': {
          // Route mounting is async for forked/group addons — the
          // provider is a Moleculer proxy whose `getRoutes()` returns
          // a Promise (the wire round-trips through the worker). The
          // EventBus subscriber callback is synchronous, so delegate
          // to an async helper and surface any failure via the
          // logger instead of letting a rejected promise (or a
          // `liveRoutes.some is not a function` TypeError) escape the
          // subscriber unobserved.
          void this.mountAddonRoutes(addonId).catch((err: unknown) => {
            this.logger.error('Failed to mount addon routes', {
              meta: { phase: 'v2', addonId, error: errMsg(err) },
            })
          })
          break
        }

        default:
          break
      }

      // HTTP data-planes aren't capabilities, so no `case` fires for them —
      // pull them off ANY cap-changed signal for this (forked) addon. Cheap +
      // idempotent (replace-all), and re-pulls the fresh baseUrl/secret after a
      // restart (the child re-handshakes → caps re-register → this re-fires).
      void this.mountAddonDataPlanes(addonId).catch((err: unknown) => {
        this.logger.error('Failed to mount addon data-planes', {
          meta: { phase: 'v2', addonId, error: errMsg(err) },
        })
      })
    })
  }

  /**
   * Mount the `addon-routes` provider for `addonId` into the
   * `AddonRouteRegistry`. Handles both co-located (in-process) and
   * forked addons:
   *
   * - For a hub-local FORKED addon the route handlers live in the
   *   child process and cannot cross the UDS wire (MsgPack can't encode
   *   a function). We fetch the handler-stripped route descriptors over
   *   UDS via `LocalChildRegistry.callAddonOnChild(addonId,
   *   {target:'routes'})` (F3 — replaces the removed per-addon Moleculer
   *   `getRoutes` action), synthesize bridge handlers that dispatch
   *   through the `addon-routes` cap's `invoke(...)` method (a normal
   *   serializable cap call over UDS), and translate the captured
   *   envelope back onto the Fastify reply.
   * - For a co-located (hub-resident) addon `getRoutes()` resolves to the
   *   live route list with real handlers, so we register the provider
   *   directly.
   */
  private async mountAddonRoutes(addonId: string): Promise<void> {
    if (!this.capabilityRegistry || !this.addonRouteRegistry) return
    const addonRouteRegistry = this.addonRouteRegistry
    const routeProvider = this.capabilityRegistry.getProviderByAddon('addon-routes', addonId)
    if (!routeProvider) return

    // ── Forked addon: fetch handler-stripped routes over UDS (F3) ──────
    // EVERY non-`@camstack/system` addon forks (the fork authority is
    // `buildAddonGroupPlan`, which does NOT require an `execution` block — an
    // addon like `auth-oidc` with no `execution` still runs in its own
    // runner). `isForkedAddonEntry` now mirrors that rule. For a forked addon
    // the `getProviderByAddon('addon-routes', …)` result is the async UDS cap
    // proxy whose `getRoutes()` returns a Promise — registering it directly
    // would crash `AddonRouteRegistry.registerRoutes` (`getRoutes(...).map is
    // not a function`), and dispatching the proxy's `getRoutes` cap method
    // over UDS would try to MsgPack-serialize the child's live handler
    // functions (→ "Unrecognized object: [object AsyncFunction]"). Instead we
    // fetch handler-STRIPPED descriptors via `callAddonOnChild(target:
    // 'routes')` and bridge each through the `invoke` cap method. The UDS
    // childId for a hub-local single-addon runner equals the addonId
    // (`resolveRunnerId` — no shipped addon declares a group). Gate on
    // `isChildKnown` (the child completed its UDS handshake) rather than
    // `childProvides('addon-routes')`: the `addon-call` route fetch works as
    // long as the child is connected, and the child is added to the UDS
    // registry BEFORE its manifest fires the cap-changed event that triggers
    // this mount, so the gate is satisfied on the happy path.
    const entry = this.addonEntries.get(addonId)
    const childRegistry = this.moleculer.childRegistry
    if (entry && this.isForkedAddonEntry(entry)) {
      if (childRegistry !== null && childRegistry.isChildKnown(this.childIdForAddon(addonId))) {
        await this.mountForkedAddonRoutes(addonId, routeProvider, addonRouteRegistry)
        return
      }
      // Child not yet connected over UDS: defer rather than register the async
      // proxy directly (which would crash on `.map`). The `addon-routes`
      // cap-changed event re-fires once the child finishes its handshake.
      this.logger.warn('Deferring forked addon route mount — child not yet UDS-reachable', {
        meta: { phase: 'v2', addonId },
      })
      return
    }

    // ── Co-located addon (`@camstack/system` builtin): live handlers, register
    // the provider directly. The route handlers run in-process against the
    // real Fastify reply, so no wire bridge is needed.
    addonRouteRegistry.registerRoutes(routeProvider.id, routeProvider)
    this.logger.info('Addon routes mounted', {
      meta: { phase: 'v2', routeProviderId: routeProvider.id },
    })
  }

  /**
   * Mount a hub-local FORKED addon's HTTP routes (F3). The route handlers live
   * in the child process; only handler-stripped descriptors cross the UDS wire.
   * We:
   *   1. fetch the descriptors via `callAddonOnChild(addonId, {target:'routes'})`,
   *   2. synthesize a bridge handler per route that dispatches the captured
   *      request through the `addon-routes` cap's `invoke(...)` method (a normal
   *      serializable UDS cap call on `routeProvider`), and
   *   3. translate the returned reply envelope back onto the Fastify reply.
   *
   * `addonRouteRegistry` is narrowed non-null by the caller's guard in
   * `mountAddonRoutes` — no assertion needed here.
   */
  private async mountForkedAddonRoutes(
    addonId: string,
    routeProvider: import('@camstack/types').IAddonRouteProvider,
    addonRouteRegistry: AddonRouteRegistry,
  ): Promise<void> {
    // The cap-registry typed surface for `addon-routes` is the operator-facing
    // `IAddonRouteProvider` (id + getRoutes). The bridge dispatch contract
    // `invoke(...)` is present on the UDS proxy but not on that interface —
    // narrow it via a structural type guard (no cast).
    if (!isAddonRoutesInvoker(routeProvider)) {
      this.logger.warn(
        'Forked addon-routes provider missing `invoke` method — routes will not dispatch. Use `buildAddonRouteProvider()` from @camstack/types.',
        { meta: { phase: 'v2', routeProviderId: routeProvider.id } },
      )
      return
    }
    const invoker = routeProvider

    const rawRoutes = await this.addonCallGateway.callForked(addonId, {
      target: 'routes',
    })
    const descriptors = parseSerializableRouteDescriptors(rawRoutes)
    const bridgeRoutes: import('@camstack/types').IAddonHttpRoute[] = descriptors.map((route) => ({
      method: route.method,
      path: route.path,
      access: route.access,
      ...(route.description !== undefined ? { description: route.description } : {}),
      ...(route.rateLimit !== undefined ? { rateLimit: route.rateLimit } : {}),
      handler: async (req, reply) => {
        const envelope = await invoker.invoke({
          method: route.method,
          // The CONCRETE path, not the pattern: the child re-matches it and
          // would otherwise bind every param to its own `:placeholder`.
          path: materializeRoutePath(route.path, req.params),
          params: req.params,
          query: req.query,
          body: req.body,
          headers: req.headers,
          ...(req.user ? { user: req.user } : {}),
          ...(req.scopedToken !== undefined ? { scopedToken: req.scopedToken } : {}),
        })
        reply.code(envelope.status)
        if (envelope.contentType) reply.type(envelope.contentType)
        for (const [k, v] of Object.entries(envelope.headers)) reply.header(k, v)
        if (envelope.redirectUrl !== null) {
          reply.header('Location', envelope.redirectUrl)
          reply.send('')
        } else {
          reply.send(envelope.body)
        }
      },
    }))
    addonRouteRegistry.registerRoutes(routeProvider.id, {
      id: routeProvider.id,
      getRoutes: () => bridgeRoutes,
    })
    this.logger.info('Addon routes mounted (forked-bridge over UDS)', {
      meta: { phase: 'v2', routeProviderId: routeProvider.id, routes: bridgeRoutes.length },
    })
  }

  // Cleanup: `addonHasConfigFields` deleted. It was the last reader of
  // the legacy `ICamstackAddon.getConfigSchema()` method, exposed via
  // `listAddons().hasConfigSchema` for the old AddonCard settings gate.
  // `NodeAddonsSettingsPanel` now gracefully shows an empty state when
  // an addon doesn't implement `getGlobalSettings`, so the backend no
  // longer needs to pre-compute this flag.

  private emitAddonLifecycleEvent(
    eventType:
      | 'addon.started'
      | 'addon.stopped'
      | 'addon.restarted'
      | 'addon.updated'
      | 'addon.installed'
      | 'addon.uninstalled'
      | 'addon.crashed'
      | 'addon.error',
    addonId: string,
    data?: Record<string, unknown>,
  ): void {
    const entry = this.addonEntries.get(addonId)
    this.eventBusService.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: {
        type: 'addon',
        id: addonId,
        nodeId: this.broker.nodeID,
      },
      category: eventType,
      data: {
        addonId,
        packageName: entry?.packageName,
        packageVersion: entry?.packageVersion,
        agent: process.env.CAMSTACK_AGENT_NAME ?? 'hub',
        ...data,
      },
    })
  }

  /**
   * Post-init hook: emit events for newly available capabilities.
   * Provider registration now happens in initialize() via context.registerProvider().
   */
  private wireCapabilities(addonId: string): void {
    const entry = this.addonEntries.get(addonId)
    if (!entry?.initialized) return

    // Emit addon-pages event for UI notification. Cap name is
    // `addon-pages-source` after the consolidation split — collection
    // providers register on the source cap; the singleton aggregator
    // owns `addon-pages` cluster-wide.
    const declaredCaps = entry.declaredCapabilities.map((c) => c.name)
    if (declaredCaps.includes('addon-pages-source')) {
      this.eventBusService.emit({
        id: randomUUID(),
        timestamp: new Date(),
        source: { type: 'addon', id: addonId },
        category: EventCategory.AddonPageReady,
        data: { addonId, packageName: entry.packageName },
      })
    }
    // Symmetric for `addon-widgets-source` — addons that contribute
    // widget bundles emit `AddonWidgetReady` so the
    // <WidgetRegistryProvider> in admin-ui invalidates its aggregator
    // query and the new bundle becomes available without a page
    // reload.
    if (declaredCaps.includes('addon-widgets-source')) {
      this.eventBusService.emit({
        id: randomUUID(),
        timestamp: new Date(),
        source: { type: 'addon', id: addonId },
        category: EventCategory.AddonWidgetReady,
        data: { addonId, packageName: entry.packageName },
      })
    }
  }

  private getAddonCapabilities(addon: ICamstackAddon): CapabilityDeclaration[] {
    const caps = addon?.manifest?.capabilities
    if (!caps) return []

    return caps.map((cap): CapabilityDeclaration => (typeof cap === 'string' ? { name: cap } : cap))
  }

  private findAddonForCapability(capName: string, addonIds: string[]): string | null {
    for (const id of addonIds) {
      const entry = this.addonEntries.get(id)
      if (!entry) continue
      // Use declaredCapabilities (from package.json) as source of truth
      if (entry.declaredCapabilities.some((c) => c.name === capName)) return id
    }
    return null
  }

  private async createAddonContext(addon: ICamstackAddon): Promise<InternalAddonContext> {
    const addonId = addon.manifest!.id
    const brokerNodeId = this.broker.nodeID
    const agentId = brokerNodeId.includes('/') ? brokerNodeId.split('/')[0]! : brokerNodeId
    // No scope on the addon root logger — the brand bracket already shows
    // `[agent/addonId]`, so `(addon:<addonId>)` was pure duplication.
    // Sub-components add their own scope via `.child('<name>')`.
    const logger = this.loggingService
      .createLogger()
      .withTags({ addonId, nodeId: brokerNodeId, agentId })

    // Per-addon private data directory — resolved from active storage
    // provider if available, otherwise falls back to a deterministic
    // hardcoded path. Addons that need the full storage provider now
    // resolve it via the capability registry.
    const storageProvider = this.activeStorageProvider
    const dataDir = storageProvider
      ? await storageProvider.resolve({
          location: 'addons-data',
          relativePath: addonId,
        })
      : // No active storage provider yet — this is an EARLY in-process builtin
        // (notably sqlite-settings, which IS the storage provider, so it loads
        // before one is active). Honor CAMSTACK_DATA here too; hardcoding the
        // relative `camstack-data` made the settings DB escape the mounted
        // data dir in container deployments.
        path.join(process.env.CAMSTACK_DATA ?? 'camstack-data', 'addons-data', addonId)

    // Node-local data ROOT — the centralized anchor for internal per-node dirs
    // (models, logs). `CAMSTACK_DATA` ?? the hub's default data dir. Mirrors the
    // kernel addon-context-factory; never the hub-singleton `storage` cap.
    const nodeDataDir = path.resolve(process.env.CAMSTACK_DATA ?? 'camstack-data')

    const registerProvider = (capabilityName: string, provider: unknown): void => {
      this.capabilityRegistry.registerProvider(capabilityName, addonId, provider)
      logger.info('Registered provider via context.registerProvider()', {
        meta: { capabilityName },
      })
    }

    // Raw three-level settings store API. The resolver service is a
    // thin wrapper over `ConfigManager` that exposes raw reads/writes
    // for the addon store, the per-device store, and the cluster-wide
    // yml-backed sections. No schema merging happens here — the addon
    // combines these raw reads with its own schema via
    // `hydrateSchema()` inside `getAddonSettings / getGlobalSettings
    // / getDeviceSettings`.
    const settingsView: AddonSettingsView = this.configService.createSettingsView(addonId)

    // Device management — unified path for hub and worker addons.
    // Persistence routes through the `device-manager` capability
    // addon via `ctx.api.deviceManager.*`. On the hub, `ctx.api` is
    // a broker-routed proxy that resolves the local
    // `device-manager` Moleculer service in-process — no network
    // hop. On a forked worker, the same proxy routes through the TCP
    // transport to the hub's service. Zero custom $hub.* actions needed.
    const kernelStreamProbe: import('@camstack/types').IKernelStreamProbe = {
      probe: (url, options) => this.streamProbe.probe(url, options),
      probeField: (key, value) => this.streamProbe.probeField(key, value),
    }
    const deviceManagerApi: import('@camstack/types').DeviceManagerApi =
      createBrokerDeviceManagerApi({
        api: this.getBrokerApi(),
        addonId,
        nodeId: this.broker.nodeID,
        logger,
        eventBus: this.eventBusService,
        registry: this.deviceRegistry,
        capabilityRegistry: this.capabilityRegistry,
        streamProbe: kernelStreamProbe,
      })

    // Captured for use inside the `ctx` object-literal getters/methods below
    // (e.g. `get api()`), where `this` rebinds to the literal — an arrow can't
    // be used for an accessor, so an explicit alias is required.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const registry = this
    const rr = this.moleculer.readinessRegistry
    const capHandleCache = new Map<string, CapabilityHandle<unknown>>()
    function getOrCreateHandle<T>(
      capName: string,
      scope: ReadinessScope,
      timeoutMs: number,
    ): CapabilityHandle<T> {
      const key = `${capName}::${scopeKey(scope)}`
      const existing = capHandleCache.get(key)
      if (existing) return existing as CapabilityHandle<T>
      const handle = new CapabilityHandle<T>(capName, scope, rr, timeoutMs)
      capHandleCache.set(key, handle as CapabilityHandle<unknown>)
      return handle
    }

    // In-process HTTP data-plane for co-located hub builtins (e.g. the snapshot
    // wrapper's per-device image endpoint). The facility binds a `127.0.0.1`
    // listener in the hub process on first `serve()`; the sink publishes its
    // endpoints straight into the hub's `DataPlaneRegistry` (bare `addonId`, the
    // same key the `/addon/:addonId/*` reverse-proxy matches), so a builtin
    // serves media exactly like a forked addon — no per-builtin proxy plumbing.
    // `mountAddonDataPlanes` handles only FORKED addons; this covers the
    // co-located path it defers. Disposed via the addon's disposer chain.
    const dataPlaneSink: DataPlaneSink = {
      set: (id, endpoints) => {
        registry.dataPlaneRegistry?.registerAddon(id, endpoints)
      },
    }
    const dataPlaneFacility = createAddonDataPlaneFacility({
      addonId,
      logger,
      sink: dataPlaneSink,
    })
    this.getOrCreateDisposerChain(addonId).add(() => dataPlaneFacility.dispose())

    // Addon→addon byte transport (`ctx.peerBytes`, D613) for a co-located hub
    // builtin, on the same terms a forked addon gets it. `broker.nodeID` IS the
    // host node here — hub-main has no runner suffix.
    const peerBytesFacility = createAddonPeerBytesFacility({
      addonId,
      logger,
      nodeId: this.broker.nodeID,
    })
    this.getOrCreateDisposerChain(addonId).add(() => peerBytesFacility.dispose())

    // This builtin's keychain values (D787). In-process, so the caller is
    // STATED (no wire, no stamp) - the one place the keychain trusts a claim.
    // `forOwner` is the door a system builtin (device-manager,
    // storage-orchestrator) uses to keep another addon's values.
    const secrets = createSecretsAccess({
      owner: addonId,
      transport: this.inProcessKeychainTransport(addonId),
      transportForOwner: (owner) => this.inProcessKeychainTransport(owner),
      eventBus: this.eventBusService,
    })

    const ctx: InternalAddonContext & {
      integrationRegistry?: unknown
      capabilities: import('@camstack/types').CapabilitiesAccess
    } = {
      id: `addon:${addonId}`,
      logger,
      eventBus: this.eventBusService,
      // No store data (D675). An in-process addon reads its persisted settings
      // through `ctx.settings`; `addonConfig` used to be filled from the sync
      // `getAddonConfig`, which has no backend on an isolated engine and handed
      // every addon `{}`. Nothing in production reads it — the same empty
      // record a forked runner's context carries (`addon-context-factory`).
      addonConfig: {},
      dataDir,
      nodeDataDir,
      dataPlane: dataPlaneFacility.dataPlane,
      peerBytes: peerBytesFacility.peerBytes,
      get api() {
        return registry.getAddonApi(addonId)
      },
      integrationRegistry: this.integrationRegistry ?? undefined,
      // Live capability-collection accessor used by addons like stream-broker
      // (webrtc fan-out), enrichment-engine, and snapshot orchestrator. Reads
      // through the hub's CapabilityRegistry so the collection reflects
      // every addon that has declared itself since the consumer initialized.
      // Without this, those addons silently saw 0 providers and quietly
      // skipped the fan-out — no errors, just missing streams/wiring.
      capabilities: {
        getCollection: <T = unknown>(capName: string): readonly T[] | undefined => {
          const items = registry.capabilityRegistry.getCollection<T>(capName)
          return items ?? undefined
        },
        getCollectionEntries: <T = unknown>(
          capName: string,
        ): readonly (readonly [string, T])[] | undefined => {
          const items = registry.capabilityRegistry.getCollectionEntries<T>(capName)
          return items ?? undefined
        },
        get: <T = unknown>(capName: string): T | undefined => {
          return registry.capabilityRegistry.getSingleton<T>(capName) ?? undefined
        },
      },
      deps: new AddonDepsManager(dataDir, logger),
      kernel: {
        localNodeId: this.broker.nodeID,
        // The keychain accepts a grouped runner's stamp (its group id) for the
        // refs of the addons that runner hosts.
        runnerIdForAddon: (id: string) => this.childIdForAddon(id),
        storage: storageProvider ?? undefined,
        deviceRegistry: this.deviceRegistry ?? undefined,
        devices: deviceManagerApi,
        cluster: { broker: adaptBrokerToCluster(this.moleculer.broker) },
        streamProbe: kernelStreamProbe,
        hwaccel: createKernelHwAccel({ logger }),
        capabilityRegistry: this.capabilityRegistry,
        // Per-addon storage-location declarations across every installed
        // addon — surfaced from the kernel's AddonLoader so the
        // storage-orchestrator builtin can aggregate them and seed defaults.
        listStorageLocationDeclarations: () => this.addonLoader.listStorageLocationDeclarations(),
        readinessRegistry: this.moleculer.readinessRegistry,
        // D3: handshake-fed native-cap view of the whole cluster. Backed by
        // `HubNodeRegistry.listNativeCapEntries()` populated by every
        // `$hub.registerNode` re-handshake. Used by device-manager as the
        // reliable fallback when push events were lost mid-transport.
        listClusterNativeCaps: () => this.moleculer.listClusterNativeCaps(),
        // Per-device slice of the above — O(caps-for-device) via the registry's
        // deviceId index. The per-device `getBindings` resolver prefers this
        // over filtering the whole-cluster flat view.
        listClusterNativeCapsForDevice: (deviceId: number) =>
          this.moleculer.listClusterNativeCapsForDevice(deviceId),
        // Node-routed cap proxy — lets hub builtins (storage-orchestrator)
        // dispatch provider work to the node that OWNS the data.
        resolveNodeCapability: (capName: string, nodeId: string) =>
          this.moleculer.createCapabilityProxy(capName, nodeId),
      },
      registerProvider,
      resolveProvider: <T = unknown>(capName: string): T | null => {
        return (registry.capabilityRegistry.getSingleton<T>(capName) as T | null) ?? null
      },
      getNativeProvider: <TCap extends CapabilityDefinition>(
        cap: TCap,
        deviceId: number,
      ): InferProvider<TCap> => {
        // Hub-side addons live on the same process as the CapabilityRegistry;
        // native providers are always resolvable locally.
        const local = registry.capabilityRegistry.getNativeProvider<InferProvider<TCap>>(
          cap.name,
          deviceId,
        )
        if (!local) {
          throw new Error(`no native provider for capability '${cap.name}' on device '${deviceId}'`)
        }
        return local
      },
      fetchDevice: async (deviceId: number) => {
        const api = registry.getBrokerApi()
        const binding = await api.deviceManager.getBindings.query({ deviceId })
        return createDeviceProxy(api, binding)
      },
      settings: settingsView,
      secrets,
      // This builtin's record kinds (D881). In-process, so the caller is STATED
      // (no wire, no stamp): the same single place identity is trusted as for
      // the keychain. `ctx.records` is the owner's own door; a builtin that
      // acts for another owner (the entries service) builds one with `recordsForOwner`.
      records: this.recordsForOwner(addonId, secrets),
      useCapability<T = unknown>(capName: string, scope: ReadinessScope = { type: 'global' }) {
        return getOrCreateHandle<T>(capName, scope, 15_000)
      },
      async acquireCapability<T = unknown>(
        capName: string,
        scope: ReadinessScope = { type: 'global' },
        opts: { timeoutMs?: number } = {},
      ) {
        const timeoutMs = opts.timeoutMs ?? 15_000
        const handle = getOrCreateHandle<T>(capName, scope, timeoutMs)
        return handle
      },
      onCapabilityStateChange(
        capName: string,
        scope: ReadinessScope,
        handler: (state: 'ready' | 'down') => void,
      ) {
        return rr.onReadyState(capName, scope, (t) => {
          handler(t.state === 'ready' ? 'ready' : 'down')
        })
      },
      addDisposer(fn: () => void | Promise<void>) {
        return registry.getOrCreateDisposerChain(addonId).add(fn)
      },
    }

    return ctx
  }

  /**
   * The keychain transport of a hub in-process caller: the provider lives in
   * this process, so the call goes straight to it with the caller STATED.
   * Built per call so a keychain registered after this context still answers;
   * a missing provider throws, which `ctx.secrets` reads as `unavailable`.
   */
  private inProcessKeychainTransport(owner: string): KeychainTransport {
    const provider = (): IKeychainProvider => {
      const p = this.capabilityRegistry.getSingleton<IKeychainProvider>('keychain')
      if (p === null || p === undefined) throw new Error('keychain provider is not registered')
      return p
    }
    const callerAddonId = owner
    return {
      put: (input) => {
        const stated = { ref: input.ref, value: input.value, callerAddonId }
        return provider().put(stated)
      },
      resolve: (input) => {
        const stated = { refs: [...input.refs], callerAddonId }
        return provider().resolve(stated)
      },
      delete: (input) => {
        const stated = { refs: [...input.refs], callerAddonId }
        return provider().delete(stated)
      },
      getState: () => provider().getState({}),
      deleteDeviceScope: (input) => {
        const stated = { deviceId: input.deviceId, callerAddonId }
        return provider().deleteDeviceScope(stated)
      },
    }
  }

  /**
   * Per-addon disposer chain. Created lazily the first time an addon
   * calls `ctx.addDisposer(...)`. Drained by `restartAddon()` /
   * `unregisterAddon()` so cleanup callbacks run before the new addon
   * instance comes up.
   */
  private readonly disposerChains = new Map<string, DisposerChain>()

  private getOrCreateDisposerChain(addonId: string): DisposerChain {
    let chain = this.disposerChains.get(addonId)
    if (chain == null) {
      const log = this.loggingService.createLogger().withTags({ addonId })
      chain = new DisposerChain({
        onError: (err, index) => {
          log.error(`Disposer #${index} threw during teardown`, {
            meta: { error: errMsg(err) },
          })
        },
      })
      this.disposerChains.set(addonId, chain)
    }
    return chain
  }

  /**
   * Drain (and remove) the disposer chain for an addon. Called by the
   * addon shutdown / restart flow so resources registered via
   * `ctx.addDisposer(...)` clean up before the next instance boots.
   */
  private async drainDisposerChain(addonId: string): Promise<void> {
    const chain = this.disposerChains.get(addonId)
    if (chain == null) return
    this.disposerChains.delete(addonId)
    await chain.dispose()
  }

  // ── Group orchestration (Phase G3 — opt-in, not yet wired into boot) ──

  /**
   * Compute the runner plan for a set of addon ids (base-layer D2).
   *
   * The runner contract is one-addon-one-process by default (D2/D9):
   *   - every addon gets its OWN runner, keyed by the addon id via
   *     `resolveRunnerId` — no shipped addon declares `execution.group`
   *     today;
   *   - the group-collapse path (same `group` → shared runner keyed by
   *     group name) is an explicit opt-in mechanism; Phase 5 dissolved
   *     the last real co-location group (`pipeline`) once frames travel
   *     as shared-memory `FrameHandle`s and audio over tRPC — nothing
   *     passes a live JS reference across a process boundary any more.
   *
   * Addons with `placement: 'agent-only'` are dropped (they don't run on
   * the hub). `@camstack/system` builtins are dropped too — UNLESS the
   * manifest entry declares `execution.isolate: true`.
   *
   * The reason builtins stay in-process is that the infrastructure ones
   * (storage, settings, logging, device-manager) must live in the process
   * every runner depends on. It is NOT, as the comment here used to claim,
   * that a subprocess would be unreachable: `docs/architecture/transport.md`
   * is explicit that there is no per-addon Moleculer broker and that a child
   * reaches the hub AND ITS SIBLINGS over the UDS channel —
   * `LocalChildRegistry` implements exactly that. The old claim was wrong and
   * nearly stopped the snapshot split; `docs/decisions/adr-0113.md` records
   * what replaced it.
   *
   * Read-only. Used by the bootstrap to plan spawns up-front and by
   * diagnostics that want to render the current topology.
   */
  buildAddonGroupPlan(addonIds: readonly string[]): RunnerPlan {
    const plan = new Map<string, RunnerAddonPlacement[]>()
    for (const id of addonIds) {
      const entry = this.addonEntries.get(id)
      if (!entry?.declaration || !entry.addonDir) continue
      if (!this.runsInOwnRunner(entry)) continue
      const runnerId = resolveRunnerId(entry.declaration, id)
      const bucket = plan.get(runnerId) ?? []
      bucket.push({ addonId: id, addonDir: entry.addonDir })
      plan.set(runnerId, bucket)
    }
    return plan
  }

  /**
   * THE fork predicate: does this entry boot in its own runner subprocess?
   *
   * Every consumer of "forked vs in-process" asks THIS — the runner plan, the
   * in-process boot passes, route mounts, data-plane mounts, restart and
   * uninstall. They are required to agree, and when they did not
   * (`isForkedAddonEntry` demanding an `execution` block the plan did not)
   * `auth-oidc` was forked at boot yet classified in-process, and its routes
   * were registered against an async UDS proxy (`getRoutes(...).map is not a
   * function`).
   */
  private runsInOwnRunner(entry: AddonEntry): boolean {
    if (!entry.declaration || !entry.addonDir) return false
    if (resolveAddonPlacement(entry.declaration) === 'agent-only') return false
    if (entry.packageName !== '@camstack/system') return true
    return isIsolatedBuiltin(entry.declaration)
  }

  /**
   * Spawn ONE runner subprocess that hosts every addon in `addons` and
   * register their custom-actions catalogs against the shared
   * CustomActionRegistry. Cap providers register themselves via
   * `CapabilityBridge.onProviderConnected` — the bridge listens for any
   * new Moleculer node (the runner's nodeID is `${parent}/${runnerId}`)
   * and proxies its services into the local `CapabilityRegistry`.
   *
   * `runnerId` is the addon id (a solo runner — one addon per process,
   * D2/D9). It can structurally also be a co-location group name if an
   * addon ever declared `execution.group`, but no shipped manifest does.
   *
   * No-op when the runner is already running (idempotent for tests +
   * crash respawn paths). Errors propagate so the bootstrap can log the
   * failed runner and surface every hosted addon as `addon.error`.
   */
  async initializeAddonGroup(
    runnerId: string,
    addons: readonly RunnerAddonPlacement[],
  ): Promise<void> {
    if (addons.length === 0) {
      throw new Error(`initializeAddonGroup("${runnerId}") requires at least one addon`)
    }
    try {
      // Serialized on the SAME key as `ensureForkedRunner`. This is the boot
      // path, and a boot spawn racing the restart a deploy fires for itself is
      // exactly how two runners started in the same second on 2026-09-17 —
      // with no manual restart anywhere. Covering only the converge left the
      // same race with a smaller window, and it lost the very next deploy.
      await this.serializeRunner(runnerId, async () => {
        try {
          await this.broker.call('$process.spawnRunner', { runnerId, addons })
        } catch (err: unknown) {
          // Losing the race is not a failure, and this method's own docblock
          // already promised so: "No-op when the runner is already running".
          // Unserialized the loser almost never got here — it spawned a SECOND
          // runner instead, which is the defect. Serializing makes the loser
          // reliable, so the promise has to be kept rather than documented.
          if (!/already running/i.test(errMsg(err))) throw err
          this.logger.info('initializeAddonGroup: runner already running — nothing to spawn', {
            meta: { runnerId, addonIds: addons.map((a) => a.addonId) },
          })
        }
      })
    } catch (err: unknown) {
      throw new Error(
        `Failed to spawn runner "${runnerId}" (${addons.length} addons): ${errMsg(err)}`,
        { cause: err },
      )
    }

    // Provider registration for cap methods is handled by
    // `CapabilityBridge.onProviderConnected` once the runner's INFO heartbeat
    // lands, and the custom-action catalogs arrive the same way — in the
    // runner's post-init register frame, applied by `applyChildCustomActions`.
    // Nothing about the runner is read from its bundle here (D444).
    for (const { addonId } of addons) {
      // Mark the entry initialized so the in-process core-builtin boot
      // passes skip it (those passes only touch `@camstack/system`).
      const entry = this.addonEntries.get(addonId)
      if (entry) {
        entry.initialized = true
        this.emitAddonLifecycleEvent('addon.started', addonId)
      }
    }

    this.logger.info('Addon runner spawned', {
      meta: { runnerId, addonCount: addons.length, addonIds: addons.map((a) => a.addonId) },
    })
  }

  /**
   * The last answer of `$process.list`, keyed by runner id (D877); `null` before
   * the first one or when the process service could not answer. Read by the
   * synchronous `listAddons()`; refreshed by `refreshRunnerStates()`.
   */
  private runnerStates: ReadonlyMap<string, RunnerProcessRow> | null = null

  /** Every runner row the process service holds right now, or `null` when it cannot answer. */
  async listRunnerRows(): Promise<readonly RunnerProcessRow[] | null> {
    try {
      // Untyped Moleculer boundary: the process-service owns `ProcessInfo`.
      const procs = (await this.broker.call('$process.list')) as ReadonlyArray<{
        name: string
        pid: number
        addonIds: readonly string[]
        state: string
        refusal?: { reason: string }
      }>
      return procs.map((p) => ({
        name: p.name,
        pid: p.pid,
        addonIds: p.addonIds,
        state: p.state,
        ...(p.refusal !== undefined ? { refusal: { reason: p.refusal.reason } } : {}),
      }))
    } catch (err) {
      this.logger.warn('could not list the runner processes - addon process state is unknown', {
        meta: { error: errMsg(err) },
      })
      return null
    }
  }

  /** Re-read the process service so the next `listAddons()` reports real runner states. */
  async refreshRunnerStates(): Promise<void> {
    const rows = await this.listRunnerRows()
    this.runnerStates = rows === null ? null : new Map(rows.map((r) => [r.name, r]))
  }

  /** The runner ids this node PLANS to run: `resolveRunnerId` over every forked addon. */
  plannedRunnerIds(): readonly string[] {
    return [...this.buildAddonGroupPlan([...this.addonEntries.keys()]).keys()]
  }

  /**
   * Snapshot of the live runner subprocesses (`$process.list`), reduced to the
   * `{ runnerId, addonIds }` shape the convergence planner needs. Returns `[]`
   * on any broker error so the caller degrades to a fresh spawn rather than
   * throwing — a missing list can only mean "nothing is running".
   */
  private async listRunnerProcesses(): Promise<readonly RunnerProcessSnapshot[]> {
    try {
      // `$process.*` is an untyped Moleculer infra boundary (returns `unknown`);
      // the process-service owns the `ProcessInfo` shape. Narrow to the two
      // fields the planner reads.
      const procs = (await this.broker.call('$process.list')) as ReadonlyArray<{
        name: string
        addonIds: readonly string[]
      }>
      return procs.map((p) => ({ name: p.name, addonIds: p.addonIds }))
    } catch {
      return []
    }
  }

  /**
   * Group-aware, convergent forked-runner spawn — the SINGLE authority for
   * bringing an addon's runner up OUTSIDE the boot plan (hot-install, retry,
   * operator restart, deploy hot-reload). The boot plan
   * (`buildAddonGroupPlan` → `initializeAddonGroup`) already groups; this makes
   * every OTHER lifecycle path honour `execution.group` too, so co-location is
   * not silently lost the moment an addon is (re)spawned post-boot.
   *
   * Resolves the runner id via `resolveRunnerId` and the FULL co-located roster
   * via `buildAddonGroupPlan` (the same authority the boot plan uses), then
   * converges the live process topology onto that roster (see
   * `planRunnerConvergence`): stop stale/mismatched runners, then spawn or
   * restart the group runner. Idempotent — safe to call once per roster member
   * (the 2nd..Nth calls see the correct topology and no-op). A groupless addon
   * keys to a size-1 roster whose runner id is its own id, so its behaviour is
   * byte-identical to the pre-group solo path.
   *
   * `opts.restart` respawns the group in place even when the roster already
   * matches — the deploy hot-reload path, so the child reboots the WHOLE roster
   * from the freshly-swapped on-disk bundle. This is why updating ONE member of
   * a group respawns the ENTIRE group (they share a process): the operator's
   * "update one → respawn the whole group" invariant.
   */
  /**
   * One converge at a time per runner. See `runner-serialization.ts` for the
   * two live episodes this closes and why the lock inside `process-service`
   * could not.
   */
  private readonly serializeRunner: RunnerSerializer = createRunnerSerializer()

  private async ensureForkedRunner(addonId: string, opts: { restart: boolean }): Promise<void> {
    const entry = this.addonEntries.get(addonId)
    if (!entry?.declaration || !entry.addonDir) {
      throw new Error(`ensureForkedRunner("${addonId}") requires an on-disk forked addon`)
    }
    const runnerId = resolveRunnerId(entry.declaration, addonId)
    const roster = this.buildAddonGroupPlan([...this.addonEntries.keys()]).get(runnerId) ?? [
      { addonId, addonDir: entry.addonDir },
    ]

    // Coalesce redundant group respawns: a package reload loops `restartAddon`
    // over every member of a co-location group, but the FIRST member's restart
    // already respawned the whole runner (every member rebooted from fresh disk
    // code). For a GROUP (roster > 1) whose runner was respawned inside the
    // coalesce window, downgrade a restart request to a plain topology check so
    // the 2nd..Nth members don't churn the runner. Solo addons (roster == 1) are
    // never coalesced — their behaviour stays byte-identical.
    const effectiveRestart =
      opts.restart &&
      roster.length > 1 &&
      Date.now() - (this.recentGroupRespawns.get(runnerId) ?? 0) < GROUP_RESPAWN_COALESCE_MS
        ? false
        : opts.restart

    // EVERYTHING from here is one atomic unit per runner. The read decides what
    // to stop and what to spawn, so a second converge that reads before this
    // one has spawned decides to spawn too — and the child nobody tracks keeps
    // running. `process-service`'s own lock cannot see this: it makes each
    // action atomic, and the unit that matters is the sequence.
    return this.serializeRunner(runnerId, async () => {
      const running = await this.listRunnerProcesses()
      const plan = planRunnerConvergence(
        runnerId,
        roster.map((r) => r.addonId),
        running,
        { restart: effectiveRestart },
      )

      // 1. Tear down every stale/mismatched runner that hosts a roster member.
      for (const name of plan.stop) {
        await this.broker.call('$process.stop', { name }).catch((err: unknown) => {
          this.logger.warn('ensureForkedRunner: failed to stop stale runner (continuing)', {
            meta: { runnerId, stale: name, error: errMsg(err) },
          })
        })
      }

      // 2. Bring the target runner to the correct roster.
      if (plan.action === 'spawn') {
        await this.broker
          .call('$process.spawnRunner', { runnerId, addons: roster })
          .catch((err) => {
            // A concurrent path may have won the spawn race — treat "already
            // running" as success (idempotent), rethrow anything else.
            if (!/already running/i.test(errMsg(err))) throw err
          })
        this.recentGroupRespawns.set(runnerId, Date.now())
      } else if (plan.action === 'restart') {
        const res = (await this.broker.call('$process.restart', { name: runnerId })) as {
          success: boolean
          reason?: string
        }
        if (!res.success) {
          throw new Error(`Process restart failed: ${res.reason ?? 'unknown'}`)
        }
        this.recentGroupRespawns.set(runnerId, Date.now())
      }

      // 3. Bookkeeping for EVERY roster member. Mark each member initialized so
      //    the in-process core-builtin boot passes skip them. The custom-action
      //    catalogs are NOT touched here: the respawned runner describes them in
      //    its post-init register frame and `applyChildCustomActions` replaces
      //    whatever the previous incarnation registered (D444).
      for (const { addonId: memberId } of roster) {
        const memberEntry = this.addonEntries.get(memberId)
        if (memberEntry) memberEntry.initialized = true
      }
    })
  }

  /**
   * Apply the custom-action catalogs a UDS child DESCRIBED in its register
   * frame (`RegisteredChild.customActions`, schemas stripped) to the hub-wide
   * `CustomActionRegistry`, dispatching each action back to that child over
   * the addon-call plane.
   *
   * ## Why the child describes, and the hub never reads the bundle
   *
   * Until D444 this was `registerForkedAddonCustomActions`: purge the require
   * cache, re-import the addon's entry INSIDE hub-main, read its
   * `customActions` export. Measured 2026-09-10 on the live hub: 9.3 MB of
   * `addon-pipeline-orchestrator/dist/index.js` evaluated in hub-main by a
   * sampling heap profile, ten deploys in the process's 23 h life, NONE of
   * which exported a catalog — and the only line saying so was at `debug`,
   * which the hub does not write. Every evaluation pins whatever module-scope
   * state the evicted graph left behind, and the bundle-reload guard existed
   * only to keep that re-execution survivable (D284). The runner is the
   * process that owns the addon; it describes its catalog once its init loop
   * has produced it, in the post-init register frame, and validates the
   * action's input and output itself (`child-addon-call-dispatch.ts`).
   *
   * ## What one description does
   *
   *  - identical to the child's last description → nothing, silently (a
   *    native-cap change or reconnect re-sends the same frame);
   *  - otherwise every addon in it is (re-)registered — an EMPTY catalog
   *    withdraws that addon's actions — and an addon the previous description
   *    named but this one does not is withdrawn too;
   *  - and ONE `info` line per applied description names what it produced,
   *    including "nothing": a load that produces nothing and says nothing is
   *    the branch D391 forbids.
   */
  private applyChildCustomActions(child: RegisteredChild): void {
    const catalogs = child.customActions
    if (catalogs === undefined) return
    const fingerprint = childCatalogsFingerprint(catalogs)
    if (this.childCatalogFingerprints.get(child.childId) === fingerprint) return
    this.childCatalogFingerprints.set(child.childId, fingerprint)

    const described = new Set(Object.keys(catalogs))
    for (const previous of this.childCatalogAddons.get(child.childId) ?? []) {
      if (!described.has(previous)) this.customActionRegistry.unregisterAddon(previous)
    }
    this.childCatalogAddons.set(child.childId, described)

    for (const [addonId, descriptor] of Object.entries(catalogs)) {
      if (Object.keys(descriptor).length === 0) {
        this.customActionRegistry.unregisterAddon(addonId)
        continue
      }
      this.customActionRegistry.registerAddon(
        addonId,
        toForkedCustomActionsSpec(descriptor),
        (action, input, caller) => this.dispatchForkedCustomAction(addonId, action, input, caller),
      )
    }

    const summary = summarizeChildCatalogs(catalogs)
    this.logger.info('UDS child custom-action catalogs applied', {
      meta: {
        childId: child.childId,
        incarnation: child.incarnation,
        registered: summary.withActions.length > 0 ? summary.withActions.join(',') : '(none)',
        withoutActions:
          summary.withoutActions.length > 0 ? summary.withoutActions.join(',') : '(none)',
      },
    })
  }

  /**
   * Dispatch a forked addon's custom action through the shared
   * {@link AddonCallGateway} (UDS to the hub-local child). The gateway owns the
   * routing + the child-availability error; there is no broker fallback after
   * the per-addon Moleculer broker was removed.
   */
  private async dispatchForkedCustomAction(
    addonId: string,
    action: string,
    input: unknown,
    caller?: import('@camstack/types').CustomActionCaller,
  ): Promise<unknown> {
    return this.addonCallGateway.callForked(addonId, {
      target: 'custom',
      action,
      args: input,
      // Additive: only carry `caller` when the hub actually forwarded one (the
      // router populates it exclusively for a `caller:'required'` action of an
      // authenticated request). Never blanket; never from client input.
      ...(caller ? { caller } : {}),
    })
  }
}
